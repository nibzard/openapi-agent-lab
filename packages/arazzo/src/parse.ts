/**
 * Bounded parser for Arazzo 1.1 workflow documents (specification section 20).
 *
 * The parser accepts one JSON document or one YAML document from a small
 * owned subset: block mappings, block sequences with compact mappings,
 * single-line flow collections, plain and quoted scalars, literal and folded
 * block scalars, comments, and an optional leading document marker. It rejects
 * closed: anchors, aliases, tags, directives, multiple documents, tabs in
 * indentation, and duplicate mapping keys.
 *
 * Every expansion is bounded by input size, materialized node count, and
 * nesting depth. The public entry point never throws; it returns typed
 * diagnostics instead. Document-level validation covers the Arazzo version
 * gate, source descriptions, workflow and step IDs, and step dependencies.
 * Contract mapping and expression strictness live in `compile.ts`.
 */

import {
  diagnostic,
  parseBlockYaml,
  parseJsonStrict,
  SAFE_ID_PATTERN,
  StrictJsonError,
  type BlockYamlFailure,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { ArazzoCode } from "./codes.ts";

/** Limits applied to one workflow document. */
export interface ArazzoParseOptions {
  /** Maximum input length in bytes. Default 1 MiB. */
  readonly maxBytes?: number;
  /** Maximum materialized node count. Default 50_000. */
  readonly maxNodes?: number;
  /** Maximum nesting depth. Default 32. */
  readonly maxDepth?: number;
  /** URI recorded in every diagnostic. */
  readonly documentUri?: string | null;
}

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_NODES = 50_000;
export const DEFAULT_MAX_DEPTH = 32;

/** Versions this compiler accepts: the 1.1 line. */
export const SUPPORTED_ARAZZO_PATTERN = /^1\.1(\.\d+)?$/;

/** One declared source description. */
export interface SourceDescriptionDoc {
  readonly name: string;
  readonly url: string;
  /** Defaults to `openapi` when the document omits it. */
  readonly type: string;
}

/** One success criterion, unvalidated. */
export interface CriterionDoc {
  readonly context: string | null;
  readonly condition: string;
  readonly type: string | null;
}

/** One raw parameter mapping, unvalidated. */
export interface ParameterDoc {
  readonly name: string;
  readonly in: string | null;
  readonly value: Json | undefined;
  readonly reference: string | null;
  readonly source: JsonObject;
}

/** One request body mapping, unvalidated. */
export interface RequestBodyDoc {
  readonly contentType: string | null;
  readonly payload: Json | undefined;
  readonly replacements: readonly Json[];
}

/** One step, structurally validated. */
export interface StepDoc {
  readonly stepId: string;
  /** Position of the step in the source document, zero based. */
  readonly sourceIndex: number;
  readonly description: string | null;
  readonly operationId: string | null;
  readonly operationPath: string | null;
  readonly channelPath: string | null;
  readonly workflowId: string | null;
  readonly dependsOn: readonly string[];
  readonly parameters: readonly ParameterDoc[];
  readonly requestBody: RequestBodyDoc | null;
  readonly successCriteria: readonly CriterionDoc[];
  readonly outputs: Readonly<Record<string, string>>;
  /** True when the step declares success or failure actions. */
  readonly declaresActions: boolean;
}

/** One workflow, structurally validated. */
export interface WorkflowDoc {
  readonly workflowId: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly dependsOn: readonly string[];
  readonly parameters: readonly ParameterDoc[];
  readonly steps: readonly StepDoc[];
  readonly outputs: Readonly<Record<string, string>>;
}

/** Structurally validated Arazzo document. */
export interface ArazzoDocument {
  readonly arazzo_version: string;
  readonly title: string | null;
  readonly sourceDescriptions: readonly SourceDescriptionDoc[];
  readonly workflows: readonly WorkflowDoc[];
}

export interface ArazzoParseResult {
  readonly document: ArazzoDocument | null;
  readonly diagnostics: readonly Diagnostic[];
}

const SOURCE_TYPES = new Set(["openapi", "asyncapi", "arazzo"]);
const PARAMETER_LOCATIONS = new Set([
  "path",
  "query",
  "querystring",
  "header",
  "cookie"
]);

/** True when the version string belongs to the supported 1.1 line. */
export function isSupportedArazzoVersion(version: string): boolean {
  return SUPPORTED_ARAZZO_PATTERN.test(version);
}

/**
 * Parse one Arazzo document. Returns typed diagnostics instead of throwing.
 * The document is null only when the text is not a JSON object or a YAML
 * mapping at all.
 */
export function parseArazzo(
  text: string,
  options: ArazzoParseOptions = {}
): ArazzoParseResult {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH
  };
  const uri = options.documentUri ?? null;
  const diagnostics: Diagnostic[] = [];
  if (text.length > limits.maxBytes) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.SizeLimit,
        message: `The workflow document exceeds the byte limit of ${String(limits.maxBytes)}.`,
        document_uri: uri,
        details: { limit: limits.maxBytes, length: text.length }
      })
    );
    return { document: null, diagnostics };
  }

  let root: Json;
  if (looksLikeJson(text)) {
    try {
      root = parseJsonStrict(text, {
        maxBytes: limits.maxBytes,
        maxNodes: limits.maxNodes
      });
    } catch (caught) {
      const message =
        caught instanceof StrictJsonError
          ? caught.message
          : "The workflow document is not valid JSON.";
      const code =
        caught instanceof StrictJsonError
          ? caught.message.includes("node limit")
            ? ArazzoCode.NodeLimit
            : caught.message.includes("byte limit")
              ? ArazzoCode.SizeLimit
              : ArazzoCode.JsonInvalid
          : ArazzoCode.JsonInvalid;
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code,
          message,
          document_uri: uri,
          details: {}
        })
      );
      return { document: null, diagnostics };
    }
  } else {
    try {
      root = parseWorkflowYaml(text, limits);
    } catch (caught) {
      if (caught instanceof YamlSubsetError) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "compile",
            code: yamlCode(caught),
            message: caught.message,
            document_uri: uri,
            details: { line: caught.line }
          })
        );
        return { document: null, diagnostics };
      }
      throw caught;
    }
  }

  if (depthOf(root, 0, limits.maxDepth) > limits.maxDepth) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.DepthLimit,
        message: `The workflow document exceeds the nesting depth limit of ${String(limits.maxDepth)}.`,
        document_uri: uri,
        details: { limit: limits.maxDepth }
      })
    );
    return { document: null, diagnostics };
  }

  const document = buildDocument(root, uri, diagnostics);
  return { document, diagnostics };
}

