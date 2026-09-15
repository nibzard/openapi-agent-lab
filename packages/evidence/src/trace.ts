/**
 * Normalized trace capture (specification section 25). Every request
 * that reaches the data plane produces exactly one api.exchange
 * record. Sequences are allocated at ingress; completions buffer
 * until prior records can be appended, so JSONL exports stay in
 * sequence order.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalJson,
  isJsonObject,
  sequenceId,
  sha256HexBytes,
  type Json,
  type JsonObject
} from "@oal/core";
import type { Redactor } from "./redaction.ts";

export type TraceHeader = {
  name: string;
  values: string[];
  redacted: boolean;
};

export type TraceQueryParameter = {
  name: string;
  values: string[];
};

export type TraceBody =
  | { kind: "none" }
  | {
      kind: "json";
      size_bytes: number;
      value: Json;
      truncated: boolean;
    }
  | {
      kind: "text";
      size_bytes: number;
      sha256: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "binary";
      size_bytes: number;
      sha256: string | null;
      blob_ref: string | null;
    }
  | {
      kind: "multipart";
      size_bytes: number;
      parts: Array<{
        name: string;
        filename: string | null;
        headers: TraceHeader[];
        body: TraceBody;
      }>;
    };

export interface TraceOperation {
  matched: boolean;
  key: string | null;
  uid: string | null;
  operation_id: string | null;
  method: string | null;
  path_template: string | null;
  support:
    | "supported"
    | "approximated"
    | "requires_scenario"
    | "unsupported"
    | null;
}

export interface TraceError {
  layer:
    | "routing"
    | "authentication"
    | "parsing"
    | "validation"
    | "behavior"
    | "timeout"
    | "transport"
    | "persistence"
    | "internal";
  code: string;
  message: string;
  retryable: boolean;
  details: JsonObject;
}

export interface TraceEvent {
  schema_version: 1;
  type: "api.exchange";
  event_id: string;
  sequence: number;
  participant_ingress_sequence: number | null;
  observed_at: string;
  logical_time: string | null;
  batch_id: string | null;
  run_id: string | null;
  eval_id: string | null;
  actor: "participant" | "control";
  transport: {
    kind: "http" | "mcp-direct" | "mcp-catalog";
    request_id: string | null;
    connection_id: string | null;
  };
  operation: TraceOperation;
  request: null | {
    received_at: string;
    method: string;
    path: string;
    query_string: string;
    query: TraceQueryParameter[];
    path_parameters: Record<string, string>;
    headers: TraceHeader[];
    credential_present: boolean;
    content_type: string | null;
    body: TraceBody;
  };
  authentication: {
    status: "authenticated" | "unauthenticated" | "not_required" | "rejected";
    alternative_index: number | null;
    schemes: string[];
    principal_ref: string | null;
  };
  validation: {
    request: TraceValidationOutcome;
    response: TraceValidationOutcome;
  };
  backend: null | {
    mode: "contract" | "scenario";
    name: string | null;
    outcome: "handled" | "domain_error" | "crashed" | "timeout" | "skipped";
    duration_ms: number;
    response_provenance: "fixture" | "behavior" | "example" | "generated";
    effects: string[];
    observations: JsonObject;
  };
  response: null | {
    completed_at: string;
    status: number;
    headers: TraceHeader[];
    content_type: string | null;
    body: TraceBody;
  };
  state: null | {
    revision_before: number;
    revision_after: number;
    digest_before: string | null;
    digest_after: string | null;
    projections: { before: Json; after: Json };
  };
  idempotency: {
    status: "not_requested" | "stored" | "replayed" | "conflict" | "rejected";
    record_ref: string | null;
  };
  replay: {
    classification: "full" | "substitutable" | "unavailable";
    reason_code: string | null;
  };
  error: TraceError | null;
  duration_ms: number;
  resource_usage: null | {
    request_bytes: number;
    response_bytes: number;
  };
  extensions: JsonObject;
}

export interface TraceValidationOutcome {
  status: "valid" | "invalid" | "not_evaluated";
  violations: Array<{
    pointer: string;
    code: string;
    message: string;
  }>;
}

/** Append-only line sink. Each line flushes (section 25.4). */
export class JsonlSink {
  private readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<JsonlSink> {
    await mkdir(dirname(path), { recursive: true });
    return new JsonlSink(path);
  }

  async append(line: string): Promise<void> {
    await appendFile(this.path, `${line}\n`, "utf8");
  }

  async appendJson(value: Json): Promise<void> {
    await this.append(canonicalJson(value));
  }
}

