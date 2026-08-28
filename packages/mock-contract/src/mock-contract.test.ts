import { describe, expect, it } from "vitest";

import { SchemaValidator, type Json } from "@oal/core";
import type {
  ContractIR,
  OperationIR,
  ResponseIR,
  SchemaIR,
  SecuritySchemeIR
} from "@oal/contract-ir";
import { deriveSingleOperation, roundTripCheck } from "./derive.ts";
import { verifyDeterminism } from "./determinism.ts";
import { BuiltinMockAdapter } from "./builtin.ts";
import {
  operationByKey,
  serializeMockResponse,
  type MockRespondInput
} from "./types.ts";

function schema(uid: string, body: Json): SchemaIR {
  return { uid, schema: body, source_pointer: "", document_uri: "" };
}

function scheme(): SecuritySchemeIR {
  return {
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
  };
}

function response(init: Partial<ResponseIR>): ResponseIR {
  return {
    selector: init.selector ?? "200",
    selector_kind: init.selector_kind ?? "exact",
    status: init.status ?? 200,
    description: null,
    headers: [],
    content: init.content ?? [
      {
        media_type: "application/json",
        schema_ref: "sch_computer",
        examples: [
          {
            name: "default",
            summary: null,
            value: { id: "computer_0001", template: "system/chrome" }
          }
        ],
        support: "supported",
        support_reason_codes: []
      }
    ],
    source_pointer: ""
  };
}

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:POST /v1/computers",
    uid: init.uid ?? "op_create1",
    surface: "path",
    method: init.method ?? "POST",
    path_template: init.path_template ?? "/v1/computers",
    route_segments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "computers" }
    ],
    operation_id: init.operation_id ?? "createComputer",
    tool_name: "create_computer",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: init.parameters ?? [],
    request_body: init.request_body ?? null,
    responses: init.responses ?? [response({})],
    security: init.security ?? {
      anonymous: false,
      alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
    },
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function contract(): ContractIR {
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
    security_schemes: { apiKeyAuth: scheme() },
    schemas: {
      sch_computer: schema("sch_computer", {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } }
      })
    },
    operations: [
      operation({}),
      operation({
        key: "path:GET /v1/computers",
        uid: "op_list1",
        method: "GET",
        operation_id: "listComputers"
      })
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

const SEED = "a".repeat(64);

/** Pointer form the compiler keeps for a preserved recursive reference. */
const NODE_POINTER = "#/components/schemas/Node";

/**
 * A contract whose response schema is recursive. The compiler preserves
 * the nested reference as a document pointer, so response generation
 * resolves it through the contract's schema registry.
 */
function recursiveContract(): ContractIR {
  const nodeSchema: Json = {
    type: "object",
    required: ["name", "children"],
    properties: {
      name: { type: "string" },
      children: { type: "array", items: { $ref: NODE_POINTER } }
    }
  };
  return {
    ...contract(),
    schemas: {
      sch_node: {
        uid: "sch_node",
        schema: nodeSchema,
        source_pointer: NODE_POINTER,
        document_uri: "openapi.yaml"
      }
    },
    operations: [
      operation({
        responses: [
          response({
            content: [
              {
                media_type: "application/json",
                schema_ref: "sch_node",
                examples: [],
                support: "supported",
                support_reason_codes: []
              }
            ]
          })
        ]
      })
    ]
  };
}

/** A contract whose success response declares two media types. */
function dualMediaContract(): ContractIR {
  return {
    ...contract(),
    operations: [
      operation({
        responses: [
          response({
            content: [
              {
                media_type: "application/json",
                schema_ref: "sch_computer",
                examples: [],
                support: "supported",
                support_reason_codes: []
              },
              {
                media_type: "text/plain",
                schema_ref: null,
                examples: [],
                support: "supported",
                support_reason_codes: []
              }
            ]
          })
        ]
      })
    ]
  };
}

/**
 * A contract whose success response is a closed tuple that no valid
 * item count can satisfy: three prefix positions against the default
 * array bound of two. This is the V2U-normalized form of a 3.0 tuple
 * with `additionalItems: false`.
 */
function closedTupleContract(): ContractIR {
  return {
    ...contract(),
    schemas: {
      sch_tuple: schema("sch_tuple", {
        type: "array",
        minItems: 3,
        prefixItems: [
          { type: "string" },
          { type: "integer" },
          { type: "string" }
        ],
        items: false
      })
    },
    operations: [
      operation({
        responses: [
          response({
            content: [
              {
                media_type: "application/json",
                schema_ref: "sch_tuple",
                examples: [],
                support: "supported",
                support_reason_codes: []
              }
            ]
          })
        ]
      })
    ]
  };
}

/** A contract whose success response is a tuple that fits the bound. */
function boundedTupleContract(): ContractIR {
  return {
    ...contract(),
    schemas: {
      sch_tuple: schema("sch_tuple", {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
        items: false
      })
    },
    operations: [
      operation({
        responses: [
          response({
            content: [
              {
                media_type: "application/json",
                schema_ref: "sch_tuple",
                examples: [],
                support: "supported",
                support_reason_codes: []
              }
            ]
          })
        ]
      })
    ]
  };
}

function candidate(source: ContractIR, operationKey: string): MockRespondInput {
  return {
    contract: source,
    seed: SEED,
    request: {
      operationKey,
      pathParameters: {},
      query: {},
      headers: {},
      cookies: {},
      body: undefined,
      contentType: null,
      accept: "application/json"
    }
  };
}

describe("deriveSingleOperation", () => {
  it("derives one operation with reachable schemas and schemes", () => {
    const source = contract();
    const derived = deriveSingleOperation(source, "path:POST /v1/computers");
    expect(derived.contract.operations).toHaveLength(1);
    expect(derived.contract.operations[0]?.key).toBe("path:POST /v1/computers");
    expect(derived.contract.schemas.sch_computer).toBeDefined();
    expect(derived.contract.security_schemes.apiKeyAuth).toBeDefined();
    expect(derived.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("drops unrelated operations and keeps the source untouched", () => {
    const source = contract();
    const derived = deriveSingleOperation(source, "path:POST /v1/computers");
    expect(source.operations).toHaveLength(2);
    expect(
      derived.contract.operations.some(
        (entry) => entry.key === "path:GET /v1/computers"
      )
    ).toBe(false);
  });

  it("round-trips the derived operation byte-for-byte", () => {
    const source = contract();
    const derived = deriveSingleOperation(source, "path:POST /v1/computers");
    expect(roundTripCheck(source, derived, "path:POST /v1/computers")).toEqual(
      []
    );
  });

  it("throws for an unknown operation key", () => {
    expect(() =>
      deriveSingleOperation(contract(), "path:DELETE /nope")
    ).toThrow();
  });
});

describe("BuiltinMockAdapter", () => {
  it("resolves declared examples deterministically", () => {
    const source = contract();
    const adapter = new BuiltinMockAdapter();
    const first = adapter.respond(candidate(source, "path:POST /v1/computers"));
    expect(first).not.toBeNull();
    expect(first?.status).toBe(200);
    expect(first?.provenance).toContain("example");
    expect(first?.body).toEqual({
      id: "computer_0001",
      template: "system/chrome"
    });
  });

  it("negotiates the response media type from accept", () => {
    const source = contract();
    const adapter = new BuiltinMockAdapter();
    const input = candidate(source, "path:POST /v1/computers");
    const selected = adapter.respond({
      ...input,
      request: { ...input.request, accept: "application/json" }
    });
    expect(selected?.mediaType).toBe("application/json");
  });

  it("serves a fixture under its declared media type, not a relabeled one", () => {
    const adapter = new BuiltinMockAdapter([
      {
        id: "fx_json",
        operation: "path:POST /v1/computers",
        status: 200,
        media_type: "application/json",
        headers: {},
        body: { kind: "json_inline", value: { id: "computer_fixture" } }
      }
    ]);
    const served = adapter.respond({
      ...candidate(dualMediaContract(), "path:POST /v1/computers"),
      request: {
        ...candidate(dualMediaContract(), "path:POST /v1/computers").request,
        accept: "text/plain"
      }
    });
    expect(served?.mediaType).toBe("application/json");
    expect(served?.body).toEqual({ id: "computer_fixture" });
    expect(served?.provenance).toBe("fixture:fx_json");
  });

  it("keeps negotiating when no fixture is selected", () => {
    const adapter = new BuiltinMockAdapter();
    const input = candidate(dualMediaContract(), "path:POST /v1/computers");
    const served = adapter.respond({
      ...input,
      request: { ...input.request, accept: "text/plain" }
    });
    expect(served?.mediaType).toBe("text/plain");
    expect(served?.provenance).toBe("none");
  });

  it("serves the documented default media type without accept", () => {
    const adapter = new BuiltinMockAdapter();
    const input = candidate(dualMediaContract(), "path:POST /v1/computers");
    const served = adapter.respond({
      ...input,
      request: { ...input.request, accept: null }
    });
    expect(served?.mediaType).toBe("application/json");
  });

  it("returns null for an operation outside the contract", () => {
    const adapter = new BuiltinMockAdapter();
    expect(
      adapter.respond({
        contract: contract(),
        seed: SEED,
        request: {
          operationKey: "path:PATCH /nothing",
          pathParameters: {},
          query: {},
          headers: {},
          cookies: {},
          body: undefined,
          contentType: null,
          accept: null
        }
      })
    ).toBeNull();
  });

  it("resolves preserved recursive references like the gateway (V2X)", () => {
    const source = recursiveContract();
    const adapter = new BuiltinMockAdapter();
    const served = adapter.respond(
      candidate(source, "path:POST /v1/computers")
    );
    expect(served).not.toBeNull();
    expect(served?.provenance).toBe("schema_generation");
    expect(served?.mediaType).toBe("application/json");

    // The recursion descends and terminates in an empty children array,
    // exactly as the gateway pipeline generates the same schema.
    let node = served?.body as { name?: Json; children?: Json[] };
    let depth = 0;
    while (Array.isArray(node.children) && node.children.length > 0) {
      node = node.children[0] as { name?: Json; children?: Json[] };
      depth += 1;
    }
    expect(depth).toBeGreaterThan(1);
    expect(depth).toBeLessThan(24);

    const nodeSchema = source.schemas.sch_node?.schema;
    if (nodeSchema === undefined) {
      throw new Error("the compiled source did not register sch_node");
    }
    // The validator resolves `#` references against its root schema, so
    // the registry is mounted as a document-shaped root for the check.
    const documentRoot: Json = {
      $ref: NODE_POINTER,
      components: { schemas: { Node: nodeSchema } }
    };
    const servedBody = served?.body;
    if (servedBody === undefined) {
      throw new Error("the mock served no body to validate");
    }
    expect(new SchemaValidator(documentRoot).errors(servedBody)).toEqual([]);
  });

  it("returns null when tuple generation admits no valid count", () => {
    const adapter = new BuiltinMockAdapter();
    expect(
      adapter.respond(
        candidate(closedTupleContract(), "path:POST /v1/computers")
      )
    ).toBeNull();
  });

  it("serves a generated tuple that fits the count bound", () => {
    const source = boundedTupleContract();
    const adapter = new BuiltinMockAdapter();
    const served = adapter.respond(
      candidate(source, "path:POST /v1/computers")
    );
    expect(served?.provenance).toBe("schema_generation");

    const body = served?.body as Json[];
    expect(body).toHaveLength(2);
    expect(typeof body[0]).toBe("string");
    expect(typeof body[1]).toBe("number");

    const tupleSchema = source.schemas.sch_tuple?.schema;
    if (tupleSchema === undefined) {
      throw new Error("the compiled source did not register sch_tuple");
    }
    expect(new SchemaValidator(tupleSchema).errors(body)).toEqual([]);
  });

  it("serves the recursive schema byte-identically on repeat calls", () => {
    const adapter = new BuiltinMockAdapter();
    const input = candidate(recursiveContract(), "path:POST /v1/computers");
    const first = adapter.respond(input);
    const second = adapter.respond(input);
    expect(second).not.toBeNull();
    expect(serializeMockResponse(second as NonNullable<typeof first>)).toBe(
      serializeMockResponse(first as NonNullable<typeof first>)
    );
  });

  it("is byte-identical across double invocation", () => {
    const source = contract();
    const adapter = new BuiltinMockAdapter();
    const result = verifyDeterminism(adapter, [
      candidate(source, "path:POST /v1/computers"),
      candidate(source, "path:GET /v1/computers")
    ]);
    expect(result).toEqual({ ok: true, checked: 2, problems: [] });
  });

  it("detects a nondeterministic adapter", () => {
    const source = contract();
    let flip = false;
    const flaky = {
      id: "flaky",
      version: "0.0.0",
      capabilities: () => ({
        examples: false,
        schemaGeneration: false,
        contentNegotiation: false,
        responseHeaders: false
      }),
      respond: () => {
        flip = !flip;
        return {
          status: 200,
          mediaType: "application/json",
          headers: {},
          body: flip ? 1 : 2,
          provenance: "example:x",
          approximation: null
        };
      }
    };
    const result = verifyDeterminism(flaky, [
      candidate(source, "path:POST /v1/computers")
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
  });
});

describe("serializeMockResponse", () => {
  it("orders headers deterministically", () => {
    const first = serializeMockResponse({
      status: 201,
      mediaType: "application/json",
      headers: { b: "2", a: "1" },
      body: { x: 1 },
      provenance: "example:y",
      approximation: null
    });
    const second = serializeMockResponse({
      status: 201,
      mediaType: "application/json",
      headers: { a: "1", b: "2" },
      body: { x: 1 },
      provenance: "example:y",
      approximation: null
    });
    expect(first).toBe(second);
    expect(first).toContain("a=1");
  });
});

describe("operationByKey", () => {
  it("finds an operation and rejects unknown keys", () => {
    const source = contract();
    expect(operationByKey(source, "path:GET /v1/computers")?.uid).toBe(
      "op_list1"
    );
    expect(operationByKey(source, "path:GET /nope")).toBeNull();
  });
});