/** Bounded depth walk. Stops as soon as the limit is exceeded. */
function depthOf(value: Json, depth: number, limit: number): number {
  if (depth > limit) {
    return depth;
  }
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) {
      deepest = Math.max(deepest, depthOf(item, depth + 1, limit));
      if (deepest > limit) {
        return deepest;
      }
    }
    return deepest;
  }
  if (typeof value === "object" && value !== null) {
    let deepest = depth;
    for (const item of Object.values(value)) {
      deepest = Math.max(deepest, depthOf(item, depth + 1, limit));
      if (deepest > limit) {
        return deepest;
      }
    }
    return deepest;
  }
  return depth;
}

function yamlCode(error: YamlSubsetError): string {
  switch (error.code) {
    case "unsupported":
      return ArazzoCode.YamlUnsupported;
    case "duplicate-key":
      return ArazzoCode.DuplicateKey;
    case "node-limit":
      return ArazzoCode.NodeLimit;
    case "depth-limit":
      return ArazzoCode.DepthLimit;
    default:
      return ArazzoCode.YamlUnsupported;
  }
}

function looksLikeJson(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      continue;
    }
    if (ch === "\uFEFF") {
      continue;
    }
    return ch === "{" || ch === "[";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Document-level validation
// ---------------------------------------------------------------------------

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: Json | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function list(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function error(
  diagnostics: Diagnostic[],
  uri: string | null,
  init: {
    code: string;
    message: string;
    pointer: string;
    details?: Json;
  }
): void {
  diagnostics.push(
    diagnostic({
      severity: "error",
      phase: "compile",
      code: init.code,
      message: init.message,
      document_uri: uri,
      json_pointer: init.pointer,
      details: init.details ?? {}
    })
  );
}

function buildDocument(
  root: Json,
  uri: string | null,
  diagnostics: Diagnostic[]
): ArazzoDocument | null {
  const document = obj(root);
  if (document === null) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: "An Arazzo document must be a mapping.",
      pointer: ""
    });
    return null;
  }

  const version = str(document["arazzo"]);
  if (version === null) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message:
        "The required 'arazzo' version field is missing or not a string.",
      pointer: "/arazzo"
    });
  } else if (!isSupportedArazzoVersion(version)) {
    error(diagnostics, uri, {
      code: ArazzoCode.VersionUnsupported,
      message: `Arazzo version '${version}' is not supported; this compiler targets 1.1.x.`,
      pointer: "/arazzo",
      details: { found: version, supported: "1.1.x" }
    });
    return {
      arazzo_version: version,
      title: str(obj(document["info"])?.["title"]),
      sourceDescriptions: [],
      workflows: []
    };
  }
  const arazzoVersion = version ?? "1.1.0";
  const title = str(obj(document["info"])?.["title"]);

  const sources = readSourceDescriptions(document, uri, diagnostics);
  const workflows = readWorkflows(document, uri, diagnostics);
  return {
    arazzo_version: arazzoVersion,
    title,
    sourceDescriptions: sources,
    workflows
  };
}

