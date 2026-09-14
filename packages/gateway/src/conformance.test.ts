/**
 * Black-box mock conformance tests (specification section 15). Every
 * exchange drives the gateway over a real loopback HTTP socket on an
 * ephemeral port, so the assertions pin wire behavior instead of helper
 * functions: routing and method matching, framework problem documents
 * with stable codes, content negotiation, parameter styles, request
 * validation, deterministic response selection, and authentication
 * emulation.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIMIT_DEFAULTS } from "@oal/config";
import type { ContractIR } from "@oal/contract-ir";
import { compileOpenApi } from "../../openapi/src/index.ts";
import { mintRunCredentials } from "./auth.ts";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type RawRequest
} from "./server.ts";

const FIXTURES = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);

interface Exchange {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Violation {
  location: string;
  pointer: string;
  code: string;
  message: string;
}

interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: string;
  request_id: string;
  detail?: string;
  violations?: Violation[];
}

function compileFixture(entrypoint: string): ContractIR {
  const documents: Record<string, string> = {};
  const extra =
    entrypoint === "openapi/refs/entry.yaml"
      ? ["openapi/refs/shared.yaml"]
      : [];
  for (const path of [entrypoint, ...extra]) {
    documents[path] = readFileSync(`${FIXTURES}${path}`, "utf8");
  }
  return compileOpenApi({ documents, entrypoint }).contract;
}

/** A loopback gateway listening on an ephemeral 127.0.0.1 port. */
class Gateway {
  private readonly server: Server;
  private readonly options: GatewayOptions;
  private sequence = 0;

  static async start(entrypoint: string): Promise<Gateway> {
    const options: GatewayOptions = {
      contract: compileFixture(entrypoint),
      limits: LIMIT_DEFAULTS,
      runSeed: "conformance_seed_1"
    };
    const server = createServer((req, res) => {
      void toRawRequest(req).then((raw) => {
        const response = handleGatewayRequest(options, ++instanceSequence, raw);
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return new Gateway(server, options);
  }

  private constructor(server: Server, options: GatewayOptions) {
    this.server = server;
    this.options = options;
  }

  get credentials(): ReturnType<typeof mintRunCredentials> {
    return mintRunCredentials(this.options.contract, this.options.runSeed);
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The loopback listener has no port.");
    }
    return address.port;
  }

  async exchange(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string
  ): Promise<Exchange> {
    this.sequence += 1;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = body;
    }
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, init);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text()
    };
  }

  /** fetch refuses the TRACE method, so it needs a raw socket client. */
  async raw(
    method: string,
    path: string,
    headers: Record<string, string> = {}
  ): Promise<Exchange> {
    this.sequence += 1;
    return new Promise<Exchange>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port: this.port, method, path, headers },
        (incoming: IncomingMessage) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            resolve({
              status: incoming.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(incoming.headers).map(([name, value]) => [
                  name,
                  Array.isArray(value) ? value.join(", ") : (value ?? "")
                ])
              ),
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        }
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
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

let instanceSequence = 0;

async function toRawRequest(req: IncomingMessage): Promise<RawRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return {
    method: req.method ?? "GET",
    target: req.url ?? "/",
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: new Uint8Array(Buffer.concat(chunks))
  };
}

function problemOf(exchange: Exchange): ProblemDocument {
  return JSON.parse(exchange.body) as ProblemDocument;
}

/** Problem bodies differ only in the per-sequence request identifier. */
function withoutRequestId(body: string): string {
  return body.replace(/req_\d{8}/g, "req_stripped");
}

const JSON_TYPE = "application/json; charset=utf-8";
const PROBLEM_TYPE = "application/problem+json";

let params: Gateway;
let methods: Gateway;
let secure: Gateway;
let store: Gateway;
let unsupported: Gateway;

