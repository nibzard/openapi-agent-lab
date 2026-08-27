/**
 * SQLite schema migrations (specification sections 17.1 and 38.1).
 *
 * Migrations run only before the listener starts, never during evidence
 * replay. A database written by a newer build is rejected instead of migrated
 * downwards.
 */

import type { DatabaseSync } from "node:sqlite";

import { runInTransaction } from "./database.ts";
import { schemaVersionUnsupported } from "./errors.ts";

/** Highest schema version this build understands. */
export const SCHEMA_VERSION = 1;

export interface Migration {
  /** Schema version after this migration applies. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const V1 = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE run_meta (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  contract_semantic_sha256 TEXT NOT NULL,
  contract_execution_sha256 TEXT NOT NULL,
  source_inventory_sha256 TEXT NOT NULL,
  pack_sha256 TEXT,
  scenario_sha256 TEXT,
  contract_variant_sha256 TEXT,
  backend_sha256 TEXT NOT NULL,
  implementation_sha256 TEXT NOT NULL,
  seed TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE participant_ingress (
  participant_ingress_sequence INTEGER PRIMARY KEY,
  ingress_id TEXT NOT NULL UNIQUE,
  plane TEXT NOT NULL CHECK (plane IN ('api', 'documentation')),
  observed_at TEXT NOT NULL
);

CREATE TABLE domain_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  logical_time TEXT NOT NULL,
  state_ciphertext BLOB NOT NULL,
  state_nonce BLOB NOT NULL,
  state_evidence_digest TEXT NOT NULL
);

CREATE TABLE requests (
  sequence INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  participant_ingress_sequence INTEGER UNIQUE
    REFERENCES participant_ingress(participant_ingress_sequence),
  ingress_observed_at TEXT NOT NULL,
  operation_key TEXT,
  method TEXT,
  path_redacted TEXT,
  terminal_status TEXT NOT NULL,
  response_status INTEGER,
  committed INTEGER NOT NULL CHECK (committed IN (0, 1))
);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY REFERENCES requests(sequence),
  event_id TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE TABLE semantic_events (
  semantic_sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  request_sequence INTEGER NOT NULL REFERENCES requests(sequence),
  parent_event_id TEXT,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE INDEX semantic_events_request
  ON semantic_events(request_sequence, semantic_sequence);

CREATE TABLE documentation_exchanges (
  documentation_sequence INTEGER PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE,
  participant_ingress_sequence INTEGER UNIQUE
    REFERENCES participant_ingress(participant_ingress_sequence),
  observed_at TEXT NOT NULL,
  method TEXT NOT NULL,
  path_redacted TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_sha256 TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE TABLE idempotency (
  operation_key TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  normalized_path_sha256 TEXT NOT NULL,
  idempotency_key_hmac TEXT NOT NULL,
  request_hmac TEXT NOT NULL,
  response_ciphertext BLOB NOT NULL,
  response_nonce BLOB NOT NULL,
  created_sequence INTEGER NOT NULL,
  PRIMARY KEY (
    operation_key,
    principal_key,
    normalized_path_sha256,
    idempotency_key_hmac
  )
);

CREATE TABLE blobs (
  blob_id TEXT PRIMARY KEY,
  sha256 TEXT,
  secret_hmac TEXT,
  bytes INTEGER NOT NULL,
  media_type TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  created_sequence INTEGER,
  CHECK (
    (sha256 IS NOT NULL AND secret_hmac IS NULL)
    OR
    (sha256 IS NULL AND secret_hmac IS NOT NULL)
  )
);

CREATE TABLE export_status (
  artifact TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'written', 'failed')),
  sha256 TEXT,
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Ordered migrations. The `export_status` table is required by section 17.1
 * but has no column list in section 38.1; version 1 uses the shape below.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "state-store-v1", sql: V1 }
];

export const SCHEMA_META_VERSION_KEY = "schema_version";

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

/** Read the persisted schema version, or null for an empty database. */
export function readSchemaVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, "schema_meta")) {
    return null;
  }
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(SCHEMA_META_VERSION_KEY);
  if (row === undefined) {
    return null;
  }
  const value = row["value"];
  if (typeof value !== "string") {
    throw new Error("schema_meta.schema_version is not a text value.");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `schema_meta.schema_version is not a positive integer: ${JSON.stringify(value)}.`
    );
  }
  return parsed;
}

/**
 * Apply pending migrations inside one transaction. Opening an already migrated
 * database is a no-op. A newer stored version is rejected.
 */
export function applyMigrations(db: DatabaseSync): number {
  const current = readSchemaVersion(db);
  if (current !== null && current > SCHEMA_VERSION) {
    throw schemaVersionUnsupported(current, SCHEMA_VERSION);
  }
  const floor = current ?? 0;
  const pending = MIGRATIONS.filter((migration) => migration.version > floor);
  if (pending.length === 0) {
    return floor;
  }
  return runInTransaction(db, () => {
    for (const migration of pending) {
      db.exec(migration.sql);
      const upsert = db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      upsert.run(`migration:${migration.version.toString(10)}`, migration.name);
    }
    const setVersion = db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    const target = pending[pending.length - 1]?.version ?? floor;
    setVersion.run(SCHEMA_META_VERSION_KEY, target.toString(10));
    return target;
  });
}

/** Names of every table version 1 creates; used by integrity checks. */
export const STATE_STORE_TABLES: readonly string[] = [
  "schema_meta",
  "run_meta",
  "participant_ingress",
  "domain_state",
  "requests",
  "events",
  "semantic_events",
  "documentation_exchanges",
  "idempotency",
  "blobs",
  "export_status"
];
