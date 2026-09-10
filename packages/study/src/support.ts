/**
 * Analysis support check (review fix plan, work package F3).
 *
 * The loaders in `@oal/study-ir` parse every field a `phase-plan.v1`
 * document accepts, including archived values this build cannot
 * execute. Parsing stays permissive on purpose: an old plan must keep
 * loading. This module is the separate permission layer. It decides
 * whether a parsed plan stays inside the set of calculations the
 * analyzer implements, and it runs before any estimate is computed.
 *
 * The supported calculation is exactly the implemented one: the binary
 * risk difference over slot counts with Wilson cell intervals, the
 * Newcombe difference interval, the Fisher exact two-sided test, and
 * Holm adjustment inside one comparison family. Nothing substitutes
 * for an unsupported option. Every rejection names the option with a
 * stable diagnostic code.
 */

import {
  deriveCellId,
  expandCellProduct,
  type PhaseContrast,
  type PhasePlan,
  type StudyProtocol
} from "@oal/study-ir";

import type { StudyFinding } from "./validate.ts";

/**
 * The only population the analyzer composes: the resolved
 * `primary_agent_outcome` slots of every pooled cell.
 */
export const SUPPORTED_POPULATION = "primary_agent_outcome";

/** Stable diagnostic codes of the analysis support check. */
export const SupportCode = {
  MeasureUnsupported: "OAL-STUDY-ANALYSIS-MEASURE-UNSUPPORTED",
  MethodUnsupported: "OAL-STUDY-ANALYSIS-METHOD-UNSUPPORTED",
  WeightingUnsupported: "OAL-STUDY-ANALYSIS-WEIGHTING-UNSUPPORTED",
  FloorCeilingUnsupported: "OAL-STUDY-ANALYSIS-FLOOR-CEILING-UNSUPPORTED",
  EligibilityUnsupported: "OAL-STUDY-ANALYSIS-ELIGIBILITY-UNSUPPORTED",
  PopulationUnsupported: "OAL-STUDY-ANALYSIS-POPULATION-UNSUPPORTED",
  OutcomeInconsistent: "OAL-STUDY-ANALYSIS-OUTCOME-INCONSISTENT",
  ContrastAmbiguous: "OAL-STUDY-ANALYSIS-CONTRAST-AMBIGUOUS",
  FamilyOverlapping: "OAL-STUDY-ANALYSIS-FAMILY-OVERLAPPING"
} as const;

/** One planned cell with its factor levels. */
export interface AnalysisCellView {
  readonly cell_id: string;
  readonly factor_levels: Readonly<Record<string, string>>;
}

export interface AnalysisSupportInput {
  readonly phasePlan: PhasePlan;
  /**
   * Resolved cell inventory. When supplied, every contrast side must
   * match exactly one cell; otherwise the ambiguity check is skipped.
   */
  readonly cells?: readonly AnalysisCellView[] | undefined;
}

/** Planned cells of a protocol, derived from its factor product. */
export function protocolCellViews(
  protocol: StudyProtocol
): readonly AnalysisCellView[] {
  return expandCellProduct(protocol.factors).map((factorLevels) => ({
    cell_id: deriveCellId(protocol.factors, factorLevels),
    factor_levels: factorLevels
  }));
}

/** Cells of one contrast side: the level plus every within stratum. */
function cellsOfSide(
  contrast: PhaseContrast,
  cells: readonly AnalysisCellView[],
  levelId: string
): readonly AnalysisCellView[] {
  const within = contrast.within ?? {};
  return cells.filter((cell) => {
    if (cell.factor_levels[contrast.factor] !== levelId) {
      return false;
    }
    return Object.entries(within).every(
      ([factor, level]) => cell.factor_levels[factor] === level
    );
  });
}

/**
 * Decide whether a parsed phase plan stays inside the implemented
 * analysis surface. Every returned finding is an error; a plan with
 * findings must not execute.
 */
