import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import type {
  ContractIR,
  MediaContentIR,
  MediaExampleIR,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SchemaIR,
  SecuritySchemeIR
} from "@oal/contract-ir";
import { evaluateSecurity, grantedScopes, mintRunCredentials } from "./auth.ts";
import {
  matchRequestMedia,
  negotiateResponseMedia,
  parseAccept
} from "./negotiate.ts";
import { createGatewayState } from "./state.ts";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type RawRequest
} from "./server.ts";

function schema(uid: string, schemaBody: Json): SchemaIR {
  return { uid, schema: schemaBody, source_pointer: "", document_uri: "" };
}

function scheme(init: Partial<SecuritySchemeIR>): SecuritySchemeIR {
  return {
    name: init.name ?? "apiKeyAuth",
    type: init.type ?? "apiKey",
    description: null,
    location: init.location ?? "header",
    wire_name: init.wire_name ?? "x-api-key",
    scheme: init.scheme ?? null,
    bearer_format: null,
    flows: init.flows ?? null,
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
    headers: init.headers ?? [],
    content: init.content ?? [],
    source_pointer: ""
  };
}

function requiredHeader(name: string): ResponseIR["headers"][number] {
  return {
    name,
    required: true,
    deprecated: false,
    description: null,
    schema_ref: null,
    content: null,
    examples: [],
    support: "supported",
    support_reason_codes: []
  };
}

function jsonContent(
  schemaRef: string | null,
  examples: MediaExampleIR[] = []
): MediaContentIR {
  return contentEntry("application/json", schemaRef, examples);
}

function contentEntry(
  mediaType: string,
  schemaRef: string | null,
  examples: MediaExampleIR[] = []
): MediaContentIR {
  return {
    media_type: mediaType,
    schema_ref: schemaRef,
    examples,
    support: "supported",
    support_reason_codes: []
  };
}

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:GET /things",
    uid: "op_test1",
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
      response({
        content: [
          {
            media_type: "application/json",
            schema_ref: "sch_thing",
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ]
      })
    ],
    security: init.security ?? null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
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