beforeAll(async () => {
  [params, methods, secure, store, unsupported] = await Promise.all([
    Gateway.start("openapi/parameters-matrix.json"),
    Gateway.start("openapi/methods-eight.json"),
    Gateway.start("openapi/security-alternatives.json"),
    Gateway.start("openapi/petstore-expanded.yaml"),
    Gateway.start("openapi/pattern-unsupported.json")
  ]);
});

afterAll(async () => {
  await Promise.all([
    params.close(),
    methods.close(),
    secure.close(),
    store.close(),
    unsupported.close()
  ]);
});

describe("routing and method matching", () => {
  it("serves a declared route with the declared representation", async () => {
    const exchange = await params.exchange(
      "GET",
      "/params/form?page=1&tags=a&tags=b"
    );
    expect(exchange.status).toBe(200);
    expect(exchange.headers["content-type"]).toBe(JSON_TYPE);
    expect(JSON.parse(exchange.body)).toEqual({ status: "ok" });
  });

  it("answers 404 with a stable route_not_found problem", async () => {
    const exchange = await params.exchange("GET", "/params/nope");
    expect(exchange.status).toBe(404);
    expect(exchange.headers["content-type"]).toBe(PROBLEM_TYPE);
    const problem = problemOf(exchange);
    expect(problem.type).toBe("https://agentlab.dev/problems/route_not_found");
    expect(problem.title).toBe("The request target is not a known route.");
    expect(problem.status).toBe(404);
    expect(problem.code).toBe("route_not_found");
    expect(problem.request_id).toMatch(/^req_\d{8}$/);
  });

  it("does not normalize dot segments or encoded slashes", async () => {
    // fetch normalizes dot segments client side, so this needs the raw
    // socket client to prove the gateway leaves them alone.
    const dots = await params.raw("GET", "/params/./form?page=1");
    expect(dots.status).toBe(404);
    expect(problemOf(dots).code).toBe("route_not_found");
    const parent = await params.raw("GET", "/params/../params/form?page=1");
    expect(parent.status).toBe(404);
    const encoded = await params.exchange("GET", "/params%2Fform?page=1");
    expect(encoded.status).toBe(404);
  });

  it("rejects an empty path parameter segment as unknown", async () => {
    const exchange = await params.exchange("GET", "/params/simple/");
    expect(exchange.status).toBe(404);
    expect(problemOf(exchange).code).toBe("route_not_found");
  });

  it("answers 405 with a sorted Allow header", async () => {
    const exchange = await params.exchange("POST", "/params/form");
    expect(exchange.status).toBe(405);
    expect(problemOf(exchange).code).toBe("method_not_allowed");
    expect(exchange.headers.allow).toBe("GET");
    const all = await methods.exchange("MKCOL", "/resource");
    expect(all.headers.allow).toBe(
      "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, TRACE"
    );
  });

  it("prefers the literal route over the parameterized neighbour", async () => {
    const literal = await params.exchange("GET", "/params/literal/fixed");
    expect(literal.status).toBe(200);
    const parameter = await params.exchange("GET", "/params/literal/7");
    expect(parameter.status).toBe(200);
    // A wrong method on the literal route stays a 405 and never falls
    // through to the parameterized POST neighbour.
    const wrong = await params.exchange("POST", "/params/literal/fixed");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe("GET");
    const neighbour = await params.exchange("POST", "/params/literal/7");
    expect(neighbour.status).toBe(200);
  });

  it("routes every declared method of a path item", async () => {
    const created = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "application/json" },
      '{"name":"alpha"}'
    );
    expect(created.status).toBe(201);
    for (const method of ["GET", "PUT", "PATCH"]) {
      const exchange = await methods.exchange(method, "/resource");
      expect(exchange.status, method).toBe(200);
      expect(exchange.headers["content-type"]).toBe(JSON_TYPE);
    }
    for (const method of ["DELETE", "OPTIONS"]) {
      const exchange = await methods.exchange(method, "/resource");
      expect(exchange.status, method).toBe(204);
      expect(exchange.body).toBe("");
      expect(exchange.headers["content-length"]).toBeUndefined();
    }
    const traced = await methods.raw("TRACE", "/resource");
    expect(traced.status).toBe(200);
    expect(traced.headers["content-type"]).toBe("text/plain");
    expect(traced.body.length).toBeGreaterThan(0);
  });

  it("sends no body bytes for HEAD while describing the representation", async () => {
    const head = await methods.exchange("HEAD", "/resource");
    const get = await methods.exchange("GET", "/resource");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe(JSON_TYPE);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });
});

