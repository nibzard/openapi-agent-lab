/**
 * Descriptive summaries for durations, token counts, and other
 * measurements. The 95th percentile is reported only when the sample
 * size supports it; otherwise it is null.
 */

export interface NumericSummary {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

/** Minimum sample size before a p95 is reported. */
export const MIN_N_FOR_P95 = 20;

/** Linear-interpolation quantile (type 7, the R default). */
export function quantile(
  values: readonly number[],
  probability: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  if (probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must lie in [0, 1]");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const position = (n - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  if (lower === upper) {
    return lowerValue;
  }
  return lowerValue + (position - lower) * (upperValue - lowerValue);
}

export function summarize(values: readonly number[]): NumericSummary {
  if (values.length === 0) {
    return {
      n: 0,
      median: null,
      p25: null,
      p75: null,
      p95: null,
      min: null,
      max: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    p95: sorted.length >= MIN_N_FOR_P95 ? quantile(values, 0.95) : null,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}
