/**
 * Control-plane lifecycle events (specification section 33.1). Each
 * trial owns one append-only lifecycle.jsonl that records every
 * internal event family behind a stable envelope. Payloads stay
 * bounded: identifiers are validated, free text is capped, and
 * credential-shaped values are rejected. Control-plane events never
 * reach the participant data plane.
 *
 * The lifecycle.stage family reuses the vocabulary of
 * schemas/lifecycle-event.v1.schema.json (specification section 22.3):
 * stage, evidence source, and bounded details. stageRecord() projects
 * one such event onto that exact record shape.
 */

import {
  formatRfc3339,
  invalidInput,
  isJsonObject,
  isRfc3339,
  isSafeId,
  isSafeRelativePath,
  isSha256Hex,
  sequenceId,
  type DiagnosticPhase,
  type DiagnosticSeverity,
  type Json
} from "@oal/core";
import { isCredentialShape } from "./redaction.ts";
import type { JsonlSink } from "./trace.ts";

/** Trial-local stream name from section 24.1. */
export const LIFECYCLE_STREAM_NAME = "lifecycle.jsonl";

/** Event id prefix; ids are lif_ plus a zero-padded sequence. */
export const LIFECYCLE_EVENT_ID_PREFIX = "lif";

/** Maximum length of one bounded free-text field. */
export const MAX_TEXT_LENGTH = 200;

/** Maximum detail entries on one lifecycle.stage record. */
export const MAX_DETAIL_ENTRIES = 32;

/** Maximum length of one detail key. */
export const MAX_DETAIL_KEY_LENGTH = 64;

/** Maximum length of one detail string value. */
export const MAX_DETAIL_TEXT_LENGTH = 128;

/** Stable error code for every lifecycle builder rejection. */
export const LIFECYCLE_INVALID_FIELD = "OAL-LIFECYCLE-INVALID-FIELD";

/** Durable trial stages (specification section 22.3). */
export type LifecycleStage =
  | "scheduled"
  | "workspace_prepared"
  | "server_ready"
  | "participant_spawned"
  | "model_started"
  | "participant_control_started"
  | "api_started"
  | "turn_completed"
  | "report_present"
  | "report_valid"
  | "operator_signal_received"
  | "finalization_started"
  | "evidence_finalized";

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  "scheduled",
  "workspace_prepared",
  "server_ready",
  "participant_spawned",
  "model_started",
  "participant_control_started",
  "api_started",
  "turn_completed",
  "report_present",
  "report_valid",
  "operator_signal_received",
  "finalization_started",
  "evidence_finalized"
];

/** Producers that can observe one stage (section 22.3). */
export type LifecycleEvidenceSource =
  | "runner"
  | "adapter"
  | "gateway"
  | "evaluator"
  | "filesystem"
  | "operator"
  | "state_store";

export const LIFECYCLE_EVIDENCE_SOURCES: readonly LifecycleEvidenceSource[] = [
  "runner",
  "adapter",
  "gateway",
  "evaluator",
  "filesystem",
  "operator",
  "state_store"
];

/** Detail values allowed by schemas/lifecycle-event.v1.schema.json. */
export type LifecycleDetailValue = string | number | boolean | null;

export type LifecycleDetails = Readonly<Record<string, LifecycleDetailValue>>;

/** Terminal dispositions (specification section 22.4). */
export type TerminalDisposition =
  | "completed"
  | "agent_incomplete"
  | "agent_failed"
  | "timed_out"
  | "budget_exhausted"
  | "operator_interrupted"
  | "provider_failed_pre_control"
  | "provider_failed_post_control"
  | "infrastructure_failed_pre_control"
  | "infrastructure_failed_post_control"
  | "harness_aborted"
  | "not_started"
  | "invalid_setup";

/** Evidence integrity flags carried by terminal records (section 22.4). */
export type EvidenceIntegrityFlag = "intact" | "corrupt" | "missing";

/** Resource limits the runner enforces independently (section 22.3). */
export type ResourceLimitName =
  | "wall_time_ms"
  | "tool_calls"
  | "requests"
  | "tokens"
  | "disk_bytes"
  | "processes";

/** Deterministic check outcomes (section 33.2). */
export type CheckStatus = "pass" | "fail" | "error" | "skipped";

