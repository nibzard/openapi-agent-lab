/**
 * `oal serve` (specification sections 23.2 and 23.4). One loopback raw
 * HTTP exposure serves the compiled contract until the process receives
 * an interruption. Exactly one readiness JSON record goes to stdout; the
 * credential instructions stay on stderr.
 */

import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  OalError,
  canonicalJsonSha256,
  diagnostic,
  invalidInput,
  isSafeId,
  sha256Hex,
  stableJsonStringify,
  unsupported,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { LIMIT_DEFAULTS } from "@oal/config";
import type { ContractIR } from "@oal/contract-ir";
import { mintRunCredentials } from "@oal/gateway";
import { compileOpenApi } from "@oal/openapi";
import { loadPack, type LoadedPack } from "@oal/pack";
import {
  deriveManualRunSeed,
  RUN_IDENTITY_MISMATCH_CODE,
  SCHEMA_VERSION,
  StateStore,
  type RunMetaInput
} from "@oal/state-store";
import {
  createRawHttpExposure,
  credentialEnvironmentName,
  DEFAULT_EXPOSURE_HOST,
  packFreezeDigest,
  packResponseFixtures,
  type ExposureHandle
} from "@oal/runner";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { resolveSourceArgument } from "../source.ts";
import { missingArgument, tooManyArguments } from "../usage.ts";

/** Stable diagnostic codes of the serve command. */
export const ServeCliCode = {
  ModeUnsupported: "OAL-SERVE-MODE-UNSUPPORTED",
  ResumeUnsupported: "OAL-SERVE-RESUME-UNSUPPORTED",
  ResumeAbsent: "OAL-SERVE-RESUME-ABSENT",
  ResumeFinalized: "OAL-SERVE-RESUME-FINALIZED",
  ResumeInUse: "OAL-SERVE-RESUME-IN-USE",
  ResumeMismatch: "OAL-SERVE-RESUME-MISMATCH",
  HostRefused: "OAL-SERVE-HOST-REFUSED",
  RunIdUnsafe: "OAL-SERVE-RUN-ID-UNSAFE",
  ReadyStale: "OAL-SERVE-READY-STALE",
  CredentialsExist: "OAL-SERVE-CREDENTIALS-EXIST",
  StrictUnsupported: "OAL-SERVE-STRICT-UNSUPPORTED"
} as const;

/** Default manual serve port (specification section 23.4). */
export const DEFAULT_SERVE_PORT = 4010;

/** Loopback hosts the command may bind without an explicit opt-in. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]"
]);

/** One compiled serve source: the contract and its capability report. */
export interface CompiledSource {
  readonly contract: ContractIR;
  readonly capabilityReport: Json;
  readonly pack: LoadedPack | null;
}

/**
 * Compile the contract behind one serve source: a pack directory with a
 * manifest, or a bare OpenAPI document.
 */
export async function compileServeSource(
  source: string,
  cwd: string,
  maxBytes: number
): Promise<CompiledSource> {
  const absolute = path.resolve(cwd, source);
  const hasManifest =
    (await stat(path.join(absolute, "pack.yaml")).catch(() => null)) !== null ||
    (await stat(path.join(absolute, "pack.json")).catch(() => null)) !== null;
  if (hasManifest) {
    const pack = await loadPack(absolute);
    const entry = pack.references.find(
      (reference) => reference.role === "contract_entrypoint"
    );
    if (entry === undefined) {
      throw invalidInput(
        "OAL-SERVE-CONTRACT-MISSING",
        `Pack ${absolute} declares no contract entrypoint.`
      );
    }
    const documents: Record<string, string> = {
      [entry.path]: await readFile(entry.absolutePath, "utf8")
    };
    const compiled = compileOpenApi({ documents, entrypoint: entry.path });
    return {
      contract: compiled.contract,
      capabilityReport: compiled.report as unknown as Json,
      pack
    };
  }
  const resolved = await resolveSourceArgument(source, { cwd, maxBytes });
  const text = await readFile(resolved.entrypoint, "utf8");
  const entrypoint = path.basename(resolved.entrypoint);
  const compiled = compileOpenApi({
    documents: { [entrypoint]: text },
    entrypoint
  });
  return {
    contract: compiled.contract,
    capabilityReport: compiled.report as unknown as Json,
    pack: null
  };
}

