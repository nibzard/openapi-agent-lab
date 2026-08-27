import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

import { LIMIT_DEFAULTS, type LimitTable } from "@oal/config";
import type {
  ContractIR,
  OperationIR,
  ResponseIR,
  SchemaIR,
  SecuritySchemeIR
} from "@oal/contract-ir";
import type { TraceEvent } from "@oal/evidence";
import { mintRunCredentials } from "@oal/gateway";

import {
  compileDocumentationProfile,
  conventionalCandidates,
  DocumentationCode,
  documentationIndexDocument,
  type DocumentationCandidate
} from "./exposure-documentation.ts";
import {
  createLoopbackExposure,
  createRawHttpExposure,
  ExposureProfileError,
  serverRecordSurfaceDigest,
  syntheticCredentialInstructions,
  type RawHttpExposureOptions
} from "./exposure.ts";
import type {
  ExposureHandle,
  ExposureFactory,
  ExposureRequest,
  TraceWriter
} from "./setup.ts";

const CLOCK = (): number => 1_700_000_000_000;

/** The sanitized localized contract bytes the facade must serve. */
const SANITIZED = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Things", version: "1.0.0" },
  servers: [],
  paths: {}
});

function schema(uid: string, body: SchemaIR["schema"]): SchemaIR {
  return { uid, schema: body, source_pointer: "", document_uri: "" };
}

