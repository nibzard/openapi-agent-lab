/**
 * Stateful milestone acceptance map (SPEC section 48.8). The JSON map
 * tracks every plan task SE-P0-01 through SE-P6-03. This suite keeps
 * the map honest: every task is present exactly once, every referenced
 * test file exists, every referenced test title appears in its file,
 * completion always carries evidence, and evidence artifacts exist.
 *
 * Completeness is a separate gate. scripts/stateful-readiness.mjs
 * fails while any task is pending or partial and while a required
 * live provider verification was skipped, so continuous integration
 * can stay green over an honest incomplete map.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { SchemaValidator } from "../packages/core/src/schema/validator.ts";
import type { Json } from "../packages/core/src/json.ts";

import { evaluateStatefulReadiness } from "../scripts/stateful-readiness.mjs";

const exec = promisify(execFile);
const script = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "stateful-readiness.mjs"
);

interface Evidence {
  readonly commit: string;
  readonly command?: string;
  readonly artifact?: string;
  readonly live_provider?: boolean;
}

interface TaskEntry {
  readonly id: string;
  readonly phase: string;
  readonly requirement: string;
  readonly status: "pending" | "partial" | "complete";
  readonly tests: readonly string[];
  readonly evidence: Evidence | null;
  readonly remaining?: string;
  readonly requires_live_provider?: boolean;
  readonly depends_on?: readonly string[];
}

interface AcceptanceMap {
  readonly schema_version: number;
  readonly kind: string;
  readonly milestone: string;
  readonly tasks: readonly TaskEntry[];
}

/** Every task the plan defines, in delivery order. */
const EXPECTED_IDS: readonly string[] = [
  "SE-P0-01",
  "SE-P0-02",
  "SE-P0-03",
  "SE-P1-01",
  "SE-P1-02",
  "SE-P1-03",
  "SE-P1-04",
  "SE-P2-01",
  "SE-P2-02",
  "SE-P2-03",
  "SE-P2-04",
  "SE-P3-01",
  "SE-P3-02",
  "SE-P3-03",
  "SE-P4-01",
  "SE-P4-02",
  "SE-P4-03",
  "SE-P5-01",
  "SE-P5-02",
  "SE-P5-03",
  "SE-P6-01",
  "SE-P6-02",
  "SE-P6-03"
];

const readJson = async (target: string): Promise<Json> =>
  JSON.parse(await readFile(target, "utf8")) as Json;

