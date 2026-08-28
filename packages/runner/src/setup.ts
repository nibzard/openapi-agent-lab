/**
 * Trial setup (specification section 22.2). One call allocates the run
 * directory tree, opens the lifecycle ledger, derives the trial seed,
 * mints run credentials, starts the injected exposure, materializes the
 * participant prompts and workspace, freezes the rendered surface, and
 * writes the write-once `run.started.json`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  canonicalJsonSha256,
  formatRfc3339,
  isJsonObject,
  jsonClone,
  resolveJsonPointer,
  sha256Hex,
  type Json,
  type JsonObject
} from "@oal/core";
import type { LimitTable } from "@oal/config";
import type { ContractIR } from "@oal/contract-ir";
import type { SecuritySchemeIR } from "@oal/contract-ir";
import { splitRef } from "@oal/openapi";
import {
  EventStream,
  type ArtifactStore,
  type DocumentationExchange,
  type JsonlSink,
  type TraceEvent,
  type TrialLayout
} from "@oal/evidence";
import { mintRunCredentials, type RunCredentials } from "@oal/gateway";
import type { LoadedPack } from "@oal/pack";

import { TrialLifecycle, type Clock } from "./lifecycle.ts";
import { materializePrompts, type MaterializedPrompts } from "./prompts.ts";
import { resolveContext } from "./template.ts";
import {
  compileSurfaceManifest,
  verifySurface,
  type CompiledSurface
} from "./surface.ts";
import {
  materializeWorkspace,
  type MaterializedWorkspace
} from "./workspace.ts";
import {
  contractSettings,
  declaredBaseUrlEnvironment,
  declaredEnvironmentNames,
  type ContractSettings,
  type FrozenPlan
} from "./preflight.ts";

/** Stable setup error codes. */
export const SetupCode = {
  RunExists: "OAL-RUN-SETUP-RUN-EXISTS",
  ContractBytesMissing: "OAL-RUN-SETUP-CONTRACT-BYTES-MISSING",
  ExposureFailed: "OAL-RUN-SETUP-EXPOSURE-FAILED",
  ControlUnsafe: "OAL-RUN-SETUP-CONTROL-UNSAFE",
  SetupFailed: "OAL-RUN-SETUP-FAILED"
} as const;

/**
 * A trial-local setup defect. The ledger, when one exists, already holds
 * the terminal stage facts, so the caller only derives the disposition.
 */
export class TrialSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly runId: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "TrialSetupError";
  }
}

/**
 * One reserved slot in the trial trace stream. The same instance serves
 * the exposure and the trial runner, so sequences stay unique.
 */
export interface TraceWriter {
  reserve(): { sequence: number; event_id: string };
  complete(event: TraceEvent): Promise<void>;
}

/** One reserved slot in the documentation event stream. */
export interface DocumentationWriter {
  reserve(): { sequence: number; event_id: string };
  complete(event: DocumentationExchange): Promise<void>;
}

function traceWriterOf(sink: JsonlSink): TraceWriter {
  const stream = EventStream.open(sink, "req");
  return {
    reserve: (): { sequence: number; event_id: string } => stream.reserve(),
    complete: (event: TraceEvent): Promise<void> =>
      stream.complete(event as unknown as Json & { sequence: number })
  };
}

function documentationWriterOf(sink: JsonlSink): DocumentationWriter {
  const stream = EventStream.open(sink, "doc");
  return {
    reserve: (): { sequence: number; event_id: string } => stream.reserve(),
    complete: (event: DocumentationExchange): Promise<void> =>
      stream.complete(event as unknown as Json & { sequence: number })
  };
}

/**
 * One live exposure treatment. The runner owns the lifetime; the handle
 * never touches the artifact store or the state database.
 */
