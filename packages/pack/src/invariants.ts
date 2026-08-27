import {
  diagnostic,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { PackCode } from "./codes.ts";
import type { LoadedPack } from "./manifest.ts";
import type { ContractIndex, OperationCoverage } from "./packir.ts";

export interface InvariantInput {
  readonly loaded: LoadedPack;
  readonly index: ContractIndex;
  readonly coverage: OperationCoverage;
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: Json | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function arr(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

/** Render one manifest value for a diagnostic message. */
function showValue(value: Json | undefined): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function failure(
  code: string,
  message: string,
  pointer: string | null = null
): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "compile",
    code,
    message,
    ...(pointer === null ? {} : { json_pointer: pointer })
  });
}

/**
 * Check the pack invariants from specification section 12.3 that cross
 * reference manifest sections with each other and with the contract. Path
 * safety, asset existence, and per-file schema validation already happened
 * during loading.
 */
export function validatePackInvariants(input: InvariantInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const manifest = input.loaded.manifest;
  const operations = new Set(input.index.operations);

  const promptSetIds = collectIds(manifest["prompt_sets"]);
  const evalIds = collectIds(manifest["evals"]);
  const scenarioIds = collectIds(manifest["scenarios"]);
  reportDuplicates(promptSetIds, "prompt set", diagnostics);
  reportDuplicates(evalIds, "eval", diagnostics);
  reportDuplicates(scenarioIds, "scenario", diagnostics);

  checkBehavior(manifest, diagnostics);
  checkResponseFixtures(
    manifest,
    input.loaded,
    operations,
    input.coverage,
    diagnostics
  );
  checkIdempotency(manifest, operations, diagnostics);

  for (let i = 0; i < arr(manifest["evals"]).length; i += 1) {
    const evaluation = obj(arr(manifest["evals"])[i]);
    if (evaluation === null) {
      continue;
    }
    const pointer = `/evals/${i}`;
    const id = str(evaluation["id"]) ?? "unknown";

    const promptSet = str(evaluation["prompt_set"]);
    if (promptSet === null || !promptSetIds.declared.has(promptSet)) {
      diagnostics.push(
        failure(
          PackCode.PromptSetUnknown,
          `Eval ${id} references unknown prompt set ${promptSet ?? "(missing)"}.`,
          `${pointer}/prompt_set`
        )
      );
    }
    const scenario = str(evaluation["scenario"]);
    if (scenario === null || !scenarioIds.declared.has(scenario)) {
      diagnostics.push(
        failure(
          PackCode.ScenarioUnknown,
          `Eval ${id} references unknown scenario ${scenario ?? "(missing)"}.`,
          `${pointer}/scenario`
        )
      );
    }
    for (const role of ["task", "result", "rubric"] as const) {
      const source = evalAssetSource(evaluation, role);
      const resolved =
        source !== null &&
        input.loaded.references.some(
          (reference) => reference.path === source && reference.sha256 !== ""
        );
      if (!resolved) {
        diagnostics.push(
          failure(
            PackCode.AssetMissing,
            `Eval ${id} does not resolve a ${role} asset.`,
            `${pointer}/${role}`
          )
        );
      }
    }
    checkOperationScope(
      evaluation["operation_scope"],
      operations,
      input.index,
      id,
      `${pointer}/operation_scope`,
      diagnostics
    );
  }

  checkParticipantTargets(manifest, diagnostics);
  return diagnostics;
}

interface IdIndex {
  /** Every declared ID, in declaration order. */
  readonly declared: Set<string>;
  /** IDs that appear more than once. */
  readonly repeated: string[];
}

function collectIds(value: Json | undefined): IdIndex {
  const declared = new Set<string>();
  const repeated: string[] = [];
  for (const entry of arr(value)) {
    const item = obj(entry);
    const id = item === null ? null : str(item["id"]);
    if (id === null) {
      continue;
    }
    if (declared.has(id)) {
      repeated.push(id);
      continue;
    }
    declared.add(id);
  }
  return { declared, repeated };
}

function reportDuplicates(
  ids: IdIndex,
  what: string,
  diagnostics: Diagnostic[]
): void {
  for (const id of ids.repeated) {
    diagnostics.push(
      failure(PackCode.DuplicateId, `Duplicate ${what} ID: ${id}`)
    );
  }
}