describe("the stateful acceptance map", () => {
  const mapPath = path.join(
    import.meta.dirname,
    "stateful-acceptance.map.json"
  );
  const mapPromise = readJson(mapPath) as unknown as Promise<AcceptanceMap>;

  it("validates against the stateful-acceptance.v1 schema", async () => {
    const schema = await readJson(
      path.join(
        import.meta.dirname,
        "..",
        "schemas",
        "stateful-acceptance.v1.schema.json"
      )
    );
    const violations = new SchemaValidator(schema).errors(
      await readJson(mapPath)
    );
    expect(violations).toEqual([]);
  });

  it("carries every stateful task with a valid record", async () => {
    const { tasks } = await mapPromise;
    const ids = tasks.map((task) => task.id);
    expect(ids).toEqual(EXPECTED_IDS);
    const problems: string[] = [];
    for (const task of tasks) {
      if (task.status === "complete") {
        if (task.tests.length === 0) {
          problems.push(`${task.id}: complete with no enforcing test`);
        }
        if (task.evidence === null) {
          problems.push(`${task.id}: complete without evidence`);
        } else {
          if (!/^[0-9a-f]{7,40}$/u.test(task.evidence.commit)) {
            problems.push(
              `${task.id}: evidence commit "${task.evidence.commit}"`
            );
          }
          if (
            task.evidence.command === undefined &&
            task.evidence.artifact === undefined
          ) {
            problems.push(
              `${task.id}: evidence names neither command nor artifact`
            );
          }
          if (
            task.requires_live_provider === true &&
            task.evidence.live_provider !== true
          ) {
            problems.push(
              `${task.id}: complete without the required live provider pass`
            );
          }
        }
      } else {
        if (
          task.remaining === undefined ||
          task.remaining.trim().length === 0
        ) {
          problems.push(`${task.id}: ${task.status} without remaining work`);
        }
        if (task.status === "pending" && task.tests.length > 0) {
          problems.push(`${task.id}: pending but names tests`);
        }
        if (task.status === "partial" && task.tests.length === 0) {
          problems.push(`${task.id}: partial without any enforcing test`);
        }
      }
      for (const dependency of task.depends_on ?? []) {
        if (!EXPECTED_IDS.includes(dependency)) {
          problems.push(`${task.id}: unknown dependency ${dependency}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("names an existing test file for every mapped test", async () => {
    const { tasks } = await mapPromise;
    const referenced = new Set(
      tasks.flatMap((task) =>
        task.tests.map((test) => test.split(" > ")[0] ?? "")
      )
    );
    const absent: string[] = [];
    for (const file of referenced) {
      const target = path.join(import.meta.dirname, "..", file);
      const text = await readFile(target, "utf8").catch(() => null);
      if (text === null) {
        absent.push(file);
      }
    }
    expect(absent).toEqual([]);
  });

  it("names a real test title for every mapped test", async () => {
    const { tasks } = await mapPromise;
    const byFile = new Map<string, Set<string>>();
    const absent: string[] = [];
    for (const test of new Set(tasks.flatMap((task) => task.tests))) {
      const separator = test.indexOf(" > ");
      if (separator < 0) {
        absent.push(test);
        continue;
      }
      const file = test.slice(0, separator);
      const title = test.slice(separator + 3);
      let titles = byFile.get(file);
      if (titles === undefined) {
        const text = await readFile(
          path.join(import.meta.dirname, "..", file),
          "utf8"
        ).catch(() => "");
        titles = new Set(
          [
            ...text.matchAll(
              /(?:it|test)(?:\s*\.\s*\w+\s*)?\(\s*"((?:[^"\\]|\\.)*)"/gu
            )
          ]
            .map((match) => match[1])
            .filter((found): found is string => found !== undefined)
        );
        byFile.set(file, titles);
      }
      if (!titles.has(title)) {
        absent.push(test);
      }
    }
    expect(absent).toEqual([]);
  });

  it("names an existing artifact for every recorded evidence path", async () => {
    const { tasks } = await mapPromise;
    const artifacts = tasks
      .map((task) => task.evidence?.artifact)
      .filter((artifact): artifact is string => artifact !== undefined);
    const absent: string[] = [];
    for (const artifact of artifacts) {
      await readFile(
        path.join(import.meta.dirname, "..", artifact),
        "utf8"
      ).catch(() => absent.push(artifact));
    }
    expect(absent).toEqual([]);
  });

  it("keeps the historical acceptance map separate and unchanged in size", async () => {
    const historical = JSON.parse(
      await readFile(
        path.join(import.meta.dirname, "acceptance.map.json"),
        "utf8"
      )
    ) as readonly { id: string }[];
    expect(historical.length).toBe(127);
    expect(historical.some((entry) => entry.id.startsWith("SE-"))).toBe(false);
  });
});

describe("the stateful readiness gate", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  const task = (overrides: Partial<TaskEntry> & { id: string }): TaskEntry => ({
    phase: "P1",
    requirement: "SPEC 48.2 · plan P1",
    status: "complete",
    tests: [
      "apps/cli/src/run.test.ts > completes the webclip scenario errand through the public command"
    ],
    evidence: { commit: "7f0b48a" },
    ...overrides
  });

  it("blocks while any task is pending or partial", () => {
    const result = evaluateStatefulReadiness([
      task({ id: "SE-P1-01" }),
      task({
        id: "SE-P1-02",
        status: "pending",
        tests: [],
        evidence: null,
        remaining: "not started"
      })
    ]);
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([
      { id: "SE-P1-02", phase: "P1", status: "pending", summary: "not started" }
    ]);
  });

  it("blocks a completed provider task without a live pass", () => {
    const result = evaluateStatefulReadiness([
      task({ id: "SE-P5-03", requires_live_provider: true })
    ]);
    expect(result.ok).toBe(false);
    expect(result.blocking[0]?.status).toBe("provider-skip");
  });

  it("accepts a complete map with recorded live provider passes", () => {
    const result = evaluateStatefulReadiness([
      task({ id: "SE-P1-01" }),
      task({
        id: "SE-P5-03",
        requires_live_provider: true,
        evidence: { commit: "7f0b48a", live_provider: true }
      })
    ]);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ complete: 2 });
  });

  it("fails through the command with the real map", async () => {
    const result = await exec("node", [script]).then(
      (ok) => ({ code: 0, stdout: ok.stdout }),
      (error: unknown) => {
        const failure = error as { code?: number; stdout?: string };
        return {
          code: failure.code ?? -1,
          stdout: typeof failure.stdout === "string" ? failure.stdout : ""
        };
      }
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Stateful environments readiness");
    expect(result.stdout).toContain("blocking");
  });

  it("succeeds through the command with a complete map", async () => {
    const { writeFile } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "oal-stateful-"));
    tempDirs.push(dir);
    const file = path.join(dir, "map.json");
    await writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        kind: "StatefulAcceptanceMap",
        milestone: "stateful-environments",
        tasks: [task({ id: "SE-P6-03" })]
      }),
      "utf8"
    );
    const result = await exec("node", [script, file]);
    expect(result.stdout).toContain(
      "tasks: 1 (complete 1, partial 0, pending 0)"
    );
  });
});
