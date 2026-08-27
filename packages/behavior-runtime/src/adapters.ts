/**
 * Deterministic service adapters over the state-store primitives. The
 * behavior-facing ports are strictly narrower: behavior reads the
 * virtual clock but cannot advance it, and blob bytes live outside
 * JSON state by digest.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BlobStore,
  DeterministicClock,
  DeterministicIds,
  DeterministicRandom
} from "@oal/behavior-api";
import type { DeterministicPrng, VirtualClock } from "@oal/state-store";

/** Read-only view of the virtual clock for behavior modules. */
export function clockAdapter(clock: VirtualClock): DeterministicClock {
  return {
    now: () => clock.now(),
    nowMs: () => clock.nowMs()
  };
}

/**
 * Deterministic IDs: one monotonic counter per prefix, formatted the
 * way sequence IDs are elsewhere in the run.
 */
export function idsAdapter(): DeterministicIds & {
  snapshot(): Record<string, number>;
} {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const current = counters.get(prefix) ?? 0;
      const next = current + 1;
      counters.set(prefix, next);
      return `${prefix}_${next.toString(10).padStart(8, "0")}`;
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries(counters);
    }
  };
}

export function randomAdapter(prng: DeterministicPrng): DeterministicRandom {
  return {
    nextFloat: () => prng.nextFloat(),
    nextInt: (maxExclusive: number) => prng.nextInt(maxExclusive),
    nextBytes: (length: number) => prng.nextBytes(length)
  };
}

/**
 * Digest-addressed blob store rooted at a directory. The same content
 * always maps to the same path, so blobs deduplicate naturally.
 */
export function fileBlobStore(
  root: string,
  maxBytes = 64 * 1024 * 1024
): BlobStore {
  const digestFor = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");
  const pathFor = (digest: string): string => join(root, digest);
  return {
    async put(
      bytes: Uint8Array
    ): Promise<{ digest: string; sizeBytes: number }> {
      if (bytes.length > maxBytes) {
        throw new Error(`blob exceeds the ${maxBytes} byte store limit`);
      }
      const digest = digestFor(bytes);
      const path = pathFor(digest);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { digest, sizeBytes: bytes.length };
    },
    async get(digest: string): Promise<Uint8Array | null> {
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        return null;
      }
      try {
        return new Uint8Array(await readFile(pathFor(digest)));
      } catch {
        return null;
      }
    }
  };
}