/**
 * Allocates event ids and sequences at ingress and flushes completed
 * records in strict sequence order. Out-of-order completions buffer
 * until every prior record has been appended, and completions serialize
 * on one promise chain so concurrent writers commit in submission
 * order. A record leaves the buffer only after its append succeeds,
 * so a failed drain leaves it for the next completion to retry.
 */
export class EventStream {
  private nextSequence = 1;
  private readonly pending = new Map<number, Json>();
  private writeUpTo = 1;
  private tail: Promise<void> = Promise.resolve();

  private readonly sink: JsonlSink;
  private readonly idPrefix: string;

  private constructor(sink: JsonlSink, idPrefix: string) {
    this.sink = sink;
    this.idPrefix = idPrefix;
  }

  static open(
    sink: JsonlSink,
    idPrefix: string,
    nextSequence = 1
  ): EventStream {
    const stream = new EventStream(sink, idPrefix);
    stream.nextSequence = nextSequence;
    stream.writeUpTo = nextSequence;
    return stream;
  }

  /** Reserve the next sequence at ingress time. */
  reserve(): { sequence: number; event_id: string } {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return { sequence, event_id: sequenceId(this.idPrefix, sequence) };
  }

  /**
   * Complete a reserved record; flushes everything now in order. Each
   * call waits for the previous one, so records reach the file in the
   * order completions were submitted, whatever the scheduling of the
   * underlying writes.
   */
  async complete(event: Json & { sequence: number }): Promise<void> {
    const run = this.tail.then(() => this.flushContiguous(event));
    // A failed write must not poison later completions; the caller
    // still observes the error from its own promise.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    await run;
  }

  private async flushContiguous(
    event: Json & { sequence: number }
  ): Promise<void> {
    this.pending.set(event.sequence, event);
    while (this.pending.has(this.writeUpTo)) {
      const ready = this.pending.get(this.writeUpTo);
      if (ready === undefined) {
        break;
      }
      // Append before dropping: a failed append leaves the record
      // buffered at writeUpTo, so the next completion retries it and
      // a record whose own complete() already resolved is never lost.
      await this.sink.appendJson(ready);
      this.pending.delete(this.writeUpTo);
      this.writeUpTo += 1;
    }
  }

  /** Number of buffered records waiting for an earlier sequence. */
  get buffered(): number {
    return this.pending.size;
  }
}

export interface BodyCaptureLimits {
  /** Redacted JSON bodies beyond this many bytes are truncated flags. */
  maxJsonBytes: number;
  /** Bounded redacted text preview length. */
  maxTextPreviewBytes: number;
  /** Store binary bodies as content-addressed blobs when true. */
  captureBlobs: boolean;
}

export interface BlobPutTarget {
  put(bytes: Uint8Array): Promise<{ digest: string }>;
}

export interface CaptureBodyInput {
  bytes: Uint8Array;
  contentType: string | null;
  redactor: Redactor;
  blobs: BlobPutTarget | null;
  limits: BodyCaptureLimits;
}

/**
 * Capture one request or response body as the single applicable
 * variant from section 25.3. Digests are dropped when the content
 * could reveal equality of a registered secret.
 */
export async function captureBody(input: CaptureBodyInput): Promise<TraceBody> {
  const { bytes, contentType, redactor, limits } = input;
  if (bytes.length === 0) {
    return { kind: "none" };
  }
  const mediaType = contentType === null ? "" : mediaBaseType(contentType);
  const decoder = new TextDecoder();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const text = decoder.decode(bytes);
    const parsed: unknown = JSON.parse(text);
    const redacted = redactor.redactJson(parsed as Json);
    return {
      kind: "json",
      size_bytes: bytes.length,
      value: redacted,
      truncated: bytes.length > limits.maxJsonBytes
    };
  }
  if (mediaType.startsWith("multipart/")) {
    return captureMultipart(input, contentType ?? "");
  }
  const textual =
    mediaType.startsWith("text/") ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml");
  const digestOrNull = redactor.containsSecret(decoder.decode(bytes))
    ? null
    : sha256HexBytes(bytes);
  if (textual) {
    const decoded = redactor.redactText(decoder.decode(bytes));
    const truncated = decoded.length > limits.maxTextPreviewBytes;
    return {
      kind: "text",
      size_bytes: bytes.length,
      sha256: digestOrNull,
      text: decoded.slice(0, limits.maxTextPreviewBytes),
      truncated
    };
  }
  let blob_ref: string | null = null;
  if (input.blobs !== null && limits.captureBlobs && digestOrNull !== null) {
    await input.blobs.put(bytes);
    blob_ref = `blobs/sha256/${digestOrNull}`;
  }
  return {
    kind: "binary",
    size_bytes: bytes.length,
    sha256: digestOrNull,
    blob_ref
  };
}

