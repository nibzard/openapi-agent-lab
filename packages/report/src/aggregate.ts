/**
 * Report aggregation (specification sections 27.1 through 27.4).
 *
 * The builder is a pure function of its inputs: one scope, the trial
 * evidence streams, and the trial evaluations. Timestamps, digests, and
 * outcomes come from the evidence; no clock, randomness, or environment
 * read is involved. Ordering is explicit everywhere: trials are
 * processed in run identifier order and every count map is emitted in
 * its enumeration order or sorted key order, so two builds from the
 * same inputs produce byte-identical canonical JSON.
 *
 * Independent outcome axes (section 27.1) never collapse into one
 * boolean: disposition, evidence integrity, censor class, task outcome,
 * and participant report status are counted separately.
 */

import {
  SAFE_ID_PATTERN,
  canonicalJson,
  canonicalJsonSha256,
  isSha256Hex,
  sha256Hex,
  type Json
} from "@oal/core";
import {
  classifyEvidenceIntegrity,
  integrityFlag,
  type DocumentationExchange,
  type IntegrityInput,
  type LifecycleEvent,
  type LifecycleStage,
  type SemanticEvent,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import type { Evaluation } from "@oal/evaluator";
import {
  MIN_N_FOR_P95,
  quantile,
  summarize,
  weightedMean,
  wilsonInterval
} from "@oal/statistics";
import {
  DISPOSITIONS,
  DOCUMENTATION_OUTCOMES,
  REPORT_BUILDER_IDENTITY,
  REPORT_LIFECYCLE_STAGES,
  type CensorClass,
  type CellProvenance,
  type Disposition,
  type EvidenceIntegrity,
  type FirstDiscoveryEntry,
  type ParticipantReportStatus,
  type Report,
  type ReportLifecycleStage,
  type ReportMetric,
  type ReportScope,
  type ReportWarning,
  type ReportWarningKind,
  type SensitivityEstimate,
  type SequenceVariant,
  type TaskOutcome,
  type UsageDistribution
} from "./model.ts";
import {
  enforceReportRedaction,
  redactSummary,
  type SummaryRedactionContext
} from "./redact.ts";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUS_KEY_PATTERN = /^[1-5][0-9][0-9]$/;
const SEMANTIC_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Trial stages that prove the participant was active. */
const ACTIVE_TRIAL_STAGES: ReadonlySet<LifecycleStage> = new Set([
  "model_started",
  "participant_control_started",
  "api_started",
  "turn_completed",
  "report_present",
  "report_valid"
]);

/** Dispositions that mark a failed trial rather than a clean finish. */
const FAILURE_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  "agent_incomplete",
  "agent_failed",
  "timed_out",
  "budget_exhausted",
  "operator_interrupted",
  "provider_failed_pre_control",
  "provider_failed_post_control",
  "infrastructure_failed_pre_control",
  "infrastructure_failed_post_control",
  "harness_aborted",
  "invalid_setup"
]);

/** Required denominator set of section 27.3. */
export interface Denominators {
  primary_assignment_count: number;
  activated_replacement_count: number;
  operational_assignment_count: number;
  launched_trial_count: number;
  not_started_count: number;
  participant_control_started_count: number;
  primary_agent_outcome_count: number;
  api_behavior_count: number;
  task_evaluation_count: number;
  report_agreement_count: number;
  usage_observed_count: number;
  valid_evaluation_count: number;
  held_unused_count: number;
}

/** Usage dimensions with only observed values (section 27.3). */
export interface TrialUsageInput {
  readonly tokens?: number | null | undefined;
  readonly tool_calls?: number | null | undefined;
  readonly provider_cost?: number | null | undefined;
}

/** Final state digest plus an optional summary to redact. */
export interface TrialFinalStateInput {
  readonly state_sha256: string;
  readonly summary?: Json | undefined;
}

/** One trial's evidence: lifecycle, data plane, and evaluation. */
export interface TrialInput {
  readonly run_id: string;
  readonly evidence_uri: string;
  readonly eval_id?: string | null | undefined;
  readonly assignment_id?: string | null | undefined;
  readonly replacement_of?: string | null | undefined;
  readonly events: readonly LifecycleEvent[];
  readonly trace: readonly TraceEvent[];
  readonly documentation?: readonly DocumentationExchange[] | undefined;
  readonly semantic?: readonly SemanticEvent[] | undefined;
  readonly evaluation?: Evaluation | null | undefined;
  readonly participant_report_status?:
    | ParticipantReportStatus
    | null
    | undefined;
  readonly usage?: TrialUsageInput | null | undefined;
  readonly final_state?: TrialFinalStateInput | null | undefined;
  /** Verification input for integrity reason codes (section 33.3). */
  readonly integrity?: IntegrityInput | undefined;
  /** Final censor class persisted by the runner. */
  readonly censor_class?: CensorClass | undefined;
}

/** Frozen schedule numbers the run evidence cannot know. */
export interface AssignmentTotals {
  readonly primary_assignments?: number | undefined;
  readonly activated_replacements?: number | undefined;
  readonly held_unused?: number | undefined;
  readonly not_started?: number | undefined;
}

export interface ProvenanceInput {
  readonly cells?: readonly CellProvenance[] | undefined;
  readonly implementation?: Readonly<Record<string, string>> | undefined;
  readonly environment_names?: readonly string[] | undefined;
}

export interface ReportBuildInput {
  readonly scope: ReportScope;
  readonly trials: readonly TrialInput[];
  readonly assignment_totals?: AssignmentTotals | undefined;
  readonly provenance?: ProvenanceInput | undefined;
  readonly redaction?: SummaryRedactionContext | undefined;
  readonly extensions?: Readonly<Record<string, Json>> | undefined;
}

/** Per-trial row: pass or fail with score, per eval case. */
export interface TrialRow {
  readonly run_id: string;
  readonly eval_id: string | null;
  readonly assignment_id: string | null;
  readonly replacement_of: string | null;
  readonly disposition: Disposition;
  readonly evidence_integrity: EvidenceIntegrity;
  readonly censor_class: CensorClass;
  readonly launched: boolean;
  readonly participant_control_started: boolean;
  readonly turn_completed: boolean;
  readonly task_outcome: TaskOutcome;
  readonly evaluation_status: string | null;
  readonly score: number | null;
  readonly request_total: number;
  readonly documentation_request_total: number;
}

/** Slot-preserving outcome resolution (sections 27.2 and 27.3). */
export interface SlotResolution {
  readonly slot_id: string;
  readonly attempt_run_ids: readonly string[];
  readonly resolved: boolean;
  readonly source: "primary" | "replacement" | null;
  readonly supplying_run_id: string | null;
  readonly task_outcome: TaskOutcome | null;
  readonly worst_case_failure: boolean;
}

