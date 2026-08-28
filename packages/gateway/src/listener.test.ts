/**
 * Serving-path tests for the loopback gateway listener. Every exchange
 * here runs over a real HTTP socket so the assertions pin wire
 * behavior: one trace event per accepted, rejected, or disconnected
 * request, duplicate wire values in wire order, digest-and-blob
 * evidence for binary and multipart bodies, and state transactions
 * that never commit an invalid backend result.
 */

import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { LIMIT_DEFAULTS, type LimitTable } from "@oal/config";
import { sha256HexBytes, type Json } from "@oal/core";
import type {
  ContractIR,
  MediaExampleIR,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SchemaIR
} from "@oal/contract-ir";
import { startGatewayListener, type GatewayListener } from "./listener.ts";
import type { ContractFixture } from "./select.ts";
import { createGatewayState, type GatewayState } from "./state.ts";
import { MemoryBlobStore, type BlobStore } from "./trace.ts";
import type { GatewayOptions } from "./server.ts";

function schema(uid: string, schemaBody: Json): SchemaIR {
  return { uid, schema: schemaBody, source_pointer: "", document_uri: "" };
}

function headerParameter(name: string, schemaRef: string): ParameterIR {
  return {
    name,
    location: "header",
    style: "simple",
    explode: false,
    allow_reserved: false,
    required: true,
    deprecated: false,
    description: null,
    schema_ref: schemaRef,
    content: null,
    examples: [],
    default_value: undefined,
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
    content: init.content ?? [],
    source_pointer: ""
  };
}

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:GET /things",
    uid: "op_listen1",
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
      init.schemas === undefined
        ? {
            sch_thing: schema("sch_thing", {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } }
            })
          }
        : init.schemas,
    operations: init.operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

/** A contract whose singular example violates the declared schema. */
function invalidExampleContract(): ContractIR {
  const examples: MediaExampleIR[] = [
    { name: null, value: { wrong: true }, summary: null }
  ];
  return contract({
    operations: [
      operation({
        responses: [
          response({
            content: [
              {
                media_type: "application/json",
                schema_ref: "sch_thing",
                examples,
                support: "supported",
                support_reason_codes: []
              }
            ]
          })
        ]
      })
    ]
  });
}

interface ListenerInit {
  contract?: ContractIR;
  limits?: LimitTable;
  state?: GatewayState;
  blobs?: BlobStore;
  fixtures?: ContractFixture[];
}

async function withListener(
  init: ListenerInit,
  run: (listener: GatewayListener) => Promise<void>
): Promise<void> {
  const options: GatewayOptions = {
    contract: init.contract ?? contract({ operations: [operation({})] }),
    limits: init.limits ?? LIMIT_DEFAULTS,
    runSeed: "listener_seed_1",
    ...(init.state === undefined ? {} : { state: init.state }),
    ...(init.fixtures === undefined ? {} : { fixtures: init.fixtures })
  };
  const listener = await startGatewayListener({
    gateway: options,
    ...(init.blobs === undefined ? {} : { blobs: init.blobs })
  });
  try {
    await run(listener);
  } finally {
    await listener.close();
  }
}

/** One fetch exchange; the body is drained so the response settles. */
async function exchange(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: Uint8Array
): Promise<{ status: number; contentType: string }> {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(`http://127.0.0.1:${port}${target}`, init);
  await response.arrayBuffer();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? ""
  };
}

