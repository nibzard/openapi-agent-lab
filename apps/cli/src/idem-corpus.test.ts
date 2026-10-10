/**
 * idem-runtime corpus command tests (specification sections 17.3 and
 * 48.5). The synthetic idempotency pack ships its own corpus; these
 * checks drive it through the real CLI and real HTTP, so the replay
 * and conflict behaviors survive the full serve path - exposure
 * wiring, sealed store, and the gateway pipeline - not just the
 * in-process engine calls the runtime corpus checks use.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ExitCode, JsonObject } from "@oal/core";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";

const packDir = path.resolve(
  import.meta.dirname,
  "../../../packs/idem-runtime"
);

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function run(
  argv: readonly string[]
): Promise<{ code: ExitCode; io: MemoryIo }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-idem-corpus-"));
  scratch.push(cwd);
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

describe("the idem-runtime corpus through the CLI", () => {
  it("validates the pack and its corpus", async () => {
    const { code, io } = await run(["corpus", "validate", packDir]);
    expect(code).toBe(0);
    const summary = JSON.parse(io.stdoutText()) as JsonObject;
    expect(summary["validated"]).toBe(1);
    expect(summary["corpora"]).toEqual([
      { id: "idem-core", cases: 3, source: "corpora/core.yaml" }
    ]);
  });

  it("passes every case over real HTTP", async () => {
    const { code, io } = await run([
      "corpus",
      "run",
      packDir,
      "--corpus",
      "idem-core"
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText()) as JsonObject;
    expect(report["kind"]).toBe("CorpusReport");
    expect(report["summary"]).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
      error: 0
    });

    // The retry step replays the stored create: the same job id, not a
    // second job.
    const replay = caseOf(report, "replay-same-key");
    expect(replay["status"]).toBe("passed");
    const retry = (replay["steps"] as JsonObject[]).find(
      (step) => step["id"] === "retry"
    );
    const idCheck = ((retry?.["assertions"] ?? []) as JsonObject[]).find(
      (assertion) => assertion["op"] === "equals"
    );
    expect(idCheck?.["passed"]).toBe(true);
    expect(idCheck?.["actual"]).toBe(idCheck?.["expected"]);

    // The reused key with a different body answers the declared
    // conflict, with the SPEC error code in the body.
    const conflict = caseOf(report, "conflict-different-body");
    expect(conflict["status"]).toBe("passed");
    const reuse = (conflict["steps"] as JsonObject[]).find(
      (step) => step["id"] === "reuse"
    );
    const statusCheck = ((reuse?.["assertions"] ?? []) as JsonObject[]).find(
      (assertion) => assertion["op"] === "status"
    );
    expect(statusCheck?.["actual"]).toBe(409);
  }, 300_000);
});
