/**
 * Checkpoint tests (specification section 48.4). A checkpoint carries
 * every deterministic component: the full random stream positions,
 * the ID allocator positions, the idempotency replay entries, and the
 * blob references restore into a fresh database under a fresh key and
 * continue exactly where the source stopped. A state-only snapshot,
 * an omitted component, and an incompatible version all fail
 * validation before any world opens.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OalError, type Json } from "@oal/core";

import {
  buildCheckpointDocument,
  parseCheckpointDocument
} from "./checkpoint.ts";
import { DeterministicPrng, createNamespacePrng } from "./random.ts";
import { SCHEMA_META_VERSION_KEY, SCHEMA_VERSION } from "./schema.ts";
import { StateStore } from "./store.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-checkpoint-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SEED = "a".repeat(64);
const WORLD_ID = "webclip-serve-01";

const FROZEN = {
  pack_id: "webclip",
  pack_sha256: "1".repeat(64),
  scenario_id: "baseline",
  seed: SEED,
  behavior_sha256: "2".repeat(64),
  behavior_closure_identity: "3".repeat(64),
  runtime_name: "node",
  contract_semantic_sha256: "4".repeat(64),
  contract_execution_sha256: "5".repeat(64)
};

/** Assert that `fn` throws the stable code, not just any error. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OalError);
    expect((error as OalError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a throw with code ${code}, but nothing threw.`);
}

/** One source world with state, a replay entry, and a blob. */
function openSourceWorld(name = "source.db"): StateStore {
  const store = StateStore.open({
    path: join(dir, name),
    runId: WORLD_ID,
    clock: { initialMs: 946684800_000, tickMs: 1 }
  });
  store.initializeWorld({
    worldId: WORLD_ID,
    createdAt: "2026-10-10T00:00:00.000Z"
  });
  store.initializeRun({
    batchId: "manual",
    contractSemanticSha256: "1".repeat(64),
    contractExecutionSha256: "2".repeat(64),
    sourceInventorySha256: "3".repeat(64),
    backendSha256: "4".repeat(64),
    implementationSha256: "5".repeat(64),
    seed: SEED,
    stateSchemaVersion: 1,
    createdAt: "2026-10-10T00:00:00.000Z"
  });
  store.putState({
    state: { clips: { clip_00000001: { url: "https://example.com/a" } } },
    expectedRevision: null
  });
  store.putIdempotencyRecord({
    identity: {
      operationKey: "path:POST /v1/clips",
      principalKey: "principal-1",
      normalizedPath: "/v1/clips",
      idempotencyKey: "create-once"
    },
    requestFingerprint: '{"url":"https://example.com/a"}',
    response: {
      status: 201,
      headers: { "content-type": "application/json" },
      body: { id: "clip_00000001" }
    },
    sequence: 1,
    logicalTime: "2000-01-01T00:00:01.000Z"
  });
  store.registerBlob({
    blobId: "blob_00000001",
    sha256: "6".repeat(64),
    bytes: 128,
    mediaType: "text/markdown",
    relativePath: "blobs/blob_00000001"
  });
  return store;
}

