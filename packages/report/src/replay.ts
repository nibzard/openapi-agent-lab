/**
 * Deterministic evidence replay (specification section 23.12).
 *
 * Replay starts no agent. It reads one run's persisted evidence stream
 * (lifecycle plus trace records), rebuilds every recorded participant
 * HTTP request, and re-issues it through the gateway with the same
 * frozen contract, run seed, fixtures, and limits. Replay covers the
 * HTTP plane only: real timestamps, latency, and agent behavior stay
 * out of scope.
 *
 * The engine is a pure function of its inputs. It reads no clock, uses
 * no randomness, and opens no socket; every observable value comes from
 * the evidence records or the gateway pipeline itself.
 *
 * Redaction gaps are explicit. Declared authentication is substitutable
 * (section 23.12): the engine mints the run's synthetic credentials and
 * fills exactly the values the record redacted. Any other secret-bearing
 * gap makes the request unavailable for replay, and full verification is
 * withheld while any required request is unavailable.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  jsonEquals,
  sha256HexBytes,
  type Json
} from "@oal/core";
import type { LifecycleEvent, TraceBody, TraceEvent } from "@oal/evidence";
import {
  handleGatewayRequest,
  mintRunCredentials,
  type GatewayOptions,
  type GatewayResponse,
  type RawRequest
} from "@oal/gateway";

export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_RESULT_KIND = "ReplayResult";

/** Contract type accepted by the gateway, re-exported for callers. */
export type ReplayContract = GatewayOptions["contract"];
/** One contract fixture of the frozen run inputs. */
export type ReplayFixture = NonNullable<GatewayOptions["fixtures"]>[number];
/** Limit table type the gateway pipeline enforces. */
export type ReplayLimits = GatewayOptions["limits"];

/** Response headers excluded from comparison (section 23.12 timestamps). */
export const VOLATILE_RESPONSE_HEADERS: readonly string[] = ["date", "age"];

/** Redaction marker used by the evidence text contexts (section 30.4). */
export const REDACTED_MARKER = "[REDACTED]";

/** Stable fingerprint shape of a redacted path or query value. */
const REDACTED_FINGERPRINT = /^path-[0-9a-f]{12}$/;

/** Deterministic non-secret credential for rejected presentations. */
const INVALID_REPLAY_CREDENTIAL = "oal-replay-invalid-credential";

/** Replay classification of one recorded request (section 23.12). */
export type ReplayClassification = "full" | "substitutable" | "unavailable";

/** Per-request replay outcome. */
export type ReplayRequestStatus = "verified" | "mismatch" | "skipped" | "error";

export type ReplayDifferenceKind = "status" | "header" | "body";

/** One observed inequality between the record and the replay. */
export interface ReplayDifference {
  kind: ReplayDifferenceKind;
  name: string | null;
  recorded: string | null;
  observed: string | null;
}

/** Outcome of one recorded participant request. */
export interface ReplayOutcome {
  sequence: number;
  request_id: string;
  operation: string | null;
  classification: ReplayClassification;
  status: ReplayRequestStatus;
  reason_code: string | null;
  recorded_status: number | null;
  observed_status: number | null;
  /** Security scheme names whose redacted credential was substituted. */
  substituted: readonly string[];
  differences: readonly ReplayDifference[];
  /** Response aspects the record cannot support comparing. */
  not_comparable: readonly string[];
  /** Gateway error message when the replay attempt threw. */
  error_message: string | null;
}

export interface ReplayCounts {
  /** Participant exchanges in scope after the request filter. */
  in_scope: number;
  /** Requests actually issued through the gateway. */
  replayed: number;
  verified: number;
  mismatched: number;
  skipped: number;
  failed: number;
}

export type ReplayDiagnosticSeverity = "error" | "warning";

export interface ReplayDiagnostic {
  severity: ReplayDiagnosticSeverity;
  code: string;
  message: string;
  sequence: number | null;
}

/** Frozen contract identity check against the recorded digest. */
export interface ReplayContractCheck {
  expected: string | null;
  observed: string;
  match: boolean | null;
}

export interface ReplayResult {
  schema_version: typeof REPLAY_SCHEMA_VERSION;
  kind: typeof REPLAY_RESULT_KIND;
  run_id: string;
  verify: boolean;
  request_filter: number | null;
  contract: ReplayContractCheck;
  fixtures_sha256: string;
  counts: ReplayCounts;
  /** Verified fraction of the in-scope requests; zero when none. */
  coverage: number;
  /**
   * True only when every in-scope request verified against comparable
   * records and no unavailable request remains (section 23.12).
   */
  full_verification: boolean;
  outcomes: readonly ReplayOutcome[];
  diagnostics: readonly ReplayDiagnostic[];
  replay_sha256: string;
}