export function checkAnalysisSupport(
  input: AnalysisSupportInput
): readonly StudyFinding[] {
  const findings: StudyFinding[] = [];
  const analysis = input.phasePlan.analysis;
  const estimand = analysis.primary_estimand;
  const reject = (code: string, message: string): void => {
    findings.push({ severity: "error", code, message });
  };

  if (estimand.measure !== "risk_difference") {
    reject(
      SupportCode.MeasureUnsupported,
      `Measure ${JSON.stringify(estimand.measure)} is not implemented; this ` +
        "build estimates only the binary risk difference. No difference is " +
        "substituted for it."
    );
  }

  if (analysis.methods.binary_interval !== "wilson") {
    reject(
      SupportCode.MethodUnsupported,
      `methods.binary_interval ${JSON.stringify(
        analysis.methods.binary_interval
      )} is not implemented; only Wilson cell intervals exist. No interval ` +
        "is substituted."
    );
  }
  if (analysis.methods.risk_difference_interval !== "newcombe") {
    reject(
      SupportCode.MethodUnsupported,
      `methods.risk_difference_interval ${JSON.stringify(
        analysis.methods.risk_difference_interval
      )} is not implemented; only the Newcombe interval exists. No interval ` +
        "is substituted."
    );
  }
  // `methods.exact_test` needs no comparison: version 1 accepts only the
  // value "fisher_two_sided", so no other test can parse, and the parsed
  // type proves it.

  if (analysis.marginal_weighting !== "none") {
    reject(
      SupportCode.WeightingUnsupported,
      `marginal_weighting ${JSON.stringify(
        analysis.marginal_weighting
      )} is not implemented; population counts pool raw slot numerators ` +
        "and denominators without weighting."
    );
  }

  if (analysis.floor_ceiling.apply_by_factor_level !== null) {
    reject(
      SupportCode.FloorCeilingUnsupported,
      `floor_ceiling.apply_by_factor_level ${JSON.stringify(
        analysis.floor_ceiling.apply_by_factor_level
      )} is declared, but the analyzer checks only that the factor exists; ` +
        "no floor or ceiling rule is executed."
    );
  }

  // The executed slot eligibility is fixed in the report builder: a
  // slot needs participant control and censor class none. That rule
  // enforces every eligibility value the loader accepts: `require` is
  // pinned to participant_control_started, `api_behavior.require` to
  // the two enforced trace conditions, and every parseable exclusion
  // censor class is a class the executed rule already excludes. The
  // loader vocabulary and the executed rule coincide, so no accepted
  // declaration can go beyond what is enforced.

  if (estimand.population !== SUPPORTED_POPULATION) {
    reject(
      SupportCode.PopulationUnsupported,
      `Primary estimand population ${JSON.stringify(
        estimand.population
      )} is not implemented; the analyzer composes only ` +
        `population ${JSON.stringify(SUPPORTED_POPULATION)}.`
    );
  }
  for (const contrast of analysis.contrasts) {
    if (
      contrast.population !== undefined &&
      contrast.population !== SUPPORTED_POPULATION
    ) {
      reject(
        SupportCode.PopulationUnsupported,
        `Contrast ${JSON.stringify(contrast.id)} declares population ` +
          `${JSON.stringify(contrast.population)}, which the analyzer does ` +
          `not compose; only ${JSON.stringify(SUPPORTED_POPULATION)} exists.`
      );
    }
  }

  const referenced = analysis.contrasts.find(
    (contrast) => contrast.id === estimand.contrast
  );
  if (referenced !== undefined && referenced.metric !== estimand.outcome) {
    reject(
      SupportCode.OutcomeInconsistent,
      `Primary estimand outcome ${JSON.stringify(estimand.outcome)} does ` +
        `not match the metric of its contrast ${JSON.stringify(
          estimand.contrast
        )}, which is ${JSON.stringify(referenced.metric)}.`
    );
  }

  const familyOfContrast = new Map<string, number>();
  for (const family of analysis.comparison_families) {
    for (const contrastId of family.contrasts) {
      familyOfContrast.set(
        contrastId,
        (familyOfContrast.get(contrastId) ?? 0) + 1
      );
    }
  }
  for (const [contrastId, count] of familyOfContrast) {
    if (count > 1) {
      reject(
        SupportCode.FamilyOverlapping,
        `Contrast ${JSON.stringify(contrastId)} belongs to ${count} ` +
          "comparison-family slots; overlapping families have no defined " +
          "execution."
      );
    }
  }

  if (input.cells !== undefined) {
    for (const contrast of analysis.contrasts) {
      for (const levelId of contrast.levels) {
        const matching = cellsOfSide(contrast, input.cells, levelId);
        if (matching.length > 1) {
          reject(
            SupportCode.ContrastAmbiguous,
            `Contrast ${JSON.stringify(contrast.id)} side ` +
              `${JSON.stringify(levelId)} of factor ` +
              `${JSON.stringify(contrast.factor)} matches ${matching.length} ` +
              `cells (${matching
                .map((cell) => cell.cell_id)
                .sort()
                .join(", ")}); ` +
              "no marginal analysis exists to pool them."
          );
        }
      }
    }
  }

  return findings;
}