function readSourceDescriptions(
  document: JsonObject,
  uri: string | null,
  diagnostics: Diagnostic[]
): SourceDescriptionDoc[] {
  const raw = document["sourceDescriptions"];
  if (!Array.isArray(raw) || raw.length === 0) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: "The required 'sourceDescriptions' array is missing or empty.",
      pointer: "/sourceDescriptions"
    });
    return [];
  }
  const out: SourceDescriptionDoc[] = [];
  const names = new Set<string>();
  raw.forEach((entry, index) => {
    const pointer = `/sourceDescriptions/${String(index)}`;
    const source = obj(entry);
    if (source === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A source description must be a mapping.",
        pointer
      });
      return;
    }
    const name = str(source["name"]);
    if (name === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A source description needs a string 'name'.",
        pointer: `${pointer}/name`
      });
      return;
    }
    if (!SAFE_ID_PATTERN.test(name)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdUnsafe,
        message: `Source description name '${name}' is not a safe identifier.`,
        pointer: `${pointer}/name`
      });
      return;
    }
    if (names.has(name)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdDuplicate,
        message: `Source description name '${name}' is declared twice.`,
        pointer
      });
      return;
    }
    names.add(name);
    const url = str(source["url"]);
    if (url === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: `Source description '${name}' needs a string 'url'.`,
        pointer: `${pointer}/url`
      });
      return;
    }
    const declared = str(source["type"]) ?? "openapi";
    if (!SOURCE_TYPES.has(declared)) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: `Source description '${name}' has unknown type '${declared}'.`,
        pointer: `${pointer}/type`
      });
      return;
    }
    if (declared !== "openapi") {
      error(diagnostics, uri, {
        code: ArazzoCode.SourceTypeUnsupported,
        message: `Source description '${name}' has type '${declared}'; only 'openapi' is supported.`,
        pointer: `${pointer}/type`,
        details: { found: declared }
      });
      return;
    }
    out.push({ name, url, type: declared });
  });
  return out;
}

