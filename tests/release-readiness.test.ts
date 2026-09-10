/**
 * Release readiness gate tests. The gate itself lives in
 * scripts/release-readiness.mjs and runs outside `pnpm run ci`. These
 * tests pin its semantics through the command line: a corrected
 * criterion satisfies the gate, a deferred criterion never does, and a
 * live criterion cannot pass on constructed evidence.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);

const script = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "release-readiness.mjs"
);

interface MapEntry {
  readonly id: string;
  readonly group: string;
  readonly claim: string;
  readonly milestone: string;
  readonly status: string;
  readonly tests: readonly string[];
  readonly requires_live?: boolean;
  readonly evidence?: string;
  readonly deferred?: { summary: string; owner: string };
}

function entry(overrides: Partial<MapEntry> & { id: string }): MapEntry {
  return {
    group: "review",
    claim: "probe",
    milestone: "review-remediation",
    status: "missing",
    tests: [],
    ...overrides
  };
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Write one fixture map and return its path plus the CLI result. */
async function runGate(entries: readonly MapEntry[]): Promise<{
  code: number;
  stdout: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-readiness-"));
  tempDirs.push(dir);
  const file = path.join(dir, "map.json");
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return exec("node", [script, file]).then(
    (result) => ({ code: 0, stdout: result.stdout }),
    (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      return {
        code: failure.code ?? -1,
        stdout: typeof failure.stdout === "string" ? failure.stdout : ""
      };
    }
  );
}

describe("the release readiness gate", () => {
  it("fails on the current map and names the blocking criteria", async () => {
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
    expect(result.stdout).toContain("Release readiness");
    // One blocker per open work package, plus the deferred MVP criteria.
    for (const id of ["AC-061", "AC-083", "AC-103", "AC-121", "AC-127"]) {
      expect(result.stdout).toContain(id);
    }
    for (const owner of ["F2", "F3", "F4", "F5", "F6", "F7"]) {
      expect(result.stdout).toContain(`owner ${owner}`);
    }
  });

  it("passes a fully satisfied map", async () => {
    const result = await runGate([
      entry({ id: "AC-900", status: "covered", tests: ["a.test.ts > x"] }),
      entry({
        id: "AC-901",
        status: "corrected",
        tests: ["a.test.ts > x"]
      }),
      entry({
        id: "AC-902",
        status: "covered",
        tests: ["a.test.ts > x"],
        requires_live: true,
        evidence: "live"
      })
    ]);
    expect(result.stdout).toContain("review-remediation: ready");
    expect(result.code).toBe(0);
  });

  it("rejects a live criterion proven only by a constructed trace", async () => {
    const result = await runGate([
      entry({
        id: "AC-900",
        status: "covered",
        tests: ["a.test.ts > x"],
        requires_live: true,
        evidence: "constructed"
      })
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("AC-900 [constructed-evidence]");
  });

  it("never accepts a partial criterion, whatever it enforces", async () => {
    const result = await runGate([
      entry({
        id: "AC-900",
        status: "partial",
        tests: ["a.test.ts > x"],
        deferred: { summary: "remainder", owner: "F5" }
      })
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("AC-900 [partial] owner F5");
  });
});
