import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  stableJsonStringify,
  type Json
} from "@oal/core";
import type { TraceBody } from "@oal/evidence";

import { main } from "./cli.ts";
import { FrictionCliCode } from "./handlers/friction.ts";
import { compileServeSource } from "./handlers/serve.ts";
import { RunTreeCode } from "./handlers/run-tree.ts";
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

describe("oal friction over a serve session", () => {
  /** A minimal unauthenticated contract the session was served from. */
  const SESSION_CONTRACT = {
    openapi: "3.1.0",
    info: { title: "clips", version: "1.0.0" },
    paths: {
      "/v1/clips": {
        get: {
          operationId: "list_clips",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { type: "string" } }
                    },
                    required: ["items"]
                  }
                }
              }
            }
          }
        }
      }
    }
  } as const;

  /**
   * One serve session directory in the manual-session shape: trace.jsonl
   * plus capability-report.json, with no run.started.json and no
   * lifecycle ledger. The trace events carry the serve wire identity.
   */
  async function serveSession(
    cwd: string,
    sessionId: string,
    options: { readonly withoutCapabilities?: boolean } = {}
  ): Promise<string> {
    const sessionDir = path.join(cwd, ".oal", "runs", sessionId);
    await mkdir(sessionDir, { recursive: true });
    if (!options.withoutCapabilities) {
      const document = path.join(cwd, "openapi.json");
      await writeFile(document, JSON.stringify(SESSION_CONTRACT));
      const compiled = await compileServeSource(
        document,
        cwd,
        10 * 1024 * 1024
      );
      await writeFile(
        path.join(sessionDir, "capability-report.json"),
        `${stableJsonStringify(compiled.capabilityReport)}\n`
      );
    }
    const first = traceEvent({
      sequence: 1,
      runId: sessionId,
      method: "GET",
      path: "/v1/clips",
      status: 200
    });
    if (first.batch_id === null) {
      first.batch_id = "manual";
    }
    const rejected = traceEvent({
      sequence: 2,
      runId: sessionId,
      method: "POST",
      path: "/v1/clips",
      status: 422,
      error: traceError("validation", "request_schema_invalid"),
      body: jsonBody({ url: 7 })
    });
    if (rejected.response !== null) {
      rejected.response.body = jsonBody({
        violations: [
          {
            location: "body",
            pointer: "/url",
            code: "type",
            message: "value must be a string"
          }
        ]
      });
    }
    await writeFile(
      path.join(sessionDir, "trace.jsonl"),
      [first, rejected].map((event) => JSON.stringify(event)).join("\n") + "\n"
    );
    return sessionDir;
  }

  it("builds a report scoped to the session with external-origin incidents", async () => {
    const cwd = await newWorkspace();
    const sessionId = "manual-20260831-085950";
    const sessionDir = await serveSession(cwd, sessionId);
    const io = new MemoryIo();
    const code = await main(["friction", sessionDir, "--format", "json"], io, {
      cwd
    });
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutChunks.join("")) as {
      scope: { level: string; id: string };
      counts: { trials: number; exchanges: number; incidents: number };
      incidents: Array<{ origin: string; kind: string }>;
    };
    expect(report.scope).toEqual({ level: "run", id: sessionId });
    expect(report.counts.trials).toBe(1);
    expect(report.counts.exchanges).toBe(2);
    expect(report.counts.incidents).toBeGreaterThanOrEqual(1);
    expect(
      report.incidents.filter((incident) => incident.origin === "external")
        .length
    ).toBe(report.incidents.length);
  });

  it("projects a serve session to the terminal", async () => {
    const cwd = await newWorkspace();
    const sessionDir = await serveSession(cwd, "manual-20260831-085859");
    const io = new MemoryIo();
    expect(await main(["friction", sessionDir], io, { cwd })).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("friction: run manual-20260831-085859");
    expect(text).toContain(
      "incident: request_schema_rejected [spec_friction/external]"
    );
  });

  it("refuses a session directory without a capability report", async () => {
    const cwd = await newWorkspace();
    const sessionDir = await serveSession(cwd, "manual-nocap", {
      withoutCapabilities: true
    });
    const io = new MemoryIo();
    const code = await main(["friction", sessionDir], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(RunTreeCode.SessionCapabilityMissing);
  });

  it("keeps evaluate refusing a serve session with a clear diagnostic", async () => {
    const cwd = await newWorkspace();
    const sessionDir = await serveSession(cwd, "manual-evaluate");
    const io = new MemoryIo();
    const code = await main(["evaluate", sessionDir], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(RunTreeCode.NotRunOrBatch);
  });
});
