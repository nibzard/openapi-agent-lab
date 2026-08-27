/**
 * Report document model, typed from schemas/report.v1.schema.json
 * (specification section 27.4). The model is the single source of truth
 * for the builder: every field name and required property below mirrors
 * the schema file, not the specification prose alone.
 *
 * Identifiers are pattern-bound at build time; the types stay plain
 * strings so documents remain assignable to JSON values.
 */

import type { Json } from "@oal/core";

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_KIND = "Report";

/** Identifier shape ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$. */
export type SafeId = string;

/** Lowercase sha256 hex digest, 64 characters. */
export type Sha256Hex = string;

/** Assignment or run identifier ^(?:asg|bat|run)_[a-f0-9]{24,32}$. */
export type ControlId = string;

/** Terminal disposition vocabulary (section 22.4). */
export type Disposition =
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

export const DISPOSITIONS: readonly Disposition[] = [
  "completed",
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
  "not_started",
  "invalid_setup"
];

/** Evidence integrity axis (section 27.1). */
export type EvidenceIntegrity = "intact" | "corrupt" | "missing";

export const EVIDENCE_INTEGRITY_FLAGS: readonly EvidenceIntegrity[] = [
  "intact",
  "corrupt",
  "missing"
];

/** Censor classes from the replacement policy (sections 27.2 and 27.3). */
export type CensorClass =
  | "none"
  | "pre_control_nonparticipant"
  | "administrative_censor"
  | "instrumentation_censor";

export const CENSOR_CLASSES: readonly CensorClass[] = [
  "none",
  "pre_control_nonparticipant",
  "administrative_censor",
  "instrumentation_censor"
];

/** Task outcome axis (section 27.1). */
export type TaskOutcome =
  | "passed"
  | "failed"
  | "partial"
  | "indeterminate"
  | "not_evaluated";

export const TASK_OUTCOMES: readonly TaskOutcome[] = [
  "passed",
  "failed",
  "partial",
  "indeterminate",
  "not_evaluated"
];

/**
 * Lifecycle stage vocabulary of the report schema. These run-level
 * stages differ from the trial-stage ledger of section 22.3; the
 * builder maps lifecycle evidence onto this vocabulary explicitly.
 */
export type ReportLifecycleStage =
  | "scheduled"
  | "workspace_prepared"
  | "server_ready"
  | "participant_spawned"
  | "participant_active"
  | "participant_exiting"
  | "participant_exited"
  | "finalizing"
  | "evidence_exported"
  | "evaluated"
  | "finalized"
  | "aborted"
  | "failed";

export const REPORT_LIFECYCLE_STAGES: readonly ReportLifecycleStage[] = [
  "scheduled",
  "workspace_prepared",
  "server_ready",
  "participant_spawned",
  "participant_active",
  "participant_exiting",
  "participant_exited",
  "finalizing",
  "evidence_exported",
  "evaluated",
  "finalized",
  "aborted",
  "failed"
];

/** Participant report status axis (section 27.1). */
export type ParticipantReportStatus =
  | "absent"
  | "malformed"
  | "schema_invalid"
  | "valid"
  | "unavailable_due_to_infrastructure";

export const PARTICIPANT_REPORT_STATUSES: readonly ParticipantReportStatus[] = [
  "absent",
  "malformed",
  "schema_invalid",
  "valid",
  "unavailable_due_to_infrastructure"
];

/** Documentation facade outcomes permitted by the schema. */
export type DocumentationOutcome =
  | "contract_served"
  | "index_served"
  | "rejected_authentication"
  | "neutral_unknown_route"
  | "disabled";

export const DOCUMENTATION_OUTCOMES: readonly DocumentationOutcome[] = [
  "contract_served",
  "index_served",
  "rejected_authentication",
  "neutral_unknown_route",
  "disabled"
];

/** Warning kinds permitted by the schema (section 27.4). */
export type ReportWarningKind =
  | "trace_truncation"
  | "missing_evidence"
  | "corrupt_evidence"
  | "approximation"
  | "sandbox"
  | "isolation"
  | "blinding_review"
  | "cue_review"
  | "mock_fidelity"
  | "unplanned_analysis"
  | "other";