/** One persisted evidence record of a run's streams. */
export type ReplayEvidenceEvent = LifecycleEvent | TraceEvent;

export interface ReplayInput {
  runId: string;
  events: readonly ReplayEvidenceEvent[];
  contract: ReplayContract;
  /** Digest recorded for the run's frozen contract, when known. */
  contractSha256?: string | null | undefined;
  runSeed: string;
  fixtures?: readonly ReplayFixture[] | undefined;
  limits: ReplayLimits;
  /** Restrict replay to one ingress sequence (`--request`). */
  request?: number | null | undefined;
  /** Strict mode: mismatches become error diagnostics. */
  verify?: boolean | undefined;
}

/** Digest of the canonical serialized contract. */
export function replayContractSha256(contract: ReplayContract): string {
  return canonicalJsonSha256(contract as unknown as Json);
}

function asJson(value: unknown): Json {
  return value as Json;
}

function isTraceEvent(event: ReplayEvidenceEvent): event is TraceEvent {
  return event.type === "api.exchange";
}

/** Ingress sequence of one exchange; the trace sequence is the fallback. */
function ingressOf(event: TraceEvent): number {
  return event.participant_ingress_sequence ?? event.sequence;
}

function requestIdOf(sequence: number): string {
  return `req_${sequence.toString(10).padStart(8, "0")}`;
}

function isRedactedValue(value: string): boolean {
  return value === REDACTED_MARKER || REDACTED_FINGERPRINT.test(value);
}

/** Whether a recorded JSON body still holds redaction markers. */
function jsonHoldsMarkers(value: Json): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonHoldsMarkers(item));
  }
  if (value !== null && typeof value === "object") {
    if (value["redacted"] === true) {
      return true;
    }
    return Object.values(value).some((item) => jsonHoldsMarkers(item));
  }
  return false;
}

interface ReconstructedBody {
  bytes: Uint8Array;
}

/** Why a recorded request body cannot be rebuilt. */
type BodyRejection =
  | "body_secret_undeclared"
  | "body_truncated"
  | "body_representation_unsupported";

function reconstructRequestBody(
  body: TraceBody
): ReconstructedBody | { reason: BodyRejection } {
  switch (body.kind) {
    case "none":
      return { bytes: new Uint8Array(0) };
    case "json": {
      if (body.truncated) {
        return { reason: "body_truncated" };
      }
      if (jsonHoldsMarkers(body.value)) {
        return { reason: "body_secret_undeclared" };
      }
      return { bytes: new TextEncoder().encode(canonicalJson(body.value)) };
    }
    case "text": {
      if (body.truncated) {
        return { reason: "body_truncated" };
      }
      if (body.text.includes(REDACTED_MARKER)) {
        return { reason: "body_secret_undeclared" };
      }
      return { bytes: new TextEncoder().encode(body.text) };
    }
    default:
      return { reason: "body_representation_unsupported" };
  }
}

interface Reconstruction {
  classification: ReplayClassification;
  reasonCode: string | null;
  substituted: readonly string[];
  raw: RawRequest | null;
}

function unavailable(reasonCode: string): Reconstruction {
  return {
    classification: "unavailable",
    reasonCode,
    substituted: [],
    raw: null
  };
}

/**
 * Rebuild the raw wire request from one trace record. Redacted
 * credential locations are filled with the run's minted values; any
 * other redaction gap makes the request unavailable (section 23.12).
 */