describe("checkpoint documents", () => {
  it("restores streams, identifiers, replays, and blobs", () => {
    const source = openSourceWorld();
    const worldPrng = createNamespacePrng(SEED, "world:services");
    // Draw three values so the exported position is mid-stream.
    worldPrng.nextFloat();
    worldPrng.nextFloat();
    worldPrng.nextFloat();
    const faultPrng = createNamespacePrng(SEED, "faults");

    const document = source.exportCheckpoint({
      checkpointId: "chk_00000001",
      frozen: FROZEN,
      services: {
        clock: { now_ms: 946684800_007, tick_ms: 1 },
        ids: { positions: { clip: 3 } },
        random: [
          {
            namespace: "world:services",
            algorithm: DeterministicPrng.ALGORITHM,
            state: worldPrng.exportState()
          }
        ],
        faults: {
          counters: { "flaky-render": 2 },
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: faultPrng.exportState()
          }
        }
      }
    });
    expect(document.state.revision).toBe(0);
    expect(document.idempotency.entries.length).toBe(1);
    expect(document.blobs.references.length).toBe(1);
    source.close();

    // The wire form round-trips: parse what JSON.stringify produced.
    const parsed = parseCheckpointDocument(
      JSON.parse(JSON.stringify(document)) as Json
    );
    expect(parsed.random.streams[0]?.namespace).toBe("world:services");

    // The stream continues from the exported position, not the seed.
    const restored = DeterministicPrng.fromState(
      parsed.random.streams[0]?.state ?? ""
    );
    const ahead = createNamespacePrng(SEED, "world:services");
    ahead.nextFloat();
    ahead.nextFloat();
    ahead.nextFloat();
    expect(restored.nextFloat()).toBe(ahead.nextFloat());

    // The next identifier continues the counter position.
    const position = parsed.ids.positions["clip"] ?? 0;
    expect(`clip_${(position + 1).toString(10).padStart(8, "0")}`).toBe(
      "clip_00000004"
    );

    // The importing world uses a fresh database with a fresh key.
    const target = StateStore.open({
      path: join(dir, "target.db"),
      runId: "webclip-fork-01"
    });
    try {
      const imported = target.importCheckpoint(
        JSON.parse(JSON.stringify(document)) as Json
      );
      expect(imported.world.generation).toBe(1);

      const state = target.getState();
      expect(state?.revision).toBe(0);
      expect(state?.state).toEqual(document.state.state);

      // The replay entry answers under the new key.
      const replay = target.lookupIdempotency({
        identity: {
          operationKey: "path:POST /v1/clips",
          principalKey: "principal-1",
          normalizedPath: "/v1/clips",
          idempotencyKey: "create-once"
        },
        requestFingerprint: '{"url":"https://example.com/a"}'
      });
      expect(replay.outcome).toBe("replay");
      expect(replay.response?.status).toBe(201);
      expect(replay.response?.body).toEqual({ id: "clip_00000001" });

      // A different fingerprint still conflicts, not replays.
      const conflict = target.lookupIdempotency({
        identity: {
          operationKey: "path:POST /v1/clips",
          principalKey: "principal-1",
          normalizedPath: "/v1/clips",
          idempotencyKey: "create-once"
        },
        requestFingerprint: '{"url":"https://example.com/b"}'
      });
      expect(conflict.outcome).toBe("conflict");

      // The blob reference survives the import.
      const world = target.readWorld();
      expect(world?.originCheckpointId).toBe("chk_00000001");
      const reexported = target.exportCheckpoint({
        checkpointId: "chk_00000002",
        frozen: FROZEN,
        services: {
          clock: { now_ms: parsed.clock.now_ms, tick_ms: parsed.clock.tick_ms },
          ids: { positions: { ...parsed.ids.positions } },
          random: parsed.random.streams.map((stream) => ({ ...stream })),
          faults: {
            counters: { ...parsed.faults.counters },
            random: { ...parsed.faults.random }
          }
        }
      });
      expect(reexported.blobs.references).toEqual(document.blobs.references);
      expect(reexported.idempotency.entries).toEqual(
        document.idempotency.entries
      );
      expect(reexported.ids.positions).toEqual({ clip: 3 });
    } finally {
      target.close();
    }
  });

  it("refuses a state-only snapshot", () => {
    const stateOnly = {
      schema_version: 1,
      kind: "Checkpoint",
      checkpoint_id: "chk_00000001",
      frozen: FROZEN,
      world: {
        world_id: WORLD_ID,
        generation: 1,
        origin_checkpoint_id: null
      },
      state: {
        state_schema_version: 1,
        revision: 1,
        logical_time: "2000-01-01T00:00:01.000Z",
        state: { clips: {} }
      }
    };
    expectCode(
      () => parseCheckpointDocument(stateOnly as Json),
      "OAL-CHECKPOINT-INCOMPLETE"
    );
  });

  it("refuses each omitted component at build time", () => {
    const base = {
      checkpoint_id: "chk_00000001",
      world: { world_id: WORLD_ID, generation: 1, origin_checkpoint_id: null },
      state: {
        state_schema_version: 1,
        revision: 1,
        logical_time: "2000-01-01T00:00:01.000Z",
        state: { clips: {} }
      },
      services: {
        clock: { now_ms: 1, tick_ms: 1 },
        ids: { positions: { clip: 1 } },
        random: [
          {
            namespace: "world:services",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        ],
        faults: {
          counters: {},
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        }
      },
      idempotency: [],
      blobs: [],
      frozen: FROZEN
    };
    expectCode(
      () =>
        buildCheckpointDocument({
          ...base,
          services: { ...base.services, faults: undefined as never }
        }),
      "OAL-CHECKPOINT-INCOMPLETE"
    );
    expectCode(
      () =>
        buildCheckpointDocument({
          ...base,
          services: { ...base.services, random: [] }
        }),
      "OAL-CHECKPOINT-INCOMPLETE"
    );
    expectCode(
      () => buildCheckpointDocument({ ...base, blobs: undefined as never }),
      "OAL-CHECKPOINT-INCOMPLETE"
    );
  });

  it("refuses incompatible document and stream versions", () => {
    const store = openSourceWorld();
    const document = store.exportCheckpoint({
      checkpointId: "chk_00000001",
      frozen: FROZEN,
      services: {
        clock: { now_ms: 1, tick_ms: 1 },
        ids: { positions: {} },
        random: [
          {
            namespace: "world:services",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        ],
        faults: {
          counters: {},
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        }
      }
    });
    store.close();

    const newer = {
      ...JSON.parse(JSON.stringify(document)),
      schema_version: 2
    } as Json;
    expectCode(
      () => parseCheckpointDocument(newer),
      "OAL-CHECKPOINT-INCOMPATIBLE"
    );

    const foreignStream = JSON.parse(JSON.stringify(document)) as {
      random: { streams: Array<Record<string, unknown>> };
    };
    const firstStream = foreignStream.random.streams[0];
    if (firstStream === undefined) {
      throw new Error("The exported document carries no random stream.");
    }
    firstStream.algorithm = "xorshift-v9";
    expectCode(
      () => parseCheckpointDocument(foreignStream as Json),
      "OAL-CHECKPOINT-INCOMPATIBLE"
    );

    const foreignClock = JSON.parse(JSON.stringify(document)) as {
      clock: Record<string, unknown>;
    };
    foreignClock.clock.algorithm = "tick-tock-v0";
    expectCode(
      () => parseCheckpointDocument(foreignClock as Json),
      "OAL-CHECKPOINT-INCOMPATIBLE"
    );
  });

  it("imports only into an empty world", () => {
    const source = openSourceWorld();
    const document = source.exportCheckpoint({
      checkpointId: "chk_00000001",
      frozen: FROZEN,
      services: {
        clock: { now_ms: 1, tick_ms: 1 },
        ids: { positions: {} },
        random: [
          {
            namespace: "world:services",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        ],
        faults: {
          counters: {},
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        }
      }
    });
    source.close();

    const occupied = openSourceWorld("occupied.db");
    try {
      expect(() =>
        occupied.importCheckpoint(JSON.parse(JSON.stringify(document)) as Json)
      );
      expect(occupied.getState()).not.toBeNull();
    } finally {
      occupied.close();
    }
  });

  it("migrates a version one database before startup", () => {
    const path = join(dir, "legacy.db");
    const store = StateStore.open({ path, runId: WORLD_ID });
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    store.close();

    // Roll the database back to version 1, as an older build left it.
    const raw = new DatabaseSync(path);
    try {
      raw.exec("DROP TABLE world_state");
      raw.exec("DROP TABLE idempotency_identity");
      raw.exec("DROP TABLE control_results");
      raw.exec("DROP TABLE fault_state");
      raw.exec("DROP TABLE fault_consumptions");
      raw.exec("DROP TABLE delivery");
      raw.exec(`DELETE FROM schema_meta WHERE key = 'migration:4'`);
      raw.exec(`DELETE FROM schema_meta WHERE key = 'migration:3'`);
      raw
        .prepare(`UPDATE schema_meta SET value = ? WHERE key = ?`)
        .run("1", SCHEMA_META_VERSION_KEY);
      raw.exec(`DELETE FROM schema_meta WHERE key = 'migration:2'`);
    } finally {
      raw.close();
    }

    const migrated = StateStore.open({ path, runId: WORLD_ID });
    try {
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      const probe = new DatabaseSync(path);
      try {
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => String(row["name"]));
        expect(tables).toContain("world_state");
        expect(tables).toContain("idempotency_identity");
      } finally {
        probe.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("refuses a second world identity in one database", () => {
    const store = StateStore.open({
      path: join(dir, "identity.db"),
      runId: WORLD_ID
    });
    try {
      const first = store.initializeWorld({
        worldId: WORLD_ID,
        createdAt: "2026-10-10T00:00:00.000Z"
      });
      expect(first.generation).toBe(1);
      // Re-initializing the same world is idempotent.
      store.initializeWorld({
        worldId: WORLD_ID,
        createdAt: "2026-10-10T00:00:00.000Z"
      });
      expect(() =>
        store.initializeWorld({
          worldId: "another-world",
          createdAt: "2026-10-10T00:00:00.000Z"
        })
      );
      expect(store.readWorld()?.worldId).toBe(WORLD_ID);
    } finally {
      store.close();
    }
  });
});
