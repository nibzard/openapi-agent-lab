/**
 * `oal world` commands. `world inspect` reads one world at rest: it
 * opens the control directory's sealed database read-only and
 * projects the world identity, the committed revision, and the
 * recorded operator controls. It reads no credentials and starts no
 * listener (specification section 48.3).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import path from "node:path";

import {
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  isJsonObject,
  sha256Hex,
  stableJsonStringify,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";

import { emitDiagnostics } from "../diagnostics.ts";
import { invalidOptionValue, missingArgument } from "../usage.ts";
import type { CommandArgs } from "../commands.ts";
import type { Io } from "../io.ts";
import {
  awaitInterruption,
  exportScenarioEvidence,
  finalizeServeControl,
  startForkServe
} from "./serve.ts";
import {
  EnvironmentError,
  readCheckpoint,
  type Environment
} from "@oal/environment";
import { deriveManualRunSeed } from "@oal/state-store";
import { closeSchemaWorker } from "@oal/core";

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

/** One request against a world's operator socket. */
function controlRequest(
  socketPath: string,
  method: string,
  target: string,
  options: { readonly body?: Json; readonly credential: string }
): Promise<{ status: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? "" : JSON.stringify(options.body);
    const outgoing = request(
      {
        socketPath,
        path: target,
        method,
        headers: {
          authorization: `Bearer ${options.credential}`,
          ...(text.length === 0
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text).toString(10)
              })
        }
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const parsed = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as JsonObject;
          resolve({ status: incoming.statusCode ?? 0, body: parsed });
        });
      }
    );
    outgoing.on("error", reject);
    if (text.length > 0) {
      outgoing.write(text);
    }
    outgoing.end();
  });
}

/** The first diagnostic code of one control envelope. */
function envelopeCode(body: JsonObject): string {
  const diagnostics = body["diagnostics"];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return "";
  }
  const first = diagnostics[0];
  if (isJsonObject(first) && typeof first["code"] === "string") {
    return first["code"];
  }
  return "";
}

/** `oal world checkpoint --world DIR --out DIR`: drive the live socket. */
export async function worldCheckpointCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const worldFlag = args.flags.string("world");
  if (typeof worldFlag !== "string" || worldFlag.length === 0) {
    throw missingArgument(args.command.name, "--world");
  }
  const outFlag = args.flags.string("out");
  if (typeof outFlag !== "string" || outFlag.length === 0) {
    throw missingArgument(args.command.name, "--out");
  }
  const worldDir = path.resolve(args.context.cwd, worldFlag);
  const operatorDir = path.join(worldDir, "operator");
  const credential = (
    await readFile(path.join(operatorDir, "operator-credential"), "utf8").catch(
      () => null
    )
  )?.trim();
  if (credential === undefined) {
    io.stderr(
      `No operator credential under ${operatorDir}; only a running world accepts checkpoints.`
    );
    return EXIT_UNSUPPORTED;
  }
  const answer = await controlRequest(
    path.join(operatorDir, "control.sock"),
    "POST",
    "/v1/checkpoints",
    {
      credential,
      body: {
        control_id: `cli-${randomBytes(8).toString("hex")}`,
        out: path.resolve(args.context.cwd, outFlag)
      }
    }
  );
  io.stdout(stableJsonStringify(answer.body as unknown as Json));
  if (answer.status === 200) {
    return EXIT_OK;
  }
  emitDiagnostics(io, args.context, [
    diagnostic({
      severity: "error",
      phase: "preflight",
      code: envelopeCode(answer.body) || "OAL-WORLD-CONTROL-FAILED",
      message: `The checkpoint control answered HTTP ${answer.status.toString(10)}.`
    })
  ]);
  return answer.status >= 500 ? EXIT_UNSUPPORTED : EXIT_INVALID;
}

/** `oal world fork CHECKPOINT_DIR --out NEW_DIR --port N`. */
export async function worldForkCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const source = args.positionals[0];
  if (source === undefined) {
    throw missingArgument(args.command.name, "checkpoint");
  }
  const outFlag = args.flags.string("out");
  if (typeof outFlag !== "string" || outFlag.length === 0) {
    throw missingArgument(args.command.name, "--out");
  }
  const portFlag = args.flags.string("port");
  const port = portFlag === undefined ? 0 : Number.parseInt(portFlag, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalidOptionValue("--port", portFlag ?? "", "a TCP port number");
  }
  const checkpointDir = path.resolve(args.context.cwd, source);
  const worldDir = path.resolve(args.context.cwd, outFlag);
  const checkpoint = await readCheckpoint(checkpointDir).catch(
    (cause: unknown) => {
      if (cause instanceof EnvironmentError) {
        emitDiagnostics(io, args.context, [
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: cause.code,
            message: cause.message
          })
        ]);
        return null;
      }
      throw cause;
    }
  );
  if (checkpoint === null) {
    return EXIT_UNSUPPORTED;
  }
  const existing = await stat(worldDir).catch(() => null);
  if (existing !== null) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: "OAL-ARTIFACT-EXISTS",
        message: `Fork output directory ${worldDir} already exists; a fork never replaces a world.`
      })
    ]);
    return EXIT_INVALID;
  }
  await mkdir(worldDir, { recursive: true });
  const evidenceDir = path.join(worldDir, "evidence");
  const runId = `fork-${defaultForkId(new Date())}`;
  const runSeed = deriveManualRunSeed({
    runId,
    contractExecutionSha256:
      checkpoint.document.frozen.contract_execution_sha256,
    packSha256: checkpoint.document.frozen.pack_sha256,
    scenarioSha256: sha256Hex(checkpoint.document.frozen.scenario_id),
    backendSha256: checkpoint.document.frozen.behavior_sha256
  });
  const { openRestoredEnvironment } = await import("@oal/environment");
  let environment: Environment;
  try {
    environment = await openRestoredEnvironment({
      checkpoint,
      worldId: runId,
      databasePath: path.join(worldDir, "world.sqlite"),
      batchId: "fork",
      now: (): number => Date.now()
    });
  } catch (cause) {
    const code =
      cause instanceof EnvironmentError
        ? cause.code
        : "OAL-SCENARIO-INITIALIZE-FAILED";
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  const session = await startForkServe({
    environment,
    contract: checkpoint.contractIr as never,
    worldDir,
    evidenceDir,
    runId,
    runSeed,
    host: "127.0.0.1",
    port
  });
  io.stdout(stableJsonStringify(session.readiness));
  await awaitInterruption(args.context.abortSignal);
  await exportScenarioEvidence(environment, evidenceDir);
  await finalizeServeControl(worldDir);
  await session.handle.close();
  await session.control?.close();
  await environment.close();
  session.store.close();
  closeSchemaWorker();
  return EXIT_OK;
}

/** Timestamped fork identity, in the manual run id style. */
function defaultForkId(at: Date): string {
  const pad = (value: number, width = 2): string =>
    value.toString(10).padStart(width, "0");
  return [
    at.getUTCFullYear().toString(10),
    pad(at.getUTCMonth() + 1),
    pad(at.getUTCDate()),
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(
      at.getUTCSeconds()
    )}`
  ].join("");
}