function contract(init: {
  operations: OperationIR[];
  securitySchemes?: Record<string, SecuritySchemeIR>;
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
    security_schemes: init.securitySchemes ?? {},
    schemas:
      init.schemas ??
      ({
        sch_thing: schema("sch_thing", {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            secret: { type: "string", writeOnly: true }
          }
        })
      } as Record<string, SchemaIR>),
    operations: init.operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

function options(init: Partial<GatewayOptions>): GatewayOptions {
  return {
    contract: init.contract ?? contract({ operations: [operation({})] }),
    limits: init.limits ?? LIMIT_DEFAULTS,
    fixtures: init.fixtures ?? [],
    runSeed: init.runSeed ?? "run_seed_1",
    ...(init.state === undefined ? {} : { state: init.state })
  };
}

function request(init: Partial<RawRequest>): RawRequest {
  return {
    method: init.method ?? "GET",
    target: init.target ?? "/things",
    headers: init.headers ?? {},
    body: init.body ?? new Uint8Array(0)
  };
}

describe("content negotiation", () => {
  it("orders preferences by quality, specificity, then lexically", () => {
    const preferences = parseAccept(
      "text/plain;q=0.5, application/json, text/*;q=0.8"
    );
    expect(preferences.map((entry) => entry.type)).toEqual([
      "application/json",
      "text/*",
      "text/plain"
    ]);
  });

  it("drops malformed quality factors and zero-quality entries lose", () => {
    expect(parseAccept("application/json;q=banana")).toHaveLength(0);
    expect(
      negotiateResponseMedia(["application/json"], "application/json;q=0")
    ).toBeNull();
  });

  it("permits the declared default without an Accept header", () => {
    expect(negotiateResponseMedia(["application/json"], null)).toBe(
      "application/json"
    );
    expect(
      negotiateResponseMedia(["application/xml", "application/json"], "")
    ).toBe("application/xml");
  });

  it("honors wildcards with a lexical tie-breaker", () => {
    expect(
      negotiateResponseMedia(["application/xml", "application/json"], "*/*")
    ).toBe("application/json");
    expect(
      negotiateResponseMedia(["text/html", "application/json"], "text/*")
    ).toBe("text/html");
  });

  it("returns null when nothing satisfies the Accept header", () => {
    expect(
      negotiateResponseMedia(["application/json"], "image/png")
    ).toBeNull();
  });

  it("matches request media types ignoring parameters", () => {
    expect(
      matchRequestMedia(["application/json"], "application/json; charset=utf-8")
    ).toBe("application/json");
    expect(matchRequestMedia(["application/json"], "text/plain")).toBeNull();
    expect(matchRequestMedia(["application/json"], null)).toBeNull();
  });
});

describe("authentication emulation", () => {
  const oauthFlows = {
    clientCredentials: {
      authorization_url: null,
      token_url: "https://example.invalid/token",
      refresh_url: null,
      scopes: { read: "Read scope", write: "Write scope" }
    }
  };

  it("mints deterministic synthetic credentials per run seed", () => {
    const c = contract({ operations: [] });
    const left = mintRunCredentials(c, "seed_a");
    const right = mintRunCredentials(c, "seed_a");
    const other = mintRunCredentials(c, "seed_b");
    expect(left).toEqual(right);
    expect(left.bearer).not.toEqual(other.bearer);
    expect(left.bearer).toMatch(/^oal_[0-9a-f]{64}$/);
  });

  it("verifies api keys in the declared location", () => {
    const apiKeyScheme = scheme({});
    const c = contract({
      operations: [
        operation({
          security: {
            anonymous: false,
            alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
          }
        })
      ],
      securitySchemes: { apiKeyAuth: apiKeyScheme }
    });
    const credentials = mintRunCredentials(c, "seed_a");
    const op = c.operations[0] as OperationIR;
    const unauthenticated = evaluateSecurity(
      op,
      c,
      {
        headers: {},
        query: {},
        cookies: {}
      },
      credentials
    );
    expect(unauthenticated.ok).toBe(false);

    const authenticated = evaluateSecurity(
      op,
      c,
      {
        headers: { "x-api-key": credentials.apiKeys.apiKeyAuth as string },
        query: {},
        cookies: {}
      },
      credentials
    );
    expect(authenticated.ok).toBe(true);
  });

  it("grants all declared scopes to the dummy oauth bearer", () => {
    const oauth = scheme({
      name: "oauth",
      type: "oauth2",
      location: null,
      wire_name: null,
      flows: oauthFlows
    });
    expect(grantedScopes(oauth).sort()).toEqual(["read", "write"]);
    const c = contract({
      operations: [
        operation({
          security: {
            anonymous: false,
            alternatives: [{ schemes: [{ name: "oauth", scopes: ["read"] }] }]
          }
        })
      ],
      securitySchemes: { oauth }
    });
    const credentials = mintRunCredentials(c, "seed_a");
    const outcome = evaluateSecurity(
      c.operations[0] as OperationIR,
      c,
      {
        headers: { authorization: `Bearer ${credentials.bearer}` },
        query: {},
        cookies: {}
      },
      credentials
    );
    expect(outcome.ok).toBe(true);
  });

  it("answers 403 semantics for a scope deficit", () => {
    const oauth = scheme({
      name: "oauth",
      type: "oauth2",
      location: null,
      wire_name: null,
      flows: {
        clientCredentials: {
          authorization_url: null,
          token_url: "",
          refresh_url: null,
          scopes: { read: "Read scope" }
        }
      }
    });
    const c = contract({
      operations: [
        operation({
          security: {
            anonymous: false,
            alternatives: [{ schemes: [{ name: "oauth", scopes: ["admin"] }] }]
          }
        })
      ],
      securitySchemes: { oauth }
    });
    const credentials = mintRunCredentials(c, "seed_a");
    const outcome = evaluateSecurity(
      c.operations[0] as OperationIR,
      c,
      {
        headers: { authorization: `Bearer ${credentials.bearer}` },
        query: {},
        cookies: {}
      },
      credentials
    );
    expect(outcome).toEqual({
      ok: false,
      code: "authorization_failed",
      scheme: "oauth"
    });
  });
});

describe("gateway pipeline", () => {
  it("serves a generated response with provenance", () => {
    const result = handleGatewayRequest(options({}), 1, request({}));
    expect(result.status).toBe(200);
    expect(result.provenance).toBe("schema_generation");
    expect(result.headers["content-type"]).toBe(
      "application/json; charset=utf-8"
    );
    const body = JSON.parse(result.body ?? "{}") as { id?: string };
    expect(typeof body.id).toBe("string");
    expect(body).not.toHaveProperty("secret");
  });

  it("serves problem documents with stable codes and ids", () => {
    const result = handleGatewayRequest(
      options({}),
      42,
      request({ target: "/nope" })
    );
    expect(result.status).toBe(404);
    expect(result.frameworkCode).toBe("route_not_found");
    const document = JSON.parse(result.body ?? "{}") as {
      code?: string;
      request_id?: string;
    };
    expect(document.code).toBe("route_not_found");
    expect(document.request_id).toBe("req_00000042");
    expect(result.headers["content-type"]).toBe("application/problem+json");
  });

  it("answers 405 with sorted Allow methods", () => {
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [operation({})] }) }),
      2,
      request({ method: "DELETE", target: "/things" })
    );
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe("GET");
  });

  it("enforces the request target limit with 414", () => {
    const result = handleGatewayRequest(
      options({
        limits: { ...LIMIT_DEFAULTS, maxRequestTargetBytes: 8 }
      }),
      3,
      request({ target: "/things/way-too-long" })
    );
    expect(result.status).toBe(414);
    expect(result.frameworkCode).toBe("request_target_too_large");
  });

  it("rejects malformed JSON bodies with 400", () => {
    const op = operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "application/json",
            schema_ref: "sch_thing",
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [op] }) }),
      4,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("{not json")
      })
    );
    expect(result.status).toBe(400);
    expect(result.frameworkCode).toBe("request_malformed");
  });

  it("requires declared authentication with 401", () => {
    const c = contract({
      operations: [
        operation({
          security: {
            anonymous: false,
            alternatives: [{ schemes: [{ name: "apiKeyAuth", scopes: [] }] }]
          }
        })
      ],
      securitySchemes: { apiKeyAuth: scheme({}) }
    });
    const result = handleGatewayRequest(
      options({ contract: c }),
      5,
      request({})
    );
    expect(result.status).toBe(401);
    expect(result.frameworkCode).toBe("authentication_failed");

    const credentials = mintRunCredentials(c, "run_seed_1");
    const authorized = handleGatewayRequest(
      options({ contract: c }),
      6,
      request({
        headers: { "x-api-key": credentials.apiKeys.apiKeyAuth as string }
      })
    );
    expect(authorized.status).toBe(200);
  });

  it("reports schema violations with pointers", () => {
    const op = operation({
      method: "POST",
      key: "path:POST /things",
      parameters: [parameter({ name: "kind", required: true })],
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "application/json",
            schema_ref: "sch_thing",
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [op] }) }),
      7,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"wrong": true}')
      })
    );
    expect(result.status).toBe(422);
    expect(result.frameworkCode).toBe("request_schema_invalid");
    const document = JSON.parse(result.body ?? "{}") as {
      violations?: Array<{ location: string; code: string }>;
    };
    const codes = (document.violations ?? []).map(
      (entry) => `${entry.location}:${entry.code}`
    );
    expect(codes).toContain("query:required");
    expect(codes).toContain("body:required");
  });

  it("rejects undeclared request media types with 415", () => {
    const op = operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "application/json",
            schema_ref: "sch_thing",
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [op] }) }),
      8,
      request({
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: new TextEncoder().encode("a,b")
      })
    );
    expect(result.status).toBe(415);
  });

  it("answers 406 when Accept cannot be satisfied", () => {
    const result = handleGatewayRequest(
      options({}),
      9,
      request({ headers: { accept: "image/png" } })
    );
    expect(result.status).toBe(406);
    expect(result.frameworkCode).toBe("response_media_type_unacceptable");
  });

  it("omits body bytes for 204 and decodes query parameters", () => {
    const noContent = operation({
      responses: [response({ selector: "204", status: 204 })]
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [noContent] }) }),
      10,
      request({ target: "/things" })
    );
    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();

    const limited = operation({
      parameters: [parameter({ name: "q" })]
    });
    const echoed = handleGatewayRequest(
      options({ contract: contract({ operations: [limited] }) }),
      11,
      request({ target: "/things?q=%20space" })
    );
    expect(echoed.status).toBe(200);
  });
});

