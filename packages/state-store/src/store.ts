/**
 * Transactional state store (specification sections 17 and 38.1).
 *
 * One `StateStore` owns one private SQLite database for one run. Every write
 * runs inside `runInTransaction`, so a behavior result's response, next state,
 * idempotency record, API exchange, and semantic events commit together or not
 * at all.
 */

import {
  assertSafeId,
  canonicalJson,
  canonicalJsonSha256,
  jsonEquals,
  parseRfc3339,
  sha256Hex,
  type Json,
  type JsonObject
} from "@oal/core";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  createRunSecrets,
  generateDataEncryptionKey,
  type RunSecrets,
  type SealedValue
} from "./cipher.ts";
import { VirtualClock, type VirtualClockOptions } from "./clock.ts";
import {
  closeDatabase,
  openDatabase,
  runInTransaction,
  type JournalMode
} from "./database.ts";
import {
  limitReached,
  runIdentityMismatch,
  stateCommitFailed
} from "./errors.ts";
import { resolveStateStoreLimits, type StateStoreLimits } from "./limits.ts";
import {
  apiEventSequenceId,
  documentationExchangeSequenceId,
  nextSequence,
  participantIngressSequenceId,
  requestSequenceId,
  semanticEventSequenceId
} from "./sequences.ts";
import { applyMigrations } from "./schema.ts";

type Row = Record<string, SQLOutputValue>;

export type IngressPlane = "api" | "documentation";

export type RequestTerminalStatus =
  | "pending"
  | "committed"
  | "replayed"
  | "rejected"
  | "failed";

export type ExportArtifactStatus = "pending" | "written" | "failed";

export interface RunMetaInput {
  readonly batchId: string;
  readonly contractSemanticSha256: string;
  readonly contractExecutionSha256: string;
  readonly sourceInventorySha256: string;
  readonly packSha256?: string | null;
  readonly scenarioSha256?: string | null;
  readonly contractVariantSha256?: string | null;
  readonly backendSha256: string;
  readonly implementationSha256: string;
  readonly seed: string;
  readonly stateSchemaVersion: number;
  readonly createdAt: string;
}

export interface RunMetaRecord extends RunMetaInput {
  readonly runId: string;
}

export interface ParticipantIngressRecord {
  readonly participantIngressSequence: number;
  readonly ingressId: string;
  readonly plane: IngressPlane;
  readonly observedAt: string;
}

export interface RequestBeginInput {
  readonly participantIngressSequence?: number | null;
  readonly ingressObservedAt: string;
  readonly operationKey?: string | null;
  readonly method?: string | null;
  readonly pathRedacted?: string | null;
}

export interface RequestAllocation {
  readonly sequence: number;
  readonly requestId: string;
}

export interface RequestCompletion {
  readonly operationKey?: string | null;
  readonly method?: string | null;
  readonly pathRedacted?: string | null;
  readonly terminalStatus: RequestTerminalStatus;
  readonly responseStatus?: number | null;
  readonly committed: boolean;
}

export interface RequestRecord {
  readonly sequence: number;
  readonly requestId: string;
  readonly participantIngressSequence: number | null;
  readonly ingressObservedAt: string;
  readonly operationKey: string | null;
  readonly method: string | null;
  readonly pathRedacted: string | null;
  readonly terminalStatus: RequestTerminalStatus;
  readonly responseStatus: number | null;
  readonly committed: boolean;
}

export interface ApiEventInput {
  readonly sequence: number;
  readonly eventJson: Json;
  readonly eventId?: string;
}

export interface ApiEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly event: Json;
}

export interface SemanticEventInput {
  readonly requestSequence: number;
  readonly parentEventId?: string | null;
  readonly eventName: string;
  readonly schemaVersion: number;
  readonly eventJson: Json;
}

export interface SemanticEventRecord extends SemanticEventInput {
  readonly semanticSequence: number;
  readonly eventId: string;
}

export interface DocumentationExchangeInput {
  readonly participantIngressSequence?: number | null;
  readonly observedAt: string;
  readonly method: string;
  readonly pathRedacted: string;
  readonly responseStatus: number;
  readonly responseJson: Json;
  readonly eventJson: Json;
}

export interface DocumentationExchangeRecord {
  readonly documentationSequence: number;
  readonly exchangeId: string;
  readonly participantIngressSequence: number | null;
  readonly observedAt: string;
  readonly method: string;
  readonly pathRedacted: string;
  readonly responseStatus: number;
  readonly responseSha256: string;
  readonly event: Json;
}

export interface StateSnapshot {
  readonly revision: number;
  readonly logicalTime: string;
  readonly state: JsonObject;
  readonly evidenceDigest: string;
}

