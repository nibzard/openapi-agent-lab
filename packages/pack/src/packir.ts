import type { ContractIR } from "@oal/contract-ir";
import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isJsonObject,
  VIRTUAL_EPOCH_ISO,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { PackCode } from "./codes.ts";
import type { LoadedPack, PackReference } from "./manifest.ts";

/** Effective resource limits recorded in PackIR. */
export interface PackLimits {
  readonly max_agent_tool_calls: number;
  readonly max_api_requests: number;
  readonly max_artifact_bytes: number;
}

/** Canonical operation index used for scope resolution and coverage. */
export interface ContractIndex {
  /** Sorted canonical operation keys. */
  readonly operations: readonly string[];
  readonly tags: ReadonlyMap<string, readonly string[]>;
  readonly methodOf: ReadonlyMap<string, string>;
}

export interface OperationCoverage {
  /** Sorted canonical operation keys of the contract. */
  readonly contractOperations: readonly string[];
  /** Operation key to contract response fixture IDs. */
  readonly fixtureIds: ReadonlyMap<string, readonly string[]>;
  /** Operation keys covered by an idempotency policy. */
  readonly idempotencyOperations: readonly string[];
  /** Eval ID to its resolved frozen operation scope. */
  readonly scope: ReadonlyMap<string, readonly string[]>;
}

export interface PackIrOptions {
  /** Compiled ContractIR used for the operation index and digests. */
  readonly contractIr?: ContractIR;
  /** Digest of a compiled capability report, when one exists. */
  readonly capabilityReportSha256?: string;
  readonly limits?: PackLimits;
}

export interface PackIrResult {
  /** Serialized PackIR, or null when a required input was unavailable. */
  readonly ir: JsonObject | null;
  readonly coverage: OperationCoverage;
  readonly diagnostics: Diagnostic[];
}

const OPERATION_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
] as const;

const MUSTACHE_TAG = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: Json | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function arr(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

/** Structural object check that also accepts values typed as `unknown`. */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted unique mustache variable names referenced by one template. */
export function templateVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MUSTACHE_TAG)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Build an operation index from a raw parsed OpenAPI document. */
export function contractIndexFromDocument(document: JsonObject): ContractIndex {
  const operations: string[] = [];
  const tags = new Map<string, string[]>();
  const methodOf = new Map<string, string>();
  const paths = obj(document["paths"]);
  if (paths !== null) {
    for (const template of Object.keys(paths).sort()) {
      const item = obj(paths[template]);
      if (item === null) {
        continue;
      }
      for (const lower of OPERATION_METHODS) {
        const operation = obj(item[lower]);
        if (operation === null) {
          continue;
        }
        const key = `path:${lower.toUpperCase()} ${template}`;
        operations.push(key);
        methodOf.set(key, lower.toUpperCase());
        tags.set(
          key,
          arr(operation["tags"])
            .map((entry) => str(entry))
            .filter((entry): entry is string => entry !== null)
        );
      }
    }
  }
  operations.sort();
  return { operations, tags, methodOf };
}

/** Build an operation index from a compiled ContractIR. */
export function contractIndexFromContractIr(ir: ContractIR): ContractIndex {
  const operations: string[] = [];
  const tags = new Map<string, string[]>();
  const methodOf = new Map<string, string>();
  for (const operation of ir.operations) {
    operations.push(operation.key);
    methodOf.set(operation.key, operation.method.toUpperCase());
    tags.set(operation.key, [...operation.tags]);
  }
  operations.sort();
  return { operations, tags, methodOf };
}

function referenceByPath(
  loaded: LoadedPack,
  target: string
): PackReference | undefined {
  return loaded.references.find((reference) => reference.path === target);
}

function digestOf(loaded: LoadedPack, target: string | null): string | null {
  if (target === null) {
    return null;
  }
  const reference = referenceByPath(loaded, target);
  if (reference === undefined || reference.sha256 === "") {
    return null;
  }
  return reference.sha256;
}

/**
 * Resolve one eval operation scope to a frozen canonical-key list. Unknown
 * keys are kept out of the result; the invariant checks report them.
 */
