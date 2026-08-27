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
  createLoopbackExposure,
  credentialEnvironmentName,
  DEFAULT_EXPOSURE_HOST,
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

/** Derive the manual run seed from the contract and the run identity. */
export function deriveServeRunSeed(
  contract: ContractIR,
  runId: string
): string {
  return sha256Hex(
    `${contract.source.semantic_sha256}:${contract.source.execution_sha256}` +
      `:contract:${runId}`
  );
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

/** Everything `startServe` produced, for reuse by tests. */
export interface ServeSession {
  readonly handle: ExposureHandle;
  readonly credentials: ManualCredentials;
  readonly credentialsPath: string | null;
  readonly capabilitiesPath: string;
  readonly readiness: JsonObject;
}

/**
 * Bring one compiled contract up on loopback HTTP, write the private
 * control files, and return the readiness record.
 */
export async function startServe(options: {
  readonly contract: ContractIR;
  readonly capabilityReport: Json;
  readonly host: string;
  readonly port: number;
  readonly runId: string;
  readonly runSeed: string;
  readonly controlDir: string;
  readonly credentialsOut: string | null;
}): Promise<ServeSession> {
  await mkdir(options.controlDir, { recursive: true });
  const handle = await createLoopbackExposure({
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
    readiness
  };
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
  if (resume !== undefined) {
    unsupportedFindings.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ServeCliCode.ResumeUnsupported,
        message:
          "--resume needs SQLite state verification, which this build does " +
          "not expose. Start a new serve instead."
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

  const runIdFlag = args.flags.string("run-id");
  const runId = runIdFlag ?? defaultServeRunId(new Date());
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
    args.flags.string("run-seed") ?? deriveServeRunSeed(contract, runId);

  const runDirFlag = args.flags.string("run-dir");
  const controlDir =
    runDirFlag === undefined
      ? path.resolve(args.context.cwd, ".oal", "serve", runId)
      : path.resolve(args.context.cwd, runDirFlag);
  if (
    runDirFlag !== undefined &&
    (await stat(controlDir).catch(() => null)) !== null
  ) {
    throw unsupported(
      ServeCliCode.ReadyStale,
      `Run directory already exists: ${controlDir}.`
    );
  }

  const session = await startServe({
    contract,
    capabilityReport: compiledSource.capabilityReport,
    host,
    port,
    runId,
    runSeed,
    controlDir,
    credentialsOut
  });
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
  if (session.credentialsPath !== null) {
    await rm(session.credentialsPath, { force: true }).catch(() => undefined);
  }
  await session.handle.close();
  return EXIT_OK;
};
