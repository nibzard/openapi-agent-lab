/**
 * Deterministic friction analysis over recorded trials (specification
 * section 27). The builder reads frozen trace events and reports every
 * friction incident it can prove from them: what the participant sent,
 * what the mock answered, and which sidecar action would remove the
 * friction. It never reads the clock, the filesystem, or the network, so
 * the same trials produce byte-identical reports.
 *
 * Reading old traces is tolerated everywhere: records written before
 * truthful provenance lack the example class and the approximation
 * observation, and their absence simply yields no approximation signal.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  isJsonObject,
  sha256Hex,
  type Json
} from "@oal/core";
import type { TraceBody, TraceEvent } from "@oal/evidence";
import { summarize, type NumericSummary } from "@oal/statistics";

export const FRICTION_SCHEMA_VERSION = 1;
export const FRICTION_REPORT_KIND = "FrictionReport";

/** Evidence rows cited per incident. */
export const FRICTION_MAX_EVIDENCE_ROWS = 20;
/** Request-shape descriptors kept per operation. */
export const FRICTION_MAX_SHAPE_DESCRIPTORS = 8;
/** Distinct approximation markers kept per operation. */
export const FRICTION_MAX_APPROXIMATIONS = 16;
/** Framework code rows kept per operation. */
export const FRICTION_MAX_FRAMEWORK_CODES = 32;

/** Longest incident id suffix; keeps ids inside the schema pattern. */
const SLUG_MAX_LENGTH = 96;
/** Longest free-text line the builder ever emits. */
const DETAIL_MAX_LENGTH = 500;

/** A generated value the mock invented, for example a cursor or id. */
const GENERATED_HANDLE_PATTERN = /^gen_[A-Za-z0-9_-]+$/;

export type FrictionScopeLevel = "run" | "batch";

export type FrictionScope = {
  level: FrictionScopeLevel;
  id: string;
};

export type FrictionClass =
  | "spec_friction"
  | "mock_fidelity"
  | "harness"
  | "unknown";

/**
 * Where one incident came from. `api` names the lab data plane under a
 * runner trial; `external` names a trace the lab recorded or imported
 * without a runner, for example a serve session or a HAR import;
 * `harness` names admission control.
 */
export type FrictionOrigin = "api" | "harness" | "external";

/** Where one trial's trace was recorded. */
export type FrictionTrialSource = "runner" | "external";

export type FrictionIncidentKind =
  | "route_unmatched"
  | "request_schema_rejected"
  | "media_type_rejected"
  | "quota_exceeded"
  | "framework_error"
  | "escalation"
  | "abandonment"
  | "identical_retry"
  | "generated_handle_reuse";

export type FrictionWorklistAction =
  | "author_fixture"
  | "add_enum_values"
  | "declare_media_type"
  | "normalize_route"
  | "document_precondition"
  | "requires_behavior_backend"
  | "investigate";

export interface FrictionTrialRow {
  trial_id: string;
  exchanges: number;
  failed_exchanges: number;
  incident_count: number;
}

export interface FrictionFrameworkCodeRow {
  code: string;
  status: number;
  count: number;
}

export interface FrictionOperationRow {
  operation: string;
  operation_id: string | null;
  attempts: number;
  status_counts: Record<string, number>;
  first_success_attempt: number | null;
  attempts_to_first_2xx: number | null;
  distinct_request_shapes: number;
  shape_descriptors: string[];
  escalated: boolean;
  abandoned: boolean;
  identical_retries: number;
  framework_codes: FrictionFrameworkCodeRow[];
  provenance_mix: { fixture: number; example: number; generated: number };
  approximations: string[];
  duration: NumericSummary;
}

export interface FrictionEvidenceRow {
  trial_id: string;
  sequence: number;
  status: number;
  code: string | null;
  request_shape: string | null;
  provenance: string | null;
}

export interface FrictionIncident {
  id: string;
  kind: FrictionIncidentKind;
  class: FrictionClass;
  origin: FrictionOrigin;
  operation: string | null;
  near_miss_of: string | null;
  trials: string[];
  occurrences: number;
  evidence: FrictionEvidenceRow[];
  detail: string;
}

export interface FrictionFixtureHint {
  status: number;
  media_type: string;
  body_kind: "json_file" | "json_inline" | "text_file";
}

export interface FrictionWorklistItem {
  id: string;
  incident_ids: string[];
  operation: string | null;
  action: FrictionWorklistAction;
  summary: string;
  fixture?: FrictionFixtureHint;
  requires_behavior_backend: boolean;
}

export interface FrictionCounts {
  trials: number;
  exchanges: number;
  operations: number;
  incidents: number;
  incidents_by_class: Record<FrictionClass, number>;
  incidents_by_kind: Record<string, number>;
  worklist_items: number;
}