export function resolveOperationScope(
  scope: JsonObject,
  index: ContractIndex
): string[] {
  const mode = str(scope["mode"]);
  if (mode === "list") {
    const declared = arr(scope["operations"])
      .map((entry) => str(entry))
      .filter((entry): entry is string => entry !== null);
    const present = new Set(index.operations);
    return [...new Set(declared)].filter((key) => present.has(key)).sort();
  }
  if (mode === "selector") {
    const selector = obj(scope["selector"]);
    if (selector === null) {
      return [];
    }
    const kind = str(selector["kind"]);
    if (kind === "methods") {
      const methods = new Set(
        arr(selector["methods"])
          .map((entry) => str(entry))
          .filter((entry): entry is string => entry !== null)
      );
      return index.operations
        .filter((key) => methods.has(index.methodOf.get(key) ?? ""))
        .sort();
    }
    if (kind === "tags") {
      const wanted = new Set(
        arr(selector["tags"])
          .map((entry) => str(entry))
          .filter((entry): entry is string => entry !== null)
      );
      return index.operations
        .filter((key) =>
          (index.tags.get(key) ?? []).some((tag) => wanted.has(tag))
        )
        .sort();
    }
    return [];
  }
  return [...index.operations].sort();
}

/**
 * Build the effective PackIR from a loaded pack. The result is the serialized
 * form validated by schemas/pack-ir.v1.schema.json plus the derived operation
 * coverage map, which is not part of the serialized document.
 */
