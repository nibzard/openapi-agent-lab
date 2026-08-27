/**
 * Holm step-down familywise error adjustment. Returns adjusted p-values
 * in their original order, capped at 1, and monotone non-decreasing in
 * sorted order.
 */

export function holmAdjust(pValues: readonly number[]): number[] {
  for (const p of pValues) {
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError(`p-values must lie in [0, 1], got ${p}`);
    }
  }
  const m = pValues.length;
  const adjusted = new Array<number>(m).fill(0);
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((x, y) => x.p - y.p);
  let runningMax = 0;
  for (let i = 0; i < m; i += 1) {
    const entry = order[i];
    if (entry === undefined) {
      continue;
    }
    const scaled = (m - i) * entry.p;
    runningMax = Math.max(runningMax, scaled);
    adjusted[entry.index] = Math.min(1, runningMax);
  }
  return adjusted;
}
