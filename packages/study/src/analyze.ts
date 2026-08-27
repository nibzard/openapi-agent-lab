/**
 * Study analysis (specification sections 12.13, 23.17, and 27).
 *
 * The analyzer reads frozen artifacts only: the collected per-cell trial
 * evidence, the StudyRun header, the frozen schedule, the append-only
 * assignment ledger, and the caller's hash verifications. It never queries
 * live provider state and it never launches anything.
 *
 * Slot mapping is never reimplemented here: replacement chains resolve
 * through the report builder's slot resolution, so a mapped replacement
 * occupies exactly the primary slot it replaced. Pooling is gated by the
 * compatibility keys; a cell that fails is excluded with a diagnostic and
 * its slots never enter a denominator, but its unresolved slots stay
 * visible in the extensions so exclusion cannot silently shrink a
 * denominator.
 *
 * Refusal rules: a hash that fails verification refuses the whole
 * analysis; an incomplete required block refuses the pooled estimates
 * that draw on it; a contrast without both level cells or without an
 * estimable binary metric is withheld with a warning. Estimates the
 * schema cannot represent (a required number) are never invented.
 *
 * Every function is pure and deterministic: the same frozen inputs
 * produce byte-identical canonical JSON.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isRfc3339,
  isSafeId,
  isSha256Hex,
  sha256Hex,
  type Diagnostic,
  type Json
} from "@oal/core";
import {
  buildTrialFacts,
  resolveSlots,
  type SlotResolution,
  type TrialFacts,
  type TrialInput
} from "@oal/report";
import {
  blockCompletion,
  replacementPolicyOf,
  type AssignmentLedger,
  type AssignmentSchedule,
  type ReplacementPolicy
} from "@oal/scheduler";
import type { StudyRunHeader } from "@oal/scheduler";
import {
  fisherExactTwoSided,
  holmAdjust,
  newcombeDifferenceInterval,
  wilsonInterval
} from "@oal/statistics";
import type { ProtocolMetric, PhaseContrast, PhasePlan } from "@oal/study-ir";

import { poolCompatibleCells } from "./compatibility.ts";

/** Schema version of the emitted analysis document. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Kind marker of the emitted analysis document. */
export const ANALYSIS_KIND = "StudyAnalysis";

/** Default two-sided level when a family declares no usable alpha. */
export const DEFAULT_CONFIDENCE_LEVEL = 0.95;

/** Stable diagnostic codes of the study analyzer. */
export const AnalysisCode = {
  HashVerificationFailed: "OAL-STUDY-ANALYSIS-HASH-VERIFICATION-FAILED",
  InputInvalid: "OAL-STUDY-ANALYSIS-INPUT-INVALID",
  StudyRunMismatch: "OAL-STUDY-ANALYSIS-STUDY-RUN-MISMATCH",
  CellNotAnalytical: "OAL-STUDY-ANALYSIS-CELL-NOT-ANALYTICAL",
  BlockIncomplete: "OAL-STUDY-ANALYSIS-BLOCK-INCOMPLETE",
  ContrastCellsMissing: "OAL-STUDY-ANALYSIS-CONTRAST-CELLS-MISSING",
  ContrastMetricUnknown: "OAL-STUDY-ANALYSIS-CONTRAST-METRIC-UNKNOWN",
  ContrastMetricNotEstimable:
    "OAL-STUDY-ANALYSIS-CONTRAST-METRIC-NOT-ESTIMABLE",
  ContrastDenominatorEmpty: "OAL-STUDY-ANALYSIS-CONTRAST-DENOMINATOR-EMPTY",
  PopulationMissing: "OAL-STUDY-ANALYSIS-POPULATION-MISSING",
  MethodUnsupported: "OAL-STUDY-ANALYSIS-METHOD-UNSUPPORTED"
} as const;

/** Frozen evidence of one collected cell. */
export interface CellEvidence {
  readonly cell_id: string;
  /** Analytical flag the cell report recorded. */
  readonly analytical: boolean;
  readonly study_compatibility_sha256: string;
  readonly cell_compatibility_sha256: string;
  /** Collected trial evidence of the cell, replacements included. */
  readonly trials: readonly TrialInput[];
}