/** Agent session channels, shared with the agent event stream. */
export type AgentSessionChannel = "stdout" | "stderr" | "jsonrpc" | "adapter";

export interface RunCreatedPayload {
  run_id: string;
  retry_of: string | null;
}

export interface RunStartedPayload {
  started_at: string;
  adapter: string;
  model: string | null;
}

export interface RunCancelledPayload {
  reason_code: string;
  signal: string | null;
}

export interface RunFinishedPayload {
  disposition: TerminalDisposition;
  evidence_integrity: EvidenceIntegrityFlag;
  duration_ms: number;
}

export interface CompilerDiagnosticPayload {
  severity: DiagnosticSeverity;
  phase: DiagnosticPhase;
  code: string;
  message: string;
}

export interface MockStartedPayload {
  port: number | null;
  documentation_facade: boolean;
}

export interface MockStoppedPayload {
  graceful: boolean;
}

export interface AgentStartedPayload {
  adapter: string;
  model: string | null;
  sandbox: string | null;
}

export interface AgentSessionEventPayload {
  channel: AgentSessionChannel;
  redacted: boolean;
  bytes: number | null;
  kind: string | null;
}

export interface AgentExitedPayload {
  exit_code: number | null;
  signal: string | null;
  graceful: boolean;
}

export interface ProcessTerminatedPayload {
  pid: number;
  signal: string | null;
  exit_code: number | null;
  forced: boolean;
}

export interface SandboxDenialPayload {
  tool: string | null;
  policy: string;
}

export interface ResourceLimitReachedPayload {
  limit: ResourceLimitName;
  observed: number;
  ceiling: number;
}

export interface EvaluatorStartedPayload {
  eval_id: string | null;
  case_count: number;
}

export interface EvaluatorCheckPayload {
  check_id: string;
  status: CheckStatus;
}

export interface EvaluatorFinishedPayload {
  status: CheckStatus;
  case_count: number;
  checks_total: number;
  checks_failed: number;
}

export interface ArtifactFinalizedPayload {
  manifest_path: string;
  entries: number;
  manifest_sha256: string | null;
}

export interface LifecycleStagePayload {
  stage: LifecycleStage;
  recorded_at: string;
  evidence_source: LifecycleEvidenceSource;
  details: Record<string, LifecycleDetailValue>;
}

export interface AssignmentActivatedPayload {
  assignment_id: string;
  run_id: string | null;
  replacement_of: string | null;
}

export interface AssignmentFinishedPayload {
  assignment_id: string;
  run_id: string | null;
  disposition: TerminalDisposition;
  evidence_integrity: EvidenceIntegrityFlag;
}

export interface StudyAbortedPayload {
  study_run_id: string;
  reason_code: string;
}

export interface StudyFinishedPayload {
  study_run_id: string;
  completed: number;
  aborted: number;
  failed: number;
}

/** Family name to payload type map; the record union derives from it. */
export interface LifecyclePayloads {
  "run.created": RunCreatedPayload;
  "run.started": RunStartedPayload;
  "run.cancelled": RunCancelledPayload;
  "run.finished": RunFinishedPayload;
  "compiler.diagnostic": CompilerDiagnosticPayload;
  "mock.started": MockStartedPayload;
  "mock.stopped": MockStoppedPayload;
  "agent.started": AgentStartedPayload;
  "agent.session_event": AgentSessionEventPayload;
  "agent.exited": AgentExitedPayload;
  "process.terminated": ProcessTerminatedPayload;
  "sandbox.denial": SandboxDenialPayload;
  "resource.limit_reached": ResourceLimitReachedPayload;
  "evaluator.started": EvaluatorStartedPayload;
  "evaluator.check": EvaluatorCheckPayload;
  "evaluator.finished": EvaluatorFinishedPayload;
  "artifact.finalized": ArtifactFinalizedPayload;
  "lifecycle.stage": LifecycleStagePayload;
  "assignment.activated": AssignmentActivatedPayload;
  "assignment.finished": AssignmentFinishedPayload;
  "study.aborted": StudyAbortedPayload;
  "study.finished": StudyFinishedPayload;
}

/** Every internal event family from section 33.1. */
export type LifecycleEventType = keyof LifecyclePayloads;