export function buildPackIr(
  loaded: LoadedPack,
  options: PackIrOptions = {}
): PackIrResult {
  const diagnostics: Diagnostic[] = [];
  const manifest = loaded.manifest;
  const metadata = obj(manifest["metadata"]);
  const requires = obj(manifest["requires"]);
  const contractIr = options.contractIr;
  const index =
    contractIr === undefined
      ? contractIndexFromDocument(
          obj(
            loaded.references.find(
              (reference) => reference.role === "contract_entrypoint"
            )?.document
          ) ?? {}
        )
      : contractIndexFromContractIr(contractIr);

  const entrypointReference = loaded.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  if (entrypointReference === undefined || entrypointReference.sha256 === "") {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: PackCode.ScopeEmpty,
        message: "PackIR needs a loaded contract entrypoint."
      })
    );
    return { ir: null, coverage: emptyCoverage(), diagnostics };
  }

  const sourceDocument =
    entrypointReference.document !== null &&
    isJsonObject(entrypointReference.document)
      ? entrypointReference.document
      : {};
  const sourceSha = entrypointReference.sha256;
  const derivedSha = canonicalJsonSha256(sourceDocument);
  const executionSha = canonicalJsonSha256(executionProjection(sourceDocument));
  let contractIrSha = derivedSha;
  let capabilitySha = derivedSha;
  if (contractIr !== undefined) {
    contractIrSha = canonicalJsonSha256(contractIrProjection(contractIr));
  } else {
    diagnostics.push(
      diagnostic({
        severity: "info",
        phase: "compile",
        code: PackCode.ContractNotCompiled,
        message:
          "Contract was not compiled in this build; ContractIR and capability digests fall back to source digests."
      })
    );
  }
  if (options.capabilityReportSha256 !== undefined) {
    capabilitySha = options.capabilityReportSha256;
  }

  const behavior = obj(manifest["behavior"]) ?? {};
  const behaviorMode =
    str(behavior["mode"]) === "scenario" ? "scenario" : "contract";
  const completeness =
    str(behavior["completeness"]) === "partial" ? "partial" : "exact";
  const fallback =
    str(behavior["fallback"]) === "contract" ? "contract" : "none";

  const scenarios: JsonObject[] = [];
  const scenarioIds = new Set<string>();
  for (const entry of arr(manifest["scenarios"])) {
    const scenario = obj(entry);
    if (scenario === null) {
      continue;
    }
    const id = str(scenario["id"]);
    if (id === null) {
      continue;
    }
    scenarioIds.add(id);
    scenarios.push({
      id,
      fixtures: arr(scenario["fixtures"])
        .map((fixture) => str(fixture))
        .filter((fixture): fixture is string => fixture !== null)
        .map((fixture) => ({
          path: fixture,
          sha256: digestOf(loaded, fixture) ?? ""
        }))
    });
  }

  const promptSets: JsonObject[] = [];
  for (const entry of arr(manifest["prompt_sets"])) {
    const set = obj(entry);
    if (set === null) {
      continue;
    }
    const id = str(set["id"]);
    const instructions = obj(set["instructions"]);
    const launch = obj(set["launch"]);
    if (id === null || instructions === null || launch === null) {
      continue;
    }
    const instructionsSource = str(instructions["source"]);
    const launchSource = str(launch["source"]);
    const instructionsReference =
      instructionsSource === null
        ? undefined
        : referenceByPath(loaded, instructionsSource);
    const launchReference =
      launchSource === null ? undefined : referenceByPath(loaded, launchSource);
    const engine = str(instructions["engine"]);
    const instructionsText = instructionsReference?.text ?? null;
    const launchText = launchReference?.text ?? null;
    promptSets.push({
      id,
      purpose_disclosure:
        str(set["purpose_disclosure"]) === "naturalistic"
          ? "naturalistic"
          : "diagnostic",
      instructions_sha256: digestOf(loaded, instructionsSource) ?? "",
      launch_sha256: digestOf(loaded, launchSource) ?? "",
      ...(engine === "mustache-strict"
        ? {
            variables: [
              ...new Set([
                ...(instructionsText === null
                  ? []
                  : templateVariables(instructionsText)),
                ...(launchText === null ? [] : templateVariables(launchText))
              ])
            ].sort()
          }
        : {})
    });
  }

  const participantFiles: JsonObject[] = [];
  const seenTargets = new Map<string, number>();
  for (const entry of arr(manifest["prompt_sets"])) {
    const set = obj(entry);
    const instructions = set === null ? null : obj(set["instructions"]);
    if (instructions === null) {
      continue;
    }
    if (str(instructions["delivery"]) !== "file") {
      continue;
    }
    const source = str(instructions["source"]);
    const target = str(instructions["target"]);
    if (source === null || target === null) {
      continue;
    }
    pushParticipantFile(loaded, participantFiles, seenTargets, source, target);
  }

  const evals: JsonObject[] = [];
  const scopeMap = new Map<string, readonly string[]>();
  for (const entry of arr(manifest["evals"])) {
    const evaluation = obj(entry);
    if (evaluation === null) {
      continue;
    }
    const id = str(evaluation["id"]);
    if (id === null) {
      continue;
    }
    const task = obj(evaluation["task"]);
    const result = obj(evaluation["result"]);
    const taskSource = task === null ? null : str(task["source"]);
    const taskTarget =
      (task === null ? null : str(task["target"])) ?? "TASK.md";
    const resultSchema = result === null ? null : str(result["schema"]);
    const rubric = str(evaluation["rubric"]);
    const scope = obj(evaluation["operation_scope"]);
    const resolved = scope === null ? [] : resolveOperationScope(scope, index);
    scopeMap.set(id, resolved);
    if (resolved.length === 0) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: PackCode.ScopeEmpty,
          message: `Eval ${id} resolves to an empty operation scope.`,
          json_pointer: "/evals"
        })
      );
    }
    if (taskSource !== null) {
      pushParticipantFile(
        loaded,
        participantFiles,
        seenTargets,
        taskSource,
        taskTarget
      );
    }
    for (const fileEntry of arr(evaluation["participant_files"])) {
      const file = obj(fileEntry);
      const source = file === null ? null : str(file["source"]);
      const target = file === null ? null : str(file["target"]);
      if (source === null || target === null) {
        continue;
      }
      pushParticipantFile(
        loaded,
        participantFiles,
        seenTargets,
        source,
        target
      );
    }
    evals.push({
      id,
      prompt_set: str(evaluation["prompt_set"]) ?? "",
      task_sha256: digestOf(loaded, taskSource) ?? "",
      result_schema_sha256: digestOf(loaded, resultSchema) ?? "",
      rubric_sha256: digestOf(loaded, rubric) ?? "",
      scenario: str(evaluation["scenario"]) ?? "",
      operation_scope: resolved,
      data_plane_scope: "all"
    });
  }

  const credentials: JsonObject[] = [];
  const security = obj(manifest["security"]);
  if (security !== null) {
    for (const entry of arr(security["credentials"])) {
      const credential = obj(entry);
      const provider = credential === null ? null : obj(credential["provider"]);
      const expose = credential === null ? null : obj(credential["expose"]);
      if (credential === null || provider === null || expose === null) {
        continue;
      }
      credentials.push({
        id: str(credential["id"]) ?? "",
        scheme: str(credential["scheme"]) ?? "",
        provider_kind:
          str(provider["kind"]) === "fixed" ? "fixed" : "generated",
        expose_environment: str(expose["environment"]) ?? ""
      });
    }
  }

  const stateSchema = str(behavior["state_schema"]);
  const stateSchemaSha = digestOf(loaded, stateSchema);
  const clock = obj(behavior["clock"]);
  const random = obj(behavior["random"]);

  const ir: JsonObject = {
    schema_version: 1,
    kind: "PackIR",
    pack: {
      id: str(metadata?.["id"]) ?? "",
      name: str(metadata?.["name"]) ?? "",
      version: str(metadata?.["version"]) ?? "",
      requires: {
        agentlab: str(requires?.["agentlab"]) ?? "",
        backend_api: numberOf(requires?.["backend_api"], 1),
        rubric_api: numberOf(requires?.["rubric_api"], 1)
      },
      manifest_sha256: loaded.manifestSha256
    },
    contract: {
      entrypoint: entrypointReference.path,
      source_sha256: sourceSha,
      semantic_sha256: derivedSha,
      execution_sha256: executionSha,
      contract_ir_sha256: contractIrSha,
      capability_report_sha256: capabilitySha,
      documents: [{ uri: entrypointReference.path, sha256: sourceSha }]
    },
    behavior: {
      mode: behaviorMode,
      completeness,
      fallback,
      ...(stateSchema !== null && stateSchemaSha !== null
        ? {
            state_schema_version: numberOf(behavior["state_schema_version"], 1),
            state_schema_sha256: stateSchemaSha
          }
        : {}),
      ...(clock !== null ? { clock: resolvedClock(clock) } : {}),
      ...(random !== null
        ? {
            random: { seed: str(random["seed"]) === "fixed" ? "fixed" : "run" }
          }
        : {})
    },
    scenarios,
    prompt_sets: promptSets,
    participant_files: participantFiles,
    credentials,
    evals,
    limits: limitsJson(options.limits),
    trust:
      behaviorMode === "scenario"
        ? { execution_profile: "trusted-local", isolation: "advisory" }
        : { execution_profile: "contract-safe", isolation: "hard" },
    warnings: [],
    extensions: obj(manifest["extensions"]) ?? {}
  };

  if (behaviorMode === "scenario") {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "compile",
        code: PackCode.IsolationAdvisory,
        message:
          "Scenario behavior runs trusted-local with advisory isolation in this build."
      })
    );
    diagnostics.push(
      diagnostic({
        severity: "info",
        phase: "compile",
        code: PackCode.BehaviorNotBundled,
        message:
          "Behavior entrypoints are bundled during strict preflight, not by the pack loader."
      })
    );
  }

  const coverage: OperationCoverage = {
    contractOperations: index.operations,
    fixtureIds: fixtureCoverage(manifest),
    idempotencyOperations: idempotencyCoverage(manifest),
    scope: scopeMap
  };

  return { ir, coverage, diagnostics };
}