function reconstructRequest(
  contract: ReplayContract,
  runSeed: string,
  exchange: TraceEvent
): Reconstruction {
  if (exchange.transport.kind !== "http") {
    return unavailable("transport_not_http");
  }
  const request = exchange.request;
  if (request === null) {
    return unavailable("request_record_missing");
  }
  if (exchange.replay.classification === "unavailable") {
    return unavailable(exchange.replay.reason_code ?? "recorded_unavailable");
  }

  for (const segment of request.path.split("/")) {
    if (isRedactedValue(segment)) {
      return unavailable("path_redacted");
    }
  }

  const body = reconstructRequestBody(request.body);
  if (!("bytes" in body)) {
    return unavailable(body.reason);
  }

  const headers: Record<string, string | string[]> = {};
  const redactedNames = new Set<string>();
  for (const header of request.headers) {
    if (
      header.redacted ||
      header.values.some((value) => isRedactedValue(value))
    ) {
      redactedNames.add(header.name.toLowerCase());
      continue;
    }
    const [first] = header.values;
    headers[header.name] =
      header.values.length === 1 && first !== undefined
        ? first
        : [...header.values];
  }

  const queryTokens = new Map<string, string>();
  const substituted = substituteCredentials(
    contract,
    runSeed,
    exchange,
    headers,
    redactedNames,
    queryTokens
  );

  const remainingRedacted = Object.values(headers).some((value) =>
    Array.isArray(value)
      ? value.some((entry) => isRedactedValue(entry))
      : isRedactedValue(value)
  );
  if (remainingRedacted) {
    return unavailable("request_secret_undeclared");
  }

  const query = rebuiltQuery(request.query_string, request.query, queryTokens);
  if (query.redacted) {
    return unavailable("request_secret_undeclared");
  }

  const target =
    query.string.length > 0 ? `${request.path}?${query.string}` : request.path;
  return {
    classification:
      substituted.length > 0 ? "substitutable" : exchange.replay.classification,
    reasonCode: substituted.length > 0 ? "credential_substituted" : null,
    substituted,
    raw: {
      method: request.method,
      target,
      headers,
      body: body.bytes
    }
  };
}

/**
 * Fill every redacted credential location with minted run values. The
 * minted values are deterministic in the run seed, so a substituted
 * credential equals the one the original run presented.
 */
function substituteCredentials(
  contract: ReplayContract,
  runSeed: string,
  exchange: TraceEvent,
  headers: Record<string, string | string[]>,
  redactedNames: ReadonlySet<string>,
  queryTokens: Map<string, string>
): string[] {
  const substituted: string[] = [];
  const minted = mintRunCredentials(contract, runSeed);
  const authenticated = exchange.authentication.status === "authenticated";
  const declared = exchange.authentication.schemes;
  const queryRedacted = exchange.request?.query.some((parameter) =>
    parameter.values.some((value) => isRedactedValue(value))
  );
  if (redactedNames.size === 0 && queryRedacted !== true) {
    return substituted;
  }
  for (const [name, scheme] of Object.entries(contract.security_schemes)) {
    if (declared.length > 0 && !declared.includes(name)) {
      continue;
    }
    const token = authenticated
      ? (minted.apiKeys[name] ?? INVALID_REPLAY_CREDENTIAL)
      : INVALID_REPLAY_CREDENTIAL;
    if (scheme.type === "apiKey") {
      if (
        scheme.location === "header" &&
        scheme.wire_name !== null &&
        redactedNames.has(scheme.wire_name.toLowerCase())
      ) {
        headers[scheme.wire_name] = token;
        substituted.push(name);
      } else if (
        scheme.location === "query" &&
        scheme.wire_name !== null &&
        queryRedacted === true &&
        exchange.request?.query.some(
          (parameter) =>
            parameter.name === scheme.wire_name &&
            parameter.values.some((value) => isRedactedValue(value))
        ) === true
      ) {
        queryTokens.set(scheme.wire_name, token);
        substituted.push(name);
      } else if (
        scheme.location === "cookie" &&
        scheme.wire_name !== null &&
        redactedNames.has("cookie")
      ) {
        headers["cookie"] = `${scheme.wire_name}=${token}`;
        substituted.push(name);
      }
      continue;
    }
    if (
      (scheme.type === "http" ||
        scheme.type === "oauth2" ||
        scheme.type === "openIdConnect") &&
      redactedNames.has("authorization")
    ) {
      if (scheme.type === "http" && scheme.scheme === "basic") {
        const pair = authenticated
          ? `${minted.basic.username}:${minted.basic.password}`
          : `${INVALID_REPLAY_CREDENTIAL}:${INVALID_REPLAY_CREDENTIAL}`;
        headers["authorization"] = `Basic ${Buffer.from(pair, "utf8").toString(
          "base64"
        )}`;
        substituted.push(name);
        continue;
      }
      headers["authorization"] = `Bearer ${
        authenticated ? minted.bearer : INVALID_REPLAY_CREDENTIAL
      }`;
      substituted.push(name);
    }
  }
  return substituted;
}

/**
 * Rebuild the query string from the recorded parameters. The original
 * string is kept unless a value had to be substituted or still holds a
 * redaction marker.
 */
