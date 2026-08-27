/**
 * Descriptive comparison of two or more reports (specification
 * sections 27.5 and 27.6).
 *
 * Ordinary comparison renders results side by side. It never pools
 * numerators across different compatibility keys, never treats matched
 * run seeds as pairing, and never upgrades a descriptive result to a
 * confirmatory claim. Every interval and p-value comes from the
 * statistics helpers; when a helper declines to produce a value, the
 * comparison reports null instead of inventing one.
 */

import {
  fisherExactTwoSided,
  holmAdjust,
  mcnemarExact,
  newcombeDifferenceInterval,
  pairedDifference,
  type PairedBinary
} from "@oal/statistics";
import type { Json } from "@oal/core";
import type { Report, ReportMetric, ReportScope } from "./model.ts";

/** Default familywise error rate for the declared family. */
export const DEFAULT_ALPHA = 0.05;

/** Default confidence level for intervals. */
export const DEFAULT_LEVEL = 0.95;

/** Default family identifier for the Holm adjustment. */
export const DEFAULT_FAMILY_ID = "compare";

/** Preregistered paired counts for one metric. */
export interface PairedMetricInput {
  readonly metric_id: string;
  readonly counts: PairedBinary;
}

export interface CompareOptions {
  readonly alpha?: number | undefined;
  readonly level?: number | undefined;
  readonly family_id?: string | undefined;
  readonly paired?: readonly PairedMetricInput[] | undefined;
}

export type MetricVerdict =
  | "difference_detected"
  | "no_difference_detected"
  | "not_estimable"
  | "not_compared_incompatible";

