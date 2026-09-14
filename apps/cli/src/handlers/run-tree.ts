/**
 * Run and batch directory loading shared by the evaluate, report, compare,
 * workflow, and study analyze commands. Every reader is read-only: the
 * commands never mutate recorded evidence.
 */

import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  invalidInput,
  isJsonObject,
  isSafeId,
  isSafeRelativePath,
  sha256HexBytes,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  ArtifactStore,
  type DocumentationExchange,
  type LifecycleEvent,
  type TraceEvent
} from "@oal/evidence";
import type { Evaluation } from "@oal/evaluator";

/** Stable diagnostic codes of the run-tree readers. */
export const RunTreeCode = {
  NotRunOrBatch: "OAL-RUNTREE-NOT-RUN-OR-BATCH",
  NotBatch: "OAL-RUNTREE-NOT-BATCH",
  NotRun: "OAL-RUNTREE-NOT-RUN",
  NotSession: "OAL-RUNTREE-NOT-SESSION",
  SessionCapabilityMissing: "OAL-RUNTREE-SESSION-CAPABILITY-MISSING",
  RecordInvalid: "OAL-RUNTREE-RECORD-INVALID"
} as const;

/** One recorded trial, loaded from its run directory. */
export interface LoadedTrial {
  /** Absolute run directory. */
  readonly root: string;
  readonly runId: string;
  readonly batchId: string | null;
  readonly started: JsonObject;
  readonly completed: JsonObject | null;
  readonly lifecycle: readonly LifecycleEvent[];
  /** Redacted adapter session events of section 33.1. */
  readonly session: readonly LifecycleEvent[];
  readonly trace: readonly TraceEvent[];
  readonly documentation: readonly DocumentationExchange[];
  readonly evaluation: Evaluation | null;
  readonly participantText: string | null;
  readonly usage: JsonObject | null;
  readonly stateFinal: JsonObject | null;
  readonly stateSummary: JsonObject | null;
}

/** One recorded batch with every trial it owns. */
export interface LoadedBatch {
  /** Absolute batch directory. */
  readonly root: string;
  readonly batchId: string;
  readonly batch: JsonObject | null;
  readonly completed: JsonObject | null;
  readonly inputsDir: string;
  /** Records of the batch-level assignment ledger. */
  readonly assignmentEvents: readonly JsonObject[];
  readonly trials: readonly LoadedTrial[];
}

/**
 * One serve session: `trace.jsonl` plus `capability-report.json` under
 * one directory, as `oal serve` writes it. A session has no lifecycle
 * ledger and no assignment ledger, so its trial carries empty ledgers
 * and no recorded evaluation; nothing is inferred to fill them.
 */
export interface LoadedSession {
  /** Absolute session directory. */
  readonly root: string;
  /** Session identifier: the run_id the trace events carry. */
  readonly sessionId: string;
  /** The compiled capability report served alongside the trace. */
  readonly capabilities: JsonObject;
  /** The one trial the session trace describes. */
  readonly trials: readonly LoadedTrial[];
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

function requireObject(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(
      RunTreeCode.RecordInvalid,
      `${what} did not yield a JSON object.`
    );
  }
  return value as JsonObject;
}

async function readJsonObject(file: string): Promise<JsonObject | null> {
  const text = await readIfPresent(file);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidInput(
      RunTreeCode.RecordInvalid,
      `${file} is not valid JSON: ${describeCause(error)}.`
    );
  }
  return requireObject(parsed, file);
}

async function readJsonLines(file: string): Promise<readonly JsonObject[]> {
  const text = await readIfPresent(file);
  if (text === null) {
    return [];
  }
  const records: JsonObject[] = [];
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
        RunTreeCode.RecordInvalid,
        `${file} line ${index + 1} is not valid JSON: ${describeCause(error)}.`
      );
    }
    records.push(requireObject(parsed, `${file} line ${index + 1}`));
  }
  return records;
}