export interface FrictionReport {
  schema_version: 1;
  kind: "FrictionReport";
  scope: FrictionScope;
  generated_at?: string;
  counts: FrictionCounts;
  trials: FrictionTrialRow[];
  operations: FrictionOperationRow[];
  incidents: FrictionIncident[];
  worklist: FrictionWorklistItem[];
  extensions: Record<string, Json>;
}

/** One trial as the builder accepts it: an id plus frozen trace events. */
export interface FrictionTrialInput {
  runId: string;
  events: readonly TraceEvent[];
  /**
   * Where the trace was recorded. A runner trial is the default; an
   * external trial, for example a serve session or an imported HAR,
   * relabels every api-origin incident `external` because no runner
   * harness produced it.
   */
  readonly source?: FrictionTrialSource;
}

export interface FrictionBuildInput {
  scope: FrictionScope;
  trials: readonly FrictionTrialInput[];
  /** Injected timestamp; the builder never reads the clock itself. */
  generatedAt?: string;
}

/** Everything one exchange contributes to every detector. */
interface Attempt {
  trialIndex: number;
  runId: string;
  /** Incident origin this exchange reports: api or external. */
  origin: FrictionOrigin;
  /** True when no runner harness recorded this exchange. */
  external: boolean;
  sequence: number;
  key: string;
  operationId: string | null;
  matched: boolean;
  method: string;
  path: string;
  queryString: string;
  queryValues: string[];
  status: number | null;
  is2xx: boolean;
  descriptor: string;
  fingerprint: string;
  errorCode: string | null;
  provenance: "fixture" | "behavior" | "example" | "generated" | null;
  approximation: string | null;
  contentType: string | null;
  durationMs: number;
  violations: string[];
  responseHandles: string[];
}

/** Evidence row plus the trial index it came from, for ordering. */
type SeedRow = FrictionEvidenceRow & { trialIndex: number };

/** Incident under construction, keyed by bucket id. */
interface IncidentSeed {
  kind: FrictionIncidentKind;
  frictionClass: FrictionClass;
  origin: FrictionOrigin;
  operation: string | null;
  operationId: string | null;
  nearMissOf: string | null;
  rows: SeedRow[];
  trials: string[];
  occurrences: number;
  detail: string;
  action: FrictionWorklistAction;
  summary: string;
  hint: FrictionFixtureHint | null;
}