function scheme(init: Partial<SecuritySchemeIR>): SecuritySchemeIR {
  return {
    name: init.name ?? "bearerAuth",
    type: init.type ?? "http",
    description: null,
    location: init.location ?? null,
    wire_name: init.wire_name ?? null,
    scheme: init.scheme ?? "bearer",
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
        schema_ref: "sch_thing",
        examples: [],
        support: "supported",
        support_reason_codes: []
      }
    ],
    source_pointer: ""
  };
}

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:GET /things",
    uid: init.uid ?? "op_things",
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
    responses: init.responses ?? [response({})],
    security: init.security ?? null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function contract(init: {
  operations?: OperationIR[];
  securitySchemes?: Record<string, SecuritySchemeIR>;
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
    schemas: {
      sch_thing: schema("sch_thing", {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } }
      })
    } as Record<string, SchemaIR>,
    operations: init.operations ?? [
      operation({}),
      operation({
        key: "path:GET /things/{id}",
        uid: "op_thing_get",
        method: "GET",
        path_template: "/things/{id}",
        route_segments: [
          { kind: "literal", value: "things" },
          { kind: "parameter", value: "id" }
        ]
      })
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

/** One exchange as the participant observes it. */
interface Exchange {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A trace sink the test can read back event by event. */
interface EventSink extends TraceWriter {
  readonly events: unknown[];
}

class RecordingTrace implements EventSink {
  readonly events: unknown[] = [];
  private next = 1;

  reserve(): { sequence: number; event_id: string } {
    const sequence = this.next;
    this.next += 1;
    return {
      sequence,
      event_id: `req_${sequence.toString(10).padStart(8, "0")}`
    };
  }

  complete(event: TraceEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** A trace that holds the first completion until the test opens it. */
class GatedTrace implements EventSink {
  readonly events: unknown[] = [];
  private next = 1;
  private release: () => void = () => undefined;
  readonly gate: Promise<void> = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  reserve(): { sequence: number; event_id: string } {
    const sequence = this.next;
    this.next += 1;
    return {
      sequence,
      event_id: `req_${sequence.toString(10).padStart(8, "0")}`
    };
  }

  async complete(event: TraceEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length === 1) {
      await this.gate;
    }
  }

  open(): void {
    this.release();
  }
}

function eventOf(event: unknown, type: string): Record<string, unknown> | null {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  return (event as Record<string, unknown>)["type"] === type
    ? (event as Record<string, unknown>)
    : null;
}

/** The framework code of one serialized problem document. */
function problemCode(body: string): unknown {
  return (JSON.parse(body) as Record<string, unknown>)["code"];
}

function documentationEvents(trace: EventSink): number {
  return trace.events.filter(
    (event) => eventOf(event, "documentation.exchange") !== null
  ).length;
}

function apiEvents(trace: EventSink): Array<Record<string, unknown>> {
  return trace.events.flatMap((event) => {
    const api = eventOf(event, "api.exchange");
    return api === null ? [] : [api];
  });
}

/** The first api.exchange, or a loud failure when none was recorded. */
function firstApiEvent(trace: EventSink): Record<string, unknown> {
  const first = apiEvents(trace)[0];
  if (first === undefined) {
    throw new Error("The trace holds no api.exchange event.");
  }
  return first;
}

/** Replace the per-request correlation id so bodies compare bytewise. */
function neutralShape(body: string): string {
  return body.replace(/req_\d{8}/u, "req_XXXXXXXX");
}

interface ServerStart {
  readonly handle: ExposureHandle;
  readonly trace: EventSink;
}

async function startServer(
  init: {
    contract?: ContractIR;
    limits?: Partial<LimitTable>;
    trace?: EventSink;
  } = {},
  options: RawHttpExposureOptions = {},
  factory: ExposureFactory = createRawHttpExposure(options)
): Promise<ServerStart> {
  const trace = init.trace ?? new RecordingTrace();
  const request: ExposureRequest = {
    batchId: "b-exposure",
    runId: "run-exposure-1",
    evalId: "eval-exposure",
    trialSeed: "trial-seed-1",
    contract: init.contract ?? contract({}),
    limits: { ...LIMIT_DEFAULTS, ...init.limits },
    host: "127.0.0.1",
    port: 0,
    now: CLOCK,
    trace,
    sensitiveHeaderNames: ["authorization"],
    sensitiveKeyPatterns: []
  };
  const handle = await factory(request);
  return { handle, trace };
}

async function exchange(
  handle: ExposureHandle,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {}
): Promise<Exchange> {
  const response = await fetch(`${handle.baseUrl}${path}`, {
    method,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body })
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text()
  };
}

function rawExchange(
  port: number,
  method: string,
  path: string
): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path },
      (incoming: IncomingMessage) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: {},
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function portOf(handle: ExposureHandle): number {
  const port = handle.serverRecord["port"];
  if (typeof port !== "number") {
    throw new Error("The server record carries no port.");
  }
  return port;
}

describe("createLoopbackExposure", () => {
  it("serves the product pipeline and records api exchanges", async () => {
    const server = await startServer({}, {}, createLoopbackExposure);
    try {
      const ok = await exchange(server.handle, "GET", "/things");
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("application/json");

      const item = await exchange(server.handle, "GET", "/things/1");
      expect(item.status).toBe(200);

      const missing = await exchange(server.handle, "GET", "/not-a-route");
      expect(missing.status).toBe(404);
      expect(problemCode(missing.body)).toBe("route_not_found");

      expect(server.trace.events.length).toBe(3);
      expect(documentationEvents(server.trace)).toBe(0);
      const first = firstApiEvent(server.trace);
      expect(first["type"]).toBe("api.exchange");
      expect((first["operation"] as Record<string, unknown>)["matched"]).toBe(
        true
      );
    } finally {
      await server.handle.close();
    }
  });

  it("keeps the handle ports and the record deterministic per options", async () => {
    const first = await startServer();
    const second = await startServer();
    try {
      expect(portOf(first.handle)).not.toBe(portOf(second.handle));
      expect(second.handle.serverRecord["documentation"]).toBe(null);
      expect(second.handle.documentationUrl).toBe(null);
      expect(serverRecordSurfaceDigest(first.handle.serverRecord)).toBe(
        serverRecordSurfaceDigest(second.handle.serverRecord)
      );
    } finally {
      await first.handle.close();
      await second.handle.close();
    }
  });

  it("closes idempotently and releases the port", async () => {
    const server = await startServer();
    await server.handle.close();
    await server.handle.close();
    await expect(exchange(server.handle, "GET", "/things")).rejects.toThrow();
  });
});

describe("contract visibility", () => {
  it("file keeps the contract off the listener", async () => {
    const server = await startServer({}, { visibility: "file" });
    try {
      const response = await exchange(server.handle, "GET", "/openapi.json");
      expect(response.status).toBe(404);
      expect(problemCode(response.body)).toBe("route_not_found");
      expect(documentationEvents(server.trace)).toBe(0);
      expect(server.handle.documentationUrl).toBe(null);
      expect(server.handle.serverRecord["documentation"]).toBe(null);
    } finally {
      await server.handle.close();
    }
  });

  it("tool-only and none serve no contract artifact", async () => {
    for (const visibility of ["tool-only", "none"] as const) {
      const server = await startServer({}, { visibility });
      try {
        const response = await exchange(server.handle, "GET", "/openapi.json");
        expect(response.status).toBe(404);
        expect(documentationEvents(server.trace)).toBe(0);
        expect(server.handle.serverRecord["documentation"]).toBe(null);
      } finally {
        await server.handle.close();
      }
    }
  });

  it("discoverable serves the sanitized bytes before product routing", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: { sanitizedContract: SANITIZED }
      }
    );
    try {
      const response = await exchange(server.handle, "GET", "/openapi.json");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.body).toBe(SANITIZED);

      expect(documentationEvents(server.trace)).toBe(1);
      expect(apiEvents(server.trace)).toEqual([]);
      expect(server.handle.documentationUrl).toBe(server.handle.baseUrl);

      const record = server.handle.serverRecord["documentation"] as Record<
        string,
        unknown
      >;
      expect(record["profile"]).toBe("openapi-conventional-v1");
      expect(record["contract_sha256"]).toHaveLength(64);
    } finally {
      await server.handle.close();
    }
  });

  it("keeps product routing outside the documentation plane", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: { sanitizedContract: SANITIZED }
      }
    );
    try {
      const product = await exchange(server.handle, "GET", "/things");
      expect(product.status).toBe(200);

      // Candidates are GET-only, so another method falls through to
      // the product pipeline and its unknown-route error.
      const posted = await exchange(server.handle, "POST", "/openapi.json");
      expect(posted.status).toBe(404);
      expect(problemCode(posted.body)).toBe("route_not_found");

      expect(documentationEvents(server.trace)).toBe(0);
      expect(apiEvents(server.trace).length).toBe(2);
      expect(server.trace.events.length).toBe(2);
    } finally {
      await server.handle.close();
    }
  });
});