function rebuiltQuery(
  recorded: string,
  query: ReadonlyArray<{ name: string; values: string[] }>,
  queryTokens: ReadonlyMap<string, string>
): { string: string; redacted: boolean } {
  let redacted = false;
  const pairs: string[] = [];
  for (const parameter of query) {
    const token = queryTokens.get(parameter.name);
    if (token !== undefined) {
      pairs.push(
        `${encodeURIComponent(parameter.name)}=${encodeURIComponent(token)}`
      );
      continue;
    }
    for (const value of parameter.values) {
      if (isRedactedValue(value)) {
        redacted = true;
      }
      pairs.push(
        `${encodeURIComponent(parameter.name)}=${encodeURIComponent(value)}`
      );
    }
  }
  if (redacted || queryTokens.size > 0) {
    return { string: pairs.join("&"), redacted };
  }
  return { string: recorded, redacted: false };
}

interface ResponseComparison {
  differences: ReplayDifference[];
  notComparable: string[];
}

function clip(text: string): string {
  return text.length > 80 ? text.slice(0, 80) : text;
}

/** Short, bounded rendering of one recorded body for difference rows. */
function summarizeBody(body: TraceBody): string {
  switch (body.kind) {
    case "none":
      return "<no body>";
    case "json":
      return `json:${clip(canonicalJson(body.value))}`;
    case "text":
      return body.sha256 === null
        ? `text:${clip(body.text)}`
        : `sha256:${body.sha256}`;
    default:
      return `${body.kind}:${body.size_bytes}b`;
  }
}

/** Compare the recorded response with the replayed one. */
function compareResponse(
  recorded: NonNullable<TraceEvent["response"]>,
  observed: GatewayResponse
): ResponseComparison {
  const differences: ReplayDifference[] = [];
  const notComparable: string[] = [];

  if (recorded.status !== observed.status) {
    differences.push({
      kind: "status",
      name: null,
      recorded: recorded.status.toString(10),
      observed: observed.status.toString(10)
    });
  }

  const volatile = new Set(VOLATILE_RESPONSE_HEADERS);
  const observedHeaders = new Map<string, string>();
  for (const [name, value] of Object.entries(observed.headers)) {
    const lower = name.toLowerCase();
    if (!volatile.has(lower)) {
      observedHeaders.set(lower, value);
    }
  }
  const recordedNames = new Set<string>();
  for (const header of recorded.headers) {
    if (volatile.has(header.name)) {
      continue;
    }
    recordedNames.add(header.name.toLowerCase());
    if (header.redacted) {
      notComparable.push("response_headers");
      continue;
    }
    const expected = header.values.join(", ");
    const actual = observedHeaders.get(header.name.toLowerCase());
    if (actual !== expected) {
      differences.push({
        kind: "header",
        name: header.name,
        recorded: expected,
        observed: actual ?? null
      });
    }
  }
  for (const [name, value] of observedHeaders) {
    if (!recordedNames.has(name)) {
      differences.push({
        kind: "header",
        name,
        recorded: null,
        observed: value
      });
    }
  }

  const bodyEquality = compareBody(recorded.body, observed.body);
  if (bodyEquality.comparable) {
    if (bodyEquality.equal === false) {
      differences.push({
        kind: "body",
        name: null,
        recorded: summarizeBody(recorded.body),
        observed: observed.body === undefined ? null : clip(observed.body)
      });
    }
  } else {
    notComparable.push("response_body");
  }
  return { differences, notComparable };
}

function compareBody(
  recorded: TraceBody,
  observed: string | undefined
): { comparable: boolean; equal: boolean | null } {
  switch (recorded.kind) {
    case "none":
      return {
        comparable: true,
        equal: observed === undefined || observed.length === 0
      };
    case "json": {
      if (jsonHoldsMarkers(recorded.value)) {
        return { comparable: false, equal: null };
      }
      if (observed === undefined) {
        return { comparable: true, equal: false };
      }
      try {
        return {
          comparable: true,
          equal: jsonEquals(JSON.parse(observed) as Json, recorded.value)
        };
      } catch {
        return { comparable: true, equal: false };
      }
    }
    case "text": {
      if (recorded.sha256 === null || recorded.truncated) {
        return { comparable: false, equal: null };
      }
      if (observed === undefined) {
        return { comparable: true, equal: false };
      }
      return {
        comparable: true,
        equal:
          sha256HexBytes(new TextEncoder().encode(observed)) === recorded.sha256
      };
    }
    case "binary": {
      if (recorded.sha256 === null) {
        return { comparable: false, equal: null };
      }
      if (observed === undefined) {
        return { comparable: true, equal: false };
      }
      return {
        comparable: true,
        equal:
          sha256HexBytes(new TextEncoder().encode(observed)) === recorded.sha256
      };
    }
    default:
      return { comparable: false, equal: null };
  }
}

