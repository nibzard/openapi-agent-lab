import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OalError, SchemaValidator, type Json } from "@oal/core";
import { JsonlSink } from "./trace.ts";
import {
  LIFECYCLE_EVENT_TYPES,
  LifecycleStream,
  agentSessionEvent,
  artifactFinalized,
  assignmentActivated,
  compilerDiagnostic,
  evaluatorCheck,
  isLifecycleEvent,
  lifecycleStage,
  runCreated,
  runFinished,
  stageRecord,
  studyFinished
} from "./lifecycle.ts";

const SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "lifecycle-event.v1.schema.json"
);

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-lifecycle-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readLines(path: string): Promise<Json[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Json);
}

describe("LifecycleStream", () => {
  it("writes every family behind one envelope with rising sequences", async () => {
    const sink = await JsonlSink.open(join(dir, "lifecycle.jsonl"));
    const stream = LifecycleStream.open(sink, {
      batch_id: "batch-01",
      run_id: "run-01"
    });
    const created = await stream.emit(
      runCreated({
        run_id: "run-01",
        retry_of: null,
        observed_at: OBSERVED_AT
      })
    );
    const started = await stream.emit(
      compilerDiagnostic({
        severity: "warning",
        phase: "compile",
        code: "OAL-OAS-ROUTE-AMBIGUOUS",
        message: "two operations share one route",
        observed_at: OBSERVED_AT
      })
    );
    const finished = await stream.emit(
      runFinished({
        disposition: "completed",
        evidence_integrity: "intact",
        duration_ms: 1200,
        observed_at: OBSERVED_AT
      })
    );
    expect([created.sequence, started.sequence, finished.sequence]).toEqual([
      1, 2, 3
    ]);
    expect(created.event_id).toBe("lif_00000001");
    expect(finished.event_id).toBe("lif_00000003");
    expect(created).toEqual({
      schema_version: 1,
      type: "run.created",
      event_id: "lif_00000001",
      sequence: 1,
      observed_at: OBSERVED_AT,
      batch_id: "batch-01",
      run_id: "run-01",
      payload: { run_id: "run-01", retry_of: null }
    });
    const lines = await readLines(join(dir, "lifecycle.jsonl"));
    expect(lines.map((line) => (line as { type: string }).type)).toEqual([
      "run.created",
      "compiler.diagnostic",
      "run.finished"
    ]);
    for (const line of lines) {
      expect(isLifecycleEvent(line)).toBe(true);
    }
  });

  it("keeps study scope null for batch and run ids", async () => {
    const sink = await JsonlSink.open(join(dir, "lifecycle.jsonl"));
    const stream = LifecycleStream.open(sink);
    const event = await stream.emit(
      studyFinished({
        study_run_id: "study-01",
        completed: 4,
        aborted: 1,
        failed: 0,
        observed_at: OBSERVED_AT
      })
    );
    expect(event.batch_id).toBeNull();
    expect(event.run_id).toBeNull();
  });

  it("rejects an unsafe scope identifier", async () => {
    const sink = await JsonlSink.open(join(dir, "lifecycle.jsonl"));
    expect(() => LifecycleStream.open(sink, { run_id: "../escape" })).toThrow();
  });

  it("covers every event family from section 33.1", () => {
    expect(LIFECYCLE_EVENT_TYPES).toHaveLength(22);
    expect(LIFECYCLE_EVENT_TYPES).toContain("lifecycle.stage");
    expect(LIFECYCLE_EVENT_TYPES).toContain("study.aborted");
  });
});

