/**
 * `oal probe <run-or-batch> --base-url <url> --operations <op,op>`. Replay
 * the recorded requests of a run or batch against a live service and diff
 * every answer against the frozen contract (section 24.1 inputs). The mock
 * can only show that an agent used the contract; this command shows where
 * the live server left it: status codes the contract never declared, and
 * bodies its schemas refuse. Only operations the operator names replay,
 * and only safe methods unless --allow-writes opts in, so a probe can
 * never fire a stray write. The credential the operator names travels in
 * the header the contract's security scheme expects; its value joins the
 * run secret registry before anything is written (section 30), so an echo
 * in a body, a header, or a path is scrubbed before persistence.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_OK,
  EXIT_UNSUPPORTED,
  diagnostic,
  formatRfc3339,
  invalidInput,
  isSafeId,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import type { ContractIR, OperationIR } from "@oal/contract-ir";
import {
  Redactor,
  captureBody,
  traceHeaders,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import {
  createContractSchemaLookup,
  findResponseForStatus,
  matchRoute,
  validateResponse,
  type SelectedResponse
} from "@oal/gateway";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  missingOptionValue,
  tooManyArguments
} from "../usage.ts";
import { parseDurationMs } from "./run.ts";
import {
  batchRootOf,
  isSessionDir,
  loadRunOrBatch,
  trialsOf
} from "./run-tree.ts";

/** Stable diagnostic codes of the probe command. */
export const ProbeCliCode = {
  BaseUrlInvalid: "OAL-PROBE-BASE-URL-INVALID",
  CredentialEnvUnsafe: "OAL-PROBE-CREDENTIAL-ENV-UNSAFE",
  CredentialEnvUnset: "OAL-PROBE-CREDENTIAL-ENV-UNSET",
  TargetStale: "OAL-PROBE-TARGET-STALE",
  ContractMissing: "OAL-PROBE-CONTRACT-MISSING",
  ContractInvalid: "OAL-PROBE-CONTRACT-INVALID",
  ScopeUnsafe: "OAL-PROBE-SCOPE-UNSAFE",
  SessionUnsupported: "OAL-PROBE-SESSION-UNSUPPORTED",
  OperationUnknown: "OAL-PROBE-OPERATION-UNKNOWN",
  RequestsTruncated: "OAL-PROBE-REQUESTS-TRUNCATED",
  ResponseNonconformant: "OAL-PROBE-RESPONSE-NONCONFORMANT",
  RequestFailed: "OAL-PROBE-REQUEST-FAILED",
  BodyUnavailable: "OAL-PROBE-BODY-UNAVAILABLE",
  ProjectionUnsupported: "OAL-PROBE-PROJECTION-UNSUPPORTED"
} as const;

/** Methods that replay in the default read-only mode. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Frozen contract file of a batch, relative to the batch root. */
const CONTRACT_INPUT = "inputs/contract.ir.json";

/**
 * Per-request ceiling of one probe. The single-response bound of the
 * limit table (section 31.1) fits a replayed request best.
 */
const DEFAULT_TIMEOUT_MS = LIMIT_DEFAULTS.maxSseDurationMs;

/** Body capture limits of one probe; no blob store backs it. */
const CAPTURE_LIMITS = {
  maxJsonBytes: 1_048_576,
  maxTextPreviewBytes: 4_096,
  captureBlobs: false
} as const;

/** Environment names the credential flag accepts. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** One per-request row of the conformance document. */
export interface ConformanceResult {
  readonly trial_id: string;
  readonly sequence: number;
  readonly operation: string | null;
  readonly method: string;
  readonly path: string;
  readonly classification:
    | "conformant"
    | "undeclared_status"
    | "schema_violation"
    | "request_error"
    | "skipped";
  readonly status: number | null;
  readonly skip_reason:
    | "not_allowlisted"
    | "write_without_opt_in"
    | "operation_unmatched"
    | "body_unavailable"
    | "run_limit"
    | null;
  readonly error_code: "timeout" | "network" | null;
  readonly error_message: string | null;
  readonly violations: number;
}

