/**
 * Deterministic PRNG (specification sections 12, 16, and 17.5).
 *
 * Splitmix64 over the 256-bit namespace seed. The same seed always yields the
 * same value sequence, on every platform, because the generator uses integer
 * arithmetic only.
 */

import { isSha256Hex } from "@oal/core";

import { deriveNamespaceSeed, PRNG_NAMESPACES } from "./seed.ts";

const MASK64 = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;
const UINT32 = 0x1_0000_0000;

function mix64(value: bigint): bigint {
  let z = value & MASK64;
  z = ((z ^ (z >> 30n)) * MIX_A) & MASK64;
  z = ((z ^ (z >> 27n)) * MIX_B) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** Absorb every bit of a 256-bit seed into the 64-bit splitmix64 state. */
function absorbSeed(seed: string): bigint {
  let state = 0n;
  for (let i = 0; i < seed.length; i += 16) {
    const chunk = seed.slice(i, i + 16);
    state = mix64(state ^ BigInt(`0x${chunk}`));
  }
  return state;
}

export class DeterministicPrng {
  private state: bigint;

  constructor(seed: string) {
    if (!isSha256Hex(seed)) {
      throw new Error(
        `PRNG seed must be a lowercase 64-character SHA-256 digest, got ${JSON.stringify(seed)}.`
      );
    }
    this.state = absorbSeed(seed);
  }

  /** Next raw 64-bit output as a unsigned BigInt. */
  nextUint64(): bigint {
    this.state = (this.state + GAMMA) & MASK64;
    return mix64(this.state);
  }

  /** Next unsigned 32-bit integer in `[0, 4294967295]`. */
  nextUint32(): number {
    return Number(this.nextUint64() >> 32n);
  }

  /** Next float in `[0, 1)` with 32-bit resolution. */
  nextFloat(): number {
    return this.nextUint32() / UINT32;
  }

  /** Next integer in `[0, maxExclusive)` without modulo bias. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(
        `maxExclusive must be a positive integer, got ${String(maxExclusive)}.`
      );
    }
    if (maxExclusive > UINT32) {
      throw new Error("maxExclusive must not exceed 2^32.");
    }
    const limit = Math.floor(UINT32 / maxExclusive) * maxExclusive;
    let draw = this.nextUint32();
    while (draw >= limit) {
      draw = this.nextUint32();
    }
    return draw % maxExclusive;
  }

  /** Next `length` pseudorandom bytes. */
  nextBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error("Byte length must be a nonnegative integer.");
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 4) {
      const word = this.nextUint32();
      const stop = Math.min(i + 4, length);
      for (let j = i; j < stop; j += 1) {
        out[j] = (word >>> ((j - i) * 8)) & 0xff;
      }
    }
    return out;
  }

  /** Pick one element. Throws on an empty input. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty list.");
    }
    const index = this.nextInt(items.length);
    return items[index] as T;
  }

  /** Fisher-Yates shuffle returning a new array; the input is unchanged. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const left = out[i] as T;
      out[i] = out[j] as T;
      out[j] = left;
    }
    return out;
  }
}

/** One independent generator per required PRNG namespace. */
export type PrngNamespaces = Readonly<Record<string, DeterministicPrng>>;

/** Build every namespace declared in specification section 17.5. */
export function createPrngNamespaces(runSeed: string): PrngNamespaces {
  const generators: Record<string, DeterministicPrng> = {};
  for (const namespace of PRNG_NAMESPACES) {
    generators[namespace] = new DeterministicPrng(
      deriveNamespaceSeed(runSeed, namespace)
    );
  }
  return generators;
}

/** Convenience constructor: namespace seed first, then the generator. */
export function createNamespacePrng(
  runSeed: string,
  namespace: string
): DeterministicPrng {
  return new DeterministicPrng(deriveNamespaceSeed(runSeed, namespace));
}