/** Censor class for one attempt, from the section 27.2 table. */
export function censorClassFor(
  disposition: Disposition,
  controlStarted: boolean,
  integrity: "intact" | "corrupt" | "missing"
): CensorClass {
  if (controlStarted && disposition === "operator_interrupted") {
    return "administrative_censor";
  }
  if (controlStarted && integrity !== "intact") {
    return "instrumentation_censor";
  }
  if (!controlStarted) {
    return "pre_control_nonparticipant";
  }
  return "none";
}

/**
 * Task outcome for one evaluation. A failed evaluation with a positive
 * score stays "partial"; an evaluator error is "indeterminate" because
 * an infrastructure error is never a task failure.
 */
export function taskOutcomeFor(
  evaluation: Evaluation | null | undefined
): TaskOutcome {
  if (evaluation === null || evaluation === undefined) {
    return "not_evaluated";
  }
  switch (evaluation.status) {
    case "passed":
      return "passed";
    case "failed":
      return evaluation.score > 0 ? "partial" : "failed";
    case "skipped":
      return "not_evaluated";
    default:
      return "indeterminate";
  }
}

/**
 * Map lifecycle evidence onto the report stage vocabulary. A stage is
 * counted only when the evidence proves it, so the histogram stays
 * derivable from the stream.
 */
