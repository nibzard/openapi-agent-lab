/**
 * Batch-global preflight (specification section 22.1). Every check runs
 * before any paid model call: resolve the effective configuration, refuse
 * an existing batch, load and freeze the pack, compile the contract and
 * its capability report, check scenario completeness, materialize a prompt
 * preview, compile the rubric, probe the adapter, check exposure
 * compatibility, compute the paid-call plan, and require confirmation.
 */

import {
  canonicalJsonSha256,
  diagnostic,
  isJsonObject,
  isSafeId,
  parseJsonStrict,
  sha256Hex,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { CapabilityReport } from "@oal/capability";
import {
  LIMIT_DEFAULTS,
  PROFILE_LIMIT_DEFAULTS,
  resolveLimits,
  type LimitTable,
  type RunProfile
} from "@oal/config";
import type { ContractIR } from "@oal/contract-ir";
import type { ArtifactStore } from "@oal/evidence";
import type { AgentAdapter, AgentConfig, AgentProbe } from "@oal/agent-adapter";
import {
  loadEval,
  loadEvalCases,
  loadRubric,
  type Eval,
  type EvalCase
} from "@oal/evaluator";
import type { Rubric } from "@oal/evaluator";
import {
  compileOpenApi,
  loadDocumentSet,
  parseSafeYaml,
  resolveCompilerLimits
} from "@oal/openapi";
import {
  buildPackIr,
  contractIndexFromDocument,
  loadPack,
  validatePackInvariants,
  type LoadedPack,
  type OperationCoverage
} from "@oal/pack";
import { deriveRunSeed, deriveTrialSeed, runSeedId } from "@oal/state-store";

import { materializePrompts, type MaterializedPrompts } from "./prompts.ts";
import { resolveContext } from "./template.ts";
import { compileSurfaceManifest } from "./surface.ts";

/** Stable preflight diagnostic codes. */
export const PreflightCode = {
  BatchExists: "OAL-RUN-PREFLIGHT-BATCH-EXISTS",
  BatchIdUnsafe: "OAL-RUN-PREFLIGHT-BATCH-ID-UNSAFE",
  PackInvalid: "OAL-RUN-PREFLIGHT-PACK-INVALID",
  EvalUnknown: "OAL-RUN-PREFLIGHT-EVAL-UNKNOWN",
  ScenarioIncomplete: "OAL-RUN-PREFLIGHT-SCENARIO-INCOMPLETE",
  WorkflowUnsupported: "OAL-RUN-PREFLIGHT-WORKFLOW-UNSUPPORTED",
  ExposureIncompatible: "OAL-RUN-PREFLIGHT-EXPOSURE-INCOMPATIBLE",
  VisibilityUnsupported: "OAL-RUN-PREFLIGHT-VISIBILITY-UNSUPPORTED",
  AdapterUnusable: "OAL-RUN-PREFLIGHT-ADAPTER-UNUSABLE",
  LimitExceeded: "OAL-RUN-PREFLIGHT-LIMIT-EXCEEDED",
  ConfirmationRequired: "OAL-RUN-PREFLIGHT-CONFIRMATION-REQUIRED",
  NotConfirmed: "OAL-RUN-PREFLIGHT-NOT-CONFIRMED",
  PlanInvalid: "OAL-RUN-PREFLIGHT-PLAN-INVALID"
} as const;

/** Exposure modes of specification section 9.2. */
export type ExposureMode = "raw-http" | "direct-tools" | "catalog-tools";

/** Contract visibility treatments of specification section 9.4. */
export type ContractVisibility = "file" | "discoverable" | "tool-only" | "none";

/** Data-plane scope of specification section 9.2. */
export type DataPlaneScope = "all" | "task";

export const EXPOSURE_MODES: readonly ExposureMode[] = [
  "raw-http",
  "direct-tools",
  "catalog-tools"
];

export const CONTRACT_VISIBILITIES: readonly ContractVisibility[] = [
  "file",
  "discoverable",
  "tool-only",
  "none"
];

export const DATA_PLANE_SCOPES: readonly DataPlaneScope[] = ["all", "task"];

/** Options of {@link runPreflight}. */
export interface PreflightOptions {
  /** Pack directory. */
  readonly packDir: string;
  /**
   * The pack at `packDir`, when the caller already loaded it. Passing it
   * keeps preflight and the batch freeze on one set of bytes.
   */
  readonly loadedPack?: LoadedPack | undefined;
  /** Eval identifier inside the pack. */
  readonly evalId: string;
  /** Batch identifier; must not exist yet. */
  readonly batchId: string;
  /** Evidence store that owns the batch directory. */
  readonly store: ArtifactStore;
  /** Adapter that runs every trial. */
  readonly adapter: AgentAdapter;
  /** Adapter configuration, when the adapter needs one. */
  readonly adapterConfig?: AgentConfig | undefined;
  /** Exposure mode; default is the capability report recommendation. */
  readonly exposureMode?: ExposureMode | undefined;
  /** Contract visibility; default `file`. */
  readonly contractVisibility?: ContractVisibility | undefined;
  /** Data-plane scope; default `all`. */
  readonly dataPlaneScope?: DataPlaneScope | undefined;
  /** Scenario override for the eval default. */
  readonly scenarioId?: string | undefined;
  /** Trial count; default 1. */
  readonly count?: number | undefined;
  /** Parallel trial bound; default 1. */
  readonly parallel?: number | undefined;
  /** Trial wall-time limit in milliseconds. */
  readonly trialWallTimeMs?: number | undefined;
  /** Operator cohort seed; default derives from the batch identifier. */
  readonly cohortSeed?: string | undefined;
  /** Model identifier handed to the adapter. */
  readonly model?: string | undefined;
  /** Reasoning effort handed to the adapter. */
  readonly effort?: string | undefined;
  /** Sandbox mode handed to the adapter. */
  readonly sandbox?: string | undefined;
  /** Limit overrides. A value above a ceiling fails preflight. */
  readonly limitOverrides?: Partial<Record<string, number>> | undefined;
  /**
   * Whether the adapter makes paid model calls. Set false for the mock
   * adapter, so a local run needs no paid confirmation.
   */
  readonly paid?: boolean | undefined;
  /** Paid-call confirmation. Called after every other check passed. */
  readonly confirmPaid?:
    | ((plan: PaidCallPlan) => boolean | Promise<boolean>)
    | undefined;
  /** Directory holding the `*.schema.json` documents. */
  readonly schemaDir?: string | undefined;
}

/** The paid-call and resource plan preflight prints before confirmation. */
export interface PaidCallPlan {
  readonly paid: boolean;
  readonly trials: number;
  readonly maxAgentLaunches: number;
  readonly trialWallTimeMs: number;
  readonly maxApiRequestsPerTrial: number;
  readonly maxAgentToolCallsPerTrial: number;
  readonly maxArtifactsBytesPerTrial: number;
  readonly trialRunIds: readonly string[];
  readonly adapterId: string;
  readonly model: string | null;
  /** This build estimates no cost; the field stays null. */
  readonly estimatedCostValue: number | null;
  readonly estimatedCostCurrency: string | null;
}

/** Every input the batch freezes before the first trial starts. */
export interface FrozenPlan {
  readonly batchId: string;
  readonly evalId: string;
  readonly promptSetId: string;
  readonly scenarioId: string;
  readonly behaviorMode: "contract" | "scenario";
  readonly exposureMode: ExposureMode;
  readonly contractVisibility: ContractVisibility;
  readonly dataPlaneScope: DataPlaneScope;
  readonly paid: boolean;
  readonly count: number;
  readonly parallel: number;
  readonly trialWallTimeMs: number;
  readonly cohortSeed: string;
  readonly runSeed: string;
  readonly runSeedIdentifier: string;
  readonly trialRunIds: readonly string[];
  readonly trialSeeds: readonly string[];
  readonly limits: LimitTable;
  readonly pack: {
    readonly root: string;
    readonly manifestName: string;
    readonly manifestSha256: string;
    readonly packSha256: string;
    readonly packIr: JsonObject | null;
    readonly packIrSha256: string;
    readonly coverage: OperationCoverage;
  };
  readonly contract: {
    readonly entrypoint: string;
    readonly entrypointSha256: string;
    readonly semanticSha256: string;
    readonly executionSha256: string;
    readonly ir: ContractIR;
    /** Parsed document set of the contract, keyed by root-relative path.
     * Sibling documents exist only when the contract spans files. */
    readonly documents: Readonly<Record<string, Json>>;
    readonly capabilityReport: CapabilityReport;
    readonly capabilityReportSha256: string;
  };
  readonly surface: {
    readonly template: JsonObject;
    readonly templateSha256: string;
  };
  /**
   * Prompt preview rendered with a placeholder base URL. Trial setup
   * renders the real per-trial prompts once the server is listening.
   */
  readonly promptPreview: MaterializedPrompts;
  readonly evaluation: {
    readonly evalDoc: Eval;
    readonly cases: readonly EvalCase[];
    readonly rubric: Rubric;
    readonly rubricSha256: string;
    readonly resultSchema: Json | null;
    readonly resultSchemaSha256: string | null;
  };
  readonly adapter: {
    readonly id: string;
    readonly probe: AgentProbe;
    readonly model: string | null;
    readonly effort: string | null;
    readonly sandbox: string | null;
  };
  readonly profile: RunProfile;
  readonly paidCallPlan: PaidCallPlan;
}

/** Result of one preflight pass. */
export interface PreflightResult {
  /** True when no finding carries error severity. */
  readonly ok: boolean;
  /** Every finding; all carry phase `preflight`. */
  readonly findings: readonly Diagnostic[];
  /** Frozen plan, or null when any check failed. */
  readonly plan: FrozenPlan | null;
}

function error(code: string, message: string, details?: Json): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "preflight",
    code,
    message,
    ...(details === undefined ? {} : { details })
  });
}

