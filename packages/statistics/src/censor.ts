/**
 * Worst-case bounds for censored binary outcomes. Unknown outcomes
 * shift the rate between the observed-success floor and the
 * observed-plus-unknown ceiling. Both bounds are reported; no single
 * invented value is produced.
 */

export interface CensorBounds {
  /** Successes divided by total outcomes including unknowns. */
  lower: number;
  /** Successes plus unknowns divided by total outcomes. */
  upper: number;
  successes: number;
  failures: number;
  unknown: number;
  total: number;
}

export function worstCaseBounds(
  successes: number,
  failures: number,
  unknown: number,
): CensorBounds | null {
  for (const value of [successes, failures, unknown]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError("censor inputs must be non-negative integers");
    }
  }
  const total = successes + failures + unknown;
  if (total === 0) {
    return null;
  }
  return {
    lower: successes / total,
    upper: (successes + unknown) / total,
    successes,
    failures,
    unknown,
    total,
  };
}