describe("candidate enablement matrix", () => {
  const combinations: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true]
  ];

  it("answers every combination from the frozen inventory", async () => {
    for (const [index, openapi, wellKnown] of combinations) {
      const server = await startServer(
        {},
        {
          visibility: "discoverable",
          documentation: {
            sanitizedContract: SANITIZED,
            authentication: "none",
            candidates: { index, openapi, wellKnown }
          }
        }
      );
      try {
        const root = await exchange(server.handle, "GET", "/");
        expect(root.status).toBe(index ? 200 : 404);
        const document = await exchange(server.handle, "GET", "/openapi.json");
        expect(document.status).toBe(openapi ? 200 : 404);
        if (openapi) {
          expect(document.body).toBe(SANITIZED);
        }
        const known = await exchange(
          server.handle,
          "GET",
          "/.well-known/openapi.json"
        );
        expect(known.status).toBe(wellKnown ? 200 : 404);
        if (wellKnown) {
          expect(known.body).toBe(SANITIZED);
        }
        expect(server.trace.events.length).toBe(3);
      } finally {
        await server.handle.close();
      }
    }
  });

  it("serves an index that names enabled contract candidates only", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: SANITIZED,
          authentication: "none",
          candidates: { index: true, openapi: true, wellKnown: true }
        }
      }
    );
    try {
      const response = await exchange(server.handle, "GET", "/");
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        schema_version: 1,
        kind: "DocumentationIndex",
        profile: "openapi-conventional-v1",
        links: [
          { rel: "describedby", href: "/.well-known/openapi.json" },
          { rel: "describedby", href: "/openapi.json" }
        ]
      });
    } finally {
      await server.handle.close();
    }
  });

  it("answers HEAD on an enabled candidate without body bytes", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: SANITIZED,
          authentication: "none"
        }
      }
    );
    try {
      const response = await exchange(server.handle, "HEAD", "/openapi.json");
      expect(response.status).toBe(200);
      expect(response.body).toBe("");
      expect(response.headers["content-length"]).toBe(
        Buffer.byteLength(SANITIZED, "utf8").toString(10)
      );
    } finally {
      await server.handle.close();
    }
  });
});

