/**
 * Corpus command tests (specification section 48.5) through the real
 * CLI and real HTTP: validate accepts a declared corpus, and run
 * drives a fresh scenario serve per case, binds returned ids, records
 * every poll attempt, fails missing bindings explicitly, always
 * attempts eligible cleanup, and refuses nothing silently. Operator
 * steps reach the world through the real operator socket.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  validateSchemaInstance,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";

const webclipRoot = path.resolve(import.meta.dirname, "../../../packs/webclip");
const schemaRoot = path.resolve(import.meta.dirname, "../../../schemas");

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** The corpus the test pack declares: every engine behavior at once. */
const CORPUS_YAML = `api_version: 1
id: engine-checks
version: 1.0.0
scenario: baseline
inputs:
  - name: clip_url
cases:
  - id: create-read
    claim_ids: [clip-lifecycle]
    scope: black_box
    steps:
      - id: create
        request:
          operation_id: create_clip
          body:
            url: { input: clip_url }
            format: markdown
        bind:
          id: { source: body, pointer: /id }
        assert:
          - op: status
            expected: 201
      - id: read
        request:
          operation_id: get_clip
          parameters:
            path:
              clipId: { binding: create.id }
        assert:
          - op: status
            expected: 200
          - op: equals
            actual: { source: body, pointer: /id }
            expected: { binding: create.id }
    cleanup:
      - id: remove
        request:
          operation_id: delete_clip
          parameters:
            path:
              clipId: { binding: create.id }
        assert:
          - op: status
            expected: 204
  - id: poll-list
    claim_ids: [clip-list]
    scope: black_box
    steps:
      - id: create
        request:
          operation_id: create_clip
          body:
            url: { input: clip_url }
            format: markdown
        bind:
          id: { source: body, pointer: /id }
        assert:
          - op: status
            expected: 201
      - id: wait-list
        poll:
          operation_id: list_clips
          parameters:
            query:
              limit: 10
          attempts: 3
          interval_ms: 5
          deadline_ms: 100
        assert:
          - op: status
            expected: 200
          - op: length
            actual: { source: body, pointer: /items }
            expected: 1
    cleanup:
      - id: remove
        request:
          operation_id: delete_clip
          parameters:
            path:
              clipId: { binding: create.id }
  - id: missing-binding
    claim_ids: [clip-lifecycle]
    scope: black_box
    steps:
      - id: create
        request:
          operation_id: create_clip
          body:
            url: { input: clip_url }
            format: markdown
        bind:
          id: { source: body, pointer: /id }
          ghost: { source: body, pointer: /absent }
        assert:
          - op: status
            expected: 201
      - id: needs-ghost
        request:
          operation_id: get_clip
          parameters:
            path:
              clipId: { binding: create.ghost }
        assert:
          - op: status
            expected: 200
    cleanup:
      - id: sweep
        request:
          operation_id: list_clips
          parameters:
            query:
              limit: 10
        assert:
          - op: status
            expected: 200
  - id: poll-exhausts
    claim_ids: [clip-list]
    scope: black_box
    steps:
      - id: wait-forever
        poll:
          operation_id: list_clips
          parameters:
            query:
              limit: 10
          attempts: 3
          interval_ms: 5
          deadline_ms: 100
        assert:
          - op: length
            actual: { source: body, pointer: /items }
            expected: 99
  - id: advance-and-read
    claim_ids: [clip-time]
    scope: emulator_only
    steps:
      - id: create
        request:
          operation_id: create_clip
          body:
            url: { input: clip_url }
            format: markdown
        bind:
          id: { source: body, pointer: /id }
        assert:
          - op: status
            expected: 201
      - id: advance
        operator:
          kind: advance_time
          by_ms: 1000
      - id: read
        request:
          operation_id: get_clip
          parameters:
            path:
              clipId: { binding: create.id }
        assert:
          - op: status
            expected: 200
`;

