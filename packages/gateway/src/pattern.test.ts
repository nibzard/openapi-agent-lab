import { describe, expect, it } from "vitest";

import { SchemaValidator } from "@oal/core";
import { generateValue, GenerationUnsupportedError } from "./generate.ts";
import {
  patternAccepts,
  synthesizePattern,
  type PatternBounds
} from "./pattern.ts";

const unbounded: PatternBounds = { minLength: null, maxLength: null };

async function assertRoundTrip(
  pattern: string,
  bounds: PatternBounds
): Promise<string> {
  const produced = await synthesizePattern(pattern, bounds);
  expect(produced).not.toBeNull();
  const value = produced as string;
  expect(await patternAccepts(pattern, value)).toBe(true);
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
  it("produces first-declared members for slack patterns", async () => {
    expect(await assertRoundTrip("^[TE][A-Z0-9]{8,}$", unbounded)).toBe(
      "TAAAAAAAA"
    );
    expect(await assertRoundTrip("^[UW][A-Z0-9]{8,}|^$", unbounded)).toBe(
      "UAAAAAAAA"
    );
    expect(await assertRoundTrip("^\\d{10}$", unbounded)).toBe("0000000000");
    expect(await assertRoundTrip("^X[a-zA-Z0-9]{9,}$", unbounded)).toBe(
      "Xaaaaaaaaa"
    );
    expect(await assertRoundTrip("^([a-fA-F0-9]{6})?$", unbounded)).toBe("");
    expect(await assertRoundTrip("^[0-9a-f]{12}$", unbounded)).toBe(
      "000000000000"
    );
  });

  it("handles negated classes, counted ranges, and escapes", async () => {
    // Space is the first printable ASCII character [^abc] accepts.
    expect(await assertRoundTrip("^[^abc]+$", unbounded)).toBe(" ");
    expect(await assertRoundTrip("^a{3,5}$", unbounded)).toBe("aaa");
    expect(await assertRoundTrip("^\\d{1,3}\\.\\d{2}$", unbounded)).toBe(
      "0.00"
    );
    expect(await assertRoundTrip("^\\\\x\\.$", unbounded)).toBe("\\x.");
    expect(await assertRoundTrip("^[A-Z]{2}-[0-9]{4}$", unbounded)).toBe(
      "AA-0000"
    );
  });

  it("leaves unanchored patterns unanchored", async () => {
    expect(await assertRoundTrip("\\d+", unbounded)).toBe("0");
    expect(await assertRoundTrip("unanchored-\\d+", unbounded)).toBe(
      "unanchored-0"
    );
  });

  it("inflates an elastic term to reach minLength", async () => {
    expect(
      await assertRoundTrip("^[TE][A-Z0-9]{8,}$", {
        minLength: 20,
        maxLength: null
      })
    ).toBe("TAAAAAAAAAAAAAAAAAAA");
    expect(
      await assertRoundTrip("^x*$", { minLength: 3, maxLength: null })
    ).toBe("xxx");
  });

  it("respects maxLength and refuses impossible bounds", async () => {
    expect(
      await synthesizePattern("^A{5}$", { minLength: null, maxLength: 3 })
    ).toBeNull();
    expect(
      await synthesizePattern("^\\d+$", { minLength: 300, maxLength: null })
    ).toBeNull();
    expect(
      await synthesizePattern("^[a-z]+$", { minLength: 5, maxLength: 3 })
    ).toBeNull();
  });

  it("is pure: repeated calls and unrelated seeds agree", async () => {
    const first = await synthesizePattern("^[TE][A-Z0-9]{8,}$", unbounded);
    for (let i = 0; i < 3; i += 1) {
      expect(await synthesizePattern("^[TE][A-Z0-9]{8,}$", unbounded)).toBe(
        first
      );
    }
    // The pattern branch of the generator takes no seed input.
    const seeds = await Promise.all(
      ["op_a", "op_b", "op_c"].map(async (seed) =>
        generateValue(
          { type: "string", pattern: "^[TE][A-Z0-9]{8,}$" },
          { seed }
        )
      )
    );
    expect(new Set(seeds).size).toBe(1);
  });

  it("fails closed on unsupported constructs", async () => {
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
      expect(await synthesizePattern(pattern, unbounded)).toBeNull();
      await expect(
        generateValue({ type: "string", pattern }, { seed: "op_test" })
      ).rejects.toThrow(GenerationUnsupportedError);
    }
  });

  it("keeps the frozen literal shortcuts untouched", async () => {
    // The format-first branch returns a seeded token that satisfies
    // some patterns; these five refuse the token, so the shortcut
    // literals surface unchanged.
    expect(
      await generateValue(
        { type: "string", pattern: "^[a-z]+$" },
        { seed: "s" }
      )
    ).toBe("generated");
    expect(
      await generateValue(
        { type: "string", pattern: "^[A-Za-z]+$" },
        { seed: "s" }
      )
    ).toBe("generated");
    expect(
      await generateValue(
        { type: "string", pattern: "^[0-9]+$" },
        { seed: "s" }
      )
    ).toBe("2000");
    expect(
      await generateValue(
        { type: "string", pattern: "^[A-Z]{2}-[0-9]{3}$" },
        { seed: "s" }
      )
    ).toBe("XX-000");
    expect(
      await generateValue(
        { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        { seed: "s" }
      )
    ).toBe("generated");
    // A shortcut that violates the declared bounds falls through to
    // synthesis instead of being padded into an invalid value.
    expect(
      await generateValue(
        { type: "string", pattern: "^[0-9]+$", minLength: 6 },
        { seed: "s" }
      )
    ).toBe("000000");
  });
});