describe("documentation profile validation", () => {
  const base = {
    visibility: "discoverable" as const,
    authentication: "required" as const,
    contract: contract({}),
    documentBytes: Buffer.byteLength(SANITIZED, "utf8"),
    maxDocumentBytes: 1024 * 1024
  };

  function codes(diagnostics: ReadonlyArray<{ code: string }>): string[] {
    return diagnostics.map((entry) => entry.code);
  }

  it("compiles a clean conventional profile", () => {
    const compiled = compileDocumentationProfile({
      ...base,
      candidates: conventionalCandidates({}, "discoverable")
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.profile?.id).toBe("openapi-conventional-v1");
    expect(compiled.profile?.disabledCandidateOutcome).toBe(
      "neutral_unknown_route"
    );
  });

  it("rejects an enabled candidate that collides with a product route", () => {
    const colliding = contract({
      operations: [
        operation({
          key: "path:GET /openapi.json",
          method: "GET",
          path_template: "/openapi.json",
          route_segments: [{ kind: "literal", value: "openapi.json" }]
        })
      ]
    });
    const compiled = compileDocumentationProfile({
      ...base,
      contract: colliding,
      candidates: conventionalCandidates({}, "discoverable")
    });
    const errors = compiled.diagnostics.filter(
      (entry) => entry.severity === "error"
    );
    expect(codes(errors)).toEqual([DocumentationCode.RouteCollision]);
    expect(errors[0]?.operation_key).toBe("path:GET /openapi.json");
    expect(compiled.profile).toBe(null);
  });

  it("allows a colliding candidate while it stays disabled", () => {
    const colliding = contract({
      operations: [
        operation({
          key: "path:GET /openapi.json",
          method: "GET",
          path_template: "/openapi.json",
          route_segments: [{ kind: "literal", value: "openapi.json" }]
        })
      ]
    });
    const compiled = compileDocumentationProfile({
      ...base,
      contract: colliding,
      candidates: conventionalCandidates({ openapi: false }, "none")
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.profile).not.toBe(null);
  });

  it("rejects duplicate, parameterized, and control-plane candidates", () => {
    const duplicated: DocumentationCandidate[] = [
      {
        id: "openapi",
        route_id: "openapi-json",
        method: "GET",
        path: "/openapi.json",
        role: "contract",
        enabled: true
      },
      {
        id: "wellKnown",
        route_id: "well-known-openapi-json",
        method: "GET",
        path: "/openapi.json/",
        role: "contract",
        enabled: false
      }
    ];
    expect(
      codes(
        compileDocumentationProfile({
          ...base,
          candidates: duplicated
        }).diagnostics
      )
    ).toEqual([DocumentationCode.RouteDuplicate]);

    const parameterized: DocumentationCandidate[] = [
      {
        id: "openapi",
        route_id: "openapi-json",
        method: "GET",
        path: "/openapi/{file}",
        role: "contract",
        enabled: true
      }
    ];
    expect(
      codes(
        compileDocumentationProfile({
          ...base,
          candidates: parameterized
        }).diagnostics
      )
    ).toEqual([DocumentationCode.RouteParameterized]);

    const controlPlane: DocumentationCandidate[] = [
      {
        id: "openapi",
        route_id: "openapi-json",
        method: "GET",
        path: "/oal/openapi.json",
        role: "contract",
        enabled: false
      }
    ];
    expect(
      codes(
        compileDocumentationProfile({
          ...base,
          candidates: controlPlane
        }).diagnostics
      )
    ).toEqual([DocumentationCode.RouteControlPlane]);
  });

  it("rejects a missing or oversized sanitized document", () => {
    expect(
      codes(
        compileDocumentationProfile({
          ...base,
          documentBytes: null,
          candidates: conventionalCandidates({}, "discoverable")
        }).diagnostics
      )
    ).toEqual([DocumentationCode.DocumentMissing]);

    expect(
      codes(
        compileDocumentationProfile({
          ...base,
          documentBytes: 64,
          maxDocumentBytes: 8,
          candidates: conventionalCandidates({}, "discoverable")
        }).diagnostics
      )
    ).toEqual([DocumentationCode.DocumentTooLarge]);
  });

  it("refuses to start a colliding discoverable server", async () => {
    const colliding = contract({
      operations: [
        operation({
          key: "path:GET /openapi.json",
          method: "GET",
          path_template: "/openapi.json",
          route_segments: [{ kind: "literal", value: "openapi.json" }]
        })
      ]
    });
    const attempt = startServer(
      { contract: colliding },
      {
        visibility: "discoverable",
        documentation: { sanitizedContract: SANITIZED }
      }
    );
    const error = await attempt.then(
      () => null,
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(ExposureProfileError);
    expect(
      (error as ExposureProfileError).diagnostics.map((entry) => entry.code)
    ).toEqual([DocumentationCode.RouteCollision]);
  });

  it("builds a deterministic index document from any profile", () => {
    const enabled = conventionalCandidates(
      { index: true, openapi: true, wellKnown: true },
      "discoverable"
    );
    const compiled = compileDocumentationProfile({
      ...base,
      candidates: enabled
    });
    if (compiled.profile === null) {
      throw new Error("The conventional profile must compile.");
    }
    expect(documentationIndexDocument(compiled.profile)).toBe(
      documentationIndexDocument(compiled.profile)
    );
  });
});

describe("neutral blind shape", () => {
  it("matches the unknown-route shape byte for byte", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: SANITIZED,
          candidates: { index: false, openapi: false, wellKnown: false }
        }
      }
    );
    try {
      const probe = await exchange(server.handle, "GET", "/openapi.json");
      const unknown = await exchange(server.handle, "GET", "/not-a-route");
      expect(probe.status).toBe(unknown.status);
      expect(probe.headers["content-type"]).toBe(
        unknown.headers["content-type"]
      );
      expect(neutralShape(probe.body).length).toBe(
        neutralShape(unknown.body).length
      );
      expect(neutralShape(probe.body)).toBe(neutralShape(unknown.body));

      // The disabled probe is recorded as a documentation exchange;
      // the unknown path stays a product exchange.
      expect(documentationEvents(server.trace)).toBe(1);
      expect(apiEvents(server.trace).length).toBe(1);
    } finally {
      await server.handle.close();
    }
  });

  it("stays neutral whatever credentials the probe presents", async () => {
    const credentials = mintRunCredentials(contract({}), "trial-seed-1");
    const server = await startServer(
      {},
      {
        visibility: "none",
        documentation: {
          sanitizedContract: SANITIZED,
          candidates: { openapi: false }
        }
      }
    );
    try {
      const anonymous = await exchange(server.handle, "GET", "/openapi.json");
      const authenticated = await exchange(
        server.handle,
        "GET",
        "/openapi.json",
        {
          headers: {
            authorization: `Bearer ${credentials.bearer}`
          }
        }
      );
      expect(anonymous.status).toBe(404);
      expect(authenticated.status).toBe(404);
      expect(neutralShape(anonymous.body)).toBe(
        neutralShape(authenticated.body)
      );
    } finally {
      await server.handle.close();
    }
  });
});

