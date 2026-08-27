import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNamespacePrng, VirtualClock } from "@oal/state-store";
import {
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "./adapters.ts";

describe("clockAdapter", () => {
  it("exposes the virtual time read-only", () => {
    const clock = new VirtualClock({ initialMs: 1_000 });
    const adapter = clockAdapter(clock);
    expect(adapter.nowMs()).toBe(1_000);
    expect(adapter.now()).toBe(clock.now());
    clock.advance(5);
    expect(adapter.nowMs()).toBe(1_005);
  });
});

describe("idsAdapter", () => {
  it("numbers each prefix independently with padded sequence ids", () => {
    const ids = idsAdapter();
    expect(ids.next("evt")).toBe("evt_00000001");
    expect(ids.next("evt")).toBe("evt_00000002");
    expect(ids.next("doc")).toBe("doc_00000001");
  });

  it("snapshots the counters", () => {
    const ids = idsAdapter();
    ids.next("evt");
    ids.next("evt");
    expect(ids.snapshot()).toEqual({ evt: 2 });
  });
});

const RUN_SEED_A = "a".repeat(64);
const RUN_SEED_B = "b".repeat(64);

describe("randomAdapter", () => {
  it("mirrors the namespaced PRNG deterministically", () => {
    const left = randomAdapter(createNamespacePrng(RUN_SEED_A, "adapter-test"));
    const right = randomAdapter(
      createNamespacePrng(RUN_SEED_A, "adapter-test")
    );
    expect(left.nextFloat()).toBe(right.nextFloat());
    expect(left.nextInt(100)).toBe(right.nextInt(100));
    expect(left.nextBytes(8)).toEqual(right.nextBytes(8));
  });

  it("yields distinct streams for distinct seeds", () => {
    const left = randomAdapter(createNamespacePrng(RUN_SEED_A, "adapter-test"));
    const right = randomAdapter(
      createNamespacePrng(RUN_SEED_B, "adapter-test")
    );
    expect(left.nextFloat()).not.toBe(right.nextFloat());
  });
});

describe("fileBlobStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "oal-blobs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes by digest", async () => {
    const store = fileBlobStore(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stored = await store.put(bytes);
    expect(stored.sizeBytes).toBe(4);
    expect(stored.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(stored.digest)).toEqual(bytes);
  });

  it("deduplicates identical content", async () => {
    const store = fileBlobStore(root);
    const first = await store.put(new Uint8Array([9, 9]));
    const second = await store.put(new Uint8Array([9, 9]));
    expect(second.digest).toBe(first.digest);
  });

  it("returns null for an unknown or malformed digest", async () => {
    const store = fileBlobStore(root);
    expect(
      await store.get(
        "0000000000000000000000000000000000000000000000000000000000000000"
      )
    ).toBeNull();
    expect(await store.get("not-a-digest")).toBeNull();
  });

  it("rejects a blob beyond the byte bound", async () => {
    const store = fileBlobStore(root, 4);
    await expect(store.put(new Uint8Array(5))).rejects.toThrow(/blob exceeds/);
  });
});