function warn(code: string, message: string, details?: Json): Diagnostic {
  return diagnostic({
    severity: "warning",
    phase: "preflight",
    code,
    message,
    ...(details === undefined ? {} : { details })
  });
}

function failed(findings: readonly Diagnostic[]): boolean {
  return findings.some((entry) => entry.severity === "error");
}

/** Deterministic run ID of trial `index` inside one batch. */
export function batchTrialRunId(batchId: string, index: number): string {
  return `${batchId}-run-${String(index + 1).padStart(2, "0")}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Parse one contract document: JSON first, safe YAML second. */
function parseDocumentText(relative: string, text: string): Json {
  try {
    return parseJsonStrict(text);
  } catch {
    try {
      return parseSafeYaml(text);
    } catch (cause) {
      throw new Error(
        `Document ${relative} parses as neither JSON nor YAML: ${describe(cause)}`
      );
    }
  }
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function section(holder: JsonObject, key: string): JsonObject | null {
  const value = holder[key];
  return isJsonObject(value) ? value : null;
}

function manifestSection(pack: LoadedPack, key: string): JsonObject | null {
  return section(pack.manifest, key);
}

/** One pack reference by pack-relative path, or null when absent. */
export function packReferenceOf(
  pack: LoadedPack,
  path: string
): { sha256: string; document: Json | null; text: string | null } | null {
  for (const reference of pack.references) {
    if (reference.path === path) {
      return reference;
    }
  }
  return null;
}

/**
 * Parsed document of one pack asset, or undefined when absent. The same
 * path can carry two references, and the first wins in
 * {@link packReferenceOf}: a text-only participant file ahead of a parsed
 * schema document. Text copies therefore parse here as JSON.
 */
export function packDocumentOf(
  pack: LoadedPack,
  path: string
): Json | undefined {
  const found = packReferenceOf(pack, path);
  if (found === null) {
    return undefined;
  }
  if (found.document !== null) {
    return found.document;
  }
  if (found.text === null) {
    return undefined;
  }
  try {
    return parseJsonStrict(found.text);
  } catch {
    return undefined;
  }
}

/** Digest over the pack identity plus every referenced asset. */
export function packFreezeDigest(pack: LoadedPack): string {
  return sha256Hex(
    [
      pack.manifestName,
      pack.manifestSha256,
      ...pack.references.map(
        (reference) => `${reference.role}:${reference.path}:${reference.sha256}`
      )
    ].join("\n")
  );
}

/** Declared participant contract settings of one pack. */
export interface ContractSettings {
  readonly filename: string;
  readonly bundleRefs: boolean;
  readonly replaceServers: boolean;
  readonly stripExternalDocs: boolean;
}

export function contractSettings(pack: LoadedPack): ContractSettings {
  const copy = manifestSection(pack, "contract")?.["participant_copy"];
  const declared = isJsonObject(copy) ? copy : null;
  return {
    filename: str(declared?.["filename"]) ?? "openapi.json",
    bundleRefs: declared?.["bundle_refs"] !== false,
    replaceServers: declared?.["replace_servers"] !== false,
    stripExternalDocs: declared?.["external_docs"] !== "keep"
  };
}

/** Participant environment names the pack declares. */
export function declaredEnvironmentNames(pack: LoadedPack): readonly string[] {
  const environment = manifestSection(pack, "participant")?.["environment"];
  const declared = isJsonObject(environment) ? environment : null;
  const allow = declared?.["allow"];
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow.filter((name): name is string => typeof name === "string");
}

/** Base URL environment name the pack declares, when it declares one. */
export function declaredBaseUrlEnvironment(pack: LoadedPack): string | null {
  return str(manifestSection(pack, "security")?.["base_url_environment"]);
}

interface CompiledEval {
  readonly evalDoc: Eval;
  readonly cases: readonly EvalCase[];
  readonly rubric: Rubric;
  readonly rubricSha256: string;
  readonly resultSchema: Json | null;
  readonly resultSchemaSha256: string | null;
}

function compileEvalDocuments(
  pack: LoadedPack,
  evalId: string,
  findings: Diagnostic[]
): CompiledEval | null {
  const entries = pack.manifest["evals"];
  const list = Array.isArray(entries) ? entries : [];
  let declared: JsonObject | null = null;
  for (const entry of list) {
    if (isJsonObject(entry) && entry["id"] === evalId) {
      declared = entry;
      break;
    }
  }
  if (declared === null) {
    findings.push(
      error(
        PreflightCode.EvalUnknown,
        `Pack declares no eval with id ${evalId}.`,
        { eval_id: evalId }
      )
    );
    return null;
  }
  if (declared["workflow"] !== undefined || declared["arazzo"] !== undefined) {
    findings.push(
      error(
        PreflightCode.WorkflowUnsupported,
        `Eval ${evalId} references a workflow, and this build ships no Arazzo engine.`,
        { eval_id: evalId }
      )
    );
    return null;
  }

  const resolveText = (reference: string): string | undefined =>
    packReferenceOf(pack, reference)?.text ?? undefined;
  const resolveDocument = (reference: string): Json | undefined =>
    packDocumentOf(pack, reference);

  const loaded = loadEval(declared as Json, {
    resolveText,
    resolveDocument,
    documentUri: `${pack.root}/${pack.manifestName}#/evals/${evalId}`
  });
  findings.push(...loaded.diagnostics);
  if (loaded.eval === null) {
    return null;
  }
  const evaluation = loaded.eval;

  const rubricPath = str(declared["rubric"]);
  const rubricReference =
    rubricPath === null ? null : packReferenceOf(pack, rubricPath);
  if (
    rubricReference === null ||
    rubricReference.document === null ||
    rubricReference.sha256 === ""
  ) {
    findings.push(
      error(
        PreflightCode.PackInvalid,
        `Eval ${evalId} declares rubric ${rubricPath ?? "none"}, which the pack did not load.`,
        { eval_id: evalId }
      )
    );
    return null;
  }
  const rubricLoaded = loadRubric(rubricReference.document, {
    resolveSchema: resolveDocument,
    documentUri: `${pack.root}/${rubricPath ?? "rubric"}`
  });
  findings.push(...rubricLoaded.diagnostics);
  if (rubricLoaded.rubric === null) {
    return null;
  }

  const cases: EvalCase[] = [];
  if (evaluation.cases !== undefined) {
    const source = packReferenceOf(pack, evaluation.cases.source);
    if (source === null || source.text === null) {
      findings.push(
        error(
          PreflightCode.PackInvalid,
          `Eval ${evalId} declares case source ${evaluation.cases.source}, which the pack did not load.`,
          { eval_id: evalId }
        )
      );
      return null;
    }
    // The pack case schema governs the input object, and loadEval above
    // already validated every input against it. This pass loads the
    // lines structurally; the repository eval-case schema governs the
    // line shape when a caller supplies it.
    const loadedCases = loadEvalCases(source.text, {
      documentUri: `${pack.root}/${evaluation.cases.source}`
    });
    findings.push(...loadedCases.diagnostics);
    cases.push(...loadedCases.cases);
  }

  const resultReference = packReferenceOf(pack, evaluation.result.schema);
  const resultSchema = resolveDocument(evaluation.result.schema) ?? null;
  if (resultReference === null || resultSchema === null) {
    findings.push(
      error(
        PreflightCode.PackInvalid,
        `Eval ${evalId} declares result schema ${evaluation.result.schema}, which the pack did not load.`,
        { eval_id: evalId }
      )
    );
    return null;
  }

  return {
    evalDoc: evaluation,
    cases: Object.freeze(cases),
    rubric: rubricLoaded.rubric,
    rubricSha256: rubricReference.sha256,
    resultSchema,
    resultSchemaSha256: resultReference.sha256
  };
}

