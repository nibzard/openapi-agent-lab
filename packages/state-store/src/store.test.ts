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