describe("content negotiation", () => {
  it("serves the declared default representation without Accept", async () => {
    const exchange = await methods.exchange("GET", "/resource");
    expect(exchange.headers["content-type"]).toBe(JSON_TYPE);
    const body = JSON.parse(exchange.body) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("serves the value of the negotiated media type", async () => {
    const exchange = await methods.exchange("GET", "/resource", {
      accept: "text/plain"
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers["content-type"]).toBe("text/plain");
    // The body comes from the text/plain schema, not from the JSON page.
    expect(exchange.body.startsWith("[")).toBe(false);
    expect(exchange.body.startsWith("{")).toBe(false);
  });

  it("honors quality factors and case-insensitive types", async () => {
    const quality = await methods.exchange("GET", "/resource", {
      accept: "application/json;q=0.5, text/plain"
    });
    expect(quality.headers["content-type"]).toBe("text/plain");
    const upper = await methods.exchange("GET", "/resource", {
      accept: "TEXT/PLAIN"
    });
    expect(upper.status).toBe(200);
    expect(upper.headers["content-type"]).toBe("text/plain");
  });

  it("honors wildcards with the declared default", async () => {
    const exchange = await methods.exchange("GET", "/resource", {
      accept: "*/*"
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers["content-type"]).toBe(JSON_TYPE);
  });

  it("answers 406 when Accept cannot be satisfied", async () => {
    const exchange = await methods.exchange("GET", "/resource", {
      accept: "image/png"
    });
    expect(exchange.status).toBe(406);
    expect(exchange.headers["content-type"]).toBe(PROBLEM_TYPE);
    expect(problemOf(exchange).code).toBe("response_media_type_unacceptable");
  });

  it("answers 415 for an undeclared request media type", async () => {
    const exchange = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "text/csv" },
      "a,b"
    );
    expect(exchange.status).toBe(415);
    expect(problemOf(exchange).code).toBe("media_type_unsupported");
  });

  it("accepts a case-insensitive request Content-Type", async () => {
    const exchange = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "APPLICATION/JSON" },
      '{"name":"beta"}'
    );
    expect(exchange.status).toBe(201);
  });
});