/** Render the prompt preview with a placeholder loopback base URL. */
function previewPrompts(
  pack: LoadedPack,
  settings: ContractSettings,
  plan: {
    readonly promptSetId: string;
    readonly evalId: string;
    readonly exposureMode: ExposureMode;
    readonly contractVisibility: ContractVisibility;
    readonly runSeed: string;
  },
  firstCase: EvalCase | null,
  findings: Diagnostic[]
): MaterializedPrompts | null {
  const metadata = manifestSection(pack, "metadata");
  const values: Record<string, string | number | boolean> = {
    "pack.name": str(metadata?.["name"]) ?? "",
    "pack.version": str(metadata?.["version"]) ?? "",
    "eval.id": plan.evalId,
    "run.id": "preview",
    "run.index": 0,
    "run.seed": plan.runSeed,
    "api.baseUrl": "http://127.0.0.1:0",
    "api.contractFile": settings.filename,
    "exposure.mode": plan.exposureMode,
    "contract.visibility": plan.contractVisibility
  };
  if (firstCase !== null) {
    values["case.name"] = firstCase.id;
    for (const [key, value] of Object.entries(firstCase.input)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        values[`case.input.${key}`] = value;
      }
    }
  }
  try {
    const context = resolveContext({
      values,
      ...(firstCase === null
        ? {}
        : { caseInputKeys: Object.keys(firstCase.input) })
    });
    return materializePrompts({
      pack,
      promptSetId: plan.promptSetId,
      evalId: plan.evalId,
      context
    });
  } catch (cause) {
    findings.push(
      error(
        PreflightCode.PackInvalid,
        `Prompt materialization failed: ${describe(cause)}`,
        { eval_id: plan.evalId }
      )
    );
    return null;
  }
}