export interface StatePutInput {
  readonly state: JsonObject;
  /** Revision the caller read; null initializes the singleton row. */
  readonly expectedRevision: number | null;
  /** Redacted projection used for the exported evidence digest. */
  readonly projection?: Json;
}

export interface StateCommitResult {
  readonly revision: number;
  readonly changed: boolean;
  readonly logicalTime: string;
  readonly evidenceDigest: string;
}

export interface StoredResponse {
  readonly status: number;
  readonly headers: JsonObject;
  readonly body: Json | null;
}

export interface IdempotencyIdentity {
  readonly operationKey: string;
  readonly principalKey: string;
  readonly normalizedPath: string;
  readonly idempotencyKey: string;
}

export interface IdempotencyPolicyOptions {
  /** Per-run entry limit; defaults to `maxIdempotencyEntries`. */
  readonly maxEntries?: number;
  /** Virtual-time TTL in milliseconds; omitted or null means no expiry. */
  readonly ttlMs?: number | null;
  /** Status returned for a conflicting request body. Default 409. */
  readonly conflictStatus?: number;
}

export interface IdempotencyLookupInput {
  readonly identity: IdempotencyIdentity;
  /** Canonical JSON of the normalized request body used for conflict checks. */
  readonly requestFingerprint: string;
  readonly policy?: IdempotencyPolicyOptions;
  readonly nowMs?: number;
}

export type IdempotencyOutcome = "miss" | "replay" | "conflict" | "expired";

export interface IdempotencyLookupResult {
  readonly outcome: IdempotencyOutcome;
  /** Stored response for a replay; the conflict status for a conflict. */
  readonly response: StoredResponse | null;
  readonly conflictStatus: number | null;
}

export interface IdempotencyPutInput {
  readonly identity: IdempotencyIdentity;
  readonly requestFingerprint: string;
  readonly response: StoredResponse;
  readonly sequence: number;
  readonly logicalTime: string;
  readonly policy?: IdempotencyPolicyOptions;
  readonly nowMs?: number;
}

export interface BlobRegistration {
  readonly blobId: string;
  readonly sha256?: string | null;
  readonly secretHmac?: string | null;
  readonly bytes: number;
  readonly mediaType?: string | null;
  readonly relativePath: string;
  readonly sequence?: number | null;
}

export interface ExportStatusInput {
  readonly artifact: string;
  readonly status: ExportArtifactStatus;
  readonly sha256?: string | null;
  readonly bytes: number;
  readonly updatedAt: string;
}

export interface StateStoreOptions {
  /** File path or `:memory:`. Never share one database across runs. */
  readonly path: string;
  readonly runId: string;
  readonly limits?: Partial<StateStoreLimits>;
  /** 32-byte per-run key; generated when omitted and never persisted here. */
  readonly encryptionKey?: Uint8Array;
  readonly clock?: VirtualClock | VirtualClockOptions;
  readonly busyTimeoutMs?: number;
  readonly journalMode?: JournalMode;
  readonly readOnly?: boolean;
}

const encoder = new TextEncoder();

function column(row: Row, key: string): SQLOutputValue {
  const value = row[key];
  if (value === undefined) {
    throw new Error(`SQLite row is missing column ${JSON.stringify(key)}.`);
  }
  return value;
}

function requiredText(row: Row, key: string): string {
  const value = column(row, key);
  if (typeof value !== "string") {
    throw new Error(`Column ${JSON.stringify(key)} is not text.`);
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = column(row, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Column ${JSON.stringify(key)} is not text.`);
  }
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = column(row, key);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Column ${JSON.stringify(key)} is not an integer.`);
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = column(row, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Column ${JSON.stringify(key)} is not an integer.`);
  }
  return value;
}

function requiredBlob(row: Row, key: string): Uint8Array {
  const value = column(row, key);
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Column ${JSON.stringify(key)} is not a blob.`);
  }
  return value;
}

function parseJsonObject(text: string, what: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object.`);
  }
  return parsed as JsonObject;
}

function asJsonObject(value: Json | undefined, what: string): JsonObject {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${what} is not a JSON object.`);
  }
  return value;
}