export function buildFrictionReport(input: FrictionBuildInput): FrictionReport {
  const trials = input.trials.map((trial) => ({
    runId: trial.runId,
    external: trial.source === "external",
    events: trial.events
      .filter((event) => event.actor === "participant")
      .sort((a, b) => a.sequence - b.sequence)
  }));
  const attemptsByTrial = trials.map((trial, index) =>
    trial.events.map((event) =>
      attemptOf(event, index, trial.runId, trial.external)
    )
  );

  // Operation grouping keeps first-seen order for deterministic rows.
  const operationOrder: string[] = [];
  const operations = new Map<string, Attempt[]>();
  const perTrialOperations = attemptsByTrial.map((attempts) => {
    const byKey = new Map<string, Attempt[]>();
    for (const attempt of attempts) {
      if (!operations.has(attempt.key)) {
        operations.set(attempt.key, []);
        operationOrder.push(attempt.key);
      }
      (operations.get(attempt.key) as Attempt[]).push(attempt);
      if (!byKey.has(attempt.key)) {
        byKey.set(attempt.key, []);
      }
      (byKey.get(attempt.key) as Attempt[]).push(attempt);
    }
    return byKey;
  });

  // An incident is identified by its detector, operation, and friction
  // class, so every bucket key below carries those three. A key keeps an
  // extra component only when it changes the remedy the incident asks
  // for, never to split identical findings.
  const seeds = new Map<string, IncidentSeed>();

  // Event-level detectors.
  const declaredKeys = [...operations.keys()].filter((key) =>
    operations.get(key)?.some((attempt) => attempt.matched)
  );
  attemptsByTrial.forEach((attempts) => {
    for (const attempt of attempts) {
      collectEventIncident(attempt, declaredKeys, seeds);
    }
  });

  // Sequence-level detectors, per trial and operation.
  attemptsByTrial.forEach((attempts, trialIndex) => {
    const max2xxSequence = attempts.reduce(
      (best, attempt) =>
        attempt.is2xx ? Math.max(best, attempt.sequence) : best,
      Number.NEGATIVE_INFINITY
    );
    for (const [key, list] of perTrialOperations[trialIndex] as Map<
      string,
      Attempt[]
    >) {
      detectEscalation(key, list, seeds);
      detectIdenticalRetries(key, list, seeds);
      detectAbandonment(key, list, max2xxSequence, seeds);
    }
    detectGeneratedHandleReuse(attempts, seeds);
  });

  const incidents = [...seeds.values()].sort(byFirstEvidence);
  const trialsOfIncident = incidents.map((incident) =>
    distinct(incident.rows.map((row) => row.trial_id))
  );

  const worklist = buildWorklist(incidents);

  const operationRows = operationOrder.map((key) =>
    operationRowOf(key, operations.get(key) as Attempt[], incidents)
  );

  const incidentsByClass: Record<FrictionClass, number> = {
    spec_friction: 0,
    mock_fidelity: 0,
    harness: 0,
    unknown: 0
  };
  const incidentsByKind: Record<string, number> = {};
  for (const incident of incidents) {
    incidentsByClass[incident.frictionClass] += 1;
    incidentsByKind[incident.kind] = (incidentsByKind[incident.kind] ?? 0) + 1;
  }

  return {
    schema_version: FRICTION_SCHEMA_VERSION,
    kind: FRICTION_REPORT_KIND,
    scope: input.scope,
    ...(input.generatedAt !== undefined
      ? { generated_at: input.generatedAt }
      : {}),
    counts: {
      trials: trials.length,
      exchanges: attemptsByTrial.reduce(
        (total, list) => total + list.length,
        0
      ),
      operations: operationRows.length,
      incidents: incidents.length,
      incidents_by_class: incidentsByClass,
      incidents_by_kind: incidentsByKind,
      worklist_items: worklist.length
    },
    trials: trials.map((trial, index) => ({
      trial_id: trial.runId,
      exchanges: attemptsByTrial[index]?.length ?? 0,
      failed_exchanges:
        attemptsByTrial[index]?.filter((attempt) => !attempt.is2xx).length ?? 0,
      incident_count: trialsOfIncident.reduce(
        (total, list) => total + (list.includes(trial.runId) ? 1 : 0),
        0
      )
    })),
    operations: operationRows,
    incidents: incidents.map((incident) => ({
      id: incidentIdOf(incident),
      kind: incident.kind,
      class: incident.frictionClass,
      origin: incident.origin,
      operation: incident.operation,
      near_miss_of: incident.nearMissOf,
      trials: incident.trials,
      occurrences: incident.occurrences,
      evidence: incident.rows
        .slice(0, FRICTION_MAX_EVIDENCE_ROWS)
        .map(publicRow),
      detail: incident.detail
    })),
    worklist,
    extensions: {}
  };
}

// ---------------------------------------------------------------------------
// Attempt extraction
// ---------------------------------------------------------------------------

function attemptOf(
  event: TraceEvent,
  trialIndex: number,
  runId: string,
  external: boolean
): Attempt {
  const request = event.request;
  const status = event.response?.status ?? null;
  const backend = event.backend;
  const observations = backend?.observations;
  const approximation =
    observations !== undefined &&
    isJsonObject(observations) &&
    typeof observations["approximation"] === "string"
      ? observations["approximation"]
      : null;
  const body = request?.body;
  const responseBody = event.response?.body;
  return {
    trialIndex,
    runId,
    origin: external ? "external" : "api",
    external,
    sequence: event.sequence,
    key: operationKeyOf(event),
    operationId: event.operation.operation_id,
    matched: event.operation.matched,
    method: request?.method ?? "UNKNOWN",
    path: request?.path ?? "UNKNOWN",
    queryString: request?.query_string ?? "",
    queryValues: (request?.query ?? []).flatMap(
      (parameter) => parameter.values
    ),
    status,
    is2xx: status !== null && status >= 200 && status < 300,
    descriptor: shapeDescriptorOf(body),
    fingerprint: valueFingerprintOf(body),
    errorCode: event.error?.code ?? null,
    provenance: backend?.response_provenance ?? null,
    approximation,
    contentType: event.response?.content_type ?? null,
    durationMs: event.duration_ms,
    violations: violationLinesOf(event),
    responseHandles: generatedHandlesOf(responseBody)
  };
}

/** `path:POST /v1/clips`, or `unmatched:GET /v1/clips/` when nothing matched. */
function operationKeyOf(event: TraceEvent): string {
  if (event.operation.key !== null) {
    return event.operation.key;
  }
  const request = event.request;
  return `unmatched:${request?.method ?? "UNKNOWN"} ${request?.path ?? "UNKNOWN"}`;
}

/**
 * Canonical key set of a JSON request body, for example
 * `{"keys":["format","url"]}`. Two bodies with the same keys but
 * different values share a descriptor, which is exactly what the
 * descriptor is for.
 */
