import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXIT_INVALID,
  EXIT_OK,
  SchemaValidator,
  canonicalJson,
  type Json
} from "@oal/core";

import { main } from "./cli.ts";
import { ProbeCliCode } from "./handlers/probe.ts";
import { MemoryIo } from "./io.ts";

const RUN_ID = "run-0001";
const BATCH_ID = "batch-probe-1";
const T0 = "2026-09-14T12:00:00.000Z";

/** One live credential the probe must never persist. */
const LIVE_TOKEN = "probe-live-canary-91d4e7";
const CREDENTIAL_ENV = "OAL_PROBE_TEST_TOKEN";

/**
 * A four-operation contract the frozen batch input holds: list, read,
 * create, and delete widgets. Only the declared responses count, so a
 * live 503 on the read is server divergence, not a declared outcome.
 */
function probeContract(): Json {
  const widget = {
    uid: "sch_widget",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, stock: { type: "integer" } }
    },
    source_pointer: "",
    document_uri: ""
  };
  const widgetInput = {
    uid: "sch_widget_input",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    },
    source_pointer: "",
    document_uri: ""
  };
  const content = (ref: string): Json => [
    {
      media_type: "application/json",
      schema_ref: ref,
      examples: [],
      support: "supported",
      support_reason_codes: []
    }
  ];
  const response = (status: number, ref: string | null): Json => ({
    selector: status.toString(10),
    selector_kind: "exact",
    status,
    description: null,
    headers: [],
    content: ref === null ? [] : content(ref),
    source_pointer: ""
  });
  const widgetIdParameter = {
    name: "widgetId",
    location: "path",
    style: "simple",
    explode: false,
    allow_reserved: false,
    required: true,
    deprecated: false,
    description: null,
    schema_ref: null,
    content: null,
    examples: [],
    support: { level: "supported", diagnostic_codes: [] },
    source_pointer: ""
  };
  const base = (
    method: string,
    template: string,
    segments: Json
  ): Record<string, unknown> => ({
    surface: "path",
    method,
    path_template: template,
    route_segments: segments,
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  });
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal-cli-test", version: "0" },
    source: {
      entrypoint: "openapi.json",
      media_type: "application/json",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {
      bearerAuth: {
        name: "bearerAuth",
        type: "http",
        description: null,
        location: null,
        wire_name: null,
        scheme: "bearer",
        bearer_format: null,
        flows: null,
        open_id_connect_url: null,
        support: { level: "supported", diagnostic_codes: [] },
        support_reason_codes: [],
        source_pointer: ""
      }
    },
    schemas: { sch_widget: widget, sch_widget_input: widgetInput },
    operations: [
      {
        ...base("GET", "/widgets", [{ kind: "literal", value: "widgets" }]),
        key: "path:GET /widgets",
        uid: "op_list_widgets",
        operation_id: "listWidgets",
        tool_name: "list_widgets",
        request_body: null,
        responses: [response(200, "sch_widget")],
        security: null
      },
      {
        ...base("GET", "/widgets/{widgetId}", [
          { kind: "literal", value: "widgets" },
          { kind: "parameter", value: "widgetId" }
        ]),
        key: "path:GET /widgets/{widgetId}",
        uid: "op_get_widget",
        operation_id: "getWidget",
        tool_name: "get_widget",
        parameters: [widgetIdParameter],
        request_body: null,
        responses: [response(200, "sch_widget")],
        security: null
      },
      {
        ...base("POST", "/widgets", [{ kind: "literal", value: "widgets" }]),
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
      },
      {
        ...base("DELETE", "/widgets/{widgetId}", [
          { kind: "literal", value: "widgets" },
          { kind: "parameter", value: "widgetId" }
        ]),
        key: "path:DELETE /widgets/{widgetId}",
        uid: "op_delete_widget",
        operation_id: "deleteWidget",
        tool_name: "delete_widget",
        parameters: [widgetIdParameter],
        request_body: null,
        responses: [response(204, null)],
        security: null
      }
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

interface RecordedRequest {
  sequence: number;
  method: string;
  path: string;
  operationId: string;
  operationKey: string;
  body?: Json;
  contentType?: string;
}

/** One recorded api.exchange event, minimal but schema-shaped. */
function recordedExchange(request: RecordedRequest): Json {
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: `req${request.sequence.toString(10).padStart(8, "0")}`,
    sequence: request.sequence,
    participant_ingress_sequence: request.sequence,
    observed_at: T0,
    logical_time: null,
    batch_id: BATCH_ID,
    run_id: RUN_ID,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: true,
      key: request.operationKey,
      uid: null,
      operation_id: request.operationId,
      method: request.method,
      path_template: request.path.split("?")[0] ?? request.path,
      support: "supported"
    },
    request: {
      received_at: T0,
      method: request.method,
      path: request.path.split("?")[0] ?? request.path,
      query_string: "",
      query: [],
      path_parameters: {},
      headers: [],
      credential_present: false,
      content_type: request.contentType ?? null,
      body:
        request.body === undefined
          ? { kind: "none" }
          : {
              kind: "json",
              size_bytes: JSON.stringify(request.body).length,
              value: request.body,
              truncated: false
            }
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
    response: null,
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: null,
    duration_ms: 3,
    resource_usage: null,
    extensions: {}
  };
}

/** The four recorded requests of the batch: list, read, create, delete. */
function recordedExchanges(): Json[] {
  return [
    recordedExchange({
      sequence: 1,
      method: "GET",
      path: "/widgets",
      operationId: "listWidgets",
      operationKey: "path:GET /widgets"
    }),
    recordedExchange({
      sequence: 2,
      method: "GET",
      path: "/widgets/w_1",
      operationId: "getWidget",
      operationKey: "path:GET /widgets/{widgetId}"
    }),
    recordedExchange({
      sequence: 3,
      method: "POST",
      path: "/widgets",
      operationId: "createWidget",
      operationKey: "path:POST /widgets",
      contentType: "application/json",
      body: { name: "beta" }
    }),
    recordedExchange({
      sequence: 4,
      method: "DELETE",
      path: "/widgets/w_1",
      operationId: "deleteWidget",
      operationKey: "path:DELETE /widgets/{widgetId}"
    })
  ];
}

const scratchDirectories: string[] = [];
const liveServices: LiveService[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
  await Promise.all(liveServices.splice(0).map((service) => service.close()));
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-probe-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Write the section 24.1 tree of one batch with one recorded trial. */
async function writeBatch(cwd: string): Promise<string> {
  const batchDir = path.join(cwd, ".oal", "runs", BATCH_ID);
  const runDir = path.join(batchDir, "trials", RUN_ID);
  await mkdir(path.join(batchDir, "inputs"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(batchDir, "inputs", "contract.ir.json"),
    `${canonicalJson(probeContract())}\n`
  );
  await writeFile(
    path.join(batchDir, "batch.json"),
    `${canonicalJson({ schema_version: 1, kind: "Batch", batch_id: BATCH_ID })}\n`
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
      run_seed: "a".repeat(64),
      server: { base_url: "http://127.0.0.1:1", mode: "contract", mcp: null },
      inputs: {},
      participant_files: [],
      extensions: {}
    })}\n`
  );
  await writeFile(
    path.join(runDir, "trace.jsonl"),
    recordedExchanges()
      .map((event) => canonicalJson(event))
      .join("\n") + "\n"
  );
  return batchDir;
}

interface ScriptedRoute {
  readonly status: number;
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly hang?: boolean;
}

/** A scripted loopback service the probe replays against. */
class LiveService {
  private readonly server: Server;
  private readonly routes = new Map<string, ScriptedRoute>();
  readonly hits: string[] = [];

  static async start(): Promise<LiveService> {
    const service = new LiveService(createServer());
    await new Promise<void>((resolve) => {
      service.server.listen(0, "127.0.0.1", resolve);
    });
    liveServices.push(service);
    return service;
  }

  private constructor(server: Server) {
    this.server = server;
    this.server.on("request", (req, res) => {
      const key = `${req.method ?? "GET"} ${req.url ?? "/"}`;
      this.hits.push(key);
      const route = this.routes.get(key);
      if (route === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no scripted route" }));
        return;
      }
      if (route.hang) {
        // The live service accepts the request and never answers.
        return;
      }
      res.writeHead(route.status, {
        "content-type": route.contentType ?? "application/json",
        ...route.headers
      });
      res.end(route.body ?? "");
    });
  }

  get baseUrl(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The loopback listener has no port.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  route(method: string, target: string, route: ScriptedRoute): void {
    this.routes.set(`${method} ${target}`, route);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }
}

interface ConformanceDocument {
  kind: string;
  scope: { level: string; id: string };
  base_url: string;
  allowlist: string[];
  writes_allowed: boolean;
  credential: { environment: string; header_names: string[] } | null;
  counts: Record<string, number>;
  results: Array<{
    trial_id: string;
    sequence: number;
    operation: string | null;
    method: string;
    path: string;
    classification: string;
    status: number | null;
    skip_reason: string | null;
    error_code: string | null;
    violations: number;
  }>;
  findings: Array<{
    id: string;
    kind: string;
    class: string;
    origin: string;
    operation: string | null;
    trial_id: string;
    sequence: number;
    response: {
      status: number;
      headers: Array<{ name: string; values: string[]; redacted: boolean }>;
    };
    violations: Array<{ code: string }>;
  }>;
}

/** The parsed conformance document the probe wrote. */
async function readDocument(out: string): Promise<ConformanceDocument> {
  return JSON.parse(
    await readFile(path.join(out, "conformance.json"), "utf8")
  ) as ConformanceDocument;
}

/** The conformance schema every written document must satisfy. */
async function loadConformanceSchema(): Promise<Json> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "conformance.v1.schema.json"),
      "utf8"
    )
  ) as Json;
}

/** Assert one written document satisfies schemas/conformance.v1. */
async function expectSchemaValid(document: ConformanceDocument): Promise<void> {
  const validator = new SchemaValidator(await loadConformanceSchema());
  expect(validator.errors(document as unknown as Json)).toEqual([]);
}

/** Drive the probe command the way the binary would. */
async function runProbe(
  cwd: string,
  args: readonly string[],
  io: MemoryIo = new MemoryIo()
): Promise<{ io: MemoryIo; code: number }> {
  const code = await main(["probe", ...args], io, { cwd });
  return { io, code };
}

describe("oal probe", () => {
  it("records undeclared-status and schema evidence against a live base url", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    service.route("GET", "/widgets/w_1", {
      status: 503,
      body: JSON.stringify({ error: "unavailable" })
    });
    const out = path.join(cwd, "probe-out");
    const io = new MemoryIo();
    const code = await main(
      [
        "probe",
        batchDir,
        "--base-url",
        service.baseUrl,
        "--operations",
        "listWidgets,getWidget",
        "--out",
        out,
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = await readDocument(out);
    await expectSchemaValid(document);
    expect(document.kind).toBe("ConformanceReport");
    expect(document.scope).toEqual({ level: "batch", id: BATCH_ID });
    expect(document.base_url).toBe(service.baseUrl);
    expect(document.allowlist).toEqual(["listWidgets", "getWidget"]);
    expect(document.writes_allowed).toBe(false);
    expect(document.credential).toBeNull();
    expect(document.counts).toMatchObject({
      requests: 4,
      replayed: 2,
      skipped: 2,
      conformant: 1,
      undeclared_status: 1,
      schema_violation: 0,
      request_error: 0,
      findings: 1
    });
    // Only the two allowlisted safe requests reached the live service.
    expect(service.hits).toEqual(["GET /widgets", "GET /widgets/w_1"]);
    // The conformant read and the undeclared status rows.
    expect(document.results[0]).toMatchObject({
      trial_id: RUN_ID,
      sequence: 1,
      operation: "listWidgets",
      classification: "conformant",
      status: 200,
      skip_reason: null
    });
    expect(document.results[1]).toMatchObject({
      sequence: 2,
      operation: "getWidget",
      classification: "undeclared_status",
      status: 503,
      violations: 1
    });
    // The recorded write stays skipped because the operator never named
    // it in the allowlist; nothing was sent.
    expect(document.results[2]).toMatchObject({
      sequence: 3,
      classification: "skipped",
      skip_reason: "not_allowlisted",
      status: null
    });
    expect(document.results[3]).toMatchObject({
      sequence: 4,
      classification: "skipped",
      skip_reason: "not_allowlisted"
    });
    // The finding speaks the server-divergence vocabulary.
    expect(document.findings).toHaveLength(1);
    const finding = document.findings[0];
    expect(finding).toMatchObject({
      kind: "undeclared_status",
      class: "spec_friction",
      origin: "server",
      operation: "getWidget",
      trial_id: RUN_ID,
      sequence: 2
    });
    expect(finding?.response.status).toBe(503);
    expect(finding?.violations[0]?.code).toBe("status_undeclared");
    // The JSON projection prints the document to stdout.
    const printed = JSON.parse(io.stdoutText()) as ConformanceDocument;
    expect(printed.kind).toBe("ConformanceReport");
    // Diagnostics stream to stderr in JSON format.
    expect(io.stderrText()).toContain(ProbeCliCode.ResponseNonconformant);
  });

  it("skips recorded writes until the explicit opt-in flag", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    service.route("GET", "/widgets/w_1", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    service.route("POST", "/widgets", {
      status: 201,
      // The required id is missing: a schema violation.
      body: JSON.stringify({ stock: 7 })
    });
    service.route("DELETE", "/widgets/w_1", {
      status: 204,
      contentType: "application/json",
      body: ""
    });
    const all = "listWidgets,getWidget,createWidget,deleteWidget";

    const refused = path.join(cwd, "refused");
    const first = await runProbe(cwd, [
      batchDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      all,
      "--out",
      refused
    ]);
    expect(first.code).toBe(EXIT_OK);
    expect(service.hits).toEqual(["GET /widgets", "GET /widgets/w_1"]);
    const refusedDoc = await readDocument(refused);
    await expectSchemaValid(refusedDoc);
    expect(refusedDoc.counts).toMatchObject({
      replayed: 2,
      skipped: 2,
      findings: 0
    });
    expect(refusedDoc.results[2]).toMatchObject({
      sequence: 3,
      classification: "skipped",
      skip_reason: "write_without_opt_in"
    });
    expect(refusedDoc.results[3]).toMatchObject({
      sequence: 4,
      classification: "skipped",
      skip_reason: "write_without_opt_in"
    });

    const allowed = path.join(cwd, "allowed");
    const second = await runProbe(cwd, [
      batchDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      all,
      "--allow-writes",
      "--out",
      allowed
    ]);
    expect(second.code).toBe(EXIT_OK);
    // The hits of the second invocation only; the two safe reads above
    // already hit the service once.
    expect(service.hits.slice(-4)).toEqual([
      "GET /widgets",
      "GET /widgets/w_1",
      "POST /widgets",
      "DELETE /widgets/w_1"
    ]);
    const allowedDoc = await readDocument(allowed);
    await expectSchemaValid(allowedDoc);
    expect(allowedDoc.writes_allowed).toBe(true);
    expect(allowedDoc.counts).toMatchObject({
      replayed: 4,
      skipped: 0,
      conformant: 3,
      schema_violation: 1,
      findings: 1
    });
    const violation = allowedDoc.findings[0];
    expect(violation).toMatchObject({
      kind: "schema_violation",
      class: "spec_friction",
      origin: "server",
      operation: "createWidget",
      sequence: 3
    });
    expect(violation?.violations[0]?.code).toBe("required");
  });

  it("warns when a named operation matches nothing", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    const out = path.join(cwd, "probe-out");
    const { io, code } = await runProbe(cwd, [
      batchDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      "listWidgets,missingOperation",
      "--out",
      out
    ]);
    expect(code).toBe(EXIT_OK);
    expect(io.stderrText()).toContain(ProbeCliCode.OperationUnknown);
    const document = await readDocument(out);
    expect(document.counts.requests).toBe(4);
    expect(document.counts.replayed).toBe(1);
  });

  it("never persists the credential a live service echoes", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4, echo: LIVE_TOKEN }),
      headers: { "x-echo-token": LIVE_TOKEN }
    });
    service.route("GET", "/widgets/w_1", {
      status: 503,
      body: JSON.stringify({ error: "unavailable", echo: LIVE_TOKEN }),
      headers: { "x-echo-authorization": LIVE_TOKEN }
    });
    const out = path.join(cwd, "probe-out");
    vi.stubEnv(CREDENTIAL_ENV, LIVE_TOKEN);
    const io = new MemoryIo();
    try {
      const { code } = await runProbe(
        cwd,
        [
          batchDir,
          "--base-url",
          service.baseUrl,
          "--operations",
          "listWidgets,getWidget",
          "--credential-env",
          CREDENTIAL_ENV,
          "--out",
          out,
          "--format",
          "json"
        ],
        io
      );
      expect(code).toBe(EXIT_OK);
    } finally {
      vi.unstubAllEnvs();
    }
    // No written artifact holds the value.
    for (const file of await readdir(out)) {
      const text = await readFile(path.join(out, file), "utf8");
      expect(text).not.toContain(LIVE_TOKEN);
      expect(text).not.toContain("probe-live-canary");
    }
    // Neither projection echoes it.
    expect(io.stdoutText()).not.toContain(LIVE_TOKEN);
    expect(io.stderrText()).not.toContain(LIVE_TOKEN);
    const document = await readDocument(out);
    await expectSchemaValid(document);
    // Names and presence survive; values never do.
    expect(document.credential).toEqual({
      environment: CREDENTIAL_ENV,
      header_names: ["authorization"]
    });
    const finding = document.findings[0];
    const echoed = finding?.response.headers.find((header) =>
      header.name.startsWith("x-echo")
    );
    expect(echoed).toMatchObject({
      name: "x-echo-authorization",
      values: ["[REDACTED]"],
      redacted: true
    });
    // The echoed body value is scrubbed inside the finding evidence.
    const raw = JSON.parse(
      await readFile(path.join(out, "conformance.json"), "utf8")
    ) as { findings: Array<{ response: { body: unknown } }> };
    expect(JSON.stringify(raw.findings[0]?.response.body)).not.toContain(
      LIVE_TOKEN
    );
  });

  it("classifies a timeout and a refused connection as request errors", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const hanging = await LiveService.start();
    hanging.route("GET", "/widgets", { status: 200, hang: true });
    const hungOut = path.join(cwd, "hung");
    const hung = await runProbe(cwd, [
      batchDir,
      "--base-url",
      hanging.baseUrl,
      "--operations",
      "listWidgets",
      "--timeout",
      "150ms",
      "--out",
      hungOut
    ]);
    expect(hung.code).toBe(EXIT_OK);
    const hungDoc = await readDocument(hungOut);
    await expectSchemaValid(hungDoc);
    expect(hungDoc.results[0]).toMatchObject({
      sequence: 1,
      classification: "request_error",
      error_code: "timeout",
      status: null
    });
    expect(hungDoc.counts.request_error).toBe(1);
    expect(hung.io.stderrText()).toContain(ProbeCliCode.RequestFailed);

    const refused = await LiveService.start();
    const url = refused.baseUrl;
    await refused.close();
    const refusedOut = path.join(cwd, "refused");
    const down = await runProbe(cwd, [
      batchDir,
      "--base-url",
      url,
      "--operations",
      "listWidgets",
      "--timeout",
      "2s",
      "--out",
      refusedOut
    ]);
    expect(down.code).toBe(EXIT_OK);
    const refusedDoc = await readDocument(refusedOut);
    expect(refusedDoc.results[0]).toMatchObject({
      classification: "request_error",
      error_code: "network"
    });
  });

  it("reports a fully conformant service with no findings", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    service.route("GET", "/widgets/w_1", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    service.route("POST", "/widgets", {
      status: 201,
      body: JSON.stringify({ id: "w_2", stock: 0 })
    });
    service.route("DELETE", "/widgets/w_1", {
      status: 204,
      contentType: "application/json",
      body: ""
    });
    const { io, code } = await runProbe(cwd, [
      batchDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      "listWidgets,getWidget,createWidget,deleteWidget",
      "--allow-writes"
    ]);
    expect(code).toBe(EXIT_OK);
    // The default out directory sits under .oal/probe/<scope-id>.
    const out = path.join(cwd, ".oal", "probe", BATCH_ID);
    const document = await readDocument(out);
    await expectSchemaValid(document);
    expect(document.counts).toMatchObject({
      requests: 4,
      replayed: 4,
      conformant: 4,
      findings: 0
    });
    expect(document.findings).toEqual([]);
    // The terminal projection summarizes the counts.
    expect(io.stdoutText()).toContain(`probe: batch ${BATCH_ID}`);
    expect(io.stdoutText()).toContain("requests: 4");
  });

  it("probes a single run directory through its batch contract", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    const out = path.join(cwd, "probe-out");
    const runDir = path.join(batchDir, "trials", RUN_ID);
    const { code } = await runProbe(cwd, [
      runDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      "listWidgets",
      "--out",
      out
    ]);
    expect(code).toBe(EXIT_OK);
    const document = await readDocument(out);
    expect(document.scope).toEqual({ level: "run", id: RUN_ID });
    expect(document.counts.requests).toBe(4);
  });

  it("refuses a target that already exists, like the import target", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const service = await LiveService.start();
    service.route("GET", "/widgets", {
      status: 200,
      body: JSON.stringify({ id: "w_1", stock: 4 })
    });
    const out = path.join(cwd, "taken");
    await mkdir(out);
    const { io, code } = await runProbe(cwd, [
      batchDir,
      "--base-url",
      service.baseUrl,
      "--operations",
      "listWidgets",
      "--out",
      out
    ]);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ProbeCliCode.TargetStale);
  });

  it("refuses a session directory, which holds no frozen contract", async () => {
    const cwd = await newWorkspace();
    const sessionDir = path.join(cwd, "session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "trace.jsonl"), "{}\n");
    await writeFile(path.join(sessionDir, "capability-report.json"), "{}\n");
    const { io, code } = await runProbe(cwd, [
      sessionDir,
      "--base-url",
      "http://127.0.0.1:1",
      "--operations",
      "listWidgets"
    ]);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ProbeCliCode.SessionUnsupported);
  });

  it("refuses a run directory whose batch contract is missing", async () => {
    const cwd = await newWorkspace();
    const orphan = path.join(cwd, "orphan-run");
    await mkdir(orphan, { recursive: true });
    await writeFile(
      path.join(orphan, "run.started.json"),
      `${canonicalJson({
        schema_version: 1,
        kind: "RunStarted",
        run_id: RUN_ID,
        batch_id: null,
        started_at: T0,
        repetition_index: 0,
        run_seed: "a".repeat(64),
        server: { base_url: "http://127.0.0.1:1", mode: "contract", mcp: null },
        inputs: {},
        participant_files: [],
        extensions: {}
      })}\n`
    );
    await writeFile(path.join(orphan, "trace.jsonl"), "\n");
    const { io, code } = await runProbe(cwd, [
      orphan,
      "--base-url",
      "http://127.0.0.1:1",
      "--operations",
      "listWidgets"
    ]);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ProbeCliCode.ContractMissing);
  });

  it("refuses a missing credential environment value without printing it", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    vi.stubEnv(CREDENTIAL_ENV, undefined);
    const io = new MemoryIo();
    try {
      const { code } = await runProbe(
        cwd,
        [
          batchDir,
          "--base-url",
          "http://127.0.0.1:1",
          "--operations",
          "listWidgets",
          "--credential-env",
          CREDENTIAL_ENV
        ],
        io
      );
      expect(code).toBe(EXIT_INVALID);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(io.stderrText()).toContain(ProbeCliCode.CredentialEnvUnset);
  });

  it("refuses an unsafe credential environment name", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const { io, code } = await runProbe(cwd, [
      batchDir,
      "--base-url",
      "http://127.0.0.1:1",
      "--operations",
      "listWidgets",
      "--credential-env",
      "not a name"
    ]);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ProbeCliCode.CredentialEnvUnsafe);
  });

  it("requires a base url, operations, and a parseable base url", async () => {
    const cwd = await newWorkspace();
    const batchDir = await writeBatch(cwd);
    const noBase = await runProbe(cwd, [
      batchDir,
      "--operations",
      "listWidgets"
    ]);
    expect(noBase.code).toBe(EXIT_INVALID);
    expect(noBase.io.stderrText()).toContain("OAL-CLI-MISSING-OPTION-VALUE");

    const noOperations = await runProbe(cwd, [
      batchDir,
      "--base-url",
      "http://127.0.0.1:1"
    ]);
    expect(noOperations.code).toBe(EXIT_INVALID);
    expect(noOperations.io.stderrText()).toContain(
      "OAL-CLI-MISSING-OPTION-VALUE"
    );

    const unparseable = await runProbe(cwd, [
      batchDir,
      "--base-url",
      "not a url",
      "--operations",
      "listWidgets"
    ]);
    expect(unparseable.code).toBe(EXIT_INVALID);
    expect(unparseable.io.stderrText()).toContain(ProbeCliCode.BaseUrlInvalid);
  });
});
