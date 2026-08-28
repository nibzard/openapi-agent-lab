import { describe, expect, it } from "vitest";

import {
  fisherExactTwoSided,
  newcombeDifferenceInterval,
  wilsonInterval
} from "./rates.ts";
import { holmAdjust } from "./multiplicity.ts";
import { quantile, summarize } from "./summary.ts";
import { weightedProportion } from "./weighted.ts";
import { worstCaseBounds } from "./censor.ts";
import { mcnemarExact, pairedDifference } from "./paired.ts";
import { logChoose, logGamma, normalQuantile, twoSidedZ } from "./special.ts";

/**
 * Expected values in this file are checked-in numeric reference vectors
 * from the specification and from hand calculation. They are never
 * produced by the implementation under test.
 */

describe("special functions", () => {
  it("matches published gamma and choose values", () => {
    expect(Math.exp(logGamma(6))).toBeCloseTo(120, 10);
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 10);
    expect(Math.exp(logChoose(20, 10))).toBeCloseTo(184756, 6);
  });

  it("matches the standard normal quantile", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 9);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(twoSidedZ(0.95)).toBeCloseTo(1.959963984540054, 9);
  });
});

describe("Wilson interval", () => {
  it("matches the specification vector for 5/10", () => {
    const interval = wilsonInterval(5, 10, 0.95);
    expect(interval).not.toBeNull();
    expect(interval?.lower).toBeCloseTo(0.236593, 6);
    expect(interval?.upper).toBeCloseTo(0.763407, 6);
  });

  it("degenerates at the boundaries and rejects empty denominators", () => {
    expect(wilsonInterval(0, 10, 0.95)?.lower).toBe(0);
    expect(wilsonInterval(10, 10, 0.95)?.upper).toBe(1);
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(() => wilsonInterval(11, 10)).toThrow();
  });
});

describe("Newcombe difference interval", () => {
  it("matches the symmetric specification vector for 5/10 minus 5/10", () => {
    const interval = newcombeDifferenceInterval(5, 10, 5, 10, 0.95);
    expect(interval).not.toBeNull();
    expect(interval?.lower).toBeCloseTo(-0.372514, 6);
    expect(interval?.upper).toBeCloseTo(0.372514, 6);
  });

  it("returns null when either denominator is empty", () => {
    expect(newcombeDifferenceInterval(5, 10, 0, 0)).toBeNull();
  });
});

describe("Fisher exact test", () => {
  it("matches the specification vector for [[1,9],[8,2]]", () => {
    expect(
      fisherExactTwoSided([
        [1, 9],
        [8, 2]
      ])
    ).toBeCloseTo(0.00547749, 7);
  });

  it("is 1 for identical rows", () => {
    expect(
      fisherExactTwoSided([
        [5, 5],
        [5, 5]
      ])
    ).toBeCloseTo(1, 8);
  });
});

describe("Holm adjustment", () => {
  it("matches the specification vector", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });

  it("stays monotone and capped for a larger family", () => {
    expect(holmAdjust([0.9, 0.8, 0.7, 0.6])).toEqual([1, 1, 1, 1]);
    expect(holmAdjust([0.5])).toEqual([0.5]);
  });
});

describe("numeric summaries", () => {
  it("computes linear-interpolation quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("withholds p95 from small samples", () => {
    const small = summarize([1, 2, 3, 4, 5]);
    expect(small.p95).toBeNull();
    expect(small.median).toBe(3);
    const large = summarize(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(large.p95).toBeCloseTo(38.05, 6);
    expect(large.min).toBe(1);
    expect(large.max).toBe(40);
  });
});

describe("weighted estimands", () => {
  it("equals the simple mean under equal weights", () => {
    const result = weightedProportion([
      { rate: 0.5, weight: 1 },
      { rate: 1, weight: 1 },
      { rate: 0, weight: 1 },
      { rate: 0.5, weight: 1 }
    ]);
    expect(result?.estimate).toBeCloseTo(0.5, 12);
    expect(result?.effective_n).toBeCloseTo(4, 12);
  });

  it("respects unequal weights", () => {
    const result = weightedProportion([
      { rate: 0.8, weight: 3 },
      { rate: 0.2, weight: 1 }
    ]);
    // (3*0.8 + 1*0.2) / 4 = 0.65
    expect(result?.estimate).toBeCloseTo(0.65, 12);
    // Kish effective n for weights [3,1]: 16/10 = 1.6
    expect(result?.effective_n).toBeCloseTo(1.6, 12);
  });

  it("returns null for empty or zero-weight input", () => {
    expect(weightedProportion([])).toBeNull();
    expect(
      weightedProportion([
        { rate: 0.5, weight: 0 },
        { rate: 0.5, weight: 0 }
      ])
    ).toBeNull();
  });
});