/** Raw socket client that can repeat header lines and abort mid-request. */
function rawClient(
  port: number,
  headers: Record<string, string | string[]>,
  target: string,
  method: string
): {
  connected: Promise<void>;
  send: (body: Uint8Array) => void;
  abort: () => void;
} {
  let connected: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const socket = netConnect({ host: "127.0.0.1", port }, () => {
    const lines = [`${method} ${target} HTTP/1.1`, "Host: 127.0.0.1"];
    for (const [name, value] of Object.entries(headers)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${entry}`);
      }
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    connected();
  });
  socket.on("error", () => undefined);
  return {
    connected: ready,
    send: (body: Uint8Array): void => {
      socket.write(body);
    },
    abort: (): void => {
      // A half-close delivers the partial request reliably and ends
      // the exchange before the promised Content-Length is satisfied.
      socket.end();
    }
  };
}

describe("trace events per request", () => {
  it("records exactly one accepted event for a served request", async () => {
    await withListener({}, async (listener) => {
      const served = await exchange(listener.port, "GET", "/things");
      expect(served.status).toBe(200);
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      const [event] = listener.events;
      expect(event?.outcome).toBe("accepted");
      expect(event?.sequence).toBe(1);
      expect(event?.request_id).toBe("req_00000001");
      expect(event?.request.method).toBe("GET");
      expect(event?.request.target).toBe("/things");
      expect(event?.response?.status).toBe(200);
      expect(event?.response?.framework_code).toBeNull();
      expect(event?.error).toBeNull();
    });
  });

  it("records exactly one rejected event for a framework error", async () => {
    await withListener({}, async (listener) => {
      const served = await exchange(listener.port, "GET", "/nope");
      expect(served.status).toBe(404);
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      const [event] = listener.events;
      expect(event?.outcome).toBe("rejected");
      expect(event?.response?.framework_code).toBe("route_not_found");
      expect(event?.error).toBeNull();
    });
  });

  it("records exactly one disconnected event for an aborted socket", async () => {
    const listener = await startGatewayListener({
      gateway: {
        contract: contract({ operations: [operation({})] }),
        limits: LIMIT_DEFAULTS,
        runSeed: "listener_seed_1"
      }
    });
    try {
      const client = rawClient(
        listener.port,
        {
          "content-type": "application/json",
          "content-length": "100"
        },
        "/things",
        "POST"
      );
      await client.connected;
      client.send(new TextEncoder().encode('{"partial":'));
      client.abort();
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      // Give the listener every chance to record a second event.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const events = listener.events;
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.outcome).toBe("disconnected");
      expect(event?.response).toBeNull();
      expect(event?.error?.layer).toBe("transport");
      expect(event?.error?.code).toBe("client_disconnected");
      expect(event?.request_id).toMatch(/^req_\d{8}$/);
      expect(event?.request.body.sha256).toBe(
        sha256HexBytes(new TextEncoder().encode('{"partial":'))
      );
      expect(listener.diagnostics).toHaveLength(1);
      expect(listener.diagnostics[0]?.code).toBe("OAL-CLIENT-DISCONNECTED");
      expect(listener.diagnostics[0]?.phase).toBe("serve");
    } finally {
      await listener.close();
    }
  });
});

describe("wire order of duplicate values", () => {
  it("keeps repeated header and query values in wire order", async () => {
    const blobs = new MemoryBlobStore();
    const listener = await startGatewayListener({
      gateway: {
        contract: contract({ operations: [operation({})] }),
        limits: LIMIT_DEFAULTS,
        runSeed: "listener_seed_1"
      },
      blobs
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: listener.port,
            method: "GET",
            path: "/things?tag=first&tag=second",
            headers: { "x-tag": ["alpha", "beta"] }
          },
          (incoming) => {
            incoming.resume();
            incoming.on("end", () => {
              resolve();
            });
          }
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      const [event] = listener.events;
      const header = event?.request.headers.find(
        (entry) => entry.name === "x-tag"
      );
      expect(header?.values).toEqual(["alpha", "beta"]);
      const query = event?.request.query.find((entry) => entry.name === "tag");
      expect(query?.values).toEqual(["first", "second"]);
      expect(event?.outcome).toBe("accepted");
    } finally {
      await listener.close();
    }
  });
});

describe("header list parameters on the wire", () => {
  it("accepts two header lines as one trimmed list", async () => {
    const flags = operation({
      parameters: [headerParameter("X-Flags", "sch_flags")]
    });
    const source = contract({
      operations: [flags],
      schemas: {
        sch_thing: schema("sch_thing", {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } }
        }),
        sch_flags: schema("sch_flags", {
          type: "array",
          items: { type: "string", enum: ["alpha", "beta"] }
        })
      }
    });
    const listener = await startGatewayListener({
      gateway: {
        contract: source,
        limits: LIMIT_DEFAULTS,
        runSeed: "listener_seed_1"
      }
    });
    try {
      // Two header lines arrive flattened as "alpha, beta"; the space
      // after the comma is framing, so the second element must still
      // satisfy the enum.
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: listener.port,
            method: "GET",
            path: "/things",
            headers: { "x-flags": ["alpha", "beta"] }
          },
          (incoming) => {
            incoming.resume();
            incoming.on("end", () => {
              resolve(incoming.statusCode ?? 0);
            });
          }
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(status).toBe(200);
    } finally {
      await listener.close();
    }
  });
});

describe("default representation without Accept", () => {
  it("serves application/json over the alphabetically first type", async () => {
    // The compiler emits response content alphabetically, so a plain
    // GET without an Accept header must still receive the documented
    // application/json preference, not schema-generated binary.
    const dual = operation({
      responses: [
        response({
          content: [
            {
              media_type: "application/octet-stream",
              schema_ref: null,
              examples: [],
              support: "supported",
              support_reason_codes: []
            },
            {
              media_type: "application/json",
              schema_ref: "sch_thing",
              examples: [],
              support: "supported",
              support_reason_codes: []
            }
          ]
        })
      ]
    });
    await withListener(
      { contract: contract({ operations: [dual] }) },
      async (listener) => {
        // A raw socket sends no Accept header at all, where fetch would
        // add a default "accept: */*".
        const wire = await new Promise<string>((resolve, reject) => {
          const socket = netConnect(
            { host: "127.0.0.1", port: listener.port },
            () => {
              socket.write(
                "GET /things HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
              );
            }
          );
          const chunks: Buffer[] = [];
          socket.on("data", (chunk) => {
            chunks.push(chunk);
          });
          socket.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
          socket.on("error", reject);
        });
        expect(wire.startsWith("HTTP/1.1 200")).toBe(true);
        expect(wire.toLowerCase()).toContain("content-type: application/json");
      }
    );
  });
});

describe("response write guard", () => {
  it("drops a fixture header with CR/LF and still serves the response", async () => {
    await withListener(
      {
        fixtures: [
          {
            id: "fx_crlf",
            operation: "path:GET /things",
            status: 200,
            media_type: "application/json",
            headers: { "x-trace": "a\r\nSet-Cookie: pwned=1" },
            body: { kind: "json_inline", value: { id: "thing_1" } }
          }
        ]
      },
      async (listener) => {
        const response = await fetch(
          `http://127.0.0.1:${listener.port}/things`
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-trace")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.json()).toEqual({ id: "thing_1" });
        await vi.waitFor(() => {
          expect(listener.events).toHaveLength(1);
        });
        const [event] = listener.events;
        expect(event?.outcome).toBe("accepted");
        expect(event?.response?.status).toBe(200);
        expect(listener.diagnostics).toHaveLength(1);
        expect(listener.diagnostics[0]?.code).toBe(
          "OAL-RESPONSE-HEADER-INVALID"
        );
        expect(listener.diagnostics[0]?.phase).toBe("serve");
        // The listener stays alive and keeps serving after the write.
        const again = await exchange(listener.port, "GET", "/things");
        expect(again.status).toBe(200);
      }
    );
  });

  it("answers a handled error when a fixture header value is not a string", async () => {
    await withListener(
      {
        fixtures: [
          {
            id: "fx_header_type",
            operation: "path:GET /things",
            status: 200,
            media_type: "application/json",
            // A YAML list reaches the listener as an array; the header
            // filter cannot test it and must take the handled path.
            headers: { "x-trace": ["a"] as unknown as string },
            body: { kind: "json_inline", value: { id: "thing_1" } }
          }
        ]
      },
      async (listener) => {
        const response = await fetch(
          `http://127.0.0.1:${listener.port}/things`
        );
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toBe(
          "application/problem+json"
        );
        expect(await response.json()).toMatchObject({ code: "internal_error" });
        await vi.waitFor(() => {
          expect(listener.events).toHaveLength(1);
        });
        const [event] = listener.events;
        expect(event?.outcome).toBe("rejected");
        expect(event?.response?.status).toBe(500);
        expect(event?.response?.framework_code).toBe("internal_error");
        expect(event?.error).toBeNull();
        expect(listener.diagnostics).toHaveLength(1);
        expect(listener.diagnostics[0]?.code).toBe("OAL-RESPONSE-WRITE-FAILED");
        expect(listener.diagnostics[0]?.phase).toBe("serve");
        // The listener stays alive and keeps answering after the throw.
        const again = await exchange(listener.port, "GET", "/things");
        expect(again.status).toBe(500);
      }
    );
  });
});

