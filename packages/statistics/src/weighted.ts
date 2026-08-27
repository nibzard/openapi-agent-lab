/**
 * Weighted estimands for cross-case and cross-cell aggregates. Weights
 * are normalized internally; zero total weight yields null rather than
 * an invented value.
 */

import { wilsonInterval } from "./rates.ts";

export interface WeightedProportion {
  estimate: number;
  total_weight: number;
  effective_n: number;
  interval: { lower: number; upper: number } | null;
}

/**
 * Weighted mean of cell rates with a Wilson interval at the Kish
 * effective sample size. This is the equal-weight macro aggregate used
 * for multi-case reports.
 */
export function weightedProportion(
  cells: readonly { rate: number; weight: number }[],
  level = 0.95,
): WeightedProportion | null {
  if (cells.length === 0) {
    return null;
  }
  let weightSum = 0;
  let weightSquaredSum = 0;
  let weightedRateSum = 0;
  for (const cell of cells) {
    if (cell.weight < 0 || !Number.isFinite(cell.weight)) {
      throw new RangeError("weights must be finite and non-negative");
    }
    if (cell.rate < 0 || cell.rate > 1) {
      throw new RangeError(`cell rate must lie in [0, 1], got ${cell.rate}`);
    }
    weightSum += cell.weight;
    weightSquaredSum += cell.weight * cell.weight;
    weightedRateSum += cell.weight * cell.rate;
  }
  if (weightSum === 0) {
    return null;
  }
  const estimate = weightedRateSum / weightSum;
  const effectiveN =
    weightSquaredSum === 0 ? 0 : (weightSum * weightSum) / weightSquaredSum;
  // A fractional effective sample size is rounded for the binomial
  // interval; k is the weighted success count, bounded to n.
  const n = Math.max(1, Math.round(effectiveN));
  const k = Math.min(n, Math.max(0, Math.round(estimate * n)));
  return {
    estimate,
    total_weight: weightSum,
    effective_n: effectiveN,
    interval: wilsonInterval(k, n, level),
  };
}

/** Weighted mean of arbitrary real-valued observations. */
export function weightedMean(
  observations: readonly { value: number; weight: number }[],
): number | null {
  let weightSum = 0;
  let weightedSum = 0;
  for (const observation of observations) {
    if (
      observation.weight < 0 ||
      !Number.isFinite(observation.weight) ||
      !Number.isFinite(observation.value)
    ) {
      throw new RangeError("weights and values must be finite");
    }
    weightSum += observation.weight;
    weightedSum += observation.weight * observation.value;
  }
  if (weightSum === 0) {
    return null;
  }
  return weightedSum / weightSum;
}
