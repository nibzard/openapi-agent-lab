/**
 * Study review checks above the schema level (specification sections 12.8,
 * 12.9, 12.10, 12.12, and 12.13).
 *
 * The loaders in `@oal/study-ir` prove that a protocol and its plans are
 * well formed. This module proves the design is sound: factors balance
 * across the resolved cell inventory, counterfactual arms stay comparable,
 * blinding rules hold, and an analytical run cannot start before a
 * verified protocol lock exists.
 */

import {
  expandCellProduct,
  StudyCode,
  type BlindingReview,
  type EquivalenceReview,
  type PhasePlan,
  type ProtocolLock,
  type ProtocolLockVerifyResult,
  type StudyIR,
  type StudyProtocol
} from "@oal/study-ir";

/** Review-specific codes the loaders cannot emit. */
export const ReviewCode = {
  FactorNonvarying: "OAL-STUDY-FACTOR-NONVARYING",
  CounterfactualArmMixed: "OAL-STUDY-COUNTERFACTUAL-ARM-MIXED",
  VariantsWithoutSet: "OAL-STUDY-VARIANTS-WITHOUT-SET",
  EquivalenceReviewMissing: "OAL-STUDY-EQUIVALENCE-REVIEW-MISSING",
  EquivalenceReviewIncomplete: "OAL-STUDY-EQUIVALENCE-REVIEW-INCOMPLETE",
  BlindingPolicyMissing: "OAL-STUDY-BLINDING-POLICY-MISSING",
  BlindingReviewIncomplete: "OAL-STUDY-BLINDING-REVIEW-INCOMPLETE",
  BlindingReviewCellUnknown: "OAL-STUDY-BLINDING-REVIEW-CELL-UNKNOWN",
  LockMissing: "OAL-STUDY-LOCK-MISSING",
  LockDrifted: "OAL-STUDY-LOCK-DRIFTED",
  LockIdentityMismatch: "OAL-STUDY-LOCK-IDENTITY-MISMATCH",
  PhaseUndeclared: "OAL-STUDY-PHASE-UNDECLARED"
} as const;

