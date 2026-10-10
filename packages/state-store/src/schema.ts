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
export const SCHEMA_VERSION = 4;

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
 * Version 2 adds the world identity a checkpoint exports and the
 * plaintext idempotency identities a fork re-tags under its own key
 * (section 48.4). The sidecar cascades with its parent row. Databases
 * written at version 1 gain both tables before any listener starts.
 */
const V2 = `
CREATE TABLE world_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  world_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  origin_checkpoint_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_identity (
  operation_key TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  normalized_path_sha256 TEXT NOT NULL,
  idempotency_key_hmac TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  PRIMARY KEY (
    operation_key,
    principal_key,
    normalized_path_sha256,
    idempotency_key_hmac
  ),
  FOREIGN KEY (
    operation_key, principal_key, normalized_path_sha256, idempotency_key_hmac
  ) REFERENCES idempotency (
    operation_key, principal_key, normalized_path_sha256, idempotency_key_hmac
  ) ON DELETE CASCADE
);
`;

/**
 * Version 3 records operator control results. A repeated control id
 * replays its recorded result and a changed payload conflicts, across
 * generations (section 48.3).
 */
const V3 = `
CREATE TABLE control_results (
  control_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  control_sequence INTEGER NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  virtual_time TEXT NOT NULL,
  status INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Version 4 persists the fault engine and separates delivery evidence
 * from the committed response candidate (section 48.6): the fault
 * counters and stream position survive restarts and forks, every
 * consumption is its own durable row, and a delivery outcome is
 * written only once the transport settles. No delivery row means
 * delivery is unknown, never delivered.
 */
const V4 = `
CREATE TABLE fault_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  counters_json TEXT NOT NULL,
  prng_state TEXT NOT NULL
);

CREATE TABLE fault_consumptions (
  sequence INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  phase TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE delivery (
  sequence INTEGER PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'lost')),
  recorded_at TEXT NOT NULL
);
`;

/**
 * Ordered migrations. The `export_status` table is required by section 17.1
 * but has no column list in section 38.1; version 1 uses the shape below.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "state-store-v1", sql: V1 },
  { version: 2, name: "world-state-v2", sql: V2 },
  { version: 3, name: "control-results-v3", sql: V3 },
  { version: 4, name: "faults-and-delivery-v4", sql: V4 }
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

/** Names of every table the migrations create; used by integrity checks. */
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
  "export_status",
  "world_state",
  "idempotency_identity",
  "control_results"
];
