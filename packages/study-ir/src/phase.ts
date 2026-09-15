/**
 * PhasePlan model and loader (specification section 12.9).
 *
 * A PhasePlan freezes one smoke, pilot, confirmatory, or other named phase.
 * The loader validates the document against `phase-plan.v1.schema.json`,
 * then resolves every analysis reference against the owning StudyProtocol:
 * metrics, factors, levels, strata, contrasts, and estimands. It also checks
 * the balance rule the schema cannot express: the primary count must be
 * divisible by the resolved cell count.
 */

import {
  diagnostic,
  isJsonObject,
  isSafeId,
  validateSchemaInstance,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { StudyCode } from "./codes.ts";
import type { FactorRole, ProtocolMetric, StudyProtocol } from "./protocol.ts";

export const PHASE_PLAN_API_VERSION = "agentlab.dev/v1";
export const PHASE_PLAN_KIND = "PhasePlan";

export type PhasePurpose =
  | "smoke"
  | "pilot"
  | "confirmatory"
  | "exploratory"
  | "operational";

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

export type EvidenceIntegrity = "corrupt" | "missing";

export interface ActivationRule {
  readonly disposition?: Disposition | undefined;
  readonly evidence_integrity?: readonly EvidenceIntegrity[] | undefined;
}

export type CensorClass =
  | "pre_control_nonparticipant"
  | "administrative_censor"
  | "instrumentation_censor";

export interface PhaseDesign {
  readonly kind: "complete-balanced-blocks";
  readonly primary_assignments: number;
  readonly explicit_seed_required?: boolean | undefined;
  readonly block?:
    | { readonly cells: "all"; readonly repetitions: number }
    | undefined;
  readonly ordering: "canonical-sha256-sort-v1";
}

export interface PhaseReplacements {
  readonly kind: "none" | "held-same-cell";
  readonly slots_per_cell: number;
  readonly activation_timing:
    | "immediate_after_terminal"
    | "after_primary_schedule";
  readonly activate_on: readonly ActivationRule[];
  readonly maximum_activated_per_cell: number;
}

export interface PhaseRuntimeLock {
  readonly required_fields: readonly string[];
}

export interface PhaseEligibility {
  readonly primary_agent_outcome: {
    readonly require: "participant_control_started";
    readonly exclude?: readonly { readonly censor_class: CensorClass }[];
  };
  readonly api_behavior: {
    readonly require: readonly (
      | "participant_control_started"
      | "trace_intact"
    )[];
  };
}

export interface PhaseStopping {
  readonly batch_wide_pre_control_failure: "abort" | "incomplete";
  readonly second_unreplaced_failure_in_cell: "incomplete" | "abort";
  readonly operator_interruption: "abort";
  readonly data_dependent_success_stop: "forbidden";
}

export type ContrastDirection = "first_minus_second" | "second_minus_first";

export interface PhaseContrast {
  readonly id: string;
  readonly metric: string;
  readonly factor: string;
  readonly levels: readonly [string, string];
  readonly direction: ContrastDirection;
  readonly within?: Readonly<Record<string, string>> | undefined;
  readonly population?: string | undefined;
}

export type EstimandMeasure = "risk_difference" | "risk_ratio" | "difference";

export interface PrimaryEstimand {
  readonly id: string;
  readonly outcome: string;
  readonly population: string;
  readonly contrast: string;
  readonly measure: EstimandMeasure;
}

export interface ComparisonFamily {
  readonly id: string;
  readonly contrasts: readonly string[];
  readonly alpha: number;
  readonly multiplicity: "holm" | "none";
}

export interface AnalysisMethods {
  readonly binary_interval: "wilson" | "wald";
  readonly risk_difference_interval: "newcombe" | "wald";
  readonly exact_test: "fisher_two_sided";
}

export interface PhaseAnalysis {
  readonly contrasts: readonly PhaseContrast[];
  readonly primary_estimand: PrimaryEstimand;
  readonly comparison_families: readonly ComparisonFamily[];
  readonly methods: AnalysisMethods;
  readonly sensitivity: {
    readonly participant_control_started_censors_as_failure: boolean;
  };
  readonly marginal_weighting: "none" | "equal_cells" | "equal_assignments";
  readonly floor_ceiling: { readonly apply_by_factor_level: string | null };
  readonly small_sample_label: "directional" | "confirmatory";
}

export interface PhasePaidCalls {
  readonly primary: number;
  readonly maximum_with_replacements: number;
}

/** Typed PhasePlan. Serialized form validates against its schema. */
export interface PhasePlan {
  readonly apiVersion: typeof PHASE_PLAN_API_VERSION;
  readonly kind: typeof PHASE_PLAN_KIND;
  readonly metadata: { readonly id: string };
  readonly purpose: PhasePurpose;
  readonly analytical: boolean;
  readonly design: PhaseDesign;
  readonly replacements?: PhaseReplacements | undefined;
  readonly runtime_lock: PhaseRuntimeLock;
  readonly eligibility: PhaseEligibility;
  readonly stopping: PhaseStopping;
  readonly analysis: PhaseAnalysis;
  readonly paid_calls: PhasePaidCalls;
}

export interface PhasePlanLoadOptions {
  /** Draft 2020-12 `phase-plan.v1` schema. The caller reads it. */
  readonly schema?: Json | undefined;
  /** Owning protocol. Analysis references resolve against it. */
  readonly protocol: StudyProtocol;
  /** Resolved cell count of the protocol. Enables the balance check. */
  readonly cellCount?: number | undefined;
  /** Rubric check IDs the metric sources may reference. */
  readonly knownChecks?: ReadonlySet<string> | undefined;
  /** Rubric signal IDs the metric sources may reference. */
  readonly knownSignals?: ReadonlySet<string> | undefined;
  readonly documentUri?: string | undefined;
}

export interface PhasePlanLoadResult {
  readonly phasePlan: PhasePlan | null;
  readonly diagnostics: Diagnostic[];
}

const DISPOSITIONS: ReadonlySet<string> = new Set<string>([
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
]);

const CENSOR_CLASSES: ReadonlySet<string> = new Set<string>([
  "pre_control_nonparticipant",
  "administrative_censor",
  "instrumentation_censor"
]);

const PURPOSES: ReadonlySet<string> = new Set<string>([
  "smoke",
  "pilot",
  "confirmatory",
  "exploratory",
  "operational"
]);

/** Load and validate one PhasePlan document. Never throws on content. */
export async function loadPhasePlan(
  document: Json,
  options: PhasePlanLoadOptions
): Promise<PhasePlanLoadResult> {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;

  if (options.schema !== undefined) {
    // Study documents are untrusted: their schema evaluation runs inside
    // the bounded schema-worker boundary.
    const violations = await validateSchemaInstance(options.schema, document);
    for (const violation of violations) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `${violation.code}: ${violation.message}`,
          document_uri: uri,
          json_pointer:
            violation.pointer.length === 0
              ? "#/"
              : `#/${violation.pointer.slice(1)}`
        })
      );
    }
  }
  if (!isJsonObject(document)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A PhasePlan must be an object.",
        document_uri: uri,
        json_pointer: "#/"
      })
    );
    return { phasePlan: null, diagnostics };
  }

  const plan = parsePhasePlan(document, report);
  if (plan === null) {
    return { phasePlan: null, diagnostics };
  }
  checkAnalysisReferences(plan, options.protocol, options, report);
  checkBalance(plan, options.cellCount, report);
  checkPaidCalls(plan, report);
  checkConfirmatoryRules(plan, report);
  checkMetricSources(options.protocol, options, report);

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { phasePlan: null, diagnostics };
  }
  return { phasePlan: plan, diagnostics };
}