/** One hash the caller verified before analysis started. */
export interface VerificationEntry {
  readonly artifact: string;
  readonly expected_sha256: string;
  readonly observed_sha256: string;
}

export interface AnalysisLineage {
  readonly kind: "preregistered" | "derived";
  readonly parent_analysis_id?: string | null | undefined;
  readonly reason?: string | null | undefined;
}

export interface StudyAnalysisInput {
  readonly analysis_id: string;
  /** Millisecond RFC 3339 timestamp; optional in the schema. */
  readonly generated_at?: string | undefined;
  readonly lineage?: AnalysisLineage | undefined;
  readonly header: StudyRunHeader;
  readonly phasePlan: PhasePlan;
  /** Metric definitions of the locked protocol. */
  readonly metrics: readonly ProtocolMetric[];
  readonly schedule: AssignmentSchedule;
  readonly ledger: AssignmentLedger;
  readonly cells: readonly CellEvidence[];
  readonly verification: readonly VerificationEntry[];
  readonly evidence_requirements_sha256: string;
}

/** Slot outcome of one analysis slot, as the report builder resolved it. */
export interface SlotOutcome {
  readonly slot_id: string;
  readonly cell_id: string;
  /** False when the compatibility gate excluded the owning cell. */
  readonly pooled: boolean;
  readonly resolved: boolean;
  readonly source: "primary" | "replacement" | null;
  readonly supplying_run_id: string | null;
  readonly worst_case_failure: boolean;
  /** Metric satisfaction by metric identifier, resolved slots only. */
  readonly metric_values: Readonly<Record<string, boolean>>;
}

/** Typed `study-analysis.v1` document. */
export interface StudyAnalysis {
  readonly schema_version: typeof ANALYSIS_SCHEMA_VERSION;
  readonly kind: typeof ANALYSIS_KIND;
  readonly analysis_id: string;
  readonly study_run_id: string;
  readonly generated_at?: string | undefined;
  readonly lineage: {
    readonly kind: "preregistered" | "derived";
    readonly parent_analysis_id?: string | null | undefined;
    readonly reason?: string | null | undefined;
  };
  readonly verified: readonly {
    readonly artifact: string;
    readonly sha256: string;
    readonly verified: boolean;
  }[];
  readonly inputs: {
    readonly protocol_lock_sha256: string;
    readonly phase_plan_sha256: string;
    readonly phase_lock_sha256: string;
    readonly schedule_sha256: string;
    readonly compatibility_sha256: string;
    readonly implementation_sha256: string;
    readonly evidence_requirements_sha256: string;
    readonly analysis_plan_sha256: string;
  };
  readonly populations: readonly {
    readonly id: string;
    readonly numerator: number;
    readonly denominator: number;
    readonly unresolved_slots?: number | undefined;
  }[];
  readonly estimates: readonly {
    readonly contrast_id: string;
    readonly metric: string;
    readonly population: string;
    readonly cells: readonly {
      readonly cell_id: string;
      readonly numerator: number;
      readonly denominator: number;
      readonly rate: number;
      readonly interval?: readonly [number, number] | undefined;
    }[];
    readonly estimate: number;
    readonly interval?: readonly [number, number] | undefined;
    readonly p_value?: number | null | undefined;
    readonly adjusted_p_value?: number | null | undefined;
    readonly family_id?: string | null | undefined;
  }[];
  readonly sensitivity: readonly {
    readonly id: string;
    readonly estimates: readonly {
      readonly contrast_id: string;
      readonly estimate: number;
    }[];
  }[];
  readonly warnings: readonly string[];
  readonly extensions: Readonly<Record<string, Json>>;
}