/** One server-divergence finding of the conformance document. */
export interface ConformanceFinding {
  readonly id: string;
  readonly kind: "undeclared_status" | "schema_violation";
  readonly class: "spec_friction";
  readonly origin: "server";
  readonly operation: string | null;
  readonly trial_id: string;
  readonly sequence: number;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query_string: string;
  };
  readonly response: {
    readonly status: number;
    readonly media_type: string | null;
    readonly headers: ReturnType<typeof traceHeaders>;
    readonly body: TraceBody;
  };
  readonly violations: ReadonlyArray<{
    readonly location: string;
    readonly pointer: string;
    readonly code: string;
    readonly message: string;
  }>;
  readonly detail: string;
}

/** The conformance document of one probe (conformance.v1). */
export interface ConformanceDocument {
  readonly schema_version: 1;
  readonly kind: "ConformanceReport";
  readonly scope: { readonly level: "run" | "batch"; readonly id: string };
  readonly generated_at: string;
  readonly base_url: string;
  readonly contract: { readonly path: string; readonly sha256: string };
  readonly allowlist: readonly string[];
  readonly writes_allowed: boolean;
  readonly credential: {
    readonly environment: string;
    readonly header_names: readonly string[];
  } | null;
  readonly request_timeout_ms: number;
  readonly counts: {
    readonly requests: number;
    readonly replayed: number;
    readonly skipped: number;
    readonly conformant: number;
    readonly undeclared_status: number;
    readonly schema_violation: number;
    readonly request_error: number;
    readonly findings: number;
  };
  readonly results: readonly ConformanceResult[];
  readonly findings: readonly ConformanceFinding[];
  readonly extensions: JsonObject;
}