/**
 * Derive the manual run seed from the contract, the loaded pack, and
 * the run identity. The inputs are exactly the ones
 * {@link serveRunIdentity} records, so one contract or pack change
 * moves the seed and the identity together.
 */
export function deriveServeRunSeed(
  contract: ContractIR,
  pack: LoadedPack | null,
  runId: string
): string {
  return deriveManualRunSeed({
    runId,
    contractExecutionSha256: contract.source.execution_sha256,
    packSha256: packSha256Of(pack),
    scenarioSha256: null,
    backendSha256: sha256Hex(
      `contract-backend:${contract.source.semantic_sha256}`
    )
  });
}

/** Digest of the served pack, or null for a bare document. */
function packSha256Of(pack: LoadedPack | null): string | null {
  return pack === null ? null : packFreezeDigest(pack);
}

/** Default manual run identifier from one wall-clock instant. */
export function defaultServeRunId(at: Date): string {
  const pad = (value: number, width = 2): string =>
    value.toString().padStart(width, "0");
  return [
    "manual",
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`,
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  ].join("-");
}

/** One synthetic credential entry of the private credentials file. */
export interface CredentialScheme {
  readonly scheme: string;
  readonly type: string;
  readonly location: string | null;
  readonly wire_name: string | null;
  readonly environment: string;
  readonly value: string;
}

/** One OR alternative: every scheme one AND set requires. */
export interface CredentialAlternative {
  readonly index: number;
  readonly schemes: readonly CredentialScheme[];
}

/** Credential file document written for a secured manual mock. */
export interface ManualCredentials {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly base_url: string;
  readonly alternatives: readonly CredentialAlternative[];
}

/**
 * Build the private credentials document: one alternative per distinct
 * security requirement the contract declares, with synthetic values.
 */
export function buildManualCredentials(
  contract: ContractIR,
  runId: string,
  baseUrl: string,
  runSeed: string
): ManualCredentials {
  const minted = mintRunCredentials(contract, runSeed);
  const alternatives: CredentialAlternative[] = [];
  const seen = new Set<string>();
  for (const operation of contract.operations) {
    if (operation.security === null) {
      continue;
    }
    for (const requirement of operation.security.alternatives) {
      const schemes: CredentialScheme[] = [];
      for (const needed of requirement.schemes) {
        const declared = contract.security_schemes[needed.name];
        if (declared === undefined) {
          continue;
        }
        const name = credentialEnvironmentName(declared.name);
        const wireName = declared.wire_name ?? declared.name;
        const bearerish =
          declared.type === "oauth2" ||
          declared.type === "openIdConnect" ||
          (declared.type === "http" && declared.scheme === "bearer");
        if (declared.type === "http" && declared.scheme === "basic") {
          schemes.push(
            {
              scheme: declared.name,
              type: "http basic",
              location: "header",
              wire_name: "authorization",
              environment: `${name}_USERNAME`,
              value: minted.basic.username
            },
            {
              scheme: declared.name,
              type: "http basic",
              location: "header",
              wire_name: "authorization",
              environment: `${name}_PASSWORD`,
              value: minted.basic.password
            }
          );
          continue;
        }
        const apiKey = minted.apiKeys[declared.name];
        schemes.push({
          scheme: declared.name,
          type: declared.type,
          location: declared.location === null ? null : declared.location,
          wire_name: wireName,
          environment: name,
          value: bearerish ? minted.bearer : (apiKey ?? minted.bearer)
        });
      }
      if (schemes.length === 0) {
        continue;
      }
      const key = canonicalJsonSha256(schemes as unknown as Json);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      alternatives.push({ index: alternatives.length, schemes });
    }
  }
  return { schema_version: 1, run_id: runId, base_url: baseUrl, alternatives };
}

/**
 * Human instructions for a secured manual mock. Names only: values never
 * appear here.
 */
export function credentialInstructionsOf(
  credentials: ManualCredentials
): readonly string[] {
  if (credentials.alternatives.length === 0) {
    return ["The contract declares no authentication; send requests plain."];
  }
  const lines: string[] = [];
  for (const alternative of credentials.alternatives) {
    const names = alternative.schemes
      .map((scheme) => scheme.environment)
      .join(", ");
    lines.push(
      `Alternative ${alternative.index}: set ${names}, then send them as ` +
        "declared on every request."
    );
  }
  lines.push(
    "Synthetic values live in the private credentials file named by " +
      "credentialsPath in the readiness record."
  );
  return lines;
}

async function writePrivateFile(target: string, text: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

/** Wait for the run-wide abort signal, which interruption triggers. */
export function awaitInterruption(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      (): void => {
        resolve();
      },
      { once: true }
    );
  });
}

/** A trace writer that records nothing; manual serve keeps no evidence. */
const DISCARD_TRACE = {
  reserve: (): { sequence: number; event_id: string } => ({
    sequence: 0,
    event_id: "manual"
  }),
  complete: (): Promise<void> => Promise.resolve()
};

/** Marker files of the private serve control directory (section 23.4). */
const RUN_ID_FILE = "RUN_ID";
const SERVER_PID_FILE = "SERVER.pid";
const FINALIZED_FILE = "FINALIZED";

/** The persisted run record a later `--resume` verifies against. */
export interface ServeRunRecord {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly run_seed: string;
  readonly created_at: string;
}

/**
 * The run identity of one manual serve, exactly as the state store
 * records it (section 16.3): contract digests, the sorted source
 * inventory, the pack digest when the source is a pack, the
 * contract-backend and implementation bundles, the seed, and the state
 * schema version.
 */
export function serveRunIdentity(
  contract: ContractIR,
  pack: LoadedPack | null,
  runSeed: string
): RunMetaInput {
  const inventory = [...contract.source.documents].sort((left, right) =>
    left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0
  );
  return {
    batchId: "manual",
    contractSemanticSha256: contract.source.semantic_sha256,
    contractExecutionSha256: contract.source.execution_sha256,
    sourceInventorySha256: canonicalJsonSha256(inventory as unknown as Json),
    packSha256: packSha256Of(pack),
    scenarioSha256: null,
    contractVariantSha256: null,
    backendSha256: sha256Hex(
      `contract-backend:${contract.source.semantic_sha256}`
    ),
    implementationSha256: sha256Hex("oal-serve:1"),
    seed: runSeed,
    stateSchemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString()
  };
}

/**
 * Read the persisted run record of one control directory. Returns null
 * when no readable record exists; a resume of such a tree is refused.
 */
export async function readServeRunRecord(
  controlDir: string
): Promise<ServeRunRecord | null> {
  const text = await readFile(path.join(controlDir, RUN_ID_FILE), "utf8").catch(
    () => null
  );
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<ServeRunRecord>;
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.run_id !== "string" ||
      typeof parsed.run_seed !== "string" ||
      typeof parsed.created_at !== "string"
    ) {
      return null;
    }
    return {
      schema_version: 1,
      run_id: parsed.run_id,
      run_seed: parsed.run_seed,
      created_at: parsed.created_at
    };
  } catch {
    return null;
  }
}

/**
 * Whether one process id still names a live process. A permission
 * error still proves the process exists, so it counts as live.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Write one private control marker, replacing any earlier content. */
async function writeMarker(target: string, text: string): Promise<void> {
  const handle = await open(target, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

/** Everything `startServe` produced, for reuse by tests. */
export interface ServeSession {
  readonly handle: ExposureHandle;
  readonly credentials: ManualCredentials;
  readonly credentialsPath: string | null;
  readonly capabilitiesPath: string;
  readonly readiness: JsonObject;
  /** The private state store of this control directory. */
  readonly store: StateStore;
  /** Absolute control directory the markers and state live in. */
  readonly controlDir: string;
}

/**
 * Bring one compiled contract up on loopback HTTP, write the private
 * control files, and return the readiness record. A fresh serve
 * initializes the run identity; a resumed serve verifies it first and
 * refuses when any recorded digest moved.
 */
export async function startServe(options: {
  readonly contract: ContractIR;
  readonly capabilityReport: Json;
  /** Loaded pack behind the contract, or null for a bare document. */
  readonly pack: LoadedPack | null;
  readonly host: string;
  readonly port: number;
  readonly runId: string;
  readonly runSeed: string;
  readonly controlDir: string;
  readonly credentialsOut: string | null;
  /** Run identity of the serve; reused verbatim on resume. */
  readonly identity: RunMetaInput;
  /** True when this call resumes an interrupted serve. */
  readonly resumed: boolean;
}): Promise<ServeSession> {
  await mkdir(options.controlDir, { recursive: true });
  const store = StateStore.open({
    path: path.join(options.controlDir, "state.sqlite"),
    runId: options.runId
  });
  if (options.resumed) {
    try {
      store.verifyRunIdentity(options.identity);
    } catch (error) {
      store.close();
      throw error;
    }
  } else {
    store.initializeRun(options.identity);
  }
  const handle = await createRawHttpExposure({
    fixtures: options.pack === null ? [] : packResponseFixtures(options.pack)
  })({
    batchId: "manual",
    runId: options.runId,
    evalId: "manual",
    trialSeed: options.runSeed,
    contract: options.contract,
    limits: LIMIT_DEFAULTS,
    host: options.host,
    port: options.port,
    now: (): number => Date.now(),
    trace: DISCARD_TRACE,
    sensitiveHeaderNames: ["authorization"],
    sensitiveKeyPatterns: []
  });
  const credentials = buildManualCredentials(
    options.contract,
    options.runId,
    handle.baseUrl,
    options.runSeed
  );
  const defaultCredentialsPath = path.join(
    options.controlDir,
    "credentials.json"
  );
  const credentialsPath = options.credentialsOut ?? defaultCredentialsPath;
  if (credentials.alternatives.length > 0) {
    // A resumed serve rewrites its credentials: the port may differ, so
    // the values change even though the seed does not.
    if (options.resumed) {
      await rm(credentialsPath, { force: true }).catch(() => undefined);
    }
    await writePrivateFile(
      credentialsPath,
      `${stableJsonStringify(credentials as unknown as Json)}\n`
    );
  }
  const capabilitiesPath = path.join(
    options.controlDir,
    "capability-report.json"
  );
  await writeFile(
    capabilitiesPath,
    `${stableJsonStringify(options.capabilityReport)}\n`
  );
  const record: ServeRunRecord = {
    schema_version: 1,
    run_id: options.runId,
    run_seed: options.runSeed,
    created_at: options.identity.createdAt
  };
  await writeMarker(
    path.join(options.controlDir, RUN_ID_FILE),
    `${stableJsonStringify(record as unknown as Json)}\n`
  );
  await writeMarker(
    path.join(options.controlDir, SERVER_PID_FILE),
    `${process.pid.toString(10)}\n`
  );
  const supported = options.contract.operations.filter(
    (operation) => operation.support.level === "supported"
  ).length;
  const readiness: JsonObject = {
    schema_version: 1,
    status: "ready",
    mode: "contract",
    baseUrl: handle.baseUrl,
    runId: options.runId,
    contractSha256: options.contract.source.semantic_sha256,
    operationCount: options.contract.operations.length,
    supportedOperationCount: supported,
    capabilitiesPath,
    credentialsPath:
      credentials.alternatives.length > 0 ? credentialsPath : null
  };
  return {
    handle,
    credentials,
    credentialsPath:
      credentials.alternatives.length > 0 ? credentialsPath : null,
    capabilitiesPath,
    readiness,
    store,
    controlDir: options.controlDir
  };
}

/**
 * Write the terminal marker of one control directory and clear the
 * live-server marker, so a later resume is correctly refused.
 */
export async function finalizeServeControl(controlDir: string): Promise<void> {
  await writeMarker(
    path.join(controlDir, FINALIZED_FILE),
    `${stableJsonStringify({
      schema_version: 1,
      finished_at: new Date().toISOString(),
      pid: process.pid
    } as Json)}\n`
  );
  await rm(path.join(controlDir, SERVER_PID_FILE), { force: true }).catch(
    () => undefined
  );
}

/** `oal serve <source>` (specification section 23.4). */
export const serveCommand: CommandHandler = async (args, io) => {
  const source = args.positionals[0];
  if (source === undefined) {
    throw missingArgument(args.command.name, "source");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const resume = args.flags.string("resume");
  if (resume !== undefined) {
    for (const conflict of ["run-id", "run-dir", "run-seed"]) {
      if (args.flags.string(conflict) !== undefined) {
        throw invalidInput(
          ServeCliCode.ResumeUnsupported,
          `--resume and --${conflict} are mutually exclusive.`
        );
      }
    }
  }
  const mode = args.flags.enumeration(
    "mode",
    ["contract", "scenario"] as const,
    "contract"
  );
  const scenario = args.flags.string("scenario");
  const unsupportedFindings: Diagnostic[] = [];
  if (mode === "scenario" || scenario !== undefined) {
    unsupportedFindings.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.ModeUnsupported,
        message:
          "Scenario mode needs a pack scenario backend, which this build " +
          "does not serve. Serve the contract in contract mode instead."
      })
    );
  }
  if (unsupportedFindings.length > 0) {
    emitDiagnostics(io, args.context, unsupportedFindings);
    return EXIT_UNSUPPORTED;
  }

  const host = args.flags.string("host") ?? DEFAULT_EXPOSURE_HOST;
  const port =
    args.flags.integer("port", { minimum: 0, maximum: 65_535 }) ??
    DEFAULT_SERVE_PORT;
  if (!LOOPBACK_HOSTS.has(host) && !args.flags.has("allow-non-loopback")) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.HostRefused,
        message:
          `Host ${host} is not loopback. Pass --allow-non-loopback to bind ` +
          "it explicitly.",
        details: { host }
      })
    ]);
    return EXIT_INVALID;
  }

  // A resume targets one control directory. The persisted run record
  // supplies the run id, the seed, and the creation time; a finalized
  // or still-live serve is refused before any contract work happens.
  const resumeDir =
    resume === undefined ? null : path.resolve(args.context.cwd, resume);
  const resumed =
    resumeDir === null ? null : await readServeRunRecord(resumeDir);
  if (resumeDir !== null && resumed === null) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.ResumeAbsent,
        message:
          `No readable run record under ${resumeDir}. A resume needs the ` +
          "private control state of an interrupted serve."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  if (resumeDir !== null) {
    if (
      (await stat(path.join(resumeDir, FINALIZED_FILE)).catch(() => null)) !==
      null
    ) {
      emitDiagnostics(io, args.context, [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: ServeCliCode.ResumeFinalized,
          message:
            `The serve under ${resumeDir} finalized cleanly. Start a new ` +
            "serve instead of resuming a finished run."
        })
      ]);
      return EXIT_UNSUPPORTED;
    }
    const pidText = await readFile(
      path.join(resumeDir, SERVER_PID_FILE),
      "utf8"
    ).catch(() => null);
    const pid =
      pidText === null ? Number.NaN : Number.parseInt(pidText.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      emitDiagnostics(io, args.context, [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: ServeCliCode.ResumeInUse,
          message:
            `The serve under ${resumeDir} still runs as process ` +
            `${pid.toString(10)}. Stop it before resuming.`,
          details: { pid }
        })
      ]);
      return EXIT_UNSUPPORTED;
    }
  }

  const runIdFlag = args.flags.string("run-id");
  const runId = resumed?.run_id ?? runIdFlag ?? defaultServeRunId(new Date());
  if (!isSafeId(runId)) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.RunIdUnsafe,
        message: `Run identifier is not a safe id: ${runId}.`
      })
    ]);
    return EXIT_INVALID;
  }

  const readyPath = args.flags.string("ready");
  const credentialsOut = args.flags.string("credentials-out") ?? null;
  if (
    readyPath !== undefined &&
    (await stat(readyPath).catch(() => null)) !== null
  ) {
    throw unsupported(
      ServeCliCode.ReadyStale,
      `Readiness path already exists: ${readyPath}.`
    );
  }
  if (
    credentialsOut !== null &&
    (await stat(credentialsOut).catch(() => null)) !== null
  ) {
    throw unsupported(
      ServeCliCode.CredentialsExist,
      `Credentials path already exists: ${credentialsOut}.`
    );
  }

  const compiledSource = await compileServeSource(
    source,
    args.context.cwd,
    args.context.maxSourceBytes
  );
  const contract = compiledSource.contract;
  const unsupportedOperations = contract.operations.filter(
    (operation) => operation.support.level !== "supported"
  );
  if (args.flags.has("strict") && unsupportedOperations.length > 0) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.StrictUnsupported,
        message:
          `--strict refuses the contract: ${unsupportedOperations.length} of ` +
          `${contract.operations.length} operations are not fully supported.`,
        details: {
          operations: unsupportedOperations.map((operation) => operation.key)
        }
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  const runSeed =
    resumed?.run_seed ??
    args.flags.string("run-seed") ??
    deriveServeRunSeed(contract, compiledSource.pack, runId);

  const runDirFlag = args.flags.string("run-dir");
  const controlDir =
    resumeDir ??
    (runDirFlag === undefined
      ? path.resolve(args.context.cwd, ".oal", "serve", runId)
      : path.resolve(args.context.cwd, runDirFlag));
  if (
    resumeDir === null &&
    runDirFlag !== undefined &&
    (await stat(controlDir).catch(() => null)) !== null
  ) {
    throw unsupported(
      ServeCliCode.ReadyStale,
      `Run directory already exists: ${controlDir}.`
    );
  }

  const identity = serveRunIdentity(contract, compiledSource.pack, runSeed);
  let session: ServeSession;
  try {
    session = await startServe({
      contract,
      capabilityReport: compiledSource.capabilityReport,
      pack: compiledSource.pack,
      host,
      port,
      runId,
      runSeed,
      controlDir,
      credentialsOut,
      identity,
      resumed: resumed !== null
    });
  } catch (error) {
    if (
      error instanceof OalError &&
      error.code === RUN_IDENTITY_MISMATCH_CODE
    ) {
      emitDiagnostics(io, args.context, [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: ServeCliCode.ResumeMismatch,
          message:
            `The contract or seed under ${controlDir} no longer matches ` +
            "the recorded run identity. Start a new serve instead.",
          details: error.details
        })
      ]);
      return EXIT_UNSUPPORTED;
    }
    throw error;
  }
  io.stdout(stableJsonStringify(session.readiness));
  for (const line of credentialInstructionsOf(session.credentials)) {
    io.stderr(line);
  }
  if (readyPath !== undefined) {
    await writePrivateFile(
      readyPath,
      `${stableJsonStringify(session.readiness)}\n`
    );
  }
  await awaitInterruption(args.context.abortSignal);
  await finalizeServeControl(controlDir);
  if (session.credentialsPath !== null) {
    await rm(session.credentialsPath, { force: true }).catch(() => undefined);
  }
  await session.handle.close();
  session.store.close();
  return EXIT_OK;
};