export interface StudyAnalysisResult {
  readonly analysis: StudyAnalysis | null;
  /** Slot outcome table of every collected cell, included or excluded. */
  readonly slots: readonly SlotOutcome[];
  readonly excluded_cell_ids: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Counted slot facts of one cell and one metric. */
interface CellCounts {
  readonly cell_id: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly unresolved: number;
  readonly censored: number;
}

function report(
  diagnostics: Diagnostic[],
  code: string,
  message: string
): void {
  diagnostics.push(
    diagnostic({ severity: "error", phase: "evaluate", code, message })
  );
}

const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True when the metric yields one binary value per analysis slot. */
function slotBinaryMetric(
  metric: ProtocolMetric
): { check_id: string } | { signal_id: string } | null {
  if (metric.type !== "binary") {
    return null;
  }
  if (metric.source.kind === "rubric_check") {
    return { check_id: metric.source.check_id };
  }
  if (metric.source.kind === "rubric_signal") {
    return { signal_id: metric.source.signal_id };
  }
  return null;
}

/** Metric satisfaction of one supplying run, failures included. */
function metricValueOf(
  metric: ProtocolMetric,
  trial: TrialInput | undefined
): boolean {
  if (trial === undefined) {
    return false;
  }
  const evaluation = trial.evaluation ?? null;
  if (evaluation === null) {
    return false;
  }
  const source = metric.source;
  if (source.kind === "rubric_check") {
    return (
      evaluation.checks.find((check) => check.id === source.check_id)
        ?.status === "passed"
    );
  }
  if (source.kind === "rubric_signal") {
    return evaluation.signals[source.signal_id] === true;
  }
  return false;
}

/** Resolve one cell's slots and their per-metric satisfaction. */
function cellSlots(
  cell: CellEvidence,
  metrics: readonly ProtocolMetric[]
): { outcomes: SlotOutcome[]; byMetric: Map<string, CellCounts> } {
  const facts: readonly TrialFacts[] = cell.trials.map((trial) =>
    buildTrialFacts(trial)
  );
  const resolutions: readonly SlotResolution[] = resolveSlots(facts);
  const byRun = new Map(cell.trials.map((trial) => [trial.run_id, trial]));
  const outcomes: SlotOutcome[] = resolutions.map((slot) => {
    const metricValues: Record<string, boolean> = {};
    for (const metric of metrics) {
      if (slotBinaryMetric(metric) === null) {
        continue;
      }
      metricValues[metric.id] = slot.resolved
        ? metricValueOf(metric, byRun.get(slot.supplying_run_id ?? ""))
        : false;
    }
    return {
      slot_id: slot.slot_id,
      cell_id: cell.cell_id,
      pooled: true,
      resolved: slot.resolved,
      source: slot.source,
      supplying_run_id: slot.supplying_run_id,
      worst_case_failure: slot.worst_case_failure,
      metric_values: metricValues
    };
  });
  const byMetric = new Map<string, CellCounts>();
  for (const metric of metrics) {
    if (slotBinaryMetric(metric) === null) {
      continue;
    }
    let numerator = 0;
    let denominator = 0;
    let unresolved = 0;
    let censored = 0;
    for (const outcome of outcomes) {
      if (!outcome.resolved) {
        unresolved += 1;
        continue;
      }
      denominator += 1;
      if (outcome.metric_values[metric.id] === true) {
        numerator += 1;
      }
      if (outcome.worst_case_failure) {
        censored += 1;
      }
    }
    byMetric.set(metric.id, {
      cell_id: cell.cell_id,
      numerator,
      denominator,
      unresolved,
      censored
    });
  }
  return { outcomes, byMetric };
}

/** Blocks one cell's primaries live in. */
function blocksOfCell(
  schedule: AssignmentSchedule,
  cellId: string
): ReadonlySet<number> {
  const blocks = new Set<number>();
  for (const assignment of schedule.assignments) {
    if (
      assignment.kind === "primary" &&
      assignment.cell_id === cellId &&
      assignment.block_id !== null
    ) {
      blocks.add(assignment.block_id);
    }
  }
  return blocks;
}

/**
 * Analyze one StudyRun from frozen inputs. The result is null only when a
 * refusal rule fired: a failed hash verification, a mismatched StudyRun,
 * or inputs no `study-analysis.v1` document can represent.
 */
export function analyzeStudyRun(
  input: StudyAnalysisInput
): StudyAnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const warnings: string[] = [];
  const header = input.header;