describe("lifecycle builders", () => {
  it("bounds free text and rejects credential material", () => {
    expect(
      compilerDiagnostic({
        severity: "error",
        phase: "compile",
        code: "OAL-JSON-INVALID",
        message: "x".repeat(400)
      }).payload.message
    ).toHaveLength(200);
    const error = capture(() =>
      compilerDiagnostic({
        severity: "error",
        phase: "compile",
        code: "OAL-JSON-INVALID",
        message: "Bearer abcdefghijklmnop"
      })
    );
    expect(error?.code).toBe("OAL-LIFECYCLE-INVALID-FIELD");
  });

  it("rejects unsafe identifiers, paths, and timestamps", () => {
    expect(() => runCreated({ run_id: "bad id" })).toThrow(/safe identifier/);
    expect(() =>
      artifactFinalized({
        manifest_path: "../outside/manifest.json",
        entries: 1,
        manifest_sha256: null
      })
    ).toThrow(/safe relative artifact path/);
    expect(() =>
      artifactFinalized({
        manifest_path: "runs/b1/trials/r1/artifact-manifest.json",
        entries: 1,
        manifest_sha256: "not-a-digest"
      })
    ).toThrow(/sha256 digest/);
    expect(() =>
      runFinished({
        disposition: "completed",
        evidence_integrity: "intact",
        duration_ms: -1
      })
    ).toThrow(/non-negative integer/);
  });

  it("sorts and bounds lifecycle stage details", () => {
    const draft = lifecycleStage({
      stage: "server_ready",
      recorded_at: OBSERVED_AT,
      evidence_source: "runner",
      details: { port: 41234, synthetic_home: true, note: "ready" }
    });
    expect(Object.keys(draft.payload.details)).toEqual([
      "note",
      "port",
      "synthetic_home"
    ]);
    const tooMany: Record<string, number> = {};
    for (let index = 0; index < 33; index += 1) {
      tooMany[`k${index}`] = index;
    }
    expect(() =>
      lifecycleStage({
        stage: "scheduled",
        recorded_at: OBSERVED_AT,
        evidence_source: "runner",
        details: tooMany
      })
    ).toThrow(/entries/);
  });

  it("carries an error code on every rejection", () => {
    const error = capture(() =>
      assignmentActivated({
        assignment_id: "asg bad",
        run_id: null,
        replacement_of: null
      })
    );
    expect(error).toBeInstanceOf(OalError);
    expect(error?.code).toBe("OAL-LIFECYCLE-INVALID-FIELD");
    expect(error?.category).toBe("input");
  });

  it("narrows payloads read back from the stream", async () => {
    const sink = await JsonlSink.open(join(dir, "lifecycle.jsonl"));
    const stream = LifecycleStream.open(sink, {
      batch_id: "batch-01",
      run_id: "run-01"
    });
    await stream.emit(
      evaluatorCheck({
        check_id: "rubric.pass",
        status: "pass",
        observed_at: OBSERVED_AT
      })
    );
    await stream.emit(
      agentSessionEvent({
        channel: "jsonrpc",
        redacted: true,
        bytes: 128,
        kind: null,
        observed_at: OBSERVED_AT
      })
    );
    for (const line of await readLines(join(dir, "lifecycle.jsonl"))) {
      if (!isLifecycleEvent(line)) {
        throw new Error("record failed the lifecycle guard");
      }
      if (line.type === "evaluator.check") {
        expect(line.payload).toEqual({
          check_id: "rubric.pass",
          status: "pass"
        });
      } else if (line.type === "agent.session_event") {
        expect(line.payload.channel).toBe("jsonrpc");
      }
    }
  });
});

describe("stage record schema conformance", () => {
  it("validates against schemas/lifecycle-event.v1.schema.json", async () => {
    const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as Json;
    const validator = new SchemaValidator(schema);
    const sink = await JsonlSink.open(join(dir, "lifecycle.jsonl"));
    const stream = LifecycleStream.open(sink, {
      batch_id: "batch-01",
      run_id: "run-01"
    });
    const event = await stream.emit(
      lifecycleStage({
        stage: "workspace_prepared",
        recorded_at: "2026-01-15T09:30:01.004Z",
        evidence_source: "runner",
        details: { workspace_bytes: 0, synthetic_home: true },
        observed_at: OBSERVED_AT
      })
    );
    const record = stageRecord(event);
    expect(record).toEqual({
      schema_version: 1,
      sequence: 1,
      stage: "workspace_prepared",
      recorded_at: "2026-01-15T09:30:01.004Z",
      evidence_source: "runner",
      details: { synthetic_home: true, workspace_bytes: 0 }
    });
    expect(validator.errors(record as unknown as Json)).toEqual([]);
    expect(
      validator.errors({
        schema_version: 1,
        sequence: 1,
        stage: "not-a-stage",
        recorded_at: "2026-01-15T09:30:01.004Z",
        evidence_source: "runner",
        details: {}
      } as unknown as Json).length
    ).toBeGreaterThan(0);
  });
});

function capture(action: () => unknown): OalError | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof OalError) {
      return error;
    }
    throw error;
  }
}
