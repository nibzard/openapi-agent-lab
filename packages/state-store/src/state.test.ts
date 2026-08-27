import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJsonSha256, OalError } from "@oal/core";

import { deriveDataEncryptionKey } from "./cipher.ts";
import { VirtualClock } from "./clock.ts";
import type { StateStoreLimits } from "./limits.ts";
import { StateStore } from "./store.ts";

const RUN_ID = "codex-baseline-01-run-01";
const KEY = deriveDataEncryptionKey("0".repeat(64));
const TINY: StateStoreLimits = {
  maxRequestsPerRun: 100,
  maxEventLogBytes: 4096,
  maxPersistedStateBytes: 200,
  maxDomainObjects: 3,
  maxIdempotencyEntries: 16
};

let dir: string;

function storePath(name = "state.db"): string {
  return join(dir, name);
}

function openStore(
  path: string,
  options?: { limits?: StateStoreLimits; key?: Uint8Array }
): StateStore {
  return StateStore.open({
    path,
    runId: RUN_ID,
    ...(options?.limits === undefined ? {} : { limits: options.limits }),
    ...(options?.key === undefined ? {} : { encryptionKey: options.key })
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("domain state revisions", () => {
  it("initializes at revision zero and increments on change", () => {
    const store = openStore(storePath(), { key: KEY });
    expect(store.getState()).toBeNull();
    const first = store.putState({
      state: { computers: {} },
      expectedRevision: null
    });
    expect(first).toEqual({
      revision: 0,
      changed: true,
      logicalTime: "2000-01-01T00:00:00.000Z",
      evidenceDigest: canonicalJsonSha256({ computers: {} })
    });
    const second = store.putState({
      state: { computers: { comp_0001: { state: "running" } } },
      expectedRevision: 0
    });
    expect(second.revision).toBe(1);
    expect(second.changed).toBe(true);
    const snapshot = store.getState();
    expect(snapshot?.revision).toBe(1);
    expect(snapshot?.state).toEqual({
      computers: { comp_0001: { state: "running" } }
    });
    store.close();
  });

  it("keeps the revision when the committed state is unchanged", () => {
    const store = openStore(storePath(), { key: KEY });
    store.putState({ state: { computers: {} }, expectedRevision: null });
    const again = store.putState({
      state: { computers: {} },
      expectedRevision: 0
    });
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(0);
    // Key order does not matter for the equality check.
    store.putState({
      state: { extra: 1, computers: {} },
      expectedRevision: 0
    });
    const reordered = store.putState({
      state: { computers: {}, extra: 1 },
      expectedRevision: 1
    });
    expect(reordered.changed).toBe(false);
    expect(reordered.revision).toBe(1);
    store.close();
  });

  it("fails with OAL-STATE-COMMIT-FAILED on a stale revision", () => {
    const store = openStore(storePath(), { key: KEY });
    store.putState({ state: { computers: {} }, expectedRevision: null });
    store.putState({ state: { computers: { a: 1 } }, expectedRevision: 0 });
    try {
      store.putState({ state: { computers: { a: 2 } }, expectedRevision: 0 });
      expect.unreachable("a stale revision must not commit");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-STATE-COMMIT-FAILED");
    }
    try {
      store.putState({
        state: { computers: { a: 3 } },
        expectedRevision: null
      });
      expect.unreachable("an initialized state cannot be reinitialized");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-STATE-COMMIT-FAILED");
    }
    expect(store.getState()?.state).toEqual({ computers: { a: 1 } });
    store.close();
  });

  it("encrypts state at rest and rejects the wrong key", () => {
    const path = storePath();
    const store = openStore(path, { key: KEY });
    store.putState({
      state: { computers: { comp_0001: { secret: "hunter2" } } },
      expectedRevision: null,
      projection: { computers: { comp_0001: { secret: "[REDACTED]" } } }
    });
    store.close();
    const raw = new DatabaseSync(path);
    try {
      const row = raw
        .prepare(
          "SELECT state_ciphertext, state_evidence_digest FROM domain_state"
        )
        .get();
      const ciphertext = new TextDecoder().decode(
        row?.["state_ciphertext"] as Uint8Array
      );
      expect(ciphertext).not.toContain("hunter2");
      expect(row?.["state_evidence_digest"]).toBe(
        canonicalJsonSha256({
          computers: { comp_0001: { secret: "[REDACTED]" } }
        })
      );
    } finally {
      raw.close();
    }
    const reopened = openStore(path, {
      key: deriveDataEncryptionKey("1".repeat(64))
    });
    try {
      reopened.getState();
      expect.unreachable("a foreign key must not decrypt the state");
    } catch (error) {
      expect(String(error)).toMatch(/authentication/i);
    }
    reopened.close();
  });

  it("persists state and revision across reopen with the same key", () => {
    const path = storePath();
    const first = openStore(path, { key: KEY });
    first.putState({ state: { computers: { a: 1 } }, expectedRevision: null });
    first.putState({ state: { computers: { a: 2 } }, expectedRevision: 0 });
    first.close();
    const second = openStore(path, { key: KEY });
    expect(second.getState()?.state).toEqual({ computers: { a: 2 } });
    expect(second.getState()?.revision).toBe(1);
    second.close();
  });

  it("stamps logical time from the virtual clock", () => {
    const store = StateStore.open({
      path: storePath(),
      runId: RUN_ID,
      encryptionKey: KEY,
      clock: new VirtualClock({
        initialMs: Date.parse("2026-01-01T00:00:00.000Z"),
        tickMs: 5
      })
    });
    const result = store.putState({
      state: { computers: {} },
      expectedRevision: null
    });
    expect(result.logicalTime).toBe("2026-01-01T00:00:00.000Z");
    expect(store.getState()?.logicalTime).toBe("2026-01-01T00:00:00.000Z");
    store.completeRequest(
      store.beginRequest({
        ingressObservedAt: "2026-08-27T12:00:00.000Z"
      }).sequence,
      { terminalStatus: "committed", committed: true }
    );
    expect(store.clock.now()).toBe("2026-01-01T00:00:00.005Z");
    const next = store.putState({
      state: { computers: { a: 1 } },
      expectedRevision: 0
    });
    expect(next.logicalTime).toBe("2026-01-01T00:00:00.005Z");
    store.close();
  });

  it("enforces the persisted-state limits", () => {
    const store = openStore(storePath(), { key: KEY, limits: TINY });
    store.putState({ state: { computers: {} }, expectedRevision: null });
    try {
      store.putState({
        state: { blob: "y".repeat(400) },
        expectedRevision: 0
      });
      expect.unreachable("the byte limit must stop the write");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-LIMIT-REACHED");
    }
    try {
      store.putState({
        state: { a: 1, b: 2, c: 3, d: 4 },
        expectedRevision: 0
      });
      expect.unreachable("the object limit must stop the write");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-LIMIT-REACHED");
    }
    expect(store.getState()?.state).toEqual({ computers: {} });
    store.close();
  });
});