function stringOf(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Load one run directory. The write-once start record identifies the run;
 * every other artifact is optional so an unfinalized run still loads.
 */
export async function loadTrial(runDir: string): Promise<LoadedTrial> {
  const started = await readJsonObject(path.join(runDir, "run.started.json"));
  if (started === null) {
    throw invalidInput(
      RunTreeCode.NotRun,
      `Directory "${runDir}" holds no run.started.json, so it is not a run ` +
        "directory."
    );
  }
  const runId = stringOf(started, "run_id");
  if (runId === null) {
    throw invalidInput(
      RunTreeCode.RecordInvalid,
      `${path.join(runDir, "run.started.json")} holds no run_id.`
    );
  }
  const evaluationObject = await readJsonObject(
    path.join(runDir, "evaluation.json")
  );
  return {
    root: runDir,
    runId,
    batchId: stringOf(started, "batch_id"),
    started,
    completed: await readJsonObject(path.join(runDir, "run.completed.json")),
    lifecycle: (await readJsonLines(
      path.join(runDir, "lifecycle.jsonl")
    )) as unknown as LifecycleEvent[],
    session: (await readJsonLines(
      path.join(runDir, "session", "events.redacted.jsonl")
    )) as unknown as LifecycleEvent[],
    trace: (await readJsonLines(
      path.join(runDir, "trace.jsonl")
    )) as unknown as TraceEvent[],
    documentation: (await readJsonLines(
      path.join(runDir, "documentation.jsonl")
    )) as unknown as DocumentationExchange[],
    evaluation:
      evaluationObject === null
        ? null
        : (evaluationObject as unknown as Evaluation),
    participantText: await readIfPresent(
      path.join(runDir, "participant-final.txt")
    ),
    usage: await readJsonObject(path.join(runDir, "resource-usage.json")),
    stateFinal: await readJsonObject(path.join(runDir, "state.final.json")),
    stateSummary: await readJsonObject(path.join(runDir, "state.summary.json"))
  };
}

async function isDirectory(target: string): Promise<boolean> {
  const stats = await stat(target).catch(() => null);
  return stats !== null && stats.isDirectory();
}

/** True when the directory holds the write-once batch record. */
export async function isBatchDir(target: string): Promise<boolean> {
  return (
    (await isDirectory(target)) &&
    ((await readIfPresent(path.join(target, "batch.json"))) !== null ||
      (await readIfPresent(path.join(target, "batch.completed.json"))) !== null)
  );
}

/** True when the directory holds a run start record. */
export async function isRunDir(target: string): Promise<boolean> {
  return (
    (await isDirectory(target)) &&
    (await readIfPresent(path.join(target, "run.started.json"))) !== null
  );
}

/**
 * True when the directory holds a serve session: a `trace.jsonl` next to
 * a `capability-report.json`, with neither a run start record nor a
 * batch record. Run and batch directories keep precedence.
 */
export async function isSessionDir(target: string): Promise<boolean> {
  if (!(await isDirectory(target))) {
    return false;
  }
  if (await isRunDir(target)) {
    return false;
  }
  if (await isBatchDir(target)) {
    return false;
  }
  return (
    (await readIfPresent(path.join(target, "trace.jsonl"))) !== null &&
    (await readIfPresent(path.join(target, "capability-report.json"))) !== null
  );
}

/**
 * Load one serve session directory. The session identifier is the run_id
 * every trace event carries; events that disagree on it, or a trace
 * that names none, are refused rather than guessed at.
 */
export async function loadSession(sessionDir: string): Promise<LoadedSession> {
  if (!(await isDirectory(sessionDir))) {
    throw invalidInput(
      RunTreeCode.NotSession,
      `Session directory "${sessionDir}" does not exist.`
    );
  }
  if ((await readIfPresent(path.join(sessionDir, "trace.jsonl"))) === null) {
    throw invalidInput(
      RunTreeCode.NotSession,
      `Directory "${sessionDir}" holds no trace.jsonl, so it is not a ` +
        "serve session directory."
    );
  }
  const capabilities = await readJsonObject(
    path.join(sessionDir, "capability-report.json")
  );
  if (capabilities === null) {
    throw invalidInput(
      RunTreeCode.SessionCapabilityMissing,
      `Serve session "${sessionDir}" holds no capability-report.json, so ` +
        "the contract it was served under is unknown. A session needs " +
        "trace.jsonl plus capability-report.json."
    );
  }
  const trace = (await readJsonLines(
    path.join(sessionDir, "trace.jsonl")
  )) as unknown as TraceEvent[];
  const sessionId = sessionIdOf(sessionDir, trace);
  return {
    root: sessionDir,
    sessionId,
    capabilities,
    trials: [
      {
        root: sessionDir,
        runId: sessionId,
        batchId: null,
        started: {},
        completed: null,
        lifecycle: [],
        session: [],
        trace,
        documentation: [],
        evaluation: null,
        participantText: null,
        usage: null,
        stateFinal: null,
        stateSummary: null
      }
    ]
  };
}

/**
 * The session identifier one trace names: the run_id its events agree
 * on, or the directory name when the trace holds no events.
 */
function sessionIdOf(sessionDir: string, trace: readonly TraceEvent[]): string {
  let named: string | null = null;
  for (const event of trace) {
    const runId = event["run_id"];
    if (typeof runId !== "string") {
      continue;
    }
    if (named === null) {
      named = runId;
      continue;
    }
    if (named !== runId) {
      throw invalidInput(
        RunTreeCode.RecordInvalid,
        `Serve session "${sessionDir}" holds several run_id values ` +
          `(${named}, ${runId}), so one session cannot name it.`
      );
    }
  }
  const id = named ?? path.basename(path.resolve(sessionDir));
  if (!isSafeId(id)) {
    throw invalidInput(
      RunTreeCode.RecordInvalid,
      `Serve session "${sessionDir}" names the identifier "${id}", which ` +
        "is not a safe id."
    );
  }
  return id;
}

/** Load one batch directory and every recorded trial below trials/. */
export async function loadBatch(batchDir: string): Promise<LoadedBatch> {
  if (!(await isDirectory(batchDir))) {
    throw invalidInput(
      RunTreeCode.NotBatch,
      `Batch directory "${batchDir}" does not exist.`
    );
  }
  const batch = await readJsonObject(path.join(batchDir, "batch.json"));
  const completed = await readJsonObject(
    path.join(batchDir, "batch.completed.json")
  );
  if (batch === null && completed === null) {
    throw invalidInput(
      RunTreeCode.NotBatch,
      `Directory "${batchDir}" holds no batch.json or batch.completed.json, ` +
        "so it is not a batch directory."
    );
  }
  const batchId =
    stringOf(batch ?? {}, "batch_id") ?? stringOf(completed ?? {}, "batch_id");
  if (batchId === null) {
    throw invalidInput(
      RunTreeCode.RecordInvalid,
      `The batch records of "${batchDir}" hold no batch_id.`
    );
  }
  const trialsRoot = path.join(batchDir, "trials");
  const entries = await readdir(trialsRoot)
    .catch(() => [])
    .then((names) => names.sort());
  const trials: LoadedTrial[] = [];
  for (const name of entries) {
    const runDir = path.join(trialsRoot, name);
    if (await isRunDir(runDir)) {
      trials.push(await loadTrial(runDir));
    }
  }
  trials.sort((left, right) => (left.runId < right.runId ? -1 : 1));
  return {
    root: batchDir,
    batchId,
    batch,
    completed,
    inputsDir: path.join(batchDir, "inputs"),
    assignmentEvents: await readJsonLines(
      path.join(batchDir, "assignment-events.jsonl")
    ),
    trials
  };
}

/** A resolved run-or-batch argument, with a serve session as a third kind. */
export type RunOrBatch =
  | {
      readonly kind: "run";
      readonly trials: readonly LoadedTrial[];
      readonly assignmentEvents: readonly JsonObject[];
    }
  | { readonly kind: "batch"; readonly batch: LoadedBatch }
  | { readonly kind: "session"; readonly session: LoadedSession };

/**
 * Resolve one run-or-batch argument. A run directory loads as one trial; a
 * batch directory loads with every recorded trial. A serve session loads
 * only when the caller allows it, because reports and evaluations read
 * ledgers a session never recorded.
 */
export async function loadRunOrBatch(
  target: string,
  options: { readonly sessions?: "allow" | "refuse" } = {}
): Promise<RunOrBatch> {
  if (await isRunDir(target)) {
    const trial = await loadTrial(target);
    const batchRoot = await batchRootOf(target);
    return {
      kind: "run",
      trials: [trial],
      assignmentEvents:
        batchRoot === null
          ? []
          : await readJsonLines(path.join(batchRoot, "assignment-events.jsonl"))
    };
  }
  if (await isBatchDir(target)) {
    return { kind: "batch", batch: await loadBatch(target) };
  }
  // A directory that holds trace.jsonl but no run or batch record is a
  // serve session candidate: loadSession refuses it with the precise
  // diagnostic when the capability report is missing.
  if (
    options.sessions === "allow" &&
    (await readIfPresent(path.join(target, "trace.jsonl"))) !== null
  ) {
    return { kind: "session", session: await loadSession(target) };
  }
  throw invalidInput(
    RunTreeCode.NotRunOrBatch,
    `"${target}" is neither a run directory (run.started.json) nor a batch ` +
      "directory (batch.json or batch.completed.json)."
  );
}

/** The assignment-ledger records of one resolved run-or-batch argument. */
export function assignmentEventsOf(subject: RunOrBatch): readonly JsonObject[] {
  if (subject.kind === "batch") {
    return subject.batch.assignmentEvents;
  }
  if (subject.kind === "session") {
    return [];
  }
  return subject.assignmentEvents;
}

/** Every trial of one resolved run-or-batch argument. */
export function trialsOf(subject: RunOrBatch): readonly LoadedTrial[] {
  if (subject.kind === "run") {
    return subject.trials;
  }
  if (subject.kind === "session") {
    return subject.session.trials;
  }
  return subject.batch.trials;
}

/** The run identifier one ledger record points at, when it points at one. */
function ledgerRunIdOf(event: JsonObject): string | null {
  const recorded = event["run_id"];
  if (typeof recorded === "string") {
    return recorded;
  }
  const extensions = event["extensions"];
  if (isJsonObject(extensions)) {
    const extended = extensions["run_id"];
    if (typeof extended === "string") {
      return extended;
    }
  }
  return null;
}

/** The last ledger record of one kind that points at the given run. */
function ledgerEventOf(
  events: readonly JsonObject[],
  runId: string,
  kind: string
): JsonObject | null {
  let found: JsonObject | null = null;
  for (const event of events) {
    if (event["kind"] !== kind) {
      continue;
    }
    if (ledgerRunIdOf(event) === runId) {
      found = event;
    }
  }
  return found;
}

/**
 * The scheduling view one run's assignment recorded: its identifier and,
 * for an activated replacement, the assignment it replaced.
 */
export function assignmentViewOf(
  events: readonly JsonObject[],
  runId: string
): {
  readonly assignmentId: string | null;
  readonly replacementOf: string | null;
} {
  const launched = ledgerEventOf(events, runId, "launched");
  return {
    assignmentId:
      launched === null ? null : stringOf(launched, "assignment_id"),
    replacementOf:
      launched === null ? null : stringOf(launched, "replacement_target")
  };
}

/**
 * The raw terminal ledger record of one run, when the ledger holds
 * one. `assignmentFinishedOf` projects this record; readers that need
 * its original fields, such as the censor class, read it here.
 */
export function assignmentTerminalRecordOf(
  events: readonly JsonObject[],
  runId: string
): JsonObject | null {
  return ledgerEventOf(events, runId, "terminal");
}

/**
 * Project the terminal ledger record of one run into its section 33.1
 * lifecycle form. Every field copies the recorded record; nothing is
 * inferred. Null when the ledger holds no terminal record for the run.
 */
export function assignmentFinishedOf(
  events: readonly JsonObject[],
  runId: string
): LifecycleEvent | null {
  const terminal = assignmentTerminalRecordOf(events, runId);
  if (terminal === null) {
    return null;
  }
  const runIdOfRecord = ledgerRunIdOf(terminal);
  const stringField = (key: string): string | null => stringOf(terminal, key);
  const fallbackStamp = "1970-01-01T00:00:00.000Z";
  const projected: JsonObject = {
    schema_version: 1,
    event_id: stringField("event_id") ?? `asg-${runId}`,
    sequence:
      typeof terminal["sequence"] === "number" ? terminal["sequence"] : 0,
    observed_at: stringField("recorded_at") ?? fallbackStamp,
    batch_id: stringField("batch_id"),
    run_id: runIdOfRecord,
    type: "assignment.finished",
    payload: {
      assignment_id: stringField("assignment_id") ?? "",
      run_id: runIdOfRecord,
      disposition: stringField("disposition") ?? "harness_aborted",
      evidence_integrity: stringField("evidence_integrity") ?? "missing"
    }
  };
  return projected as unknown as LifecycleEvent;
}

/**
 * Locate the batch directory that owns one run directory: the nearest
 * ancestor holding an `inputs` directory. Null at the filesystem root.
 */
export async function batchRootOf(runDir: string): Promise<string | null> {
  let current = path.resolve(runDir);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
    if (await isDirectory(path.join(current, "inputs"))) {
      return current;
    }
  }
}