function captureMultipart(
  input: CaptureBodyInput,
  mediaType: string
): TraceBody {
  const boundary = boundaryOf(mediaType);
  if (boundary === null) {
    return binaryFallback(input);
  }
  const text = new TextDecoder().decode(input.bytes);
  const frames = text.split(`--${boundary}`);
  const parts: Array<{
    name: string;
    filename: string | null;
    headers: TraceHeader[];
    body: TraceBody;
  }> = [];
  for (const frame of frames) {
    const trimmed = frame.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (trimmed.length === 0 || trimmed === "--") {
      continue;
    }
    const divider = trimmed.indexOf("\r\n\r\n");
    const headerBlock = divider === -1 ? trimmed : trimmed.slice(0, divider);
    const bodyText = divider === -1 ? "" : trimmed.slice(divider + 4);
    const headers: TraceHeader[] = [];
    let name = "part";
    let filename: string | null = null;
    for (const line of headerBlock.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const headerName = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (headerName === "content-disposition") {
        name = dispositionValue(value, "name") ?? "part";
        filename = dispositionValue(value, "filename");
        continue;
      }
      const redacted = input.redactor.isSensitiveKey(headerName);
      headers.push({
        name: headerName,
        values: [redacted ? "[REDACTED]" : value],
        redacted
      });
    }
    const encoded = new TextEncoder().encode(bodyText);
    parts.push({
      name,
      filename,
      headers,
      body: {
        kind: "text",
        size_bytes: encoded.length,
        sha256: input.redactor.containsSecret(bodyText)
          ? null
          : createHash("sha256").update(encoded).digest("hex"),
        text: input.redactor
          .redactText(bodyText)
          .slice(0, input.limits.maxTextPreviewBytes),
        truncated: bodyText.length > input.limits.maxTextPreviewBytes
      }
    });
  }
  return { kind: "multipart", size_bytes: input.bytes.length, parts };
}

function binaryFallback(input: CaptureBodyInput): TraceBody {
  const digestOrNull = input.redactor.containsSecret(
    new TextDecoder().decode(input.bytes)
  )
    ? null
    : sha256HexBytes(input.bytes);
  return {
    kind: "binary",
    size_bytes: input.bytes.length,
    sha256: digestOrNull,
    blob_ref: null
  };
}

/** The media type without parameters, lowercased. */
function mediaBaseType(contentType: string): string {
  const base = contentType.split(";")[0] ?? "";
  return base.trim().toLowerCase();
}

function boundaryOf(contentType: string): string | null {
  const parameter = contentType
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("boundary="));
  if (parameter === undefined) {
    return null;
  }
  return parameter.slice("boundary=".length).replace(/^"|"$/g, "") || null;
}

function dispositionValue(header: string, field: string): string | null {
  const marker = `${field}=`;
  const token = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(marker));
  if (token === undefined) {
    return null;
  }
  return token.slice(marker.length).replace(/^"|"$/g, "") || null;
}

/**
 * Redact one path target: sensitive segments become stable
 * fingerprints; the raw target is never retained (section 25.4).
 */
export function redactPath(path: string, redactor: Redactor): string {
  return path
    .split("/")
    .map((segment) =>
      segment.length > 0 && redactor.containsSecret(segment)
        ? redactor.redactPathValue(segment)
        : segment
    )
    .join("/");
}

/** Build trace header records with lowercase names and wire order. */
export function traceHeaders(
  headers: Iterable<[string, string[]]>,
  redactor: Redactor
): TraceHeader[] {
  const records: TraceHeader[] = [];
  for (const [name, values] of headers) {
    const sensitiveName = redactor.isSensitiveKey(name);
    const safeValues = sensitiveName
      ? values.map(() => "[REDACTED]")
      : values.map((value) => redactor.redactHeaderValue(name, value));
    records.push({
      name: name.toLowerCase(),
      values: safeValues,
      redacted:
        sensitiveName ||
        safeValues.some((value, index) => value !== values[index])
    });
  }
  return records;
}

/** Validate that a decoded query record set stays an ordered array. */
export function traceQuery(
  query: Iterable<[string, string[]]>,
  redactor: Redactor
): TraceQueryParameter[] {
  const records: TraceQueryParameter[] = [];
  for (const [name, values] of query) {
    records.push({
      name,
      values: values.map((value) => redactor.redactQueryValue(name, value))
    });
  }
  return records;
}

/** Typed guard for JSON objects used in trace building. */
export function asJsonObject(value: Json): JsonObject {
  return isJsonObject(value) ? value : {};
}