export interface ExposureHandle {
  /** Participant-visible API base URL. */
  readonly baseUrl: string;
  /**
   * Environment names that carry credentials. Names only: values never
   * appear here, in evidence, or in a manifest.
   */
  readonly credentialNames: readonly string[];
  /** Documentation facade base URL, or null when none is served. */
  readonly documentationUrl: string | null;
  /** MCP endpoint URL, or null when the treatment serves no catalog. */
  readonly mcpUrl: string | null;
  /** Server facts recorded verbatim in `server.json`. */
  readonly serverRecord: JsonObject;
  /** Number of exchanges that the exposure could not persist or complete. */
  readonly exchangeFailureCount?: number;
  /** Stop the exposure and release its port. Idempotent. */
  close(): Promise<void>;
}

/** Everything an exposure factory needs to bring one treatment up. */
export interface ExposureRequest {
  readonly batchId: string;
  readonly runId: string;
  readonly evalId: string;
  /** Trial seed; credentials and generated values derive from it. */
  readonly trialSeed: string;
  readonly contract: ContractIR;
  readonly limits: LimitTable;
  /** Bind host; the runner always passes a loopback address. */
  readonly host: string;
  /** Bind port; zero requests an ephemeral port. */
  readonly port: number;
  /** Injected clock, used for every recorded timestamp. */
  readonly now: Clock;
  /** The trial trace stream the exposure appends its exchanges to. */
  readonly trace: TraceWriter;
  /** The separate documentation stream. It never contributes to API metrics. */
  readonly documentationTrace?: DocumentationWriter;
  /** Exact run credential values. The redactor uses them before persistence. */
  readonly secrets?: readonly string[];
  /** Header names whose values the trace must redact. */
  readonly sensitiveHeaderNames: readonly string[];
  /** Key pattern strings whose matching names the trace must redact. */
  readonly sensitiveKeyPatterns: readonly string[];
}

/** Builds one exposure treatment per trial. Injected; never a socket. */
export type ExposureFactory = (
  request: ExposureRequest
) => Promise<ExposureHandle>;

/** Private control directory facts for one trial. */
export interface ControlLayout {
  readonly root: string;
  readonly homeDir: string;
  readonly temporaryDir: string;
  readonly credentialsPath: string;
  readonly readinessPath: string;
}

/** Everything trial execution needs after setup completes. */
export interface TrialSetup {
  readonly batchId: string;
  readonly runId: string;
  readonly index: number;
  readonly trialSeed: string;
  readonly layout: TrialLayout;
  readonly control: ControlLayout;
  readonly lifecycle: TrialLifecycle;
  readonly exposure: ExposureHandle;
  readonly prompts: MaterializedPrompts;
  readonly workspace: MaterializedWorkspace;
  readonly surface: CompiledSurface;
  readonly surfaceProblems: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
  readonly credentials: RunCredentials;
  readonly toolEnvironment: Readonly<Record<string, string>>;
  readonly launcherEnvironment: Readonly<Record<string, string>>;
  /** Trace stream; every reserved sequence must be completed. */
  readonly trace: TraceWriter;
  /** The write-once start record, as written to `run.started.json`. */
  readonly runStarted: JsonObject;
  readonly contractFilePlan: { filename: string; sha256: string } | null;
}

/** Options of {@link setupTrial}. */
export interface SetupTrialOptions {
  readonly store: ArtifactStore;
  readonly plan: FrozenPlan;
  readonly pack: LoadedPack;
  /** Zero-based trial index inside the batch. */
  readonly index: number;
  /** Exposure factory; the loopback gateway is the default. */
  readonly exposure: ExposureFactory;
  readonly now: Clock;
  /** Bind host override; defaults to loopback. */
  readonly host?: string | undefined;
  /** Bind port override; zero is the only safe default. */
  readonly port?: number | undefined;
  /** Retry lineage recorded with `run.created`, or null. */
  readonly retryOf?: string | null | undefined;
  /** Initialize a fresh Git repository in the workspace. Default false. */
  readonly gitInit?: boolean | undefined;
}