/** Map an adapter identifier onto the run-profile adapter enum. */
export function adapterKindOf(
  adapterId: string
): RunProfile["agent"]["adapter"] {
  return adapterId === "codex-cli" ? "codex-cli" : "generic";
}

function normalizeEffort(
  effort: string | undefined
): RunProfile["agent"]["effort"] {
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  return null;
}

function normalizeSandbox(
  sandbox: string | undefined
): RunProfile["agent"]["sandbox"] {
  if (
    sandbox === "danger-full-access" ||
    sandbox === "workspace-write" ||
    sandbox === "read-only"
  ) {
    return sandbox;
  }
  return null;
}

/** Schema visibility: the frozen records know three values. */
export function schemaVisibility(
  visibility: ContractVisibility
): "none" | "file" | "discoverable" {
  return visibility === "tool-only" ? "none" : visibility;
}

/**
 * Run every batch-global check. The function never throws for pack,
 * contract, eval, rubric, exposure, adapter, or confirmation problems:
 * each becomes a diagnostic. It throws only for a programmer error such
 * as an unsafe batch identifier.
 */
export async function runPreflight(
  options: PreflightOptions
): Promise<PreflightResult> {
  const findings: Diagnostic[] = [];

  if (!isSafeId(options.batchId)) {
    throw new Error(
      `Batch identifier is not safe: ${JSON.stringify(options.batchId)}.`
    );
  }

  // Step 2: refuse an existing batch identifier.
  if (await options.store.exists(`runs/${options.batchId}/batch.json`)) {
    findings.push(
      error(
        PreflightCode.BatchExists,
        `Batch ${options.batchId} already exists. Existing batch identifiers are always refused.`,
        { batch_id: options.batchId }
      )
    );
  }

  // Step 3: load and freeze the pack.
  const pack =
    options.loadedPack ??
    (await loadPack(options.packDir, {
      ...(options.schemaDir === undefined
        ? {}
        : { schemaDir: options.schemaDir })
    }));
  findings.push(...pack.diagnostics);
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  const entryDocument =
    entry?.document !== null && entry?.document !== undefined
      ? isJsonObject(entry.document)
        ? entry.document
        : null
      : null;
  const built = buildPackIr(pack);
  findings.push(...built.diagnostics);
  findings.push(
    ...validatePackInvariants({
      loaded: pack,
      index: contractIndexFromDocument(entryDocument ?? {}),
      coverage: built.coverage
    })
  );

  // Step 4: compile the contract and the capability report.
  let contractIr: ContractIR | null = null;
  let capability: CapabilityReport | null = null;
  let bundleDocuments: Record<string, Json> | null = null;
  if (entry === undefined || entry.bytes === 0) {
    findings.push(
      error(
        PreflightCode.PackInvalid,
        "The pack declares no readable contract entrypoint."
      )
    );
  } else {
    try {
      const set = await loadDocumentSet(
        pack.root,
        entry.path,
        resolveCompilerLimits()
      );
      const documents: Record<string, string> = {};
      const parsed: Record<string, Json> = {};
      for (const [relative, text] of set.documents) {
        documents[relative] = text;
        parsed[relative] = parseDocumentText(relative, text);
      }
      const compiled = compileOpenApi({ documents, entrypoint: entry.path });
      findings.push(...compiled.contract.diagnostics);
      contractIr = compiled.contract;
      capability = compiled.report;
      bundleDocuments = parsed;
    } catch (cause) {
      findings.push(
        error(
          PreflightCode.PackInvalid,
          `The contract document set did not compile: ${describe(cause)}`
        )
      );
    }
  }
  if (contractIr === null || capability === null || built.ir === null) {
    return { ok: false, findings, plan: null };
  }
  const ir = built.ir;
  const contract = section(ir, "contract");
  const executionSha256 = str(contract?.["execution_sha256"]) ?? "";
  const semanticSha256 = str(contract?.["semantic_sha256"]) ?? "";

  // Steps 6 and 7: eval, cases, rubric.
  const compiledEval = compileEvalDocuments(pack, options.evalId, findings);
  if (compiledEval === null) {
    return { ok: false, findings, plan: null };
  }

  // Step 5: scenario completeness. The eval loader already requires the
  // scenario field, so no fallback applies here.
  const scenarioId = options.scenarioId ?? compiledEval.evalDoc.scenario;
  const scenarioEntries = pack.manifest["scenarios"];
  const scenarioList = Array.isArray(scenarioEntries) ? scenarioEntries : [];
  const scenarioIds = scenarioList
    .filter((candidate): candidate is JsonObject => isJsonObject(candidate))
    .map((candidate) => str(candidate["id"]))
    .filter((id): id is string => id !== null);
  const behaviorMode: "contract" | "scenario" =
    str(manifestSection(pack, "behavior")?.["mode"]) === "scenario"
      ? "scenario"
      : "contract";
  if (behaviorMode === "scenario" && !scenarioIds.includes(scenarioId)) {
    findings.push(
      error(
        PreflightCode.ScenarioIncomplete,
        `Eval ${options.evalId} needs scenario ${scenarioId}, which the pack does not declare.`,
        { scenario_id: scenarioId, declared: scenarioIds }
      )
    );
  }
  if (behaviorMode === "contract" && options.scenarioId !== undefined) {
    findings.push(
      warn(
        PreflightCode.ScenarioIncomplete,
        `Scenario override ${options.scenarioId} was ignored: the pack runs in contract mode.`,
        { scenario_id: options.scenarioId }
      )
    );
  }

  // Step 10: limits and resource ceilings.
  let limits: LimitTable = LIMIT_DEFAULTS;
  try {
    limits = resolveLimits({ ...(options.limitOverrides ?? {}) });
  } catch (cause) {
    findings.push(
      error(
        PreflightCode.LimitExceeded,
        `A requested limit is invalid: ${describe(cause)}`,
        { requested: { ...(options.limitOverrides ?? {}) } as Json }
      )
    );
  }
  const count = options.count ?? 1;
  const parallel = options.parallel ?? 1;
  const trialWallTimeMs = options.trialWallTimeMs ?? limits.trialWallTimeMs;
  if (!Number.isInteger(count) || count < 1) {
    findings.push(
      error(PreflightCode.PlanInvalid, "Trial count must be at least 1.", {
        count
      })
    );
  }
  if (!Number.isInteger(parallel) || parallel < 1) {
    findings.push(
      error(
        PreflightCode.PlanInvalid,
        "Parallel trial bound must be at least 1.",
        { parallel }
      )
    );
  }
  if (count > limits.maxBatchTrials) {
    findings.push(
      error(
        PreflightCode.LimitExceeded,
        `Trial count ${count} exceeds the batch ceiling ${limits.maxBatchTrials}.`,
        { count, ceiling: limits.maxBatchTrials }
      )
    );
  }
  if (parallel > limits.maxParallelTrials) {
    findings.push(
      error(
        PreflightCode.LimitExceeded,
        `Parallel bound ${parallel} exceeds the ceiling ${limits.maxParallelTrials}.`,
        { parallel, ceiling: limits.maxParallelTrials }
      )
    );
  }
  if (trialWallTimeMs > limits.trialWallTimeMs) {
    findings.push(
      error(
        PreflightCode.LimitExceeded,
        `Trial wall time ${trialWallTimeMs} ms exceeds the ceiling ${limits.trialWallTimeMs} ms.`,
        {
          trial_wall_time_ms: trialWallTimeMs,
          ceiling: limits.trialWallTimeMs
        }
      )
    );
  }
  if (failed(findings)) {
    return { ok: false, findings, plan: null };
  }

  // Step 8: adapter probe.
  let probe: AgentProbe | null = null;
  try {
    probe = await options.adapter.probe(options.adapterConfig ?? {});
  } catch (cause) {
    findings.push(
      error(
        PreflightCode.AdapterUnusable,
        `Adapter probe threw: ${describe(cause)}`,
        { adapter_id: options.adapter.id }
      )
    );
  }
  if (probe !== null && probe.status !== "available") {
    findings.push(
      error(
        PreflightCode.AdapterUnusable,
        `Adapter ${options.adapter.id} is ${probe.status}: ${probe.error ?? "no reason reported"}.`,
        {
          adapter_id: options.adapter.id,
          ...(probe.errorCode === undefined
            ? {}
            : { error_code: probe.errorCode })
        }
      )
    );
  }
  if (failed(findings) || probe === null) {
    return { ok: false, findings, plan: null };
  }

  // Step 9: exposure compatibility. An operator request stays as asked. When
  // the pack recommendation needs MCP and the adapter serves none, fall back
  // to raw-http and record a warning instead of blocking the run.
  let exposureMode: ExposureMode =
    options.exposureMode ?? capability.recommendations.recommended_exposure;
  if (
    (exposureMode === "direct-tools" || exposureMode === "catalog-tools") &&
    !probe.capabilities.mcp
  ) {
    if (options.exposureMode === undefined) {
      findings.push(
        warn(
          PreflightCode.ExposureIncompatible,
          `Adapter ${options.adapter.id} reports no MCP support, so the recommended exposure mode ${exposureMode} falls back to raw-http.`,
          {
            adapter_id: options.adapter.id,
            exposure_mode: exposureMode,
            fallback_mode: "raw-http"
          }
        )
      );
      exposureMode = "raw-http";
    } else {
      findings.push(
        error(
          PreflightCode.ExposureIncompatible,
          `Adapter ${options.adapter.id} reports no MCP support, which exposure mode ${exposureMode} requires.`,
          { adapter_id: options.adapter.id, exposure_mode: exposureMode }
        )
      );
    }
  }
  if (exposureMode === "direct-tools") {
    for (const reason of capability.recommendations.direct_tools.reason_codes) {
      findings.push(
        warn(
          PreflightCode.ExposureIncompatible,
          `Direct-tools exposure is limited: ${reason}.`,
          { reason_code: reason }
        )
      );
    }
    if (!capability.recommendations.direct_tools.viable) {
      findings.push(
        error(
          PreflightCode.ExposureIncompatible,
          "Exposure mode direct-tools is not viable for this contract.",
          {
            exposure_mode: exposureMode,
            reason_codes: capability.recommendations.direct_tools.reason_codes
          }
        )
      );
    }
  }
  if (
    exposureMode === "catalog-tools" &&
    !capability.recommendations.catalog_tools.viable
  ) {
    findings.push(
      error(
        PreflightCode.ExposureIncompatible,
        "Exposure mode catalog-tools is not viable for this contract.",
        {
          exposure_mode: exposureMode,
          reason_codes: capability.recommendations.catalog_tools.reason_codes
        }
      )
    );
  }
  const contractVisibility: ContractVisibility =
    options.contractVisibility ?? "file";
  if (contractVisibility === "discoverable" && exposureMode !== "raw-http") {
    findings.push(
      error(
        PreflightCode.VisibilityUnsupported,
        "Contract visibility discoverable needs the raw HTTP documentation facade, and this exposure mode serves none.",
        {
          contract_visibility: contractVisibility,
          exposure_mode: exposureMode
        }
      )
    );
  }
  if (failed(findings)) {
    return { ok: false, findings, plan: null };
  }

  // Prompt preview, surface template, and the run seed.
  const settings = contractSettings(pack);
  const cohortSeed = options.cohortSeed ?? `batch:${options.batchId}`;
  const provisionalSeed = sha256Hex(`preview:${options.batchId}`);
  const promptPreview = previewPrompts(
    pack,
    settings,
    {
      promptSetId: compiledEval.evalDoc.prompt_set,
      evalId: options.evalId,
      exposureMode,
      contractVisibility,
      runSeed: provisionalSeed
    },
    compiledEval.cases[0] ?? null,
    findings
  );
  if (promptPreview === null) {
    return { ok: false, findings, plan: null };
  }
  const surface = compileSurfaceManifest({
    cellId: options.evalId,
    runId: null,
    isTemplate: true,
    files: promptPreview.files
  });
  const firstCase = compiledEval.cases[0] ?? null;
  const runSeed = deriveRunSeed({
    contractExecutionSha256: executionSha256,
    participantSurfaceTemplateSha256: surface.manifestSha256,
    packSha256: packFreezeDigest(pack),
    scenario:
      behaviorMode === "scenario" && scenarioIds.includes(scenarioId)
        ? { id: scenarioId, sha256: sha256Hex(scenarioId) }
        : null,
    behaviorSha256: sha256Hex(behaviorMode),
    eval: { id: options.evalId, sha256: sha256Hex(options.evalId) },
    case:
      firstCase === null
        ? null
        : { id: firstCase.id, sha256: sha256Hex(firstCase.id) },
    cohortSeed,
    assignment: { kind: "primary", index: 0 }
  });

  const trialRunIds = Array.from({ length: count }, (_, index) =>
    batchTrialRunId(options.batchId, index)
  );
  const trialSeeds = trialRunIds.map((id, index) =>
    deriveTrialSeed(runSeed, { index, id })
  );

  const packLimits = section(ir, "limits");
  const profile: RunProfile = {
    apiVersion: "agentlab.dev/v1",
    kind: "RunProfile",
    metadata: { id: options.evalId },
    agent: {
      adapter: adapterKindOf(options.adapter.id),
      model: options.model ?? null,
      effort: normalizeEffort(options.effort),
      sandbox: normalizeSandbox(options.sandbox)
    },
    exposure: {
      mode: exposureMode,
      contract_visibility: schemaVisibility(contractVisibility),
      data_plane_scope: options.dataPlaneScope ?? "all",
      documentation_profile: null
    },
    execution: {
      count,
      parallel,
      timeout_ms: trialWallTimeMs,
      cohort_seed: cohortSeed,
      confirm_paid_calls: options.paid ?? true
    },
    evaluation: {
      model_judge: "disabled",
      fail_on: { required_check: true, infrastructure: true }
    },
    limits: {
      max_agent_tool_calls:
        typeof packLimits?.["max_agent_tool_calls"] === "number"
          ? packLimits["max_agent_tool_calls"]
          : PROFILE_LIMIT_DEFAULTS.max_agent_tool_calls,
      max_api_requests:
        typeof packLimits?.["max_api_requests"] === "number"
          ? packLimits["max_api_requests"]
          : PROFILE_LIMIT_DEFAULTS.max_api_requests,
      max_artifact_bytes:
        typeof packLimits?.["max_artifact_bytes"] === "number"
          ? packLimits["max_artifact_bytes"]
          : PROFILE_LIMIT_DEFAULTS.max_artifact_bytes
    }
  };

  const paid = options.paid ?? true;
  const paidCallPlan: PaidCallPlan = {
    paid,
    trials: count,
    maxAgentLaunches: count,
    trialWallTimeMs,
    maxApiRequestsPerTrial: limits.maxRequestsPerRun,
    maxAgentToolCallsPerTrial: profile.limits.max_agent_tool_calls,
    maxArtifactsBytesPerTrial: profile.limits.max_artifact_bytes,
    trialRunIds: Object.freeze([...trialRunIds]),
    adapterId: options.adapter.id,
    model: options.model ?? null,
    estimatedCostValue: null,
    estimatedCostCurrency: null
  };

  // Step 11: confirmation for paid runs.
  if (paid) {
    if (options.confirmPaid === undefined) {
      findings.push(
        error(
          PreflightCode.ConfirmationRequired,
          `Adapter ${options.adapter.id} makes paid model calls, and no confirmation callback was supplied.`,
          { adapter_id: options.adapter.id }
        )
      );
    } else if (!(await options.confirmPaid(paidCallPlan))) {
      findings.push(
        error(
          PreflightCode.NotConfirmed,
          "The operator did not confirm the paid-call plan, so no trial starts.",
          { batch_id: options.batchId }
        )
      );
    }
  }

  if (failed(findings)) {
    return { ok: false, findings, plan: null };
  }

  return {
    ok: true,
    findings,
    plan: {
      batchId: options.batchId,
      evalId: options.evalId,
      promptSetId: compiledEval.evalDoc.prompt_set,
      scenarioId,
      behaviorMode,
      exposureMode,
      contractVisibility,
      dataPlaneScope: options.dataPlaneScope ?? "all",
      paid,
      count,
      parallel,
      trialWallTimeMs,
      cohortSeed,
      runSeed,
      runSeedIdentifier: runSeedId(runSeed),
      trialRunIds: Object.freeze([...trialRunIds]),
      trialSeeds: Object.freeze(trialSeeds),
      limits,
      pack: {
        root: pack.root,
        manifestName: pack.manifestName,
        manifestSha256: pack.manifestSha256,
        packSha256: packFreezeDigest(pack),
        packIr: ir,
        packIrSha256: canonicalJsonSha256(ir),
        coverage: built.coverage
      },
      contract: {
        entrypoint: entry?.path ?? "",
        entrypointSha256: entry?.sha256 ?? "",
        semanticSha256,
        executionSha256,
        ir: contractIr,
        documents: bundleDocuments ?? {},
        capabilityReport: capability,
        capabilityReportSha256: canonicalJsonSha256(
          capability as unknown as Json
        )
      },
      surface: {
        template: surface.manifest,
        templateSha256: surface.manifestSha256
      },
      promptPreview,
      evaluation: {
        evalDoc: compiledEval.evalDoc,
        cases: compiledEval.cases,
        rubric: compiledEval.rubric,
        rubricSha256: compiledEval.rubricSha256,
        resultSchema: compiledEval.resultSchema,
        resultSchemaSha256: compiledEval.resultSchemaSha256
      },
      adapter: {
        id: options.adapter.id,
        probe,
        model: options.model ?? null,
        effort: options.effort ?? null,
        sandbox: options.sandbox ?? null
      },
      profile,
      paidCallPlan
    }
  };
}

/** Return the frozen plan, or throw the first error finding. */
export function assertPreflightClean(result: PreflightResult): FrozenPlan {
  if (result.plan !== null && result.ok) {
    return result.plan;
  }
  const first = result.findings.find((entry) => entry.severity === "error");
  throw new Error(
    first === undefined
      ? "Preflight failed without an error finding."
      : `${first.code}: ${first.message}`
  );
}
