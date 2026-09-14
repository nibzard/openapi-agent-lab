/**
 * `oal trace import <har> --contract <spec>`. Normalize one Chrome HAR
 * 1.2 recording into the trace schema of a serve session: one
 * api.exchange event per entry, matched against the compiled contract,
 * with request and response validation recorded. Sensitive header and
 * credential values are redacted before anything is written; header
 * names and presence survive, values never do (section 30). Every
 * sensitive header value joins the run secret registry, so a value
 * repeated in a body, a query string, or a path is scrubbed there too.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_OK,
  EXIT_UNSUPPORTED,
  canonicalJson,
  diagnostic,
  formatRfc3339,
  invalidInput,
  isCredentialKey,
  isSafeId,
  sequenceId,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import {
  Redactor,
  captureBody,
  redactPath,
  traceHeaders,
  traceQuery,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import {
  createContractSchemaLookup,
  findResponseForStatus,
  matchRoute,
  validateBody,
  validateParameters,
  validateResponse,
  type SelectedResponse
} from "@oal/gateway";
import type { OperationIR } from "@oal/contract-ir";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { resolveSourceArgument } from "../source.ts";
import {
  missingArgument,
  missingOptionValue,
  tooManyArguments
} from "../usage.ts";
import { compileServeSource } from "./serve.ts";

/** Stable diagnostic codes of the trace import command. */
export const TraceImportCliCode = {
  HarInvalid: "OAL-TRACE-IMPORT-HAR-INVALID",
  RunIdUnsafe: "OAL-TRACE-IMPORT-RUN-ID-UNSAFE",
  TargetStale: "OAL-TRACE-IMPORT-TARGET-STALE",
  RouteUnmatched: "OAL-TRACE-IMPORT-ROUTE-UNMATCHED",
  MethodNotAllowed: "OAL-TRACE-IMPORT-METHOD-NOT-ALLOWED",
  RequestInvalid: "OAL-TRACE-IMPORT-REQUEST-INVALID",
  ResponseInvalid: "OAL-TRACE-IMPORT-RESPONSE-INVALID",
  ResponseAbsent: "OAL-TRACE-IMPORT-RESPONSE-ABSENT",
  EntriesTruncated: "OAL-TRACE-IMPORT-ENTRIES-TRUNCATED"
} as const;

/** Body capture limits of one import; no blob store backs it. */
const CAPTURE_LIMITS = {
  maxJsonBytes: 1_048_576,
  maxTextPreviewBytes: 4_096,
  captureBlobs: false
} as const;

/** Length of the HAR digest prefix that names the imported run. */
const RUN_ID_DIGEST_LENGTH = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Group HAR header lines by lowercase name, keeping first-seen order. */
function groupHarHeaders(value: unknown): Array<[string, string[]]> {
  const list = Array.isArray(value) ? value : [];
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const raw of list) {
    const record = asRecord(raw);
    const name = record === null ? null : asString(record["name"]);
    if (name === null) {
      continue;
    }
    const valueText = record === null ? "" : (asString(record["value"]) ?? "");
    const key = name.toLowerCase();
    const values = grouped.get(key);
    if (values === undefined) {
      order.push(key);
      grouped.set(key, [valueText]);
    } else {
      values.push(valueText);
    }
  }
  return order.map((name) => [name, grouped.get(name) ?? []]);
}

/** Group HAR queryString pairs by name, keeping first-seen order. */
function groupHarQuery(value: unknown): Array<[string, string[]]> {
  const list = Array.isArray(value) ? value : [];
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const raw of list) {
    const record = asRecord(raw);
    const name = record === null ? null : asString(record["name"]);
    if (name === null) {
      continue;
    }
    const valueText = record === null ? "" : (asString(record["value"]) ?? "");
    const values = grouped.get(name);
    if (values === undefined) {
      order.push(name);
      grouped.set(name, [valueText]);
    } else {
      values.push(valueText);
    }
  }
  return order.map((name) => [name, grouped.get(name) ?? []]);
}

/** One normalized HAR exchange plus the findings it produced. */
interface ImportedExchange {
  readonly event: TraceEvent;
  readonly matched: boolean;
}