describe("recursive contract schemas", () => {
  const NODE_POINTER = "#/components/schemas/Node";
  const recursiveSchemas = (): Record<string, SchemaIR> => ({
    sch_node: {
      uid: "sch_node",
      schema: {
        type: "object",
        required: ["name", "children"],
        properties: {
          name: { type: "string" },
          children: { type: "array", items: { $ref: NODE_POINTER } }
        }
      },
      source_pointer: NODE_POINTER,
      document_uri: "openapi.yaml"
    }
  });

  const postNode = (): OperationIR => {
    return operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [jsonContent("sch_node")],
        source_pointer: ""
      },
      responses: [response({ content: [jsonContent("sch_node")] })]
    });
  };

  const postBody = (value: Json): RawRequest => {
    return request({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(value))
    });
  };

  it("accepts a valid recursive body and serves a generated one", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [postNode()],
          schemas: recursiveSchemas()
        })
      }),
      21,
      postBody({
        name: "a",
        children: [{ name: "b", children: [{ name: "c", children: [] }] }]
      })
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
    expect(result.provenance).toBe("schema_generation");
    const body = JSON.parse(result.body ?? "{}") as {
      name?: unknown;
      children?: unknown[];
    };
    expect(typeof body.name).toBe("string");
    expect(Array.isArray(body.children)).toBe(true);
  });

  it("reports violations inside the referenced schema", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [postNode()],
          schemas: recursiveSchemas()
        })
      }),
      22,
      postBody({ name: "a", children: [{ name: 5, children: [] }] })
    );
    expect(result.status).toBe(422);
    expect(result.frameworkCode).toBe("request_schema_invalid");
    const document = JSON.parse(result.body ?? "{}") as {
      violations?: Array<{ location: string; pointer: string; code: string }>;
    };
    expect(document.violations).toContainEqual({
      location: "body",
      pointer: "/children/0/name",
      code: "type",
      message: 'Expected type "string".'
    });
  });

  it("repeats the generated recursive response byte for byte", () => {
    const init = options({
      contract: contract({
        operations: [postNode()],
        schemas: recursiveSchemas()
      })
    });
    const first = handleGatewayRequest(
      init,
      23,
      postBody({ name: "a", children: [] })
    );
    const second = handleGatewayRequest(
      init,
      24,
      postBody({ name: "a", children: [] })
    );
    expect(second.body).toBe(first.body);
    expect(first.status).toBe(200);
  });
});