describe("documentation authentication", () => {
  const secured = contract({
    securitySchemes: { bearerAuth: scheme({ name: "bearerAuth" }) }
  });

  it("rejects a probe without credentials", async () => {
    const server = await startServer(
      { contract: secured },
      {
        visibility: "discoverable",
        documentation: { sanitizedContract: SANITIZED }
      }
    );
    try {
      const response = await exchange(server.handle, "GET", "/openapi.json");
      expect(response.status).toBe(401);
      expect(problemCode(response.body)).toBe("authentication_failed");
      expect(documentationEvents(server.trace)).toBe(1);
    } finally {
      await server.handle.close();
    }
  });

  it("serves the declared synthetic credential", async () => {
    const credentials = mintRunCredentials(secured, "trial-seed-1");
    const server = await startServer(
      { contract: secured },
      {
        visibility: "discoverable",
        documentation: { sanitizedContract: SANITIZED }
      }
    );
    try {
      const response = await exchange(server.handle, "GET", "/openapi.json", {
        headers: { authorization: `Bearer ${credentials.bearer}` }
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe(SANITIZED);
    } finally {
      await server.handle.close();
    }
  });

  it("serves without credentials when the policy is none", async () => {
    const server = await startServer(
      { contract: secured },
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: SANITIZED,
          authentication: "none"
        }
      }
    );
    try {
      const response = await exchange(server.handle, "GET", "/openapi.json");
      expect(response.status).toBe(200);
    } finally {
      await server.handle.close();
    }
  });
});

