import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson, canonicalJsonSha256, OalError } from "@oal/core";

import { integrityCheck } from "./database.ts";
import { schemaVersionUnsupported } from "./errors.ts";
import {
  SCHEMA_META_VERSION_KEY,
  SCHEMA_VERSION,
  STATE_STORE_TABLES
} from "./schema.ts";
import type { StateStoreLimits } from "./limits.ts";
import { StateStore } from "./store.ts";
import type { RunMetaInput } from "./store.ts";

const RUN_ID = "codex-baseline-01-run-01";
const OBSERVED_AT = "2026-08-27T12:00:00.480Z";

let dir: string;

function storePath(name = "state.db"): string {
  return join(dir, name);
}

function openStore(
  path: string,
  limits?: StateStoreLimits,
  options?: { runId?: string }
): StateStore {
  return StateStore.open({
    path,
    ...(limits === undefined ? {} : { limits }),
    runId: options?.runId ?? RUN_ID
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-state-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("schema and migrations", () => {
  it("creates every table from specification section 38.1", () => {
    const store = openStore(storePath());
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.journalMode).toBe("wal");
    const raw = new DatabaseSync(storePath());
    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row["name"]));
      for (const table of STATE_STORE_TABLES) {
        expect(tables).toContain(table);
      }
      expect(raw.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1
      });
      expect(integrityCheck(raw)).toBe(true);
    } finally {
      raw.close();
    }
    store.close();
  });

  it("records the schema version in schema_meta", () => {
    const store = openStore(storePath());
    const raw = new DatabaseSync(storePath());
    try {
      const row = raw
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(SCHEMA_META_VERSION_KEY);
      expect(row).toEqual({ value: SCHEMA_VERSION.toString(10) });
    } finally {
      raw.close();
    }
    store.close();
  });

  it("is idempotent when the same database is opened twice", () => {
    const first = openStore(storePath());
    first.allocateIngress({ plane: "api", observedAt: OBSERVED_AT });
    first.close();

    const second = openStore(storePath());
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    expect(second.getIngress(1)?.ingressId).toBe("ing_00000001");
    const next = second.allocateIngress({
      plane: "api",
      observedAt: OBSERVED_AT
    });
    expect(next.participantIngressSequence).toBe(2);
    second.close();
  });

  it("rejects a database written by a newer build", () => {
    const path = storePath("future.db");
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    raw
      .prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
      .run(SCHEMA_META_VERSION_KEY, (SCHEMA_VERSION + 1).toString(10));
    raw.close();
    try {
      openStore(path);
      expect.unreachable("opening a newer database must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-SCHEMA-VERSION-UNSUPPORTED");
      expect((error as OalError).message).toMatch(/newer/);
      expect(schemaVersionUnsupported(2, 1).code).toBe(
        "OAL-SCHEMA-VERSION-UNSUPPORTED"
      );
    }
  });

  it("refuses an unsafe run identifier", () => {
    expect(() =>
      openStore(storePath(), undefined, { runId: "../escape" })
    ).toThrowError(/safe identifier/);
  });

  it("supports a private in-memory database with a journal fallback", () => {
    const store = StateStore.open({ path: ":memory:", runId: RUN_ID });
    expect(store.journalMode).toBe("memory");
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    expect(request.requestId).toBe("req_00000001");
    store.close();
  });
});

