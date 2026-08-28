import { describe, expect, it } from "vitest";

import { mcnemarExact } from "./paired.ts";

describe("mcnemarExact input validation", () => {
  it("throws a RangeError on a negative count in any cell", () => {
    // A negative onlyFirst used to shrink the discordant total and the
    // empty tail sum used to fabricate Number.MIN_VALUE as a p-value.
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: -1, onlySecond: 9, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: -6, onlyFirst: 1, onlySecond: 9, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: 1, onlySecond: -9, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: 1, onlySecond: 9, neither: -4 })
    ).toThrow(RangeError);
  });

  it("throws a RangeError on a non-integer count in any cell", () => {
    expect(() =>
      mcnemarExact({ both: 6.5, onlyFirst: 1, onlySecond: 9, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: 1.5, onlySecond: 9, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: 1, onlySecond: 9.5, neither: 4 })
    ).toThrow(RangeError);
    expect(() =>
      mcnemarExact({ both: 6, onlyFirst: 1, onlySecond: 9, neither: 4.5 })
    ).toThrow(RangeError);
  });

  it("reports the same message as the Fisher table guard", () => {
    expect(() =>
      mcnemarExact({ both: -1, onlyFirst: 0, onlySecond: 0, neither: 0 })
    ).toThrow("Paired counts must be non-negative integers");
  });

  it("still computes when boundary cells are zero", () => {
    // All four cells zero: no discordant pairs, p = 1.
    expect(
      mcnemarExact({ both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 })
    ).toBe(1);
    // Zero concordant cells leave the exact binomial tail unchanged.
    expect(
      mcnemarExact({ both: 0, onlyFirst: 1, onlySecond: 9, neither: 0 })
    ).toBeCloseTo(0.021484375, 12);
    // One discordant cell at zero gives the single-point tail.
    expect(
      mcnemarExact({ both: 3, onlyFirst: 0, onlySecond: 10, neither: 2 })
    ).toBeCloseTo(0.001953125, 12);
  });
});