/** Lifecycle-derived diagnostics about stream completeness. */
function lifecycleDiagnostics(
  events: readonly LifecycleEvent[],
  runId: string,
  verify: boolean
): ReplayDiagnostic[] {
  const diagnostics: ReplayDiagnostic[] = [];
  const own = events.filter(
    (event) => event.run_id === null || event.run_id === runId
  );
  if (own.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "replay.lifecycle_absent",
      message:
        "The evidence stream carries no lifecycle records; completeness cannot be assessed.",
      sequence: null
    });
    return diagnostics;
  }
  const created = own.some(
    (event) => event.type === "run.created" && event.payload.run_id === runId
  );
  if (!created) {
    diagnostics.push({
      severity: "warning",
      code: "replay.run_created_missing",
      message: "The stream holds no run.created record for this run.",
      sequence: null
    });
  }
  const finished = own.find((event) => event.type === "run.finished");
  if (finished === undefined) {
    diagnostics.push({
      severity: "warning",
      code: "replay.run_unfinished",
      message:
        "The run has no terminal record; the evidence may be incomplete.",
      sequence: null
    });
  } else if (finished.payload.evidence_integrity !== "intact") {
    diagnostics.push({
      severity: verify ? "error" : "warning",
      code: "replay.evidence_integrity",
      message: `The run terminal record reports ${finished.payload.evidence_integrity} evidence.`,
      sequence: finished.sequence
    });
  }
  return diagnostics;
}

function outcomeDiagnostics(
  outcome: ReplayOutcome,
  verify: boolean
): ReplayDiagnostic[] {
  const diagnostics: ReplayDiagnostic[] = [];
  if (outcome.status === "mismatch") {
    diagnostics.push({
      severity: verify ? "error" : "warning",
      code: "replay.mismatch",
      message: `The replayed response differs from the record at request sequence ${outcome.sequence} (${outcome.differences.length} difference(s)).`,
      sequence: outcome.sequence
    });
  } else if (outcome.status === "skipped") {
    diagnostics.push({
      severity: verify ? "error" : "warning",
      code: "replay.unavailable",
      message: `Request sequence ${outcome.sequence} is not replayable: ${outcome.reason_code ?? "unknown reason"}.`,
      sequence: outcome.sequence
    });
  } else if (outcome.status === "error") {
    diagnostics.push({
      severity: "error",
      code: "replay.gateway_error",
      message: `The gateway threw at request sequence ${outcome.sequence}: ${outcome.error_message ?? "unknown error"}.`,
      sequence: outcome.sequence
    });
  }
  if (outcome.status === "verified" && outcome.not_comparable.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "replay.not_comparable",
      message: `Request sequence ${outcome.sequence} could not compare ${outcome.not_comparable.join(", ")}.`,
      sequence: outcome.sequence
    });
  }
  return diagnostics;
}