describe("array and scalar request bodies", () => {
  const postTags = (): OperationIR => {
    return operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [jsonContent("sch_tags")],
        source_pointer: ""
      }
    });
  };

  it("validates an array body against the declared array schema", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [postTags()],
          schemas: {
            sch_tags: schema("sch_tags", {
              type: "array",
              maxItems: 2,
              items: { type: "string", maxLength: 3 }
            })
          }
        })
      }),
      25,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('["toolong1","toolong2","toolong3"]')
      })
    );
    expect(result.status).toBe(422);
    expect(result.frameworkCode).toBe("request_schema_invalid");
    const document = JSON.parse(result.body ?? "{}") as {
      violations?: Array<{ location: string; pointer: string; code: string }>;
    };
    const found = document.violations ?? [];
    expect(found).toContainEqual({
      location: "body",
      pointer: "/0",
      code: "maxLength",
      message: "String length must be <= 3."
    });
    expect(found.some((entry) => entry.code === "maxItems")).toBe(true);
  });

  it("accepts a valid array body through the pipeline (V2E)", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [postTags()],
          schemas: {
            sch_tags: schema("sch_tags", {
              type: "array",
              maxItems: 2,
              items: { type: "string", maxLength: 3 }
            }),
            sch_thing: schema("sch_thing", {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } }
            })
          }
        })
      }),
      26,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('["ab","cd"]')
      })
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
  });
});