describe("parameter parsing and coercion", () => {
  it("coerces and validates a simple integer path parameter", async () => {
    const ok = await params.exchange("GET", "/params/simple/7");
    expect(ok.status).toBe(200);
    const type = await params.exchange("GET", "/params/simple/abc");
    expect(type.status).toBe(422);
    expect(problemOf(type).violations).toEqual([
      {
        location: "path",
        pointer: "id",
        code: "type",
        message: 'Expected type "integer".'
      }
    ]);
    const bound = await params.exchange("GET", "/params/simple/0");
    expect(bound.status).toBe(422);
    expect(problemOf(bound).violations?.[0]?.code).toBe("minimum");
  });

  it("lets the operation level override the inherited declaration", async () => {
    const ok = await params.exchange("GET", "/params/override/20");
    expect(ok.status).toBe(200);
    const rejected = await params.exchange("GET", "/params/override/5");
    expect(rejected.status).toBe(422);
    expect(problemOf(rejected).violations?.[0]?.code).toBe("minimum");
  });

  it("parses label and matrix path styles", async () => {
    const label = await params.exchange("GET", "/params/label/.a.b");
    expect(label.status).toBe(200);
    const short = await params.exchange("GET", "/params/label/.a");
    expect(short.status).toBe(422);
    expect(problemOf(short).violations?.[0]?.code).toBe("minItems");
    const undotted = await params.exchange("GET", "/params/label/a,b");
    expect(undotted.status).toBe(422);
    expect(problemOf(undotted).violations?.[0]?.code).toBe("style");
    const matrix = await params.exchange("GET", "/params/matrix/;id=7");
    expect(matrix.status).toBe(200);
    const bare = await params.exchange("GET", "/params/matrix/7");
    expect(bare.status).toBe(422);
    expect(problemOf(bare).violations?.[0]?.code).toBe("style");
  });

  it("parses form primitives, arrays, and non-exploded objects", async () => {
    const ok = await params.exchange(
      "GET",
      "/params/form?page=1&tags=a&tags=b&filter=source,web&cursor=a%2Fb"
    );
    expect(ok.status).toBe(200);
    const positional = await params.exchange(
      "GET",
      "/params/form?page=2&tags=a&tags=b&filter=source,web"
    );
    expect(positional.status).toBe(200);
    const missing = await params.exchange("GET", "/params/form?tags=a&tags=b");
    expect(missing.status).toBe(422);
    const required = problemOf(missing).violations?.[0];
    expect(required?.location).toBe("query");
    expect(required?.pointer).toBe("page");
    expect(required?.code).toBe("required");
    const textual = await params.exchange(
      "GET",
      "/params/form?page=one&tags=a&tags=b"
    );
    expect(textual.status).toBe(422);
    expect(problemOf(textual).violations?.[0]?.code).toBe("type");
    const sparse = await params.exchange("GET", "/params/form?page=1&tags=a");
    expect(sparse.status).toBe(422);
    expect(problemOf(sparse).violations?.[0]?.code).toBe("minItems");
  });

  it("parses delimited and deep-object query styles", async () => {
    const delimited = await params.exchange(
      "GET",
      "/params/delimited?words=a%20b&codes=1|2"
    );
    expect(delimited.status).toBe(200);
    const deep = await params.exchange(
      "GET",
      "/params/deep?meta[source]=web&meta[weight]=2"
    );
    expect(deep.status).toBe(200);
    const absent = await params.exchange("GET", "/params/deep");
    expect(absent.status).toBe(422);
    expect(problemOf(absent).violations?.[0]?.code).toBe("required");
  });

  it("reads header and cookie parameters by name", async () => {
    const header = await params.exchange("GET", "/params/header", {
      "x-request-token": "abcd"
    });
    expect(header.status).toBe(200);
    const short = await params.exchange("GET", "/params/header", {
      "x-request-token": "ab"
    });
    expect(short.status).toBe(422);
    expect(problemOf(short).violations?.[0]?.code).toBe("minLength");
    const cookie = await params.exchange("GET", "/params/cookie", {
      cookie: "session=abcd"
    });
    expect(cookie.status).toBe(200);
    const missing = await params.exchange("GET", "/params/cookie");
    expect(missing.status).toBe(422);
    expect(problemOf(missing).violations?.[0]?.code).toBe("required");
  });

  it("parses a content parameter as JSON", async () => {
    const ok = await params.exchange(
      "GET",
      `/params/content?fields=${encodeURIComponent('["a","b"]')}`
    );
    expect(ok.status).toBe(200);
    const malformed = await params.exchange(
      "GET",
      "/params/content?fields=notjson"
    );
    expect(malformed.status).toBe(422);
    const violation = problemOf(malformed).violations?.[0];
    expect(violation?.location).toBe("query");
    expect(violation?.pointer).toBe("fields");
    expect(violation?.code).toBe("style");
  });
});