function fieldOf(value: JsonObject, key: string): Json | undefined {
  return value[key];
}

function readId(
  value: Json | undefined,
  pointer: string,
  what: string,
  report: (entry: Diagnostic) => void
): string | null {
  if (typeof value !== "string" || !isSafeId(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: `${what} must be a safe identifier.`,
        json_pointer: pointer
      })
    );
    return null;
  }
  return value;
}

function parsePhasePlan(
  document: JsonObject,
  report: (entry: Diagnostic) => void
): PhasePlan | null {
  const metadataValue = fieldOf(document, "metadata");
  const id = isJsonObject(metadataValue)
    ? readId(fieldOf(metadataValue, "id"), "#/metadata/id", "phase id", report)
    : null;
  const purpose = fieldOf(document, "purpose");
  if (typeof purpose !== "string" || !PURPOSES.has(purpose)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "purpose must be a known phase purpose.",
        json_pointer: "#/purpose"
      })
    );
  }
  const analytical = fieldOf(document, "analytical");
  if (typeof analytical !== "boolean") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "analytical must be a boolean.",
        json_pointer: "#/analytical"
      })
    );
  }
  const design = parseDesign(fieldOf(document, "design"), report);
  const replacements = parseReplacements(
    fieldOf(document, "replacements"),
    report
  );
  const runtimeLock = parseRuntimeLock(
    fieldOf(document, "runtime_lock"),
    report
  );
  const eligibility = parseEligibility(
    fieldOf(document, "eligibility"),
    report
  );
  const stopping = parseStopping(fieldOf(document, "stopping"), report);
  const analysis = parseAnalysis(fieldOf(document, "analysis"), report);
  const paidCalls = parsePaidCalls(fieldOf(document, "paid_calls"), report);
  if (
    id === null ||
    design === null ||
    runtimeLock === null ||
    eligibility === null ||
    stopping === null ||
    analysis === null ||
    paidCalls === null ||
    typeof purpose !== "string" ||
    typeof analytical !== "boolean"
  ) {
    return null;
  }
  return {
    apiVersion: PHASE_PLAN_API_VERSION,
    kind: PHASE_PLAN_KIND,
    metadata: { id },
    purpose: purpose as PhasePurpose,
    analytical,
    design,
    ...(replacements === undefined ? {} : { replacements }),
    runtime_lock: runtimeLock,
    eligibility,
    stopping,
    analysis,
    paid_calls: paidCalls
  };
}