export const REPORT_WARNING_KINDS: readonly ReportWarningKind[] = [
  "trace_truncation",
  "missing_evidence",
  "corrupt_evidence",
  "approximation",
  "sandbox",
  "isolation",
  "blinding_review",
  "cue_review",
  "mock_fidelity",
  "unplanned_analysis",
  "other"
];

export interface ReportScope {
  level: "batch" | "study";
  id: SafeId;
  study_run_id?: SafeId | null | undefined;
  cell_id?: SafeId | null | undefined;
  analysis_id?: SafeId | null | undefined;
  lineage?: "preregistered" | "derived" | undefined;
}

export interface EvidenceIntegrityCounts {
  intact: number;
  corrupt: number;
  missing: number;
}

export interface CensorClassCounts {
  none: number;
  pre_control_nonparticipant: number;
  administrative_censor: number;
  instrumentation_censor: number;
}

export interface ReplacementCounts {
  activated: number;
  held_unused: number;
}

export interface TaskOutcomeCounts {
  passed: number;
  failed: number;
  partial: number;
  indeterminate: number;
  not_evaluated: number;
}

export interface ReportCounts {
  primary_assignments: number;
  activated_replacements: number;
  operational_assignments: number;
  launched_trials: number;
  held_unused: number;
  not_started: number;
  lifecycle_stages?: Readonly<Partial<Record<ReportLifecycleStage, number>>>;
  dispositions: Readonly<Partial<Record<Disposition, number>>>;
  evidence_integrity: EvidenceIntegrityCounts;
  censor_classes: CensorClassCounts;
  replacements?: ReplacementCounts | undefined;
  task_outcomes: TaskOutcomeCounts;
}

export interface MetricAvailability {
  observed: number;
  unknown: number;
  not_applicable: number;
  unavailable_due_to_evidence: number;
}

export interface PerRunEvidenceLink {
  run_id: SafeId;
  evidence_uri: string;
}

export interface ReportMetric {
  id: SafeId;
  numerator: number;
  denominator: number;
  availability: MetricAvailability;
  label?: string | undefined;
  reasons?: readonly string[] | undefined;
  per_run?: readonly PerRunEvidenceLink[] | undefined;
}

export type ConfidenceInterval = readonly [number | null, number | null];

export interface SensitivityEstimate {
  id: SafeId;
  kind: "worst_case" | "worst_case_sensitivity" | "marginal" | "other";
  estimate: number | null;
  interval?: ConfidenceInterval | null | undefined;
}

export interface ReportEstimate {
  contrast_id: SafeId;
  estimate: number | null;
  interval: ConfidenceInterval | null;
  sensitivity: readonly SensitivityEstimate[];
  p_value?: number | null | undefined;
  adjusted_p_value?: number | null | undefined;
  family_id?: SafeId | null | undefined;
}

export interface FirstDiscoveryEntry {
  run_id: SafeId;
  sequence: number;
  operation_id: string;
}

export interface ApiBehavior {
  request_total: number;
  status_distribution: Readonly<Record<string, number>>;
  operation_frequency: Readonly<Record<string, number>>;
  unknown_endpoints?: number | undefined;
  wrong_methods?: number | undefined;
  malformed_requests?: number | undefined;
  authentication_failures?: number | undefined;
  invalid_transitions?: number | undefined;
  retries?: number | undefined;
  correction_loops?: number | undefined;
  recoveries_after_error?: number | undefined;
  first_discovery?: readonly FirstDiscoveryEntry[] | undefined;
}

export interface ProbeChronologyEntry {
  run_id: SafeId;
  sequence: number;
  route_id: string;
}

export interface DocumentationBehavior {
  request_total: number;
  outcome_distribution: Readonly<Record<string, number>>;
  probe_chronology?: readonly ProbeChronologyEntry[] | undefined;
}

export interface SequenceVariant {
  id: SafeId;
  description?: string | undefined;
  steps: readonly string[];
}

export interface SemanticBehavior {
  facts: Readonly<Record<string, number>>;
  sequence_variants: readonly SequenceVariant[];
}

/** Distribution block of the schema: min, max, median, mean, quantiles. */
export interface UsageDistribution {
  min: number;
  max: number;
  median: number;
  mean: number;
  p05?: number | undefined;
  p95?: number | undefined;
  counts: readonly number[];
}