/** Scope identity of one resolved run-or-batch argument. */
export function scopeOf(subject: RunOrBatch): {
  readonly level: "batch" | "run";
  readonly id: string;
} {
  if (subject.kind === "batch") {
    return { level: "batch", id: subject.batch.batchId };
  }
  if (subject.kind === "session") {
    // A session names one run of the serve exposure, never a batch.
    return { level: "run", id: subject.session.sessionId };
  }
  const trial = subject.trials[0];
  const id = trial?.batchId ?? trial?.runId ?? "run";
  return { level: trial?.batchId === null ? "run" : "batch", id };
}

/** One artifact-manifest drift finding of a run or batch directory. */
export interface ArtifactDrift {
  readonly root: string;
  readonly path: string;
  readonly detail: string;
}

/**
 * Verify the artifact hashes of one run directory against its recorded
 * artifact manifest. Every recorded entry must exist and hash to its
 * recorded digest; returns one finding per drift.
 */
export async function verifyTrialArtifacts(
  trial: LoadedTrial
): Promise<readonly ArtifactDrift[]> {
  return await verifyArtifactsOf(trial.root);
}

/** Verify a run or batch from its write-once completion pointer. */
export async function verifyScopeArtifacts(
  subject: RunOrBatch
): Promise<readonly ArtifactDrift[]> {
  if (subject.kind === "session") {
    // A serve session writes no manifest and no completion pointer, so
    // scope verification reports that fact instead of guessing a root.
    return [
      {
        root: subject.session.root,
        path: "artifact-manifest.json",
        detail: "a serve session records no artifact manifest"
      }
    ];
  }
  const trial = subject.kind === "run" ? subject.trials[0] : undefined;
  if (subject.kind === "run" && trial === undefined) {
    return [
      {
        root: "",
        path: "run.completed.json",
        detail: "the run scope has no trial"
      }
    ];
  }
  const scopeRoot =
    subject.kind === "batch" ? subject.batch.root : (trial?.root ?? "");
  const storeRoot =
    subject.kind === "batch"
      ? path.resolve(scopeRoot, "../..")
      : trial?.batchId === null
        ? path.dirname(scopeRoot)
        : path.resolve(scopeRoot, "../../../..");
  const pointerPath = path.relative(
    storeRoot,
    path.join(
      scopeRoot,
      subject.kind === "batch" ? "batch.completed.json" : "run.completed.json"
    )
  );
  const result = await new ArtifactStore(storeRoot).verify(pointerPath);
  return result.problems.map((detail) => ({
    root: scopeRoot,
    path: pointerPath,
    detail
  }));
}