function readWorkflows(
  document: JsonObject,
  uri: string | null,
  diagnostics: Diagnostic[]
): WorkflowDoc[] {
  const raw = document["workflows"];
  if (!Array.isArray(raw) || raw.length === 0) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: "The required 'workflows' array is missing or empty.",
      pointer: "/workflows"
    });
    return [];
  }
  const collected: Array<{
    workflow: JsonObject;
    workflowId: string;
    pointer: string;
  }> = [];
  const ids = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const pointer = `/workflows/${String(index)}`;
    const entry = raw[index];
    const workflow = obj(entry);
    if (workflow === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A workflow must be a mapping.",
        pointer
      });
      continue;
    }
    const workflowId = str(workflow["workflowId"]);
    if (workflowId === null || !SAFE_ID_PATTERN.test(workflowId)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdUnsafe,
        message: "A workflow needs a safe 'workflowId'.",
        pointer: `${pointer}/workflowId`
      });
      continue;
    }
    if (ids.has(workflowId)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdDuplicate,
        message: `Workflow ID '${workflowId}' is declared twice.`,
        pointer
      });
      continue;
    }
    ids.add(workflowId);
    collected.push({ workflow, workflowId, pointer });
  }
  return collected.map((entry) => ({
    workflowId: entry.workflowId,
    summary: str(entry.workflow["summary"]),
    description: str(entry.workflow["description"]),
    dependsOn: readDependencies(
      entry.workflow["dependsOn"],
      ids,
      "Workflow",
      entry.pointer,
      uri,
      diagnostics
    ),
    parameters: readParameters(entry.workflow, entry.pointer, uri, diagnostics),
    steps: readSteps(entry.workflow, entry.pointer, uri, diagnostics),
    outputs: readOutputs(entry.workflow, entry.pointer, uri, diagnostics)
  }));
}

/** Validate one `dependsOn` array against a known ID set. */
function readDependencies(
  value: Json | undefined,
  known: ReadonlySet<string>,
  what: string,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): string[] {
  const out: string[] = [];
  for (const entry of list(value)) {
    const id = str(entry);
    if (id === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: `${what} dependencies must be strings.`,
        pointer: `${pointer}/dependsOn`
      });
      continue;
    }
    if (id.startsWith("$")) {
      error(diagnostics, uri, {
        code: ArazzoCode.DependencyUnsupported,
        message: `Dependency '${id}' uses an unsupported reference form.`,
        pointer: `${pointer}/dependsOn`
      });
      continue;
    }
    if (!known.has(id)) {
      error(diagnostics, uri, {
        code: ArazzoCode.DependencyUnknown,
        message: `${what} dependency '${id}' names no declared ID.`,
        pointer: `${pointer}/dependsOn`
      });
      continue;
    }
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

function readSteps(
  workflow: JsonObject,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): StepDoc[] {
  const raw = workflow["steps"];
  if (!Array.isArray(raw) || raw.length === 0) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: "A workflow needs a non-empty 'steps' array.",
      pointer: `${pointer}/steps`
    });
    return [];
  }
  const collected: Array<{
    step: JsonObject;
    stepId: string;
    pointer: string;
    index: number;
  }> = [];
  const ids = new Set<string>();
  raw.forEach((entry, index) => {
    const stepPointer = `${pointer}/steps/${String(index)}`;
    const step = obj(entry);
    if (step === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A step must be a mapping.",
        pointer: stepPointer
      });
      return;
    }
    const stepId = str(step["stepId"]);
    if (stepId === null || !SAFE_ID_PATTERN.test(stepId)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdUnsafe,
        message: "A step needs a safe 'stepId'.",
        pointer: `${stepPointer}/stepId`
      });
      return;
    }
    if (ids.has(stepId)) {
      error(diagnostics, uri, {
        code: ArazzoCode.IdDuplicate,
        message: `Step ID '${stepId}' appears twice in this workflow.`,
        pointer: stepPointer
      });
      return;
    }
    ids.add(stepId);
    collected.push({ step, stepId, pointer: stepPointer, index });
  });
  const known = ids;
  return collected.map((entry) => ({
    ...readStep(
      entry.step,
      entry.stepId,
      entry.pointer,
      uri,
      diagnostics,
      known
    ),
    sourceIndex: entry.index
  }));
}

