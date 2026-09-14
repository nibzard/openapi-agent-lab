/**
 * `oal trace import <har> --contract <spec>`. Normalize one Chrome HAR
 * 1.2 recording into the trace schema of a serve session: one
 * api.exchange event per entry, matched against the compiled contract,
 * with request and response validation recorded. Sensitive header and
 * credential values are redacted before anything is written; header
 * names and presence survive, values never do (section 30).
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
}

/**
 * Capture one HAR body under the recorder discipline (section 25.3).
 * A body the JSON parser refuses still records as text, because the
 * recording, not the contract, is the source here.
 */
async function captureHarBody(
  redactor: Redactor,
  text: string | null,
  contentType: string | null
): Promise<TraceBody> {
  if (text === null || text.length === 0) {
    return { kind: "none" };
  }
  const bytes = new TextEncoder().encode(text);
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

/** Parse one JSON body for validation; null when it is not JSON. */
function parseJsonBody(
  text: string | null,
  contentType: string | null
): Json | undefined {
  if (text === null || text.length === 0) {
    return undefined;
  }
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
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
  const headerNames = new Set(headerPairs.map(([name]) => name));
  const credentialPresent = headerNames.has("authorization");
  const requestJson = parseJsonBody(requestText, requestContentType);
  const status =
    response === null
      ? null
      : typeof response["status"] === "number"
        ? response["status"]
        : null;
  const responseContent =
    response === null ? null : asRecord(response["content"]);
  const responseText =
    responseContent === null ? null : (asString(responseContent["text"]) ?? "");
  const responseContentType =
    responseContent === null ? null : asString(responseContent["mimeType"]);
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
        requestContentType
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
              responseContentType
            )
          },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: errorOf(route.pathExists, operation, status, requestViolations),
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

/** Prefix a validation pointer with its location, body pointers as-is. */
function violationPointerOf(location: string, pointer: string): string {
  return location === "body" || pointer.startsWith("/")
    ? pointer
    : `/${pointer}`;
}

/**
 * The error record of one imported exchange. An unmatched route keeps
 * the gateway routing codes so friction reads it; a request the
 * declared schema rejects, which the recorded service also refused,
 * keeps request_schema_invalid for the same reason.
 */
function errorOf(
  pathExists: boolean,
  operation: OperationIR | null,
  status: number | null,
  requestViolations: ReadonlyArray<{ pointer: string; code: string }>
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
    maxBytes: args.context.maxSourceBytes
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
  const sensitiveHeaderNames = new Set(["authorization"]);
  for (const scheme of Object.values(compiled.contract.security_schemes)) {
    if (
      scheme.type === "apiKey" &&
      scheme.location === "header" &&
      scheme.wire_name !== null
    ) {
      sensitiveHeaderNames.add(scheme.wire_name);
    }
  }
  const state: ImportState = {
    runId,
    operations: compiled.contract.operations,
    schemaLookup: createContractSchemaLookup(compiled.contract.schemas),
    redactor: new Redactor({
      hmacKey: Buffer.from(`trace-import:${harDigest}`, "utf8"),
      secrets: [],
      config: { sensitiveHeaderNames: [...sensitiveHeaderNames] }
    })
  };

  const findings: Diagnostic[] = [];
  const bounded = entryList.slice(0, LIMIT_DEFAULTS.maxRequestsPerRun);
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