/** Replay one recorded run and compare every in-scope exchange. */
export async function replayRun(input: ReplayInput): Promise<ReplayResult> {
  const verify = input.verify ?? false;
  const diagnostics: ReplayDiagnostic[] = [];

  const foreign = input.events.filter(
    (event) => event.run_id !== null && event.run_id !== input.runId
  ).length;
  if (foreign > 0) {
    diagnostics.push({
      severity: "warning",
      code: "replay.foreign_run_events",
      message: `${foreign} evidence record(s) belong to another run and were ignored.`,
      sequence: null
    });
  }

  const lifecycle = input.events.filter(
    (event): event is LifecycleEvent => !isTraceEvent(event)
  );
  const traces = input.events.filter(isTraceEvent);
  diagnostics.push(...lifecycleDiagnostics(lifecycle, input.runId, verify));

  const observedContractSha = replayContractSha256(input.contract);
  const expectedSha = input.contractSha256 ?? null;
  const contract: ReplayContractCheck = {
    expected: expectedSha,
    observed: observedContractSha,
    match: expectedSha === null ? null : expectedSha === observedContractSha
  };
  if (contract.match === false) {
    diagnostics.push({
      severity: verify ? "error" : "warning",
      code: "replay.contract_mismatch",
      message:
        "The supplied contract does not match the digest recorded for the run.",
      sequence: null
    });
  }

  const gatewayOptions: GatewayOptions = {
    contract: input.contract,
    limits: input.limits,
    runSeed: input.runSeed
  };
  if (input.fixtures !== undefined) {
    gatewayOptions.fixtures = [...input.fixtures];
  }

  const exchanges = traces
    .filter(
      (event) =>
        event.actor === "participant" &&
        (event.run_id === null || event.run_id === input.runId)
    )
    .sort((left, right) => ingressOf(left) - ingressOf(right));

  const filter = input.request ?? null;
  const selected =
    filter === null
      ? exchanges
      : exchanges.filter((event) => ingressOf(event) === filter);
  if (filter !== null && selected.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "replay.request_not_found",
      message: `No participant request with sequence ${filter} exists in the evidence stream.`,
      sequence: null
    });
  }

  const outcomes: ReplayOutcome[] = [];
  for (const exchange of selected) {
    const sequence = ingressOf(exchange);
    const reconstruction = reconstructRequest(
      input.contract,
      input.runSeed,
      exchange
    );
    const outcome = await replayExchange(
      exchange,
      reconstruction,
      gatewayOptions,
      sequence
    );
    outcomes.push(outcome);
    diagnostics.push(...outcomeDiagnostics(outcome, verify));
  }

  const counts: ReplayCounts = {
    in_scope: selected.length,
    replayed: 0,
    verified: 0,
    mismatched: 0,
    skipped: 0,
    failed: 0
  };
  for (const outcome of outcomes) {
    if (outcome.status === "error") {
      counts.failed += 1;
    } else if (outcome.status === "skipped") {
      counts.skipped += 1;
    } else {
      counts.replayed += 1;
      if (outcome.status === "verified") {
        counts.verified += 1;
      } else {
        counts.mismatched += 1;
      }
    }
  }

  const coverage =
    counts.in_scope === 0 ? 0 : counts.verified / counts.in_scope;
  const fullyVerified =
    counts.in_scope > 0 &&
    counts.verified === counts.in_scope &&
    contract.match !== false &&
    outcomes.every(
      (outcome) =>
        outcome.status === "verified" && outcome.not_comparable.length === 0
    );

  const partial: Omit<ReplayResult, "replay_sha256"> = {
    schema_version: REPLAY_SCHEMA_VERSION,
    kind: REPLAY_RESULT_KIND,
    run_id: input.runId,
    verify,
    request_filter: filter,
    contract,
    fixtures_sha256: canonicalJsonSha256(asJson([...(input.fixtures ?? [])])),
    counts,
    coverage,
    full_verification: fullyVerified,
    outcomes,
    diagnostics
  };
  return { ...partial, replay_sha256: canonicalJsonSha256(asJson(partial)) };
}

async function replayExchange(
  exchange: TraceEvent,
  reconstruction: Reconstruction,
  options: GatewayOptions,
  sequence: number
): Promise<ReplayOutcome> {
  const base = {
    sequence,
    request_id: requestIdOf(sequence),
    operation: exchange.operation.key,
    classification: reconstruction.classification,
    substituted: reconstruction.substituted
  };
  if (reconstruction.raw === null) {
    return {
      ...base,
      status: "skipped",
      reason_code: reconstruction.reasonCode,
      recorded_status: exchange.response?.status ?? null,
      observed_status: null,
      differences: [],
      not_comparable: [],
      error_message: null
    };
  }
  if (exchange.response === null) {
    return {
      ...base,
      status: "skipped",
      reason_code: "response_absent",
      recorded_status: null,
      observed_status: null,
      differences: [],
      not_comparable: [],
      error_message: null
    };
  }
  let response: GatewayResponse;
  try {
    response = await handleGatewayRequest(
      options,
      sequence,
      reconstruction.raw
    );
  } catch (error) {
    return {
      ...base,
      status: "error",
      reason_code: "gateway_error",
      recorded_status: exchange.response.status,
      observed_status: null,
      differences: [],
      not_comparable: [],
      error_message: error instanceof Error ? error.message : String(error)
    };
  }
  const comparison = compareResponse(exchange.response, response);
  return {
    ...base,
    status: comparison.differences.length > 0 ? "mismatch" : "verified",
    reason_code: reconstruction.reasonCode,
    recorded_status: exchange.response.status,
    observed_status: response.status,
    differences: comparison.differences,
    not_comparable: comparison.notComparable,
    error_message: null
  };
}