describe("run metadata", () => {
  it("round-trips the run record", () => {
    const store = openStore(storePath());
    expect(store.getRunMeta()).toBeNull();
    const record = store.initializeRun({
      batchId: "codex-baseline-01",
      contractSemanticSha256: "a".repeat(64),
      contractExecutionSha256: "b".repeat(64),
      sourceInventorySha256: "c".repeat(64),
      packSha256: "d".repeat(64),
      scenarioSha256: "e".repeat(64),
      contractVariantSha256: null,
      backendSha256: "f".repeat(64),
      implementationSha256: "9".repeat(64),
      seed: "0".repeat(64),
      stateSchemaVersion: 1,
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    expect(record.runId).toBe(RUN_ID);
    expect(store.getRunMeta()).toEqual(record);
    expect(() =>
      store.initializeRun({
        batchId: "other",
        contractSemanticSha256: "a".repeat(64),
        contractExecutionSha256: "b".repeat(64),
        sourceInventorySha256: "c".repeat(64),
        backendSha256: "f".repeat(64),
        implementationSha256: "9".repeat(64),
        seed: "0".repeat(64),
        stateSchemaVersion: 1,
        createdAt: "2026-08-27T12:00:00.000Z"
      })
    ).toThrowError(/already initialized/);
    store.close();
  });
});

describe("ingress and request sequences", () => {
  it("allocates monotonic participant ingress identifiers", () => {
    const store = openStore(storePath());
    const first = store.allocateIngress({
      plane: "api",
      observedAt: OBSERVED_AT
    });
    const second = store.allocateIngress({
      plane: "documentation",
      observedAt: OBSERVED_AT
    });
    expect(first).toEqual({
      participantIngressSequence: 1,
      ingressId: "ing_00000001",
      plane: "api",
      observedAt: OBSERVED_AT
    });
    expect(second.participantIngressSequence).toBe(2);
    expect(second.ingressId).toBe("ing_00000002");
    expect(store.getIngress(2)?.plane).toBe("documentation");
    expect(store.getIngress(3)).toBeNull();
    store.close();
  });

  it("formats request identifiers as req_00000001 and stays monotonic", () => {
    const store = openStore(storePath());
    const first = store.beginRequest({
      ingressObservedAt: OBSERVED_AT,
      operationKey: "path:POST /v1/computers",
      method: "POST",
      pathRedacted: "/v1/computers"
    });
    const second = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    expect(first).toEqual({ sequence: 1, requestId: "req_00000001" });
    expect(second.sequence).toBe(2);
    expect(second.requestId).toBe("req_00000002");
    const record = store.getRequest(1);
    expect(record?.requestId).toBe("req_00000001");
    expect(record?.terminalStatus).toBe("pending");
    expect(record?.committed).toBe(false);
    expect(store.getRequest(3)).toBeNull();
    store.close();
  });

  it("enforces the per-run request limit", () => {
    const store = openStore(storePath(), {
      maxRequestsPerRun: 2,
      maxEventLogBytes: 1024,
      maxPersistedStateBytes: 1024,
      maxDomainObjects: 16,
      maxIdempotencyEntries: 16
    });
    store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    try {
      store.beginRequest({ ingressObservedAt: OBSERVED_AT });
      expect.unreachable("the request limit must stop the third request");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-LIMIT-REACHED");
    }
    expect(store.countRequests()).toBe(2);
    store.close();
  });

  it("rejects a plane mismatch between ingress and transaction", () => {
    const store = openStore(storePath());
    const documentationIngress = store.allocateIngress({
      plane: "documentation",
      observedAt: OBSERVED_AT
    });
    expect(() =>
      store.beginRequest({
        participantIngressSequence:
          documentationIngress.participantIngressSequence,
        ingressObservedAt: OBSERVED_AT
      })
    ).toThrowError(/plane/);
    expect(() =>
      store.beginRequest({
        participantIngressSequence: 99,
        ingressObservedAt: OBSERVED_AT
      })
    ).toThrowError(/No participant ingress/);
    store.close();
  });

  it("advances the virtual clock once per committed request", () => {
    const store = openStore(storePath());
    expect(store.clock.now()).toBe("2000-01-01T00:00:00.000Z");
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.completeRequest(request.sequence, {
      terminalStatus: "committed",
      responseStatus: 201,
      committed: true
    });
    expect(store.clock.now()).toBe("2000-01-01T00:00:00.001Z");
    const rejected = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.completeRequest(rejected.sequence, {
      terminalStatus: "rejected",
      responseStatus: 401,
      committed: false
    });
    expect(store.clock.now()).toBe("2000-01-01T00:00:00.001Z");
    expect(store.getRequest(rejected.sequence)?.responseStatus).toBe(401);
    expect(store.getRequest(rejected.sequence)?.committed).toBe(false);
    expect(() => {
      store.completeRequest(99, {
        terminalStatus: "failed",
        committed: false
      });
    }).toThrowError(/No request/);
    store.close();
  });
});

describe("event log", () => {
  it("stores canonical API events with their digest", () => {
    const store = openStore(storePath());
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    const event = { type: "api.exchange", sequence: request.sequence };
    const record = store.appendApiEvent({
      sequence: request.sequence,
      eventJson: event
    });
    expect(record.eventId).toBe("evt_00000001");
    expect(store.eventLogBytes()).toBe(
      Buffer.byteLength(canonicalJson(event), "utf8")
    );
    const raw = new DatabaseSync(storePath());
    try {
      const row = raw
        .prepare(
          "SELECT event_json, event_sha256 FROM events WHERE sequence = ?"
        )
        .get(request.sequence);
      expect(row?.["event_json"]).toBe(canonicalJson(event));
      expect(row?.["event_sha256"]).toBe(canonicalJsonSha256(event));
    } finally {
      raw.close();
    }
    store.close();
  });

  it("rolls back an event whose request row is missing", () => {
    const store = openStore(storePath());
    expect(() =>
      store.appendApiEvent({ sequence: 7, eventJson: { type: "api.exchange" } })
    ).toThrowError();
    expect(store.eventLogBytes()).toBe(0);
    store.close();
  });

  it("enforces the event-log byte cap", () => {
    const store = openStore(storePath(), {
      maxRequestsPerRun: 100,
      maxEventLogBytes: 64,
      maxPersistedStateBytes: 1024,
      maxDomainObjects: 16,
      maxIdempotencyEntries: 16
    });
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.appendApiEvent({
      sequence: request.sequence,
      eventJson: { type: "api.exchange", note: "small" }
    });
    const bytes = store.eventLogBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(64);
    try {
      store.appendApiEvent({
        sequence: request.sequence,
        eventJson: {
          type: "api.exchange",
          payload: "x".repeat(200)
        }
      });
      expect.unreachable("the event-log cap must stop the append");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-LIMIT-REACHED");
    }
    expect(store.eventLogBytes()).toBe(bytes);
    store.close();
  });

  it("links semantic events to their request and parent", () => {
    const store = openStore(storePath());
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    const apiEvent = store.appendApiEvent({
      sequence: request.sequence,
      eventJson: { type: "api.exchange" }
    });
    const first = store.appendSemanticEvent({
      requestSequence: request.sequence,
      parentEventId: apiEvent.eventId,
      eventName: "computer.created",
      schemaVersion: 1,
      eventJson: { computer_id: "comp_0001" }
    });
    const second = store.appendSemanticEvent({
      requestSequence: request.sequence,
      parentEventId: first.eventId,
      eventName: "computer.started",
      schemaVersion: 1,
      eventJson: { computer_id: "comp_0001" }
    });
    expect(first.semanticSequence).toBe(1);
    expect(first.eventId).toBe("sem_00000001");
    expect(second.semanticSequence).toBe(2);
    const listed = store.listSemanticEvents(request.sequence);
    expect(listed).toHaveLength(2);
    expect(listed[1]?.parentEventId).toBe(first.eventId);
    expect(listed[0]?.eventJson).toEqual({ computer_id: "comp_0001" });
    expect(() =>
      store.appendSemanticEvent({
        requestSequence: 42,
        eventName: "orphan",
        schemaVersion: 1,
        eventJson: {}
      })
    ).toThrowError();
    store.close();
  });

  it("records documentation exchanges on their own sequence", () => {
    const store = openStore(storePath());
    const ingress = store.allocateIngress({
      plane: "documentation",
      observedAt: OBSERVED_AT
    });
    const record = store.recordDocumentationExchange({
      participantIngressSequence: ingress.participantIngressSequence,
      observedAt: OBSERVED_AT,
      method: "GET",
      pathRedacted: "/docs/openapi.json",
      responseStatus: 200,
      responseJson: { openapi: "3.1.0" },
      eventJson: { type: "documentation.exchange" }
    });
    expect(record.documentationSequence).toBe(1);
    expect(record.exchangeId).toBe("doc_00000001");
    expect(record.responseSha256).toBe(
      canonicalJsonSha256({ openapi: "3.1.0" })
    );
    expect(store.eventLogBytes()).toBeGreaterThan(0);
    const apiIngress = store.allocateIngress({
      plane: "api",
      observedAt: OBSERVED_AT
    });
    expect(() =>
      store.recordDocumentationExchange({
        participantIngressSequence: apiIngress.participantIngressSequence,
        observedAt: OBSERVED_AT,
        method: "GET",
        pathRedacted: "/docs",
        responseStatus: 200,
        responseJson: {},
        eventJson: {}
      })
    ).toThrowError(/plane/);
    store.close();
  });
});

describe("blobs and export status", () => {
  it("registers either a public digest or a keyed secret tag", () => {
    const store = openStore(storePath());
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.registerBlob({
      blobId: "blob_0001",
      sha256: "1".repeat(64),
      bytes: 12,
      mediaType: "application/octet-stream",
      relativePath: "blobs/blob-0001.bin",
      sequence: request.sequence
    });
    store.registerBlob({
      blobId: "sec_0001",
      secretHmac: "2".repeat(64),
      bytes: 4,
      relativePath: "secrets/sec-0001.bin"
    });
    expect(() => {
      store.registerBlob({
        blobId: "bad_0001",
        sha256: "3".repeat(64),
        secretHmac: "4".repeat(64),
        bytes: 4,
        relativePath: "blobs/bad.bin"
      });
    }).toThrowError(/never both/);
    const raw = new DatabaseSync(storePath());
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM blobs").get()).toEqual({
        n: 2
      });
    } finally {
      raw.close();
    }
    store.close();
  });

  it("tracks export status per artifact", () => {
    const store = openStore(storePath());
    store.setExportStatus({
      artifact: "state.final.json",
      status: "pending",
      bytes: 0,
      updatedAt: OBSERVED_AT
    });
    store.setExportStatus({
      artifact: "state.final.json",
      status: "written",
      sha256: "5".repeat(64),
      bytes: 120,
      updatedAt: OBSERVED_AT
    });
    expect(store.getExportStatus("state.final.json")).toEqual({
      artifact: "state.final.json",
      status: "written",
      sha256: "5".repeat(64),
      bytes: 120,
      updatedAt: OBSERVED_AT
    });
    expect(store.getExportStatus("missing.json")).toBeNull();
    store.close();
  });
});