function parseDesign(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseDesign | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design must be an object.",
        json_pointer: "#/design"
      })
    );
    return null;
  }
  const kind = fieldOf(value, "kind");
  if (kind !== "complete-balanced-blocks") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design.kind must be complete-balanced-blocks in version 1.",
        json_pointer: "#/design/kind"
      })
    );
    return null;
  }
  const primary = fieldOf(value, "primary_assignments");
  if (
    typeof primary !== "number" ||
    !Number.isInteger(primary) ||
    primary < 1
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design.primary_assignments must be a positive integer.",
        json_pointer: "#/design/primary_assignments"
      })
    );
    return null;
  }
  const ordering = fieldOf(value, "ordering");
  if (ordering !== "canonical-sha256-sort-v1") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design.ordering must be canonical-sha256-sort-v1.",
        json_pointer: "#/design/ordering"
      })
    );
    return null;
  }
  const seed = fieldOf(value, "explicit_seed_required");
  if (seed !== undefined && typeof seed !== "boolean") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design.explicit_seed_required must be a boolean.",
        json_pointer: "#/design/explicit_seed_required"
      })
    );
    return null;
  }
  const blockValue = fieldOf(value, "block");
  let block: PhaseDesign["block"];
  if (blockValue === undefined) {
    block = undefined;
  } else if (
    !isJsonObject(blockValue) ||
    fieldOf(blockValue, "cells") !== "all" ||
    typeof fieldOf(blockValue, "repetitions") !== "number" ||
    !Number.isInteger(fieldOf(blockValue, "repetitions")) ||
    (fieldOf(blockValue, "repetitions") as number) < 1
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "design.block must declare cells all and repetitions >= 1.",
        json_pointer: "#/design/block"
      })
    );
    block = undefined;
  } else {
    block = {
      cells: "all",
      repetitions: fieldOf(blockValue, "repetitions") as number
    };
  }
  return {
    kind,
    primary_assignments: primary,
    ordering,
    ...(seed === undefined ? {} : { explicit_seed_required: seed }),
    ...(block === undefined ? {} : { block })
  };
}