  if (!isSafeId(input.analysis_id)) {
    report(
      diagnostics,
      AnalysisCode.InputInvalid,
      `analysis_id ${JSON.stringify(input.analysis_id)} is not a safe identifier.`
    );
  }
  if (input.generated_at !== undefined) {
    if (
      !RFC3339_MILLIS.test(input.generated_at) ||
      !isRfc3339(input.generated_at)
    ) {
      report(
        diagnostics,
        AnalysisCode.InputInvalid,
        `generated_at ${JSON.stringify(input.generated_at)} is not a millisecond RFC 3339 UTC timestamp.`
      );
    }
  }
  if (!isSha256Hex(input.evidence_requirements_sha256)) {
    report(
      diagnostics,
      AnalysisCode.InputInvalid,
      "evidence_requirements_sha256 is not a SHA-256 digest."
    );
  }
  if (
    input.schedule.study_run_id !== header.study_run_id ||
    input.ledger.study_run_id !== header.study_run_id
  ) {
    report(
      diagnostics,
      AnalysisCode.StudyRunMismatch,
      `The schedule and the ledger must belong to StudyRun ${JSON.stringify(header.study_run_id)}.`
    );
  }

  const verified = input.verification.map((entry) => ({
    artifact: entry.artifact,
    sha256: entry.observed_sha256,
    verified: entry.expected_sha256 === entry.observed_sha256
  }));
  for (const entry of input.verification) {
    if (entry.expected_sha256 !== entry.observed_sha256) {
      report(
        diagnostics,
        AnalysisCode.HashVerificationFailed,
        `Artifact ${JSON.stringify(entry.artifact)} changed after freezing: expected ${entry.expected_sha256}, observed ${entry.observed_sha256}.`
      );
    }
  }

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { analysis: null, slots: [], excluded_cell_ids: [], diagnostics };
  }

  const pool = poolCompatibleCells(
    {
      study_compatibility_sha256: header.study_compatibility_sha256,
      cells: header.child_batches.map((batch) => ({
        cell_id: batch.cell_id,
        cell_compatibility_sha256: batch.cell_compatibility_sha256
      }))
    },
    input.cells.map((cell) => ({
      cell_id: cell.cell_id,
      study_compatibility_sha256: cell.study_compatibility_sha256,
      cell_compatibility_sha256: cell.cell_compatibility_sha256
    }))
  );
  diagnostics.push(...pool.diagnostics);
  const included = new Set(pool.included_cell_ids);
  for (const cell of input.cells) {
    if (!included.has(cell.cell_id)) {
      continue;
    }
    if (header.phase.analytical && !cell.analytical) {
      included.delete(cell.cell_id);
      report(
        diagnostics,
        AnalysisCode.CellNotAnalytical,
        `Cell ${JSON.stringify(cell.cell_id)} reported itself as not analytical, so an analytical phase cannot pool it.`
      );
    }
  }

  const collectedCells = input.cells.filter((cell) =>
    included.has(cell.cell_id)
  );
  const collectedIds = new Set(collectedCells.map((cell) => cell.cell_id));
  for (const batch of header.child_batches) {
    if (!collectedIds.has(batch.cell_id)) {
      warnings.push(
        `${AnalysisCode.ContrastCellsMissing}: cell ${batch.cell_id} contributed no pooled evidence.`
      );
    }
  }

  const slotRows: SlotOutcome[] = [];
  const countsByCell = new Map<string, Map<string, CellCounts>>();
  for (const cell of collectedCells) {
    const resolved = cellSlots(cell, input.metrics);
    slotRows.push(...resolved.outcomes);
    countsByCell.set(cell.cell_id, resolved.byMetric);
  }
  for (const cell of input.cells) {
    if (countsByCell.has(cell.cell_id)) {
      continue;
    }
    const resolved = cellSlots(cell, input.metrics);
    slotRows.push(
      ...resolved.outcomes.map((outcome) => ({
        ...outcome,
        pooled: false
      }))
    );
  }
  slotRows.sort((a, b) =>
    a.cell_id === b.cell_id
      ? a.slot_id < b.slot_id
        ? -1
        : 1
      : a.cell_id < b.cell_id
        ? -1
        : 1
  );

  const policy: ReplacementPolicy = replacementPolicyOf(input.phasePlan);
  const completion = blockCompletion(input.schedule, input.ledger, policy);
  const incompleteBlocks = completion.filter((block) => !block.complete);
  const refusalRule =
    input.phasePlan.stopping.second_unreplaced_failure_in_cell === "abort"
      ? "second_unreplaced_failure_in_cell=abort"
      : input.phasePlan.stopping.batch_wide_pre_control_failure === "abort"
        ? "batch_wide_pre_control_failure=abort"
        : "phase-plan refusal";

  // A block is refused when the ledger left an assignment missing or when a
  // pooled cell never resolved one of the slots the schedule promised. The
  // slot rules of the report builder decide resolution, never the counts.
  const refusedBlocks = new Set<number>(
    incompleteBlocks.map((block) => block.block_id)
  );
  for (const cell of collectedCells) {
    const resolved = new Set(
      slotRows
        .filter((row) => row.cell_id === cell.cell_id && row.resolved)
        .map((row) => row.slot_id)
    );
    let unresolved = 0;
    for (const assignment of input.schedule.assignments) {
      if (
        assignment.kind !== "primary" ||
        assignment.cell_id !== cell.cell_id ||
        resolved.has(assignment.assignment_id)
      ) {
        continue;
      }
      unresolved += 1;
      if (assignment.block_id !== null) {
        refusedBlocks.add(assignment.block_id);
      }
    }
    if (unresolved === 0) {
      continue;
    }
    const counts = countsByCell.get(cell.cell_id);
    if (counts === undefined) {
      continue;
    }
    for (const metricId of [...counts.keys()]) {
      const entry = counts.get(metricId);
      if (entry !== undefined) {
        counts.set(metricId, { ...entry, unresolved });
      }
    }
  }

  const factorLevels = new Map(
    header.child_batches.map((batch) => [batch.cell_id, batch.factor_levels])
  );
  const familyOf = (contrastId: string) =>
    input.phasePlan.analysis.comparison_families.find((family) =>
      family.contrasts.includes(contrastId)
    ) ?? null;

  interface EstimateDraft {
    readonly contrast: PhaseContrast;
    readonly first: CellCounts;
    readonly second: CellCounts;
    readonly level: number;
    readonly familyId: string | null;
    readonly pValue: number | null;
  }

  const drafts: EstimateDraft[] = [];
  for (const contrast of input.phasePlan.analysis.contrasts) {
    const family = familyOf(contrast.id);
    const level =
      family === null
        ? DEFAULT_CONFIDENCE_LEVEL
        : Math.min(Math.max(1 - family.alpha, 0.5), 0.999);
    const metric = input.metrics.find((entry) => entry.id === contrast.metric);
    if (metric === undefined) {
      warnings.push(
        `${AnalysisCode.ContrastMetricUnknown}: contrast ${contrast.id} references metric ${contrast.metric}, which the protocol does not define.`
      );
      continue;
    }
    if (slotBinaryMetric(metric) === null) {
      warnings.push(
        `${AnalysisCode.ContrastMetricNotEstimable}: metric ${metric.id} is not a binary rubric check or signal, so no slot-preserving rate exists.`
      );
      continue;
    }

    const matchesSide = (
      cellId: string,
      levelId: string,
      within: Readonly<Record<string, string>>
    ): boolean => {
      const levels = factorLevels.get(cellId);
      if (levels === undefined || levels[contrast.factor] !== levelId) {
        return false;
      }
      return Object.entries(within).every(
        ([factor, level]) => levels[factor] === level
      );
    };
    const sides = [contrast.levels[0], contrast.levels[1]].map((levelId) => {
      const cellId = collectedCells
        .map((cell) => cell.cell_id)
        .find((id) => matchesSide(id, levelId, contrast.within ?? {}));
      return cellId === undefined
        ? null
        : (countsByCell.get(cellId)?.get(metric.id) ?? null);
    });
    const first = sides[0] ?? null;
    const second = sides[1] ?? null;
    if (first === null || second === null) {
      warnings.push(
        `${AnalysisCode.ContrastCellsMissing}: contrast ${contrast.id} lacks one level cell of factor ${contrast.factor}.`
      );
      continue;
    }

    const contrastCells = collectedCells
      .map((cell) => cell.cell_id)
      .filter(
        (id) =>
          matchesSide(id, contrast.levels[0], contrast.within ?? {}) ||
          matchesSide(id, contrast.levels[1], contrast.within ?? {})
      );
    const drawnBlocks = new Set<number>();
    for (const cellId of contrastCells) {
      for (const block of blocksOfCell(input.schedule, cellId)) {
        drawnBlocks.add(block);
      }
    }
    const refusedFor = [...drawnBlocks]
      .filter((block) => refusedBlocks.has(block))
      .sort((a, b) => a - b);
    if (refusedFor.length > 0) {
      warnings.push(
        `${AnalysisCode.BlockIncomplete}: contrast ${contrast.id} is refused because required block(s) ${refusedFor
          .map((block) => String(block))
          .join(", ")} hold unresolved slots (${refusalRule}).`
      );
      continue;
    }

    if (first.denominator === 0 || second.denominator === 0) {
      warnings.push(
        `${AnalysisCode.ContrastDenominatorEmpty}: contrast ${contrast.id} has no resolved slot on one side, so no difference is estimated.`
      );
      continue;
    }

    const table: [[number, number], [number, number]] = [
      [first.numerator, Math.max(first.denominator - first.numerator, 0)],
      [second.numerator, Math.max(second.denominator - second.numerator, 0)]
    ];
    const rawP = fisherExactTwoSided(table);
    drafts.push({
      contrast,
      first,
      second,
      level,
      familyId: family?.id ?? null,
      pValue: rawP > 0 && rawP <= 1 ? rawP : null
    });
  }

  const methodWarnings: string[] = [];
  if (input.phasePlan.analysis.methods.binary_interval === "wald") {
    methodWarnings.push(
      `${AnalysisCode.MethodUnsupported}: binary_interval wald is not implemented; Wilson intervals are reported.`
    );
  }
  if (input.phasePlan.analysis.methods.risk_difference_interval === "wald") {
    methodWarnings.push(
      `${AnalysisCode.MethodUnsupported}: risk_difference_interval wald is not implemented; Newcombe intervals are reported.`
    );
  }
  warnings.push(...methodWarnings);

  const adjustedByContrast = new Map<string, number>();
  for (const family of input.phasePlan.analysis.comparison_families) {
    if (family.multiplicity !== "holm") {
      continue;
    }
    const familyDrafts = drafts.filter(
      (draft) => draft.familyId === family.id && draft.pValue !== null
    );
    if (familyDrafts.length === 0) {
      continue;
    }
    const adjusted = holmAdjust(familyDrafts.map((draft) => draft.pValue ?? 1));
    for (const [index, draft] of familyDrafts.entries()) {
      const value = adjusted[index];
      if (value !== undefined) {
        adjustedByContrast.set(draft.contrast.id, value);
      }
    }
  }

  const clamp = (value: number): number => Math.min(Math.max(value, -1), 1);
  const estimates: StudyAnalysis["estimates"] = drafts.map((draft) => {
    const rateFirst = draft.first.numerator / draft.first.denominator;
    const rateSecond = draft.second.numerator / draft.second.denominator;
    const estimate =
      draft.contrast.direction === "first_minus_second"
        ? rateFirst - rateSecond
        : rateSecond - rateFirst;
    const firstInterval = wilsonInterval(
      draft.first.numerator,
      draft.first.denominator,
      draft.level
    );
    const secondInterval = wilsonInterval(
      draft.second.numerator,
      draft.second.denominator,
      draft.level
    );
    const difference =
      draft.contrast.direction === "first_minus_second"
        ? newcombeDifferenceInterval(
            draft.first.numerator,
            draft.first.denominator,
            draft.second.numerator,
            draft.second.denominator,
            draft.level
          )
        : newcombeDifferenceInterval(
            draft.second.numerator,
            draft.second.denominator,
            draft.first.numerator,
            draft.first.denominator,
            draft.level
          );
    const adjusted = adjustedByContrast.get(draft.contrast.id);
    const cells: StudyAnalysis["estimates"][number]["cells"] = [
      {
        cell_id: draft.first.cell_id,
        numerator: draft.first.numerator,
        denominator: draft.first.denominator,
        rate: rateFirst,
        ...(firstInterval === null
          ? {}
          : {
              interval: [firstInterval.lower, firstInterval.upper] as [
                number,
                number
              ]
            })
      },
      {
        cell_id: draft.second.cell_id,
        numerator: draft.second.numerator,
        denominator: draft.second.denominator,
        rate: rateSecond,
        ...(secondInterval === null
          ? {}
          : {
              interval: [secondInterval.lower, secondInterval.upper] as [
                number,
                number
              ]
            })
      }
    ];
    return {
      contrast_id: draft.contrast.id,
      metric: draft.contrast.metric,
      population: draft.contrast.metric,
      cells,
      estimate,
      ...(difference === null
        ? {}
        : {
            interval: [clamp(difference.lower), clamp(difference.upper)] as [
              number,
              number
            ]
          }),
      ...(draft.pValue === null ? {} : { p_value: draft.pValue }),
      ...(adjusted === undefined ? {} : { adjusted_p_value: adjusted }),
      family_id: draft.familyId
    };
  });

  const populations: StudyAnalysis["populations"] = [
    ...new Set(
      input.phasePlan.analysis.contrasts.map((contrast) => contrast.metric)
    )
  ]
    .filter((metricId) =>
      collectedCells.some((cell) =>
        countsByCell.get(cell.cell_id)?.has(metricId)
      )
    )
    .sort()
    .map((metricId) => {
      let numerator = 0;
      let denominator = 0;
      let unresolved = 0;
      for (const cell of collectedCells) {
        const counts = countsByCell.get(cell.cell_id)?.get(metricId);
        if (counts === undefined) {
          continue;
        }
        numerator += counts.numerator;
        denominator += counts.denominator;
        unresolved += counts.unresolved;
      }
      return {
        id: metricId,
        numerator,
        denominator,
        ...(unresolved === 0 ? {} : { unresolved_slots: unresolved })
      };
    });

  const sensitivity: {
    id: string;
    estimates: { contrast_id: string; estimate: number }[];
  }[] = [];
  if (
    input.phasePlan.analysis.sensitivity
      .participant_control_started_censors_as_failure &&
    drafts.length > 0
  ) {
    sensitivity.push({
      id: "worst_case_censor_failure",
      estimates: drafts.map((draft) => {
        const firstTotal = draft.first.denominator + draft.first.censored;
        const secondTotal = draft.second.denominator + draft.second.censored;
        const firstWorst =
          (draft.first.numerator + draft.first.censored) /
          Math.max(firstTotal, 1);
        const secondWorst =
          (draft.second.numerator + draft.second.censored) /
          Math.max(secondTotal, 1);
        return {
          contrast_id: draft.contrast.id,
          estimate:
            draft.contrast.direction === "first_minus_second"
              ? firstWorst - secondWorst
              : secondWorst - firstWorst
        };
      })
    });
  }

  if (input.phasePlan.analysis.small_sample_label === "directional") {
    warnings.push(
      "OAL-STUDY-ANALYSIS-SMALL-SAMPLE: this phase labels its estimates directional, not confirmatory."
    );
  }
  for (const entry of diagnostics) {
    if (entry.severity === "warning") {
      warnings.push(`${entry.code}: ${entry.message}`);
    }
  }
  const uniqueWarnings = [...new Set(warnings)].sort();

  if (populations.length === 0) {
    report(
      diagnostics,
      AnalysisCode.PopulationMissing,
      "No pooled population survived the compatibility gate and the metric checks, so no study-analysis.v1 document can be produced."
    );
    return {
      analysis: null,
      slots: slotRows,
      excluded_cell_ids: input.cells
        .map((cell) => cell.cell_id)
        .filter((cellId) => !included.has(cellId))
        .sort(),
      diagnostics
    };
  }

  const lineage = input.lineage ?? { kind: "preregistered" };
  const analysis: StudyAnalysis = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    kind: ANALYSIS_KIND,
    analysis_id: input.analysis_id,
    study_run_id: header.study_run_id,
    ...(input.generated_at === undefined
      ? {}
      : { generated_at: input.generated_at }),
    lineage: {
      kind: lineage.kind,
      ...(lineage.parent_analysis_id === undefined
        ? {}
        : { parent_analysis_id: lineage.parent_analysis_id }),
      ...(lineage.reason === undefined ? {} : { reason: lineage.reason })
    },
    verified,
    inputs: {
      protocol_lock_sha256: header.protocol.protocol_lock_sha256,
      phase_plan_sha256: header.phase.phase_plan_sha256,
      phase_lock_sha256: header.phase.phase_lock_sha256,
      schedule_sha256: header.assignment_schedule.sha256,
      compatibility_sha256: header.study_compatibility_sha256,
      implementation_sha256: header.implementation_sha256,
      evidence_requirements_sha256: input.evidence_requirements_sha256,
      analysis_plan_sha256: header.analysis_plan_sha256
    },
    populations,
    estimates,
    sensitivity,
    warnings: uniqueWarnings,
    extensions: {
      slot_rule: "report/resolveSlots",
      excluded_cell_ids: input.cells
        .map((cell) => cell.cell_id)
        .filter((cellId) => !included.has(cellId))
        .sort(),
      slots: slotRows.map((slot) => ({
        slot_id: slot.slot_id,
        cell_id: slot.cell_id,
        pooled: slot.pooled,
        resolved: slot.resolved,
        source: slot.source,
        supplying_run_id: slot.supplying_run_id,
        worst_case_failure: slot.worst_case_failure
      }))
    }
  };

  return {
    analysis,
    slots: slotRows,
    excluded_cell_ids: input.cells
      .map((cell) => cell.cell_id)
      .filter((cellId) => !included.has(cellId))
      .sort(),
    diagnostics
  };
}