/** Copy the webclip pack and declare the corpus in its manifest. */
async function corpusPack(): Promise<{ cwd: string; packDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-corpus-"));
  scratch.push(cwd);
  const packDir = path.join(cwd, "pack");
  await cp(webclipRoot, packDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`)
  });
  await symlink(
    path.join(webclipRoot, "node_modules"),
    path.join(packDir, "node_modules"),
    "dir"
  );
  await mkdir(path.join(packDir, "corpora"), { recursive: true });
  await writeFile(path.join(packDir, "corpora", "engine.yaml"), CORPUS_YAML);
  // The pack ships webclip-core already; the fixture swaps in the
  // engine-checks corpus that exercises poll and operator paths.
  const manifest = await readFile(path.join(packDir, "pack.yaml"), "utf8");
  const swapped = manifest.replace(
    "corpora:\n  - id: webclip-core\n    source: corpora/core.yaml",
    "corpora:\n  - id: engine-checks\n    source: corpora/engine.yaml"
  );
  if (swapped === manifest) {
    throw new Error("The webclip manifest no longer declares its corpus.");
  }
  await writeFile(path.join(packDir, "pack.yaml"), swapped);
  return { cwd, packDir };
}

async function run(
  argv: readonly string[],
  cwd: string
): Promise<{ code: ExitCode; io: MemoryIo }> {
  const io = new MemoryIo();
  const guard = new TerminationGuard();
  const code = await main([...argv], io, { cwd, guard });
  return { code, io };
}

function caseOf(report: JsonObject, id: string): JsonObject {
  const found = (report["cases"] as JsonObject[]).find(
    (entry) => entry["id"] === id
  );
  if (found === undefined) {
    throw new Error(`The report carries no case ${JSON.stringify(id)}.`);
  }
  return found;
}

describe("oal corpus", () => {
  it("validates a pack with a declared corpus", async () => {
    const { cwd, packDir } = await corpusPack();
    const { code, io } = await run(["corpus", "validate", packDir], cwd);
    expect(code).toBe(0);
    const summary = JSON.parse(io.stdoutText()) as JsonObject;
    expect(summary["validated"]).toBe(1);
    expect(summary["corpora"]).toEqual([
      { id: "engine-checks", cases: 5, source: "corpora/engine.yaml" }
    ]);
  });

  it("runs the corpus through real HTTP and reports every behavior", async () => {
    const { cwd, packDir } = await corpusPack();
    const { code, io } = await run(
      [
        "corpus",
        "run",
        packDir,
        "--corpus",
        "engine-checks",
        "--input",
        "clip_url=https://example.com/essay"
      ],
      cwd
    );

    // Two cases fail on purpose: a missing binding and an exhausted
    // poll. Everything else must pass.
    expect(code).toBe(2);
    const report = JSON.parse(io.stdoutText()) as JsonObject;
    expect(report["schema_version"]).toBe(1);
    expect(report["kind"]).toBe("CorpusReport");
    expect(report["target"]).toMatchObject({
      id: "local",
      capabilities: { operators: true, virtual_time: true }
    });
    expect(report["summary"]).toEqual({
      passed: 3,
      failed: 2,
      skipped: 0,
      error: 0
    });

    // The report validates against corpus-report.v1.
    const schema = JSON.parse(
      await readFile(
        path.join(schemaRoot, "corpus-report.v1.schema.json"),
        "utf8"
      )
    ) as JsonObject;
    const violations = await validateSchemaInstance(schema, report as Json);
    expect(violations).toEqual([]);

    // Create and read bind the returned id through real HTTP.
    const createRead = caseOf(report, "create-read");
    expect(createRead["status"]).toBe("passed");
    expect(createRead["behavioral_conformance"]).toBe("pass");
    expect(createRead["agent_success"]).toBe("not_evaluated");
    const steps = createRead["steps"] as JsonObject[];
    const create = steps.find((step) => step["id"] === "create");
    expect((create?.["exchange"] as JsonObject)["status"]).toBe(201);
    expect((create?.["exchange"] as JsonObject)["url"]).toContain("/v1/clips");
    expect(
      ((create?.["bindings"] as JsonObject[])[0] as JsonObject)["value"]
    ).toBe("clip_00000001");
    const remove = steps.find((step) => step["id"] === "remove");
    expect(remove?.["phase"]).toBe("cleanup");
    expect((remove?.["exchange"] as JsonObject)["status"]).toBe(204);
    expect(createRead["cleanup"]).toEqual({ status: "passed", steps: 1 });

    // A poll that satisfies on the first attempt records that attempt.
    const pollList = caseOf(report, "poll-list");
    expect(pollList["status"]).toBe("passed");
    const waitList = (pollList["steps"] as JsonObject[]).find(
      (step) => step["id"] === "wait-list"
    );
    const attempts = (waitList?.["attempts"] ?? []) as JsonObject[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.["passed"]).toBe(true);

    // A missing binding fails explicitly, stops the sequence, and
    // still attempts cleanup.
    const missing = caseOf(report, "missing-binding");
    expect(missing["status"]).toBe("failed");
    const createMissing = (missing["steps"] as JsonObject[]).find(
      (step) => step["id"] === "create"
    );
    const ghost = (createMissing?.["bindings"] as JsonObject[]).find(
      (binding) => binding["name"] === "ghost"
    );
    expect(ghost?.["missing"]).toBe(true);
    const needsGhost = (missing["steps"] as JsonObject[]).find(
      (step) => step["id"] === "needs-ghost"
    );
    expect(needsGhost?.["status"]).toBe("failed");
    expect((needsGhost?.["diagnostic"] as JsonObject)["code"]).toBe(
      "OAL-CORPUS-BINDING-MISSING"
    );
    const sweep = (missing["steps"] as JsonObject[]).find(
      (step) => step["id"] === "sweep"
    );
    expect(sweep?.["phase"]).toBe("cleanup");
    expect((sweep?.["exchange"] as JsonObject)["status"]).toBe(200);
    expect(missing["cleanup"]).toEqual({ status: "passed", steps: 1 });

    // An exhausted poll records every attempt and fails.
    const exhausted = caseOf(report, "poll-exhausts");
    expect(exhausted["status"]).toBe("failed");
    const waitForever = (exhausted["steps"] as JsonObject[]).find(
      (step) => step["id"] === "wait-forever"
    );
    expect(waitForever?.["attempts"]).toHaveLength(3);
    expect(
      (exhausted["diagnostics"] as JsonObject[]).some(
        (entry) => entry["code"] === "OAL-CORPUS-POLL-EXHAUSTED"
      )
    ).toBe(true);

    // An operator step advances the real world through its socket.
    const advance = caseOf(report, "advance-and-read");
    expect(advance["status"]).toBe("passed");
    const advanceStep = (advance["steps"] as JsonObject[]).find(
      (step) => step["id"] === "advance"
    );
    expect(advanceStep?.["status"]).toBe("passed");
    expect(
      typeof (advanceStep?.["operator_result"] as JsonObject)["virtual_time"]
    ).toBe("string");
    const readBack = (advance["steps"] as JsonObject[]).find(
      (step) => step["id"] === "read"
    );
    expect((readBack?.["exchange"] as JsonObject)["status"]).toBe(200);
  }, 300_000);

  it("refuses to run when an input value is missing", async () => {
    const { cwd, packDir } = await corpusPack();
    const { code, io } = await run(
      ["corpus", "run", packDir, "--corpus", "engine-checks"],
      cwd
    );
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("clip_url");
  });

  it("writes the report to the --out file", async () => {
    const { cwd, packDir } = await corpusPack();
    const out = path.join(cwd, "report.json");
    const { code } = await run(
      [
        "corpus",
        "run",
        packDir,
        "--corpus",
        "engine-checks",
        "--input",
        "clip_url=https://example.com/essay",
        "--out",
        out
      ],
      cwd
    );
    expect(code).toBe(2);
    const written = JSON.parse(await readFile(out, "utf8")) as JsonObject;
    expect(written["kind"]).toBe("CorpusReport");
    expect(
      (written["cases"] as JsonObject[]).some(
        (entry) => entry["id"] === "create-read"
      )
    ).toBe(true);
  }, 300_000);
});
