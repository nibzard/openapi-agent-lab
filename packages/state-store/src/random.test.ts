import { describe, expect, it } from "vitest";

import {
  createNamespacePrng,
  createPrngNamespaces,
  DeterministicPrng
} from "./random.ts";
import { deriveNamespaceSeed, PRNG_NAMESPACES } from "./seed.ts";

const IDS_SEED =
  "5de8c5313a718345c16b78d8831df2ec371a3c9704cfbfd6188b57e0dd140985";
const UUIDS_SEED =
  "b4f77b30beb1b57aaf1bedcc56143fc6c35f1aebfb8aed85b00ae22ea8d2c0d4";
const RUN_SEED =
  "e864b39062a1c3fe6d94ec6df87181261e5fa12eb2c4542fe5139286eebdc432";

describe("DeterministicPrng", () => {
  it("reproduces the frozen splitmix64 vector", () => {
    const prng = new DeterministicPrng(IDS_SEED);
    expect([
      prng.nextUint32(),
      prng.nextUint32(),
      prng.nextUint32(),
      prng.nextUint32(),
      prng.nextUint32()
    ]).toEqual([4192303558, 747859971, 3335455139, 1714119606, 3917350890]);
  });

  it("is deterministic for the same seed", () => {
    const left = new DeterministicPrng(IDS_SEED);
    const right = new DeterministicPrng(IDS_SEED);
    for (let i = 0; i < 1_000; i += 1) {
      expect(left.nextUint32()).toBe(right.nextUint32());
    }
  });

  it("absorbs the whole 256-bit seed", () => {
    const prng = new DeterministicPrng(UUIDS_SEED);
    expect(prng.nextUint32()).toBe(2147793175);
    // Two seeds that share their first 63 hex characters still diverge.
    const variant = `${UUIDS_SEED.slice(0, 63)}0`;
    expect(new DeterministicPrng(variant).nextUint32()).not.toBe(2147793175);
    expect(() => new DeterministicPrng("nope")).toThrowError(/SHA-256/);
  });

  it("returns bounded 32-bit values and floats", () => {
    const prng = new DeterministicPrng(IDS_SEED);
    for (let i = 0; i < 10_000; i += 1) {
      const value = prng.nextUint32();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
      const float = prng.nextFloat();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
  });

  it("spreads values over the unit interval", () => {
    const prng = new DeterministicPrng(RUN_SEED);
    const buckets = new Array<number>(16).fill(0);
    const draws = 160_000;
    for (let i = 0; i < draws; i += 1) {
      const index = Math.floor(prng.nextFloat() * 16);
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    const expected = draws / 16;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.9);
      expect(count).toBeLessThan(expected * 1.1);
    }
  });

  it("draws unbiased integers inside the bound", () => {
    const prng = new DeterministicPrng(RUN_SEED);
    const counts = new Array<number>(7).fill(0);
    for (let i = 0; i < 70_000; i += 1) {
      const value = prng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
      counts[value] = (counts[value] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(9_000);
      expect(count).toBeLessThan(11_000);
    }
    expect(prng.nextInt(1)).toBe(0);
    expect(() => prng.nextInt(0)).toThrowError(/positive/);
  });

  it("picks and shuffles deterministically", () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const left = new DeterministicPrng(IDS_SEED);
    const right = new DeterministicPrng(IDS_SEED);
    const leftShuffle = left.shuffle(source);
    expect(leftShuffle).toEqual(right.shuffle(source));
    expect(leftShuffle).not.toEqual(source);
    expect([...leftShuffle].sort((a, b) => a - b)).toEqual(source);
    // The input array is left untouched.
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new DeterministicPrng(UUIDS_SEED).shuffle(source)).not.toEqual(
      leftShuffle
    );
    expect(new DeterministicPrng(IDS_SEED).pick(source)).toBe(
      new DeterministicPrng(IDS_SEED).pick(source)
    );
    expect(() => new DeterministicPrng(IDS_SEED).pick([])).toThrowError(
      /empty/
    );
    // A one-element shuffle is stable.
    expect(new DeterministicPrng(IDS_SEED).shuffle(["only"])).toEqual(["only"]);
  });

  it("produces the requested number of bytes", () => {
    const prng = new DeterministicPrng(IDS_SEED);
    const bytes = prng.nextBytes(10);
    expect(bytes).toHaveLength(10);
    expect(prng.nextBytes(0)).toHaveLength(0);
    expect(() => prng.nextBytes(-1)).toThrowError(/nonnegative/);
  });
});

describe("PRNG namespaces", () => {
  it("builds every namespace declared in section 17.5", () => {
    const namespaces = createPrngNamespaces(RUN_SEED);
    expect(Object.keys(namespaces).sort()).toEqual([...PRNG_NAMESPACES].sort());
    const draws = Object.values(namespaces).map((prng) => prng.nextUint32());
    expect(new Set(draws).size).toBe(draws.length);
  });

  it("keeps one namespace stable when another draws values", () => {
    const isolated = createNamespacePrng(RUN_SEED, "faults");
    const first = isolated.nextUint32();
    const shared = createPrngNamespaces(RUN_SEED);
    for (let i = 0; i < 500; i += 1) {
      shared["ids"]?.nextUint32();
      shared["uuids"]?.nextFloat();
    }
    expect(shared["faults"]?.nextUint32()).toBe(first);
  });

  it("uses the documented namespace seed", () => {
    const prng = createNamespacePrng(RUN_SEED, "ids");
    expect(prng).toBeInstanceOf(DeterministicPrng);
    expect(prng.nextUint32()).toBe(4192303558);
    const uuids = createNamespacePrng(RUN_SEED, "uuids");
    expect(uuids.nextUint32()).not.toBe(prng.nextUint32());
    expect(deriveNamespaceSeed(RUN_SEED, "ids")).toBe(IDS_SEED);
  });
});
