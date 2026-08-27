import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveDataEncryptionKey } from "./cipher.ts";
import { VirtualClock } from "./clock.ts";
import { StateStore } from "./store.ts";

const RUN_ID = "codex-baseline-01-run-01";
const KEY = deriveDataEncryptionKey("2".repeat(64));
const OBSERVED_AT = "2026-08-27T12:00:00.480Z";

const IDENTITY = {
  operationKey: "path:POST /v1/computers",
  principalKey: "principal:primary-api-key",
  normalizedPath: "/v1/computers",
  idempotencyKey: "idem-0001"
};

const RESPONSE = {
  status: 201,
  headers: { "content-type": "application/json" },
  body: { id: "comp_0001", state: "running" }
};

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-idem-"));
  store = StateStore.open({
    path: join(dir, "state.db"),
    runId: RUN_ID,
    encryptionKey: KEY
  });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function commit(sequence: number, fingerprint: string, logicalTime: string) {
  store.putIdempotencyRecord({
    identity: IDENTITY,
    requestFingerprint: fingerprint,
    response: RESPONSE,
    sequence,
    logicalTime
  });
}

describe("idempotency cache", () => {
  it("misses before the first commit and replays afterwards", () => {
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    const fingerprint = '{"template":"system/chrome"}';
    expect(
      store.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: fingerprint
      })
    ).toEqual({ outcome: "miss", response: null, conflictStatus: null });

    commit(request.sequence, fingerprint, "2000-01-01T00:00:00.000Z");
    const replay = store.lookupIdempotency({
      identity: IDENTITY,
      requestFingerprint: fingerprint
    });
    expect(replay.outcome).toBe("replay");
    expect(replay.response).toEqual(RESPONSE);
    expect(store.countIdempotencyEntries()).toBe(1);
  });

  it("reports a conflict with the configured status on a different body", () => {
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    commit(
      request.sequence,
      '{"template":"system/chrome"}',
      "2000-01-01T00:00:00.000Z"
    );

    const conflict = store.lookupIdempotency({
      identity: IDENTITY,
      requestFingerprint: '{"template":"system/vim"}'
    });
    expect(conflict).toEqual({
      outcome: "conflict",
      response: null,
      conflictStatus: 409
    });

    const custom = store.lookupIdempotency({
      identity: IDENTITY,
      requestFingerprint: '{"template":"system/vim"}',
      policy: { conflictStatus: 422 }
    });
    expect(custom.conflictStatus).toBe(422);
    // A different key namespace does not collide with the stored entry.
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, idempotencyKey: "idem-0002" },
        requestFingerprint: '{"template":"system/vim"}'
      }).outcome
    ).toBe("miss");
  });

  it("separates principals and normalized paths", () => {
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    commit(request.sequence, "body", "2000-01-01T00:00:00.000Z");
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, principalKey: "principal:other" },
        requestFingerprint: "body"
      }).outcome
    ).toBe("miss");
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, normalizedPath: "/v1/v1/computers" },
        requestFingerprint: "body"
      }).outcome
    ).toBe("miss");
  });

  it("expires entries on virtual time and removes them", () => {
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    commit(request.sequence, "body", "2000-01-01T00:00:00.000Z");
    const policy = { ttlMs: 1_000 };
    expect(
      store.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: "body",
        policy,
        nowMs: Date.parse("2000-01-01T00:00:00.999Z")
      }).outcome
    ).toBe("replay");
    expect(
      store.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: "body",
        policy,
        nowMs: Date.parse("2000-01-01T00:00:01.000Z")
      }).outcome
    ).toBe("expired");
    expect(store.countIdempotencyEntries()).toBe(0);
    expect(
      store.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: "body"
      }).outcome
    ).toBe("miss");
  });

  it("evicts expired entries first, then the oldest sequence", () => {
    const policy = { maxEntries: 2, ttlMs: 10_000 };
    const first = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    const second = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    const third = store.beginRequest({ ingressObservedAt: OBSERVED_AT });

    store.putIdempotencyRecord({
      identity: { ...IDENTITY, idempotencyKey: "k1" },
      requestFingerprint: "a",
      response: RESPONSE,
      sequence: first.sequence,
      logicalTime: "2000-01-01T00:00:00.000Z",
      policy
    });
    store.putIdempotencyRecord({
      identity: { ...IDENTITY, idempotencyKey: "k2" },
      requestFingerprint: "b",
      response: RESPONSE,
      sequence: second.sequence,
      logicalTime: "2000-01-01T00:00:19.000Z",
      policy
    });
    expect(store.countIdempotencyEntries()).toBe(2);

    // k1 expired long ago; adding a third entry removes it, not k2.
    store.putIdempotencyRecord({
      identity: { ...IDENTITY, idempotencyKey: "k3" },
      requestFingerprint: "c",
      response: RESPONSE,
      sequence: third.sequence,
      logicalTime: "2000-01-01T00:00:20.000Z",
      policy,
      nowMs: Date.parse("2000-01-01T00:00:20.000Z")
    });
    expect(store.countIdempotencyEntries()).toBe(2);
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, idempotencyKey: "k1" },
        requestFingerprint: "a"
      }).outcome
    ).toBe("miss");
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, idempotencyKey: "k2" },
        requestFingerprint: "b"
      }).outcome
    ).toBe("replay");

    // With no TTL, the oldest committed sequence is evicted instead.
    store.putIdempotencyRecord({
      identity: { ...IDENTITY, idempotencyKey: "k4" },
      requestFingerprint: "d",
      response: RESPONSE,
      sequence: third.sequence,
      logicalTime: "2000-01-01T00:00:20.000Z",
      policy: { maxEntries: 2 }
    });
    expect(store.countIdempotencyEntries()).toBe(2);
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, idempotencyKey: "k2" },
        requestFingerprint: "b"
      }).outcome
    ).toBe("miss");
    expect(
      store.lookupIdempotency({
        identity: { ...IDENTITY, idempotencyKey: "k4" },
        requestFingerprint: "d"
      }).outcome
    ).toBe("replay");
  });

  it("stores keyed identities and encrypted responses", () => {
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    commit(request.sequence, "body", "2000-01-01T00:00:00.000Z");
    const raw = new DatabaseSync(join(dir, "state.db"));
    try {
      const row = raw
        .prepare(
          "SELECT idempotency_key_hmac, request_hmac, response_ciphertext FROM idempotency"
        )
        .get();
      expect(row?.["idempotency_key_hmac"]).not.toBe(IDENTITY.idempotencyKey);
      expect(String(row?.["idempotency_key_hmac"])).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.["request_hmac"]).not.toBe("body");
      const ciphertext = new TextDecoder().decode(
        row?.["response_ciphertext"] as Uint8Array
      );
      expect(ciphertext).not.toContain("comp_0001");
    } finally {
      raw.close();
    }
  });

  it("shares the run virtual clock for default expiry decisions", () => {
    const clocked = StateStore.open({
      path: join(dir, "clocked.db"),
      runId: RUN_ID,
      encryptionKey: KEY,
      clock: new VirtualClock({ tickMs: 1 })
    });
    const request = clocked.beginRequest({ ingressObservedAt: OBSERVED_AT });
    clocked.completeRequest(request.sequence, {
      terminalStatus: "committed",
      committed: true
    });
    clocked.putIdempotencyRecord({
      identity: IDENTITY,
      requestFingerprint: "body",
      response: RESPONSE,
      sequence: request.sequence,
      logicalTime: clocked.clock.now(),
      policy: { ttlMs: 1 }
    });
    clocked.completeRequest(
      clocked.beginRequest({ ingressObservedAt: OBSERVED_AT }).sequence,
      { terminalStatus: "committed", committed: true }
    );
    expect(
      clocked.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: "body",
        policy: { ttlMs: 1 },
        nowMs: clocked.clock.nowMs()
      }).outcome
    ).toBe("expired");
    clocked.close();
  });
});