async function safeMkdir(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

/** Deterministic environment name of one credential alias. */
export function credentialEnvironmentName(alias: string): string {
  return `OAL_AUTH_${alias.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

/** Environment names for every scheme the contract declares. */
export function credentialEnvironmentNames(
  contract: ContractIR
): readonly string[] {
  const names = new Set<string>();
  for (const [name, scheme] of Object.entries(contract.security_schemes)) {
    names.add(credentialEnvironmentName(name));
    if (scheme.type === "http") {
      names.add("OAL_AUTH_BASIC_USERNAME");
      names.add("OAL_AUTH_BASIC_PASSWORD");
    }
  }
  names.add("OAL_AUTH_BEARER");
  return [...names].sort();
}

function credentialAliases(contract: ContractIR): readonly string[] {
  return Object.keys(contract.security_schemes).sort();
}

/**
 * Sibling documents of a multi-file contract, keyed by the same normalized
 * root-relative path the preflight froze.
 */
export interface ContractBundleInput {
  /** Root-relative path of the entrypoint document, for example
   * `contract/openapi.json`. */
  readonly entrypoint: string;
  /** Every document of the set, entrypoint included, keyed by normalized
   * root-relative path. */
  readonly documents: Readonly<Record<string, Json>>;
}

/** Component sections a bundled reference can land in. */
const COMPONENT_SECTIONS: ReadonlySet<string> = new Set([
  "schemas",
  "responses",
  "parameters",
  "examples",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
  "pathItems"
]);

/** Component names OpenAPI allows: word characters plus dots and dashes. */
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/u;

interface BundleState {
  readonly root: JsonObject;
  readonly documents: Readonly<Record<string, Json>>;
  readonly entryUri: string;
  /** Maps `uri + pointer` of an imported target to its internal ref. */
  readonly imported: Map<string, string>;
}

/**
 * Build the sanitized participant contract for `file` visibility: deep
 * clone the entrypoint document, strip external documentation links, point
 * every declared server entry at the live loopback base URL, and bundle
 * references that cross document boundaries into root components.
 */
export function sanitizeParticipantContract(
  document: Json,
  settings: ContractSettings,
  baseUrl: string,
  bundle?: ContractBundleInput
): { text: string; warnings: readonly string[] } {
  const warnings: string[] = [];
  const clone = jsonClone(isJsonObject(document) ? document : {});
  if (settings.stripExternalDocs) {
    delete clone["externalDocs"];
    const paths = isJsonObject(clone["paths"]) ? clone["paths"] : null;
    if (paths !== null) {
      for (const item of Object.values(paths)) {
        if (!isJsonObject(item)) {
          continue;
        }
        delete item["externalDocs"];
        for (const operation of Object.values(item)) {
          if (isJsonObject(operation)) {
            delete operation["externalDocs"];
          }
        }
      }
    }
  }
  if (settings.replaceServers) {
    replaceDeclaredServers(clone, baseUrl);
  }
  if (settings.bundleRefs && bundle !== undefined) {
    const state: BundleState = {
      root: clone,
      documents: bundle.documents,
      entryUri: bundle.entrypoint,
      imported: new Map()
    };
    rewriteRefsIn(clone, bundle.entrypoint, state, warnings);
  }
  if (settings.bundleRefs) {
    auditRefs(clone, warnings);
  }
  const text = canonicalJson(clone as Json);
  return { text, warnings: Object.freeze(warnings) };
}

/**
 * Replace every declared servers array — root, path item, and operation —
 * with the single live loopback entry.
 */
function replaceDeclaredServers(document: JsonObject, baseUrl: string): void {
  document["servers"] = [{ url: baseUrl }];
  const paths = isJsonObject(document["paths"]) ? document["paths"] : null;
  if (paths === null) {
    return;
  }
  for (const item of Object.values(paths)) {
    if (!isJsonObject(item)) {
      continue;
    }
    if ("servers" in item) {
      item["servers"] = [{ url: baseUrl }];
    }
    for (const operation of Object.values(item)) {
      if (isJsonObject(operation) && "servers" in operation) {
        operation["servers"] = [{ url: baseUrl }];
      }
    }
  }
}

/** Rewrite every `$ref` under `value` into an internal components ref. */
function rewriteRefsIn(
  value: Json,
  uri: string,
  state: BundleState,
  warnings: string[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rewriteRefsIn(item, uri, state, warnings);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const ref = value["$ref"];
  if (typeof ref === "string") {
    const internal = importTargetOf(ref, uri, state, warnings);
    if (internal !== null) {
      value["$ref"] = internal;
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$ref") {
      rewriteRefsIn(item, uri, state, warnings);
    }
  }
}

/**
 * Resolve one reference site. Returns the internal replacement, or null
 * when the reference must stay as it is.
 */
function importTargetOf(
  ref: string,
  uri: string,
  state: BundleState,
  warnings: string[]
): string | null {
  let target: { uri: string; pointer: string };
  try {
    target = splitRef(uri, ref);
  } catch {
    warnings.push(
      `The sanitized contract keeps a reference the policy refused: ${ref}.`
    );
    return null;
  }
  if (target.uri === state.entryUri) {
    // Root-internal references already resolve inside the entrypoint.
    return null;
  }
  return importDocument(target.uri, stripHash(target.pointer), state, warnings);
}

/** Hoist one cross-document target into root components. */
function importDocument(
  uri: string,
  pointer: string,
  state: BundleState,
  warnings: string[]
): string | null {
  const key = `${uri}#${pointer}`;
  const known = state.imported.get(key);
  if (known !== undefined) {
    return known;
  }
  const document = state.documents[uri];
  if (document === undefined) {
    warnings.push(
      `The sanitized contract cannot resolve ${key}: the document is absent.`
    );
    return null;
  }
  const value = resolveJsonPointer(document, pointer);
  if (value === undefined) {
    warnings.push(
      `The sanitized contract cannot resolve ${key}: the pointer is absent.`
    );
    return null;
  }
  const copy = jsonClone(value);
  if (!isJsonObject(copy)) {
    warnings.push(
      `The sanitized contract cannot bundle ${key}: the target is not an object.`
    );
    return null;
  }
  const slot = componentSlot(uri, pointer, state.root);
  const internal = `#/components/${slot.section}/${slot.name}`;
  // Register before the recursive copy so cyclic references terminate.
  state.imported.set(key, internal);
  rewriteRefsIn(copy, uri, state, warnings);
  const components = componentsOf(state.root);
  const section = isJsonObject(components[slot.section])
    ? (components[slot.section] as JsonObject)
    : {};
  components[slot.section] = section;
  section[slot.name] = copy;
  return internal;
}

/** Pick the components section and a free name for one imported target. */
function componentSlot(
  uri: string,
  pointer: string,
  root: JsonObject
): { section: string; name: string } {
  const match = /^\/components\/([^/]+)\/([^/]+)$/u.exec(pointer);
  const declaredSection = match === null ? undefined : match[1];
  const declaredName = match === null ? undefined : match[2];
  const section =
    declaredSection !== undefined && COMPONENT_SECTIONS.has(declaredSection)
      ? declaredSection
      : "schemas";
  const wanted =
    declaredName !== undefined && COMPONENT_NAME.test(declaredName)
      ? declaredName
      : slugName(uri, pointer);
  return { section, name: freeName(section, wanted, root) };
}

/** Build a valid component name from a pointer that has no natural one. */
function slugName(uri: string, pointer: string): string {
  const raw = `${uri}${pointer}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return raw === "" ? "bundled" : raw;
}

/** Suffix the name until it collides with no existing component. */
function freeName(section: string, name: string, root: JsonObject): string {
  const existing = sectionOf(root, section);
  if (existing === null || !(name in existing)) {
    return name;
  }
  let index = 2;
  while (`${name}--${index}` in existing) {
    index += 1;
  }
  return `${name}--${index}`;
}

function componentsOf(root: JsonObject): JsonObject {
  const components = isJsonObject(root["components"]) ? root["components"] : {};
  root["components"] = components;
  return components;
}

function sectionOf(root: JsonObject, section: string): JsonObject | null {
  const components = isJsonObject(root["components"])
    ? (root["components"] as JsonObject)
    : null;
  if (components === null) {
    return null;
  }
  const value = components[section];
  return isJsonObject(value) ? value : null;
}

function stripHash(pointer: string): string {
  return pointer.startsWith("#") ? pointer.slice(1) : pointer;
}

/**
 * Warn about every reference that survived bundling: pointers that resolve
 * nowhere inside the sanitized copy, and every external reference.
 */
function auditRefs(root: JsonObject, warnings: string[]): void {
  walkRefs(root, root, warnings);
}

function walkRefs(value: Json, root: JsonObject, warnings: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkRefs(item, root, warnings);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const ref = value["$ref"];
  if (typeof ref === "string" && !resolvesInRoot(ref, root)) {
    warnings.push(
      `The sanitized contract keeps an unresolved reference: ${ref}.`
    );
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$ref") {
      walkRefs(item, root, warnings);
    }
  }
}

/** True when the reference points inside `root` and the target exists. */
function resolvesInRoot(ref: string, root: JsonObject): boolean {
  if (ref === "#") {
    return true;
  }
  if (!ref.startsWith("#/")) {
    return false;
  }
  return resolveJsonPointer(root, stripHash(ref)) !== undefined;
}

function buildToolEnvironment(input: {
  contract: ContractIR;
  credentials: RunCredentials;
  baseUrl: string;
  baseUrlEnvironment: string | null;
  declaredNames: readonly string[];
}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const alias of credentialAliases(input.contract)) {
    const scheme: SecuritySchemeIR | undefined =
      input.contract.security_schemes[alias];
    const name = credentialEnvironmentName(alias);
    if (scheme === undefined) {
      continue;
    }
    if (scheme.type === "apiKey") {
      environment[name] = input.credentials.apiKeys[alias] ?? "";
    } else if (scheme.type === "http") {
      environment[`${name}_USERNAME`] = input.credentials.basic.username;
      environment[`${name}_PASSWORD`] = input.credentials.basic.password;
    } else {
      environment[name] = input.credentials.bearer;
    }
  }
  environment.OAL_AUTH_BEARER = input.credentials.bearer;
  const urlName =
    input.baseUrlEnvironment ??
    credentialEnvironmentName("base_url").replace("OAL_AUTH_", "OAL_");
  environment[urlName] = input.baseUrl;
  if (input.declaredNames.length === 0) {
    return environment;
  }
  // The pack declares the allow list, so only those names cross over.
  const allowed = new Set(input.declaredNames);
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowed.has(name)) {
      filtered[name] = value;
    }
  }
  return filtered;
}

function trialContextValues(input: {
  plan: FrozenPlan;
  pack: LoadedPack;
  settings: ContractSettings;
  runId: string;
  index: number;
  trialSeed: string;
  baseUrl: string;
  caseName: string | null;
  caseInput: JsonObject | null;
}): Record<string, string | number | boolean> {
  const metadata = isJsonObject(input.pack.manifest["metadata"])
    ? input.pack.manifest["metadata"]
    : null;
  const values: Record<string, string | number | boolean> = {
    "pack.name": typeof metadata?.["name"] === "string" ? metadata["name"] : "",
    "pack.version":
      typeof metadata?.["version"] === "string" ? metadata["version"] : "",
    "eval.id": input.plan.evalId,
    "run.id": input.runId,
    "run.index": input.index,
    "run.seed": input.trialSeed,
    "api.baseUrl": input.baseUrl,
    "api.contractFile": input.settings.filename,
    "exposure.mode": input.plan.exposureMode,
    "contract.visibility": input.plan.contractVisibility
  };
  if (input.caseName !== null) {
    values["case.name"] = input.caseName;
  }
  if (input.caseInput !== null) {
    for (const [key, value] of Object.entries(input.caseInput)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        values[`case.input.${key}`] = value;
      }
    }
  }
  return values;
}

/**
 * Set up one trial end to end. Throws only for a programmer error or an
 * unusable filesystem; the caller maps every failure into the trial
 * disposition.
 */
export async function setupTrial(
  options: SetupTrialOptions
): Promise<TrialSetup> {
  const { store, plan, pack, index, now } = options;
  const runId = plan.trialRunIds[index];
  if (runId === undefined) {
    throw new Error(`Trial index ${index} is outside the frozen batch.`);
  }
  const trialSeed = plan.trialSeeds[index];
  if (trialSeed === undefined) {
    throw new Error(`Trial ${runId} has no frozen seed.`);
  }

  // Steps 1 and 2: exclusive trial tree plus the private control tree.
  const relativeRoot = `runs/${plan.batchId}/trials/${runId}`;
  if (await store.exists(`${relativeRoot}/run.started.json`)) {
    throw new Error(`Trial ${runId} already started; a trial never resumes.`);
  }
  const layout = await store.initTrial(plan.batchId, runId);
  const controlRoot = store.resolve(`control/${plan.batchId}/${runId}`);
  const control: ControlLayout = {
    root: controlRoot,
    homeDir: path.join(controlRoot, "home"),
    temporaryDir: path.join(controlRoot, "tmp"),
    credentialsPath: path.join(controlRoot, "credentials.json"),
    readinessPath: path.join(controlRoot, "readiness.json")
  };
  await safeMkdir(control.homeDir);
  await safeMkdir(control.temporaryDir);

  // Step 3: open the ledger and record `scheduled`.
  const sink = await store.openSink(`${relativeRoot}/lifecycle.jsonl`);
  const lifecycle = TrialLifecycle.open(sink, {
    batchId: plan.batchId,
    runId
  });
  await lifecycle.created(runId, options.retryOf ?? null, now);
  await lifecycle.record("scheduled", "runner", { index }, now);

  // Step 5: mint the run credentials. Values stay in the control tree and
  // in the participant tool environment, never in evidence.
  const credentials = mintRunCredentials(plan.contract.ir, trialSeed);

  const settings = contractSettings(pack);
  // Create the trace artifact up front. A participant that makes no
  // request still leaves a complete, empty api trace behind.
  await store.writeOnce(`${relativeRoot}/trace.jsonl`, "");
  const trace = traceWriterOf(
    await store.openSink(`${relativeRoot}/trace.jsonl`)
  );
  await store.writeOnce(`${relativeRoot}/documentation.jsonl`, "");
  const documentationTrace = documentationWriterOf(
    await store.openSink(`${relativeRoot}/documentation.jsonl`)
  );

  // Step 8: start the exposure before any participant material exists.
  let exposure: ExposureHandle | null = null;
  const redaction = isJsonObject(pack.manifest["redaction"])
    ? pack.manifest["redaction"]
    : null;
  const headerNames = Array.isArray(redaction?.["header_names"])
    ? redaction["header_names"]
    : [];
  const keyPatterns = Array.isArray(redaction?.["key_patterns"])
    ? redaction["key_patterns"]
    : [];
  try {
    exposure = await options.exposure({
      batchId: plan.batchId,
      runId,
      evalId: plan.evalId,
      trialSeed,
      contract: plan.contract.ir,
      limits: plan.limits,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      now,
      trace,
      documentationTrace,
      secrets: [
        ...Object.values(credentials.apiKeys),
        credentials.basic.username,
        credentials.basic.password,
        credentials.bearer
      ],
      sensitiveHeaderNames: headerNames.filter(
        (name): name is string => typeof name === "string"
      ),
      sensitiveKeyPatterns: keyPatterns.filter(
        (name): name is string => typeof name === "string"
      )
    });
  } catch (cause) {
    await finalizeFailedSetup(lifecycle, now);
    throw new TrialSetupError(
      SetupCode.ExposureFailed,
      `Exposure for trial ${runId} failed to start: ${describeCause(cause)}`,
      runId,
      { cause }
    );
  }
  const liveExposure = exposure;

  // The private credentials file names the live base URL and the aliases.
  try {
    await writeFile(
      control.credentialsPath,
      `${canonicalJson({
        schema_version: 1,
        run_id: runId,
        base_url: liveExposure.baseUrl,
        schemes: credentialAliases(plan.contract.ir).map((alias) => ({
          scheme: alias,
          environment: credentialEnvironmentName(alias)
        }))
      } as Json)}\n`,
      { mode: 0o600, flag: "wx" }
    ).catch((cause: unknown) => {
      if (
        cause instanceof Error &&
        (cause as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        return;
      }
      throw cause;
    });

    // Step 10: materialize prompts and workspace against the live base URL.
    const caseIndex = index % Math.max(1, plan.evaluation.cases.length);
    const selectedCase =
      plan.evaluation.cases.length > 0
        ? (plan.evaluation.cases[caseIndex] ?? null)
        : null;
    const prompts = materializePrompts({
      pack,
      promptSetId: plan.promptSetId,
      evalId: plan.evalId,
      context: resolveContext({
        values: trialContextValues({
          plan,
          pack,
          settings,
          runId,
          index,
          trialSeed,
          baseUrl: liveExposure.baseUrl,
          caseName: selectedCase?.id ?? null,
          caseInput: selectedCase?.input ?? null
        }),
        ...(selectedCase === null
          ? {}
          : { caseInputKeys: Object.keys(selectedCase.input) })
      })
    });

    let sanitized: { text: string; warnings: readonly string[] } | null = null;
    if (plan.contractVisibility === "file") {
      const entry = pack.references.find(
        (reference) => reference.role === "contract_entrypoint"
      );
      if (entry?.document === null || entry === undefined) {
        throw new TrialSetupError(
          SetupCode.ContractBytesMissing,
          "Contract visibility is file but the pack entrypoint did not parse.",
          runId
        );
      }
      sanitized = sanitizeParticipantContract(
        entry.document,
        settings,
        liveExposure.baseUrl,
        {
          entrypoint: plan.contract.entrypoint,
          documents: plan.contract.documents
        }
      );
    }

    const workspace = await materializeWorkspace({
      workspaceDir: layout.workspaceDir,
      plan: prompts.files,
      contractVisibility: plan.contractVisibility,
      sanitizedContract: sanitized?.text ?? null,
      ...(plan.contractVisibility === "file"
        ? { contractFilename: settings.filename }
        : {}),
      ...(options.gitInit ? { gitInit: true } : {})
    });

    // Step 12: freeze the rendered surface and verify it against the tree.
    // The workspace plan is the prompt set plus the sanitized contract, and
    // the surface manifest must declare every file the workspace holds.
    const surface = compileSurfaceManifest({
      cellId: plan.evalId,
      runId,
      isTemplate: false,
      files: workspace.files
    });
    const surfaceProblems = await verifySurface(
      surface.manifest,
      layout.workspaceDir
    );
    await store.writeOnce(
      `${relativeRoot}/participant-surface-manifest.json`,
      `${canonicalJson(surface.manifest as Json)}\n`
    );
    await store.writeOnce(
      `${relativeRoot}/participant-surface-verification.json`,
      `${canonicalJson({
        schema_version: 1,
        kind: "ParticipantSurfaceVerification",
        run_id: runId,
        manifest_sha256: surface.manifestSha256,
        template_sha256: plan.surface.templateSha256,
        ok: surfaceProblems.length === 0,
        problems: surfaceProblems.map((problem) => ({
          code: problem.code,
          path: problem.path,
          message: problem.message
        }))
      } as unknown as Json)}\n`
    );

    // Step 13: record both facts, now that both are true.
    await lifecycle.record(
      "workspace_prepared",
      "filesystem",
      {
        files: prompts.files.length,
        ...(sanitized === null ? {} : { contract: settings.filename })
      },
      now
    );
    await lifecycle.record(
      "server_ready",
      "gateway",
      { base_url: liveExposure.baseUrl },
      now
    );

    // Server facts for evidence.
    await store.writeOnce(
      `${relativeRoot}/server.json`,
      `${canonicalJson(liveExposure.serverRecord)}\n`
    );

    const toolEnvironment = buildToolEnvironment({
      contract: plan.contract.ir,
      credentials,
      baseUrl: liveExposure.baseUrl,
      baseUrlEnvironment: declaredBaseUrlEnvironment(pack),
      declaredNames: declaredEnvironmentNames(pack)
    });
    const launcherEnvironment: Record<string, string> = {
      OAL_RUN_ID: runId,
      OAL_BATCH_ID: plan.batchId
    };

    // Step 14: the write-once start record. The canonical instructions
    // and task digests cover the same placeholder-rendered preview
    // batch.json froze, so the two records digest one canonical text and
    // stay comparable (section 24.3 write-once inputs). The live fields
    // pin what this trial rendered against its own base URL.
    const inputs: Record<string, string> = {
      pack_sha256: plan.pack.packSha256,
      contract_original_sha256: plan.contract.entrypointSha256,
      contract_semantic_sha256: plan.contract.semanticSha256,
      contract_execution_sha256: plan.contract.executionSha256,
      capability_report_sha256: plan.contract.capabilityReportSha256,
      run_profile_sha256: canonicalJsonSha256(plan.profile as unknown as Json),
      prompt_sha256: prompts.frozenSha256,
      instructions_sha256: sha256Hex(
        plan.promptPreview.prompts.instructions.text
      ),
      task_sha256: sha256Hex(plan.promptPreview.prompts.task.text),
      instructions_live_sha256: sha256Hex(prompts.prompts.instructions.text),
      task_live_sha256: sha256Hex(prompts.prompts.task.text),
      rubric_sha256: plan.evaluation.rubricSha256,
      ...(plan.evaluation.resultSchemaSha256 === null
        ? {}
        : { result_schema_sha256: plan.evaluation.resultSchemaSha256 })
    };
    const runStarted: JsonObject = {
      schema_version: 1,
      kind: "RunStarted",
      run_id: runId,
      batch_id: plan.batchId,
      started_at: formatRfc3339(now()),
      repetition_index: index,
      run_seed: plan.runSeed,
      server: {
        base_url: liveExposure.baseUrl,
        mode: plan.behaviorMode,
        ...(liveExposure.documentationUrl === null
          ? {}
          : { documentation_base_url: liveExposure.documentationUrl }),
        mcp: liveExposure.mcpUrl
      },
      inputs,
      participant_files: workspace.files.map((file) => ({
        path: file.target,
        sha256: file.sha256
      })),
      extensions: {
        exposure_mode: plan.exposureMode,
        contract_visibility: plan.contractVisibility,
        data_plane_scope: plan.dataPlaneScope,
        adapter_id: plan.adapter.id,
        trial_seed_id: trialSeed.slice(0, 12),
        credential_names: [...liveExposure.credentialNames],
        // What the adapter probe declared about its own enforcement. An
        // advisory level never masquerades as an enforced boundary.
        environment_separation: plan.adapter.probe.environmentSeparation,
        tool_network_policy: plan.adapter.probe.toolNetworkPolicy
      } as unknown as JsonObject
    };
    await store.writeOnce(
      `${relativeRoot}/run.started.json`,
      `${canonicalJson(runStarted as Json)}\n`
    );

    return {
      batchId: plan.batchId,
      runId,
      index,
      trialSeed,
      layout,
      control,
      lifecycle,
      exposure: liveExposure,
      prompts,
      workspace,
      surface,
      surfaceProblems,
      credentials,
      toolEnvironment,
      launcherEnvironment,
      trace,
      runStarted,
      contractFilePlan:
        plan.contractVisibility === "file"
          ? {
              filename: settings.filename,
              sha256: canonicalJsonSha256(sanitized?.text ?? "")
            }
          : null
    };
  } catch (cause) {
    await liveExposure.close().catch(() => undefined);
    if (cause instanceof TrialSetupError) {
      await finalizeFailedSetup(lifecycle, now);
      throw cause;
    }
    await finalizeFailedSetup(lifecycle, now);
    throw new TrialSetupError(
      SetupCode.SetupFailed,
      `Trial ${runId} setup failed: ${describeCause(cause)}`,
      runId,
      { cause }
    );
  }
}

/** Append the terminal stage facts of a setup that never spawned. */
async function finalizeFailedSetup(
  lifecycle: TrialLifecycle,
  now: Clock
): Promise<void> {
  await lifecycle.record(
    "finalization_started",
    "runner",
    { terminal: "invalid_setup" },
    now
  );
  await lifecycle.record(
    "evidence_finalized",
    "runner",
    { terminal: "invalid_setup" },
    now
  );
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