function shapeDescriptorOf(body: TraceBody | undefined): string {
  if (body === undefined || body.kind === "none") {
    return "none";
  }
  if (body.kind === "json") {
    if (isJsonObject(body.value)) {
      return canonicalJson({ keys: Object.keys(body.value).sort() });
    }
    return `json:${Array.isArray(body.value) ? "array" : typeof body.value}`;
  }
  return body.kind;
}

/** Digest of the full request value; differs when any value differs. */
function valueFingerprintOf(body: TraceBody | undefined): string {
  if (body === undefined || body.kind === "none") {
    return "none";
  }
  switch (body.kind) {
    case "json":
      return canonicalJsonSha256(body.value);
    case "text":
      return sha256Hex(body.text);
    case "binary":
      return body.sha256 ?? "binary";
    case "multipart":
      return sha256Hex(
        canonicalJson(
          body.parts.map((part) => [part.name, part.body.kind] as Json)
        )
      );
  }
}

/**
 * Per-field violation lines from the 422 problem body. The trace
 * validation block carries only the framework code, so the problem
 * document is the richer source.
 */
function violationLinesOf(event: TraceEvent): string[] {
  const body = event.response?.body;
  if (body === undefined || body.kind !== "json" || !isJsonObject(body.value)) {
    return [];
  }
  const raw = body.value["violations"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const lines: string[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const pointer =
      typeof entry["pointer"] === "string" ? entry["pointer"] : "";
    const message =
      typeof entry["message"] === "string" ? entry["message"] : "";
    if (pointer === "" && message === "") {
      continue;
    }
    lines.push(pointer === "" ? message : `${pointer}: ${message}`);
  }
  return lines;
}

/** Generated handle strings inside a JSON response body. */
function generatedHandlesOf(body: TraceBody | undefined): string[] {
  if (body === undefined || body.kind !== "json") {
    return [];
  }
  const handles: string[] = [];
  collectHandleStrings(body.value, handles, 0);
  return handles;
}

function collectHandleStrings(value: Json, out: string[], depth: number): void {
  if (depth > 8) {
    return;
  }
  if (typeof value === "string") {
    if (GENERATED_HANDLE_PATTERN.test(value)) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHandleStrings(item, out, depth + 1);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) {
      collectHandleStrings(item, out, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Event-level detectors
// ---------------------------------------------------------------------------

function collectEventIncident(
  attempt: Attempt,
  declaredKeys: readonly string[],
  seeds: Map<string, IncidentSeed>
): void {
  if (
    attempt.status === 429 &&
    attempt.errorCode === "request_quota_exceeded"
  ) {
    // Harness admission control: one incident per trial, never a worklist
    // item, because the mock never saw the request. The seed names no
    // operation (refusal happens before routing) and the per-run burst
    // budget scopes the incident to its trial.
    addSeed(seeds, `quota:${attempt.runId}`, {
      kind: "quota_exceeded",
      frictionClass: "harness",
      origin: "harness",
      operation: null,
      operationId: null,
      nearMissOf: null,
      rows: [evidenceRow(attempt, null, null)],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `The exposure refused the request under its burst quota; the mock never saw it.`
      ),
      action: "investigate",
      summary: "",
      hint: null
    });
    return;
  }
  if (!attempt.matched) {
    const near = nearMissOf(attempt, declaredKeys);
    addSeed(seeds, `route_unmatched:${attempt.key}`, {
      kind: "route_unmatched",
      frictionClass: "spec_friction",
      origin: attempt.origin,
      operation: attempt.key,
      operationId: null,
      nearMissOf: near,
      rows: [evidenceRow(attempt, attempt.errorCode, null)],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `The route ${attempt.method} ${attempt.path} was requested but not declared` +
          (near === null ? `.` : `; the nearest declared route is ${near}.`)
      ),
      action: "normalize_route",
      summary: clamp(
        `Declare ${attempt.method} ${attempt.path} or align it with the nearest declared route` +
          (near === null ? `; no declared route is close.` : ` (${near}).`)
      ),
      hint: null
    });
    return;
  }
  if (attempt.errorCode === "request_schema_invalid") {
    const first = attempt.violations[0] ?? null;
    // The first violation stays in the key: distinct pointers name
    // distinct gaps in the same schema, and the summary names the gap.
    const bucket = `request_schema_rejected:${attempt.key}:${first ?? "none"}`;
    addSeed(seeds, bucket, {
      kind: "request_schema_rejected",
      frictionClass: "spec_friction",
      origin: attempt.origin,
      operation: attempt.key,
      operationId: attempt.operationId,
      nearMissOf: null,
      rows: [evidenceRow(attempt, attempt.errorCode, first)],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `A request was rejected by the declared schema` +
          (first === null ? `.` : `; first violation ${first}.`)
      ),
      action: "add_enum_values",
      summary: clamp(
        first === null
          ? `Widen the request schema for ${attempt.key} or document the accepted values where the participant looks for them.`
          : `Widen the request schema for ${attempt.key} (first violation: ${first}), or document the accepted values where the participant looks for them.`
      ),
      hint: null
    });
    return;
  }
  if (
    attempt.errorCode === "media_type_unsupported" ||
    attempt.errorCode === "response_media_type_unacceptable"
  ) {
    addSeed(seeds, `media_type_rejected:${attempt.key}`, {
      kind: "media_type_rejected",
      frictionClass: "spec_friction",
      origin: attempt.origin,
      operation: attempt.key,
      operationId: attempt.operationId,
      nearMissOf: null,
      rows: [evidenceRow(attempt, attempt.errorCode, null)],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `A request carried a media type the route does not declare (${attempt.errorCode}).`
      ),
      action: "declare_media_type",
      summary: clamp(
        `Declare the media type the participant used on ${attempt.key}, or document the accepted ones.`
      ),
      hint: null
    });
    return;
  }
  if (
    attempt.errorCode !== null &&
    (attempt.errorCode.startsWith("mock_") ||
      attempt.errorCode === "behavior_timeout")
  ) {
    const requiresBackend = attempt.errorCode === "mock_behavior_unavailable";
    // The code stays in the key: it selects the worklist action, so
    // merging codes on one operation would collapse two remedies into
    // whichever failure came first.
    addSeed(seeds, `framework_error:${attempt.key}:${attempt.errorCode}`, {
      kind: "framework_error",
      frictionClass: "mock_fidelity",
      origin: attempt.origin,
      operation: attempt.key,
      operationId: attempt.operationId,
      nearMissOf: null,
      rows: [evidenceRow(attempt, attempt.errorCode, attempt.descriptor)],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `The mock framework answered ${attempt.errorCode} instead of serving a declared response.`
      ),
      action: requiresBackend ? "requires_behavior_backend" : "investigate",
      summary: requiresBackend
        ? clamp(
            `Give ${attempt.key} a scenario behavior; contract mode cannot express it (${attempt.errorCode}).`
          )
        : clamp(
            `Investigate ${attempt.errorCode} on ${attempt.key}: the pack could not serve a valid declared response.`
          ),
      hint: null
    });
  }
}