function checkBehavior(manifest: JsonObject, diagnostics: Diagnostic[]): void {
  const behavior = obj(manifest["behavior"]);
  if (behavior === null) {
    return;
  }
  const mode = str(behavior["mode"]);
  if (mode === "scenario" && obj(behavior["backend"]) === null) {
    diagnostics.push(
      failure(
        PackCode.AssetMissing,
        "Scenario behavior requires a backend entrypoint.",
        "/behavior/backend"
      )
    );
  }
  const completeness = str(behavior["completeness"]) ?? "exact";
  const fallback = str(behavior["fallback"]) ?? "none";
  if (completeness === "exact" && fallback !== "none") {
    diagnostics.push(
      failure(
        PackCode.CompletenessConflict,
        "Exact completeness requires fallback none.",
        "/behavior/fallback"
      )
    );
  }
}

function checkResponseFixtures(
  manifest: JsonObject,
  loaded: LoadedPack,
  operations: Set<string>,
  coverage: OperationCoverage,
  diagnostics: Diagnostic[]
): void {
  const contract = obj(manifest["contract"]);
  if (contract === null) {
    return;
  }
  const document = contractDocumentOf(loaded, str(contract["entrypoint"]));
  const fixtures = arr(contract["response_fixtures"]);
  const defaults = new Map<string, number>();
  for (let i = 0; i < fixtures.length; i += 1) {
    const fixture = obj(fixtures[i]);
    if (fixture === null) {
      continue;
    }
    const pointer = `/contract/response_fixtures/${i}`;
    const operation = str(fixture["operation"]);
    const id = str(fixture["id"]) ?? "(missing)";
    if (operation === null || !operations.has(operation)) {
      diagnostics.push(
        failure(
          PackCode.OperationUnknown,
          `Response fixture ${id} targets unknown operation ${operation ?? "(missing)"}.`,
          `${pointer}/operation`
        )
      );
      continue;
    }
    if (fixture["default"] === true) {
      const count = defaults.get(operation) ?? 0;
      defaults.set(operation, count + 1);
    }
    if (!statusIsDeclared(document, operation, fixture["status"])) {
      diagnostics.push(
        failure(
          PackCode.FixtureSelectorUnknown,
          `Response fixture ${id} status ${showValue(
            fixture["status"]
          )} matches no declared response for ${operation}.`,
          `${pointer}/status`
        )
      );
    }
  }
  for (const [operation, ids] of coverage.fixtureIds) {
    const repeated = ids.length - new Set(ids).size;
    if (repeated > 0) {
      diagnostics.push(
        failure(
          PackCode.DuplicateId,
          `Response fixture IDs repeat for ${operation}.`,
          "/contract/response_fixtures"
        )
      );
    }
  }
  for (const [operation, count] of defaults) {
    if (count > 1) {
      diagnostics.push(
        failure(
          PackCode.FixtureDefaultDuplicate,
          `Operation ${operation} declares ${count} default fixtures; at most one is allowed.`,
          "/contract/response_fixtures"
        )
      );
    }
  }
}

/**
 * Resolve whether a fixture status matches an exact, range, or default
 * response declaration of the target operation in the source document.
 */
function statusIsDeclared(
  document: JsonObject | null,
  operationKey: string,
  status: unknown
): boolean {
  if (typeof status !== "number" || document === null) {
    return false;
  }
  const paths = obj(document["paths"]);
  const template = operationKey.slice(operationKey.indexOf(" ") + 1);
  const item = paths === null ? null : obj(paths[template]);
  if (item === null) {
    return false;
  }
  const method = operationKey.slice(5, operationKey.indexOf(" ")).toLowerCase();
  const operation = obj(item[method]);
  const responses = operation === null ? null : obj(operation["responses"]);
  if (responses === null) {
    return false;
  }
  const exact = String(status);
  const range = `${exact.charAt(0)}XX`;
  return (
    Object.keys(responses).includes(exact) ||
    Object.keys(responses).includes(range) ||
    Object.keys(responses).includes("default")
  );
}

/** The parsed contract document referenced by the manifest, when loaded. */
function contractDocumentOf(
  loaded: LoadedPack,
  entrypoint: string | null
): JsonObject | null {
  if (entrypoint === null) {
    return null;
  }
  const reference = loaded.references.find(
    (candidate) => candidate.path === entrypoint
  );
  if (reference === undefined) {
    return null;
  }
  const document = reference.document;
  return typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
    ? document
    : null;
}

