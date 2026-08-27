import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import {
  Redactor,
  captureBody,
  traceHeaders,
  type TraceEvent
} from "@oal/evidence";
import {
  handleGatewayRequest,
  mintRunCredentials,
  type GatewayOptions,
  type RawRequest
} from "@oal/gateway";
import { DOCTOR_PROBE_LIMITS } from "./doctor.ts";
import { runCreatedEvent, runFinishedEvent, traceEvent } from "./fixtures.ts";
import {
  replayContractSha256,
  replayRun,
  type ReplayContract,
  type ReplayEvidenceEvent,
  type ReplayFixture
} from "./replay.ts";

const RUN_ID = "run-replay-1";
const RUN_SEED = "seed-replay-1";

const FIXTURES: readonly ReplayFixture[] = [
  {
    id: "fx-widget",
    operation: "path:GET /widgets/{id}",
    status: 200,
    body: { kind: "json", value: { fixed: true, id: "c-7" } }
  }
];

function testContract(): ReplayContract {
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
  const idSchema = {
    uid: "sch_id",
    schema: { type: "string", minLength: 1 },
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
  const jsonContent = (schemaRef: string) => [
    {
      media_type: "application/json",
      schema_ref: schemaRef,
      examples: [],
      support: "supported" as const,
      support_reason_codes: []
    }
  ];
  const jsonResponse = (
    status: number,
    schemaRef: string,
    examples: Array<{
      name: string | null;
      summary: string | null;
      value: Json;
    }> = []
  ) => ({
    selector: status.toString(10),
    selector_kind: "exact" as const,
    status,
    description: null,
    headers: [],
    content: [
      {
        media_type: "application/json",
        schema_ref: schemaRef,
        examples,
        support: "supported" as const,
        support_reason_codes: []
      }
    ],
    source_pointer: ""
  });
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal-test", version: "0" },
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
    security_schemes: {
      apiKeyAuth: {
        name: "apiKeyAuth",
        type: "apiKey",
        description: null,
        location: "header",
        wire_name: "x-api-key",
        scheme: null,
        bearer_format: null,
        flows: null,
        open_id_connect_url: null,
        support: "supported",
        support_reason_codes: [],
        source_pointer: ""
      }
    },
    schemas: {
      sch_widget: widgetSchema,
      sch_id: idSchema,
      sch_widget_input: inputSchema
    },
    operations: [
      {
        key: "path:GET /widgets",
        uid: "op_list_widgets",
        surface: "path",
        method: "GET",
        path_template: "/widgets",
        route_segments: [{ kind: "literal", value: "widgets" }],
        operation_id: "listWidgets",
        tool_name: "list_widgets",
        summary: null,
        description: null,
        tags: [],
        deprecated: false,
        servers: [],
        parameters: [],
        request_body: null,
        responses: [jsonResponse(200, "sch_widget")],
        security: {
          anonymous: false,
          alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
        },
        callbacks: [],
        extensions: {},
        source_pointer: "",
        support: { level: "supported", diagnostic_codes: [] }
      },
      {
        key: "path:POST /widgets",
        uid: "op_create_widget",
        surface: "path",
        method: "POST",
        path_template: "/widgets",
        route_segments: [{ kind: "literal", value: "widgets" }],
        operation_id: "createWidget",
        tool_name: "create_widget",
        summary: null,
        description: null,
        tags: [],
        deprecated: false,
        servers: [],
        parameters: [],
        request_body: {
          required: true,
          description: null,
          content: jsonContent("sch_widget_input"),
          source_pointer: ""
        },
        responses: [
          jsonResponse(201, "sch_widget", [
            {
              name: "created",
              summary: null,
              value: { id: "w-1", name: "alpha" }
            }
          ])
        ],
        security: {
          anonymous: false,
          alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
        },
        callbacks: [],
        extensions: {},
        source_pointer: "",
        support: { level: "supported", diagnostic_codes: [] }
      },
      {
        key: "path:GET /widgets/{id}",
        uid: "op_get_widget",
        surface: "path",
        method: "GET",
        path_template: "/widgets/{id}",
        route_segments: [
          { kind: "literal", value: "widgets" },
          { kind: "parameter", value: "id" }
        ],
        operation_id: "getWidget",
        tool_name: "get_widget",
        summary: null,
        description: null,
        tags: [],
        deprecated: false,
        servers: [],
        parameters: [
          {
            name: "id",
            location: "path",
            style: "simple",
            explode: false,
            allow_reserved: false,
            required: true,
            deprecated: false,
            description: null,
            schema_ref: "sch_id",
            content: null,
            examples: [],
            default_value: undefined,
            support: "supported",
            support_reason_codes: [],
            source_pointer: ""
          }
        ],
        request_body: null,
        responses: [jsonResponse(200, "sch_widget")],
        security: {
          anonymous: false,
          alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
        },
        callbacks: [],
        extensions: {},
        source_pointer: "",
        support: { level: "supported", diagnostic_codes: [] }
      }
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

function gatewayOptions(): GatewayOptions {
  const options: GatewayOptions = {
    contract: testContract(),
    limits: DOCTOR_PROBE_LIMITS,
    runSeed: RUN_SEED
  };
  options.fixtures = [...FIXTURES];
  return options;
}

/** Redactor that preserves every value, for fully recorded evidence. */
function fullRedactor(): Redactor {
  return new Redactor({
    hmacKey: new Uint8Array(32).fill(3),
    secrets: [],
    config: { keyPatterns: [] }
  });
}

/** Redactor that redacts the credential header, as a run recording does. */
function credentialRedactor(): Redactor {
  return new Redactor({
    hmacKey: new Uint8Array(32).fill(5),
    secrets: [],
    config: { keyPatterns: [], sensitiveHeaderNames: ["x-api-key"] }
  });
}

const CAPTURE_LIMITS = {
  maxJsonBytes: 65_536,
  maxTextPreviewBytes: 4_096,
  captureBlobs: false
};

interface ExchangeInit {
  sequence: number;
  method: string;
  target: string;
  headers: Record<string, string>;
  body?: string | undefined;
  operationKey: string;
  authentication: "authenticated" | "rejected";
}

/**
 * Record one exchange by driving the gateway, the same way the runner
 * recording layer does: request and response pass through the shared
 * capture helpers under the supplied redactor.
 */
async function recordExchange(
  options: GatewayOptions,
  redactor: Redactor,
  init: ExchangeInit
): Promise<TraceEvent> {
  const bytes = new TextEncoder().encode(init.body ?? "");
  const raw: RawRequest = {
    method: init.method,
    target: init.target,
    headers: init.headers,
    body: bytes
  };
  const response = handleGatewayRequest(options, init.sequence, raw);
  const requestHeaders = traceHeaders(
    Object.entries(init.headers).map(([name, value]) => [name, [value]]),
    redactor
  );
  const responseHeaders = traceHeaders(
    Object.entries(response.headers).map(([name, value]) => [name, [value]]),
    redactor
  );
  const requestBody = await captureBody({
    bytes,
    contentType: init.headers["content-type"] ?? null,
    redactor,
    blobs: null,
    limits: CAPTURE_LIMITS
  });
  const responseBody = await captureBody({
    bytes: new TextEncoder().encode(response.body ?? ""),
    contentType: response.headers["content-type"] ?? null,
    redactor,
    blobs: null,
    limits: CAPTURE_LIMITS
  });
  const path = init.target.split("?")[0] ?? init.target;
  const method = init.method.toUpperCase();
  return {
    ...traceEvent({
      sequence: init.sequence,
      runId: RUN_ID,
      method,
      path,
      status: response.status,
      operation: {
        matched: true,
        key: init.operationKey,
        uid: "op_test",
        operation_id: init.operationKey,
        method,
        path_template: path,
        support: "supported"
      }
    }),
    transport: {
      kind: "http",
      request_id: response.requestId,
      connection_id: null
    },
    request: {
      received_at: "2026-08-27T12:00:00.000Z",
      method,
      path,
      query_string: "",
      query: [],
      path_parameters: {},
      headers: requestHeaders,
      credential_present: true,
      content_type: init.headers["content-type"] ?? null,
      body: requestBody
    },
    authentication: {
      status: init.authentication,
      alternative_index: 0,
      schemes: ["apiKeyAuth"],
      principal_ref: null
    },
    response: {
      completed_at: "2026-08-27T12:00:00.001Z",
      status: response.status,
      headers: responseHeaders,
      content_type: response.headers["content-type"] ?? null,
      body: responseBody
    }
  };
}

/** Four recorded exchanges: list, create, fixture read, rejected read. */
async function recordedExchanges(redactor: Redactor): Promise<TraceEvent[]> {
  const options = gatewayOptions();
  const key = mintRunCredentials(options.contract, RUN_SEED).apiKeys[
    "apiKeyAuth"
  ];
  if (key === undefined) {
    throw new Error("The test contract must declare the apiKeyAuth scheme.");
  }
  return [
    await recordExchange(options, redactor, {
      sequence: 1,
      method: "GET",
      target: "/widgets",
      headers: { "x-api-key": key, accept: "application/json" },
      operationKey: "path:GET /widgets",
      authentication: "authenticated"
    }),
    await recordExchange(options, redactor, {
      sequence: 2,
      method: "POST",
      target: "/widgets",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: '{"name":"alpha"}',
      operationKey: "path:POST /widgets",
      authentication: "authenticated"
    }),
    await recordExchange(options, redactor, {
      sequence: 3,
      method: "GET",
      target: "/widgets/c-7",
      headers: { "x-api-key": key },
      operationKey: "path:GET /widgets/{id}",
      authentication: "authenticated"
    }),
    await recordExchange(options, redactor, {
      sequence: 4,
      method: "GET",
      target: "/widgets",
      headers: { "x-api-key": "totally-wrong-key" },
      operationKey: "path:GET /widgets",
      authentication: "rejected"
    })
  ];
}

async function recordedRun(redactor: Redactor): Promise<ReplayEvidenceEvent[]> {
  const traces = await recordedExchanges(redactor);
  return [
    runCreatedEvent({ runId: RUN_ID, sequence: 1 }),
    runFinishedEvent(
      { runId: RUN_ID, sequence: 2 },
      "completed",
      "intact",
      9000
    ),
    ...traces
  ];
}

function replayInput(events: readonly ReplayEvidenceEvent[]) {
  const contract = testContract();
  return {
    runId: RUN_ID,
    events,
    contract,
    contractSha256: replayContractSha256(contract),
    runSeed: RUN_SEED,
    fixtures: FIXTURES,
    limits: DOCTOR_PROBE_LIMITS,
    verify: true
  };
}

describe("replayRun", () => {
  it("verifies every recorded exchange of a faithful run", async () => {
    const events = await recordedRun(fullRedactor());
    const result = replayRun(replayInput(events));

    expect(result.counts).toEqual({
      in_scope: 4,
      replayed: 4,
      verified: 4,
      mismatched: 0,
      skipped: 0,
      failed: 0
    });
    expect(result.coverage).toBe(1);
    expect(result.full_verification).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.contract.match).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "verified",
      "verified",
      "verified",
      "verified"
    ]);
    expect(result.outcomes.map((outcome) => outcome.classification)).toEqual([
      "full",
      "full",
      "full",
      "full"
    ]);
    expect(result.outcomes[0]?.request_id).toBe("req_00000001");
    expect(result.outcomes[2]?.recorded_status).toBe(200);
    expect(result.replay_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a mutated record and grades it by verify mode", async () => {
    const events = structuredClone(await recordedRun(fullRedactor()));
    const mutatedStatus = events[3];
    const mutatedBody = events[4];
    expect(mutatedStatus?.type).toBe("api.exchange");
    expect(mutatedBody?.type).toBe("api.exchange");
    if (
      mutatedStatus?.type === "api.exchange" &&
      mutatedStatus.response !== null
    ) {
      mutatedStatus.response.status = 200;
    }
    if (
      mutatedBody?.type === "api.exchange" &&
      mutatedBody.response !== null &&
      mutatedBody.response.body.kind === "json"
    ) {
      mutatedBody.response.body.value = { fixed: false, id: "c-7" };
    }

    const lenient = replayRun({ ...replayInput(events), verify: false });
    expect(lenient.counts).toEqual({
      in_scope: 4,
      replayed: 4,
      verified: 2,
      mismatched: 2,
      skipped: 0,
      failed: 0
    });
    expect(lenient.coverage).toBe(0.5);
    expect(lenient.full_verification).toBe(false);
    expect(lenient.outcomes[1]?.differences).toEqual([
      {
        kind: "status",
        name: null,
        recorded: "200",
        observed: "201"
      }
    ]);
    expect(lenient.outcomes[2]?.differences[0]?.kind).toBe("body");
    const mismatchDiagnostics = lenient.diagnostics.filter(
      (diagnostic) => diagnostic.code === "replay.mismatch"
    );
    expect(mismatchDiagnostics).toHaveLength(2);
    expect(
      mismatchDiagnostics.every(
        (diagnostic) => diagnostic.severity === "warning"
      )
    ).toBe(true);

    const strict = replayRun({ ...replayInput(events), verify: true });
    expect(
      strict.diagnostics
        .filter((diagnostic) => diagnostic.code === "replay.mismatch")
        .every((diagnostic) => diagnostic.severity === "error")
    ).toBe(true);
    expect(strict.full_verification).toBe(false);
  });

  it("substitutes redacted credentials with minted run values", async () => {
    const events = await recordedRun(credentialRedactor());
    const first = events[2];
    if (first?.type === "api.exchange" && first.request !== null) {
      expect(first.request.headers[0]).toMatchObject({
        name: "x-api-key",
        redacted: true
      });
    }

    const result = replayRun(replayInput(events));

    expect(result.counts.verified).toBe(4);
    expect(result.full_verification).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.classification)).toEqual([
      "substitutable",
      "substitutable",
      "substitutable",
      "substitutable"
    ]);
    expect(result.outcomes[0]?.substituted).toEqual(["apiKeyAuth"]);
    expect(result.outcomes[0]?.reason_code).toBe("credential_substituted");
    expect(result.outcomes[3]?.recorded_status).toBe(401);
    expect(result.outcomes[3]?.observed_status).toBe(401);
  });

  it("withholds full verification while a request is unavailable", async () => {
    const events = structuredClone(await recordedRun(fullRedactor()));
    const secret = events[3];
    if (secret?.type === "api.exchange") {
      secret.replay = {
        classification: "unavailable",
        reason_code: "secret_body"
      };
    }

    const result = replayRun(replayInput(events));

    expect(result.counts.skipped).toBe(1);
    expect(result.counts.verified).toBe(3);
    expect(result.coverage).toBe(0.75);
    expect(result.full_verification).toBe(false);
    expect(result.outcomes[1]?.status).toBe("skipped");
    expect(result.outcomes[1]?.reason_code).toBe("secret_body");
    expect(result.outcomes[1]?.classification).toBe("unavailable");
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "replay.unavailable" &&
          diagnostic.severity === "error"
      )
    ).toBe(true);
  });

  it("refuses replay of request bodies the record cannot rebuild", async () => {
    const events = structuredClone(await recordedRun(fullRedactor()));
    const binary = events[3];
    if (binary?.type === "api.exchange" && binary.request !== null) {
      binary.request.body = {
        kind: "binary",
        size_bytes: 4,
        sha256: "f".repeat(64),
        blob_ref: null
      };
    }

    const result = replayRun(replayInput(events));

    expect(result.outcomes[1]?.status).toBe("skipped");
    expect(result.outcomes[1]?.reason_code).toBe(
      "body_representation_unsupported"
    );
    expect(result.full_verification).toBe(false);
  });

  it("skips exchanges whose record holds no response", async () => {
    const events = structuredClone(await recordedRun(fullRedactor()));
    const absent = events[4];
    if (absent?.type === "api.exchange") {
      absent.response = null;
    }

    const result = replayRun(replayInput(events));

    expect(result.outcomes[2]?.status).toBe("skipped");
    expect(result.outcomes[2]?.reason_code).toBe("response_absent");
  });

  it("replays only the requested sequence", async () => {
    const events = await recordedRun(fullRedactor());

    const one = replayRun({
      ...replayInput(events),
      request: 3,
      verify: false
    });
    expect(one.counts).toEqual({
      in_scope: 1,
      replayed: 1,
      verified: 1,
      mismatched: 0,
      skipped: 0,
      failed: 0
    });
    expect(one.outcomes[0]?.sequence).toBe(3);
    expect(one.request_filter).toBe(3);

    const none = replayRun({ ...replayInput(events), request: 99 });
    expect(none.counts.in_scope).toBe(0);
    expect(none.coverage).toBe(0);
    expect(none.full_verification).toBe(false);
    expect(
      none.diagnostics.some(
        (diagnostic) => diagnostic.code === "replay.request_not_found"
      )
    ).toBe(true);
  });

  it("fails the frozen contract digest check on drift", async () => {
    const events = await recordedRun(fullRedactor());
    const result = replayRun({
      ...replayInput(events),
      contractSha256: "0".repeat(64)
    });

    expect(result.contract.match).toBe(false);
    expect(result.full_verification).toBe(false);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "replay.contract_mismatch" &&
          diagnostic.severity === "error"
      )
    ).toBe(true);
  });

  it("warns about incomplete or foreign evidence", async () => {
    const traces = await recordedExchanges(fullRedactor());
    const foreign = traceEvent({
      runId: "run-other",
      sequence: 9,
      status: 200
    });

    const unfinished = replayRun({
      ...replayInput([
        runCreatedEvent({ runId: RUN_ID, sequence: 1 }),
        ...traces
      ]),
      verify: false
    });
    expect(
      unfinished.diagnostics.some(
        (diagnostic) => diagnostic.code === "replay.run_unfinished"
      )
    ).toBe(true);

    const foreignRun = replayRun({
      ...replayInput([...traces, foreign]),
      verify: false
    });
    expect(foreignRun.counts.in_scope).toBe(4);
    expect(
      foreignRun.diagnostics.some(
        (diagnostic) => diagnostic.code === "replay.foreign_run_events"
      )
    ).toBe(true);

    const bare = replayRun({ ...replayInput(traces), verify: false });
    expect(
      bare.diagnostics.some(
        (diagnostic) => diagnostic.code === "replay.lifecycle_absent"
      )
    ).toBe(true);
  });

  it("produces a stable digest over the replay", async () => {
    const events = await recordedRun(fullRedactor());
    const first = replayRun(replayInput(events));
    const second = replayRun(replayInput(structuredClone(events)));
    expect(second.replay_sha256).toBe(first.replay_sha256);

    const strict = replayRun({ ...replayInput(events), verify: false });
    expect(strict.replay_sha256).not.toBe(first.replay_sha256);
  });
});