function emptyCoverage(): OperationCoverage {
  return {
    contractOperations: [],
    fixtureIds: new Map(),
    idempotencyOperations: [],
    scope: new Map()
  };
}

/** Read one manifest number, or fall back to a documented default. */
function numberOf(value: Json | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function limitsJson(limits: PackLimits | undefined): JsonObject {
  return {
    max_agent_tool_calls: limits?.max_agent_tool_calls ?? 500,
    max_api_requests: limits?.max_api_requests ?? 10_000,
    max_artifact_bytes: limits?.max_artifact_bytes ?? 1_073_741_824
  };
}

/** Apply the documented clock defaults for any field the pack omitted. */
function resolvedClock(clock: JsonObject): JsonObject {
  const initial = str(clock["initial"]);
  const tick = clock["tick_ms"];
  return {
    kind: str(clock["kind"]) === "wall" ? "wall" : "virtual",
    initial: initial === null ? VIRTUAL_EPOCH_ISO : initial,
    tick_ms: typeof tick === "number" ? tick : 1
  };
}

function pushParticipantFile(
  loaded: LoadedPack,
  out: JsonObject[],
  seen: Map<string, number>,
  source: string,
  target: string
): void {
  const reference = referenceByPath(loaded, source);
  seen.set(target, (seen.get(target) ?? 0) + 1);
  out.push({
    source,
    target,
    sha256: reference === undefined ? "" : reference.sha256,
    bytes: reference === undefined ? 0 : reference.bytes,
    visibility: "participant"
  });
}

function fixtureCoverage(manifest: JsonObject): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const contract = obj(manifest["contract"]);
  const fixtures = contract === null ? [] : arr(contract["response_fixtures"]);
  for (const entry of fixtures) {
    const fixture = obj(entry);
    if (fixture === null) {
      continue;
    }
    const operation = str(fixture["operation"]);
    const id = str(fixture["id"]);
    if (operation === null || id === null) {
      continue;
    }
    const existing = map.get(operation) ?? [];
    existing.push(id);
    map.set(operation, existing);
  }
  return map;
}

