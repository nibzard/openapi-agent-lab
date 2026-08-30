import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_UNSUPPORTED, type Json } from "@oal/core";
import type { TraceBody } from "@oal/evidence";

import { main } from "./cli.ts";
import { FrictionCliCode } from "./handlers/friction.ts";
import { MemoryIo } from "./io.ts";
import { loadSteelPack } from "../../../packages/testkit/src/index.ts";
import {
  traceError,
  traceEvent
} from "../../../packages/report/src/fixtures.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-friction-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

function jsonBody(value: Json): TraceBody {
  return { kind: "json", size_bytes: 16, value, truncated: false };
}

/** Two recorded exchanges: a schema rejection, then an escalation. */
function recordedTrace(runId: string): string {
  const rejected = traceEvent({
    sequence: 1,
    runId,
    method: "POST",
    path: "/v1/computers",
    status: 422,
    error: traceError("validation", "request_schema_invalid"),
    body: jsonBody({ name: "steel box", cores: "many" }),
    operation: {
      matched: true,
      key: "path:POST /v1/computers",
      uid: "op-1",
      operation_id: "createComputer",
      method: "POST",
      path_template: "/v1/computers"
    }
  });
  if (rejected.response !== null) {
    rejected.response.body = jsonBody({
      violations: [
        {
          location: "body",
          pointer: "/cores",
          code: "type",
          message: "value must be a number"
        }
      ]
    });
  }
  const satisfied = traceEvent({
    sequence: 2,
    runId,
    method: "POST",
    path: "/v1/computers",
    status: 201,
    body: jsonBody({ name: "steel box", cores: 4 }),
    operation: {
      matched: true,
      key: "path:POST /v1/computers",
      uid: "op-1",
      operation_id: "createComputer",
      method: "POST",
      path_template: "/v1/computers"
    },
    backend: {
      mode: "contract",
      name: null,
      outcome: "handled",
      duration_ms: 1,
      response_provenance: "generated",
      effects: [],
      observations: {}
    }
  });
  return [rejected, satisfied].map((event) => JSON.stringify(event)).join("\n");
}

/**
 * Record one real one-trial batch with the mock agent, then replace the
 * (empty) mock trace with recorded exchanges the way a paid agent run
 * leaves them. The CLI mock agent runs an empty script, so its own
 * trace holds no exchanges.
 */
async function recordedBatch(
  batchId: string
): Promise<{ cwd: string; batchDir: string }> {
  const pack = await loadSteelPack();
  const cwd = await newWorkspace();
  const io = new MemoryIo();
  const code: number = await main(
    [
      "run",
      pack.root,
      "--eval",
      "basic-lifecycle",
      "--batch",
      batchId,
      "--no-fail-on-eval",
      "--format",
      "json"
    ],
    io,
    { cwd }
  );
  expect(code).toBe(EXIT_OK);
  const trialsRoot = path.join(cwd, ".oal", "runs", batchId, "trials");
  const trialDir = (await readdir(trialsRoot))[0];
  if (trialDir === undefined) {
    throw new Error(`no trial directory below ${trialsRoot}`);
  }
  await writeFile(
    path.join(trialsRoot, trialDir, "trace.jsonl"),
    `${recordedTrace(`${batchId}-run-01`)}\n`,
    "utf8"
  );
  return { cwd, batchDir: path.join(cwd, ".oal", "runs", batchId) };
}

describe("oal friction", () => {
  it("renders the canonical JSON friction report of one batch", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-friction-json");
    const io = new MemoryIo();
    const code = await main(["friction", batchDir, "--format", "json"], io, {
      cwd
    });
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutChunks.join("")) as {
      kind: string;
      schema_version: number;
      scope: { level: string; id: string };
      counts: {
        trials: number;
        exchanges: number;
        operations: number;
        incidents: number;
        worklist_items: number;
      };
    };
    expect(report.kind).toBe("FrictionReport");
    expect(report.schema_version).toBe(1);
    expect(report.scope.level).toBe("batch");
    expect(report.scope.id).toBe("cli-friction-json");
    expect(report.counts.trials).toBe(1);
    expect(report.counts.exchanges).toBe(2);
    expect(report.counts.operations).toBe(1);
    expect(report.counts.incidents).toBeGreaterThanOrEqual(1);
    expect(report.counts.worklist_items).toBeGreaterThanOrEqual(1);
  });

  it("projects the friction report to the terminal", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-friction-term");
    const io = new MemoryIo();
    expect(await main(["friction", batchDir], io, { cwd })).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("friction: batch cli-friction-term");
    expect(text).toContain(
      "incident: request_schema_rejected [spec_friction/api]"
    );
    expect(text).toContain("worklist: 2 item(s)");
    expect(text).toContain("counts: trials=1 exchanges=2 operations=1");
  });

  it("rejects html and markdown projections", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-friction-format");
    for (const format of ["html", "markdown"]) {
      const io = new MemoryIo();
      const code = await main(["friction", batchDir, "--format", format], io, {
        cwd
      });
      expect(code).toBe(EXIT_UNSUPPORTED);
      expect(io.stderrText()).toContain(FrictionCliCode.ProjectionUnsupported);
    }
  });
});