describe("runtime controls", () => {
  it("answers 413 when the body exceeds the limit", async () => {
    const server = await startServer({
      limits: { maxRequestBodyBytes: 64 }
    });
    try {
      const response = await exchange(server.handle, "POST", "/things", {
        headers: { "content-type": "application/json" },
        body: "x".repeat(200)
      });
      expect(response.status).toBe(413);
      expect(problemCode(response.body)).toBe("request_body_too_large");
      const event = firstApiEvent(server.trace);
      const usage = event["resource_usage"] as Record<string, unknown>;
      expect(usage["request_bytes"]).toBe(200);
      const request = event["request"] as Record<string, unknown>;
      const body = request["body"] as Record<string, unknown>;
      expect(body["kind"]).toBe("binary");
      expect(body["size_bytes"]).toBe(200);
      expect(body["sha256"]).toMatch(/^[a-f0-9]{64}$/u);
      expect((event["backend"] as Record<string, unknown>)["outcome"]).toBe(
        "skipped"
      );
    } finally {
      await server.handle.close();
    }
  });

  it("answers 414 when the target exceeds the limit", async () => {
    const server = await startServer({
      limits: { maxRequestTargetBytes: 32 }
    });
    try {
      const response = await exchange(
        server.handle,
        "GET",
        `/things?filter=${"a".repeat(64)}`
      );
      expect(response.status).toBe(414);
      expect(problemCode(response.body)).toBe("request_target_too_large");
      expect(documentationEvents(server.trace)).toBe(0);
    } finally {
      await server.handle.close();
    }
  });

  it("answers 429 when the run request quota is spent", async () => {
    const server = await startServer({
      limits: { maxRequestsPerRun: 2 }
    });
    try {
      const first = await exchange(server.handle, "GET", "/things");
      expect(first.status).toBe(200);
      await exchange(server.handle, "GET", "/things");
      const third = await exchange(server.handle, "GET", "/things");
      expect(third.status).toBe(429);
      expect(problemCode(third.body)).toBe("request_quota_exceeded");
      const codes = apiEvents(server.trace).map(
        (event) =>
          (event["error"] as Record<string, unknown> | null)?.["code"] ?? null
      );
      expect(codes).toEqual([null, null, "request_quota_exceeded"]);
    } finally {
      await server.handle.close();
    }
  });

  it("answers 429 when the burst quota is exceeded", async () => {
    const server = await startServer({
      limits: { maxBurstRequestsPerSecond: 1 }
    });
    try {
      const first = await exchange(server.handle, "GET", "/things");
      const second = await exchange(server.handle, "GET", "/things");
      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(problemCode(second.body)).toBe("request_quota_exceeded");
    } finally {
      await server.handle.close();
    }
  });

  it("bounds the request queue and answers 429", async () => {
    const gated = new GatedTrace();
    const server = await startServer({
      trace: gated,
      limits: { maxConcurrentConnectionsPerRun: 1 }
    });
    try {
      const port = portOf(server.handle);
      const first = rawExchange(port, "GET", "/things");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const second = await rawExchange(port, "GET", "/things");
      expect(second.status).toBe(429);
      expect(problemCode(second.body)).toBe("request_quota_exceeded");
      gated.open();
      expect((await first).status).toBe(200);
    } finally {
      gated.open();
      await server.handle.close();
    }
  });
});