/** Shared state of one import: the contract, redactor, and identity. */
interface ImportState {
  readonly runId: string;
  readonly operations: readonly OperationIR[];
  readonly schemaLookup: (ref: string) => Json | undefined;
  readonly redactor: Redactor;
  /** Lowercase header names the contract and section 30.3 flag. */
  readonly sensitiveHeaderNames: readonly string[];
}

/**
 * Capture one HAR body under the recorder discipline (section 25.3).
 * A body the JSON parser refuses still records as text, because the
 * recording, not the contract, is the source here. An encoding of
 * "base64" is decoded first, so digests and sizes describe the payload
 * bytes, never the encoding text.
 */
async function captureHarBody(
  redactor: Redactor,
  text: string | null,
  contentType: string | null,
  encoding: string | null
): Promise<TraceBody> {
  if (text === null || text.length === 0) {
    return { kind: "none" };
  }
  const bytes =
    encoding === "base64"
      ? Buffer.from(text, "base64")
      : new TextEncoder().encode(text);
  try {
    return await captureBody({
      bytes,
      contentType,
      redactor,
      blobs: null,
      limits: CAPTURE_LIMITS
    });
  } catch {
    return await captureBody({
      bytes,
      contentType: "text/plain",
      redactor,
      blobs: null,
      limits: CAPTURE_LIMITS
    });
  }
}