describe("URL-encoded form request bodies (V2A)", () => {
  const postForm = (): OperationIR => {
    return operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [
          contentEntry("application/x-www-form-urlencoded", "sch_thing")
        ],
        source_pointer: ""
      }
    });
  };

  it("rejects a parsed form body that violates the schema with 422", () => {
    // The gateway coerces `id=5` to the number 5, which the declared
    // string schema must reject.
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [postForm()] }) }),
      27,
      request({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode("id=5")
      })
    );
    expect(result.status).toBe(422);
    expect(result.frameworkCode).toBe("request_schema_invalid");
    const document = JSON.parse(result.body ?? "{}") as {
      violations?: Array<{ location: string; pointer: string; code: string }>;
    };
    expect(document.violations).toContainEqual({
      location: "body",
      pointer: "/id",
      code: "type",
      message: 'Expected type "string".'
    });
  });

  it("accepts a conforming parsed form body", () => {
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [postForm()] }) }),
      28,
      request({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode("id=thing_1")
      })
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
  });
});

describe("response validation before commit", () => {
  it("rejects a produced body that violates the declared schema", () => {
    const op = operation({
      responses: [
        response({
          content: [
            jsonContent("sch_thing", [
              { name: null, value: { wrong: true }, summary: null }
            ])
          ]
        })
      ]
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [op] }) }),
      12,
      request({})
    );
    expect(result.status).toBe(500);
    expect(result.frameworkCode).toBe("mock_response_invalid");
    expect(result.headers["content-type"]).toBe("application/problem+json");
    const document = JSON.parse(result.body ?? "{}") as {
      code?: string;
      request_id?: string;
    };
    expect(document.code).toBe("mock_response_invalid");
    expect(document.request_id).toBe("req_00000012");
  });

  it("rejects a fixture status that matches no declared response", () => {
    const result = handleGatewayRequest(
      options({
        fixtures: [
          {
            id: "fx_status",
            operation: "path:GET /things",
            status: 299,
            body: { kind: "json_inline", value: { id: "thing_1" } }
          }
        ]
      }),
      13,
      request({})
    );
    expect(result.status).toBe(500);
    expect(result.frameworkCode).toBe("mock_response_invalid");
  });

  it("rejects a produced response missing a required header", () => {
    const op = operation({
      responses: [response({ headers: [requiredHeader("x-request-id")] })]
    });
    const result = handleGatewayRequest(
      options({ contract: contract({ operations: [op] }) }),
      14,
      request({})
    );
    expect(result.status).toBe(500);
    expect(result.frameworkCode).toBe("mock_response_invalid");
  });

  it("serves a generated response that omits writeOnly behind a ref (V2B)", () => {
    const op = operation({
      responses: [response({ content: [jsonContent("sch_report")] })]
    });
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [op],
          schemas: {
            sch_report: schema("sch_report", {
              type: "object",
              required: ["item"],
              properties: { item: { $ref: "sch_line" } }
            }),
            sch_line: schema("sch_line", {
              type: "object",
              required: ["label", "secret"],
              properties: {
                label: { type: "string" },
                secret: { type: "string", writeOnly: true }
              }
            })
          }
        })
      }),
      30,
      request({})
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
    const body = JSON.parse(result.body ?? "{}") as {
      item?: { label?: string };
    };
    expect(typeof body.item?.label).toBe("string");
    expect(body.item).not.toHaveProperty("secret");
  });

  it("accepts a request that omits readOnly behind a ref (V2B)", () => {
    const op = operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [jsonContent("sch_cart")],
        source_pointer: ""
      },
      responses: [response({ content: [jsonContent("sch_thing")] })]
    });
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [op],
          schemas: {
            sch_cart: schema("sch_cart", {
              type: "object",
              required: ["item"],
              properties: { item: { $ref: "sch_line" } }
            }),
            sch_line: schema("sch_line", {
              type: "object",
              required: ["id", "quantity"],
              properties: {
                id: { type: "string", readOnly: true },
                quantity: { type: "integer" }
              }
            }),
            sch_thing: schema("sch_thing", {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } }
            })
          }
        })
      }),
      31,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"item":{"quantity":2}}')
      })
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
  });

  it("serves a fixture that satisfies every declared check", () => {
    const op = operation({
      responses: [
        response({
          headers: [requiredHeader("x-request-id")],
          content: [jsonContent("sch_thing")]
        })
      ]
    });
    const result = handleGatewayRequest(
      options({
        contract: contract({ operations: [op] }),
        fixtures: [
          {
            id: "fx_ok",
            operation: "path:GET /things",
            status: 200,
            headers: { "x-request-id": "req_1" },
            body: { kind: "json_inline", value: { id: "thing_1" } }
          }
        ]
      }),
      15,
      request({})
    );
    expect(result.status).toBe(200);
    expect(result.headers["x-request-id"]).toBe("req_1");
    expect(result.frameworkCode).toBeNull();
  });

  it("serves a fixture body that satisfies the declared schema (V2D)", () => {
    // A fixture body is frozen pack data, and it must also satisfy the
    // declared response schema like every value the gateway serves.
    const op = operation({
      responses: [
        response({
          content: [contentEntry("application/json", "sch_thing_list")]
        })
      ]
    });
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [op],
          schemas: {
            sch_thing_list: schema("sch_thing_list", {
              type: "array",
              items: { $ref: "sch_thing" }
            }),
            sch_thing: schema("sch_thing", {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } }
            })
          }
        }),
        fixtures: [
          {
            id: "fx_frozen",
            operation: "path:GET /things",
            status: 200,
            media_type: "application/json",
            body: { kind: "json_inline", value: [{ id: "thing_1" }] }
          }
        ]
      }),
      18,
      request({})
    );
    expect(result.status).toBe(200);
    expect(result.provenance).toBe("fixture:fx_frozen");
    expect(result.frameworkCode).toBeNull();
    expect(result.headers["content-type"]).toBe(
      "application/json; charset=utf-8"
    );
    expect(JSON.parse(result.body ?? "{}")).toEqual([{ id: "thing_1" }]);
  });

  it("never serves a fixture body that violates the declared schema", () => {
    const op = operation({
      responses: [
        response({
          content: [contentEntry("application/json", "sch_thing_list")]
        })
      ]
    });
    const result = handleGatewayRequest(
      options({
        contract: contract({
          operations: [op],
          schemas: {
            sch_thing_list: schema("sch_thing_list", {
              type: "array",
              items: { $ref: "sch_thing" }
            }),
            sch_thing: schema("sch_thing", {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } }
            })
          }
        }),
        fixtures: [
          {
            id: "fx_frozen",
            operation: "path:GET /things",
            status: 200,
            media_type: "application/json",
            body: { kind: "json_inline", value: { id: "thing_1" } }
          }
        ]
      }),
      29,
      request({})
    );
    expect(result.status).toBe(500);
    expect(result.frameworkCode).toBe("mock_response_invalid");
    expect(result.headers["content-type"]).toBe("application/problem+json");
    expect(result.body).not.toContain("thing_1");
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({
      code: "mock_response_invalid"
    });
  });
});