function readStep(
  step: JsonObject,
  stepId: string,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[],
  knownStepIds: ReadonlySet<string>
): Omit<StepDoc, "sourceIndex"> {
  const operationId = str(step["operationId"]);
  const operationPath = str(step["operationPath"]);
  const channelPath = str(step["channelPath"]);
  const workflowId = str(step["workflowId"]);
  const targets = [operationId, operationPath, channelPath, workflowId].filter(
    (value) => value !== null
  );
  if (targets.length === 0) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: `Step '${stepId}' must reference one operation.`,
      pointer
    });
  } else if (targets.length > 1) {
    error(diagnostics, uri, {
      code: ArazzoCode.StructureInvalid,
      message: `Step '${stepId}' references more than one operation.`,
      pointer
    });
  } else if (channelPath !== null) {
    error(diagnostics, uri, {
      code: ArazzoCode.StepTargetUnsupported,
      message: `Step '${stepId}' targets an AsyncAPI channel; only operations are supported.`,
      pointer: `${pointer}/channelPath`
    });
  } else if (workflowId !== null) {
    error(diagnostics, uri, {
      code: ArazzoCode.StepTargetUnsupported,
      message: `Step '${stepId}' targets a nested workflow; only operations are supported.`,
      pointer: `${pointer}/workflowId`
    });
  }

  const dependsOn = readDependencies(
    step["dependsOn"],
    knownStepIds,
    `Step '${stepId}'`,
    pointer,
    uri,
    diagnostics
  );

  return {
    stepId,
    description: str(step["description"]),
    operationId,
    operationPath,
    channelPath,
    workflowId,
    dependsOn,
    parameters: readParameters(step, pointer, uri, diagnostics),
    requestBody: readRequestBody(step, pointer, uri, diagnostics),
    successCriteria: readCriteria(step, pointer, uri, diagnostics),
    outputs: readOutputs(step, pointer, uri, diagnostics),
    declaresActions:
      obj(step["onSuccess"]) !== null || obj(step["onFailure"]) !== null
  };
}

function readParameters(
  holder: JsonObject,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): ParameterDoc[] {
  const out: ParameterDoc[] = [];
  list(holder["parameters"]).forEach((entry, index) => {
    const entryPointer = `${pointer}/parameters/${String(index)}`;
    const parameter = obj(entry);
    if (parameter === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A parameter mapping must be a mapping.",
        pointer: entryPointer
      });
      return;
    }
    const name = str(parameter["name"]);
    if (name === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A parameter mapping needs a string 'name'.",
        pointer: `${entryPointer}/name`
      });
      return;
    }
    const location = str(parameter["in"]);
    if (location !== null && !PARAMETER_LOCATIONS.has(location)) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: `Parameter '${name}' has unknown location '${location}'.`,
        pointer: `${entryPointer}/in`
      });
      return;
    }
    if (!("value" in parameter) && str(parameter["reference"]) === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: `Parameter '${name}' needs a 'value' or a 'reference'.`,
        pointer: entryPointer
      });
      return;
    }
    out.push({
      name,
      in: location,
      value: parameter["value"],
      reference: str(parameter["reference"]),
      source: parameter
    });
  });
  return out;
}

function readRequestBody(
  step: JsonObject,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): RequestBodyDoc | null {
  const body = obj(step["requestBody"]);
  if (body === null) {
    return null;
  }
  const replacements = list(body["replacements"]);
  if (replacements.length > 0) {
    error(diagnostics, uri, {
      code: ArazzoCode.FeatureUnsupported,
      message: "Payload replacements are outside the supported subset.",
      pointer: `${pointer}/requestBody/replacements`
    });
  }
  return {
    contentType: str(body["contentType"]),
    payload: body["payload"],
    replacements
  };
}

function readCriteria(
  step: JsonObject,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): CriterionDoc[] {
  const out: CriterionDoc[] = [];
  list(step["successCriteria"]).forEach((entry, index) => {
    const entryPointer = `${pointer}/successCriteria/${String(index)}`;
    const criterion = obj(entry);
    if (criterion === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A success criterion must be a mapping.",
        pointer: entryPointer
      });
      return;
    }
    const condition = str(criterion["condition"]);
    if (condition === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.StructureInvalid,
        message: "A success criterion needs a string 'condition'.",
        pointer: `${entryPointer}/condition`
      });
      return;
    }
    out.push({
      context: str(criterion["context"]),
      condition,
      type: str(criterion["type"])
    });
  });
  return out;
}