export function reportStagesFor(
  events: readonly LifecycleEvent[]
): ReportLifecycleStage[] {
  const observed = new Set<ReportLifecycleStage>();
  for (const event of events) {
    switch (event.type) {
      case "run.created": {
        observed.add("scheduled");
        break;
      }
      case "mock.started": {
        observed.add("server_ready");
        break;
      }
      case "agent.exited": {
        observed.add("participant_exited");
        break;
      }
      case "artifact.finalized": {
        observed.add("evidence_exported");
        break;
      }
      case "evaluator.finished": {
        observed.add("evaluated");
        break;
      }
      case "run.cancelled":
      case "study.aborted": {
        observed.add("aborted");
        break;
      }
      case "run.finished": {
        observed.add("finalized");
        if (FAILURE_DISPOSITIONS.has(event.payload.disposition)) {
          observed.add("failed");
        }
        break;
      }
      case "lifecycle.stage": {
        const stage = event.payload.stage;
        if (stage === "workspace_prepared") {
          observed.add("workspace_prepared");
        } else if (stage === "participant_spawned") {
          observed.add("participant_spawned");
        } else if (stage === "operator_signal_received") {
          observed.add("participant_exiting");
        } else if (stage === "finalization_started") {
          observed.add("finalizing");
        } else if (ACTIVE_TRIAL_STAGES.has(stage)) {
          observed.add("participant_active");
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  return REPORT_LIFECYCLE_STAGES.filter((stage) => observed.has(stage));
}

interface UsageValues {
  readonly tokens: number | null;
  readonly tool_calls: number | null;
  readonly provider_cost: number | null;
  readonly requests: number | null;
  readonly duration_ms: number | null;
}

/** Every derived fact for one trial. */
export interface TrialFacts {
  readonly input: TrialInput;
  readonly row: TrialRow;
  readonly disposition: Disposition;
  readonly integrity: "intact" | "corrupt" | "missing";
  readonly integrityReasons: readonly string[];
  readonly censorClass: CensorClass;
  readonly taskOutcome: TaskOutcome;
  readonly slotTaskOutcome: TaskOutcome;
  readonly eligibleForSlot: boolean;
  readonly participantReportStatus: ParticipantReportStatus;
  readonly participantRequests: readonly TraceEvent[];
  readonly smokeRequests: number;
  readonly durationMs: number | null;
  readonly usage: UsageValues;
}

/** Build the per-trial row and every derived trial fact. */
export function buildTrialFacts(trial: TrialInput): TrialFacts {
  const finished = lastEventOf(trial.events, "run.finished");
  const assignmentFinished = lastEventOf(trial.events, "assignment.finished");
  const disposition: Disposition =
    finished?.payload.disposition ??
    assignmentFinished?.payload.disposition ??
    // Section 32.4: never guess an uncommitted terminal transition.
    "harness_aborted";
  const classification = classifyEvidenceIntegrity(
    trial.integrity ?? { problems: [] }
  );
  const integrityReasons = classification.reason_codes;
  const integrity: "intact" | "corrupt" | "missing" =
    finished?.payload.evidence_integrity ??
    assignmentFinished?.payload.evidence_integrity ??
    (trial.integrity === undefined
      ? "missing"
      : integrityFlag(classification.classification));
  const launched = trial.events.some(
    (event) => event.type === "run.started" || event.type === "agent.started"
  );
  const controlStarted = trial.events.some(
    (event) =>
      event.type === "lifecycle.stage" &&
      event.payload.stage === "participant_control_started"
  );
  const turnCompleted = trial.events.some(
    (event) =>
      event.type === "lifecycle.stage" &&
      event.payload.stage === "turn_completed"
  );
  const censorClass =
    trial.censor_class ??
    censorClassFor(disposition, controlStarted, integrity);
  const evaluation = trial.evaluation ?? null;
  const taskOutcome = taskOutcomeFor(evaluation);
  const eligibleForSlot = controlStarted && censorClass === "none";
  // Section 27.2: a missing or malformed participant report supplies
  // its slot and counts as failure when control started and the
  // required evidence is intact.
  const slotTaskOutcome: TaskOutcome = !eligibleForSlot
    ? "not_evaluated"
    : evaluation === null
      ? "failed"
      : taskOutcome;
  const participantRequests = trial.trace.filter(
    (event) => event.actor === "participant"
  );
  const participantReportStatus = deriveParticipantReportStatus(
    trial,
    turnCompleted
  );
  const usage: UsageValues = {
    tokens: finiteOrNull(trial.usage?.tokens ?? null),
    tool_calls: finiteOrNull(trial.usage?.tool_calls ?? null),
    provider_cost: finiteOrNull(trial.usage?.provider_cost ?? null),
    requests:
      participantRequests.length > 0 ? participantRequests.length : null,
    duration_ms: finished?.payload.duration_ms ?? null
  };
  const row: TrialRow = {
    run_id: trial.run_id,
    eval_id: trial.eval_id ?? null,
    assignment_id: trial.assignment_id ?? null,
    replacement_of: trial.replacement_of ?? null,
    disposition,
    evidence_integrity: integrity,
    censor_class: censorClass,
    launched,
    participant_control_started: controlStarted,
    turn_completed: turnCompleted,
    task_outcome: slotTaskOutcome,
    evaluation_status: evaluation?.status ?? null,
    score: evaluation?.score ?? null,
    request_total: participantRequests.length,
    documentation_request_total:
      trial.documentation?.filter(
        (exchange) => exchange.actor === "participant"
      ).length ?? 0
  };
  return {
    input: trial,
    row,
    disposition,
    integrity,
    integrityReasons,
    censorClass,
    taskOutcome,
    slotTaskOutcome,
    eligibleForSlot,
    participantReportStatus,
    participantRequests,
    smokeRequests: trial.trace.length - participantRequests.length,
    durationMs: usage.duration_ms,
    usage
  };
}

function deriveParticipantReportStatus(
  trial: TrialInput,
  turnCompleted: boolean
): ParticipantReportStatus {
  const explicit = trial.participant_report_status;
  if (explicit !== null && explicit !== undefined) {
    return explicit;
  }
  const stages = trial.events.filter(
    (event): event is Extract<LifecycleEvent, { type: "lifecycle.stage" }> =>
      event.type === "lifecycle.stage"
  );
  if (stages.some((event) => event.payload.stage === "report_valid")) {
    return "valid";
  }
  if (stages.some((event) => event.payload.stage === "report_present")) {
    // Present but never validated: the report schema check failed.
    return "schema_invalid";
  }
  return turnCompleted ? "malformed" : "absent";
}

function finiteOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function lastEventOf<Type extends LifecycleEvent["type"]>(
  events: readonly LifecycleEvent[],
  type: Type
): Extract<LifecycleEvent, { type: Type }> | undefined {
  let found: Extract<LifecycleEvent, { type: Type }> | undefined;
  for (const event of events) {
    if (event.type === type) {
      found = event as Extract<LifecycleEvent, { type: Type }>;
    }
  }
  return found;
}

function warning(
  kind: ReportWarningKind,
  message: string,
  runId: string | null
): ReportWarning {
  return {
    kind,
    message,
    ...(runId === null ? {} : { run_id: runId })
  };
}

function trialWarnings(fact: TrialFacts): ReportWarning[] {
  const warnings: ReportWarning[] = [];
  const runId = fact.row.run_id;
  const reasons =
    fact.integrityReasons.length > 0
      ? fact.integrityReasons.join(", ")
      : "unclassified";
  if (fact.integrity === "missing") {
    warnings.push(
      warning(
        "missing_evidence",
        `evidence missing for ${runId}: ${reasons}`,
        runId
      )
    );
  } else if (fact.integrity === "corrupt") {
    warnings.push(
      warning(
        "corrupt_evidence",
        `evidence corrupt for ${runId}: ${reasons}`,
        runId
      )
    );
  }
  let truncated = 0;
  let approximated = 0;
  for (const event of fact.participantRequests) {
    const bodies: readonly (TraceBody | null)[] = [
      event.request === null ? null : event.request.body,
      event.response === null ? null : event.response.body
    ];
    for (const body of bodies) {
      if (body === null || body.kind === "none") {
        continue;
      }
      if (body.kind === "multipart") {
        for (const part of body.parts) {
          if (
            (part.body.kind === "json" || part.body.kind === "text") &&
            part.body.truncated
          ) {
            truncated += 1;
          }
        }
      } else if (
        (body.kind === "json" || body.kind === "text") &&
        body.truncated
      ) {
        truncated += 1;
      }
    }
    if (event.operation.support === "approximated") {
      approximated += 1;
    }
  }
  if (truncated > 0) {
    warnings.push(
      warning(
        "trace_truncation",
        `${truncated} truncated body capture(s) in ${runId}`,
        runId
      )
    );
  }
  if (approximated > 0) {
    warnings.push(
      warning(
        "approximation",
        `${approximated} request(s) hit an approximated operation in ${runId}`,
        runId
      )
    );
  }
  const denials = fact.input.events.filter(
    (event) => event.type === "sandbox.denial"
  );
  if (denials.length > 0) {
    warnings.push(
      warning(
        "sandbox",
        `${denials.length} sandbox denial(s) in ${runId}`,
        runId
      )
    );
  }
  const limits = new Set<string>();
  for (const event of fact.input.events) {
    if (event.type === "resource.limit_reached") {
      limits.add(event.payload.limit);
    }
  }
  for (const limit of [...limits].sort()) {
    warnings.push(
      warning("other", `resource limit reached in ${runId}: ${limit}`, runId)
    );
  }
  return warnings;
}

/** Resolve every primary analysis slot (section 27.2). */
export function resolveSlots(facts: readonly TrialFacts[]): SlotResolution[] {
  const bySlot = new Map<string, TrialFacts[]>();
  for (const fact of facts) {
    const key = slotKeyOf(fact);
    const bucket = bySlot.get(key);
    if (bucket === undefined) {
      bySlot.set(key, [fact]);
    } else {
      bucket.push(fact);
    }
  }
  const resolutions: SlotResolution[] = [];
  for (const slotId of [...bySlot.keys()].sort()) {
    const ordered = [...(bySlot.get(slotId) ?? [])].sort(compareAttempts);
    const chain: TrialFacts[] = [];
    let supplier: TrialFacts | null = null;
    for (const attempt of ordered) {
      chain.push(attempt);
      if (attempt.eligibleForSlot) {
        supplier = attempt;
        break;
      }
    }
    const worstCaseFailure = chain.some(
      (attempt) =>
        attempt.censorClass === "administrative_censor" ||
        attempt.censorClass === "instrumentation_censor"
    );
    resolutions.push({
      slot_id: slotId,
      attempt_run_ids: ordered.map((attempt) => attempt.row.run_id),
      resolved: supplier !== null,
      source:
        supplier === null
          ? null
          : supplier.row.replacement_of === null
            ? "primary"
            : "replacement",
      supplying_run_id: supplier === null ? null : supplier.row.run_id,
      task_outcome: supplier === null ? null : supplier.slotTaskOutcome,
      // Section 27.2: one worst-case failure per slot whose chain holds
      // a post-control censor before an eligible outcome.
      worst_case_failure: worstCaseFailure
    });
  }
  return resolutions;
}

function slotKeyOf(fact: TrialFacts): string {
  if (fact.row.replacement_of !== null) {
    return fact.row.replacement_of;
  }
  return fact.row.assignment_id ?? `run:${fact.row.run_id}`;
}

/** Per-slot worst-case tally shared by report and study sensitivity. */
export interface WorstCaseSlotTally {
  /** Resolved slots whose eligible outcome passes. */
  readonly successes: number;
  /** Resolved slots whose eligible outcome fails. */
  readonly failures: number;
  /**
   * Resolved slots forced to one failure by a post-control censor in
   * their chain, whatever their eligible outcome says.
   */
  readonly censored_failures: number;
  /** Unresolved slots: no denominator entry, tracked separately. */
  readonly unresolved: number;
  /** Worst-case rate successes / (successes + failures), or null. */
  readonly worst_case_rate: number | null;
}

/**
 * Apply the one-outcome-per-slot worst-case rule of section 27.2 to a
 * resolved slot table. A slot whose chain holds a post-control censor
 * contributes exactly one failure, even when a later replacement
 * passed. Every other resolved slot contributes its eligible outcome.
 * A chain with only pre-control failures stays unresolved and invents
 * no task failure. Each slot enters the tally at most once.
 *
 * The success predicate adapts the shared rule to the caller's
 * outcome: the report passes `task_outcome === "passed"` and the study
 * passes its metric outcome.
 */
export function worstCaseSlotTally(
  slots: readonly SlotResolution[],
  isSuccess: (slot: SlotResolution) => boolean
): WorstCaseSlotTally {
  let successes = 0;
  let failures = 0;
  let censoredFailures = 0;
  let unresolved = 0;
  for (const slot of slots) {
    if (!slot.resolved) {
      unresolved += 1;
      continue;
    }
    if (slot.worst_case_failure) {
      censoredFailures += 1;
      failures += 1;
      continue;
    }
    if (isSuccess(slot)) {
      successes += 1;
    } else {
      failures += 1;
    }
  }
  const total = successes + failures;
  return {
    successes,
    failures,
    censored_failures: censoredFailures,
    unresolved,
    worst_case_rate: total === 0 ? null : successes / total
  };
}

/** Original attempts sort before their replacements. */
function compareAttempts(a: TrialFacts, b: TrialFacts): number {
  const aOriginal = a.row.replacement_of === null ? 0 : 1;
  const bOriginal = b.row.replacement_of === null ? 0 : 1;
  if (aOriginal !== bOriginal) {
    return aOriginal - bOriginal;
  }
  const aId = a.row.assignment_id ?? a.row.run_id;
  const bId = b.row.assignment_id ?? b.row.run_id;
  if (aId !== bId) {
    return aId < bId ? -1 : 1;
  }
  return a.row.run_id < b.row.run_id ? -1 : 1;
}

/** Build the full report document from frozen inputs. */
export function buildReport(input: ReportBuildInput): Report {
  const facts = input.trials
    .map((trial) => buildTrialFacts(trial))
    .sort((a, b) => (a.row.run_id < b.row.run_id ? -1 : 1));
  const slots = resolveSlots(facts);
  const counts = buildCounts(facts, slots, input.assignment_totals);
  const denominators = buildDenominators(facts, slots, counts);
  const metrics = buildMetrics(facts, slots);
  const estimates = buildEstimates(slots);
  const behavior = buildBehavior(facts);
  const surfaces = buildSurfaces(facts, input.redaction);
  // Provenance runs before the warnings are collected so that dropped
  // environment names and other late findings enter the same list.
  const provenance = buildProvenance(input.provenance, behavior.extraWarnings);
  const warnings = collectWarnings(facts, slots, behavior.extraWarnings);

  const extensions: Record<string, Json> = {
    attempt_count: facts.length,
    trials: facts.map((fact) => fact.row as unknown as Json),
    denominators: denominators as unknown as Json,
    participant_report_status: {
      absent: 0,
      malformed: 0,
      schema_invalid: 0,
      valid: 0,
      unavailable_due_to_infrastructure: 0,
      ...countBy(facts, (fact) => fact.participantReportStatus)
    },
    attempt_task_outcomes: countBy(facts, (fact) => fact.taskOutcome),
    slot_resolution: slots.map((slot) => slot as unknown as Json),
    usage_missing: usageMissing(facts),
    smoke_request_total: facts.reduce(
      (total, fact) => total + fact.smokeRequests,
      0
    ),
    documentation_smoke_request_total: behavior.documentationSmokeRequests
  };
  for (const [key, value] of Object.entries(input.extensions ?? {})) {
    extensions[key] = value;
  }

  const report: Report = {
    schema_version: 1,
    kind: "Report",
    scope: { ...input.scope },
    counts,
    metrics,
    estimates,
    behavior: behavior.behavior,
    surfaces,
    provenance,
    warnings,
    extensions
  };
  const secrets = input.redaction?.secrets ?? [];
  return enforceReportRedaction(report, secrets);
}

function countBy(
  facts: readonly TrialFacts[],
  keyOf: (fact: TrialFacts) => string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fact of facts) {
    const key = keyOf(fact);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sortedNumberRecord(counts);
}

function sortedNumberRecord(
  record: Readonly<Record<string, number>>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function collectWarnings(
  facts: readonly TrialFacts[],
  slots: readonly SlotResolution[],
  extra: readonly ReportWarning[]
): ReportWarning[] {
  const warnings: ReportWarning[] = [...extra];
  for (const fact of facts) {
    warnings.push(...trialWarnings(fact));
  }
  const unresolved = slots.filter((slot) => !slot.resolved).length;
  if (unresolved > 0) {
    warnings.push(
      warning(
        "other",
        `${unresolved} primary analysis slot(s) unresolved`,
        null
      )
    );
  }
  const unique = new Map<string, ReportWarning>();
  for (const entry of warnings) {
    const key = `${entry.kind} ${entry.run_id ?? ""} ${entry.message}`;
    if (!unique.has(key)) {
      unique.set(key, entry);
    }
  }
  return [...unique.values()].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.run_id ?? "").localeCompare(b.run_id ?? "") ||
      a.message.localeCompare(b.message)
  );
}

function orderedCounts<Key extends string>(
  counts: Readonly<Partial<Record<Key, number>>>,
  order: readonly Key[]
): Partial<Record<Key, number>> {
  const out: Partial<Record<Key, number>> = {};
  for (const key of order) {
    const value = counts[key];
    if (value !== undefined && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

function buildCounts(
  facts: readonly TrialFacts[],
  slots: readonly SlotResolution[],
  totals: AssignmentTotals | undefined
): Report["counts"] {
  const lifecycleStages: Partial<Record<ReportLifecycleStage, number>> = {};
  const dispositions: Partial<Record<Disposition, number>> = {};
  const integrityCounts: Record<string, number> = {};
  const censorCounts: Record<string, number> = {};
  const taskOutcomes: Record<string, number> = {};
  for (const fact of facts) {
    for (const stage of reportStagesFor(fact.input.events)) {
      lifecycleStages[stage] = (lifecycleStages[stage] ?? 0) + 1;
    }
    dispositions[fact.disposition] = (dispositions[fact.disposition] ?? 0) + 1;
    integrityCounts[fact.integrity] =
      (integrityCounts[fact.integrity] ?? 0) + 1;
    censorCounts[fact.censorClass] = (censorCounts[fact.censorClass] ?? 0) + 1;
  }
  for (const slot of slots) {
    if (slot.resolved && slot.task_outcome !== null) {
      taskOutcomes[slot.task_outcome] =
        (taskOutcomes[slot.task_outcome] ?? 0) + 1;
    }
  }
  const primaryAssignments = totals?.primary_assignments ?? slots.length;
  const activatedReplacements =
    totals?.activated_replacements ??
    facts.filter((fact) => fact.row.replacement_of !== null).length;
  const heldUnused = totals?.held_unused ?? 0;
  const notStarted =
    totals?.not_started ?? countNeverLaunchedPrimaries(facts, slots);
  return {
    primary_assignments: primaryAssignments,
    activated_replacements: activatedReplacements,
    operational_assignments: primaryAssignments + activatedReplacements,
    launched_trials: facts.filter((fact) => fact.row.launched).length,
    held_unused: heldUnused,
    not_started: notStarted,
    lifecycle_stages: orderedCounts(lifecycleStages, REPORT_LIFECYCLE_STAGES),
    dispositions: orderedCounts(dispositions, DISPOSITIONS),
    evidence_integrity: {
      intact: integrityCounts["intact"] ?? 0,
      corrupt: integrityCounts["corrupt"] ?? 0,
      missing: integrityCounts["missing"] ?? 0
    },
    censor_classes: {
      none: censorCounts["none"] ?? 0,
      pre_control_nonparticipant:
        censorCounts["pre_control_nonparticipant"] ?? 0,
      administrative_censor: censorCounts["administrative_censor"] ?? 0,
      instrumentation_censor: censorCounts["instrumentation_censor"] ?? 0
    },
    replacements: {
      activated: activatedReplacements,
      held_unused: heldUnused
    },
    task_outcomes: {
      passed: taskOutcomes["passed"] ?? 0,
      failed: taskOutcomes["failed"] ?? 0,
      partial: taskOutcomes["partial"] ?? 0,
      indeterminate: taskOutcomes["indeterminate"] ?? 0,
      not_evaluated: taskOutcomes["not_evaluated"] ?? 0
    }
  };
}

/** Primaries with no launched original attempt (section 27.3). */
function countNeverLaunchedPrimaries(
  facts: readonly TrialFacts[],
  slots: readonly SlotResolution[]
): number {
  let notStarted = 0;
  for (const slot of slots) {
    const attempts = facts.filter(
      (fact) =>
        slot.attempt_run_ids.includes(fact.row.run_id) &&
        fact.row.replacement_of === null
    );
    if (attempts.length === 0 || attempts.every((fact) => !fact.row.launched)) {
      notStarted += 1;
    }
  }
  return notStarted;
}

function buildDenominators(
  facts: readonly TrialFacts[],
  slots: readonly SlotResolution[],
  counts: Report["counts"]
): Denominators {
  return {
    primary_assignment_count: counts.primary_assignments,
    activated_replacement_count: counts.activated_replacements,
    operational_assignment_count: counts.operational_assignments,
    launched_trial_count: counts.launched_trials,
    not_started_count: counts.not_started,
    participant_control_started_count: facts.filter(
      (fact) => fact.row.participant_control_started
    ).length,
    primary_agent_outcome_count: slots.filter((slot) => slot.resolved).length,
    api_behavior_count: facts.filter(
      (fact) =>
        fact.row.participant_control_started && fact.integrity === "intact"
    ).length,
    task_evaluation_count: facts.filter(
      (fact) =>
        fact.input.evaluation !== null &&
        fact.input.evaluation !== undefined &&
        fact.integrity === "intact"
    ).length,
    report_agreement_count: facts.filter((fact) => fact.row.turn_completed)
      .length,
    usage_observed_count: facts.filter((fact) =>
      [
        fact.usage.tokens,
        fact.usage.tool_calls,
        fact.usage.provider_cost,
        fact.usage.requests,
        fact.usage.duration_ms
      ].some((value) => value !== null)
    ).length,
    valid_evaluation_count: facts.filter((fact) => {
      const evaluation = fact.input.evaluation;
      return (
        evaluation !== null &&
        evaluation !== undefined &&
        evaluation.status !== "error" &&
        evaluation.infrastructure_errors.length === 0
      );
    }).length,
    held_unused_count: counts.held_unused
  };
}

interface CheckRollup {
  readonly passed: number;
  readonly failed: number;
  readonly availability: ReportMetric["availability"];
  readonly reasons: readonly string[];
}

function buildMetrics(
  facts: readonly TrialFacts[],
  slots: readonly SlotResolution[]
): ReportMetric[] {
  const metrics: ReportMetric[] = [];
  const perRun = facts.map((fact) => ({
    run_id: fact.row.run_id,
    evidence_uri: fact.input.evidence_uri
  }));
  const checkIds = new Set<string>();
  const signalIds = new Set<string>();
  for (const fact of facts) {
    const evaluation = fact.input.evaluation;
    if (evaluation === null || evaluation === undefined) {
      continue;
    }
    for (const check of evaluation.checks) {
      checkIds.add(check.id);
    }
    for (const name of Object.keys(evaluation.signals)) {
      signalIds.add(name);
    }
  }

  for (const checkId of [...checkIds].sort()) {
    if (!SAFE_ID_PATTERN.test(checkId)) {
      continue;
    }
    const rollup = rollupCheck(facts, checkId);
    metrics.push({
      id: checkId,
      label: "check",
      numerator: rollup.passed,
      denominator: rollup.passed + rollup.failed,
      availability: rollup.availability,
      reasons: rollup.reasons,
      per_run: perRun
    });
  }

  for (const signalId of [...signalIds].sort()) {
    // A rubric may use one identifier for a check and a signal; the
    // signal keeps its name and the collision gets a suffix.
    const metricId = checkIds.has(signalId) ? `${signalId}_signal` : signalId;
    if (!SAFE_ID_PATTERN.test(metricId)) {
      continue;
    }
    const rollup = rollupSignal(facts, signalId);
    metrics.push({
      id: metricId,
      label: "signal",
      numerator: rollup.numerator,
      denominator: rollup.denominator,
      availability: rollup.availability,
      reasons: rollup.reasons,
      per_run: perRun
    });
  }

  const resolved = slots.filter((slot) => slot.resolved);
  const passed = resolved.filter((slot) => slot.task_outcome === "passed");
  const unresolved = slots.length - resolved.length;
  metrics.push({
    id: "task_pass",
    label: "primary_estimand",
    numerator: passed.length,
    denominator: resolved.length,
    availability: {
      observed: resolved.length,
      unknown: unresolved,
      not_applicable: facts.filter((fact) => !fact.row.launched).length,
      unavailable_due_to_evidence: facts.filter(
        (fact) => fact.row.launched && fact.integrity !== "intact"
      ).length
    },
    reasons: unresolved > 0 ? [`unresolved_slots=${unresolved}`] : [],
    per_run: perRun
  });

  // Section 27.3: report validity uses trials reaching turn_completed.
  const turnCompleted = facts.filter((fact) => fact.row.turn_completed);
  const validReports = turnCompleted.filter(
    (fact) => fact.participantReportStatus === "valid"
  ).length;
  metrics.push({
    id: "report_valid",
    label: "surface_agreement",
    numerator: validReports,
    denominator: turnCompleted.length,
    availability: reportValidityAvailability(facts),
    reasons: [],
    per_run: perRun
  });

  return metrics.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Availability buckets for the section 27.3 report-validity metric.
 * Every attempt lands in exactly one bucket: a never-launched trial is
 * not applicable, a trial that completed its turn is observed, and a
 * launched trial without a completed turn is unavailable when its
 * evidence is not intact and unknown otherwise.
 */
function reportValidityAvailability(
  facts: readonly TrialFacts[]
): ReportMetric["availability"] {
  let observed = 0;
  let unknown = 0;
  let notApplicable = 0;
  let unavailable = 0;
  for (const fact of facts) {
    if (!fact.row.launched) {
      notApplicable += 1;
    } else if (fact.row.turn_completed) {
      observed += 1;
    } else if (fact.integrity !== "intact") {
      unavailable += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    observed,
    unknown,
    not_applicable: notApplicable,
    unavailable_due_to_evidence: unavailable
  };
}

function rollupCheck(
  facts: readonly TrialFacts[],
  checkId: string
): CheckRollup {
  let passed = 0;
  let failed = 0;
  let observed = 0;
  let unknown = 0;
  let notApplicable = 0;
  let unavailable = 0;
  const reasons = new Map<string, number>();
  const addReason = (key: string): void => {
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  };
  for (const fact of facts) {
    if (!fact.row.launched) {
      notApplicable += 1;
      addReason("not_launched");
      continue;
    }
    if (fact.integrity !== "intact") {
      unavailable += 1;
      addReason(`evidence_${fact.integrity}`);
      continue;
    }
    const evaluation = fact.input.evaluation;
    if (evaluation === null || evaluation === undefined) {
      unknown += 1;
      addReason("evaluation_missing");
      continue;
    }
    const check = evaluation.checks.find((entry) => entry.id === checkId);
    if (check === undefined) {
      notApplicable += 1;
      addReason("check_absent");
      continue;
    }
    if (check.status === "passed" || check.status === "failed") {
      observed += 1;
      if (check.status === "passed") {
        passed += 1;
      } else {
        failed += 1;
      }
      continue;
    }
    if (check.status === "skipped") {
      notApplicable += 1;
      addReason("check_skipped");
      continue;
    }
    unknown += 1;
    addReason("check_error");
  }
  return {
    passed,
    failed,
    availability: {
      observed,
      unknown,
      not_applicable: notApplicable,
      unavailable_due_to_evidence: unavailable
    },
    reasons: [...reasons.keys()]
      .sort()
      .map((key) => `${key}=${reasons.get(key) ?? 0}`)
  };
}

interface SignalRollup {
  readonly numerator: number;
  readonly denominator: number;
  readonly availability: ReportMetric["availability"];
  readonly reasons: readonly string[];
}

function rollupSignal(
  facts: readonly TrialFacts[],
  signalId: string
): SignalRollup {
  let numerator = 0;
  let denominator = 0;
  let unknown = 0;
  let notApplicable = 0;
  let unavailable = 0;
  for (const fact of facts) {
    const evaluation = fact.input.evaluation;
    if (!fact.row.launched) {
      notApplicable += 1;
      continue;
    }
    if (fact.integrity !== "intact") {
      unavailable += 1;
      continue;
    }
    if (evaluation === null || evaluation === undefined) {
      unknown += 1;
      continue;
    }
    const value = evaluation.signals[signalId];
    if (value === undefined) {
      notApplicable += 1;
      continue;
    }
    denominator += 1;
    if (value) {
      numerator += 1;
    }
  }
  return {
    numerator,
    denominator,
    availability: {
      observed: denominator,
      unknown,
      not_applicable: notApplicable,
      unavailable_due_to_evidence: unavailable
    },
    reasons: unknown > 0 ? [`evaluation_missing=${unknown}`] : []
  };
}

function buildEstimates(slots: readonly SlotResolution[]): Report["estimates"] {
  const resolved = slots.filter((slot) => slot.resolved);
  const passed = resolved.filter((slot) => slot.task_outcome === "passed");
  const estimate =
    resolved.length === 0 ? null : passed.length / resolved.length;
  const interval = wilsonInterval(passed.length, resolved.length);
  const sensitivity: SensitivityEstimate[] = [];
  // Section 27.2 worst-case sensitivity through the shared slot tally:
  // a post-control censor gives its slot exactly one failure, even when
  // a later replacement passed; unresolved slots join no denominator.
  const tally = worstCaseSlotTally(
    slots,
    (slot) => slot.task_outcome === "passed"
  );
  if (tally.censored_failures > 0 && tally.worst_case_rate !== null) {
    const worstCaseInterval = wilsonInterval(
      tally.successes,
      tally.successes + tally.failures
    );
    sensitivity.push({
      id: "worst_case",
      kind: "worst_case_sensitivity",
      estimate: tally.worst_case_rate,
      interval:
        worstCaseInterval === null
          ? null
          : ([worstCaseInterval.lower, worstCaseInterval.upper] as const)
    });
  }
  return [
    {
      contrast_id: "task_pass",
      estimate,
      interval:
        interval === null ? null : ([interval.lower, interval.upper] as const),
      sensitivity
    }
  ];
}

interface ApiAccumulator {
  request_total: number;
  status_distribution: Map<string, number>;
  operation_frequency: Map<string, number>;
  unknown_endpoints: number;
  wrong_methods: number;
  malformed_requests: number;
  authentication_failures: number;
  invalid_transitions: number;
  retries: number;
  correction_loops: number;
  recoveries_after_error: number;
  first_discovery: FirstDiscoveryEntry[];
  unreportable_operations: number;
  unreportable_statuses: number;
  sequences: string[][];
}

function failedExchange(event: TraceEvent): boolean {
  if (event.error !== null || event.response === null) {
    return true;
  }
  return event.response.status >= 400;
}

function succeededExchange(event: TraceEvent): boolean {
  return (
    event.response !== null &&
    event.response.status >= 200 &&
    event.response.status < 300
  );
}

function operationKeyOf(event: TraceEvent): string {
  const key = event.operation.key;
  if (key !== null) {
    return key;
  }
  if (event.request !== null) {
    return `${event.request.method} ${event.request.path}`;
  }
  return "unknown";
}

/**
 * Analytical API behavior from the trace. Control-actor requests are
 * smoke traffic and never pool into analytical tables (section 27.4);
 * they are counted separately.
 */
function accumulateApi(
  api: ApiAccumulator,
  requests: readonly TraceEvent[],
  runId: string
): void {
  const seenOperations = new Set<string>();
  const sequence: string[] = [];
  let runLength = 0;
  let runHasFailure = false;
  let runHasSuccess = false;
  let previousKey: string | null = null;
  let previousFailed = false;
  for (const event of requests) {
    api.request_total += 1;
    const response = event.response;
    if (response !== null) {
      const key = response.status.toString(10);
      if (STATUS_KEY_PATTERN.test(key)) {
        api.status_distribution.set(
          key,
          (api.status_distribution.get(key) ?? 0) + 1
        );
      } else {
        api.unreportable_statuses += 1;
      }
    }
    const operationId = event.operation.operation_id;
    if (event.operation.matched && operationId !== null) {
      if (OPERATION_ID_PATTERN.test(operationId)) {
        api.operation_frequency.set(
          operationId,
          (api.operation_frequency.get(operationId) ?? 0) + 1
        );
        sequence.push(operationId);
        if (!seenOperations.has(operationId)) {
          seenOperations.add(operationId);
          api.first_discovery.push({
            run_id: runId,
            sequence: event.sequence,
            operation_id: operationId
          });
        }
      } else {
        api.unreportable_operations += 1;
      }
    } else if (event.error?.code === "method_not_allowed") {
      api.wrong_methods += 1;
    } else {
      api.unknown_endpoints += 1;
    }
    if (
      event.error?.code === "request_schema_invalid" ||
      event.error?.layer === "parsing"
    ) {
      api.malformed_requests += 1;
    }
    if (
      event.authentication.status === "rejected" ||
      event.error?.layer === "authentication"
    ) {
      api.authentication_failures += 1;
    }
    if (event.error?.code === "invalid_state") {
      api.invalid_transitions += 1;
    }
    const key = operationKeyOf(event);
    if (previousKey === key) {
      runLength += 1;
      if (previousFailed) {
        api.retries += 1;
        if (succeededExchange(event)) {
          api.recoveries_after_error += 1;
        }
      }
    } else {
      if (runLength >= 3 && runHasFailure && runHasSuccess) {
        api.correction_loops += 1;
      }
      runLength = 1;
      runHasFailure = false;
      runHasSuccess = false;
    }
    runHasFailure = runHasFailure || failedExchange(event);
    runHasSuccess = runHasSuccess || succeededExchange(event);
    previousKey = key;
    previousFailed = failedExchange(event);
  }
  if (runLength >= 3 && runHasFailure && runHasSuccess) {
    api.correction_loops += 1;
  }
  api.sequences.push(sequence);
}

interface DocumentationAccumulator {
  request_total: number;
  outcome_distribution: Map<string, number>;
  probe_chronology: FirstDiscoveryEntry[];
  unreportable_outcomes: number;
  smoke_requests: number;
}

function accumulateDocumentation(
  accumulator: DocumentationAccumulator,
  exchanges: readonly DocumentationExchange[],
  runId: string
): void {
  const seenRoutes = new Set<string>();
  for (const exchange of exchanges) {
    if (exchange.actor !== "participant") {
      accumulator.smoke_requests += 1;
      continue;
    }
    accumulator.request_total += 1;
    if (
      (DOCUMENTATION_OUTCOMES as readonly string[]).includes(exchange.outcome)
    ) {
      accumulator.outcome_distribution.set(
        exchange.outcome,
        (accumulator.outcome_distribution.get(exchange.outcome) ?? 0) + 1
      );
    } else {
      accumulator.unreportable_outcomes += 1;
    }
    const routeId = exchange.candidate.route_id;
    if (!seenRoutes.has(routeId)) {
      seenRoutes.add(routeId);
      accumulator.probe_chronology.push({
        run_id: runId,
        sequence: exchange.sequence,
        operation_id: routeId
      });
    }
  }
}

function sortedCounts(
  map: ReadonlyMap<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) {
    const value = map.get(key);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function sequenceVariants(sequences: readonly string[][]): SequenceVariant[] {
  const groups = new Map<string, { steps: string[]; count: number }>();
  for (const sequence of sequences) {
    if (sequence.length === 0) {
      continue;
    }
    const key = canonicalJson(sequence);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { steps: sequence, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  const variants: SequenceVariant[] = [];
  for (const group of groups.values()) {
    variants.push({
      id: `seq_${canonicalJsonSha256(group.steps).slice(0, 12)}`,
      description: `trials=${group.count}`,
      steps: group.steps
    });
  }
  return variants.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Distribution of one usage dimension, or null when nothing is observed. */
export function usageDistribution(
  values: readonly number[]
): UsageDistribution | null {
  const observed = values.filter((value) => Number.isFinite(value));
  if (observed.length === 0) {
    return null;
  }
  const summary = summarize(observed);
  const mean = weightedMean(observed.map((value) => ({ value, weight: 1 })));
  const median = summary.median;
  if (mean === null || median === null) {
    return null;
  }
  const distribution: UsageDistribution = {
    min: summary.min ?? 0,
    max: summary.max ?? 0,
    median,
    mean,
    counts: [...observed].sort((a, b) => a - b)
  };
  // Section 27.6: extreme quantiles only when the sample supports them.
  if (observed.length >= MIN_N_FOR_P95) {
    const p95 = quantile(observed, 0.95);
    const p05 = quantile(observed, 0.05);
    if (p95 !== null) {
      distribution.p95 = p95;
    }
    if (p05 !== null) {
      distribution.p05 = p05;
    }
  }
  return distribution;
}

function usageBehavior(
  facts: readonly TrialFacts[]
): Report["behavior"]["usage"] {
  const dimensions = [
    "tokens",
    "duration_ms",
    "tool_calls",
    "requests",
    "provider_cost"
  ] as const;
  const behavior: Record<string, UsageDistribution | null> = {};
  let available = false;
  for (const dimension of dimensions) {
    const values = facts
      .map((fact) => fact.usage[dimension])
      .filter((value): value is number => value !== null);
    const distribution = usageDistribution(values);
    behavior[dimension] = distribution;
    if (distribution !== null) {
      available = true;
    }
  }
  return { available, ...behavior };
}

function usageMissing(facts: readonly TrialFacts[]): Record<string, number> {
  const dimensions = [
    "tokens",
    "duration_ms",
    "tool_calls",
    "requests",
    "provider_cost"
  ] as const;
  const missing: Record<string, number> = {};
  for (const dimension of dimensions) {
    missing[dimension] = facts.filter(
      (fact) => fact.usage[dimension] === null
    ).length;
  }
  return missing;
}

function buildBehavior(facts: readonly TrialFacts[]): {
  behavior: Report["behavior"];
  extraWarnings: ReportWarning[];
  documentationSmokeRequests: number;
} {
  const api = {
    request_total: 0,
    status_distribution: new Map<string, number>(),
    operation_frequency: new Map<string, number>(),
    unknown_endpoints: 0,
    wrong_methods: 0,
    malformed_requests: 0,
    authentication_failures: 0,
    invalid_transitions: 0,
    retries: 0,
    correction_loops: 0,
    recoveries_after_error: 0,
    first_discovery: [] as FirstDiscoveryEntry[],
    unreportable_operations: 0,
    unreportable_statuses: 0,
    sequences: [] as string[][]
  } satisfies ApiAccumulator;
  const documentation: DocumentationAccumulator = {
    request_total: 0,
    outcome_distribution: new Map<string, number>(),
    probe_chronology: [],
    unreportable_outcomes: 0,
    smoke_requests: 0
  };
  const semanticFacts = new Map<string, number>();
  let unreportableSemanticNames = 0;
  for (const fact of facts) {
    accumulateApi(api, fact.participantRequests, fact.row.run_id);
    accumulateDocumentation(
      documentation,
      fact.input.documentation ?? [],
      fact.row.run_id
    );
    for (const event of fact.input.semantic ?? []) {
      if (SEMANTIC_NAME_PATTERN.test(event.name)) {
        semanticFacts.set(event.name, (semanticFacts.get(event.name) ?? 0) + 1);
      } else {
        unreportableSemanticNames += 1;
      }
    }
  }
  const extraWarnings: ReportWarning[] = [];
  if (api.unreportable_operations > 0) {
    extraWarnings.push(
      warning(
        "other",
        `${api.unreportable_operations} operation identifier(s) outside the reportable pattern were skipped`,
        null
      )
    );
  }
  if (api.unreportable_statuses > 0) {
    extraWarnings.push(
      warning(
        "other",
        `${api.unreportable_statuses} response status(es) outside the reportable pattern were skipped`,
        null
      )
    );
  }
  if (documentation.unreportable_outcomes > 0) {
    extraWarnings.push(
      warning(
        "other",
        `${documentation.unreportable_outcomes} documentation outcome(s) outside the reportable vocabulary were skipped`,
        null
      )
    );
  }
  if (unreportableSemanticNames > 0) {
    extraWarnings.push(
      warning(
        "other",
        `${unreportableSemanticNames} semantic name(s) outside the reportable pattern were skipped`,
        null
      )
    );
  }
  const byRunThenSequence = (
    a: { run_id: string; sequence: number },
    b: { run_id: string; sequence: number }
  ): number => a.run_id.localeCompare(b.run_id) || a.sequence - b.sequence;
  const behavior: Report["behavior"] = {
    api: {
      request_total: api.request_total,
      status_distribution: sortedCounts(api.status_distribution),
      operation_frequency: sortedCounts(api.operation_frequency),
      unknown_endpoints: api.unknown_endpoints,
      wrong_methods: api.wrong_methods,
      malformed_requests: api.malformed_requests,
      authentication_failures: api.authentication_failures,
      invalid_transitions: api.invalid_transitions,
      retries: api.retries,
      correction_loops: api.correction_loops,
      recoveries_after_error: api.recoveries_after_error,
      first_discovery: [...api.first_discovery].sort(byRunThenSequence)
    },
    documentation: {
      request_total: documentation.request_total,
      outcome_distribution: sortedCounts(documentation.outcome_distribution),
      probe_chronology: [...documentation.probe_chronology]
        .sort(byRunThenSequence)
        .map((entry) => ({
          run_id: entry.run_id,
          sequence: entry.sequence,
          route_id: entry.operation_id
        }))
    },
    semantic: {
      facts: sortedCounts(semanticFacts),
      sequence_variants: sequenceVariants(api.sequences)
    },
    usage: usageBehavior(facts)
  };
  return {
    behavior,
    extraWarnings,
    documentationSmokeRequests: documentation.smoke_requests
  };
}

function buildSurfaces(
  facts: readonly TrialFacts[],
  redaction: SummaryRedactionContext | undefined
): Report["surfaces"] {
  const statuses = countBy(facts, (fact) => fact.participantReportStatus);
  const turnCompletedFacts = facts.filter((fact) => fact.row.turn_completed);
  const turnCompleted = turnCompletedFacts.length;
  const valid = statuses["valid"] ?? 0;
  const validAmongTurnCompleted = turnCompletedFacts.filter(
    (fact) => fact.participantReportStatus === "valid"
  ).length;
  const finalStates = facts
    .flatMap((fact) => {
      const state = fact.input.final_state;
      if (state === null || state === undefined) {
        return [];
      }
      return [
        {
          run_id: fact.row.run_id,
          state_sha256: state.state_sha256,
          ...(state.summary === undefined
            ? {}
            : { summary: redactSummary(state.summary, redaction) })
        }
      ];
    })
    .filter((entry) => isSha256Hex(entry.state_sha256))
    .sort((a, b) => (a.run_id < b.run_id ? -1 : 1));
  return {
    participant_reports: {
      absent: statuses["absent"] ?? 0,
      malformed: statuses["malformed"] ?? 0,
      schema_invalid: statuses["schema_invalid"] ?? 0,
      valid,
      // Section 27.3: agreement over trials reaching turn_completed.
      // The numerator counts only valid reports inside that
      // denominator, so a valid-status report from a trial that never
      // completed its turn is listed but can never push the rate
      // above 1.
      agreement:
        turnCompleted === 0 ? null : validAmongTurnCompleted / turnCompleted
    },
    final_states: finalStates
  };
}

function buildProvenance(
  input: ProvenanceInput | undefined,
  extraWarnings: ReportWarning[]
): Report["provenance"] {
  const implementation: Record<string, string> = {
    // Section 27.5: the report builder is part of compatibility
    // identity. The digest covers the builder identity string.
    report_builder: sha256Hex(REPORT_BUILDER_IDENTITY)
  };
  for (const [key, value] of Object.entries(input?.implementation ?? {})) {
    if (isSha256Hex(value)) {
      implementation[key] = value;
    }
  }
  const names = input?.environment_names ?? [];
  const environmentNames = names.filter((name) =>
    ENVIRONMENT_NAME_PATTERN.test(name)
  );
  if (environmentNames.length < names.length) {
    extraWarnings.push(
      warning(
        "other",
        `${names.length - environmentNames.length} environment name(s) outside the reportable pattern were dropped`,
        null
      )
    );
  }
  return {
    cells: input?.cells ?? [],
    implementation,
    environment_names: environmentNames
  };
}

/** Digest of one report document over its canonical JSON form. */
export function reportSha256(report: Report): string {
  return canonicalJsonSha256(report as unknown as Json);
}
