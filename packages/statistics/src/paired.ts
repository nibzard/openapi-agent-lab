/**
 * Paired binary comparison. Pairing must be preregistered at the
 * assignment unit; these functions only accept the paired counts and
 * never infer pairing from seeds.
 */

import { logChoose } from "./special.ts";

export interface PairedBinary {
  /** Both success. */
  both: number;
  /** First success, second failure. */
  onlyFirst: number;
  /** First failure, second success. */
  onlySecond: number;
  /** Both failure. */
  neither: number;
}

/** Marginal success-rate difference, first condition minus second. */
export function pairedDifference(
  counts: PairedBinary
): { difference: number; discordant: number; n: number } | null {
  const n = counts.both + counts.onlyFirst + counts.onlySecond + counts.neither;
  if (n === 0) {
    return null;
  }
  return {
    difference: (counts.onlyFirst - counts.onlySecond) / n,
    discordant: counts.onlyFirst + counts.onlySecond,
    n
  };
}

/**
 * Exact McNemar test: the two-sided binomial test over the discordant
 * pairs. Returns 1 when there are no discordant pairs.
 *
 * The tail is summed in log space. Direct binomial coefficients
 * overflow once the discordant count passes 1023, which used to turn
 * the p-value into NaN or a premature exact 0; log-space terms stay
 * finite for every count the caller can pass.
 *
 * Every count must be a non-negative integer, as fisherExactTwoSided
 * requires of table cells; anything else throws instead of
 * fabricating a p-value.
 */
export function mcnemarExact(counts: PairedBinary): number {
  for (const value of [
    counts.both,
    counts.onlyFirst,
    counts.onlySecond,
    counts.neither
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError("Paired counts must be non-negative integers");
    }
  }
  const discordant = counts.onlyFirst + counts.onlySecond;
  if (discordant === 0) {
    return 1;
  }
  const k = Math.min(counts.onlyFirst, counts.onlySecond);
  // Terms C(discordant, i) / 2^discordant grow toward the middle of
  // the distribution and k never passes the middle, so term k is the
  // largest term in the sum.
  const logMax = logChoose(discordant, k) - discordant * Math.LN2;
  let scaled = 0;
  for (let i = 0; i <= k; i += 1) {
    // Ratios below the double range underflow to 0; they are
    // negligible against the maximum term, so the sum stays exact to
    // floating point.
    scaled += Math.exp(
      logChoose(discordant, i) - discordant * Math.LN2 - logMax
    );
  }
  const logTwoSided = Math.LN2 + logMax + Math.log(scaled);
  if (logTwoSided >= 0) {
    return 1;
  }
  const pValue = Math.exp(logTwoSided);
  // A true p below the smallest positive double still represents a
  // detected difference, so clamp to that value instead of reporting
  // a fabricated exact 0.
  return pValue === 0 ? Number.MIN_VALUE : pValue;
}
