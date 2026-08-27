import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  diagnostic,
  invalidInput,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import {
  replayRun,
  type ReplayContract,
  type ReplayDiagnostic,
  type ReplayEvidenceEvent,
  type ReplayResult
} from "@oal/report";
import { deriveTrialSeed } from "@oal/state-store";

import type { CommandArgs, CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

/** Stable diagnostic codes of the replay command (section 23.12). */
export const ReplayCliCode = {
  RunDirMissing: "OAL-REPLAY-RUN-DIR-MISSING",
  RunStartedMissing: "OAL-REPLAY-RUN-STARTED-MISSING",
  ContractMissing: "OAL-REPLAY-CONTRACT-MISSING",
  EvidenceUnreadable: "OAL-REPLAY-EVIDENCE-UNREADABLE",
  FrozenInputDrift: "OAL-REPLAY-FROZEN-INPUT-DRIFT"
} as const;

/** Frozen contract file of a batch, relative to the batch root. */
const CONTRACT_INPUT = "inputs/contract.ir.json";

/** How far above the run directory the batch root may sit. */
const MAX_BATCH_LEVELS = 3;

/** One run directory as the evidence store laid it out (section 24.1). */
interface RunTree {
  readonly started: JsonObject;
  readonly events: readonly ReplayEvidenceEvent[];
  readonly contract: ReplayContract;
  readonly contractFileSha256: string;
  readonly recordedContractFileSha256: string | null;
}

function requireSinglePositional(args: CommandArgs, name: string): string {
  const value = args.positionals[0];
  if (value === undefined) {
    throw missingArgument(args.command.name, name);
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  return value;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireObject(value: unknown, code: string, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(code, `${what} did not yield a JSON object.`);
  }
  return value as JsonObject;
}

/** Parse one JSONL evidence stream, keeping the line number in errors. */
function parseEvidenceStream(
  text: string,
  file: string
): ReplayEvidenceEvent[] {
  const events: ReplayEvidenceEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw invalidInput(
        ReplayCliCode.EvidenceUnreadable,
        `${file} line ${index + 1} is not valid JSON: ${describeCause(error)}.`
      );
    }
    const record = requireObject(
      parsed,
      ReplayCliCode.EvidenceUnreadable,
      `${file} line ${index + 1}`
    );
    if (typeof record["type"] !== "string") {
      throw invalidInput(
        ReplayCliCode.EvidenceUnreadable,
        `${file} line ${index + 1} carries no record type.`
      );
    }
    events.push(record as unknown as ReplayEvidenceEvent);
  }
  return events;
}