export const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[] = [
  "run.created",
  "run.started",
  "run.cancelled",
  "run.finished",
  "compiler.diagnostic",
  "mock.started",
  "mock.stopped",
  "agent.started",
  "agent.session_event",
  "agent.exited",
  "process.terminated",
  "sandbox.denial",
  "resource.limit_reached",
  "evaluator.started",
  "evaluator.check",
  "evaluator.finished",
  "artifact.finalized",
  "lifecycle.stage",
  "assignment.activated",
  "assignment.finished",
  "study.aborted",
  "study.finished"
];

/** Fields carried by every lifecycle record. */
export interface LifecycleEnvelope {
  schema_version: 1;
  event_id: string;
  sequence: number;
  observed_at: string;
  batch_id: string | null;
  run_id: string | null;
}

export interface LifecycleEventRecord<Type extends LifecycleEventType>
  extends LifecycleEnvelope {
  type: Type;
  payload: LifecyclePayloads[Type];
}

export type LifecycleEvent = {
  [Type in LifecycleEventType]: LifecycleEventRecord<Type>;
}[LifecycleEventType];

/** Builder output: one family payload plus an optional timestamp. */
export interface LifecycleEventDraft<Type extends LifecycleEventType> {
  type: Type;
  observed_at?: string | undefined;
  payload: LifecyclePayloads[Type];
}

/** Optional observation time shared by every builder input. */
export interface LifecycleObserved {
  observed_at?: string | undefined;
}

/** Batch and run scope stamped on every record of one stream. */
export interface LifecycleScope {
  batch_id?: string | null;
  run_id?: string | null;
}

interface ResolvedScope {
  batch_id: string | null;
  run_id: string | null;
}

/**
 * Trial-local lifecycle stream. Records append in observation order and
 * carry monotonically increasing sequences with lif_ prefixed ids, the
 * same allocation pattern as the trace event stream.
 */
export class LifecycleStream {
  private nextSequence = 1;

  private constructor(
    private readonly sink: JsonlSink,
    private readonly scope: ResolvedScope
  ) {}

  static open(sink: JsonlSink, scope?: LifecycleScope): LifecycleStream {
    return new LifecycleStream(sink, {
      batch_id: requireOptionalId(scope?.batch_id, "batch_id"),
      run_id: requireOptionalId(scope?.run_id, "run_id")
    });
  }

  /** Stamp, append, and return one control-plane record. */
  async emit<Type extends LifecycleEventType>(
    draft: LifecycleEventDraft<Type>
  ): Promise<LifecycleEventRecord<Type>> {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const event: LifecycleEventRecord<Type> = {
      schema_version: 1,
      type: draft.type,
      event_id: sequenceId(LIFECYCLE_EVENT_ID_PREFIX, sequence),
      sequence,
      observed_at: draft.observed_at ?? formatRfc3339(Date.now()),
      batch_id: this.scope.batch_id,
      run_id: this.scope.run_id,
      payload: draft.payload
    };
    await this.sink.appendJson(event as unknown as Json);
    return event;
  }
}

/** The exact record shape of schemas/lifecycle-event.v1.schema.json. */
export interface LifecycleStageRecord {
  schema_version: 1;
  sequence: number;
  stage: LifecycleStage;
  recorded_at: string;
  evidence_source: LifecycleEvidenceSource;
  details: Record<string, LifecycleDetailValue>;
}

/**
 * Project one lifecycle.stage event onto the section 22.3 trial ledger
 * record, which validates against lifecycle-event.v1.schema.json.
 */
export function stageRecord(
  event: LifecycleEventRecord<"lifecycle.stage">
): LifecycleStageRecord {
  return {
    schema_version: 1,
    sequence: event.sequence,
    stage: event.payload.stage,
    recorded_at: event.payload.recorded_at,
    evidence_source: event.payload.evidence_source,
    details: { ...event.payload.details }
  };
}

/** Type guard for records read back from lifecycle.jsonl. */
export function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1 || typeof record.type !== "string") {
    return false;
  }
  if (!LIFECYCLE_EVENT_TYPES.includes(record.type as LifecycleEventType)) {
    return false;
  }
  if (
    typeof record.event_id !== "string" ||
    typeof record.sequence !== "number"
  ) {
    return false;
  }
  if (
    typeof record.observed_at !== "string" ||
    !isRfc3339(record.observed_at)
  ) {
    return false;
  }
  if (record.batch_id !== null && typeof record.batch_id !== "string") {
    return false;
  }
  if (record.run_id !== null && typeof record.run_id !== "string") {
    return false;
  }
  return isJsonObject(record.payload as Json);
}