describe("digest and blob evidence", () => {
  const BOUNDARY = "oal_boundary";

  function multipartWire(): Uint8Array {
    const binary = new Uint8Array(256);
    for (let index = 0; index < binary.length; index += 1) {
      binary[index] = index % 256;
    }
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="payload"; filename="data.bin"\r\n' +
        "Content-Type: application/octet-stream\r\n" +
        "\r\n"
    );
    const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
    const wire = new Uint8Array(head.length + binary.length + tail.length);
    wire.set(head, 0);
    wire.set(binary, head.length);
    wire.set(tail, head.length + binary.length);
    return wire;
  }

  it("stores a multipart body as its raw-byte digest and blob", async () => {
    const blobs = new MemoryBlobStore();
    const wire = multipartWire();
    const upload = operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "multipart/form-data",
            schema_ref: null,
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const listener = await startGatewayListener({
      gateway: {
        contract: contract({ operations: [upload] }),
        limits: LIMIT_DEFAULTS,
        runSeed: "listener_seed_1"
      },
      blobs
    });
    try {
      const served = await exchange(
        listener.port,
        "POST",
        "/things",
        { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        wire
      );
      expect(served.status).toBe(200);
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      const [event] = listener.events;
      expect(event?.request.body.kind).toBe("multipart");
      expect(event?.request.body.size_bytes).toBe(wire.length);
      expect(event?.request.body.sha256).toBe(sha256HexBytes(wire));
      const ref = event?.request.body.blob_ref;
      expect(ref).toBe(`blobs/sha256/${sha256HexBytes(wire)}`);
      const stored = blobs.get(ref ?? "");
      expect(Buffer.compare(Buffer.from(stored ?? []), Buffer.from(wire))).toBe(
        0
      );
    } finally {
      await listener.close();
    }
  });

  it("reduces a binary body to its digest and blob", async () => {
    const blobs = new MemoryBlobStore();
    const wire = new Uint8Array([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
    const upload = operation({
      method: "POST",
      key: "path:POST /things",
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "application/octet-stream",
            schema_ref: null,
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const listener = await startGatewayListener({
      gateway: {
        contract: contract({ operations: [upload] }),
        limits: LIMIT_DEFAULTS,
        runSeed: "listener_seed_1"
      },
      blobs
    });
    try {
      const served = await exchange(
        listener.port,
        "POST",
        "/things",
        { "content-type": "application/octet-stream" },
        wire
      );
      expect(served.status).toBe(200);
      await vi.waitFor(() => {
        expect(listener.events).toHaveLength(1);
      });
      const [event] = listener.events;
      expect(event?.request.body.kind).toBe("binary");
      expect(event?.request.body.sha256).toBe(sha256HexBytes(wire));
      const stored = blobs.get(event?.request.body.blob_ref ?? "");
      expect(Buffer.compare(Buffer.from(stored ?? []), Buffer.from(wire))).toBe(
        0
      );
    } finally {
      await listener.close();
    }
  });
});

describe("state on the serving path", () => {
  it("leaves state unchanged when the produced response is invalid", async () => {
    const state = createGatewayState();
    await withListener(
      { contract: invalidExampleContract(), state },
      async (listener) => {
        const served = await exchange(listener.port, "GET", "/things");
        expect(served.status).toBe(500);
        expect(served.contentType).toBe("application/problem+json");
        expect(state.revision).toBe(0);
        expect(state.appliedEffects).toEqual([]);
        expect(state.pendingEffects).toEqual([]);
        expect(state.rollbacks).toBe(1);
      }
    );
  });

  it("commits state when the produced response is valid", async () => {
    const state = createGatewayState();
    await withListener({ state }, async (listener) => {
      const served = await exchange(listener.port, "GET", "/things");
      expect(served.status).toBe(200);
      expect(state.revision).toBe(1);
      expect(state.appliedEffects).toEqual(["path:GET /things"]);
      expect(state.rollbacks).toBe(0);
    });
  });
});

describe("contract schema version gate", () => {
  it("refuses to start for an unsupported contract schema version", async () => {
    const future = contract({ operations: [operation({})] });
    (future as { schema_version: number }).schema_version = 2;
    await expect(
      startGatewayListener({
        gateway: {
          contract: future,
          limits: LIMIT_DEFAULTS,
          runSeed: "listener_seed_1"
        }
      })
    ).rejects.toMatchObject({
      code: "OAL-SCHEMA-VERSION-UNSUPPORTED",
      exitCode: 4
    });
  });
});
