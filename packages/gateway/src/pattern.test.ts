import { describe, expect, it } from "vitest";

import { SchemaValidator } from "@oal/core";
import { generateValue, GenerationUnsupportedError } from "./generate.ts";
import {
  patternAccepts,
  synthesizePattern,
  type PatternBounds
} from "./pattern.ts";

const unbounded: PatternBounds = { minLength: null, maxLength: null };

function assertRoundTrip(pattern: string, bounds: PatternBounds): string {
  const produced = synthesizePattern(pattern, bounds);
  expect(produced).not.toBeNull();
  const value = produced as string;
  expect(patternAccepts(pattern, value)).toBe(true);
  if (bounds.minLength !== null) {
    expect(value.length).toBeGreaterThanOrEqual(bounds.minLength);
  }
  if (bounds.maxLength !== null) {
    expect(value.length).toBeLessThanOrEqual(bounds.maxLength);
  }
  // The schema validator compiles the same pattern; the synthesized
  // value must survive the same check responses are held to.
  expect(
    new SchemaValidator({
      type: "string",
      pattern,
      ...(bounds.minLength === null ? {} : { minLength: bounds.minLength }),
      ...(bounds.maxLength === null ? {} : { maxLength: bounds.maxLength })
    }).errors(value)
  ).toHaveLength(0);
  return value;
}

describe("pattern synthesis", () => {
  it("produces first-declared members for slack patterns", () => {
    expect(assertRoundTrip("^[TE][A-Z0-9]{8,}$", unbounded)).toBe("TAAAAAAAA");
    expect(assertRoundTrip("^[UW][A-Z0-9]{8,}|^$", unbounded)).toBe(
      "UAAAAAAAA"
    );
    expect(assertRoundTrip("^\\d{10}$", unbounded)).toBe("0000000000");
    expect(assertRoundTrip("^X[a-zA-Z0-9]{9,}$", unbounded)).toBe("Xaaaaaaaaa");
    expect(assertRoundTrip("^([a-fA-F0-9]{6})?$", unbounded)).toBe("");
    expect(assertRoundTrip("^[0-9a-f]{12}$", unbounded)).toBe("000000000000");
  });

  it("handles negated classes, counted ranges, and escapes", () => {
    // Space is the first printable ASCII character [^abc] accepts.
    expect(assertRoundTrip("^[^abc]+$", unbounded)).toBe(" ");
    expect(assertRoundTrip("^a{3,5}$", unbounded)).toBe("aaa");
    expect(assertRoundTrip("^\\d{1,3}\\.\\d{2}$", unbounded)).toBe("0.00");
    expect(assertRoundTrip("^\\\\x\\.$", unbounded)).toBe("\\x.");
    expect(assertRoundTrip("^[A-Z]{2}-[0-9]{4}$", unbounded)).toBe("AA-0000");
  });

  it("leaves unanchored patterns unanchored", () => {
    expect(assertRoundTrip("\\d+", unbounded)).toBe("0");
    expect(assertRoundTrip("unanchored-\\d+", unbounded)).toBe("unanchored-0");
  });

  it("inflates an elastic term to reach minLength", () => {
    expect(
      assertRoundTrip("^[TE][A-Z0-9]{8,}$", { minLength: 20, maxLength: null })
    ).toBe("TAAAAAAAAAAAAAAAAAAA");
    expect(assertRoundTrip("^x*$", { minLength: 3, maxLength: null })).toBe(
      "xxx"
    );
  });

  it("respects maxLength and refuses impossible bounds", () => {
    expect(
      synthesizePattern("^A{5}$", { minLength: null, maxLength: 3 })
    ).toBeNull();
    expect(
      synthesizePattern("^\\d+$", { minLength: 300, maxLength: null })
    ).toBeNull();
    expect(
      synthesizePattern("^[a-z]+$", { minLength: 5, maxLength: 3 })
    ).toBeNull();
  });

  it("is pure: repeated calls and unrelated seeds agree", () => {
    const first = synthesizePattern("^[TE][A-Z0-9]{8,}$", unbounded);
    for (let i = 0; i < 3; i += 1) {
      expect(synthesizePattern("^[TE][A-Z0-9]{8,}$", unbounded)).toBe(first);
    }
    // The pattern branch of the generator takes no seed input.
    const seeds = ["op_a", "op_b", "op_c"].map((seed) =>
      generateValue({ type: "string", pattern: "^[TE][A-Z0-9]{8,}$" }, { seed })
    );
    expect(new Set(seeds).size).toBe(1);
  });

  it("fails closed on unsupported constructs", () => {
    const refused = [
      "^(?=A)[A-Z]+$",
      "^(?<=x)y",
      "(a)\\1",
      "^\\p{L}+$",
      "(?i)abc",
      "(?<name>x)",
      "[",
      "^a{70}$",
      "^a{2,80}$"
    ];
    for (const pattern of refused) {
      expect(synthesizePattern(pattern, unbounded)).toBeNull();
      expect(() =>
        generateValue({ type: "string", pattern }, { seed: "op_test" })
      ).toThrow(GenerationUnsupportedError);
    }
  });

  it("keeps the frozen literal shortcuts untouched", () => {
    // The format-first branch returns a seeded token that satisfies
    // some patterns; these five refuse the token, so the shortcut
    // literals surface unchanged.
    expect(
      generateValue({ type: "string", pattern: "^[a-z]+$" }, { seed: "s" })
    ).toBe("generated");
    expect(
      generateValue({ type: "string", pattern: "^[A-Za-z]+$" }, { seed: "s" })
    ).toBe("generated");
    expect(
      generateValue({ type: "string", pattern: "^[0-9]+$" }, { seed: "s" })
    ).toBe("2000");
    expect(
      generateValue(
        { type: "string", pattern: "^[A-Z]{2}-[0-9]{3}$" },
        { seed: "s" }
      )
    ).toBe("XX-000");
    expect(
      generateValue(
        { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        { seed: "s" }
      )
    ).toBe("generated");
    // A shortcut that violates the declared bounds falls through to
    // synthesis instead of being padded into an invalid value.
    expect(
      generateValue(
        { type: "string", pattern: "^[0-9]+$", minLength: 6 },
        { seed: "s" }
      )
    ).toBe("000000");
  });
});