function reject(field: string, message: string): never {
  throw invalidInput(LIFECYCLE_INVALID_FIELD, `${field} ${message}`, { field });
}

function requireOptionalId(
  value: string | null | undefined,
  field: string
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isSafeId(value)) {
    reject(field, "is not a safe identifier");
  }
  return value;
}

function requireId(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || !isSafeId(value)) {
    reject(field, "is not a safe identifier");
  }
  return value;
}

function boundedText(value: string, field: string, maxLength: number): string {
  if (isCredentialShape(value)) {
    reject(field, "looks like credential material");
  }
  return value.slice(0, maxLength);
}

function requireCode(value: string, field: string): string {
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(value)) {
    reject(field, "is not a stable code");
  }
  return value;
}

function requireName(value: string, field: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    reject(field, "is not a stable name");
  }
  return value;
}

function requireSignal(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[A-Z0-9]{1,16}$/.test(value)) {
    reject(field, "is not a signal name");
  }
  return value;
}

function requireTimestamp(value: string, field: string): string {
  if (!isRfc3339(value)) {
    reject(field, "is not an RFC 3339 UTC timestamp");
  }
  return value;
}

function requireRelativePath(value: string, field: string): string {
  if (!isSafeRelativePath(value)) {
    reject(field, "is not a safe relative artifact path");
  }
  return value;
}

function requireDigest(value: string | null, field: string): string | null {
  if (value !== null && !isSha256Hex(value)) {
    reject(field, "is not a sha256 digest");
  }
  return value;
}

function requireCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(field, "is not a non-negative integer");
  }
  return value;
}

function requirePort(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    reject(field, "is not a port number");
  }
  return value;
}

function requireDetails(
  details: LifecycleDetails,
  field: string
): Record<string, LifecycleDetailValue> {
  const keys = Object.keys(details);
  if (keys.length > MAX_DETAIL_ENTRIES) {
    reject(field, `has more than ${MAX_DETAIL_ENTRIES} entries`);
  }
  const out: Record<string, LifecycleDetailValue> = {};
  for (const key of keys.sort()) {
    if (key.length === 0 || key.length > MAX_DETAIL_KEY_LENGTH) {
      reject(`${field}.${key}`, "is not a bounded detail key");
    }
    const value = details[key];
    if (typeof value === "string") {
      out[key] = boundedText(value, `${field}.${key}`, MAX_DETAIL_TEXT_LENGTH);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        reject(`${field}.${key}`, "is not an integer");
      }
      out[key] = value;
      continue;
    }
    if (typeof value !== "boolean" && value !== null) {
      reject(`${field}.${key}`, "is not a string, integer, boolean, or null");
    }
    out[key] = value;
  }
  return out;
}