/** The nearest ancestor directory that holds the frozen batch inputs. */
async function findBatchDir(runDir: string): Promise<string | null> {
  let current = runDir;
  for (let level = 0; level < MAX_BATCH_LEVELS; level += 1) {
    if ((await readIfPresent(path.join(current, CONTRACT_INPUT))) !== null) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/** Digest the batch manifest recorded for one frozen input, when present. */
async function recordedInputDigest(
  batchDir: string,
  relativePath: string
): Promise<string | null> {
  const text = await readIfPresent(
    path.join(batchDir, "artifact-manifest.json")
  );
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = requireObject(
    parsed,
    ReplayCliCode.EvidenceUnreadable,
    "artifact-manifest.json"
  )["entries"];
  if (!Array.isArray(entries)) {
    return null;
  }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as JsonObject;
    if (candidate["path"] === relativePath) {
      const digest = candidate["sha256"];
      return typeof digest === "string" ? digest : null;
    }
  }
  return null;
}

/**
 * Load one run directory: the write-once start record, both evidence
 * streams, and the frozen contract of the owning batch.
 */
async function loadRunTree(runDir: string): Promise<RunTree> {
  const dirStat = await stat(runDir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory()) {
    throw invalidInput(
      ReplayCliCode.RunDirMissing,
      `Run directory "${runDir}" does not exist.`
    );
  }
  const startedPath = path.join(runDir, "run.started.json");
  const startedText = await readIfPresent(startedPath);
  if (startedText === null) {
    throw invalidInput(
      ReplayCliCode.RunStartedMissing,
      `Directory "${runDir}" holds no run.started.json, so it is not a run ` +
        "directory."
    );
  }
  let startedParsed: unknown;
  try {
    startedParsed = JSON.parse(startedText);
  } catch (error) {
    throw invalidInput(
      ReplayCliCode.RunStartedMissing,
      `${startedPath} is not valid JSON: ${describeCause(error)}.`
    );
  }
  const started = requireObject(
    startedParsed,
    ReplayCliCode.RunStartedMissing,
    "run.started.json"
  );

  const batchDir = await findBatchDir(runDir);
  if (batchDir === null) {
    throw invalidInput(
      ReplayCliCode.ContractMissing,
      `No batch inputs directory with ${CONTRACT_INPUT} sits above ` +
        `"${runDir}".`
    );
  }
  const contractText = await readIfPresent(path.join(batchDir, CONTRACT_INPUT));
  if (contractText === null) {
    throw invalidInput(
      ReplayCliCode.ContractMissing,
      `Frozen contract ${path.join(batchDir, CONTRACT_INPUT)} is missing.`
    );
  }
  let contractParsed: unknown;
  try {
    contractParsed = JSON.parse(contractText);
  } catch (error) {
    throw invalidInput(
      ReplayCliCode.ContractMissing,
      `${path.join(batchDir, CONTRACT_INPUT)} is not valid JSON: ` +
        `${describeCause(error)}.`
    );
  }
  const contractRecord = requireObject(
    contractParsed,
    ReplayCliCode.ContractMissing,
    CONTRACT_INPUT
  );
  if (
    contractRecord["kind"] !== "ContractIR" ||
    !Array.isArray(contractRecord["operations"])
  ) {
    throw invalidInput(
      ReplayCliCode.ContractMissing,
      "The frozen contract is not a ContractIR document."
    );
  }

  const events: ReplayEvidenceEvent[] = [];
  for (const stream of ["lifecycle.jsonl", "trace.jsonl"]) {
    const text = await readIfPresent(path.join(runDir, stream));
    if (text !== null) {
      events.push(...parseEvidenceStream(text, stream));
    }
  }

  return {
    started,
    events,
    contract: contractRecord as unknown as ReplayContract,
    contractFileSha256: sha256Hex(contractText),
    recordedContractFileSha256: await recordedInputDigest(
      batchDir,
      CONTRACT_INPUT
    )
  };
}

function startedString(started: JsonObject, key: string): string | null {
  const value = started[key];
  return typeof value === "string" ? value : null;
}

/**
 * The seed the run gateway used. The start record stores the run seed,
 * so the trial seed is derived again the way preflight derived it.
 */
function runSeedOf(tree: RunTree): string {
  const runSeed = startedString(tree.started, "run_seed");
  const runId = startedString(tree.started, "run_id");
  if (runSeed === null || runId === null) {
    throw invalidInput(
      ReplayCliCode.RunStartedMissing,
      "run.started.json holds no run_seed or run_id, so the replay seed " +
        "cannot be rebuilt."
    );
  }
  const index = tree.started["repetition_index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return runSeed;
  }
  return deriveTrialSeed(runSeed, { index, id: runId });
}

/** One engine replay finding in the normalized CLI diagnostic shape. */
function toCliDiagnostic(entry: ReplayDiagnostic): Diagnostic {
  return diagnostic({
    severity: entry.severity,
    phase: "report",
    code: entry.code,
    message: entry.message,
    details: { sequence: entry.sequence }
  });
}

/** Engine code of a gateway failure inside replay. */
const GATEWAY_ERROR_CODE = "replay.gateway_error";

/**
 * Exit status of one replay (section 23.18). A gateway failure is an
 * infrastructure defect; every other error means invalid input or
 * invalid evidence, which is status 2.
 */
export function replayExitCode(entries: readonly Diagnostic[]): ExitCode {
  const errors = entries.filter((entry) => entry.severity === "error");
  if (errors.some((entry) => entry.code === GATEWAY_ERROR_CODE)) {
    return EXIT_INFRASTRUCTURE;
  }
  return errors.length > 0 ? EXIT_INVALID : EXIT_OK;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Operator-readable lines of one replay. */
export function replaySummaryLines(result: ReplayResult): string[] {
  const counts = result.counts;
  const lines: string[] = [
    `run: ${result.run_id}`,
    `requests: ${counts.in_scope} in scope, ${counts.replayed} replayed, ` +
      `${counts.verified} verified, ${counts.mismatched} mismatched, ` +
      `${counts.skipped} skipped, ${counts.failed} failed`,
    `coverage: ${result.coverage}`,
    `full verification: ${yesNo(result.full_verification)}`
  ];
  for (const outcome of result.outcomes) {
    if (outcome.status === "verified") {
      continue;
    }
    const operation = outcome.operation === null ? "" : ` ${outcome.operation}`;
    const reason =
      outcome.reason_code === null ? "" : ` (${outcome.reason_code})`;
    lines.push(`${outcome.request_id}${operation}: ${outcome.status}${reason}`);
    for (const difference of outcome.differences) {
      const name = difference.name === null ? "" : ` ${difference.name}`;
      const recorded = difference.recorded ?? "<absent>";
      const observed = difference.observed ?? "<absent>";
      lines.push(
        `  ${difference.kind}${name}: recorded ${recorded}, observed ${observed}`
      );
    }
  }
  return lines;
}

/** `oal replay <run> [--request <sequence>] [--verify]` (section 23.12). */
export const replayCommand: CommandHandler = async (args, io) => {
  const runArgument = requireSinglePositional(args, "run");
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const request = args.flags.integer("request", {
    minimum: 1,
    maximum: 1_000_000
  });
  const verify = args.flags.has("verify");

  const tree = await loadRunTree(path.resolve(args.context.cwd, runArgument));
  const runId = startedString(tree.started, "run_id");
  if (runId === null) {
    throw invalidInput(
      ReplayCliCode.RunStartedMissing,
      "run.started.json holds no run_id, so the run cannot be identified."
    );
  }

  const findings: Diagnostic[] = [];
  if (
    tree.recordedContractFileSha256 !== null &&
    tree.recordedContractFileSha256 !== tree.contractFileSha256
  ) {
    findings.push(
      diagnostic({
        severity: "error",
        phase: "report",
        code: ReplayCliCode.FrozenInputDrift,
        message:
          "The frozen contract file no longer matches the digest the batch " +
          "artifact manifest recorded.",
        details: {
          expected: tree.recordedContractFileSha256,
          observed: tree.contractFileSha256
        }
      })
    );
  }

  const result = replayRun({
    runId,
    events: tree.events,
    contract: tree.contract,
    runSeed: runSeedOf(tree),
    limits: LIMIT_DEFAULTS,
    ...(request === undefined ? {} : { request }),
    verify
  });
  const diagnostics = [...findings, ...result.diagnostics.map(toCliDiagnostic)];
  emitDiagnostics(io, args.context, diagnostics);

  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(result as unknown as Json));
  } else {
    for (const line of replaySummaryLines(result)) {
      io.stderr(line);
    }
  }
  return replayExitCode(diagnostics);
};
