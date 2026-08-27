/**
 * Numeric special functions used by the study statistics. All functions
 * are pure and deterministic. Accuracy is checked against published
 * values in the test suite.
 */

/** Lanczos coefficients for the log-gamma approximation (g = 7). */
const LANCZOS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function for x > 0. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula for the small-x branch.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0] as number;
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) {
    a += (LANCZOS[i] as number) / (x + i);
  }
  return (
    0.5 * Math.log(2 * Math.PI) +
    (x + 0.5) * Math.log(t) -
    t +
    Math.log(a)
  );
}

/** Natural log of the binomial coefficient C(n, k). */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return Number.NEGATIVE_INFINITY;
  }
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Standard normal probability density. */
export function normalDensity(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF for x >= 0 via composite Simpson integration of
 * the density over [0, x]. Accuracy is about 1e-12, which is far below
 * the tolerances the study statistics require.
 */
function cdfNonNegative(x: number): number {
  if (x === 0) {
    return 0.5;
  }
  const panels = 2048;
  const h = x / panels;
  const odds = 2047;
  let sum = normalDensity(x);
  for (let i = 1; i <= odds; i += 2) {
    sum += 4 * normalDensity(i * h);
  }
  for (let i = 2; i < panels; i += 2) {
    sum += 2 * normalDensity(i * h);
  }
  const integral = (h / 3) * (normalDensity(0) + sum);
  return 0.5 + integral;
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x: number): number {
  return x < 0 ? 1 - cdfNonNegative(-x) : cdfNonNegative(x);
}

/**
 * Inverse standard normal CDF by bisection over [-10, 10]. Bisection is
 * used deliberately: it cannot diverge and reaches double-precision
 * resolution within 60 iterations.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`normalQuantile requires 0 < p < 1, got ${p}`);
  }
  let low = -10;
  let high = 10;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (normalCdf(mid) < p) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/** Two-sided normal quantile for a confidence level, for example 0.95. */
export function twoSidedZ(level: number): number {
  if (level <= 0 || level >= 1) {
    throw new RangeError(
      `confidence level must be in (0, 1), got ${level}`
    );
  }
  return normalQuantile(1 - (1 - level) / 2);
}