describe("worst-case censor bounds", () => {
  it("brackets the unknown outcomes", () => {
    // 5 successes, 3 failures, 2 unknown of 10: [0.5, 0.7]
    const bounds = worstCaseBounds(5, 3, 2);
    expect(bounds?.lower).toBeCloseTo(0.5, 12);
    expect(bounds?.upper).toBeCloseTo(0.7, 12);
  });

  it("collapses when nothing is unknown and rejects empty input", () => {
    const bounds = worstCaseBounds(4, 6, 0);
    expect(bounds?.lower).toBe(bounds?.upper);
    expect(worstCaseBounds(0, 0, 0)).toBeNull();
  });
});

describe("paired binary comparison", () => {
  it("computes the marginal difference from paired counts", () => {
    const result = pairedDifference({
      both: 6,
      onlyFirst: 1,
      onlySecond: 9,
      neither: 4
    });
    // (1 - 9) / 20 = -0.4
    expect(result?.difference).toBeCloseTo(-0.4, 12);
    expect(result?.discordant).toBe(10);
    expect(result?.n).toBe(20);
  });

  it("matches the hand-computed exact McNemar p-value", () => {
    // b=1, c=9: 2 * sum_{i=0..1} C(10,i) / 2^10 = 2*11/1024
    expect(
      mcnemarExact({ both: 6, onlyFirst: 1, onlySecond: 9, neither: 4 })
    ).toBeCloseTo(0.021484375, 12);
    expect(
      mcnemarExact({ both: 5, onlyFirst: 0, onlySecond: 0, neither: 5 })
    ).toBe(1);
  });

  it("matches the exact binomial tail for small discordant counts", () => {
    // Reference values from the exact two-sided binomial tail at
    // p = 0.5: 2 * sum_{i=0..k} C(10,i) / 2^10 with k = min(b, c).
    expect(
      mcnemarExact({ both: 0, onlyFirst: 0, onlySecond: 10, neither: 0 })
    ).toBeCloseTo(0.001953125, 12);
    expect(
      mcnemarExact({ both: 0, onlyFirst: 2, onlySecond: 8, neither: 0 })
    ).toBeCloseTo(0.109375, 12);
    expect(
      mcnemarExact({ both: 0, onlyFirst: 3, onlySecond: 7, neither: 0 })
    ).toBeCloseTo(0.34375, 12);
    expect(
      mcnemarExact({ both: 0, onlyFirst: 4, onlySecond: 6, neither: 0 })
    ).toBeCloseTo(0.75390625, 12);
    expect(
      mcnemarExact({ both: 0, onlyFirst: 5, onlySecond: 5, neither: 0 })
    ).toBe(1);
  });

  it("stays finite when the discordant count overflows 2^1024", () => {
    // 512 + 512 = 1024 discordant pairs: the direct binomial
    // coefficients overflow, the doubled tail reaches 1.
    const balanced = mcnemarExact({
      both: 0,
      onlyFirst: 512,
      onlySecond: 512,
      neither: 0
    });
    expect(Number.isFinite(balanced)).toBe(true);
    expect(balanced).toBe(1);
    const large = mcnemarExact({
      both: 0,
      onlyFirst: 2000,
      onlySecond: 2000,
      neither: 0
    });
    expect(Number.isFinite(large)).toBe(true);
    expect(large).toBe(1);
  });

  it("keeps a positive p-value at cohort sizes that used to yield 0", () => {
    // 400 + 624 = 1024 discordant pairs: the exact two-sided tail is
    // about 2.63e-12, which the overflowed sum used to truncate to a
    // fabricated exact 0.
    const pValue = mcnemarExact({
      both: 0,
      onlyFirst: 400,
      onlySecond: 624,
      neither: 0
    });
    expect(Number.isFinite(pValue)).toBe(true);
    expect(pValue).toBeGreaterThan(2.5e-12);
    expect(pValue).toBeLessThan(2.8e-12);
    // Reference value 2.630042808782403e-12 computed exactly with
    // integer binomial coefficients.
    expect(pValue / 2.630042808782403e-12).toBeCloseTo(1, 10);
    // A p below the double range stays positive instead of becoming 0.
    const underflow = mcnemarExact({
      both: 0,
      onlyFirst: 2000,
      onlySecond: 0,
      neither: 0
    });
    expect(underflow).toBeGreaterThan(0);
    expect(holmAdjust([underflow])).toEqual([underflow]);
  });

  it("survives the Holm adjustment with large paired counts", () => {
    // A NaN p-value used to make holmAdjust throw before any verdict.
    const pValues = [
      mcnemarExact({ both: 0, onlyFirst: 512, onlySecond: 512, neither: 0 }),
      mcnemarExact({ both: 0, onlyFirst: 400, onlySecond: 624, neither: 0 }),
      mcnemarExact({ both: 0, onlyFirst: 600, onlySecond: 700, neither: 0 })
    ];
    expect(() => holmAdjust(pValues)).not.toThrow();
    const adjusted = holmAdjust(pValues);
    for (const value of adjusted) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic across repeated calls", () => {
    const counts = { both: 0, onlyFirst: 400, onlySecond: 624, neither: 0 };
    expect(mcnemarExact(counts)).toBe(mcnemarExact(counts));
  });
});