/** Bounded route comparison: trailing-slash equality, then one differing segment. */
function nearMissOf(
  attempt: Attempt,
  declaredKeys: readonly string[]
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of declaredKeys) {
    const separated = splitOperationKey(key);
    if (separated === null || separated.method !== attempt.method) {
      continue;
    }
    const distance = routeDistance(attempt.path, separated.path);
    if (distance === null) {
      continue;
    }
    if (
      distance < bestDistance ||
      (distance === bestDistance && (best ?? "") > key)
    ) {
      best = key;
      bestDistance = distance;
    }
  }
  return best;
}

function splitOperationKey(
  key: string
): { method: string; path: string } | null {
  const prefixless = key.startsWith("path:") ? key.slice("path:".length) : null;
  if (prefixless === null) {
    return null;
  }
  const divider = prefixless.indexOf(" ");
  if (divider === -1) {
    return null;
  }
  return {
    method: prefixless.slice(0, divider),
    path: prefixless.slice(divider + 1)
  };
}

function routeDistance(a: string, b: string): number | null {
  const as = routeSegments(a);
  const bs = routeSegments(b);
  if (as.length !== bs.length) {
    return null;
  }
  let differing = 0;
  for (let index = 0; index < as.length; index += 1) {
    if (as[index] !== bs[index]) {
      differing += 1;
    }
  }
  return differing;
}

function routeSegments(path: string): string[] {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment !== "");
}

// ---------------------------------------------------------------------------
// Sequence-level detectors
// ---------------------------------------------------------------------------

/**
 * Escalation: a non-2xx attempt followed by a 2xx attempt whose request
 * value differs. Distinct fingerprints catch retries the shape
 * descriptor cannot see, for example keys changing from one value to
 * another inside an otherwise identical body.
 */
