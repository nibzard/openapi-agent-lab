/**
 * Ingress and event sequence allocation (specification sections 17.1 and 25).
 *
 * Sequences are per run and monotonically increasing. Allocation reads
 * `MAX(column) + 1` inside an immediate write transaction, so concurrent
 * allocations serialize on the write lock and never hand out the same value.
 */

import { sequenceId } from "@oal/core";
import type { DatabaseSync } from "node:sqlite";

import { runInTransaction } from "./database.ts";

/** Tables with an allocatable integer primary-key sequence. */
export type SequenceTable =
  | "requests"
  | "participant_ingress"
  | "semantic_events"
  | "documentation_exchanges";

const SEQUENCE_COLUMNS: Readonly<Record<SequenceTable, string>> = {
  requests: "sequence",
  participant_ingress: "participant_ingress_sequence",
  semantic_events: "semantic_sequence",
  documentation_exchanges: "documentation_sequence"
};

/** `req_00000001` style request ID. */
export function requestSequenceId(sequence: number): string {
  return sequenceId("req", sequence);
}

/** `evt_00000001` style API-event ID. */
export function apiEventSequenceId(sequence: number): string {
  return sequenceId("evt", sequence);
}

/** `sem_00000001` style semantic-event ID. */
export function semanticEventSequenceId(sequence: number): string {
  return sequenceId("sem", sequence);
}

/** `ing_00000001` style participant-ingress ID. */
export function participantIngressSequenceId(sequence: number): string {
  return sequenceId("ing", sequence);
}

/** `doc_00000001` style documentation-exchange ID. */
export function documentationExchangeSequenceId(sequence: number): string {
  return sequenceId("doc", sequence);
}

/**
 * Allocate the next sequence for one table. Joins the caller's transaction
 * when one is active and otherwise opens its own.
 */
export function nextSequence(db: DatabaseSync, table: SequenceTable): number {
  return runInTransaction(db, () => {
    const column = SEQUENCE_COLUMNS[table];
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(${column}), 0) + 1 AS next FROM ${table}`
      )
      .get();
    const next = row === undefined ? undefined : row["next"];
    if (typeof next !== "number" || !Number.isInteger(next) || next < 1) {
      throw new Error(`Sequence allocation for ${table} failed.`);
    }
    return next;
  });
}