/**
 * Verify the artifact manifest of one run or batch directory. Every
 * entry must hold a safe relative path and a sha256, exist as a regular
 * file below the directory, and hash to its recorded digest. Malformed
 * or unsafe entries are reported as drift, never skipped: a manifest
 * that verifies nothing is itself drift.
 */
export async function verifyArtifactsOf(
  root: string
): Promise<readonly ArtifactDrift[]> {
  const findings: ArtifactDrift[] = [];
  const manifestPath = path.join(root, "artifact-manifest.json");
  const manifestText = await readIfPresent(manifestPath);
  if (manifestText === null) {
    return [
      {
        root,
        path: "artifact-manifest.json",
        detail: "the directory holds no artifact manifest"
      }
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch (error) {
    return [
      {
        root,
        path: "artifact-manifest.json",
        detail: `not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    ];
  }
  if (!isJsonObject(parsed as Json | undefined)) {
    return [
      {
        root,
        path: "artifact-manifest.json",
        detail: "the artifact manifest is not a JSON object"
      }
    ];
  }
  const entries = (parsed as JsonObject)["entries"];
  if (!Array.isArray(entries)) {
    return [
      {
        root,
        path: "artifact-manifest.json",
        detail: "the artifact manifest holds no entries"
      }
    ];
  }
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      findings.push({
        root,
        path: "artifact-manifest.json",
        detail: "manifest entry is malformed: not an object"
      });
      continue;
    }
    const relative = stringOf(entry, "path");
    const recorded = stringOf(entry, "sha256");
    if (relative === null || recorded === null) {
      findings.push({
        root,
        path: "artifact-manifest.json",
        detail: "manifest entry is malformed: missing path or sha256"
      });
      continue;
    }
    // A manifest path is untrusted input. Reject any path that could
    // name a file outside the directory before anything is read.
    if (!isSafeRelativePath(relative)) {
      findings.push({
        root,
        path: relative,
        detail: "the manifest path is not a safe relative path"
      });
      continue;
    }
    // lstat never follows the final path, so a symlink is refused
    // instead of read.
    const stats = await lstat(path.join(root, relative)).catch(() => null);
    if (stats === null) {
      findings.push({
        root,
        path: relative,
        detail: "recorded artifact is missing"
      });
      continue;
    }
    if (!stats.isFile()) {
      findings.push({
        root,
        path: relative,
        detail: "recorded artifact is not a regular file"
      });
      continue;
    }
    const bytes = await readFile(path.join(root, relative)).catch(() => null);
    if (bytes === null) {
      findings.push({
        root,
        path: relative,
        detail: "recorded artifact is missing"
      });
      continue;
    }
    const digest = sha256HexBytes(new Uint8Array(bytes));
    if (digest !== recorded) {
      findings.push({
        root,
        path: relative,
        detail: `hash drift: recorded ${recorded}, found ${digest}`
      });
    }
  }
  return findings;
}