function detectEscalation(
  key: string,
  attempts: readonly Attempt[],
  seeds: Map<string, IncidentSeed>
): void {
  if (!attempts.some((attempt) => attempt.matched)) {
    return;
  }
  const failedFingerprints = new Set<string>();
  let failures = 0;
  for (const attempt of attempts) {
    if (!attempt.is2xx) {
      failedFingerprints.add(attempt.fingerprint);
      failures += 1;
      continue;
    }
    const changed = [...failedFingerprints].some(
      (fingerprint) => fingerprint !== attempt.fingerprint
    );
    if (!changed || failures === 0) {
      return;
    }
    // An external exchange answers with the real service, so its content
    // counts as authored: the rejections stay spec friction and no
    // fixture is asked for.
    const authored =
      attempt.external ||
      attempt.provenance === "fixture" ||
      attempt.provenance === "example";
    const frictionClass = authored ? "spec_friction" : "mock_fidelity";
    // The class is part of the key: an authored ending is spec friction
    // and a generated ending is mock fidelity, and one operation can
    // show both across trials.
    addSeed(seeds, `escalation:${key}:${frictionClass}`, {
      kind: "escalation",
      frictionClass,
      origin: attempt.origin,
      operation: key,
      operationId: attempt.operationId,
      nearMissOf: null,
      rows: [
        evidenceRow(attempt, null, attempt.descriptor, attempt.provenance)
      ],
      trials: [attempt.runId],
      occurrences: 1,
      detail: clamp(
        `The participant retried with different values after ${failures} rejected attempt` +
          `${failures === 1 ? "" : "s"}; the satisfying response was ` +
          (attempt.external
            ? "served by the recorded service"
            : (attempt.provenance ?? "generated")) +
          (authored
            ? `, so the early rejections remain spec friction.`
            : `, not authored.`)
      ),
      action: authored ? "investigate" : "author_fixture",
      summary: authored
        ? clamp(
            `The rejection chain on ${key} ended in authored content; widen what the spec accepts so the search is unnecessary.`
          )
        : clamp(
            `Author a realistic response for ${key} so a generated body never stands in for the resource.`
          ),
      hint: authored
        ? null
        : {
            status: attempt.status ?? 200,
            media_type: attempt.contentType ?? "application/json",
            body_kind: (attempt.contentType ?? "").includes("json")
              ? "json_file"
              : "text_file"
          }
    });
    return;
  }
}

/** Identical retry: the same request repeated while the failure stands. */
function detectIdenticalRetries(
  key: string,
  attempts: readonly Attempt[],
  seeds: Map<string, IncidentSeed>
): void {
  if (!attempts.some((attempt) => attempt.matched)) {
    return;
  }
  const pending = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.is2xx) {
      pending.clear();
      continue;
    }
    if (pending.has(attempt.fingerprint)) {
      addSeed(seeds, `identical_retry:${key}`, {
        kind: "identical_retry",
        frictionClass: "unknown",
        origin: attempt.origin,
        operation: key,
        operationId: attempt.operationId,
        nearMissOf: null,
        rows: [evidenceRow(attempt, attempt.errorCode, attempt.descriptor)],
        trials: [attempt.runId],
        occurrences: 1,
        detail: clamp(
          `The same request was repeated unchanged while the previous failure still stood.`
        ),
        action: "investigate",
        summary: "",
        hint: null
      });
    }
    pending.add(attempt.fingerprint);
  }
}

/**
 * Abandonment: every attempt on the operation failed while later calls
 * elsewhere in the same trial succeeded.
 */
function detectAbandonment(
  key: string,
  attempts: readonly Attempt[],
  max2xxSequence: number,
  seeds: Map<string, IncidentSeed>
): void {
  const first = attempts[0];
  if (first === undefined || !first.matched) {
    return;
  }
  if (attempts.some((attempt) => attempt.is2xx)) {
    return;
  }
  const last = attempts[attempts.length - 1] as Attempt;
  if (!(max2xxSequence > last.sequence)) {
    return;
  }
  addSeed(seeds, `abandonment:${key}`, {
    kind: "abandonment",
    frictionClass: "unknown",
    origin: last.origin,
    operation: key,
    operationId: last.operationId,
    nearMissOf: null,
    rows: [evidenceRow(last, last.errorCode, last.descriptor)],
    trials: [last.runId],
    occurrences: attempts.length,
    detail: clamp(
      `All ${attempts.length} attempt${attempts.length === 1 ? "" : "s"} on ${key} failed while later calls in the same trial succeeded elsewhere.`
    ),
    action: "investigate",
    summary: clamp(
      `Find why the participant gave up on ${key}: the responses it received ended the effort.`
    ),
    hint: null
  });
}

/**
 * Generated handle reuse: a mock-invented value (cursor, resource id)
 * from a 2xx response later used as a path segment or query value. One
 * incident per issuing operation; every reused handle adds evidence
 * rows and one occurrence.
 */