function idempotencyCoverage(manifest: JsonObject): string[] {
  const idempotency = obj(manifest["idempotency"]);
  if (idempotency === null) {
    return [];
  }
  const keys = new Set<string>();
  for (const entry of arr(idempotency["policies"])) {
    const policy = obj(entry);
    if (policy === null) {
      continue;
    }
    for (const operation of arr(policy["operations"])) {
      const key = str(operation);
      if (key !== null) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/**
 * Deterministic runtime-relevant projection of the source document. Ordering
 * choices that affect routing, authentication, and response selection are
 * preserved; everything else is dropped.
 */
function executionProjection(document: JsonObject): JsonObject {
  const paths = obj(document["paths"]) ?? {};
  const operations: JsonObject[] = [];
  for (const template of Object.keys(paths).sort()) {
    const item = obj(paths[template]);
    if (item === null) {
      continue;
    }
    for (const lower of OPERATION_METHODS) {
      const operation = obj(item[lower]);
      if (operation === null) {
        continue;
      }
      operations.push({
        key: `path:${lower.toUpperCase()} ${template}`,
        deprecated: operation["deprecated"] === true,
        security: canonical(operation["security"]) ?? null,
        parameters: arr(operation["parameters"]).map((parameter) =>
          canonical(parameter)
        ),
        responses: Object.keys(obj(operation["responses"]) ?? {}).sort()
      });
    }
  }
  return {
    openapi: str(document["openapi"]) ?? "",
    servers: arr(document["servers"]).map((server) => canonical(server)),
    security: canonical(document["security"]) ?? null,
    schemes: securitySchemeNames(document),
    operations
  };
}

function securitySchemeNames(document: JsonObject): string[] {
  const components = obj(document["components"]);
  const schemes =
    components === null ? null : obj(components["securitySchemes"]);
  return schemes === null ? [] : Object.keys(schemes).sort();
}

function canonical(value: unknown): JsonObject | null {
  if (isRecord(value)) {
    return JSON.parse(canonicalJson(value)) as JsonObject;
  }
  return null;
}

/**
 * Digest basis for the ContractIR reference inside PackIR: the runtime-relevant
 * parts of the compiled contract, in a deterministic order. Human-facing
 * diagnostic wording and source pointers are excluded.
 */
function contractIrProjection(ir: ContractIR): JsonObject {
  return {
    compiler: ir.compiler,
    source: {
      entrypoint: ir.source.entrypoint,
      sha256: ir.source.sha256,
      semantic_sha256: ir.source.semantic_sha256,
      execution_sha256: ir.source.execution_sha256
    },
    security_schemes: Object.keys(ir.security_schemes).sort(),
    schemas: Object.keys(ir.schemas).sort(),
    operations: ir.operations
      .map((operation) => ({
        key: operation.key,
        uid: operation.uid,
        tool_name: operation.tool_name,
        method: operation.method,
        path_template: operation.path_template,
        deprecated: operation.deprecated,
        security: canonical(operation.security) ?? null
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  };
}

/** Canonical JSON text of a serialized PackIR, for stability comparison. */
export function packIrCanonicalText(ir: JsonObject): string {
  return canonicalJson(ir);
}
