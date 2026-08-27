/**
 * Paired binary comparison. Pairing must be preregistered at the
 * assignment unit; these functions only accept the paired counts and
 * never infer pairing from seeds.
 */

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
 */
export function mcnemarExact(counts: PairedBinary): number {
  const discordant = counts.onlyFirst + counts.onlySecond;
  if (discordant === 0) {
    return 1;
  }
  const k = Math.min(counts.onlyFirst, counts.onlySecond);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) {
    tail += choose(discordant, i);
  }
  const twoSided = 2 * (tail / 2 ** discordant);
  return Math.min(1, twoSided);
}

/** Exact binomial coefficient for the small discordant counts. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - i + 1)) / i;
  }
  return result;
}