function detectGeneratedHandleReuse(
  attempts: readonly Attempt[],
  seeds: Map<string, IncidentSeed>
): void {
  // Pass one: the first 2xx response that carries each handle issues it.
  const issuers = new Map<string, Attempt>();
  for (const attempt of attempts) {
    if (!attempt.is2xx) {
      continue;
    }
    for (const handle of attempt.responseHandles) {
      if (!issuers.has(handle)) {
        issuers.set(handle, attempt);
      }
    }
  }
  // Pass two: every later request that carries a handle as a path
  // segment or query value cites the issuing exchange as evidence.
  for (const attempt of attempts) {
    const used = distinct([
      ...attempt.path.split("/"),
      ...attempt.queryValues
    ]).filter(
      (value) =>
        issuers.has(value) &&
        (issuers.get(value) as Attempt).sequence < attempt.sequence
    );
    for (const handle of used) {
      const issuer = issuers.get(handle) as Attempt;
      const rows: SeedRow[] = [
        evidenceRow(issuer, null, handle, issuer.provenance),
        evidenceRow(attempt, null, handle)
      ];
      addSeed(seeds, `generated_handle_reuse:${issuer.key}`, {
        kind: "generated_handle_reuse",
        frictionClass: "mock_fidelity",
        origin: issuer.origin,
        operation: issuer.key,
        operationId: issuer.operationId,
        nearMissOf: null,
        rows,
        trials: distinct([issuer.runId, attempt.runId]),
        occurrences: 1,
        detail: clamp(
          `The response value ${handle} was generated by the mock and reused as a request argument.`
        ),
        action: "author_fixture",
        summary: clamp(
          `Author a response for ${issuer.key} with realistic values so generated handles never leak into requests.`
        ),
        hint: {
          status: issuer.status ?? 200,
          media_type: issuer.contentType ?? "application/json",
          body_kind: (issuer.contentType ?? "").includes("json")
            ? "json_file"
            : "text_file"
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function addSeed(
  seeds: Map<string, IncidentSeed>,
  bucket: string,
  seed: IncidentSeed
): void {
  const existing = seeds.get(bucket);
  if (existing === undefined) {
    seeds.set(bucket, seed);
    return;
  }
  existing.rows.push(...seed.rows);
  existing.occurrences += seed.occurrences;
  for (const trial of seed.trials) {
    if (!existing.trials.includes(trial)) {
      existing.trials.push(trial);
    }
  }
}

function evidenceRow(
  attempt: Attempt,
  code: string | null,
  requestShape: string | null,
  provenance: string | null = null
): SeedRow {
  return {
    trial_id: attempt.runId,
    sequence: attempt.sequence,
    status: attempt.status ?? 0,
    code,
    request_shape: requestShape === null ? null : requestShape.slice(0, 512),
    provenance,
    trialIndex: attempt.trialIndex
  };
}

function byFirstEvidence(a: IncidentSeed, b: IncidentSeed): number {
  const first = (seed: IncidentSeed): [number, number] => {
    const row = seed.rows[0];
    return row === undefined
      ? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
      : [row.trialIndex, row.sequence];
  };
  const [aTrial, aSequence] = first(a);
  const [bTrial, bSequence] = first(b);
  return aTrial - bTrial || aSequence - bSequence;
}

/** Drops the internal trial index before the rows leave the builder. */
function publicRow(row: SeedRow): FrictionEvidenceRow {
  return {
    trial_id: row.trial_id,
    sequence: row.sequence,
    status: row.status,
    code: row.code,
    request_shape: row.request_shape,
    provenance: row.provenance
  };
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function incidentIdOf(seed: IncidentSeed): string {
  if (seed.kind === "quota_exceeded" && seed.operation === null) {
    return `inc_quota_exceeded_${slug(seed.trials[0] ?? "trial")}`;
  }
  const base =
    seed.operation === null
      ? seed.kind
      : `${seed.kind}_${slug(stripKeyPrefix(seed.operation))}`;
  // Escalation is the only detector whose class varies on one operation,
  // so its id carries the class to stay unique per incident.
  return seed.kind === "escalation"
    ? `inc_${base}_${seed.frictionClass}`
    : `inc_${base}`;
}

function stripKeyPrefix(key: string): string {
  return key.replace(/^(path|unmatched):/, "");
}

/** Lowercase slug with [a-z0-9_.-] characters only. */
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
  return cleaned === "" ? "op" : cleaned;
}

function clamp(text: string): string {
  return text.length <= DETAIL_MAX_LENGTH
    ? text
    : text.slice(0, DETAIL_MAX_LENGTH);
}

function operationRowOf(
  key: string,
  attempts: readonly Attempt[],
  incidents: readonly IncidentSeed[]
): FrictionOperationRow {
  const descriptors: string[] = [];
  const approximations: string[] = [];
  const codeCounts = new Map<string, number>();
  const statusCounts: Record<string, number> = {};
  const provenanceMix = { fixture: 0, example: 0, generated: 0 };
  for (const attempt of attempts) {
    if (!descriptors.includes(attempt.descriptor)) {
      descriptors.push(attempt.descriptor);
    }
    if (
      attempt.approximation !== null &&
      !approximations.includes(attempt.approximation)
    ) {
      approximations.push(attempt.approximation);
    }
    if (attempt.errorCode !== null && attempt.status !== null) {
      const codeKey = `${attempt.errorCode}@${attempt.status}`;
      codeCounts.set(codeKey, (codeCounts.get(codeKey) ?? 0) + 1);
    }
    const statusKey =
      attempt.status === null ? "unmatched" : String(attempt.status);
    statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
    // An external exchange was served by the recorded service, not the
    // lab mock, so it claims no provenance bucket at all.
    if (attempt.is2xx && !attempt.external) {
      if (attempt.provenance === "fixture") {
        provenanceMix.fixture += 1;
      } else if (attempt.provenance === "example") {
        provenanceMix.example += 1;
      } else {
        provenanceMix.generated += 1;
      }
    }
  }
  const operationId =
    attempts.find((attempt) => attempt.operationId !== null)?.operationId ??
    null;

  const first2xxIndex = attempts.findIndex((attempt) => attempt.is2xx);
  let firstSuccessAttempt: number | null = null;
  if (first2xxIndex !== -1) {
    const trial = (attempts[first2xxIndex] as Attempt).runId;
    firstSuccessAttempt =
      attempts
        .filter((attempt) => attempt.runId === trial)
        .findIndex((attempt) => attempt.is2xx) + 1;
  }

  const frameworkCodes: FrictionFrameworkCodeRow[] = [
    ...codeCounts.entries()
  ].map(([codeKey, count]) => {
    const divider = codeKey.indexOf("@");
    return {
      code: codeKey.slice(0, divider),
      status: Number(codeKey.slice(divider + 1)),
      count
    };
  });

  return {
    operation: key,
    operation_id: operationId,
    attempts: attempts.length,
    status_counts: statusCounts,
    first_success_attempt: firstSuccessAttempt,
    attempts_to_first_2xx: first2xxIndex === -1 ? null : first2xxIndex + 1,
    distinct_request_shapes: descriptors.length,
    shape_descriptors: descriptors.slice(0, FRICTION_MAX_SHAPE_DESCRIPTORS),
    escalated: incidents.some(
      (incident) => incident.operation === key && incident.kind === "escalation"
    ),
    abandoned: incidents.some(
      (incident) =>
        incident.operation === key && incident.kind === "abandonment"
    ),
    identical_retries: incidents
      .filter(
        (incident) =>
          incident.operation === key && incident.kind === "identical_retry"
      )
      .reduce((total, incident) => total + incident.occurrences, 0),
    framework_codes: frameworkCodes.slice(0, FRICTION_MAX_FRAMEWORK_CODES),
    provenance_mix: provenanceMix,
    approximations: approximations.slice(0, FRICTION_MAX_APPROXIMATIONS),
    duration: summarize(attempts.map((attempt) => attempt.durationMs))
  };
}

function buildWorklist(
  incidents: readonly IncidentSeed[]
): FrictionWorklistItem[] {
  const items: FrictionWorklistItem[] = [];
  const byMergeKey = new Map<string, FrictionWorklistItem>();
  for (const incident of incidents) {
    if (incident.origin === "harness") {
      continue;
    }
    if (
      incident.frictionClass === "unknown" &&
      incident.kind !== "abandonment"
    ) {
      continue;
    }
    const mergeKey = `${incident.action}::${incident.operation ?? ""}`;
    const id = `wl_${incident.action}_${slug(
      incident.operation === null ? "batch" : stripKeyPrefix(incident.operation)
    )}`;
    const existing = byMergeKey.get(mergeKey);
    if (existing !== undefined) {
      if (!existing.incident_ids.includes(incidentIdOf(incident))) {
        existing.incident_ids.push(incidentIdOf(incident));
      }
      continue;
    }
    const item: FrictionWorklistItem = {
      id,
      incident_ids: [incidentIdOf(incident)],
      operation: incident.operation,
      action: incident.action,
      summary: incident.summary === "" ? incident.detail : incident.summary,
      ...(incident.hint !== null && incident.action === "author_fixture"
        ? { fixture: incident.hint }
        : {}),
      requires_behavior_backend: incident.action === "requires_behavior_backend"
    };
    byMergeKey.set(mergeKey, item);
    items.push(item);
  }
  return items;
}