/** The media type of a Content-Type, lowercased and without parameters. */
function baseMediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Parse one JSON body for response validation; undefined when not JSON. */
function parseJsonBody(
  text: string | null,
  contentType: string | null
): Json | undefined {
  if (text === null || text.length === 0) {
    return undefined;
  }
  const base = baseMediaTypeOf(contentType);
  if (base !== "application/json" && !base.endsWith("+json")) {
    return undefined;
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/**
 * The body value request validation sees. A JSON media type parses, and
 * text the parser refuses still counts as a present body. Every other
 * body passes as text, so validation names an undeclared media type and
 * never reports a present body as missing.
 */
function requestBodyValueOf(
  text: string | null,
  contentType: string | null
): Json | undefined {
  if (text === null || text.length === 0) {
    return undefined;
  }
  return parseJsonBody(text, contentType) ?? text;
}

/**
 * Normalize one HAR entry into an api.exchange event. The event mirrors
 * the recorder: names and presence of headers survive, sensitive values
 * become [REDACTED] or a fingerprint, and paths lose secret segments.
 */
async function importHarEntry(
  state: ImportState,
  raw: Record<string, unknown>,
  sequence: number
): Promise<ImportedExchange> {
  const request = asRecord(raw["request"]);
  const response = asRecord(raw["response"]);
  if (request === null) {
    throw invalidInput(
      TraceImportCliCode.HarInvalid,
      `HAR entry ${sequence} holds no request object.`
    );
  }
  const method = (asString(request["method"]) ?? "GET").toUpperCase();
  const urlText = asString(request["url"]) ?? "/";
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw invalidInput(
      TraceImportCliCode.HarInvalid,
      `HAR entry ${sequence} holds the unparseable url "${urlText}".`
    );
  }
  const rawPath = url.pathname;
  const startedMsRaw = Date.parse(asString(raw["startedDateTime"]) ?? "");
  const startedMs = Number.isFinite(startedMsRaw) ? startedMsRaw : 0;
  const timeRaw = raw["time"];
  const durationMs =
    typeof timeRaw === "number" && Number.isFinite(timeRaw)
      ? Math.max(0, Math.round(timeRaw))
      : 0;
  const route = matchRoute(state.operations, method, rawPath);
  const operation = route.match?.operation ?? null;
  const headerPairs = groupHarHeaders(request["headers"]);
  const queryPairs = groupHarQuery(request["queryString"]);
  const redactedQuery = traceQuery(queryPairs, state.redactor);
  const redactedQueryString = new URLSearchParams();
  for (const parameter of redactedQuery) {
    for (const value of parameter.values) {
      redactedQueryString.append(parameter.name, value);
    }
  }
  const postData = asRecord(request["postData"]);
  const requestContentType =
    postData === null ? null : asString(postData["mimeType"]);
  const requestText = postData === null ? null : asString(postData["text"]);
  const requestEncoding =
    postData === null ? null : asString(postData["encoding"]);
  const headerNames = new Set(headerPairs.map(([name]) => name));
  const credentialPresent =
    headerNames.has("authorization") ||
    state.sensitiveHeaderNames.some((name) => headerNames.has(name));
  const requestJson = requestBodyValueOf(requestText, requestContentType);
  const rawStatus =
    response === null || typeof response["status"] !== "number"
      ? null
      : response["status"];
  // Chrome writes status 0 for failed requests (net::ERR_*). The trace
  // schema accepts 100 through 599 only, so such an exchange keeps a
  // null response instead of a status no consumer can read.
  const status =
    rawStatus !== null && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : null;
  const responseContent =
    response === null ? null : asRecord(response["content"]);
  const responseText =
    responseContent === null ? null : (asString(responseContent["text"]) ?? "");
  const responseContentType =
    responseContent === null ? null : asString(responseContent["mimeType"]);
  const responseEncoding =
    responseContent === null ? null : asString(responseContent["encoding"]);
  const responseJson = parseJsonBody(responseText, responseContentType);

  const requestViolations =
    operation === null
      ? []
      : [
          ...validateParameters(
            operation,
            {
              pathParameters: route.match?.pathParameters ?? {},
              query: queryRecordOf(queryPairs),
              headers: headerRecordOf(headerPairs),
              cookies: cookieRecordOf(request["cookies"]),
              body: requestJson,
              contentType: requestContentType
            },
            state.schemaLookup
          ).violations,
          ...validateBody(
            operation,
            {
              pathParameters: route.match?.pathParameters ?? {},
              query: queryRecordOf(queryPairs),
              headers: headerRecordOf(headerPairs),
              cookies: cookieRecordOf(request["cookies"]),
              body: requestJson,
              contentType: requestContentType
            },
            state.schemaLookup
          ).violations
        ];
  const responseViolations =
    operation === null || status === null
      ? []
      : validateResponse(
          operation.responses,
          {
            status,
            response: findResponseForStatus(operation.responses, status),
            mediaType:
              responseContentType === null
                ? null
                : (responseContentType.split(";")[0]?.trim().toLowerCase() ??
                  responseContentType),
            headers: headerRecordOf(groupHarHeaders(response?.["headers"])),
            body: responseJson,
            provenance: "external",
            approximation: null
          } satisfies SelectedResponse,
          state.schemaLookup
        ).violations;

  const event: TraceEvent = {
    schema_version: 1,
    type: "api.exchange",
    event_id: sequenceId("evt", sequence),
    sequence,
    participant_ingress_sequence: sequence,
    observed_at: formatRfc3339(startedMs),
    logical_time: null,
    batch_id: null,
    run_id: state.runId,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: operation !== null,
      key: operation?.key ?? null,
      uid: operation?.uid ?? null,
      operation_id: operation?.operation_id ?? null,
      method,
      path_template: operation?.path_template ?? rawPath,
      support: operation === null ? "unsupported" : operation.support.level
    },
    request: {
      received_at: formatRfc3339(startedMs),
      method,
      path: redactPath(rawPath, state.redactor),
      query_string: redactedQueryString.toString(),
      query: redactedQuery,
      path_parameters: Object.fromEntries(
        Object.entries(route.match?.pathParameters ?? {}).map(
          ([name, value]) => [
            name,
            state.redactor.isSensitiveKey(name) ||
            state.redactor.containsSecret(value)
              ? state.redactor.redactPathValue(value)
              : value
          ]
        )
      ),
      headers: traceHeaders(headerPairs, state.redactor),
      credential_present: credentialPresent,
      content_type: requestContentType,
      body: await captureHarBody(
        state.redactor,
        requestText,
        requestContentType,
        requestEncoding
      )
    },
    authentication: {
      status: credentialPresent ? "authenticated" : "unauthenticated",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: {
        status:
          operation === null
            ? "not_evaluated"
            : requestViolations.length > 0
              ? "invalid"
              : "valid",
        violations: requestViolations.map((violation) => ({
          pointer: violationPointerOf(violation.location, violation.pointer),
          code: violation.code,
          message: violation.message
        }))
      },
      response: {
        status:
          operation === null || status === null
            ? "not_evaluated"
            : responseViolations.length > 0
              ? "invalid"
              : "valid",
        violations: responseViolations.map((violation) => ({
          pointer: violationPointerOf(violation.location, violation.pointer),
          code: violation.code,
          message: violation.message
        }))
      }
    },
    backend: null,
    response:
      status === null
        ? null
        : {
            completed_at: formatRfc3339(startedMs + durationMs),
            status,
            headers: traceHeaders(
              groupHarHeaders(response?.["headers"]),
              state.redactor
            ),
            content_type: responseContentType,
            body: await captureHarBody(
              state.redactor,
              responseText,
              responseContentType,
              responseEncoding
            )
          },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: errorOf(
      route.pathExists,
      operation,
      status,
      requestViolations,
      requestContentType
    ),
    duration_ms: durationMs,
    resource_usage: {
      request_bytes:
        requestText === null ? 0 : Buffer.byteLength(requestText, "utf8"),
      response_bytes:
        responseText === null ? 0 : Buffer.byteLength(responseText, "utf8")
    },
    extensions: { origin: "har" }
  };
  return { event, matched: operation !== null };
}