function parseReplacements(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseReplacements | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "replacements must be an object.",
        json_pointer: "#/replacements"
      })
    );
    return undefined;
  }
  const kind = fieldOf(value, "kind");
  if (kind !== "none" && kind !== "held-same-cell") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "replacements.kind must be none or held-same-cell.",
        json_pointer: "#/replacements/kind"
      })
    );
    return undefined;
  }
  const timing = fieldOf(value, "activation_timing");
  if (
    timing !== "immediate_after_terminal" &&
    timing !== "after_primary_schedule"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "replacements.activation_timing is not a version 1 timing.",
        json_pointer: "#/replacements/activation_timing"
      })
    );
    return undefined;
  }
  const numberField = (key: string): number | null => {
    const raw = fieldOf(value, key);
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `replacements.${key} must be a non-negative integer.`,
          json_pointer: `#/replacements/${key}`
        })
      );
      return null;
    }
    return raw;
  };
  const slots = numberField("slots_per_cell");
  const maximum = numberField("maximum_activated_per_cell");
  const activateOnValue = fieldOf(value, "activate_on");
  const activateOn: ActivationRule[] = [];
  if (Array.isArray(activateOnValue)) {
    for (const entry of activateOnValue) {
      if (!isJsonObject(entry)) {
        continue;
      }
      const disposition = fieldOf(entry, "disposition");
      const integrity = fieldOf(entry, "evidence_integrity");
      activateOn.push({
        ...(typeof disposition === "string" && DISPOSITIONS.has(disposition)
          ? { disposition: disposition as Disposition }
          : {}),
        ...(Array.isArray(integrity)
          ? {
              evidence_integrity: integrity.filter(
                (item): item is EvidenceIntegrity =>
                  item === "corrupt" || item === "missing"
              )
            }
          : {})
      });
    }
  }
  if (slots === null || maximum === null) {
    return undefined;
  }
  return {
    kind,
    slots_per_cell: slots,
    activation_timing: timing,
    activate_on: activateOn,
    maximum_activated_per_cell: maximum
  };
}

function parseRuntimeLock(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseRuntimeLock | null {
  if (
    !isJsonObject(value) ||
    !Array.isArray(fieldOf(value, "required_fields"))
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "runtime_lock.required_fields must be an array.",
        json_pointer: "#/runtime_lock/required_fields"
      })
    );
    return null;
  }
  const fields = fieldOf(value, "required_fields") as Json[];
  const required: string[] = [];
  for (const entry of fields) {
    if (typeof entry === "string" && entry.length > 0) {
      required.push(entry);
    }
  }
  return { required_fields: required };
}

function parseEligibility(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseEligibility | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "eligibility must be an object.",
        json_pointer: "#/eligibility"
      })
    );
    return null;
  }
  const outcomeValue = fieldOf(value, "primary_agent_outcome");
  if (
    !isJsonObject(outcomeValue) ||
    fieldOf(outcomeValue, "require") !== "participant_control_started"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message:
          "eligibility.primary_agent_outcome.require must be participant_control_started.",
        json_pointer: "#/eligibility/primary_agent_outcome/require"
      })
    );
    return null;
  }
  const excludeValue = fieldOf(outcomeValue, "exclude");
  const exclude: { censor_class: CensorClass }[] = [];
  if (Array.isArray(excludeValue)) {
    for (const entry of excludeValue) {
      if (
        isJsonObject(entry) &&
        typeof entry["censor_class"] === "string" &&
        CENSOR_CLASSES.has(entry["censor_class"])
      ) {
        exclude.push({
          censor_class: entry["censor_class"] as CensorClass
        });
      }
    }
  }
  const behaviorValue = fieldOf(value, "api_behavior");
  const behaviorRequireValue = isJsonObject(behaviorValue)
    ? fieldOf(behaviorValue, "require")
    : undefined;
  const behaviorRequire: ("participant_control_started" | "trace_intact")[] =
    [];
  if (Array.isArray(behaviorRequireValue)) {
    for (const entry of behaviorRequireValue) {
      if (entry === "participant_control_started" || entry === "trace_intact") {
        behaviorRequire.push(entry);
      }
    }
  }
  if (behaviorRequire.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "eligibility.api_behavior.require must be a non-empty array.",
        json_pointer: "#/eligibility/api_behavior/require"
      })
    );
    return null;
  }
  return {
    primary_agent_outcome: {
      require: "participant_control_started",
      ...(exclude.length === 0 ? {} : { exclude })
    },
    api_behavior: { require: behaviorRequire }
  };
}

function parseStopping(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseStopping | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "stopping must be an object.",
        json_pointer: "#/stopping"
      })
    );
    return null;
  }
  const abortOrIncomplete = (key: string): "abort" | "incomplete" | null => {
    const raw = fieldOf(value, key);
    if (raw !== "abort" && raw !== "incomplete") {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `stopping.${key} must be abort or incomplete.`,
          json_pointer: `#/stopping/${key}`
        })
      );
      return null;
    }
    return raw;
  };
  const batchWide = abortOrIncomplete("batch_wide_pre_control_failure");
  const secondFailure = abortOrIncomplete("second_unreplaced_failure_in_cell");
  const operator = fieldOf(value, "operator_interruption");
  const dataDependent = fieldOf(value, "data_dependent_success_stop");
  if (
    batchWide === null ||
    secondFailure === null ||
    operator !== "abort" ||
    dataDependent !== "forbidden"
  ) {
    if (operator !== "abort") {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: "stopping.operator_interruption must be abort.",
          json_pointer: "#/stopping/operator_interruption"
        })
      );
    }
    if (dataDependent !== "forbidden") {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: "stopping.data_dependent_success_stop must be forbidden.",
          json_pointer: "#/stopping/data_dependent_success_stop"
        })
      );
    }
    return null;
  }
  return {
    batch_wide_pre_control_failure: batchWide,
    second_unreplaced_failure_in_cell: secondFailure,
    operator_interruption: operator,
    data_dependent_success_stop: dataDependent
  };
}