function parseJson(text: string): Json {
  return JSON.parse(text) as Json;
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Private per-run SQLite source of truth. */
export class StateStore {
  readonly runId: string;
  readonly limits: StateStoreLimits;
  readonly clock: VirtualClock;
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly dataEncryptionKey: Uint8Array;
  private readonly db: DatabaseSync;
  private readonly secrets: RunSecrets;
  private closed = false;
  /**
   * Persisted event JSON bytes across the event tables, or null before
   * the first derivation. Maintained incrementally by the append
   * methods; invalidated whenever a transaction rolls back, because a
   * rollback can revert rows the total already counted.
   */
  private eventLogByteTotal: number | null = null;

  private constructor(options: StateStoreOptions) {
    const opened = openDatabase({
      path: options.path,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(options.journalMode === undefined
        ? {}
        : { journalMode: options.journalMode }),
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly })
    });
    this.db = opened.db;
    this.journalMode = opened.journalMode;
    this.runId = assertSafeId(options.runId, "runId");
    this.limits = resolveStateStoreLimits(options.limits);
    this.schemaVersion = applyMigrations(this.db);
    this.dataEncryptionKey =
      options.encryptionKey ?? generateDataEncryptionKey();
    this.secrets = createRunSecrets(this.dataEncryptionKey);
    this.clock =
      options.clock instanceof VirtualClock
        ? options.clock
        : new VirtualClock(options.clock);
  }

  static open(options: StateStoreOptions): StateStore {
    return new StateStore(options);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeDatabase(this.db);
  }

  /** Run `fn` in one transaction, rolling back when it throws. */
  transaction<T>(fn: () => T): T {
    try {
      return runInTransaction(this.db, fn);
    } catch (error) {
      // The rollback may have reverted event rows the running byte
      // total already counted, so forget the cached total; the next
      // read derives it from the tables again.
      this.eventLogByteTotal = null;
      throw error;
    }
  }

  // ---------------------------------------------------------------- run meta

  initializeRun(meta: RunMetaInput): RunMetaRecord {
    return this.transaction(() => {
      if (this.getRunMeta() !== null) {
        throw stateCommitFailed(`Run ${this.runId} is already initialized.`, {
          run_id: this.runId
        });
      }
      this.db
        .prepare(
          `INSERT INTO run_meta (
             run_id, batch_id, contract_semantic_sha256, contract_execution_sha256,
             source_inventory_sha256, pack_sha256, scenario_sha256,
             contract_variant_sha256, backend_sha256, implementation_sha256,
             seed, state_schema_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.runId,
          meta.batchId,
          meta.contractSemanticSha256,
          meta.contractExecutionSha256,
          meta.sourceInventorySha256,
          meta.packSha256 ?? null,
          meta.scenarioSha256 ?? null,
          meta.contractVariantSha256 ?? null,
          meta.backendSha256,
          meta.implementationSha256,
          meta.seed,
          meta.stateSchemaVersion,
          meta.createdAt
        );
      const record = this.getRunMeta();
      if (record === null) {
        throw stateCommitFailed(
          `Run metadata for ${this.runId} did not persist.`,
          { run_id: this.runId }
        );
      }
      return record;
    });
  }

  getRunMeta(): RunMetaRecord | null {
    const row = this.db.prepare("SELECT * FROM run_meta").get();
    if (row === undefined) {
      return null;
    }
    const record = row;
    return {
      runId: requiredText(record, "run_id"),
      batchId: requiredText(record, "batch_id"),
      contractSemanticSha256: requiredText(record, "contract_semantic_sha256"),
      contractExecutionSha256: requiredText(
        record,
        "contract_execution_sha256"
      ),
      sourceInventorySha256: requiredText(record, "source_inventory_sha256"),
      packSha256: nullableText(record, "pack_sha256"),
      scenarioSha256: nullableText(record, "scenario_sha256"),
      contractVariantSha256: nullableText(record, "contract_variant_sha256"),
      backendSha256: requiredText(record, "backend_sha256"),
      implementationSha256: requiredText(record, "implementation_sha256"),
      seed: requiredText(record, "seed"),
      stateSchemaVersion: requiredInteger(record, "state_schema_version"),
      createdAt: requiredText(record, "created_at")
    };
  }

  /**
   * Verify that this database belongs to the run described by `expected`
   * before it is resumed or attached. Restart is permitted only when the
   * contract semantic and execution digests, source inventory, pack,
   * scenario, contract variant, backend bundle, implementation, seed,
   * and state-schema version match (section 16.3). The check is
   * read-only: a refusal leaves every stored byte unchanged.
   */
  verifyRunIdentity(expected: RunMetaInput): RunMetaRecord {
    const record = this.getRunMeta();
    if (record === null) {
      throw stateCommitFailed(
        `Run ${this.runId} has no run record to resume or attach.`,
        { run_id: this.runId }
      );
    }
    const checks: Array<{
      field: string;
      expected: string | number | null;
      found: string | number | null;
    }> = [
      {
        field: "contract_semantic_sha256",
        expected: expected.contractSemanticSha256,
        found: record.contractSemanticSha256
      },
      {
        field: "contract_execution_sha256",
        expected: expected.contractExecutionSha256,
        found: record.contractExecutionSha256
      },
      {
        field: "source_inventory_sha256",
        expected: expected.sourceInventorySha256,
        found: record.sourceInventorySha256
      },
      {
        field: "pack_sha256",
        expected: expected.packSha256 ?? null,
        found: record.packSha256 ?? null
      },
      {
        field: "scenario_sha256",
        expected: expected.scenarioSha256 ?? null,
        found: record.scenarioSha256 ?? null
      },
      {
        field: "contract_variant_sha256",
        expected: expected.contractVariantSha256 ?? null,
        found: record.contractVariantSha256 ?? null
      },
      {
        field: "backend_sha256",
        expected: expected.backendSha256,
        found: record.backendSha256
      },
      {
        field: "implementation_sha256",
        expected: expected.implementationSha256,
        found: record.implementationSha256
      },
      { field: "seed", expected: expected.seed, found: record.seed },
      {
        field: "state_schema_version",
        expected: expected.stateSchemaVersion,
        found: record.stateSchemaVersion
      }
    ];
    for (const check of checks) {
      if (check.expected !== check.found) {
        throw runIdentityMismatch(check.field, check.expected, check.found);
      }
    }
    return record;
  }

  // ------------------------------------------------------------- ingress

  allocateIngress(input: {
    plane: IngressPlane;
    observedAt: string;
  }): ParticipantIngressRecord {
    return this.transaction(() => {
      const sequence = nextSequence(this.db, "participant_ingress");
      const ingressId = participantIngressSequenceId(sequence);
      this.db
        .prepare(
          `INSERT INTO participant_ingress (
             participant_ingress_sequence, ingress_id, plane, observed_at
           ) VALUES (?, ?, ?, ?)`
        )
        .run(sequence, ingressId, input.plane, input.observedAt);
      return {
        participantIngressSequence: sequence,
        ingressId,
        plane: input.plane,
        observedAt: input.observedAt
      };
    });
  }

  getIngress(sequence: number): ParticipantIngressRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM participant_ingress WHERE participant_ingress_sequence = ?"
      )
      .get(sequence);
    if (row === undefined) {
      return null;
    }
    return {
      participantIngressSequence: requiredInteger(
        row,
        "participant_ingress_sequence"
      ),
      ingressId: requiredText(row, "ingress_id"),
      plane: requiredText(row, "plane") as IngressPlane,
      observedAt: requiredText(row, "observed_at")
    };
  }

  // ------------------------------------------------------------- requests

  /** Allocate the next ingress sequence and its `req_` identifier. */
  beginRequest(input: RequestBeginInput): RequestAllocation {
    return this.transaction(() => {
      this.requireIngressPlane(input.participantIngressSequence, "api");
      const count = this.countRequests();
      if (count >= this.limits.maxRequestsPerRun) {
        throw limitReached(
          `Run ${this.runId} reached the request limit of ${this.limits.maxRequestsPerRun}.`,
          { requests: count, limit: this.limits.maxRequestsPerRun }
        );
      }
      const sequence = nextSequence(this.db, "requests");
      const requestId = requestSequenceId(sequence);
      this.db
        .prepare(
          `INSERT INTO requests (
             sequence, request_id, participant_ingress_sequence,
             ingress_observed_at, operation_key, method, path_redacted,
             terminal_status, response_status, committed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sequence,
          requestId,
          input.participantIngressSequence ?? null,
          input.ingressObservedAt,
          input.operationKey ?? null,
          input.method ?? null,
          input.pathRedacted ?? null,
          "pending",
          null,
          0
        );
      return { sequence, requestId };
    });
  }

  /**
   * Record the terminal outcome of a request. Each committed or replayed
   * request advances the virtual clock by one tick (section 17.4).
   */
  completeRequest(sequence: number, completion: RequestCompletion): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE requests
             SET operation_key = COALESCE(?, operation_key),
                 method = COALESCE(?, method),
                 path_redacted = COALESCE(?, path_redacted),
                 terminal_status = ?,
                 response_status = ?,
                 committed = ?
           WHERE sequence = ?`
        )
        .run(
          completion.operationKey ?? null,
          completion.method ?? null,
          completion.pathRedacted ?? null,
          completion.terminalStatus,
          completion.responseStatus ?? null,
          completion.committed ? 1 : 0,
          sequence
        );
      if (Number(result.changes) !== 1) {
        throw stateCommitFailed(
          `No request with sequence ${sequence} to complete.`,
          { sequence }
        );
      }
      if (completion.committed || completion.terminalStatus === "replayed") {
        this.clock.tick();
      }
    });
  }

  getRequest(sequence: number): RequestRecord | null {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE sequence = ?")
      .get(sequence);
    if (row === undefined) {
      return null;
    }
    return {
      sequence: requiredInteger(row, "sequence"),
      requestId: requiredText(row, "request_id"),
      participantIngressSequence: nullableInteger(
        row,
        "participant_ingress_sequence"
      ),
      ingressObservedAt: requiredText(row, "ingress_observed_at"),
      operationKey: nullableText(row, "operation_key"),
      method: nullableText(row, "method"),
      pathRedacted: nullableText(row, "path_redacted"),
      terminalStatus: requiredText(
        row,
        "terminal_status"
      ) as RequestTerminalStatus,
      responseStatus: nullableInteger(row, "response_status"),
      committed: requiredInteger(row, "committed") === 1
    };
  }

  countRequests(): number {
    return this.scalarInteger("SELECT COUNT(*) AS n FROM requests");
  }

  // --------------------------------------------------------------- events

  /** Append one normalized API event for an existing request sequence. */
  appendApiEvent(input: ApiEventInput): ApiEventRecord {
    return this.transaction(() => {
      const canonical = canonicalJson(input.eventJson);
      this.assertEventBudget(canonical);
      const eventId = input.eventId ?? apiEventSequenceId(input.sequence);
      this.db
        .prepare(
          `INSERT INTO events (sequence, event_id, event_json, event_sha256)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          input.sequence,
          eventId,
          canonical,
          canonicalJsonSha256(input.eventJson)
        );
      this.countEventAppend(canonical);
      return { sequence: input.sequence, eventId, event: input.eventJson };
    });
  }

  /** Append one schema-valid semantic event linked to a request. */
  appendSemanticEvent(input: SemanticEventInput): SemanticEventRecord {
    return this.transaction(() => {
      const canonical = canonicalJson(input.eventJson);
      this.assertEventBudget(canonical);
      const semanticSequence = nextSequence(this.db, "semantic_events");
      const eventId = semanticEventSequenceId(semanticSequence);
      this.db
        .prepare(
          `INSERT INTO semantic_events (
             semantic_sequence, event_id, request_sequence, parent_event_id,
             event_name, schema_version, event_json, event_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          semanticSequence,
          eventId,
          input.requestSequence,
          input.parentEventId ?? null,
          input.eventName,
          input.schemaVersion,
          canonical,
          canonicalJsonSha256(input.eventJson)
        );
      this.countEventAppend(canonical);
      return { ...input, semanticSequence, eventId };
    });
  }

  listSemanticEvents(requestSequence: number): SemanticEventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM semantic_events WHERE request_sequence = ? ORDER BY semantic_sequence"
      )
      .all(requestSequence);
    return rows.map((row) => ({
      semanticSequence: requiredInteger(row, "semantic_sequence"),
      eventId: requiredText(row, "event_id"),
      requestSequence: requiredInteger(row, "request_sequence"),
      parentEventId: nullableText(row, "parent_event_id"),
      eventName: requiredText(row, "event_name"),
      schemaVersion: requiredInteger(row, "schema_version"),
      eventJson: parseJson(requiredText(row, "event_json"))
    }));
  }

  /**
   * Record one documentation exchange in its own sequence and transaction
   * scope; it never reads or mutates domain state.
   */
  recordDocumentationExchange(
    input: DocumentationExchangeInput
  ): DocumentationExchangeRecord {
    return this.transaction(() => {
      this.requireIngressPlane(
        input.participantIngressSequence,
        "documentation"
      );
      const canonical = canonicalJson(input.eventJson);
      this.assertEventBudget(canonical);
      const sequence = nextSequence(this.db, "documentation_exchanges");
      const exchangeId = documentationExchangeSequenceId(sequence);
      this.db
        .prepare(
          `INSERT INTO documentation_exchanges (
             documentation_sequence, exchange_id, participant_ingress_sequence,
             observed_at, method, path_redacted, response_status,
             response_sha256, event_json, event_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sequence,
          exchangeId,
          input.participantIngressSequence ?? null,
          input.observedAt,
          input.method,
          input.pathRedacted,
          input.responseStatus,
          canonicalJsonSha256(input.responseJson),
          canonical,
          canonicalJsonSha256(input.eventJson)
        );
      this.countEventAppend(canonical);
      return {
        documentationSequence: sequence,
        exchangeId,
        participantIngressSequence: input.participantIngressSequence ?? null,
        observedAt: input.observedAt,
        method: input.method,
        pathRedacted: input.pathRedacted,
        responseStatus: input.responseStatus,
        responseSha256: canonicalJsonSha256(input.responseJson),
        event: input.eventJson
      };
    });
  }

  /**
   * Persisted event JSON bytes across all event tables. Derived from
   * the tables once, then advanced by each append, so N appends cost
   * O(N) instead of rescanning every stored row on every append.
   */
  eventLogBytes(): number {
    if (this.eventLogByteTotal === null) {
      this.eventLogByteTotal = this.sumEventJsonBytes();
    }
    return this.eventLogByteTotal;
  }

  /** Sum the stored event JSON bytes of the three event tables. */
  private sumEventJsonBytes(): number {
    return (
      this.scalarInteger(
        "SELECT COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0) AS n FROM events"
      ) +
      this.scalarInteger(
        "SELECT COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0) AS n FROM semantic_events"
      ) +
      this.scalarInteger(
        "SELECT COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0) AS n FROM documentation_exchanges"
      )
    );
  }

  /**
   * Fold one appended event into the running byte total. A null total
   * stays null: the next read derives it from the tables, which
   * already include the new row.
   */
  private countEventAppend(canonical: string): void {
    if (this.eventLogByteTotal !== null) {
      this.eventLogByteTotal += utf8Bytes(canonical);
    }
  }

  // ---------------------------------------------------------------- state

  /** Read the committed domain state, or null before initialization. */
  getState(): StateSnapshot | null {
    const current = this.readCurrentState();
    if (current === null) {
      return null;
    }
    return {
      revision: current.revision,
      logicalTime: current.logicalTime,
      state: current.state,
      evidenceDigest: current.evidenceDigest
    };
  }

  /**
   * Commit the next domain state with an optimistic revision check. The
   * revision increments only when the state actually changed (section 17.2).
   */
  putState(input: StatePutInput): StateCommitResult {
    return this.transaction(() => {
      const current = this.readCurrentState();
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== input.expectedRevision) {
        throw stateCommitFailed(
          `State revision is ${
            currentRevision === null ? "uninitialized" : currentRevision
          }, but the caller read ${
            input.expectedRevision === null
              ? "an uninitialized state"
              : `revision ${input.expectedRevision}`
          }.`,
          {
            expected_revision: input.expectedRevision,
            actual_revision: currentRevision
          }
        );
      }
      const canonical = canonicalJson(input.state);
      const plaintextBytes = utf8Bytes(canonical);
      if (plaintextBytes > this.limits.maxPersistedStateBytes) {
        throw limitReached(
          `Domain state of ${plaintextBytes} bytes exceeds the persisted-state limit of ${this.limits.maxPersistedStateBytes}.`,
          { bytes: plaintextBytes, limit: this.limits.maxPersistedStateBytes }
        );
      }
      const entries = Object.keys(input.state).length;
      if (entries > this.limits.maxDomainObjects) {
        throw limitReached(
          `Domain state holds ${entries} top-level objects, above the limit of ${this.limits.maxDomainObjects}.`,
          { objects: entries, limit: this.limits.maxDomainObjects }
        );
      }
      if (current !== null && jsonEquals(current.state, input.state)) {
        return {
          revision: current.revision,
          changed: false,
          logicalTime: current.logicalTime,
          evidenceDigest: current.evidenceDigest
        };
      }
      const revision = (currentRevision ?? -1) + 1;
      const logicalTime = this.clock.now();
      const sealed = this.secrets.sealText(canonical);
      const evidenceDigest = canonicalJsonSha256(
        input.projection ?? input.state
      );
      this.writeStateRow(sealed, revision, logicalTime, evidenceDigest);
      return { revision, changed: true, logicalTime, evidenceDigest };
    });
  }

  private writeStateRow(
    sealed: SealedValue,
    revision: number,
    logicalTime: string,
    evidenceDigest: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO domain_state (
           singleton, revision, logical_time, state_ciphertext, state_nonce,
           state_evidence_digest
         ) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           revision = excluded.revision,
           logical_time = excluded.logical_time,
           state_ciphertext = excluded.state_ciphertext,
           state_nonce = excluded.state_nonce,
           state_evidence_digest = excluded.state_evidence_digest`
      )
      .run(
        revision,
        logicalTime,
        sealed.ciphertext,
        sealed.nonce,
        evidenceDigest
      );
  }

  private readCurrentState(): {
    revision: number;
    logicalTime: string;
    state: JsonObject;
    evidenceDigest: string;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM domain_state WHERE singleton = 1")
      .get();
    if (row === undefined) {
      return null;
    }
    const plaintext = this.secrets.openText({
      ciphertext: requiredBlob(row, "state_ciphertext"),
      nonce: requiredBlob(row, "state_nonce")
    });
    return {
      revision: requiredInteger(row, "revision"),
      logicalTime: requiredText(row, "logical_time"),
      state: parseJsonObject(plaintext, "domain_state"),
      evidenceDigest: requiredText(row, "state_evidence_digest")
    };
  }

  // --------------------------------------------------------- idempotency

  /** Look up a stored idempotent response for one cache identity. */
  lookupIdempotency(input: IdempotencyLookupInput): IdempotencyLookupResult {
    return this.transaction(() => {
      const policy = input.policy ?? {};
      const conflictStatus = policy.conflictStatus ?? 409;
      const key = this.idempotencyKey(input.identity);
      const row = this.db
        .prepare(
          `SELECT request_hmac, response_ciphertext, response_nonce, created_sequence
             FROM idempotency
            WHERE operation_key = ? AND principal_key = ?
              AND normalized_path_sha256 = ? AND idempotency_key_hmac = ?`
        )
        .get(
          key.operationKey,
          key.principalKey,
          key.normalizedPathSha256,
          key.idempotencyKeyHmac
        );
      if (row === undefined) {
        return { outcome: "miss", response: null, conflictStatus: null };
      }
      const record = this.readStoredResponse({
        ciphertext: requiredBlob(row, "response_ciphertext"),
        nonce: requiredBlob(row, "response_nonce")
      });
      const ttlMs = policy.ttlMs ?? null;
      if (ttlMs !== null && input.nowMs !== undefined) {
        const expiresAt = parseRfc3339(record.logicalTime) + ttlMs;
        if (input.nowMs >= expiresAt) {
          this.db
            .prepare(
              `DELETE FROM idempotency
                WHERE operation_key = ? AND principal_key = ?
                  AND normalized_path_sha256 = ? AND idempotency_key_hmac = ?`
            )
            .run(
              key.operationKey,
              key.principalKey,
              key.normalizedPathSha256,
              key.idempotencyKeyHmac
            );
          return { outcome: "expired", response: null, conflictStatus: null };
        }
      }
      const requestHmac = requiredText(row, "request_hmac");
      if (requestHmac !== this.secrets.tag(input.requestFingerprint)) {
        return {
          outcome: "conflict",
          response: null,
          conflictStatus
        };
      }
      return {
        outcome: "replay",
        response: record.response,
        conflictStatus: null
      };
    });
  }

  /** Store one idempotent response and enforce the entry limit. */
  putIdempotencyRecord(input: IdempotencyPutInput): void {
    this.transaction(() => {
      const policy = input.policy ?? {};
      const key = this.idempotencyKey(input.identity);
      const record: JsonObject = {
        schema_version: 1,
        status: input.response.status,
        headers: input.response.headers,
        body: input.response.body,
        logical_time: input.logicalTime
      };
      const sealed = this.secrets.sealText(canonicalJson(record));
      this.db
        .prepare(
          `INSERT INTO idempotency (
             operation_key, principal_key, normalized_path_sha256,
             idempotency_key_hmac, request_hmac, response_ciphertext,
             response_nonce, created_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (
             operation_key, principal_key, normalized_path_sha256,
             idempotency_key_hmac
           ) DO UPDATE SET
             request_hmac = excluded.request_hmac,
             response_ciphertext = excluded.response_ciphertext,
             response_nonce = excluded.response_nonce,
             created_sequence = excluded.created_sequence`
        )
        .run(
          key.operationKey,
          key.principalKey,
          key.normalizedPathSha256,
          key.idempotencyKeyHmac,
          this.secrets.tag(input.requestFingerprint),
          sealed.ciphertext,
          sealed.nonce,
          input.sequence
        );
      this.evictIdempotency(policy, input.nowMs ?? this.clock.nowMs());
    });
  }

  countIdempotencyEntries(): number {
    return this.scalarInteger("SELECT COUNT(*) AS n FROM idempotency");
  }

  /**
   * Enforce the per-run entry limit. Removal order is expired entries first,
   * then the oldest committed sequence (section 17.3).
   */
  private evictIdempotency(
    policy: IdempotencyPolicyOptions,
    nowMs: number
  ): void {
    const maxEntries = policy.maxEntries ?? this.limits.maxIdempotencyEntries;
    const ttlMs = policy.ttlMs ?? null;
    const rows = this.db
      .prepare(
        `SELECT operation_key, principal_key, normalized_path_sha256,
                idempotency_key_hmac, response_ciphertext, response_nonce
           FROM idempotency
          ORDER BY created_sequence ASC`
      )
      .all();
    const expired: Row[] = [];
    const live: Row[] = [];
    for (const row of rows) {
      const expiredNow =
        ttlMs !== null &&
        nowMs >=
          parseRfc3339(
            this.readStoredResponse({
              ciphertext: requiredBlob(row, "response_ciphertext"),
              nonce: requiredBlob(row, "response_nonce")
            }).logicalTime
          ) +
            ttlMs;
      if (expiredNow) {
        expired.push(row);
      } else {
        live.push(row);
      }
    }
    const excess = Math.max(0, live.length - maxEntries);
    const removals = [...expired, ...live.slice(0, excess)];
    if (removals.length === 0) {
      return;
    }
    const remove = this.db.prepare(
      `DELETE FROM idempotency
        WHERE operation_key = ? AND principal_key = ?
          AND normalized_path_sha256 = ? AND idempotency_key_hmac = ?`
    );
    for (const row of removals) {
      remove.run(
        requiredText(row, "operation_key"),
        requiredText(row, "principal_key"),
        requiredText(row, "normalized_path_sha256"),
        requiredText(row, "idempotency_key_hmac")
      );
    }
  }

  private idempotencyKey(identity: IdempotencyIdentity): {
    operationKey: string;
    principalKey: string;
    normalizedPathSha256: string;
    idempotencyKeyHmac: string;
  } {
    return {
      operationKey: identity.operationKey,
      principalKey: identity.principalKey,
      normalizedPathSha256: sha256Hex(identity.normalizedPath),
      idempotencyKeyHmac: this.secrets.tag(identity.idempotencyKey)
    };
  }

  private readStoredResponse(sealed: SealedValue): {
    response: StoredResponse;
    logicalTime: string;
  } {
    const parsed = parseJsonObject(
      this.secrets.openText(sealed),
      "idempotency record"
    );
    const headers = parsed["headers"];
    const body = parsed["body"];
    const status = parsed["status"];
    const logicalTime = parsed["logical_time"];
    if (typeof status !== "number" || typeof logicalTime !== "string") {
      throw new Error("Idempotency record is missing status or logical time.");
    }
    return {
      response: {
        status,
        headers:
          headers === undefined || headers === null
            ? {}
            : asJsonObject(headers, "response headers"),
        body: body === undefined ? null : body
      },
      logicalTime
    };
  }

  // ---------------------------------------------------------------- blobs

  registerBlob(registration: BlobRegistration): void {
    const sha256 = registration.sha256 ?? null;
    const secretHmac = registration.secretHmac ?? null;
    if ((sha256 === null) === (secretHmac === null)) {
      throw new Error(
        "A blob registration sets either sha256 or secretHmac, never both."
      );
    }
    this.db
      .prepare(
        `INSERT INTO blobs (
           blob_id, sha256, secret_hmac, bytes, media_type, relative_path,
           created_sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        registration.blobId,
        sha256,
        secretHmac,
        registration.bytes,
        registration.mediaType ?? null,
        registration.relativePath,
        registration.sequence ?? null
      );
  }

  // -------------------------------------------------------- export status

  setExportStatus(status: ExportStatusInput): void {
    this.db
      .prepare(
        `INSERT INTO export_status (artifact, status, sha256, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(artifact) DO UPDATE SET
           status = excluded.status,
           sha256 = excluded.sha256,
           bytes = excluded.bytes,
           updated_at = excluded.updated_at`
      )
      .run(
        status.artifact,
        status.status,
        status.sha256 ?? null,
        status.bytes,
        status.updatedAt
      );
  }

  getExportStatus(artifact: string): ExportStatusInput | null {
    const row = this.db
      .prepare("SELECT * FROM export_status WHERE artifact = ?")
      .get(artifact);
    if (row === undefined) {
      return null;
    }
    return {
      artifact: requiredText(row, "artifact"),
      status: requiredText(row, "status") as ExportArtifactStatus,
      sha256: nullableText(row, "sha256"),
      bytes: requiredInteger(row, "bytes"),
      updatedAt: requiredText(row, "updated_at")
    };
  }

  // ------------------------------------------------------------- internals

  /** Verify plane linkage for a participant-owned transaction (section 38.1). */
  private requireIngressPlane(
    sequence: number | null | undefined,
    plane: IngressPlane
  ): void {
    if (sequence === undefined || sequence === null) {
      return;
    }
    const ingress = this.getIngress(sequence);
    if (ingress === null) {
      throw stateCommitFailed(
        `No participant ingress row with sequence ${sequence}.`,
        { participant_ingress_sequence: sequence }
      );
    }
    if (ingress.plane !== plane) {
      throw stateCommitFailed(
        `Participant ingress ${sequence} has plane ${ingress.plane}, expected ${plane}.`,
        {
          participant_ingress_sequence: sequence,
          plane: ingress.plane,
          expected: plane
        }
      );
    }
  }

  private assertEventBudget(canonical: string): void {
    const used = this.eventLogBytes();
    const next = used + utf8Bytes(canonical);
    if (next > this.limits.maxEventLogBytes) {
      throw limitReached(
        `Event log would reach ${next} bytes, above the limit of ${this.limits.maxEventLogBytes}.`,
        { bytes: next, limit: this.limits.maxEventLogBytes }
      );
    }
  }

  private scalarInteger(sql: string): number {
    const row = this.db.prepare(sql).get();
    const value = row === undefined ? undefined : row["n"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`Query did not return a nonnegative integer: ${sql}`);
    }
    return value;
  }
}