/** One recorded exchange the probe considers, with its matched route. */
interface CandidateRow {
  readonly trialId: string;
  readonly sequence: number;
  readonly event: TraceEvent;
  readonly operation: OperationIR | null;
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The media type of a Content-Type, lowercased and without parameters. */
function baseMediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Parse one JSON body for validation; undefined when not readable JSON. */
function parseJsonBody(
  text: string,
  contentType: string | null
): Json | undefined {
  if (text.length === 0) {
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
 * The body value response validation sees. A JSON media type parses, and
 * text the parser refuses still counts as a present body, so validation
 * can name the media type instead of a phantom missing body.
 */
function responseBodyValueOf(
  text: string,
  contentType: string | null
): Json | undefined {
  return (
    parseJsonBody(text, contentType) ?? (text.length > 0 ? text : undefined)
  );
}

/**
 * Capture one live body under the recorder discipline (section 25.3). A
 * JSON body the parser refuses, and a multipart body the document schema
 * keeps no room for, record as text: the bytes, not the parse, are the
 * evidence.
 */
async function captureLiveBody(
  redactor: Redactor,
  text: string,
  contentType: string | null
): Promise<TraceBody> {
  if (text.length === 0) {
    return { kind: "none" };
  }
  const bytes = new TextEncoder().encode(text);
  try {
    const captured = await captureBody({
      bytes,
      contentType,
      redactor,
      blobs: null,
      limits: CAPTURE_LIMITS
    });
    return captured.kind === "multipart"
      ? await captureBody({
          bytes,
          contentType: "text/plain",
          redactor,
          blobs: null,
          limits: CAPTURE_LIMITS
        })
      : captured;
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

/**
 * The header names the credential travels under: the authorization
 * header for http, oauth2, and openid schemes, and the wire name for an
 * apiKey in a header. A contract without schemes still gets the
 * authorization header, because the operator named a credential.
 */
function credentialHeaderNames(contract: ContractIR): string[] {
  const names = new Set<string>(["authorization"]);
  for (const scheme of Object.values(contract.security_schemes)) {
    if (
      scheme.type === "apiKey" &&
      scheme.location === "header" &&
      scheme.wire_name !== null
    ) {
      names.add(scheme.wire_name);
    }
  }
  return [...names];
}

/** The recorded request body of one write replay, when bytes survive. */
function replayBodyOf(
  event: TraceEvent
):
  | { readonly text: string; readonly contentType: string }
  | "unavailable"
  | null {
  const body = event.request?.body;
  const contentType = event.request?.content_type ?? null;
  if (body === undefined || body.kind === "none") {
    return null;
  }
  if (body.kind === "json") {
    return {
      text: stableJsonStringify(body.value),
      contentType: contentType ?? "application/json"
    };
  }
  if (body.kind === "text") {
    return {
      text: body.text,
      contentType: contentType ?? "text/plain"
    };
  }
  // A binary or multipart record keeps a digest only, never bytes.
  return "unavailable";
}

/**
 * Build the replay target: the recorded path and query under the live
 * base url, keeping any base path prefix. The recorded strings are
 * already redacted, so no secret travels in the target.
 */
function replayTarget(
  baseUrl: URL,
  recordedPath: string,
  query: string
): string {
  const url = new URL(baseUrl);
  const basePrefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePrefix}/${recordedPath.replace(/^\/+/, "")}`;
  if (query !== "") {
    url.search = url.search === "" ? query : `${url.search.slice(1)}&${query}`;
  }
  return url.toString();
}

/** Terminal projection of one conformance document. */
export function probeLines(report: ConformanceDocument): readonly string[] {
  const lines: string[] = [];
  lines.push(`probe: ${report.scope.level} ${report.scope.id}`);
  lines.push(`base url: ${report.base_url}`);
  lines.push(
    `requests: ${report.counts.requests.toString(10)} replayed: ` +
      `${report.counts.replayed.toString(10)} skipped: ` +
      `${report.counts.skipped.toString(10)} findings: ` +
      report.counts.findings.toString(10)
  );
  lines.push(
    "classifications: " +
      `conformant=${report.counts.conformant.toString(10)} ` +
      `undeclared_status=${report.counts.undeclared_status.toString(10)} ` +
      `schema_violation=${report.counts.schema_violation.toString(10)} ` +
      `request_error=${report.counts.request_error.toString(10)}`
  );
  for (const finding of report.findings) {
    lines.push(
      `finding: ${finding.kind} [${finding.class}/${finding.origin}] ` +
        `${finding.operation ?? "-"} status=${finding.response.status}`
    );
    lines.push(`  ${finding.detail}`);
  }
  return lines;
}

/** `oal probe <run-or-batch> --base-url <url> --operations <op,op>`. */
export const probeCommand: CommandHandler = async (args, io) => {
  const target = args.positionals[0];
  if (target === undefined) {
    throw missingArgument(args.command.name, "run-or-batch");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format === "html" || args.context.format === "markdown") {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "report",
        code: ProbeCliCode.ProjectionUnsupported,
        message:
          "The conformance document renders as JSON or terminal only. Use " +
          "--format json or terminal."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  const baseUrlRaw = args.flags.string("base-url");
  if (baseUrlRaw === undefined) {
    throw missingOptionValue("--base-url");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw invalidInput(
      ProbeCliCode.BaseUrlInvalid,
      `The base url "${baseUrlRaw}" does not parse as a url.`
    );
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw invalidInput(
      ProbeCliCode.BaseUrlInvalid,
      `The base url "${baseUrlRaw}" is not an http or https url.`
    );
  }

  const operationsRaw = args.flags.string("operations");
  if (operationsRaw === undefined) {
    throw missingOptionValue("--operations");
  }
  const allowlist = operationsRaw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (allowlist.length === 0) {
    throw invalidOptionValue(
      "--operations",
      operationsRaw,
      "a comma-separated list of operation ids or keys"
    );
  }
  const allowlistSet = new Set(allowlist);

  // Section 30: the credential value exists only as Redactor input and
  // as the outgoing header. It is never printed, logged, or written.
  const credentialEnv = args.flags.string("credential-env");
  let credential: string | null = null;
  if (credentialEnv !== undefined) {
    if (!ENV_NAME_PATTERN.test(credentialEnv)) {
      throw invalidInput(
        ProbeCliCode.CredentialEnvUnsafe,
        `The credential environment name "${credentialEnv}" is not a safe ` +
          "variable name."
      );
    }
    const value = process.env[credentialEnv];
    if (value === undefined || value.length === 0) {
      throw invalidInput(
        ProbeCliCode.CredentialEnvUnset,
        `The environment variable "${credentialEnv}" holds no credential, so ` +
          "no request can authenticate."
      );
    }
    credential = value;
  }

  const timeoutRaw = args.flags.string("timeout");
  let timeoutMs: number = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    const parsed = parseDurationMs(timeoutRaw);
    if (parsed === null || parsed <= 0) {
      throw invalidOptionValue(
        "--timeout",
        timeoutRaw,
        "a duration such as 5s or 500ms"
      );
    }
    timeoutMs = parsed;
  }
  const allowWrites = args.flags.has("allow-writes");

  const root = path.resolve(args.context.cwd, target);
  // A serve session holds no frozen contract, so response validation
  // would have no contract to validate against; the probe refuses it.
  if (await isSessionDir(root)) {
    throw invalidInput(
      ProbeCliCode.SessionUnsupported,
      `Directory "${root}" is a serve session, which holds no frozen ` +
        "contract. Point the probe at the run or batch directory that " +
        "recorded the requests."
    );
  }
  const subject = await loadRunOrBatch(root);
  const trials = trialsOf(subject);
  const firstTrial = trials[0];
  if (firstTrial === undefined) {
    throw invalidInput(
      ProbeCliCode.ContractMissing,
      `"${root}" holds no recorded trial, so no request can replay.`
    );
  }
  // The scope names what the operator pointed at: the run directory
  // itself, not the batch that owns it.
  const scope =
    subject.kind === "batch"
      ? { level: "batch" as const, id: subject.batch.batchId }
      : { level: "run" as const, id: firstTrial.runId };
  if (!isSafeId(scope.id)) {
    throw invalidInput(
      ProbeCliCode.ScopeUnsafe,
      `The recorded scope identifier "${scope.id}" is not a safe id.`
    );
  }

  const batchRoot =
    subject.kind === "batch"
      ? subject.batch.root
      : await batchRootOf(firstTrial.root);
  if (batchRoot === null) {
    throw invalidInput(
      ProbeCliCode.ContractMissing,
      `No batch inputs directory with ${CONTRACT_INPUT} sits above ` +
        `"${root}", so responses have no contract to validate against.`
    );
  }
  const contractFile = path.join(batchRoot, CONTRACT_INPUT);
  const contractText = await readFile(contractFile, "utf8").catch(() => null);
  if (contractText === null) {
    throw invalidInput(
      ProbeCliCode.ContractMissing,
      `Frozen contract ${contractFile} is missing.`
    );
  }
  let contractParsed: unknown;
  try {
    contractParsed = JSON.parse(contractText);
  } catch (error) {
    throw invalidInput(
      ProbeCliCode.ContractInvalid,
      `${contractFile} is not valid JSON: ${describeCause(error)}.`
    );
  }
  if (
    typeof contractParsed !== "object" ||
    contractParsed === null ||
    Array.isArray(contractParsed) ||
    (contractParsed as JsonObject)["kind"] !== "ContractIR" ||
    !Array.isArray((contractParsed as JsonObject)["operations"])
  ) {
    throw invalidInput(
      ProbeCliCode.ContractInvalid,
      `${contractFile} is not a ContractIR document.`
    );
  }
  const contract = contractParsed as unknown as ContractIR;

  const findings: Diagnostic[] = [];
  const knownOperations = new Set<string>();
  for (const operation of contract.operations) {
    if (operation.operation_id !== null) {
      knownOperations.add(operation.operation_id);
    }
    knownOperations.add(operation.key);
  }
  for (const name of allowlist) {
    if (!knownOperations.has(name)) {
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "preflight",
          code: ProbeCliCode.OperationUnknown,
          message:
            `The named operation "${name}" matches no operation id or key ` +
            "in the frozen contract."
        })
      );
    }
  }

  const outDir =
    args.context.outPath ??
    path.join(args.context.cwd, ".oal", "probe", scope.id);
  if ((await stat(outDir).catch(() => null)) !== null) {
    throw invalidInput(
      ProbeCliCode.TargetStale,
      `Probe target "${outDir}" already exists; the probe writes a fresh ` +
        "directory only. Choose another --out path."
    );
  }

  const credentialHeaders = credentialHeaderNames(contract);
  const redactor = new Redactor({
    hmacKey: Buffer.from(`probe:${sha256Hex(contractText)}`, "utf8"),
    secrets: credential === null ? [] : [credential],
    config: { sensitiveHeaderNames: [...credentialHeaders] }
  });
  const schemaLookup = createContractSchemaLookup(contract.schemas);

  // Every recorded exchange of every trial, in recorded order. The
  // trace type admits api.exchange events only, so no filter is needed.
  const candidates: CandidateRow[] = [];
  for (const trial of trials) {
    for (const event of trial.trace) {
      const method = event.request?.method ?? event.operation.method ?? "GET";
      const recordedPath = event.request?.path ?? "/";
      candidates.push({
        trialId: trial.runId,
        sequence: event.sequence,
        event,
        operation:
          matchRoute(contract.operations, method, recordedPath).match
            ?.operation ?? null
      });
    }
  }

  const results: ConformanceResult[] = [];
  const conformanceFindings: ConformanceFinding[] = [];
  let replayed = 0;
  let capped = 0;
  for (const candidate of candidates) {
    const method =
      candidate.event.request?.method ??
      candidate.event.operation.method ??
      "GET";
    const recordedPath = candidate.event.request?.path ?? "/";
    const query = candidate.event.request?.query_string ?? "";
    const where = `${method} ${recordedPath}`;
    const operationName =
      candidate.operation?.operation_id ?? candidate.operation?.key ?? null;

    const skip = (
      reason: NonNullable<ConformanceResult["skip_reason"]>
    ): void => {
      results.push({
        trial_id: candidate.trialId,
        sequence: candidate.sequence,
        operation: operationName,
        method,
        path: redactor.redactText(recordedPath),
        classification: "skipped",
        status: null,
        skip_reason: reason,
        error_code: null,
        error_message: null,
        violations: 0
      });
    };

    // The allowlist rule: a request replays only when the frozen
    // contract matches it to an operation the operator named, and only
    // when its method is safe or --allow-writes opted in. Everything
    // else records as skipped, and nothing is sent.
    if (candidate.operation === null) {
      skip("operation_unmatched");
      continue;
    }
    if (
      !allowlistSet.has(candidate.operation.operation_id ?? "") &&
      !allowlistSet.has(candidate.operation.key)
    ) {
      skip("not_allowlisted");
      continue;
    }
    if (!SAFE_METHODS.has(method) && !allowWrites) {
      skip("write_without_opt_in");
      continue;
    }
    if (replayed >= LIMIT_DEFAULTS.maxRequestsPerRun) {
      capped += 1;
      skip("run_limit");
      continue;
    }
    const body = replayBodyOf(candidate.event);
    if (body === "unavailable") {
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "run",
          code: ProbeCliCode.BodyUnavailable,
          message:
            `${where} records only a digest of its body, so the write ` +
            "cannot replay."
        })
      );
      skip("body_unavailable");
      continue;
    }

    replayed += 1;
    const headers: Record<string, string> = { accept: "application/json" };
    if (credential !== null) {
      for (const name of credentialHeaders) {
        headers[name] = credential;
      }
    }
    if (body !== null) {
      headers["content-type"] = body.contentType;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let row: ConformanceResult;
    let responseEvidence: ConformanceFinding["response"] | null = null;
    let violations: ConformanceFinding["violations"] = [];
    try {
      // A redirect stays manual: a 3xx compares as a status, and a 307
      // or 308 can never re-issue a write behind the operator's back.
      const response = await fetch(replayTarget(baseUrl, recordedPath, query), {
        method,
        headers,
        ...(body === null ? {} : { body: body.text }),
        redirect: "manual",
        signal: controller.signal
      });
      const text = await response.text();
      const contentType = response.headers.get("content-type");
      const headerPairs: Array<[string, string[]]> = [
        ...response.headers.entries()
      ].map(([name, value]) => [name, [value]]);
      const captured = await captureLiveBody(redactor, text, contentType);
      responseEvidence = {
        status: response.status,
        media_type: contentType === null ? null : baseMediaTypeOf(contentType),
        headers: traceHeaders(headerPairs, redactor),
        body: captured
      };
      const selected = {
        status: response.status,
        response: findResponseForStatus(
          candidate.operation.responses,
          response.status
        ),
        mediaType: contentType === null ? null : baseMediaTypeOf(contentType),
        headers: Object.fromEntries(
          headerPairs.map(([name, values]) => [name, values.join(", ")])
        ),
        body: responseBodyValueOf(text, contentType),
        provenance: "external",
        approximation: null
      } satisfies SelectedResponse;
      violations = validateResponse(
        candidate.operation.responses,
        selected,
        schemaLookup
      ).violations.map((violation) => ({
        location: violation.location,
        pointer: violation.pointer.length === 0 ? "/" : violation.pointer,
        code: violation.code,
        message: redactor.redactText(violation.message)
      }));
      const isUndeclared = violations.some(
        (violation) => violation.code === "status_undeclared"
      );
      const classification: ConformanceResult["classification"] =
        violations.length === 0
          ? "conformant"
          : isUndeclared
            ? "undeclared_status"
            : "schema_violation";
      row = {
        trial_id: candidate.trialId,
        sequence: candidate.sequence,
        operation: operationName,
        method,
        path: redactor.redactText(recordedPath),
        classification,
        status: response.status,
        skip_reason: null,
        error_code: null,
        error_message: null,
        violations: violations.length
      };
      if (classification !== "conformant") {
        const first = violations[0];
        conformanceFindings.push({
          id: `cf_${(conformanceFindings.length + 1).toString(10).padStart(4, "0")}`,
          kind: isUndeclared ? "undeclared_status" : "schema_violation",
          class: "spec_friction",
          origin: "server",
          operation: operationName,
          trial_id: candidate.trialId,
          sequence: candidate.sequence,
          request: {
            method,
            path: redactor.redactText(recordedPath),
            query_string: redactor.redactText(query)
          },
          response: responseEvidence,
          violations,
          detail: redactor.redactText(
            `${where} answered ${response.status.toString(10)}` +
              (first === undefined
                ? "."
                : `, which the contract refuses; first ${first.pointer}: ${first.message}`)
          )
        });
        findings.push(
          diagnostic({
            severity: "warning",
            phase: "report",
            code: ProbeCliCode.ResponseNonconformant,
            message:
              `${where} answered ${response.status.toString(10)}, which the ` +
              "frozen contract refuses" +
              (first === undefined
                ? "."
                : `; first ${first.pointer}: ${first.message}.`)
          })
        );
      }
    } catch (error) {
      const aborted =
        error instanceof Error && error.name === "AbortError"
          ? "timeout"
          : "network";
      const message = redactor.redactText(describeCause(error));
      row = {
        trial_id: candidate.trialId,
        sequence: candidate.sequence,
        operation: operationName,
        method,
        path: redactor.redactText(recordedPath),
        classification: "request_error",
        status: null,
        skip_reason: null,
        error_code: aborted,
        error_message: message,
        violations: 0
      };
      findings.push(
        diagnostic({
          severity: "warning",
          phase: "run",
          code: ProbeCliCode.RequestFailed,
          message: `${where} failed as ${aborted}: ${message}`
        })
      );
    } finally {
      clearTimeout(timer);
    }
    results.push(row);
  }

  if (capped > 0) {
    findings.push(
      diagnostic({
        severity: "warning",
        phase: "run",
        code: ProbeCliCode.RequestsTruncated,
        message:
          `The run limit of ${LIMIT_DEFAULTS.maxRequestsPerRun.toString(10)} ` +
          `replayed requests stopped the probe; ${capped.toString(10)} ` +
          "recorded requests stayed skipped."
      })
    );
  }

  const count = (classification: ConformanceResult["classification"]): number =>
    results.filter((row) => row.classification === classification).length;
  const document: ConformanceDocument = {
    schema_version: 1,
    kind: "ConformanceReport",
    scope,
    generated_at: formatRfc3339(Date.now()),
    base_url: baseUrlRaw,
    contract: { path: CONTRACT_INPUT, sha256: sha256Hex(contractText) },
    allowlist,
    writes_allowed: allowWrites,
    credential:
      credential === null
        ? null
        : {
            environment: credentialEnv as string,
            header_names: credentialHeaders
          },
    request_timeout_ms: timeoutMs,
    counts: {
      requests: results.length,
      replayed,
      skipped: count("skipped"),
      conformant: count("conformant"),
      undeclared_status: count("undeclared_status"),
      schema_violation: count("schema_violation"),
      request_error: count("request_error"),
      findings: conformanceFindings.length
    },
    results,
    findings: conformanceFindings,
    extensions: {}
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "conformance.json"),
    `${stableJsonStringify(document as unknown as Json)}\n`
  );
  emitDiagnostics(io, args.context, findings);
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(document as unknown as Json));
  } else {
    for (const line of probeLines(document)) {
      io.stdout(line);
    }
  }
  // A divergence is the product, not a failure: the probe exits 0
  // whatever it finds, like the friction measurement.
  return EXIT_OK;
};
