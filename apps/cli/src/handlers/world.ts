/**
 * `oal world` commands. `world inspect` reads one world at rest: it
 * opens the control directory's sealed database read-only and
 * projects the world identity, the committed revision, and the
 * recorded operator controls. It reads no credentials and starts no
 * listener (specification section 48.3).
 */

import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  EXIT_OK,
  stableJsonStringify,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";

import { invalidOptionValue, missingArgument } from "../usage.ts";
import type { CommandArgs } from "../commands.ts";
import type { Io } from "../io.ts";

/** One row of the world projection. */
function textOf(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Column ${JSON.stringify(key)} is not text.`);
  }
  return value;
}

/** Inspect one world directory and print its redacted projection. */
export async function worldInspectCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const worldFlag = args.flags.string("world");
  if (typeof worldFlag !== "string" || worldFlag.length === 0) {
    throw missingArgument(args.command.name, "--world");
  }
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const worldDir = path.resolve(args.context.cwd, worldFlag);
  const databasePath = path.join(worldDir, "world.sqlite");
  const databaseStat = await stat(databasePath).catch(() => null);
  if (databaseStat === null || !databaseStat.isFile()) {
    io.stderr(
      `No world database at ${databasePath}; pass the control directory of a served world.`
    );
    io.stderr("Expected a directory holding world.sqlite.");
    return 2;
  }

  const document = projectWorld(databasePath);
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(document as unknown as Json));
    return EXIT_OK;
  }
  io.stdout(`World ${label(document, "world_id")}`);
  io.stdout(`  Generation:    ${label(document, "generation")}`);
  io.stdout(`  Revision:      ${label(document, "revision")}`);
  io.stdout(`  Logical time:  ${label(document, "logical_time")}`);
  io.stdout(`  Requests:      ${label(document, "request_count")}`);
  io.stdout(`  Controls:      ${label(document, "control_count")}`);
  const origin = document["origin_checkpoint_id"];
  io.stdout(
    `  Origin:        ${
      typeof origin === "string" ? origin : "created, not forked"
    }`
  );
  for (const control of document["controls"] as JsonObject[]) {
    io.stdout(
      `  Control ${label(control, "control_id")} ${label(control, "route")}` +
        ` order ${label(control, "order")}` +
        ` generation ${label(control, "generation")}` +
        ` revision ${label(control, "revision")}`
    );
  }
  return EXIT_OK;
}

/** Read the sealed database and project the world without keys. */
function projectWorld(databasePath: string): JsonObject {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const worldRow = db
      .prepare("SELECT * FROM world_state WHERE singleton = 1")
      .get();
    const stateRow = db
      .prepare(
        "SELECT revision, logical_time FROM domain_state WHERE singleton = 1"
      )
      .get();
    const requestCount = countOf(db, "SELECT COUNT(*) AS n FROM requests");
    const controlRows = db
      .prepare(
        `SELECT control_id, route, control_sequence, generation, revision,
                virtual_time, created_at
           FROM control_results ORDER BY control_sequence ASC`
      )
      .all();
    const world = rowOf(worldRow);
    const state = rowOf(stateRow);
    const controls: JsonObject[] = controlRows.map((row) => {
      const record = rowOf(row);
      return {
        control_id: textOf(record, "control_id"),
        route: textOf(record, "route"),
        order: numberOr(record["control_sequence"], 0),
        generation: numberOr(record["generation"], 1),
        revision: numberOr(record["revision"], 0),
        virtual_time: textOrNull(record["virtual_time"]),
        created_at: textOrNull(record["created_at"])
      };
    });
    return {
      schema_version: 1,
      kind: "WorldInspection",
      world_id: textOf(world, "world_id"),
      generation: numberOr(world["generation"], 1),
      revision: numberOr(state["revision"], 0),
      logical_time: textOrNull(state["logical_time"]),
      origin_checkpoint_id: textOrNull(world["origin_checkpoint_id"]),
      created_at: textOrNull(world["created_at"]),
      request_count: requestCount,
      control_count: controls.length,
      controls
    };
  } finally {
    db.close();
  }
}

/** One sqlite row as a plain record. */
function rowOf(row: unknown): Record<string, unknown> {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : {};
}

/** One numeric column, or the fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** One text column, or null. */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One projection field as display text. */
function label(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return "none";
  }
  if (typeof value === "string" || typeof value === "number") {
    return value.toString(10);
  }
  return JSON.stringify(value);
}

function countOf(db: DatabaseSync, sql: string): number {
  const value = rowOf(db.prepare(sql).get())["n"];
  return typeof value === "number" ? value : 0;
}