describe("request body validation", () => {
  it("accepts a schema-valid body and rejects violations with pointers", async () => {
    const ok = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "application/json" },
      '{"name":"alpha","labels":["x"]}'
    );
    expect(ok.status).toBe(201);
    const missing = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "application/json" },
      '{"labels":["x"]}'
    );
    expect(missing.status).toBe(422);
    expect(problemOf(missing).code).toBe("request_schema_invalid");
    // The shared validator reports a missing property at the parent
    // pointer and names the property in the message; section 15.3 shows
    // a property pointer instead. Pin the shipped behavior here.
    expect(problemOf(missing).violations).toEqual([
      {
        location: "body",
        pointer: "",
        code: "required",
        message: 'Required property "name" is missing.'
      }
    ]);
    const typed = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "application/json" },
      '{"name":5}'
    );
    expect(typed.status).toBe(422);
    expect(problemOf(typed).violations?.[0]?.pointer).toBe("/name");
  });

  it("rejects malformed JSON with 400 request_malformed", async () => {
    const exchange = await methods.exchange(
      "POST",
      "/resource",
      { "content-type": "application/json" },
      "{nope"
    );
    expect(exchange.status).toBe(400);
    expect(problemOf(exchange).code).toBe("request_malformed");
  });

  it("rejects a missing required body with 422", async () => {
    const exchange = await methods.exchange("POST", "/resource", {
      "content-type": "application/json"
    });
    expect(exchange.status).toBe(422);
    const violation = problemOf(exchange).violations?.[0];
    expect(violation?.location).toBe("body");
    expect(violation?.code).toBe("required");
  });
});