describe("state transactions", () => {
  const invalidExample = (): OperationIR => {
    return operation({
      responses: [
        response({
          content: [
            jsonContent("sch_thing", [
              { name: null, value: { wrong: true }, summary: null }
            ])
          ]
        })
      ]
    });
  };

  it("rolls back the pending mutation when validation fails", () => {
    const state = createGatewayState();
    const result = handleGatewayRequest(
      options({
        contract: contract({ operations: [invalidExample()] }),
        state
      }),
      16,
      request({})
    );
    expect(result.frameworkCode).toBe("mock_response_invalid");
    expect(state.revision).toBe(0);
    expect(state.appliedEffects).toEqual([]);
    expect(state.pendingEffects).toEqual([]);
    expect(state.rollbacks).toBe(1);
  });

  it("commits the pending mutation when validation passes", () => {
    const state = createGatewayState();
    const result = handleGatewayRequest(options({ state }), 17, request({}));
    expect(result.status).toBe(200);
    expect(state.revision).toBe(1);
    expect(state.appliedEffects).toEqual(["path:GET /things"]);
    expect(state.rollbacks).toBe(0);
  });
});

describe("multipart limits", () => {
  function multipartBody(boundary: string, parts: string[]): Uint8Array {
    const wire =
      parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("") +
      `--${boundary}--\r\n`;
    return new TextEncoder().encode(wire);
  }

  const part = (name: string, value: string): string => {
    return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
  };

  const uploadOperation = (): OperationIR => {
    return operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [contentEntry("multipart/form-data", null)],
        source_pointer: ""
      }
    });
  };

  it("answers 413 when the parts limit is exceeded", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({ operations: [uploadOperation()] }),
        limits: { ...LIMIT_DEFAULTS, maxMultipartParts: 2 }
      }),
      18,
      request({
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=oal_boundary"
        },
        body: multipartBody("oal_boundary", [
          part("first", "one"),
          part("second", "two"),
          part("third", "three")
        ])
      })
    );
    expect(result.status).toBe(413);
    expect(result.frameworkCode).toBe("multipart_parts_too_many");
  });

  it("accepts a multipart body within the parts limit", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({ operations: [uploadOperation()] })
      }),
      19,
      request({
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=oal_boundary"
        },
        body: multipartBody("oal_boundary", [
          part("first", "one"),
          part("second", "two")
        ])
      })
    );
    expect(result.status).toBe(200);
    expect(result.frameworkCode).toBeNull();
  });

  it("answers 400 when the boundary parameter is missing", () => {
    const result = handleGatewayRequest(
      options({
        contract: contract({ operations: [uploadOperation()] })
      }),
      20,
      request({
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: multipartBody("oal_boundary", [part("first", "one")])
      })
    );
    expect(result.status).toBe(400);
    expect(result.frameworkCode).toBe("request_malformed");
  });
});

describe("contract schema version gate", () => {
  it("refuses an unsupported contract schema version per request", () => {
    const future = contract({ operations: [operation({})] });
    (future as { schema_version: number }).schema_version = 99;
    const result = handleGatewayRequest(
      options({ contract: future }),
      1,
      request({})
    );
    expect(result.status).toBe(500);
    expect(result.frameworkCode).toBe("contract_schema_version_unsupported");
  });
});