describe("credential instructions", () => {
  const secured = contract({
    securitySchemes: {
      basicAuth: scheme({
        name: "basicAuth",
        type: "http",
        scheme: "basic"
      }),
      bearerAuth: scheme({ name: "bearerAuth" }),
      keyAuth: scheme({
        name: "keyAuth",
        type: "apiKey",
        location: "query",
        wire_name: "api_key"
      })
    }
  });

  it("names schemes, wire names, and environments only", () => {
    expect(syntheticCredentialInstructions(secured)).toEqual([
      "Scheme basicAuth: send the Authorization header with Basic credentials." +
        " Build it from the values of OAL_AUTH_BASICAUTH_USERNAME and OAL_AUTH_BASICAUTH_PASSWORD.",
      "Scheme bearerAuth: send the Authorization header with the bearer token" +
        " from the value of OAL_AUTH_BEARERAUTH.",
      "Scheme keyAuth: append the api_key query parameter with the value of" +
        " OAL_AUTH_KEYAUTH on every request."
    ]);
  });

  it("returns no instruction for an open contract", () => {
    expect(syntheticCredentialInstructions(contract({}))).toEqual([]);
  });

  it("records the instructions without any credential value", async () => {
    const credentials = mintRunCredentials(secured, "trial-seed-1");
    const server = await startServer({ contract: secured });
    try {
      const record = server.handle.serverRecord;
      expect(record["credential_instructions"]).toEqual(
        syntheticCredentialInstructions(secured)
      );
      expect(record["credential_names"]).toEqual([
        "OAL_AUTH_BASICAUTH",
        "OAL_AUTH_BASIC_PASSWORD",
        "OAL_AUTH_BASIC_USERNAME",
        "OAL_AUTH_BEARER",
        "OAL_AUTH_BEARERAUTH",
        "OAL_AUTH_KEYAUTH"
      ]);
      expect(JSON.stringify(record).includes(credentials.bearer)).toBe(false);
    } finally {
      await server.handle.close();
    }
  });
});

describe("determinism", () => {
  it("digests identical records from identical options", async () => {
    const options: RawHttpExposureOptions = {
      visibility: "discoverable",
      documentation: {
        sanitizedContract: SANITIZED,
        candidates: { index: true, openapi: true }
      }
    };
    const first = await startServer({}, options);
    const second = await startServer({}, options);
    try {
      expect(portOf(first.handle)).not.toBe(portOf(second.handle));
      expect(serverRecordSurfaceDigest(second.handle.serverRecord)).toBe(
        serverRecordSurfaceDigest(first.handle.serverRecord)
      );
      const left = await exchange(first.handle, "GET", "/");
      const right = await exchange(second.handle, "GET", "/");
      expect(right.body).toBe(left.body);
      expect(neutralShape(right.body)).not.toContain("127.0.0.1");
    } finally {
      await first.handle.close();
      await second.handle.close();
    }
  });

  it("localizes the sanitized document against the live base URL", async () => {
    const first = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: (baseUrl) =>
            JSON.stringify({ servers: [{ url: baseUrl }] })
        }
      }
    );
    const second = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: (baseUrl) =>
            JSON.stringify({ servers: [{ url: baseUrl }] })
        }
      }
    );
    try {
      const left = await exchange(first.handle, "GET", "/openapi.json");
      const right = await exchange(second.handle, "GET", "/openapi.json");
      expect(left.body).toContain(first.handle.baseUrl);
      expect(right.body).toContain(second.handle.baseUrl);
      expect(right.body).not.toBe(left.body);
      expect(serverRecordSurfaceDigest(second.handle.serverRecord)).toBe(
        serverRecordSurfaceDigest(first.handle.serverRecord)
      );
    } finally {
      await first.handle.close();
      await second.handle.close();
    }
  });

  it("records documentation exchanges with their own stream identity", async () => {
    const server = await startServer(
      {},
      {
        visibility: "discoverable",
        documentation: {
          sanitizedContract: SANITIZED,
          authentication: "none"
        }
      }
    );
    try {
      await exchange(server.handle, "GET", "/openapi.json");
      await exchange(server.handle, "GET", "/openapi.json");
      await exchange(server.handle, "GET", "/things");
      const records = server.trace.events.flatMap((event) => {
        const doc = eventOf(event, "documentation.exchange");
        return doc === null ? [] : [doc];
      });
      expect(records.length).toBe(2);
      expect(records[0]?.["event_id"]).toBe("doc_00000001");
      expect(records[1]?.["event_id"]).toBe("doc_00000002");
      expect(records[1]?.["sequence"]).toBe(2);
      expect(records[0]?.["outcome"]).toBe("contract_served");
      expect(apiEvents(server.trace).length).toBe(1);
    } finally {
      await server.handle.close();
    }
  });
});