export interface UsageBehavior {
  available: boolean;
  tokens?: UsageDistribution | null | undefined;
  duration_ms?: UsageDistribution | null | undefined;
  tool_calls?: UsageDistribution | null | undefined;
  requests?: UsageDistribution | null | undefined;
  provider_cost?: UsageDistribution | null | undefined;
}

export interface ReportBehavior {
  api: ApiBehavior;
  documentation: DocumentationBehavior;
  semantic?: SemanticBehavior | undefined;
  usage?: UsageBehavior | undefined;
}

export interface ParticipantReportCounts {
  absent: number;
  malformed: number;
  schema_invalid: number;
  valid: number;
  agreement: number | null;
}

export interface FinalStateEntry {
  run_id: SafeId;
  state_sha256: Sha256Hex;
  summary?: Json | undefined;
}

export interface ReportSurfaces {
  participant_reports: ParticipantReportCounts;
  final_states?: readonly FinalStateEntry[] | undefined;
}

export interface ReplacementLineageEntry {
  assignment_id: ControlId;
  primary_assignment_id: ControlId;
}

export interface ScheduleSummary {
  schedule_sha256: Sha256Hex;
  blocks: number;
}

export interface CellProvenance {
  cell_id: SafeId;
  factor_levels: Readonly<Record<string, string>>;
  compatibility_sha256: Sha256Hex;
  intended_factors?: readonly SafeId[] | undefined;
  replacement_lineage?: readonly ReplacementLineageEntry[] | undefined;
  schedule?: ScheduleSummary | undefined;
  input_digests?: Readonly<Record<string, Sha256Hex>> | undefined;
}

export interface ReportProvenance {
  cells: readonly CellProvenance[];
  implementation: Readonly<Record<string, Sha256Hex>>;
  environment_names?: readonly string[] | undefined;
}

export interface ReportWarning {
  kind: ReportWarningKind;
  message: string;
  run_id?: SafeId | null | undefined;
}

/** Frozen machine-readable report over one batch or StudyRun. */
export interface Report {
  schema_version: 1;
  kind: "Report";
  scope: ReportScope;
  counts: ReportCounts;
  metrics: readonly ReportMetric[];
  estimates: readonly ReportEstimate[];
  behavior: ReportBehavior;
  surfaces: ReportSurfaces;
  provenance: ReportProvenance;
  warnings: readonly ReportWarning[];
  extensions: Readonly<Record<string, Json>>;
}

/** Identity of the report builder recorded in implementation digests. */
export const REPORT_BUILDER_IDENTITY = "@oal/report@0.0.0";

/** Zero buckets for every enumerated count axis. */
export function emptyEvidenceIntegrityCounts(): EvidenceIntegrityCounts {
  return { intact: 0, corrupt: 0, missing: 0 };
}

export function emptyCensorClassCounts(): CensorClassCounts {
  return {
    none: 0,
    pre_control_nonparticipant: 0,
    administrative_censor: 0,
    instrumentation_censor: 0
  };
}

export function emptyTaskOutcomeCounts(): TaskOutcomeCounts {
  return {
    passed: 0,
    failed: 0,
    partial: 0,
    indeterminate: 0,
    not_evaluated: 0
  };
}

/**
 * Structural guard for documents read from disk. It checks the required
 * envelope fields only; full validation stays with the JSON Schema.
 */
export function isReport(value: unknown): value is Report {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1 || record.kind !== "Report") {
    return false;
  }
  for (const key of [
    "scope",
    "counts",
    "metrics",
    "estimates",
    "behavior",
    "surfaces",
    "provenance",
    "warnings",
    "extensions"
  ] as const) {
    const field = record[key];
    if (field === undefined || field === null) {
      return false;
    }
    if (key === "metrics" || key === "estimates" || key === "warnings") {
      if (!Array.isArray(field)) {
        return false;
      }
    }
  }
  const scope = record.scope as Record<string, unknown> | undefined;
  return (
    scope !== undefined &&
    (scope.level === "batch" || scope.level === "study") &&
    typeof scope.id === "string"
  );
}
