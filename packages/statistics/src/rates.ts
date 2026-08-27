/**
 * Interval and test methods for binary rates. Every function returns
 * null for an empty denominator instead of inventing a value, as the
 * specification requires.
 */

import { logChoose, twoSidedZ } from "./special.ts";

/** Wilson score interval for k successes out of n trials. */
export function wilsonInterval(
  k: number,
  n: number,
  level = 0.95,
): { lower: number; upper: number } | null {
  if (n <= 0) {
    return null;
  }
  if (k < 0 || k > n) {
    throw new RangeError(`k must satisfy 0 <= k <= n, got k=${k}, n=${n}`);
  }
  const z = twoSidedZ(level);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
  };
}

/**
 * Newcombe hybrid-score interval for the risk difference k1/n1 minus
 * k2/n2 (Newcombe 1998, method 10). Null when either denominator is
 * empty.
 */
export function newcombeDifferenceInterval(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
  level = 0.95,
): { lower: number; upper: number } | null {
  const first = wilsonInterval(k1, n1, level);
  const second = wilsonInterval(k2, n2, level);
  if (first === null || second === null) {
    return null;
  }
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const difference = p1 - p2;
  const lowerShift = Math.sqrt(
    (p1 - first.lower) ** 2 + (second.upper - p2) ** 2,
  );
  const upperShift = Math.sqrt(
    (first.upper - p1) ** 2 + (p2 - second.lower) ** 2,
  );
  return {
    lower: Math.max(-1, difference - lowerShift),
    upper: Math.min(1, difference + upperShift),
  };
}

/**
 * Two-sided Fisher exact test on a 2x2 table [[a, b], [c, d]]. Sums the
 * hypergeometric probabilities of all tables with the same margins that
 * are no more probable than the observed table.
 */
export function fisherExactTwoSided(
  table: [[number, number], [number, number]],
): number {
  const [[a, b], [c, d]] = table;
  for (const value of [a, b, c, d]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError("Fisher table cells must be non-negative integers");
    }
  }
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) {
    return 1;
  }
  const probability = (x: number): number =>
    Math.exp(
      logChoose(col1, x) +
        logChoose(total - col1, row1 - x) -
        logChoose(total, row1),
    );
  const observed = probability(a);
  const xMin = Math.max(0, col1 - row2);
  const xMax = Math.min(col1, row1);
  // Tolerance absorbs floating error when comparing equal probabilities.
  const epsilon = observed * 1e-7;
  let sum = 0;
  for (let x = xMin; x <= xMax; x += 1) {
    const px = probability(x);
    if (px <= observed + epsilon) {
      sum += px;
    }
  }
  return Math.min(1, sum);
}
