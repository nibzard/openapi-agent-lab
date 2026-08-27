/**
 * Database opening and the transaction helper (specification sections 17.1
 * and 38.1).
 *
 * One private SQLite database per run: WAL journal, NORMAL synchronization,
 * foreign keys enforced, bounded busy timeout. Every write goes through
 * `runInTransaction`, which rolls back when the callback throws.
 */

import { DatabaseSync } from "node:sqlite";

export type JournalMode = "wal" | "delete" | "truncate" | "persist" | "memory";

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for a private in-memory database. */
  readonly path: string;
  /** Bounded busy timeout in milliseconds. Default 5,000. */
  readonly busyTimeoutMs?: number;
  /** Journal mode requested before migrations run. Default WAL. */
  readonly journalMode?: JournalMode;
  /** Opened for reading only; no migrations or writes are allowed. */
  readonly readOnly?: boolean;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** Journal mode SQLite actually selected; WAL can fall back. */
  readonly journalMode: string;
  readonly foreignKeysEnabled: boolean;
  readonly busyTimeoutMs: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function pragma(db: DatabaseSync, sql: string): string {
  const row = db.prepare(sql).get();
  const values = Object.values(row ?? {});
  return values.length === 0 ? "" : String(values[0]);
}

/**
 * Open a private per-run database and apply the required pragmas. In-memory
 * databases cannot use WAL, so they fall back to `memory` and the fallback is
 * reported to the caller for the run record.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const requested =
    options.journalMode ?? (options.path === ":memory:" ? "memory" : "wal");
  const db = new DatabaseSync(options.path, {
    enableForeignKeyConstraints: true,
    readOnly: options.readOnly === true,
    timeout: busyTimeoutMs
  });
  const journalMode = pragma(db, `PRAGMA journal_mode = ${requested}`);
  db.exec(`PRAGMA synchronous = NORMAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs.toString(10)}`);
  return {
    db,
    journalMode,
    foreignKeysEnabled: pragma(db, "PRAGMA foreign_keys") === "1",
    busyTimeoutMs
  };
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE` transaction. The immediate write lock
 * makes read-modify-write sequences such as sequence allocation race-free.
 * Rethrows whatever `fn` threw after rolling back.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    return fn();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction already ended; the original error matters more.
    }
    throw error;
  }
}

/** Close the database, ignoring an already closed handle. */
export function closeDatabase(db: DatabaseSync): void {
  if (db.isOpen) {
    db.close();
  }
}

/** Report whether the database passes its internal consistency check. */
export function integrityCheck(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA integrity_check").get();
  const value = row === undefined ? undefined : row["integrity_check"];
  return value === "ok";
}