function parseContrast(
  value: Json,
  report: (entry: Diagnostic) => void
): PhaseContrast | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = readId(fieldOf(value, "id"), "/id", "contrast id", report);
  const metric = readId(
    fieldOf(value, "metric"),
    "/metric",
    "contrast metric",
    report
  );
  const factor = readId(
    fieldOf(value, "factor"),
    "/factor",
    "contrast factor",
    report
  );
  const levelsValue = fieldOf(value, "levels");
  const levels: string[] = [];
  if (Array.isArray(levelsValue)) {
    for (const entry of levelsValue) {
      if (typeof entry === "string") {
        levels.push(entry);
      }
    }
  }
  const direction = fieldOf(value, "direction");
  if (
    direction !== "first_minus_second" &&
    direction !== "second_minus_first"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "contrast.direction must be a version 1 direction.",
        json_pointer: "/direction"
      })
    );
  }
  const withinValue = fieldOf(value, "within");
  let within: Record<string, string> | undefined;
  if (isJsonObject(withinValue)) {
    within = {};
    for (const key of Object.keys(withinValue)) {
      const raw = withinValue[key];
      if (typeof raw === "string") {
        within[key] = raw;
      }
    }
  }
  const population = fieldOf(value, "population");
  if (
    id === null ||
    metric === null ||
    factor === null ||
    levels.length !== 2 ||
    (direction !== "first_minus_second" && direction !== "second_minus_first")
  ) {
    return null;
  }
  return {
    id,
    metric,
    factor,
    levels: [levels[0] as string, levels[1] as string],
    direction,
    ...(within === undefined ? {} : { within }),
    ...(typeof population === "string" ? { population } : {})
  };
}