export interface StudyFinding {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export interface StudyReviewInput {
  readonly protocol: StudyProtocol;
  /** Compiled IR. Supplies the resolved cell inventory when present. */
  readonly ir?: StudyIR | undefined;
  /** Parsed phase plans by protocol phase ID. */
  readonly phases?: ReadonlyMap<string, PhasePlan> | undefined;
  readonly lock?: ProtocolLock | undefined;
  readonly blindingReview?: BlindingReview | undefined;
  readonly equivalenceReview?: EquivalenceReview | undefined;
}

export interface AnalyticalRunInput {
  readonly protocol: StudyProtocol;
  readonly phasePlan: PhasePlan;
  readonly lock?: ProtocolLock | undefined;
  readonly lockVerification?: ProtocolLockVerifyResult | undefined;
}

export interface AnalyticalRunDecision {
  readonly allowed: boolean;
  readonly findings: readonly StudyFinding[];
}

/** Resolved cell count of the design. */
export function resolvedCellCount(input: StudyReviewInput): number {
  if (input.ir !== undefined) {
    return input.ir.cells.length;
  }
  return expandCellProduct(input.protocol.factors).length;
}

/**
 * Review one study design. Every returned error blocks validation; a
 * warning is advisory only.
 */
export function reviewStudyDesign(input: StudyReviewInput): StudyFinding[] {
  const findings: StudyFinding[] = [];
  const cellCount = resolvedCellCount(input);

  checkPhaseCoverage(input, findings);
  checkFactorVariation(input, findings);
  checkFactorBalance(input, cellCount, findings);
  checkCounterfactualArms(input, findings);
  checkBlindingRules(input, findings);

  return findings;
}

/**
 * Decide whether an analytical run may start. A phase marked analytical
 * requires a protocol lock that verifies without drift.
 */
export function preflightAnalyticalRun(
  input: AnalyticalRunInput
): AnalyticalRunDecision {
  const findings: StudyFinding[] = [];
  const lock = input.lock;

  if (lock === undefined) {
    if (input.phasePlan.analytical) {
      findings.push({
        severity: "error",
        code: ReviewCode.LockMissing,
        message: "An analytical phase cannot run before a protocol lock exists."
      });
      return { allowed: false, findings };
    }
    findings.push({
      severity: "warning",
      code: ReviewCode.LockMissing,
      message:
        "The phase runs without a protocol lock, so its evidence stays operational."
    });
    return { allowed: true, findings };
  }

  if (
    lock.protocol_id !== input.protocol.metadata.id ||
    lock.protocol_version !== input.protocol.metadata.version
  ) {
    findings.push({
      severity: "error",
      code: ReviewCode.LockIdentityMismatch,
      message: "The protocol lock records a different protocol ID or version."
    });
  }

  const verification = input.lockVerification;
  if (verification !== undefined && !verification.ok) {
    for (const drift of verification.drift) {
      const at = drift.path === null ? "" : ` at ${JSON.stringify(drift.path)}`;
      findings.push({
        severity: "error",
        code: ReviewCode.LockDrifted,
        message: `Protocol lock drift (${drift.kind})${at}: ${drift.detail}`
      });
    }
  }

  const errors = findings.some((finding) => finding.severity === "error");
  return { allowed: !errors, findings };
}

function checkPhaseCoverage(
  input: StudyReviewInput,
  findings: StudyFinding[]
): void {
  const phases = input.phases;
  if (phases === undefined) {
    return;
  }
  for (const key of Object.keys(input.protocol.phases)) {
    if (!phases.has(key)) {
      findings.push({
        severity: "error",
        code: StudyCode.PhasePlanMissing,
        message: `Phase ${JSON.stringify(key)} has no parsed PhasePlan.`
      });
    }
  }
  for (const key of phases.keys()) {
    if (!(key in input.protocol.phases)) {
      findings.push({
        severity: "error",
        code: ReviewCode.PhaseUndeclared,
        message: `PhasePlan ${JSON.stringify(key)} is not declared by the protocol.`
      });
    }
  }
}

function checkFactorVariation(
  input: StudyReviewInput,
  findings: StudyFinding[]
): void {
  for (const factor of input.protocol.factors) {
    if (factor.levels.length >= 2) {
      continue;
    }
    const severity =
      factor.role === "treatment" || factor.role === "exposure"
        ? "error"
        : "warning";
    findings.push({
      severity,
      code: ReviewCode.FactorNonvarying,
      message: `Factor ${JSON.stringify(factor.id)} does not vary; it declares one level.`
    });
  }
}

/** A balanced blocked design needs the primary count divisible by cells. */
function checkFactorBalance(
  input: StudyReviewInput,
  cellCount: number,
  findings: StudyFinding[]
): void {
  const phases = input.phases;
  if (phases === undefined || cellCount < 1) {
    return;
  }
  for (const [phaseId, plan] of phases) {
    if (!plan.analytical) {
      continue;
    }
    const primary = plan.design.primary_assignments;
    if (primary % cellCount !== 0) {
      findings.push({
        severity: "error",
        code: StudyCode.DesignUnbalanced,
        message: `Phase ${JSON.stringify(phaseId)} schedules ${primary} primary assignments over ${cellCount} cells; the counts do not balance.`
      });
    }
    const block = plan.design.block;
    if (block !== undefined && primary !== cellCount * block.repetitions) {
      findings.push({
        severity: "error",
        code: StudyCode.DesignUnbalanced,
        message: `Phase ${JSON.stringify(phaseId)} declares ${block.repetitions} repetitions per block, which needs ${cellCount * block.repetitions} primary assignments, not ${primary}.`
      });
    }
  }
}

/**
 * Counterfactual arms stay comparable only when a factor either selects a
 * contract variant at every level or at none (specification section 12.12).
 */
function checkCounterfactualArms(
  input: StudyReviewInput,
  findings: StudyFinding[]
): void {
  const usesVariants = input.protocol.factors.some((factor) =>
    factor.levels.some((level) => level.contract_variant !== undefined)
  );
  if (!usesVariants) {
    return;
  }
  if (input.protocol.evaluation.contract_variant_set === undefined) {
    findings.push({
      severity: "error",
      code: ReviewCode.VariantsWithoutSet,
      message:
        "A factor selects contract variants, but the protocol names no ContractVariantSet."
    });
  }
  for (const factor of input.protocol.factors) {
    const withVariant = factor.levels.filter(
      (level) => level.contract_variant !== undefined
    ).length;
    if (withVariant > 0 && withVariant !== factor.levels.length) {
      findings.push({
        severity: "error",
        code: ReviewCode.CounterfactualArmMixed,
        message: `Factor ${JSON.stringify(factor.id)} mixes variant arms with patch-only arms; every level must select a contract variant or none must.`
      });
    }
  }
  checkEquivalenceReview(input, findings);
}

function checkEquivalenceReview(
  input: StudyReviewInput,
  findings: StudyFinding[]
): void {
  const analytical = [...(input.phases?.values() ?? [])].some(
    (plan) => plan.analytical
  );
  if (!analytical) {
    return;
  }
  const review = input.equivalenceReview;
  if (review === undefined) {
    findings.push({
      severity: "error",
      code: ReviewCode.EquivalenceReviewMissing,
      message:
        "An analytical phase over counterfactual variants needs an approved equivalence review."
    });
    return;
  }
  if (!review.approved) {
    findings.push({
      severity: "error",
      code: ReviewCode.EquivalenceReviewIncomplete,
      message: "The equivalence review is not approved."
    });
  }
  const lock = input.lock;
  if (lock === undefined) {
    return;
  }
  const reviewed = new Set(review.reviewed.map((entry) => entry.sha256));
  for (const [variant, digest] of Object.entries(lock.effective_contracts)) {
    if (!reviewed.has(digest)) {
      findings.push({
        severity: "error",
        code: ReviewCode.EquivalenceReviewIncomplete,
        message: `The equivalence review does not cover the effective contract digest of variant ${JSON.stringify(variant)}.`
      });
    }
  }
}

function checkBlindingRules(
  input: StudyReviewInput,
  findings: StudyFinding[]
): void {
  const blinding = input.protocol.blinding;
  if (
    blinding.mode === "strict" &&
    blinding.participant_surface_policy === undefined
  ) {
    findings.push({
      severity: "error",
      code: ReviewCode.BlindingPolicyMissing,
      message: "Strict blinding requires a participant surface policy."
    });
  }
  if (blinding.require_pairwise_surface_diff_review !== true) {
    return;
  }
  const review = input.blindingReview;
  if (review === undefined) {
    findings.push({
      severity: "error",
      code: ReviewCode.BlindingReviewIncomplete,
      message:
        "The protocol requires a pairwise surface diff review, but none was supplied."
    });
    return;
  }
  if (!review.approved) {
    findings.push({
      severity: "error",
      code: ReviewCode.BlindingReviewIncomplete,
      message: "The pairwise surface diff review is not approved."
    });
  }
  const cellIds = new Set((input.ir?.cells ?? []).map((cell) => cell.cell_id));
  if (cellIds.size === 0) {
    return;
  }
  for (const surface of review.reviewed_surfaces) {
    if (!cellIds.has(surface.cell_id)) {
      findings.push({
        severity: "error",
        code: ReviewCode.BlindingReviewCellUnknown,
        message: `The surface review names cell ${JSON.stringify(surface.cell_id)}, which the design does not resolve.`
      });
    }
  }
  const reviewedCells = new Set(
    review.reviewed_surfaces.map((surface) => surface.cell_id)
  );
  for (const cellId of cellIds) {
    if (!reviewedCells.has(cellId)) {
      findings.push({
        severity: "error",
        code: ReviewCode.BlindingReviewIncomplete,
        message: `The pairwise surface diff review does not cover cell ${JSON.stringify(cellId)}.`
      });
    }
  }
}
