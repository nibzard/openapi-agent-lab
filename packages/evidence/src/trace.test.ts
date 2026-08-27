import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SchemaValidator, type Json } from "@oal/core";
import { Redactor } from "./redaction.ts";
import {
  EventStream,
  JsonlSink,
  captureBody,
  redactPath,
  traceHeaders,
  traceQuery,
  type TraceBody
} from "./trace.ts";

const SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "trace-event.v1.schema.json"
);

const KEY = new Uint8Array(32).fill(3);

function redactor(): Redactor {
  return new Redactor({
    hmacKey: KEY,
    secrets: ["oal_run_secret_1"],
    config: { sensitiveHeaderNames: ["steel-api-key"] }
  });
}

function limits() {
  return { maxJsonBytes: 1024, maxTextPreviewBytes: 64, captureBlobs: true };
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bodyWithoutDigest(body: TraceBody): TraceBody {
  if (body.kind === "text" || body.kind === "binary") {
    return { ...body, sha256: body.sha256 === null ? null : "DIGEST" };
  }
  return body;
}

describe("captureBody", () => {
  it("captures an absent body as kind none", async () => {
    const body = await captureBody({
      bytes: new Uint8Array(0),
      contentType: null,
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(body).toEqual({ kind: "none" });
  });

  it("parses, redacts, and captures JSON bodies", async () => {
    const raw = '{"name":"c1","api_key":"abc","note":"uses oal_run_secret_1"}';
    const body = await captureBody({
      bytes: text(raw),
      contentType: "application/json; charset=utf-8",
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(body.kind).toBe("json");
    if (body.kind !== "json") {
      return;
    }
    expect(body.truncated).toBe(false);
    expect(body.size_bytes).toBe(raw.length);
    const r = redactor();
    expect(body.value).toEqual({
      name: "c1",
      api_key: r.redactedValue("abc", "sensitive_key"),
      note: r.redactedValue("uses oal_run_secret_1", "registered_secret")
    });
  });

  it("flags oversized JSON as truncated but still redacts it", async () => {
    const body = await captureBody({
      bytes: text(`{"pad":"${"x".repeat(2048)}"}`),
      contentType: "application/json",
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(body.kind).toBe("json");
    if (body.kind === "json") {
      expect(body.truncated).toBe(true);
    }
  });

  it("captures text bodies with a bounded redacted preview", async () => {
    const body = await captureBody({
      bytes: text("plain body without secrets"),
      contentType: "text/plain; charset=utf-8",
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(bodyWithoutDigest(body)).toEqual({
      kind: "text",
      size_bytes: "plain body without secrets".length,
      sha256: "DIGEST",
      text: "plain body without secrets",
      truncated: false
    });
  });

  it("drops the digest when a text body contains a registered secret", async () => {
    const body = await captureBody({
      bytes: text("token=oal_run_secret_1"),
      contentType: "text/plain",
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(body.kind).toBe("text");
    if (body.kind === "text") {
      expect(body.sha256).toBeNull();
    }
  });

  it("captures binary bodies with digest and blob reference", async () => {
    let stored: Uint8Array | null = null;
    const body = await captureBody({
      bytes: new Uint8Array([0, 1, 2, 255]),
      contentType: "application/octet-stream",
      redactor: redactor(),
      blobs: {
        put: (bytes: Uint8Array) => {
          stored = bytes;
          return Promise.resolve({ digest: "a".repeat(64) });
        }
      },
      limits: limits()
    });
    expect(body.kind).toBe("binary");
    if (body.kind !== "binary") {
      return;
    }
    expect(body.size_bytes).toBe(4);
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.blob_ref).toBe(`blobs/sha256/${body.sha256}`);
    expect(stored).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it("omits the blob reference when blobs are disabled", async () => {
    const body = await captureBody({
      bytes: new Uint8Array([9]),
      contentType: "application/octet-stream",
      redactor: redactor(),
      blobs: null,
      limits: { ...limits(), captureBlobs: false }
    });
    expect(body).toMatchObject({ kind: "binary", blob_ref: null });
  });

  it("captures multipart bodies with redacted parts", async () => {
    const raw = [
      "--boundary-42",
      'Content-Disposition: form-data; name="file"; filename="brief.txt"',
      "Content-Type: text/plain",
      "",
      "brief content",
      "--boundary-42--",
      ""
    ].join("\r\n");
    const body = await captureBody({
      bytes: text(raw),
      contentType: 'multipart/form-data; boundary="boundary-42"',
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    expect(body.kind).toBe("multipart");
    if (body.kind !== "multipart") {
      return;
    }
    expect(body.parts).toHaveLength(1);
    const part = body.parts[0];
    expect(part?.name).toBe("file");
    expect(part?.filename).toBe("brief.txt");
    expect(part?.body).toMatchObject({ kind: "text", text: "brief content" });
  });
});

describe("trace header and query records", () => {
  it("keeps lowercase names, wire order, and redaction flags", () => {
    const headers = traceHeaders(
      [
        ["Content-Type", ["application/json"]],
        ["Steel-API-Key", ["oal_run_secret_1"]],
        ["X-Team", ["blue"]]
      ],
      redactor()
    );
    expect(headers).toEqual([
      { name: "content-type", values: ["application/json"], redacted: false },
      { name: "steel-api-key", values: ["[REDACTED]"], redacted: true },
      { name: "x-team", values: ["blue"], redacted: false }
    ]);
  });

  it("fingerprints sensitive query values", () => {
    const r = new Redactor({
      hmacKey: KEY,
      config: { sensitiveQueryNames: ["api_key"] }
    });
    const query = traceQuery(
      [
        ["api_key", ["abc"]],
        ["team", ["blue"]]
      ],
      r
    );
    expect(query[0]?.values[0]).toMatch(/^path-[0-9a-f]{12}$/);
    expect(query[1]).toEqual({ name: "team", values: ["blue"] });
  });

  it("fingerprints secret path segments and keeps the rest", () => {
    const redacted = redactPath(
      "/v1/tenants/oal_run_secret_1/computers",
      redactor()
    );
    expect(redacted).toMatch(/^\/v1\/tenants\/path-[0-9a-f]{12}\/computers$/);
  });
});

describe("EventStream", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oal-trace-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes completed events in sequence order despite racing", async () => {
    const sink = await JsonlSink.open(join(dir, "trace.jsonl"));
    const stream = EventStream.open(sink, "evt");
    const first = stream.reserve();
    const second = stream.reserve();
    const third = stream.reserve();
    await stream.complete({ sequence: second.sequence, note: "second" });
    expect(stream.buffered).toBe(1);
    await stream.complete({ sequence: first.sequence, note: "first" });
    expect(stream.buffered).toBe(0);
    await stream.complete({ sequence: third.sequence, note: "third" });
    const lines = (await readFile(join(dir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(
      lines.map((line) => (JSON.parse(line) as { note: string }).note)
    ).toEqual(["first", "second", "third"]);
    expect(first.event_id).toBe("evt_00000001");
    expect(third.event_id).toBe("evt_00000003");
  });

  it("flushes one line per event", async () => {
    const sink = await JsonlSink.open(join(dir, "trace.jsonl"));
    const stream = EventStream.open(sink, "evt");
    for (let index = 1; index <= 3; index += 1) {
      const reserved = stream.reserve();
      await stream.complete({ sequence: reserved.sequence, index });
    }
    const lines = (await readFile(join(dir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
  });
});

describe("trace-event schema conformance", () => {
  it("accepts a complete api.exchange record", async () => {
    const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as Json;
    const validator = new SchemaValidator(schema);
    const sink = await JsonlSink.open(
      join(tmpdir(), `oal-schema-${Date.now()}.jsonl`)
    );
    const stream = EventStream.open(sink, "evt");
    const reserved = stream.reserve();
    const body = await captureBody({
      bytes: text('{"name":"c1"}'),
      contentType: "application/json",
      redactor: redactor(),
      blobs: null,
      limits: limits()
    });
    const event = {
      schema_version: 1,
      type: "api.exchange",
      event_id: reserved.event_id,
      sequence: reserved.sequence,
      participant_ingress_sequence: 1,
      observed_at: "2026-08-27T12:00:00.482Z",
      logical_time: "2000-01-01T00:00:00.000Z",
      batch_id: "batch-01",
      run_id: "batch-01-run-01",
      eval_id: "checkpoint-recovery",
      actor: "participant",
      transport: {
        kind: "http",
        request_id: "req_00000001",
        connection_id: "conn_0001"
      },
      operation: {
        matched: true,
        key: "path:POST /v1/computers",
        uid: "op_78c844bd7fa4",
        operation_id: "createComputer",
        method: "POST",
        path_template: "/v1/computers",
        support: "supported"
      },
      request: {
        received_at: "2026-08-27T12:00:00.480Z",
        method: "POST",
        path: "/v1/computers",
        query_string: "",
        query: [],
        path_parameters: {},
        headers: [
          {
            name: "content-type",
            values: ["application/json"],
            redacted: false
          },
          { name: "steel-api-key", values: ["[REDACTED]"], redacted: true }
        ],
        credential_present: true,
        content_type: "application/json",
        body
      },
      authentication: {
        status: "authenticated",
        alternative_index: 0,
        schemes: ["apiKeyAuth"],
        principal_ref: "principal-01"
      },
      validation: {
        request: { status: "valid", violations: [] },
        response: { status: "not_evaluated", violations: [] }
      },
      backend: null,
      response: {
        completed_at: "2026-08-27T12:00:00.482Z",
        status: 201,
        headers: [],
        content_type: "application/json",
        body: { kind: "none" }
      },
      state: null,
      idempotency: { status: "not_requested", record_ref: null },
      replay: { classification: "full", reason_code: null },
      error: null,
      duration_ms: 2,
      resource_usage: { request_bytes: 15, response_bytes: 0 },
      extensions: {}
    };
    const violations = validator.errors(event as unknown as Json);
    expect(violations).toEqual([]);
  });

  it("rejects an event missing required fields", async () => {
    const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as Json;
    const validator = new SchemaValidator(schema);
    expect(
      validator.errors({ type: "api.exchange" } as unknown as Json).length
    ).toBeGreaterThan(0);
  });
});