function parseAnalysis(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhaseAnalysis | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "analysis must be an object.",
        json_pointer: "#/analysis"
      })
    );
    return null;
  }
  const contrastsValue = fieldOf(value, "contrasts");
  const contrasts: PhaseContrast[] = [];
  if (Array.isArray(contrastsValue)) {
    for (const entry of contrastsValue) {
      const contrast = parseContrast(entry, report);
      if (contrast !== null) {
        contrasts.push(contrast);
      }
    }
  }
  const estimandValue = fieldOf(value, "primary_estimand");
  const estimandId = isJsonObject(estimandValue)
    ? readId(
        fieldOf(estimandValue, "id"),
        "#/analysis/primary_estimand/id",
        "estimand id",
        report
      )
    : null;
  const estimandOutcome = isJsonObject(estimandValue)
    ? readId(
        fieldOf(estimandValue, "outcome"),
        "#/analysis/primary_estimand/outcome",
        "estimand outcome",
        report
      )
    : null;
  const estimandPopulation = isJsonObject(estimandValue)
    ? readId(
        fieldOf(estimandValue, "population"),
        "#/analysis/primary_estimand/population",
        "estimand population",
        report
      )
    : null;
  const estimandContrast = isJsonObject(estimandValue)
    ? readId(
        fieldOf(estimandValue, "contrast"),
        "#/analysis/primary_estimand/contrast",
        "estimand contrast",
        report
      )
    : null;
  const measure = isJsonObject(estimandValue)
    ? fieldOf(estimandValue, "measure")
    : undefined;
  const measureValue =
    measure === "risk_difference" ||
    measure === "risk_ratio" ||
    measure === "difference"
      ? measure
      : null;
  if (measureValue === null) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "primary_estimand.measure must be a version 1 measure.",
        json_pointer: "#/analysis/primary_estimand/measure"
      })
    );
  }
  const familiesValue = fieldOf(value, "comparison_families");
  const families: ComparisonFamily[] = [];
  if (Array.isArray(familiesValue)) {
    for (const entry of familiesValue) {
      if (!isJsonObject(entry)) {
        continue;
      }
      const familyId = readId(
        fieldOf(entry, "id"),
        "#/analysis/comparison_families",
        "family id",
        report
      );
      const familyContrasts = fieldOf(entry, "contrasts");
      const names = Array.isArray(familyContrasts)
        ? familyContrasts.filter(
            (item): item is string => typeof item === "string"
          )
        : [];
      const alpha = fieldOf(entry, "alpha");
      const multiplicity = fieldOf(entry, "multiplicity");
      if (
        familyId === null ||
        typeof alpha !== "number" ||
        (multiplicity !== "holm" && multiplicity !== "none")
      ) {
        continue;
      }
      families.push({
        id: familyId,
        contrasts: names,
        alpha,
        multiplicity
      });
    }
  }
  const methodsValue = fieldOf(value, "methods");
  const binaryInterval = isJsonObject(methodsValue)
    ? fieldOf(methodsValue, "binary_interval")
    : undefined;
  const riskInterval = isJsonObject(methodsValue)
    ? fieldOf(methodsValue, "risk_difference_interval")
    : undefined;
  const exactTest = isJsonObject(methodsValue)
    ? fieldOf(methodsValue, "exact_test")
    : undefined;
  const sensitivityValue = fieldOf(value, "sensitivity");
  const censorAsFailure = isJsonObject(sensitivityValue)
    ? fieldOf(
        sensitivityValue,
        "participant_control_started_censors_as_failure"
      )
    : undefined;
  const weighting = fieldOf(value, "marginal_weighting");
  const floorValue = fieldOf(value, "floor_ceiling");
  const floorFactor = isJsonObject(floorValue)
    ? fieldOf(floorValue, "apply_by_factor_level")
    : undefined;
  const smallSample = fieldOf(value, "small_sample_label");
  if (
    contrasts.length === 0 ||
    estimandId === null ||
    estimandOutcome === null ||
    estimandPopulation === null ||
    estimandContrast === null ||
    measureValue === null ||
    families.length === 0 ||
    (binaryInterval !== "wilson" && binaryInterval !== "wald") ||
    (riskInterval !== "newcombe" && riskInterval !== "wald") ||
    exactTest !== "fisher_two_sided" ||
    typeof censorAsFailure !== "boolean" ||
    (weighting !== "none" &&
      weighting !== "equal_cells" &&
      weighting !== "equal_assignments") ||
    (floorFactor !== null && typeof floorFactor !== "string") ||
    (smallSample !== "directional" && smallSample !== "confirmatory")
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "analysis is missing a required version 1 member.",
        json_pointer: "#/analysis"
      })
    );
    return null;
  }
  return {
    contrasts,
    primary_estimand: {
      id: estimandId,
      outcome: estimandOutcome,
      population: estimandPopulation,
      contrast: estimandContrast,
      measure: measureValue
    },
    comparison_families: families,
    methods: {
      binary_interval: binaryInterval,
      risk_difference_interval: riskInterval,
      exact_test: exactTest
    },
    sensitivity: {
      participant_control_started_censors_as_failure: censorAsFailure
    },
    marginal_weighting: weighting,
    floor_ceiling: {
      apply_by_factor_level:
        typeof floorFactor === "string" ? floorFactor : null
    },
    small_sample_label: smallSample
  };
}

function parsePaidCalls(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): PhasePaidCalls | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "paid_calls must be an object.",
        json_pointer: "#/paid_calls"
      })
    );
    return null;
  }
  const readCount = (key: string): number | null => {
    const raw = fieldOf(value, key);
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `paid_calls.${key} must be a positive integer.`,
          json_pointer: `#/paid_calls/${key}`
        })
      );
      return null;
    }
    return raw;
  };
  const primary = readCount("primary");
  const maximum = readCount("maximum_with_replacements");
  if (primary === null || maximum === null) {
    return null;
  }
  return { primary, maximum_with_replacements: maximum };
}

function protocolMetrics(protocol: StudyProtocol): ProtocolMetric[] {
  return [...protocol.metrics.primary, ...(protocol.metrics.secondary ?? [])];
}

