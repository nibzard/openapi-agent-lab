import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LIMIT_DEFAULTS } from "@oal/config";
import {
  canonicalJson,
  diagnostic,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  type Json
} from "@oal/core";
import {
  captureBody,
  Redactor,
  traceHeaders,
  type LifecycleEvent,
  type TraceEvent
} from "@oal/evidence";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type RawRequest
} from "@oal/gateway";
import { deriveTrialSeed } from "@oal/state-store";

import { main } from "./cli.ts";
import { ReplayCliCode, replayExitCode } from "./handlers/replay.ts";
import { MemoryIo } from "./io.ts";

const RUN_ID = "run-0001";
const BATCH_ID = "batch-replay-1";
const RUN_SEED = "a".repeat(64);
const TRIAL_SEED = deriveTrialSeed(RUN_SEED, { index: 0, id: RUN_ID });
const T0 = "2026-08-27T12:00:00.000Z";

type Contract = GatewayOptions["contract"];

/** Two-operation contract: list widgets and create one. */
function testContract(): Contract {
  const widgetSchema = {
    uid: "sch_widget",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, stock: { type: "integer" } }
    },
    source_pointer: "",
    document_uri: ""
  };
  const inputSchema = {
    uid: "sch_widget_input",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    },
    source_pointer: "",
    document_uri: ""
  };
  const content = (schemaRef: string) => [
    {
      media_type: "application/json",
      schema_ref: schemaRef,
      examples: [],
      support: "supported" as const,
      support_reason_codes: []
    }
  ];
  const response = (status: number, schemaRef: string) => ({
    selector: status.toString(10),
    selector_kind: "exact" as const,
    status,
    description: null,
    headers: [],
    content: content(schemaRef),
    source_pointer: ""
  });
  const base = {
    surface: "path" as const,
    method: "GET" as const,
    path_template: "/widgets",
    route_segments: [{ kind: "literal" as const, value: "widgets" }],
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported" as const, diagnostic_codes: [] }
  };
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal-cli-test", version: "0" },
    source: {
      entrypoint: "openapi.yaml",
      media_type: "application/yaml",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {},
    schemas: { sch_widget: widgetSchema, sch_widget_input: inputSchema },
    operations: [
      {
        ...base,
        key: "path:GET /widgets",
        uid: "op_list_widgets",
        operation_id: "listWidgets",
        tool_name: "list_widgets",
        request_body: null,
        responses: [response(200, "sch_widget")],
        security: null
      },
      {
        ...base,
        method: "POST",
        key: "path:POST /widgets",
        uid: "op_create_widget",
        operation_id: "createWidget",
        tool_name: "create_widget",
        request_body: {
          required: true,
          description: null,
          content: content("sch_widget_input"),
          source_pointer: ""
        },
        responses: [response(201, "sch_widget")],
        security: null
      }
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

const CAPTURE_LIMITS = {
  maxJsonBytes: 65_536,
  maxTextPreviewBytes: 4_096,
  captureBlobs: false
};

const REDACTOR = new Redactor({
  hmacKey: new Uint8Array(32).fill(3),
  secrets: [],
  config: { keyPatterns: [] }
});

interface ExchangeInit {
  sequence: number;
  method: "GET" | "POST";
  target: string;
  headers: Record<string, string>;
  body: string;
  operationKey: string;
}

/** Record one exchange by driving the gateway, as the runner recording does. */
async function recordExchange(
  options: GatewayOptions,
  init: ExchangeInit
): Promise<TraceEvent> {
  const bytes = new TextEncoder().encode(init.body);
  const raw: RawRequest = {
    method: init.method,
    target: init.target,
    headers: init.headers,
    body: bytes
  };
  const response = await handleGatewayRequest(options, init.sequence, raw);
  const wire = (headers: Record<string, string>) =>
    traceHeaders(
      Object.entries(headers).map(([name, value]) => [name, [value]]),
      REDACTOR
    );
  const requestBody = await captureBody({
    bytes,
    contentType: init.headers["content-type"] ?? null,
    redactor: REDACTOR,
    blobs: null,
    limits: CAPTURE_LIMITS
  });
  const responseBody = await captureBody({
    bytes: new TextEncoder().encode(response.body ?? ""),
    contentType: response.headers["content-type"] ?? null,
    redactor: REDACTOR,
    blobs: null,
    limits: CAPTURE_LIMITS
  });
  const pathOnly = init.target.split("?")[0] ?? init.target;
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: `req${init.sequence.toString(10).padStart(8, "0")}`,
    sequence: init.sequence,
    participant_ingress_sequence: init.sequence,
    observed_at: T0,
    logical_time: null,
    batch_id: BATCH_ID,
    run_id: RUN_ID,
    eval_id: null,
    actor: "participant",
    transport: {
      kind: "http",
      request_id: response.requestId,
      connection_id: null
    },
    operation: {
      matched: true,
      key: init.operationKey,
      uid: "op_test",
      operation_id: init.operationKey,
      method: init.method,
      path_template: pathOnly,
      support: "supported"
    },
    request: {
      received_at: T0,
      method: init.method,
      path: pathOnly,
      query_string: "",
      query: [],
      path_parameters: {},
      headers: wire(init.headers),
      credential_present: false,
      content_type: init.headers["content-type"] ?? null,
      body: requestBody
    },
    authentication: {
      status: "not_required",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: { status: "valid", violations: [] },
      response: { status: "valid", violations: [] }
    },
    backend: null,
    response: {
      completed_at: T0,
      status: response.status,
      headers: wire(response.headers),
      content_type: response.headers["content-type"] ?? null,
      body: responseBody
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: null,
    duration_ms: 3,
    resource_usage: null,
    extensions: {}
  };
}

/** The lifecycle and trace records of one faithful two-request run. */
async function recordedEvents(): Promise<(LifecycleEvent | TraceEvent)[]> {
  const options: GatewayOptions = {
    contract: testContract(),
    limits: LIMIT_DEFAULTS,
    runSeed: TRIAL_SEED
  };
  return [
    {
      schema_version: 1,
      type: "run.created",
      event_id: "lif000001",
      sequence: 1,
      observed_at: T0,
      batch_id: BATCH_ID,
      run_id: RUN_ID,
      payload: { run_id: RUN_ID, retry_of: null }
    },
    {
      schema_version: 1,
      type: "run.finished",
      event_id: "lif000002",
      sequence: 2,
      observed_at: T0,
      batch_id: BATCH_ID,
      run_id: RUN_ID,
      payload: {
        disposition: "completed",
        evidence_integrity: "intact",
        duration_ms: 9000
      }
    },
    await recordExchange(options, {
      sequence: 1,
      method: "GET",
      target: "/widgets",
      headers: { accept: "application/json" },
      body: "",
      operationKey: "path:GET /widgets"
    }),
    await recordExchange(options, {
      sequence: 2,
      method: "POST",
      target: "/widgets",
      headers: { "content-type": "application/json" },
      body: '{"name":"alpha"}',
      operationKey: "path:POST /widgets"
    })
  ];
}

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-replay-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Write the section 24.1 tree of one trial by hand. */
async function writeRunTree(
  cwd: string,
  events: readonly (LifecycleEvent | TraceEvent)[],
  manifestDigest?: string
): Promise<string> {
  const batchDir = path.join(cwd, ".oal", "runs", BATCH_ID);
  const runDir = path.join(batchDir, "trials", RUN_ID);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(batchDir, "inputs"), { recursive: true });
  await writeFile(
    path.join(batchDir, "inputs", "contract.ir.json"),
    `${canonicalJson(testContract() as unknown as Json)}\n`
  );
  await writeFile(
    path.join(runDir, "run.started.json"),
    `${canonicalJson({
      schema_version: 1,
      kind: "RunStarted",
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      started_at: T0,
      repetition_index: 0,
      run_seed: RUN_SEED,
      server: { base_url: "http://127.0.0.1:1", mode: "contract", mcp: null },
      inputs: {},
      participant_files: [],
      extensions: { trial_seed_id: TRIAL_SEED.slice(0, 12) }
    } as Json)}\n`
  );
  await writeFile(
    path.join(runDir, "lifecycle.jsonl"),
    events
      .filter((event) => event.type !== "api.exchange")
      .map((event) => canonicalJson(event as unknown as Json))
      .join("\n") + "\n"
  );
  await writeFile(
    path.join(runDir, "trace.jsonl"),
    events
      .filter((event) => event.type === "api.exchange")
      .map((event) => canonicalJson(event as unknown as Json))
      .join("\n") + "\n"
  );
  if (manifestDigest !== undefined) {
    await writeFile(
      path.join(cwd, ".oal", "runs", BATCH_ID, "artifact-manifest.json"),
      `${canonicalJson({
        schema_version: 1,
        kind: "ArtifactManifest",
        scope: {
          level: "batch",
          id: BATCH_ID,
          run_id: null,
          batch_id: BATCH_ID,
          study_run_id: null
        },
        created_at: T0,
        entries: [
          {
            path: "inputs/contract.ir.json",
            bytes: 1,
            sha256: manifestDigest,
            media_type: "application/json",
            producer: { component: "@oal/evidence", version: "0.1.0" },
            sensitivity: "redacted"
          }
        ]
      } as Json)}\n`
    );
  }
  return runDir;
}

/** Deep copy with the mutable shapes replay reads. */
async function copiedEvents(): Promise<(LifecycleEvent | TraceEvent)[]> {
  return structuredClone(await recordedEvents());
}

describe("replayExitCode", () => {
  it("returns 0 while only warnings were raised", () => {
    expect(
      replayExitCode([
        diagnostic({
          severity: "warning",
          phase: "report",
          code: "replay.not_comparable",
          message: "Body was not comparable."
        })
      ])
    ).toBe(EXIT_OK);
  });

  it("maps an error diagnostic to the invalid status", () => {
    expect(
      replayExitCode([
        diagnostic({
          severity: "error",
          phase: "report",
          code: "replay.mismatch",
          message: "The record differs."
        })
      ])
    ).toBe(EXIT_INVALID);
  });

  it("maps a gateway failure to the infrastructure status", () => {
    expect(
      replayExitCode([
        diagnostic({
          severity: "error",
          phase: "report",
          code: "replay.gateway_error",
          message: "The gateway threw."
        })
      ])
    ).toBe(EXIT_INFRASTRUCTURE);
  });
});

describe("oal replay", () => {
  it("verifies a faithful run in verify mode", async () => {
    const cwd = await newWorkspace();
    const runDir = await writeRunTree(cwd, await recordedEvents());
    const io = new MemoryIo();
    const code = await main(["replay", runDir, "--verify"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks).toEqual([]);
    const text = io.stderrText();
    expect(text).toContain(`run: ${RUN_ID}`);
    expect(text).toContain("2 in scope, 2 replayed, 2 verified");
    expect(text).toContain("coverage: 1");
    expect(text).toContain("full verification: yes");
  });

  it("prints the ReplayResult document with --format json", async () => {
    const cwd = await newWorkspace();
    const runDir = await writeRunTree(cwd, await recordedEvents());
    const io = new MemoryIo();
    const code = await main(
      ["replay", runDir, "--verify", "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const result = JSON.parse(io.stdoutText()) as Record<string, unknown>;
    expect(result["kind"]).toBe("ReplayResult");
    expect(result["run_id"]).toBe(RUN_ID);
    expect(result["verify"]).toBe(true);
    expect(result["full_verification"]).toBe(true);
    expect(result["counts"]).toEqual({
      in_scope: 2,
      replayed: 2,
      verified: 2,
      mismatched: 0,
      skipped: 0,
      failed: 0
    });
    expect(result["replay_sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays only the requested ingress sequence", async () => {
    const cwd = await newWorkspace();
    const runDir = await writeRunTree(cwd, await recordedEvents());
    const io = new MemoryIo();
    const code = await main(
      ["replay", runDir, "--request", "2", "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const result = JSON.parse(io.stdoutText()) as Record<string, unknown>;
    expect(result["request_filter"]).toBe(2);
    const outcomes = result["outcomes"] as readonly Record<string, unknown>[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.["sequence"]).toBe(2);
  });

  it("maps a mutated record to exit 2 in verify mode only", async () => {
    const cwd = await newWorkspace();
    const events = await copiedEvents();
    const mutated = events[3];
    if (mutated?.type === "api.exchange" && mutated.response !== null) {
      mutated.response.status = 200;
    }
    const runDir = await writeRunTree(cwd, events);

    const strict = new MemoryIo();
    expect(await main(["replay", runDir, "--verify"], strict, { cwd })).toBe(
      EXIT_INVALID
    );
    expect(strict.stderrText()).toContain("replay.mismatch");
    expect(strict.stderrText()).toContain("req_00000002");

    const lenient = new MemoryIo();
    expect(await main(["replay", runDir], lenient, { cwd })).toBe(EXIT_OK);
    expect(lenient.stderrText()).toContain("replay.mismatch");
    expect(lenient.stderrText()).toContain("1 mismatched");
    expect(lenient.stderrText()).toContain("full verification: no");
  });

  it("refuses a missing run directory and a directory without a start record", async () => {
    const cwd = await newWorkspace();
    const missing = new MemoryIo();
    expect(
      await main(["replay", path.join(cwd, ".oal", "no-such-run")], missing, {
        cwd
      })
    ).toBe(EXIT_INVALID);
    expect(missing.stderrText()).toContain(ReplayCliCode.RunDirMissing);

    const notARun = new MemoryIo();
    expect(await main(["replay", cwd], notARun, { cwd })).toBe(EXIT_INVALID);
    expect(notARun.stderrText()).toContain(ReplayCliCode.RunStartedMissing);
  });

  it("reports evidence streams that do not parse", async () => {
    const cwd = await newWorkspace();
    const runDir = await writeRunTree(cwd, await recordedEvents());
    await writeFile(path.join(runDir, "trace.jsonl"), "{not json}\n");
    const io = new MemoryIo();
    expect(await main(["replay", runDir], io, { cwd })).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ReplayCliCode.EvidenceUnreadable);
  });

  it("fails when the frozen contract drifted from the batch manifest", async () => {
    const cwd = await newWorkspace();
    const runDir = await writeRunTree(
      cwd,
      await recordedEvents(),
      "b".repeat(64)
    );
    const io = new MemoryIo();
    expect(await main(["replay", runDir, "--verify"], io, { cwd })).toBe(
      EXIT_INVALID
    );
    expect(io.stderrText()).toContain(ReplayCliCode.FrozenInputDrift);
  });

  it("accepts a frozen contract that matches the batch manifest", async () => {
    const cwd = await newWorkspace();
    const digest = createHash("sha256")
      .update(`${canonicalJson(testContract() as unknown as Json)}\n`)
      .digest("hex");
    const runDir = await writeRunTree(cwd, await recordedEvents(), digest);
    const io = new MemoryIo();
    expect(await main(["replay", runDir, "--verify"], io, { cwd })).toBe(
      EXIT_OK
    );
    expect(io.stderrText()).not.toContain(ReplayCliCode.FrozenInputDrift);
  });
});