export function runCreated(
  input: {
    run_id: string;
    retry_of?: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"run.created"> {
  return {
    type: "run.created",
    observed_at: input.observed_at,
    payload: {
      run_id: requireId(input.run_id, "run_id"),
      retry_of: requireOptionalId(input.retry_of, "retry_of")
    }
  };
}

export function runStarted(
  input: {
    started_at: string;
    adapter: string;
    model: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"run.started"> {
  return {
    type: "run.started",
    observed_at: input.observed_at,
    payload: {
      started_at: requireTimestamp(input.started_at, "started_at"),
      adapter: requireName(input.adapter, "adapter"),
      model: input.model === null ? null : boundedText(input.model, "model", 64)
    }
  };
}

export function runCancelled(
  input: {
    reason_code: string;
    signal?: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"run.cancelled"> {
  return {
    type: "run.cancelled",
    observed_at: input.observed_at,
    payload: {
      reason_code: requireCode(input.reason_code, "reason_code"),
      signal: requireSignal(input.signal ?? null, "signal")
    }
  };
}

export function runFinished(
  input: {
    disposition: TerminalDisposition;
    evidence_integrity: EvidenceIntegrityFlag;
    duration_ms: number;
  } & LifecycleObserved
): LifecycleEventDraft<"run.finished"> {
  return {
    type: "run.finished",
    observed_at: input.observed_at,
    payload: {
      disposition: input.disposition,
      evidence_integrity: input.evidence_integrity,
      duration_ms: requireCount(input.duration_ms, "duration_ms")
    }
  };
}

export function compilerDiagnostic(
  input: {
    severity: DiagnosticSeverity;
    phase: DiagnosticPhase;
    code: string;
    message: string;
  } & LifecycleObserved
): LifecycleEventDraft<"compiler.diagnostic"> {
  return {
    type: "compiler.diagnostic",
    observed_at: input.observed_at,
    payload: {
      severity: input.severity,
      phase: input.phase,
      code: requireCode(input.code, "code"),
      message: boundedText(input.message, "message", MAX_TEXT_LENGTH)
    }
  };
}

export function mockStarted(
  input: {
    port: number | null;
    documentation_facade: boolean;
  } & LifecycleObserved
): LifecycleEventDraft<"mock.started"> {
  return {
    type: "mock.started",
    observed_at: input.observed_at,
    payload: {
      port: requirePort(input.port, "port"),
      documentation_facade: input.documentation_facade
    }
  };
}

export function mockStopped(
  input: {
    graceful: boolean;
  } & LifecycleObserved
): LifecycleEventDraft<"mock.stopped"> {
  return {
    type: "mock.stopped",
    observed_at: input.observed_at,
    payload: { graceful: input.graceful }
  };
}

export function agentStarted(
  input: {
    adapter: string;
    model: string | null;
    sandbox: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"agent.started"> {
  return {
    type: "agent.started",
    observed_at: input.observed_at,
    payload: {
      adapter: requireName(input.adapter, "adapter"),
      model:
        input.model === null ? null : boundedText(input.model, "model", 64),
      sandbox:
        input.sandbox === null
          ? null
          : boundedText(input.sandbox, "sandbox", 64)
    }
  };
}

export function agentSessionEvent(
  input: {
    channel: AgentSessionChannel;
    redacted: boolean;
    bytes: number | null;
    kind: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"agent.session_event"> {
  return {
    type: "agent.session_event",
    observed_at: input.observed_at,
    payload: {
      channel: input.channel,
      redacted: input.redacted,
      bytes: input.bytes === null ? null : requireCount(input.bytes, "bytes"),
      kind: input.kind === null ? null : requireName(input.kind, "kind")
    }
  };
}

export function agentExited(
  input: {
    exit_code: number | null;
    signal: string | null;
    graceful: boolean;
  } & LifecycleObserved
): LifecycleEventDraft<"agent.exited"> {
  return {
    type: "agent.exited",
    observed_at: input.observed_at,
    payload: {
      exit_code:
        input.exit_code === null
          ? null
          : requireCount(input.exit_code, "exit_code"),
      signal: requireSignal(input.signal, "signal"),
      graceful: input.graceful
    }
  };
}

export function processTerminated(
  input: {
    pid: number;
    signal: string | null;
    exit_code: number | null;
    forced: boolean;
  } & LifecycleObserved
): LifecycleEventDraft<"process.terminated"> {
  return {
    type: "process.terminated",
    observed_at: input.observed_at,
    payload: {
      pid: requireCount(input.pid, "pid"),
      signal: requireSignal(input.signal, "signal"),
      exit_code:
        input.exit_code === null
          ? null
          : requireCount(input.exit_code, "exit_code"),
      forced: input.forced
    }
  };
}

export function sandboxDenial(
  input: {
    tool: string | null;
    policy: string;
  } & LifecycleObserved
): LifecycleEventDraft<"sandbox.denial"> {
  return {
    type: "sandbox.denial",
    observed_at: input.observed_at,
    payload: {
      tool: input.tool === null ? null : requireName(input.tool, "tool"),
      policy: requireName(input.policy, "policy")
    }
  };
}

export function resourceLimitReached(
  input: {
    limit: ResourceLimitName;
    observed: number;
    ceiling: number;
  } & LifecycleObserved
): LifecycleEventDraft<"resource.limit_reached"> {
  return {
    type: "resource.limit_reached",
    observed_at: input.observed_at,
    payload: {
      limit: input.limit,
      observed: requireCount(input.observed, "observed"),
      ceiling: requireCount(input.ceiling, "ceiling")
    }
  };
}

export function evaluatorStarted(
  input: {
    eval_id: string | null;
    case_count: number;
  } & LifecycleObserved
): LifecycleEventDraft<"evaluator.started"> {
  return {
    type: "evaluator.started",
    observed_at: input.observed_at,
    payload: {
      eval_id: requireOptionalId(input.eval_id, "eval_id"),
      case_count: requireCount(input.case_count, "case_count")
    }
  };
}

export function evaluatorCheck(
  input: {
    check_id: string;
    status: CheckStatus;
  } & LifecycleObserved
): LifecycleEventDraft<"evaluator.check"> {
  return {
    type: "evaluator.check",
    observed_at: input.observed_at,
    payload: {
      check_id: requireName(input.check_id, "check_id"),
      status: input.status
    }
  };
}

export function evaluatorFinished(
  input: {
    status: CheckStatus;
    case_count: number;
    checks_total: number;
    checks_failed: number;
  } & LifecycleObserved
): LifecycleEventDraft<"evaluator.finished"> {
  return {
    type: "evaluator.finished",
    observed_at: input.observed_at,
    payload: {
      status: input.status,
      case_count: requireCount(input.case_count, "case_count"),
      checks_total: requireCount(input.checks_total, "checks_total"),
      checks_failed: requireCount(input.checks_failed, "checks_failed")
    }
  };
}

export function artifactFinalized(
  input: {
    manifest_path: string;
    entries: number;
    manifest_sha256: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"artifact.finalized"> {
  return {
    type: "artifact.finalized",
    observed_at: input.observed_at,
    payload: {
      manifest_path: requireRelativePath(input.manifest_path, "manifest_path"),
      entries: requireCount(input.entries, "entries"),
      manifest_sha256: requireDigest(input.manifest_sha256, "manifest_sha256")
    }
  };
}

export function lifecycleStage(
  input: {
    stage: LifecycleStage;
    recorded_at: string;
    evidence_source: LifecycleEvidenceSource;
    details: LifecycleDetails;
  } & LifecycleObserved
): LifecycleEventDraft<"lifecycle.stage"> {
  return {
    type: "lifecycle.stage",
    observed_at: input.observed_at,
    payload: {
      stage: input.stage,
      recorded_at: requireTimestamp(input.recorded_at, "recorded_at"),
      evidence_source: input.evidence_source,
      details: requireDetails(input.details, "details")
    }
  };
}

export function assignmentActivated(
  input: {
    assignment_id: string;
    run_id: string | null;
    replacement_of: string | null;
  } & LifecycleObserved
): LifecycleEventDraft<"assignment.activated"> {
  return {
    type: "assignment.activated",
    observed_at: input.observed_at,
    payload: {
      assignment_id: requireId(input.assignment_id, "assignment_id"),
      run_id: requireOptionalId(input.run_id, "run_id"),
      replacement_of: requireOptionalId(input.replacement_of, "replacement_of")
    }
  };
}

export function assignmentFinished(
  input: {
    assignment_id: string;
    run_id: string | null;
    disposition: TerminalDisposition;
    evidence_integrity: EvidenceIntegrityFlag;
  } & LifecycleObserved
): LifecycleEventDraft<"assignment.finished"> {
  return {
    type: "assignment.finished",
    observed_at: input.observed_at,
    payload: {
      assignment_id: requireId(input.assignment_id, "assignment_id"),
      run_id: requireOptionalId(input.run_id, "run_id"),
      disposition: input.disposition,
      evidence_integrity: input.evidence_integrity
    }
  };
}

export function studyAborted(
  input: {
    study_run_id: string;
    reason_code: string;
  } & LifecycleObserved
): LifecycleEventDraft<"study.aborted"> {
  return {
    type: "study.aborted",
    observed_at: input.observed_at,
    payload: {
      study_run_id: requireId(input.study_run_id, "study_run_id"),
      reason_code: requireCode(input.reason_code, "reason_code")
    }
  };
}

export function studyFinished(
  input: {
    study_run_id: string;
    completed: number;
    aborted: number;
    failed: number;
  } & LifecycleObserved
): LifecycleEventDraft<"study.finished"> {
  return {
    type: "study.finished",
    observed_at: input.observed_at,
    payload: {
      study_run_id: requireId(input.study_run_id, "study_run_id"),
      completed: requireCount(input.completed, "completed"),
      aborted: requireCount(input.aborted, "aborted"),
      failed: requireCount(input.failed, "failed")
    }
  };
}