export interface RateSide {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

export interface MetricComparison {
  readonly metric_id: string;
  readonly baseline: RateSide | null;
  readonly candidate: RateSide | null;
  /** Candidate rate minus baseline rate, when both rates exist. */
  readonly delta: number | null;
  /** Newcombe hybrid-score interval for the risk difference. */
  readonly interval: readonly [number, number] | null;
  /** Two-sided Fisher exact p-value for the 2x2 table. */
  readonly p_value: number | null;
  /** Holm-adjusted p-value within the declared family. */
  readonly adjusted_p_value: number | null;
  readonly verdict: MetricVerdict;
}

export interface PairedMetricComparison {
  readonly metric_id: string;
  readonly counts: PairedBinary;
  readonly difference: number | null;
  readonly discordant: number;
  readonly n: number;
  readonly p_value: number | null;
  readonly adjusted_p_value: number | null;
  readonly verdict: MetricVerdict;
}

export interface ReportComparison {
  readonly schema_version: 1;
  readonly kind: "ReportComparison";
  readonly baseline_scope: ReportScope;
  readonly candidate_scope: ReportScope;
  readonly compatibility_sha256: {
    readonly baseline: readonly string[];
    readonly candidate: readonly string[];
  };
  /** False when the compatibility gate refuses pooled estimates. */
  readonly compatible: boolean;
  /** Sorted, human-readable reasons for every compatibility refusal. */
  readonly compatibility_differences: readonly string[];
  /**
   * Cell-identity concerns that never refuse pooling and never pair:
   * a shared cohort seed, for example, is reported here instead of
   * being read as preregistered pairing (section 27.6).
   */
  readonly pairing_warnings: readonly string[];
  readonly family_id: string | null;
  readonly alpha: number;
  readonly metrics: readonly MetricComparison[];
  readonly paired: readonly PairedMetricComparison[];
  readonly only_baseline_metric_ids: readonly string[];
  readonly only_candidate_metric_ids: readonly string[];
  readonly interpretation: "descriptive" | "incompatible";
  readonly maximum_claim: string;
}

const INCOMPATIBLE_CLAIM =
  "Compatibility keys differ. Counts are shown side by side; no pooled estimate, p-value, or winner claim is computed.";
const DESCRIPTIVE_CLAIM =
  "Descriptive comparison only. Adjusted p-values never establish a confirmatory claim, and a non-significant result is not evidence of equivalence.";

/** Extensions and cell input-digest keys that name the cohort seed. */
const COHORT_SEED_KEYS: readonly string[] = [
  "cohort_seed",
  "cohort_seed_sha256"
];

/**
 * Cohort seed identity of one report, from its extensions or its cell
 * input digests. Two cells of one study share it by construction, so
 * it can never serve as pairing evidence.
 */
function cohortSeedOf(report: Report): string | null {
  for (const key of COHORT_SEED_KEYS) {
    const value = report.extensions[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  for (const cell of report.provenance.cells) {
    const digest = cell.input_digests?.["cohort_seed"];
    if (typeof digest === "string" && digest.length > 0) {
      return digest;
    }
  }
  return null;
}

/**
 * Warnings about shared identities that are not pairing. Matching run
 * or cohort seeds never establish pairing (section 27.6); only the
 * preregistered assignment-unit pairing the caller passes does.
 */
function pairingWarnings(
  baseline: Report,
  candidate: Report,
  paired: readonly PairedMetricInput[]
): string[] {
  const warnings: string[] = [];
  const baselineSeed = cohortSeedOf(baseline);
  const candidateSeed = cohortSeedOf(candidate);
  if (
    baselineSeed !== null &&
    baselineSeed === candidateSeed &&
    paired.length === 0
  ) {
    warnings.push(
      `shared cohort seed ${baselineSeed} never establishes pairing (section 27.6)`
    );
  }
  return warnings;
}

function metricSide(metric: ReportMetric): RateSide {
  const rate =
    metric.denominator > 0 ? metric.numerator / metric.denominator : null;
  return {
    numerator: metric.numerator,
    denominator: metric.denominator,
    rate
  };
}

function metricById(report: Report): Map<string, ReportMetric> {
  const map = new Map<string, ReportMetric>();
  for (const metric of report.metrics) {
    if (!map.has(metric.id)) {
      map.set(metric.id, metric);
    }
  }
  return map;
}

function compatibilityDigests(report: Report): string[] {
  const digests = new Set<string>();
  for (const cell of report.provenance.cells) {
    digests.add(cell.compatibility_sha256);
  }
  return [...digests].sort();
}

/**
 * Compatibility gate (section 27.5). Equal and non-empty digest sets,
 * or two empty sets, pass. Anything else refuses pooled estimates.
 * Mixed analytical status and smoke flags also refuse.
 */
export function computeCompatibility(
  baseline: Report,
  candidate: Report
): { compatible: boolean; differences: string[] } {
  const differences: string[] = [];
  const baselineDigests = compatibilityDigests(baseline);
  const candidateDigests = compatibilityDigests(candidate);
  if (baselineDigests.length === 0 && candidateDigests.length === 0) {
    differences.push("neither report carries compatibility keys");
  } else if (baselineDigests.length === 0 || candidateDigests.length === 0) {
    differences.push("one report carries no compatibility keys");
  } else {
    for (const digest of baselineDigests) {
      if (!candidateDigests.includes(digest)) {
        differences.push(`compatibility key only in baseline: ${digest}`);
      }
    }
    for (const digest of candidateDigests) {
      if (!baselineDigests.includes(digest)) {
        differences.push(`compatibility key only in candidate: ${digest}`);
      }
    }
  }
  const baselineStatus = analyticalStatus(baseline);
  const candidateStatus = analyticalStatus(candidate);
  if (baselineStatus !== null && candidateStatus !== null) {
    if (baselineStatus !== candidateStatus) {
      differences.push(
        `analytical status differs: baseline ${baselineStatus}, candidate ${candidateStatus}`
      );
    }
  }
  const baselineSmoke = isSmoke(baseline);
  const candidateSmoke = isSmoke(candidate);
  if (baselineSmoke !== candidateSmoke) {
    differences.push(
      "smoke data must not pool with analytical data (section 27.4)"
    );
  }
  return { compatible: differences.length === 0, differences };
}

function extensionFlag(report: Report, key: string): Json | undefined {
  return report.extensions[key];
}

function analyticalStatus(report: Report): string | null {
  const value = extensionFlag(report, "analytical_status");
  return typeof value === "string" ? value : null;
}

function isSmoke(report: Report): boolean {
  return extensionFlag(report, "is_smoke") === true;
}

/**
 * Compare a candidate report against a baseline report. The comparison
 * is a pure function of the two documents and the options.
 */
export function compareReports(
  baseline: Report,
  candidate: Report,
  options: CompareOptions = {}
): ReportComparison {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const level = options.level ?? DEFAULT_LEVEL;
  const familyId = options.family_id ?? DEFAULT_FAMILY_ID;
  const gate = computeCompatibility(baseline, candidate);

  const baselineMetrics = metricById(baseline);
  const candidateMetrics = metricById(candidate);
  const sharedIds = [...baselineMetrics.keys()]
    .filter((id) => candidateMetrics.has(id))
    .sort();
  const onlyBaseline = [...baselineMetrics.keys()]
    .filter((id) => !candidateMetrics.has(id))
    .sort();
  const onlyCandidate = [...candidateMetrics.keys()]
    .filter((id) => !baselineMetrics.has(id))
    .sort();

  const drafts: Array<{
    metric_id: string;
    baseline: RateSide | null;
    candidate: RateSide | null;
    p_value: number | null;
    interval: readonly [number, number] | null;
    delta: number | null;
    verdict: MetricVerdict;
  }> = [];
  const pValues: number[] = [];
  for (const metricId of sharedIds) {
    const baselineMetric = baselineMetrics.get(metricId);
    const candidateMetric = candidateMetrics.get(metricId);
    if (baselineMetric === undefined || candidateMetric === undefined) {
      continue;
    }
    const baselineSide = metricSide(baselineMetric);
    const candidateSide = metricSide(candidateMetric);
    if (!gate.compatible) {
      drafts.push({
        metric_id: metricId,
        baseline: baselineSide,
        candidate: candidateSide,
        delta: null,
        interval: null,
        p_value: null,
        verdict: "not_compared_incompatible"
      });
      continue;
    }
    if (baselineSide.rate === null || candidateSide.rate === null) {
      drafts.push({
        metric_id: metricId,
        baseline: baselineSide,
        candidate: candidateSide,
        delta: null,
        interval: null,
        p_value: null,
        verdict: "not_estimable"
      });
      continue;
    }
    const delta = candidateSide.rate - baselineSide.rate;
    const newcombe = newcombeDifferenceInterval(
      candidateSide.numerator,
      candidateSide.denominator,
      baselineSide.numerator,
      baselineSide.denominator,
      level
    );
    const pValue = fisherExactTwoSided([
      [
        candidateSide.numerator,
        candidateSide.denominator - candidateSide.numerator
      ],
      [
        baselineSide.numerator,
        baselineSide.denominator - baselineSide.numerator
      ]
    ]);
    pValues.push(pValue);
    drafts.push({
      metric_id: metricId,
      baseline: baselineSide,
      candidate: candidateSide,
      delta,
      interval:
        newcombe === null ? null : ([newcombe.lower, newcombe.upper] as const),
      p_value: pValue,
      verdict: "no_difference_detected"
    });
  }
  const adjusted = holmAdjust(pValues);
  let adjustedIndex = 0;
  const metrics: MetricComparison[] = drafts.map((draft) => {
    if (draft.p_value === null) {
      return { ...draft, adjusted_p_value: null };
    }
    const adjustedP = adjusted[adjustedIndex] ?? null;
    adjustedIndex += 1;
    return {
      ...draft,
      adjusted_p_value: adjustedP,
      verdict:
        adjustedP !== null && adjustedP <= alpha
          ? "difference_detected"
          : "no_difference_detected"
    };
  });

  const paired = gate.compatible
    ? comparePairedMetrics(options.paired ?? [], alpha)
    : (options.paired ?? []).map((entry) => ({
        metric_id: entry.metric_id,
        counts: entry.counts,
        difference: null,
        discordant: entry.counts.onlyFirst + entry.counts.onlySecond,
        n:
          entry.counts.both +
          entry.counts.onlyFirst +
          entry.counts.onlySecond +
          entry.counts.neither,
        p_value: null,
        adjusted_p_value: null,
        verdict: "not_compared_incompatible" as const
      }));

  return {
    schema_version: 1,
    kind: "ReportComparison",
    baseline_scope: baseline.scope,
    candidate_scope: candidate.scope,
    compatibility_sha256: {
      baseline: compatibilityDigests(baseline),
      candidate: compatibilityDigests(candidate)
    },
    compatible: gate.compatible,
    compatibility_differences: gate.differences,
    pairing_warnings: pairingWarnings(
      baseline,
      candidate,
      options.paired ?? []
    ),
    family_id:
      gate.compatible && metrics.length + paired.length > 0 ? familyId : null,
    alpha,
    metrics,
    paired,
    only_baseline_metric_ids: onlyBaseline,
    only_candidate_metric_ids: onlyCandidate,
    interpretation: gate.compatible ? "descriptive" : "incompatible",
    maximum_claim: gate.compatible ? DESCRIPTIVE_CLAIM : INCOMPATIBLE_CLAIM
  };
}

/**
 * Paired comparisons over preregistered pair counts. Matching run
 * seeds never establish pairing (section 27.6); the caller must hold
 * the preregistered assignment-unit pairing.
 */
export function comparePairedMetrics(
  paired: readonly PairedMetricInput[],
  alpha: number
): PairedMetricComparison[] {
  const drafts: Array<Omit<PairedMetricComparison, "adjusted_p_value">> = [];
  const pValues: number[] = [];
  for (const entry of [...paired].sort((a, b) =>
    a.metric_id < b.metric_id ? -1 : 1
  )) {
    const difference = pairedDifference(entry.counts);
    const pValue = mcnemarExact(entry.counts);
    if (difference !== null) {
      pValues.push(pValue);
    }
    drafts.push({
      metric_id: entry.metric_id,
      counts: entry.counts,
      difference: difference === null ? null : difference.difference,
      discordant: entry.counts.onlyFirst + entry.counts.onlySecond,
      n:
        entry.counts.both +
        entry.counts.onlyFirst +
        entry.counts.onlySecond +
        entry.counts.neither,
      p_value: difference === null ? null : pValue,
      verdict: difference === null ? "not_estimable" : "no_difference_detected"
    });
  }
  const adjusted = holmAdjust(pValues);
  let adjustedIndex = 0;
  return drafts.map((draft) => {
    if (draft.p_value === null) {
      return { ...draft, adjusted_p_value: null };
    }
    const adjustedP = adjusted[adjustedIndex] ?? null;
    adjustedIndex += 1;
    return {
      ...draft,
      adjusted_p_value: adjustedP,
      verdict:
        adjustedP !== null && adjustedP <= alpha
          ? "difference_detected"
          : "no_difference_detected"
    };
  });
}