function checkAnalysisReferences(
  plan: PhasePlan,
  protocol: StudyProtocol,
  options: PhasePlanLoadOptions,
  report: (entry: Diagnostic) => void
): void {
  const metrics = new Map(
    protocolMetrics(protocol).map((metric) => [metric.id, metric])
  );
  const factors = new Map(
    protocol.factors.map((factor) => [factor.id, factor] as const)
  );
  const analysis = plan.analysis;

  for (const contrast of analysis.contrasts) {
    const metric = metrics.get(contrast.metric);
    if (metric === undefined) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.MetricUnknown,
          message: `Contrast ${JSON.stringify(contrast.id)} references unknown metric ${JSON.stringify(contrast.metric)}.`,
          json_pointer: "#/analysis/contrasts"
        })
      );
    }
    const factor = factors.get(contrast.factor);
    if (factor === undefined) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.ContrastFactorUnknown,
          message: `Contrast ${JSON.stringify(contrast.id)} references unknown factor ${JSON.stringify(contrast.factor)}.`,
          json_pointer: "#/analysis/contrasts"
        })
      );
    } else {
      if (factor.levels.length < 2) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.ContrastNonvarying,
            message: `Contrast ${JSON.stringify(contrast.id)} is over nonvarying factor ${JSON.stringify(factor.id)}.`,
            json_pointer: "#/analysis/contrasts"
          })
        );
      }
      const levelIds = new Set(factor.levels.map((level) => level.id));
      for (const level of contrast.levels) {
        if (!levelIds.has(level)) {
          report(
            diagnostic({
              severity: "error",
              phase: "preflight",
              code: StudyCode.ContrastLevelUnknown,
              message: `Contrast ${JSON.stringify(contrast.id)} references unknown level ${JSON.stringify(level)} of factor ${JSON.stringify(factor.id)}.`,
              json_pointer: "#/analysis/contrasts"
            })
          );
        }
      }
    }
    for (const [factorId, levelId] of Object.entries(contrast.within ?? {})) {
      const withinFactor = factors.get(factorId);
      if (withinFactor === undefined) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.StratumUnknown,
            message: `Contrast ${JSON.stringify(contrast.id)} stratifies by unknown factor ${JSON.stringify(factorId)}.`,
            json_pointer: "#/analysis/contrasts"
          })
        );
        continue;
      }
      if (!withinFactor.levels.some((level) => level.id === levelId)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.StratumUnknown,
            message: `Contrast ${JSON.stringify(contrast.id)} stratifies factor ${JSON.stringify(factorId)} by unknown level ${JSON.stringify(levelId)}.`,
            json_pointer: "#/analysis/contrasts"
          })
        );
      }
    }
  }

  const contrastIds = new Set(analysis.contrasts.map((c) => c.id));
  const estimand = analysis.primary_estimand;
  const outcome = metrics.get(estimand.outcome);
  if (outcome === undefined) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.MetricUnknown,
        message: `Primary estimand references unknown outcome ${JSON.stringify(estimand.outcome)}.`,
        json_pointer: "#/analysis/primary_estimand"
      })
    );
  }
  if (!contrastIds.has(estimand.contrast)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.ContrastUnknown,
        message: `Primary estimand references unknown contrast ${JSON.stringify(estimand.contrast)}.`,
        json_pointer: "#/analysis/primary_estimand"
      })
    );
  }
  if (
    outcome !== undefined &&
    (estimand.measure === "risk_difference" ||
      estimand.measure === "risk_ratio") &&
    outcome.type !== "binary"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.MeasureIncompatible,
        message: `Measure ${JSON.stringify(estimand.measure)} requires a binary outcome; ${JSON.stringify(estimand.outcome)} is ${outcome.type}.`,
        json_pointer: "#/analysis/primary_estimand/measure"
      })
    );
  }
  const populationOk =
    estimand.population === "primary_agent_outcome" ||
    analysis.contrasts.some(
      (contrast) => contrast.population === estimand.population
    );
  if (!populationOk) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: `Primary estimand population ${JSON.stringify(estimand.population)} does not resolve.`,
        json_pointer: "#/analysis/primary_estimand/population"
      })
    );
  }

  for (const family of analysis.comparison_families) {
    for (const contrastId of family.contrasts) {
      if (!contrastIds.has(contrastId)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.ContrastUnknown,
            message: `Comparison family ${JSON.stringify(family.id)} references unknown contrast ${JSON.stringify(contrastId)}.`,
            json_pointer: "#/analysis/comparison_families"
          })
        );
      }
    }
  }

  const floorFactorId = analysis.floor_ceiling.apply_by_factor_level;
  if (floorFactorId !== null && !factors.has(floorFactorId)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.FactorUnknown,
        message: `floor_ceiling.apply_by_factor_level references unknown factor ${JSON.stringify(floorFactorId)}.`,
        json_pointer: "#/analysis/floor_ceiling"
      })
    );
  }
  void options;
}