/**
 * Collect the values of sensitive-named headers from both sides of
 * every imported entry (section 30.3). A name counts when the contract
 * flags it or when the canonical credential-key pattern does. The
 * values feed the Redactor secret registry and nothing else: they are
 * never returned, printed, or written by the caller.
 */
function collectHarSecrets(
  entries: readonly unknown[],
  sensitiveNames: ReadonlySet<string>
): string[] {
  const secrets = new Set<string>();
  for (const raw of entries) {
    const entry = asRecord(raw);
    const request = entry === null ? null : asRecord(entry["request"]);
    const response = entry === null ? null : asRecord(entry["response"]);
    for (const side of [request, response]) {
      if (side === null) {
        continue;
      }
      for (const [name, values] of groupHarHeaders(side["headers"])) {
        if (!sensitiveNames.has(name) && !isCredentialKey(name)) {
          continue;
        }
        for (const value of values) {
          if (value.length > 0) {
            secrets.add(value);
          }
        }
      }
    }
  }
  return [...secrets];
}

/** Join grouped pairs into the single-value record validation reads. */
function queryRecordOf(
  pairs: ReadonlyArray<readonly [string, string[]]>
): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const [name, values] of pairs) {
    record[name] = values.length === 1 ? (values[0] ?? "") : [...values];
  }
  return record;
}

/** First value of each grouped header, as Node serves them. */
function headerRecordOf(
  pairs: ReadonlyArray<readonly [string, string[]]>
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, values] of pairs) {
    record[name] = values.join(", ");
  }
  return record;
}

/** HAR cookie lines as the name-to-value record validation reads. */
function cookieRecordOf(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  const list = Array.isArray(value) ? value : [];
  for (const raw of list) {
    const item = asRecord(raw);
    const name = item === null ? null : asString(item["name"]);
    if (name !== null) {
      record[name] = item === null ? "" : (asString(item["value"]) ?? "");
    }
  }
  return record;
}

/**
 * Prefix a validation pointer with its location, body pointers as-is.
 * The validators name a whole-body violation with the empty pointer,
 * which the trace schema refuses, so it becomes the root pointer "/".
 */
function violationPointerOf(location: string, pointer: string): string {
  if (pointer.length === 0) {
    return "/";
  }
  return location === "body" || pointer.startsWith("/")
    ? pointer
    : `/${pointer}`;
}

/**
 * The error record of one imported exchange. An unmatched route keeps
 * the gateway routing codes so friction reads it; a request the
 * declared schema rejects, which the recorded service also refused,
 * keeps request_schema_invalid for the same reason. A body whose media
 * type the operation does not declare keeps media_type_unsupported,
 * the code the media-type friction detector keys on, whatever the
 * recorded service answered: the gap is in the spec, not the recording.
 */