/** JSON view of one analysis document, for schema validation. */
export function studyAnalysisJson(analysis: StudyAnalysis): Json {
  return {
    schema_version: analysis.schema_version,
    kind: analysis.kind,
    analysis_id: analysis.analysis_id,
    study_run_id: analysis.study_run_id,
    ...(analysis.generated_at === undefined
      ? {}
      : { generated_at: analysis.generated_at }),
    lineage: {
      kind: analysis.lineage.kind,
      ...(analysis.lineage.parent_analysis_id === undefined
        ? {}
        : { parent_analysis_id: analysis.lineage.parent_analysis_id }),
      ...(analysis.lineage.reason === undefined
        ? {}
        : { reason: analysis.lineage.reason })
    },
    verified: analysis.verified.map((entry) => ({
      artifact: entry.artifact,
      sha256: entry.sha256,
      verified: entry.verified
    })),
    inputs: { ...analysis.inputs },
    populations: analysis.populations.map((population) => ({
      id: population.id,
      numerator: population.numerator,
      denominator: population.denominator,
      ...(population.unresolved_slots === undefined
        ? {}
        : { unresolved_slots: population.unresolved_slots })
    })),
    estimates: analysis.estimates.map((estimate) => ({
      contrast_id: estimate.contrast_id,
      metric: estimate.metric,
      population: estimate.population,
      cells: estimate.cells.map((cell) => ({
        cell_id: cell.cell_id,
        numerator: cell.numerator,
        denominator: cell.denominator,
        rate: cell.rate,
        ...(cell.interval === undefined
          ? {}
          : { interval: [cell.interval[0], cell.interval[1]] })
      })),
      estimate: estimate.estimate,
      ...(estimate.interval === undefined
        ? {}
        : { interval: [estimate.interval[0], estimate.interval[1]] }),
      ...(estimate.p_value === undefined ? {} : { p_value: estimate.p_value }),
      ...(estimate.adjusted_p_value === undefined
        ? {}
        : { adjusted_p_value: estimate.adjusted_p_value }),
      ...(estimate.family_id === undefined
        ? {}
        : { family_id: estimate.family_id })
    })),
    sensitivity: analysis.sensitivity.map((entry) => ({
      id: entry.id,
      estimates: entry.estimates.map((item) => ({
        contrast_id: item.contrast_id,
        estimate: item.estimate
      }))
    })),
    warnings: [...analysis.warnings],
    extensions: { ...analysis.extensions }
  };
}

/** Canonical JSON bytes of one analysis document. */
export function serializeStudyAnalysis(analysis: StudyAnalysis): string {
  return canonicalJson(studyAnalysisJson(analysis));
}

/** SHA-256 over the canonical analysis bytes. */
export function studyAnalysisSha256(analysis: StudyAnalysis): string {
  return sha256Hex(serializeStudyAnalysis(analysis));
}

/** Content digest used by reproducibility checks. */
export function studyAnalysisContentSha256(analysis: StudyAnalysis): string {
  return canonicalJsonSha256(studyAnalysisJson(analysis));
}