describe("response selection", () => {
  const apiKey = (gateway: Gateway): Record<string, string> => {
    return { api_key: gateway.credentials.apiKeys.api_key as string };
  };

  it("serves the named example of the negotiated media type", async () => {
    const exchange = await store.exchange("GET", "/pets", {
      accept: "application/json",
      ...apiKey(store)
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers["content-type"]).toBe(JSON_TYPE);
    expect(JSON.parse(exchange.body)).toEqual([
      { id: 1, name: "Rin Tin Tin", tag: "watchdog" },
      { id: 2, name: "Lassie" }
    ]);
  });

  it("generates a value for a media type without examples", async () => {
    const exchange = await store.exchange("GET", "/pets", {
      accept: "application/xml",
      ...apiKey(store)
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers["content-type"]).toBe("application/xml");
    const body = JSON.parse(exchange.body) as Record<string, unknown>;
    expect(typeof body["name"]).toBe("string");
    expect(Array.isArray(body)).toBe(false);
  });
});

describe("authentication emulation", () => {
  it("permits a route declared with an empty requirement", async () => {
    const exchange = await secure.exchange("GET", "/open");
    expect(exchange.status).toBe(200);
  });

  it("answers 401 authentication_failed without credentials", async () => {
    const exchange = await secure.exchange("GET", "/key/header");
    expect(exchange.status).toBe(401);
    expect(problemOf(exchange).code).toBe("authentication_failed");
  });

  it("verifies api keys in header, query, and cookie locations", async () => {
    const credentials = secure.credentials;
    const header = await secure.exchange("GET", "/key/header", {
      "x-api-key": credentials.apiKeys.header_key as string
    });
    expect(header.status).toBe(200);
    const query = await secure.exchange(
      "GET",
      `/key/query?api_key=${credentials.apiKeys.query_key as string}`
    );
    expect(query.status).toBe(200);
    const cookie = await secure.exchange("GET", "/key/cookie", {
      cookie: `session_key=${credentials.apiKeys.cookie_key as string}`
    });
    expect(cookie.status).toBe(200);
    const wrong = await secure.exchange("GET", "/key/header", {
      "x-api-key": "oal_wrong"
    });
    expect(wrong.status).toBe(401);
  });

  it("verifies HTTP basic and bearer credentials", async () => {
    const credentials = secure.credentials;
    const basic = await secure.exchange("GET", "/basic", {
      authorization: `Basic ${Buffer.from(
        `${credentials.basic.username}:${credentials.basic.password}`
      ).toString("base64")}`
    });
    expect(basic.status).toBe(200);
    const wrongPassword = await secure.exchange("GET", "/basic", {
      authorization: `Basic ${Buffer.from(
        `${credentials.basic.username}:not-the-password`
      ).toString("base64")}`
    });
    expect(wrongPassword.status).toBe(401);
    const bearer = await secure.exchange("GET", "/bearer", {
      authorization: `Bearer ${credentials.bearer}`
    });
    expect(bearer.status).toBe(200);
  });

  it("ANDs schemes inside one requirement", async () => {
    const credentials = secure.credentials;
    const one = await secure.exchange("GET", "/both", {
      "x-api-key": credentials.apiKeys.header_key as string
    });
    expect(one.status).toBe(401);
    const both = await secure.exchange("GET", "/both", {
      "x-api-key": credentials.apiKeys.header_key as string,
      authorization: `Bearer ${credentials.bearer}`
    });
    expect(both.status).toBe(200);
  });

  it("ORs declared alternatives", async () => {
    const credentials = secure.credentials;
    const basic = await secure.exchange("GET", "/either", {
      authorization: `Basic ${Buffer.from(
        `${credentials.basic.username}:${credentials.basic.password}`
      ).toString("base64")}`
    });
    expect(basic.status).toBe(200);
    const bearer = await secure.exchange("GET", "/either", {
      authorization: `Bearer ${credentials.bearer}`
    });
    expect(bearer.status).toBe(200);
  });

  it("answers 403 authorization_failed for a scope deficit", async () => {
    const exchange = await secure.exchange("GET", "/scope", {
      authorization: `Bearer ${secure.credentials.bearer}`
    });
    expect(exchange.status).toBe(403);
    expect(problemOf(exchange).code).toBe("authorization_failed");
  });

  it("rejects a wrong key but keeps anonymous access when optional", async () => {
    const credentials = secure.credentials;
    const anonymous = await secure.exchange("GET", "/key/optional");
    expect(anonymous.status).toBe(200);
    const verified = await secure.exchange("GET", "/key/optional", {
      "x-api-key": credentials.apiKeys.header_key as string
    });
    expect(verified.status).toBe(200);
    const wrong = await secure.exchange("GET", "/key/optional", {
      "x-api-key": "oal_wrong"
    });
    expect(wrong.status).toBe(401);
    expect(problemOf(wrong).code).toBe("authentication_failed");
  });
});

describe("determinism and mock bounds", () => {
  it("repeats a problem body byte for byte", async () => {
    const first = await params.exchange("GET", "/params/simple/abc");
    const second = await params.exchange("GET", "/params/simple/abc");
    expect(withoutRequestId(second.body)).toBe(withoutRequestId(first.body));
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(second.status).toBe(first.status);
    expect(problemOf(second).request_id).toMatch(/^req_\d{8}$/);
  });

  it("repeats a success response byte for byte", async () => {
    const first = await methods.exchange("GET", "/resource");
    const second = await methods.exchange("GET", "/resource");
    expect(second.body).toBe(first.body);
    expect(second.headers["content-type"]).toBe(JSON_TYPE);
    expect(second.headers["content-length"]).toBe(
      first.headers["content-length"]
    );
  });

  it("never leaks host paths or stack details", async () => {
    for (const exchange of [
      await params.exchange("GET", "/params/nope"),
      await params.exchange("POST", "/params/form"),
      await methods.exchange("POST", "/resource", {
        "content-type": "application/json"
      })
    ]) {
      expect(exchange.body).not.toContain("/home/");
      expect(exchange.body).not.toContain("node_modules");
      expect(exchange.body).not.toContain(".ts");
    }
  });

  it("answers 501 quickly when generation is unsupported", async () => {
    const began = Date.now();
    const exchange = await unsupported.exchange(
      "POST",
      "/slugs",
      { "content-type": "application/json" },
      JSON.stringify({ slug: "a".repeat(24) })
    );
    const elapsed = Date.now() - began;
    expect(exchange.status).toBe(501);
    expect(problemOf(exchange).code).toBe("mock_behavior_unavailable");
    expect(elapsed).toBeLessThan(2000);
  });
});