function checkBalance(
  plan: PhasePlan,
  cellCount: number | undefined,
  report: (entry: Diagnostic) => void
): void {
  if (cellCount === undefined || cellCount < 1) {
    return;
  }
  const primary = plan.design.primary_assignments;
  if (primary % cellCount !== 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.DesignUnbalanced,
        message: `primary_assignments ${primary} is not divisible by the resolved cell count ${cellCount}.`,
        json_pointer: "#/design/primary_assignments"
      })
    );
  }
  const block = plan.design.block;
  if (block !== undefined) {
    const expected = cellCount * block.repetitions;
    if (primary !== expected) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.DesignUnbalanced,
          message: `primary_assignments ${primary} does not equal ${cellCount} cells times ${block.repetitions} repetitions.`,
          json_pointer: "#/design/primary_assignments"
        })
      );
    }
  }
}

function checkPaidCalls(
  plan: PhasePlan,
  report: (entry: Diagnostic) => void
): void {
  if (plan.paid_calls.primary !== plan.design.primary_assignments) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.PaidCallsInconsistent,
        message: `paid_calls.primary ${plan.paid_calls.primary} does not equal design.primary_assignments ${plan.design.primary_assignments}.`,
        json_pointer: "#/paid_calls/primary"
      })
    );
  }
  if (plan.paid_calls.maximum_with_replacements < plan.paid_calls.primary) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.PaidCallsInconsistent,
        message: "paid_calls.maximum_with_replacements is below primary.",
        json_pointer: "#/paid_calls/maximum_with_replacements"
      })
    );
  }
  if (
    plan.replacements !== undefined &&
    plan.replacements.kind === "none" &&
    plan.replacements.maximum_activated_per_cell !== 0
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.PaidCallsInconsistent,
        message:
          "replacements.kind none must activate zero replacements per cell.",
        json_pointer: "#/replacements/maximum_activated_per_cell"
      })
    );
  }
}

/**
 * A confirmatory phase must carry confirmatory labeling and a multiplicity
 * policy. Hypothesis and power fields arrive with a later schema version.
 */
function checkConfirmatoryRules(
  plan: PhasePlan,
  report: (entry: Diagnostic) => void
): void {
  if (plan.purpose !== "confirmatory") {
    return;
  }
  if (plan.analysis.small_sample_label !== "confirmatory") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.ConfirmatoryIncomplete,
        message: "A confirmatory phase must label its analysis confirmatory.",
        json_pointer: "#/analysis/small_sample_label"
      })
    );
  }
  if (
    !plan.analysis.comparison_families.some(
      (family) => family.multiplicity === "holm"
    )
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.ConfirmatoryIncomplete,
        message:
          "A confirmatory phase must declare a familywise error policy in at least one comparison family.",
        json_pointer: "#/analysis/comparison_families"
      })
    );
  }
}

function checkMetricSources(
  protocol: StudyProtocol,
  options: PhasePlanLoadOptions,
  report: (entry: Diagnostic) => void
): void {
  const checks = options.knownChecks;
  const signals = options.knownSignals;
  if (checks === undefined && signals === undefined) {
    return;
  }
  for (const metric of protocolMetrics(protocol)) {
    const source = metric.source;
    if (source.kind === "rubric_check" && checks !== undefined) {
      if (!checks.has(source.check_id)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.MetricSourceUnknown,
            message: `Metric ${JSON.stringify(metric.id)} references unknown rubric check ${JSON.stringify(source.check_id)}.`,
            json_pointer: "#/metrics"
          })
        );
      }
    }
    if (source.kind === "rubric_signal" && signals !== undefined) {
      if (!signals.has(source.signal_id)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.MetricSourceUnknown,
            message: `Metric ${JSON.stringify(metric.id)} references unknown rubric signal ${JSON.stringify(source.signal_id)}.`,
            json_pointer: "#/metrics"
          })
        );
      }
    }
  }
}

/** Factor roles of the protocol, keyed by factor ID. */
export function factorRoles(
  protocol: StudyProtocol
): ReadonlyMap<string, FactorRole> {
  return new Map(protocol.factors.map((factor) => [factor.id, factor.role]));
}
