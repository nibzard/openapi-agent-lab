import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import type { BehaviorRequest } from "@oal/behavior-api";
import type {
  ContractIR,
  MediaContentIR,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SchemaIR
} from "@oal/contract-ir";
import { createGatewayState, type GatewayState } from "./state.ts";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type RawRequest
} from "./server.ts";
import type {
  ScenarioBackend,
  ScenarioOutcome,
  ScenarioTransaction
} from "./scenario.ts";

function schema(uid: string, schemaBody: Json): SchemaIR {
  return { uid, schema: schemaBody, source_pointer: "", document_uri: "" };
}

function response(init: Partial<ResponseIR>): ResponseIR {
  return {
    selector: init.selector ?? "200",
    selector_kind: init.selector_kind ?? "exact",
    status: init.status ?? 200,
    description: null,
    headers: init.headers ?? [],
    content: init.content ?? [],
    source_pointer: ""
  };
}

function jsonContent(schemaRef: string | null): MediaContentIR {
  return {
    media_type: "application/json",
    schema_ref: schemaRef,
    examples: [],
    support: "supported",
    support_reason_codes: []
  };
}

function textContent(schemaRef: string | null): MediaContentIR {
  return {
    media_type: "text/plain",
    schema_ref: schemaRef,
    examples: [],
    support: "supported",
    support_reason_codes: []
  };
}

function parameter(init: Partial<ParameterIR>): ParameterIR {
  return {
    name: init.name ?? "limit",
    location: init.location ?? "query",
    style: init.style ?? "form",
    explode: init.explode ?? false,
    allow_reserved: false,
    required: init.required ?? false,
    deprecated: false,
    description: null,
    schema_ref: init.schema_ref ?? null,
    content: null,
    examples: [],
    default_value: undefined,
    support: "supported",
    support_reason_codes: [],
    source_pointer: ""
  };
}

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:GET /things",
    uid: init.uid ?? "op_test1",
    surface: "path",
    method: init.method ?? "GET",
    path_template: init.path_template ?? "/things",
    route_segments: init.route_segments ?? [
      { kind: "literal", value: "things" }
    ],
    operation_id: null,
    tool_name: "list_things",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: init.parameters ?? [],
    request_body: init.request_body ?? null,
    responses: init.responses ?? [
      response({ content: [jsonContent("sch_thing")] })
    ],
    security: init.security ?? null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

const thingSchema = schema("sch_thing", {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } }
});

const thingInputSchema = schema("sch_thing_input", {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" } }
});

const textSchema = schema("sch_note", { type: "string" });