function readOutputs(
  holder: JsonObject,
  pointer: string,
  uri: string | null,
  diagnostics: Diagnostic[]
): Readonly<Record<string, string>> {
  const raw = obj(holder["outputs"]);
  if (raw === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!SAFE_ID_PATTERN.test(name)) {
      error(diagnostics, uri, {
        code: ArazzoCode.OutputInvalid,
        message: `Output name '${name}' is not a safe identifier.`,
        pointer: `${pointer}/outputs`
      });
      continue;
    }
    const expression = str(value);
    if (expression === null) {
      error(diagnostics, uri, {
        code: ArazzoCode.OutputInvalid,
        message: `Output '${name}' must be a string runtime expression.`,
        pointer: `${pointer}/outputs/${name}`
      });
      continue;
    }
    out[name] = expression;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded YAML subset
// ---------------------------------------------------------------------------

type YamlSubsetCode =
  | "unsupported"
  | "duplicate-key"
  | "node-limit"
  | "depth-limit"
  | "invalid";

class YamlSubsetError extends Error {
  readonly code: YamlSubsetCode;
  readonly line: number;

  constructor(code: YamlSubsetCode, message: string, line: number) {
    super(`${message} (line ${String(line)})`);
    this.name = "YamlSubsetError";
    this.code = code;
    this.line = line;
  }
}

function yamlSubsetCode(failure: BlockYamlFailure): YamlSubsetCode {
  switch (failure.situation) {
    case "duplicate-key":
      return "duplicate-key";
    case "node-limit":
      return "node-limit";
    case "depth-limit":
      return "depth-limit";
    case "tab-indent":
    case "directive":
    case "multiple-documents":
    case "trailing-content":
    case "compact-sequence":
    case "anchors":
    case "flow-unsupported":
      return "unsupported";
    default:
      return "invalid";
  }
}

function yamlSubsetMessage(failure: BlockYamlFailure): string {
  switch (failure.situation) {
    case "tab-indent":
      return "Tab characters are not allowed in indentation.";
    case "directive":
      return "YAML directives are not supported.";
    case "multiple-documents":
      return "Multiple YAML documents are not supported.";
    case "trailing-content":
      return "Unexpected content after the document.";
    case "sequence-indent":
      return "Unexpected indentation in a block sequence.";
    case "compact-sequence":
      return "Compact nested sequences are not supported.";
    case "mapping-indent":
      return "Unexpected indentation in a block mapping.";
    case "expected-entry":
      return "Expected a 'key: value' mapping entry.";
    case "empty-key":
      return "Mapping keys must not be empty.";
    case "duplicate-key":
      return `Duplicate mapping key '${failure.key}'.`;
    case "node-limit":
      return "The workflow document exceeds the node limit.";
    case "depth-limit":
      return "The workflow document exceeds the nesting depth limit.";
    case "anchors":
      return "Anchors, aliases, and tags are not supported.";
    case "flow-unsupported":
      return "Flow collections are not supported.";
    case "quoted-scalar":
      return "Unterminated or trailing quoted scalar.";
    case "flow-trailing":
      return "Trailing content after a flow collection.";
    case "flow-unterminated":
      return "Unterminated flow collection.";
    case "flow-quoted":
      return "Unterminated quoted scalar in a flow collection.";
    case "flow-key":
      return "Unterminated quoted key in a flow mapping.";
    case "flow-colon":
      return "Expected ':' in a flow mapping.";
    case "flow-empty-key":
      return "Empty key in a flow mapping.";
    case "flow-separator":
      return `Expected ',' or '${failure.close}' in a flow collection.`;
    default:
      return "The workflow document is not valid YAML.";
  }
}

/**
 * Parse one workflow document with the shared line-based YAML engine, using
 * the dialect that reproduces the historical Arazzo subset exactly.
 */
function parseWorkflowYaml(
  text: string,
  limits: { readonly maxNodes: number; readonly maxDepth: number }
): Json {
  return parseBlockYaml(text, {
    fail(failure) {
      throw new YamlSubsetError(
        yamlSubsetCode(failure),
        yamlSubsetMessage(failure),
        failure.line
      );
    },
    skipDirectives: false,
    tabCheck: "read",
    flow: true,
    limits: { maxNodes: limits.maxNodes, maxDepth: limits.maxDepth },
    extendedEscapes: false,
    blankIsContent: true,
    chompFormulation: "body",
    flowSkipsBreaks: false,
    flowKeyBreaksOnBracket: false
  });
}