function checkIdempotency(
  manifest: JsonObject,
  operations: Set<string>,
  diagnostics: Diagnostic[]
): void {
  const idempotency = obj(manifest["idempotency"]);
  if (idempotency === null) {
    return;
  }
  const policies = arr(idempotency["policies"]);
  const seen = new Set<string>();
  for (let i = 0; i < policies.length; i += 1) {
    const policy = obj(policies[i]);
    if (policy === null) {
      continue;
    }
    const pointer = `/idempotency/policies/${i}`;
    const id = str(policy["id"]) ?? "(missing)";
    if (seen.has(id)) {
      diagnostics.push(
        failure(
          PackCode.DuplicateId,
          `Duplicate idempotency policy ID: ${id}.`,
          pointer
        )
      );
    }
    seen.add(id);
    for (const operation of arr(policy["operations"])) {
      const key = str(operation);
      if (key !== null && !operations.has(key)) {
        diagnostics.push(
          failure(
            PackCode.OperationUnknown,
            `Idempotency policy ${id} targets unknown operation ${key}.`,
            `${pointer}/operations`
          )
        );
      }
    }
  }
}

function checkOperationScope(
  value: Json | undefined,
  operations: Set<string>,
  index: ContractIndex,
  evalId: string,
  pointer: string,
  diagnostics: Diagnostic[]
): void {
  const scope = obj(value);
  if (scope === null) {
    return;
  }
  const mode = str(scope["mode"]);
  if (mode === "list") {
    for (const entry of arr(scope["operations"])) {
      const key = str(entry);
      if (key !== null && !operations.has(key)) {
        diagnostics.push(
          failure(
            PackCode.OperationUnknown,
            `Eval ${evalId} scopes unknown operation ${key}.`,
            pointer
          )
        );
      }
    }
    return;
  }
  if (mode === "all") {
    if (index.operations.length === 0) {
      diagnostics.push(
        failure(
          PackCode.ScopeEmpty,
          `Eval ${evalId} selects every operation but the contract declares none.`,
          pointer
        )
      );
    }
  }
}

function checkParticipantTargets(
  manifest: JsonObject,
  diagnostics: Diagnostic[]
): void {
  const targets = new Map<string, string>();
  const record = (target: string, source: string, pointer: string): void => {
    const previous = targets.get(target);
    if (previous !== undefined && previous !== source) {
      diagnostics.push(
        failure(
          PackCode.TargetDuplicate,
          `Participant target ${target} is declared by ${previous} and ${source}.`,
          pointer
        )
      );
      return;
    }
    targets.set(target, source);
  };
  for (let i = 0; i < arr(manifest["prompt_sets"]).length; i += 1) {
    const set = obj(arr(manifest["prompt_sets"])[i]);
    const instructions = set === null ? null : obj(set["instructions"]);
    if (instructions === null || str(instructions["delivery"]) !== "file") {
      continue;
    }
    const source = str(instructions["source"]) ?? "(missing)";
    record(
      str(instructions["target"]) ?? "(missing)",
      source,
      `/prompt_sets/${i}/instructions`
    );
  }
  for (let i = 0; i < arr(manifest["evals"]).length; i += 1) {
    const evaluation = obj(arr(manifest["evals"])[i]);
    if (evaluation === null) {
      continue;
    }
    const task = obj(evaluation["task"]);
    if (task !== null) {
      const source = str(task["source"]) ?? "(missing)";
      const target = str(task["target"]) ?? "TASK.md";
      record(target, source, `/evals/${i}/task`);
    }
    for (let j = 0; j < arr(evaluation["participant_files"]).length; j += 1) {
      const file = obj(arr(evaluation["participant_files"])[j]);
      if (file === null) {
        continue;
      }
      record(
        str(file["target"]) ?? "(missing)",
        str(file["source"]) ?? "(missing)",
        `/evals/${i}/participant_files/${j}`
      );
    }
  }
}

/** The manifest path of one eval asset role, or null when it is absent. */
function evalAssetSource(
  evaluation: JsonObject,
  role: "task" | "result" | "rubric"
): string | null {
  if (role === "task") {
    const task = obj(evaluation["task"]);
    return task === null ? null : str(task["source"]);
  }
  if (role === "result") {
    const result = obj(evaluation["result"]);
    return result === null ? null : str(result["schema"]);
  }
  return str(evaluation["rubric"]);
}