function contract(init: {
  operations: OperationIR[];
  schemas?: Record<string, SchemaIR>;
}): ContractIR {
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal", version: "0.1.0" },
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
    schemas:
      init.schemas ??
      ({
        sch_thing: thingSchema,
        sch_thing_input: thingInputSchema,
        sch_note: textSchema
      } as Record<string, SchemaIR>),
    operations: init.operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

/** One GET/POST pair over /things plus /things/{thingId}. */
function thingsContract(): ContractIR {
  return contract({
    operations: [
      operation({
        key: "path:GET /things",
        uid: "op_list",
        method: "GET",
        path_template: "/things",
        parameters: [parameter({ name: "limit", location: "query" })],
        responses: [response({ content: [jsonContent("sch_list")] })]
      }),
      operation({
        key: "path:POST /things",
        uid: "op_create",
        method: "POST",
        path_template: "/things",
        parameters: [],
        request_body: {
          required: true,
          content: [jsonContent("sch_thing_input")],
          source_pointer: ""
        },
        responses: [
          response({
            selector: "201",
            status: 201,
            content: [jsonContent("sch_thing")]
          })
        ]
      }),
      operation({
        key: "path:GET /things/{thingId}",
        uid: "op_get",
        method: "GET",
        path_template: "/things/{thingId}",
        route_segments: [
          { kind: "literal", value: "things" },
          { kind: "parameter", value: "thingId" }
        ],
        parameters: [
          parameter({
            name: "thingId",
            location: "path",
            required: true
          })
        ],
        responses: [
          response({ content: [jsonContent("sch_thing")] }),
          response({ selector: "404", status: 404, content: [] })
        ]
      }),
      operation({
        key: "path:GET /things/{thingId}/note",
        uid: "op_note",
        method: "GET",
        path_template: "/things/{thingId}/note",
        route_segments: [
          { kind: "literal", value: "things" },
          { kind: "parameter", value: "thingId" },
          { kind: "literal", value: "note" }
        ],
        parameters: [
          parameter({
            name: "thingId",
            location: "path",
            required: true
          })
        ],
        responses: [response({ content: [textContent("sch_note")] })]
      })
    ],
    schemas: {
      sch_thing: thingSchema,
      sch_thing_input: thingInputSchema,
      sch_note: textSchema,
      sch_list: schema("sch_list", {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", items: { type: "string" } } }
      })
    }
  });
}

function request(init: Partial<RawRequest>): RawRequest {
  return {
    method: init.method ?? "GET",
    target: init.target ?? "/things",
    headers: init.headers ?? {},
    body: init.body ?? new Uint8Array(0)
  };
}

function options(
  backend: ScenarioBackend,
  state: GatewayState = createGatewayState()
): GatewayOptions {
  return {
    contract: thingsContract(),
    limits: LIMIT_DEFAULTS,
    fixtures: [],
    runSeed: "run_seed_1",
    state,
    backend
  };
}

/** Backend stub that replays queued outcomes and records requests. */
function stubBackend(outcomes: ScenarioOutcome[]): ScenarioBackend & {
  requests: BehaviorRequest[];
  ids: string[];
} {
  const requests: BehaviorRequest[] = [];
  const ids: string[] = [];
  return {
    name: "stub",
    requests,
    ids,
    handle(
      request: BehaviorRequest,
      requestId: string
    ): Promise<ScenarioOutcome> {
      requests.push(request);
      ids.push(requestId);
      const outcome = outcomes.shift();
      if (outcome === undefined) {
        return Promise.reject(new Error("stub backend ran out of outcomes"));
      }
      return Promise.resolve(outcome);
    }
  };
}

/** State double that records every commit payload. */
function recordingState(): GatewayState & {
  commits: (ScenarioTransaction | undefined)[];
  rollbacks: number;
  staged: string[];
} {
  return {
    commits: [],
    rollbacks: 0,
    staged: [],
    stage(effect: string): void {
      this.staged.push(effect);
    },
    commit(scenario?: ScenarioTransaction): void {
      this.commits.push(scenario);
    },
    rollback(): void {
      this.rollbacks += 1;
    },
    get revision(): number {
      return this.commits.length;
    },
    get appliedEffects(): readonly string[] {
      return [];
    },
    get pendingEffects(): readonly string[] {
      return [];
    }
  };
}

function served(status: number, body: Json | undefined): ScenarioOutcome {
  return {
    kind: "served",
    response: {
      status,
      mediaType: "application/json",
      ...(body === undefined ? {} : { body: { kind: "json", value: body } })
    }
  };
}

describe("scenario backend seam", () => {
  it("serves a backend response and commits the transition after validation", async () => {
    const state = recordingState();
    const outcome: ScenarioOutcome = {
      kind: "served",
      response: {
        status: 201,
        mediaType: "application/json",
        body: { kind: "json", value: { id: "thing_1" } }
      },
      commit: {
        nextState: { things: ["thing_1"] },
        semanticEvents: [
          { name: "thing.created", eventVersion: 1, payload: { id: "thing_1" } }
        ],
        effects: ["create_thing"]
      }
    };
    const backend = stubBackend([outcome]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"name":"first"}')
      })
    );
    expect(response.status).toBe(201);
    expect(response.provenance).toBe("behavior:stub");
    expect(JSON.parse(response.body ?? "{}")).toEqual({ id: "thing_1" });
    // The commit carries the exchange plus the validated transition.
    expect(state.commits).toHaveLength(1);
    const transaction = state.commits[0];
    expect(transaction?.exchange).toEqual({
      requestId: "req_00000001",
      method: "POST",
      target: "/things",
      operationKey: "path:POST /things",
      status: 201
    });
    expect(transaction?.commit?.nextState).toEqual({ things: ["thing_1"] });
    expect(transaction?.commit?.effects).toEqual(["create_thing"]);
    expect(state.rollbacks).toBe(0);
  });

  it("refuses a contract-violating backend body and rolls back", async () => {
    const state = recordingState();
    const backend = stubBackend([served(200, { items: "not-an-array" })]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("mock_response_invalid");
    expect(state.commits).toHaveLength(0);
    expect(state.rollbacks).toBe(1);
  });

  it("refuses an undeclared status and rolls back", async () => {
    const state = recordingState();
    const backend = stubBackend([served(418, { id: "thing_1" })]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({ target: "/things/thing_1" })
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("mock_response_invalid");
    expect(state.commits).toHaveLength(0);
    expect(state.rollbacks).toBe(1);
  });

  it("serves a declared domain error without a state transition", async () => {
    const state = recordingState();
    const backend = stubBackend([served(404, undefined)]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({ target: "/things/missing" })
    );
    expect(response.status).toBe(404);
    expect(response.frameworkCode).toBeNull();
    // The exchange is recorded, but no transition rides along.
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]?.commit).toBeUndefined();
    expect(state.commits[0]?.exchange.status).toBe(404);
  });

  it("maps a backend timeout to 504 and rolls back", async () => {
    const state = recordingState();
    const backend = stubBackend([
      { kind: "timeout", timeoutMs: 1500, message: "child wedged" }
    ]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(504);
    expect(response.frameworkCode).toBe("behavior_timeout");
    expect(response.body).toContain("1500");
    expect(state.commits).toHaveLength(0);
    expect(state.rollbacks).toBe(1);
  });

  it("maps an internal backend outcome to 500 without leaking detail", async () => {
    const state = recordingState();
    const backend = stubBackend([
      { kind: "internal", message: "SQLSTATE=42P01 at /srv/secrets" }
    ]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("internal_error");
    expect(response.body ?? "").not.toContain("SQLSTATE");
    expect(response.body ?? "").not.toContain("/srv/secrets");
    expect(state.rollbacks).toBe(1);
  });

  it("maps a thrown handle call to 500 without leaking detail", async () => {
    const state = recordingState();
    const backend: ScenarioBackend = {
      name: "stub",
      handle() {
        return Promise.reject(new Error("ENOENT /pack/behavior/index.ts"));
      }
    };
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("internal_error");
    expect(response.body ?? "").not.toContain("ENOENT");
    expect(state.rollbacks).toBe(1);
  });

  it("maps a failed state commit to a bounded 500", async () => {
    const state: GatewayState = {
      ...createGatewayState(),
      commit() {
        throw new Error("SQLITE_BUSY");
      }
    };
    const backend = stubBackend([served(200, { items: [] })]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("OAL-STATE-COMMIT-FAILED");
    expect(response.body ?? "").not.toContain("SQLITE_BUSY");
  });

  it("serves a text body verbatim under a text media type", async () => {
    const backend = stubBackend([
      {
        kind: "served",
        response: {
          status: 200,
          mediaType: "text/plain",
          body: { kind: "text", text: "hello\nworld" }
        }
      }
    ]);
    const response = await handleGatewayRequest(
      options(backend),
      1,
      request({ target: "/things/thing_1/note" })
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello\nworld");
    expect(response.headers["content-type"]).toBe("text/plain");
  });

  it("refuses backend body kinds the wire cannot serialize", async () => {
    const state = recordingState();
    const backend = stubBackend([
      {
        kind: "served",
        response: {
          status: 200,
          mediaType: "application/json",
          body: {
            kind: "binary",
            bytes: new Uint8Array([1, 2, 3, 4]),
            sizeBytes: 4,
            sha256: "0".repeat(64)
          }
        }
      }
    ]);
    const response = await handleGatewayRequest(
      options(backend, state),
      1,
      request({})
    );
    expect(response.status).toBe(500);
    expect(response.frameworkCode).toBe("mock_response_invalid");
    expect(state.rollbacks).toBe(1);
  });

  it("passes validated request context, never raw input", async () => {
    const backend = stubBackend([served(200, { items: [] })]);
    const response = await handleGatewayRequest(
      options(backend),
      8,
      request({
        target: "/things?limit=5",
        headers: { accept: "application/json, text/plain;q=0.5" }
      })
    );
    expect(response.status).toBe(200);
    const seen = backend.requests[0];
    expect(seen).toBeDefined();
    expect(seen.operation.key).toBe("path:GET /things");
    expect(seen.parameters.path).toEqual({});
    expect(seen.parameters.query).toEqual({ limit: 5 });
    expect(seen.principal).toEqual({
      scheme: "anonymous",
      scopes: [],
      anonymous: true
    });
    expect(seen.body).toEqual({ kind: "none" });
    expect(seen.selectedRequestMediaType).toBeNull();
    expect(seen.acceptedResponseMediaTypes).toEqual([
      "application/json",
      "text/plain"
    ]);
    expect(backend.ids).toEqual(["req_00000008"]);
  });

  it("hands the backend the parsed body and matched request media type", async () => {
    const backend = stubBackend([served(201, { id: "thing_1" })]);
    await handleGatewayRequest(
      options(backend),
      3,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"name":"first"}')
      })
    );
    const seen = backend.requests[0];
    expect(seen.body).toEqual({ kind: "json", value: { name: "first" } });
    expect(seen.selectedRequestMediaType).toBe("application/json");
  });

  it("serializes concurrent scenario requests through one state", async () => {
    // Two concurrent requests over one state must not interleave their
    // transactions; the chain commits each before the next starts.
    const state = recordingState();
    const order: string[] = [];
    let calls = 0;
    const backend: ScenarioBackend = {
      name: "stub",
      async handle(_request: BehaviorRequest, requestId: string) {
        calls += 1;
        order.push(`start:${requestId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${requestId}`);
        return served(200, { items: [] });
      }
    };
    const first = handleGatewayRequest(options(backend, state), 1, request({}));
    const second = handleGatewayRequest(
      options(backend, state),
      2,
      request({})
    );
    const responses = await Promise.all([first, second]);
    expect(responses.map((entry) => entry.status)).toEqual([200, 200]);
    // Each request's backend call completed before the next began.
    expect(order).toEqual([
      "start:req_00000001",
      "end:req_00000001",
      "start:req_00000002",
      "end:req_00000002"
    ]);
    expect(calls).toBe(2);
    expect(state.commits).toHaveLength(2);
  });
});