function errorOf(
  pathExists: boolean,
  operation: OperationIR | null,
  status: number | null,
  requestViolations: ReadonlyArray<{ pointer: string; code: string }>,
  contentType: string | null
): TraceEvent["error"] {
  if (operation === null) {
    return pathExists
      ? {
          layer: "routing",
          code: "method_not_allowed",
          message: "The path exists, but not for this method.",
          retryable: false,
          details: {}
        }
      : {
          layer: "routing",
          code: "route_not_found",
          message: "No declared route matches the recorded request.",
          retryable: false,
          details: {}
        };
  }
  if (
    requestViolations.some(
      (violation) => violation.code === "media_type_unsupported"
    )
  ) {
    return {
      layer: "validation",
      code: "media_type_unsupported",
      message:
        "The recorded request body carried a media type the operation " +
        "does not declare.",
      retryable: false,
      details: contentType === null ? {} : { content_type: contentType }
    };
  }
  if (requestViolations.length > 0 && status !== null && status >= 400) {
    return {
      layer: "validation",
      code: "request_schema_invalid",
      message: "The recorded request violates the declared request schema.",
      retryable: false,
      details: { first_pointer: requestViolations[0]?.pointer ?? "" }
    };
  }
  return null;
}

/** `oal trace import <har> --contract <spec>`. */
export const traceImportCommand: CommandHandler = async (args, io) => {
  const harArg = args.positionals[0];
  if (harArg === undefined) {
    throw missingArgument(args.command.name, "har");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const contractArg = args.flags.string("contract");
  if (contractArg === undefined) {
    throw missingOptionValue("--contract");
  }
  if (args.context.format === "html" || args.context.format === "markdown") {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "ingest",
        code: "OAL-TRACE-IMPORT-PROJECTION-UNSUPPORTED",
        message:
          "The trace import report renders as JSON or terminal only. Use " +
          "--format json or terminal."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  const resolvedHar = await resolveSourceArgument(harArg, {
    cwd: args.context.cwd,
    maxBytes: args.context.maxSourceBytes,
    ...(io.stdin === undefined ? {} : { stdin: io.stdin })
  });
  const harText = await readFile(resolvedHar.entrypoint, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(harText);
  } catch (error) {
    throw invalidInput(
      TraceImportCliCode.HarInvalid,
      `HAR ${resolvedHar.entrypoint} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`
    );
  }
  const log = asRecord(asRecord(parsed)?.["log"]);
  const entries = log === null ? [] : log["entries"];
  const entryList = Array.isArray(entries) ? entries : [];
  if (log === null || entryList.length === 0) {
    throw invalidInput(
      TraceImportCliCode.HarInvalid,
      `HAR ${resolvedHar.entrypoint} holds no log.entries, so no exchange can ` +
        "be imported."
    );
  }

  const compiled = await compileServeSource(
    contractArg,
    args.context.cwd,
    args.context.maxSourceBytes
  );
  const harDigest = sha256Hex(harText);
  const runIdFlag = args.flags.string("run-id");
  const runId =
    runIdFlag ?? `import-${harDigest.slice(0, RUN_ID_DIGEST_LENGTH)}`;
  if (!isSafeId(runId)) {
    throw invalidInput(
      TraceImportCliCode.RunIdUnsafe,
      `The run id "${runId}" is not a safe id.`
    );
  }
  const sessionDir =
    args.context.outPath ??
    path.join(args.context.cwd, ".oal", "sessions", runId);
  if ((await stat(sessionDir).catch(() => null)) !== null) {
    throw invalidInput(
      TraceImportCliCode.TargetStale,
      `Session target "${sessionDir}" already exists; the import writes a ` +
        "fresh directory only. Choose another --out path."
    );
  }

  // The redaction discipline of the recorder (section 30): the HMAC key
  // comes from the HAR digest, so one recording always redacts to the
  // same fingerprints, and apiKey wire names join the sensitive set.
  // Every name is stored lowercase, the way HAR headers are grouped.
  const sensitiveHeaderNames = new Set(["authorization"]);
  for (const scheme of Object.values(compiled.contract.security_schemes)) {
    if (
      scheme.type === "apiKey" &&
      scheme.location === "header" &&
      scheme.wire_name !== null
    ) {
      sensitiveHeaderNames.add(scheme.wire_name.toLowerCase());
    }
  }
  const bounded = entryList.slice(0, LIMIT_DEFAULTS.maxRequestsPerRun);
  // Section 30.3: every value a sensitive header name carries, on both
  // sides of every imported entry, joins the run secret registry. The
  // registry exists only as Redactor input; the import never prints,
  // logs, or writes a collected value anywhere else.
  const harSecrets = collectHarSecrets(bounded, sensitiveHeaderNames);
  const state: ImportState = {
    runId,
    operations: compiled.contract.operations,
    schemaLookup: createContractSchemaLookup(compiled.contract.schemas),
    redactor: new Redactor({
      hmacKey: Buffer.from(`trace-import:${harDigest}`, "utf8"),
      secrets: harSecrets,
      config: { sensitiveHeaderNames: [...sensitiveHeaderNames] }
    }),
    sensitiveHeaderNames: [...sensitiveHeaderNames]
  };

  const findings: Diagnostic[] = [];
  if (bounded.length < entryList.length) {
    findings.push(
      diagnostic({
        severity: "warning",
        phase: "ingest",
        code: TraceImportCliCode.EntriesTruncated,
        message:
          `The HAR holds ${entryList.length.toString(10)} entries; the import ` +
          `kept the first ${bounded.length.toString(10)} under the run limit.`
      })
    );
  }
  const imported: ImportedExchange[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const raw = asRecord(bounded[index]);
    if (raw === null) {
      throw invalidInput(
        TraceImportCliCode.HarInvalid,
        `HAR entry ${(index + 1).toString(10)} is not an object.`
      );
    }
    const exchange = await importHarEntry(state, raw, index + 1);
    imported.push(exchange);
    const where = `${exchange.event.request?.method ?? "GET"} ${
      exchange.event.request?.path ?? "/"
    }`;
    if (exchange.event.error?.code === "route_not_found") {
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "ingest",
          code: TraceImportCliCode.RouteUnmatched,
          message: `${where} matches no route the contract declares.`
        })
      );
    } else if (exchange.event.error?.code === "method_not_allowed") {
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "ingest",
          code: TraceImportCliCode.MethodNotAllowed,
          message: `${where} exists with other methods only.`
        })
      );
    }
    if (exchange.event.response === null) {
      // Chrome writes status 0 for a failed request, and a response
      // object can be absent or hold no usable status at all.
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "ingest",
          code: TraceImportCliCode.ResponseAbsent,
          message:
            `${where} recorded no usable response status; the import ` +
            "wrote the exchange without a response."
        })
      );
    }
    const requestInvalid =
      exchange.event.validation.request.status === "invalid";
    if (requestInvalid) {
      const first = exchange.event.validation.request.violations[0];
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "ingest",
          code: TraceImportCliCode.RequestInvalid,
          message:
            `${where} violates the declared request schema` +
            (first === undefined
              ? "."
              : `; first ${first.pointer}: ${first.message}.`)
        })
      );
    }
    if (exchange.event.validation.response.status === "invalid") {
      const first = exchange.event.validation.response.violations[0];
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "ingest",
          code: TraceImportCliCode.ResponseInvalid,
          message:
            `The recorded response of ${where} violates the declared schema` +
            (first === undefined
              ? "."
              : `; first ${first.pointer}: ${first.message}.`)
        })
      );
    }
  }

  await mkdir(sessionDir, { recursive: true });
  const traceLines = imported.map((exchange) =>
    canonicalJson(exchange.event as unknown as Json)
  );
  await writeFile(
    path.join(sessionDir, "trace.jsonl"),
    `${traceLines.join("\n")}\n`
  );
  await writeFile(
    path.join(sessionDir, "capability-report.json"),
    `${stableJsonStringify(compiled.capabilityReport)}\n`
  );
  emitDiagnostics(io, args.context, findings);

  const matched = imported.filter((exchange) => exchange.matched).length;
  const summary: JsonObject = {
    schema_version: 1,
    kind: "TraceImportReport",
    run_id: runId,
    session_dir: sessionDir,
    entries: imported.length,
    matched,
    diagnostics: findings as unknown as Json
  };
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(summary));
  } else {
    io.stdout(`trace import: run ${runId}`);
    io.stdout(`session: ${sessionDir}`);
    io.stdout(
      `entries: ${imported.length.toString(10)} matched: ${matched.toString(10)} ` +
        `unmatched: ${(imported.length - matched).toString(10)}`
    );
    io.stdout(`diagnostics: ${findings.length.toString(10)} finding(s)`);
  }
  // Findings are the product: a session with violations imported well.
  return EXIT_OK;
};