describe("transaction helper", () => {
  it("rolls back every write when the callback throws", () => {
    const store = openStore(storePath());
    try {
      store.transaction(() => {
        store.allocateIngress({ plane: "api", observedAt: OBSERVED_AT });
        throw new Error("controller aborted");
      });
    } catch {
      // Expected: the ingress row must not survive.
    }
    expect(store.countRequests()).toBe(0);
    const next = store.allocateIngress({
      plane: "api",
      observedAt: OBSERVED_AT
    });
    expect(next.participantIngressSequence).toBe(1);
    store.close();
  });

  it("closes idempotently and leaves a readable database", () => {
    const path = join(dir, "lifecycle.db");
    const store = openStore(path);
    store.allocateIngress({ plane: "api", observedAt: OBSERVED_AT });
    store.close();
    store.close();
    expect(store.isOpen).toBe(false);
    const raw = new DatabaseSync(path);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM participant_ingress").get()
      ).toEqual({ n: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("atomic request commit under an injected crash", () => {
  const IDENTITY = {
    operationKey: "path:POST /v1/computers",
    principalKey: "principal:primary-api-key",
    normalizedPath: "/v1/computers",
    idempotencyKey: "idem-0001"
  };
  const FINGERPRINT = '{"template":"system/chrome"}';

  /**
   * One request's full commit body: state, idempotency record, API
   * event, one semantic event, and the request terminal outcome. The
   * crash point names where the simulated crash fires.
   */
  function commitBody(
    store: StateStore,
    sequence: number,
    crashAt: "never" | "after idempotency" | "after events"
  ): void {
    store.putState({
      state: { computers: { comp_0001: { state: "running" } } },
      expectedRevision: null
    });
    store.putIdempotencyRecord({
      identity: IDENTITY,
      requestFingerprint: FINGERPRINT,
      response: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: { id: "comp_0001", state: "running" }
      },
      sequence,
      logicalTime: store.clock.now()
    });
    if (crashAt === "after idempotency") {
      throw new Error("simulated crash after the idempotency write");
    }
    const apiEvent = store.appendApiEvent({
      sequence,
      eventJson: { type: "api.exchange", sequence }
    });
    store.appendSemanticEvent({
      requestSequence: sequence,
      parentEventId: apiEvent.eventId,
      eventName: "computer.created",
      schemaVersion: 1,
      eventJson: { computer_id: "comp_0001" }
    });
    if (crashAt === "after events") {
      throw new Error("simulated crash after the event writes");
    }
    store.completeRequest(sequence, {
      operationKey: IDENTITY.operationKey,
      method: "POST",
      pathRedacted: "/v1/computers",
      terminalStatus: "committed",
      responseStatus: 201,
      committed: true
    });
  }

  function tableCounts(path: string): Record<string, number> {
    const raw = new DatabaseSync(path);
    try {
      const counts: Record<string, number> = {};
      for (const table of [
        "domain_state",
        "idempotency",
        "events",
        "semantic_events"
      ]) {
        const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        counts[table] = Number(row?.["n"]);
      }
      expect(integrityCheck(raw)).toBe(true);
      return counts;
    } finally {
      raw.close();
    }
  }

  it("commits every row of one request transaction", () => {
    const path = storePath();
    const store = openStore(path);
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    store.transaction(() => {
      commitBody(store, request.sequence, "never");
    });
    expect(tableCounts(path)).toEqual({
      domain_state: 1,
      idempotency: 1,
      events: 1,
      semantic_events: 1
    });
    const snapshot = store.getState();
    expect(snapshot?.revision).toBe(0);
    expect(store.getRequest(request.sequence)).toMatchObject({
      terminalStatus: "committed",
      responseStatus: 201,
      committed: true
    });
    expect(
      store.lookupIdempotency({
        identity: IDENTITY,
        requestFingerprint: FINGERPRINT
      })
    ).toMatchObject({ outcome: "replay" });
    store.close();
  });

  it("rolls back every row when a crash fires after the idempotency write", () => {
    const path = storePath();
    const store = openStore(path);
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    try {
      store.transaction(() => {
        commitBody(store, request.sequence, "after idempotency");
      });
      expect.unreachable("the injected crash must abort the transaction");
    } catch (error) {
      expect((error as Error).message).toContain("simulated crash");
    }
    expect(tableCounts(path)).toEqual({
      domain_state: 0,
      idempotency: 0,
      events: 0,
      semantic_events: 0
    });
    expect(store.getState()).toBeNull();
    expect(store.countIdempotencyEntries()).toBe(0);
    expect(store.eventLogBytes()).toBe(0);
    expect(store.getRequest(request.sequence)).toMatchObject({
      terminalStatus: "pending",
      committed: false
    });
    store.close();
  });

  it("rolls back every row when a crash fires after the event writes", () => {
    const path = storePath();
    const store = openStore(path);
    const request = store.beginRequest({ ingressObservedAt: OBSERVED_AT });
    try {
      store.transaction(() => {
        commitBody(store, request.sequence, "after events");
      });
      expect.unreachable("the injected crash must abort the transaction");
    } catch (error) {
      expect((error as Error).message).toContain("simulated crash");
    }
    expect(tableCounts(path)).toEqual({
      domain_state: 0,
      idempotency: 0,
      events: 0,
      semantic_events: 0
    });
    expect(store.getState()).toBeNull();
    expect(store.countIdempotencyEntries()).toBe(0);
    expect(store.eventLogBytes()).toBe(0);
    expect(store.getRequest(request.sequence)).toMatchObject({
      terminalStatus: "pending",
      committed: false
    });
    // The rolled-back sequence numbers are reusable: the next commit
    // starts from a clean slate.
    store.transaction(() => {
      commitBody(store, request.sequence, "never");
    });
    expect(tableCounts(path)).toEqual({
      domain_state: 1,
      idempotency: 1,
      events: 1,
      semantic_events: 1
    });
    store.close();
  });
});

describe("run identity verification", () => {
  const META: RunMetaInput = {
    batchId: "codex-baseline-01",
    contractSemanticSha256: "a".repeat(64),
    contractExecutionSha256: "b".repeat(64),
    sourceInventorySha256: "c".repeat(64),
    packSha256: "d".repeat(64),
    scenarioSha256: "e".repeat(64),
    contractVariantSha256: null,
    backendSha256: "f".repeat(64),
    implementationSha256: "9".repeat(64),
    seed: "0".repeat(64),
    stateSchemaVersion: 1,
    createdAt: "2026-08-27T12:00:00.000Z"
  };

  /** Digest of the database and its write-ahead log. */
  function snapshotFiles(path: string): string {
    const hash = createHash("sha256");
    for (const suffix of ["", "-wal"]) {
      try {
        hash.update(readFileSync(`${path}${suffix}`));
      } catch {
        hash.update(`<absent:${suffix}>`);
      }
    }
    return hash.digest("hex");
  }

  it("accepts a resume attempt with matching fingerprints", () => {
    const store = openStore(storePath());
    const record = store.initializeRun(META);
    expect(store.verifyRunIdentity(META)).toEqual(record);
    store.close();
  });

  it("refuses every fingerprint mismatch without modifying the database", () => {
    const path = storePath();
    const store = openStore(path);
    const record = store.initializeRun(META);
    // Warm one read so the snapshot covers a settled database.
    expect(store.getRunMeta()).toEqual(record);
    const before = snapshotFiles(path);
    const variants: Array<[string, RunMetaInput]> = [
      [
        "contract_semantic_sha256",
        { ...META, contractSemanticSha256: "0".repeat(64) }
      ],
      [
        "contract_execution_sha256",
        { ...META, contractExecutionSha256: "0".repeat(64) }
      ],
      [
        "source_inventory_sha256",
        { ...META, sourceInventorySha256: "0".repeat(64) }
      ],
      ["pack_sha256", { ...META, packSha256: "0".repeat(64) }],
      ["pack_sha256", { ...META, packSha256: null }],
      ["scenario_sha256", { ...META, scenarioSha256: "0".repeat(64) }],
      ["contract_variant_sha256", { ...META, contractVariantSha256: "1" }],
      ["backend_sha256", { ...META, backendSha256: "0".repeat(64) }],
      [
        "implementation_sha256",
        { ...META, implementationSha256: "8".repeat(64) }
      ],
      ["seed", { ...META, seed: "1".repeat(64) }],
      ["state_schema_version", { ...META, stateSchemaVersion: 2 }]
    ];
    for (const [field, variant] of variants) {
      try {
        store.verifyRunIdentity(variant);
        expect.unreachable(`a mismatch on ${field} must refuse the resume`);
      } catch (error) {
        expect(error).toBeInstanceOf(OalError);
        const oal = error as OalError;
        expect(oal.code).toBe("OAL-STATE-DIGEST-MISMATCH");
        expect(oal.exitCode).toBe(3);
        expect(oal.message).toContain(field);
      }
    }
    // Neither the bytes nor the logical run record changed.
    expect(snapshotFiles(path)).toBe(before);
    expect(store.getRunMeta()).toEqual(record);
    store.close();
  });

  it("refuses a resume attempt on an uninitialized database", () => {
    const store = openStore(storePath());
    try {
      store.verifyRunIdentity(META);
      expect.unreachable("an empty database cannot resume a run");
    } catch (error) {
      expect(error).toBeInstanceOf(OalError);
      expect((error as OalError).code).toBe("OAL-STATE-COMMIT-FAILED");
    }
    store.close();
  });
});
