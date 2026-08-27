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
  parseJsonStrict,
  SAFE_ID_PATTERN,
  StrictJsonError,
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
      root = new YamlSubset(text, limits).parse();
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

interface SourceLine {
  /** Content after the leading indentation. */
  readonly text: string;
  readonly indent: number;
  readonly number: number;
  readonly blank: boolean;
}

interface YamlLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
}

const BLOCK_HEADER = /^([|>])([+-]?\d*|\d+[+-]?)$/;
const PLAIN_INTEGER = /^[+-]?[0-9]+$/;
const PLAIN_NUMBER = /^[+-]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][+-]?[0-9]+)?$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Read one quoted scalar that starts on `quote`. */
function readQuoted(
  text: string,
  start: number
): {
  value: string;
  next: number;
} | null {
  const quote = text.charAt(start);
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === quote) {
      if (quote === "'" && text.charAt(i + 1) === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, next: i + 1 };
    }
    if (quote === '"' && ch === "\\") {
      const escape = text.charAt(i + 1);
      let mapped: string | null = null;
      if (escape === '"' || escape === "\\" || escape === "/") {
        mapped = escape;
      } else if (escape === "n") {
        mapped = "\n";
      } else if (escape === "t") {
        mapped = "\t";
      } else if (escape === "r") {
        mapped = "\r";
      } else if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
      }
      if (mapped === null) {
        return null;
      }
      out += mapped;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

/** Resolve one plain scalar to null, a boolean, a number, or a string. */
function resolvePlain(input: string): Json {
  const value = input.trim();
  if (
    value === "" ||
    value === "null" ||
    value === "Null" ||
    value === "NULL" ||
    value === "~"
  ) {
    return null;
  }
  if (value === "true" || value === "True" || value === "TRUE") {
    return true;
  }
  if (value === "false" || value === "False" || value === "FALSE") {
    return false;
  }
  if (PLAIN_INTEGER.test(value) || PLAIN_NUMBER.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return value;
}

/** Cut a trailing comment that starts outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || isSpace(text.charAt(i - 1)))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Split `key: rest` outside quotes and flow collections. */
function splitEntry(text: string): { key: string; rest: string } | null {
  const first = text.charAt(0);
  if (first === '"' || first === "'") {
    const scalar = readQuoted(text, 0);
    if (scalar === null) {
      return null;
    }
    let i = scalar.next;
    while (i < text.length && isSpace(text.charAt(i))) {
      i += 1;
    }
    if (text.charAt(i) !== ":") {
      return null;
    }
    return { key: scalar.value, rest: text.slice(i + 1) };
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "#" && i > 0 && isSpace(text.charAt(i - 1))) {
      return null;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    const after = text.charAt(i + 1);
    if (ch === ":" && (after === "" || isSpace(after))) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1) };
    }
  }
  return null;
}

/**
 * Bounded YAML subset reader. One instance parses exactly one document.
 */
class YamlSubset {
  private readonly lines: readonly SourceLine[];
  private readonly limits: YamlLimits;
  private index = 0;
  private nodes = 0;

  constructor(text: string, limits: YamlLimits) {
    this.limits = limits;
    this.lines = text.split("\n").map((raw, position) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      let indent = 0;
      while (indent < line.length && line.charAt(indent) === " ") {
        indent += 1;
      }
      const content = line.slice(indent);
      return {
        text: content,
        indent,
        number: position + 1,
        blank: content === "" || content.startsWith("#")
      };
    });
  }

  parse(): Json {
    this.skipDocumentHead();
    const first = this.peek();
    if (first === null) {
      return null;
    }
    if (first.text.startsWith("%")) {
      throw new YamlSubsetError(
        "unsupported",
        "YAML directives are not supported.",
        first.number
      );
    }
    const value = this.parseNode(0);
    const trailing = this.peek();
    if (trailing !== null) {
      throw new YamlSubsetError(
        "unsupported",
        trailing.text.startsWith("---")
          ? "Multiple YAML documents are not supported."
          : "Unexpected content after the document.",
        trailing.number
      );
    }
    return value;
  }

  private skipDocumentHead(): void {
    while (true) {
      const line = this.peek();
      if (line === null) {
        return;
      }
      if (line.text.startsWith("%")) {
        throw new YamlSubsetError(
          "unsupported",
          "YAML directives are not supported.",
          line.number
        );
      }
      if (line.text === "---") {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  /** Next significant line, or null at the end of the document. */
  private peek(): SourceLine | null {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined || !line.blank) {
        if (line !== undefined && line.text.startsWith("\t")) {
          throw new YamlSubsetError(
            "unsupported",
            "Tab characters are not allowed in indentation.",
            line.number
          );
        }
        return line ?? null;
      }
      this.index += 1;
    }
    return null;
  }

  private count(line: number): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw new YamlSubsetError(
        "node-limit",
        "The workflow document exceeds the node limit.",
        line
      );
    }
  }

  private parseNode(depth: number): Json {
    if (depth > this.limits.maxDepth) {
      const line = this.peek();
      throw new YamlSubsetError(
        "depth-limit",
        "The workflow document exceeds the nesting depth limit.",
        line?.number ?? 1
      );
    }
    const line = this.peek();
    if (line === null) {
      return null;
    }
    if (isSequenceEntry(line.text)) {
      return this.parseSequence(line.indent, depth);
    }
    return this.parseMapping(line.indent, depth, null);
  }

  private parseSequence(indent: number, depth: number): Json[] {
    const items: Json[] = [];
    while (true) {
      const line = this.peek();
      if (
        line === null ||
        line.indent < indent ||
        !isSequenceEntry(line.text)
      ) {
        return items;
      }
      if (line.indent > indent) {
        throw new YamlSubsetError(
          "invalid",
          "Unexpected indentation in a block sequence.",
          line.number
        );
      }
      this.index += 1;
      this.count(line.number);
      const rest = line.text === "-" ? "" : line.text.slice(2);
      items.push(this.parseDashValue(rest, line, depth));
    }
  }

  private parseDashValue(rest: string, dash: SourceLine, depth: number): Json {
    if (rest === "") {
      const nested = this.peek();
      if (nested !== null && nested.indent > dash.indent) {
        return this.parseNode(depth + 1);
      }
      return null;
    }
    if (isSequenceEntry(rest)) {
      throw new YamlSubsetError(
        "unsupported",
        "Compact nested sequences are not supported.",
        dash.number
      );
    }
    const content = stripComment(rest).trim();
    if (splitEntry(content) !== null) {
      const offset = dash.text.length - rest.length;
      return this.parseMapping(dash.indent + offset, depth, {
        content,
        line: dash.number
      });
    }
    return this.parseInline(content, dash.number);
  }

  private parseMapping(
    indent: number,
    depth: number,
    pending: { content: string; line: number } | null
  ): JsonObject {
    const result: JsonObject = {};
    let first = pending;
    while (true) {
      let content: string;
      let lineNumber: number;
      if (first !== null) {
        content = first.content;
        lineNumber = first.line;
        first = null;
      } else {
        const line = this.peek();
        if (line === null || line.indent < indent) {
          return result;
        }
        if (line.indent > indent) {
          throw new YamlSubsetError(
            "invalid",
            "Unexpected indentation in a block mapping.",
            line.number
          );
        }
        if (isSequenceEntry(line.text)) {
          return result;
        }
        this.index += 1;
        content = line.text;
        lineNumber = line.number;
      }
      const entry = splitEntry(content);
      if (entry === null) {
        throw new YamlSubsetError(
          "invalid",
          "Expected a 'key: value' mapping entry.",
          lineNumber
        );
      }
      if (entry.key === "") {
        throw new YamlSubsetError(
          "invalid",
          "Mapping keys must not be empty.",
          lineNumber
        );
      }
      this.count(lineNumber);
      if (Object.hasOwn(result, entry.key)) {
        throw new YamlSubsetError(
          "duplicate-key",
          `Duplicate mapping key '${entry.key}'.`,
          lineNumber
        );
      }
      result[entry.key] = this.parseValue(
        entry.rest,
        indent,
        lineNumber,
        depth
      );
    }
  }

  private parseValue(
    rest: string,
    indent: number,
    lineNumber: number,
    depth: number
  ): Json {
    const header = stripComment(rest).trim();
    if (header === "") {
      const next = this.peek();
      if (next === null) {
        return null;
      }
      if (next.indent > indent) {
        return this.parseNode(depth + 1);
      }
      if (next.indent === indent && isSequenceEntry(next.text)) {
        return this.parseSequence(indent, depth + 1);
      }
      return null;
    }
    if (BLOCK_HEADER.test(header)) {
      return this.parseBlockScalar(header, indent);
    }
    return this.parseInline(header, lineNumber);
  }

  private parseBlockScalar(header: string, indent: number): string {
    const style = header.charAt(0);
    const indicators = header.slice(1);
    const chomp = indicators.includes("-")
      ? "strip"
      : indicators.includes("+")
        ? "keep"
        : "clip";
    const explicit = /^[0-9]/.test(indicators)
      ? indent + Number(indicators.replace(/[^0-9]/g, ""))
      : null;

    const collected: SourceLine[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined) {
        break;
      }
      if (line.blank) {
        collected.push(line);
        this.index += 1;
        continue;
      }
      if (line.indent <= indent) {
        break;
      }
      collected.push(line);
      this.index += 1;
    }
    while (collected.length > 0) {
      const last = collected[collected.length - 1];
      if (last !== undefined && last.text !== "") {
        break;
      }
      collected.pop();
    }
    const firstContent = collected.find((line) => line.text !== "");
    const contentIndent =
      explicit ?? (firstContent === undefined ? indent : firstContent.indent);

    const rendered = collected.map((line) =>
      line.text === ""
        ? ""
        : line.text.slice(Math.max(0, line.indent - contentIndent))
    );
    let body: string;
    if (style === "|") {
      body = rendered.join("\n");
    } else {
      const folded: string[] = [];
      let buffer = "";
      for (const line of rendered) {
        if (line === "") {
          folded.push(buffer);
          buffer = "";
          continue;
        }
        buffer = buffer === "" ? line : `${buffer} ${line}`;
      }
      folded.push(buffer);
      body = folded.join("\n");
    }
    if (chomp === "strip") {
      return body;
    }
    if (chomp === "keep") {
      return `${body}\n`;
    }
    return body === "" ? "" : `${body}\n`;
  }

  private parseInline(text: string, lineNumber: number): Json {
    if (text === "") {
      return null;
    }
    const first = text.charAt(0);
    if (first === "&" || first === "*" || first === "!") {
      throw new YamlSubsetError(
        "unsupported",
        "Anchors, aliases, and tags are not supported.",
        lineNumber
      );
    }
    if (first === '"' || first === "'") {
      const scalar = readQuoted(text, 0);
      if (scalar === null || scalar.next !== text.length) {
        throw new YamlSubsetError(
          "invalid",
          "Unterminated or trailing quoted scalar.",
          lineNumber
        );
      }
      this.count(lineNumber);
      return scalar.value;
    }
    if (first === "[" || first === "{") {
      const flow = this.parseFlow(text, 0, lineNumber);
      if (flow.next !== text.length) {
        throw new YamlSubsetError(
          "invalid",
          "Trailing content after a flow collection.",
          lineNumber
        );
      }
      return flow.value;
    }
    this.count(lineNumber);
    return resolvePlain(text);
  }

  private parseFlow(
    text: string,
    start: number,
    lineNumber: number
  ): { value: Json; next: number } {
    const open = text.charAt(start);
    const close = open === "[" ? "]" : "}";
    let i = skipFlowSpace(text, start + 1);
    const items: Json[] = [];
    const map: JsonObject = {};
    while (true) {
      if (i >= text.length) {
        throw new YamlSubsetError(
          "invalid",
          "Unterminated flow collection.",
          lineNumber
        );
      }
      if (text.charAt(i) === close) {
        return {
          value: open === "[" ? items : map,
          next: i + 1
        };
      }
      this.count(lineNumber);
      if (open === "[") {
        const item = this.parseFlowValue(text, i, lineNumber);
        items.push(item.value);
        i = item.next;
      } else {
        const key = this.parseFlowKey(text, i, lineNumber);
        i = skipFlowSpace(text, key.next);
        if (text.charAt(i) !== ":") {
          throw new YamlSubsetError(
            "invalid",
            "Expected ':' in a flow mapping.",
            lineNumber
          );
        }
        const value = this.parseFlowValue(text, i + 1, lineNumber);
        if (Object.hasOwn(map, key.value)) {
          throw new YamlSubsetError(
            "duplicate-key",
            `Duplicate mapping key '${key.value}'.`,
            lineNumber
          );
        }
        map[key.value] = value.value;
        i = value.next;
      }
      i = skipFlowSpace(text, i);
      const separator = text.charAt(i);
      if (separator === ",") {
        i = skipFlowSpace(text, i + 1);
        continue;
      }
      if (separator === close) {
        return { value: open === "[" ? items : map, next: i + 1 };
      }
      throw new YamlSubsetError(
        "invalid",
        `Expected ',' or '${close}' in a flow collection.`,
        lineNumber
      );
    }
  }

  private parseFlowValue(
    text: string,
    start: number,
    lineNumber: number
  ): { value: Json; next: number } {
    const i = skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === "[" || ch === "{") {
      return this.parseFlow(text, i, lineNumber);
    }
    if (ch === '"' || ch === "'") {
      const scalar = readQuoted(text, i);
      if (scalar === null) {
        throw new YamlSubsetError(
          "invalid",
          "Unterminated quoted scalar in a flow collection.",
          lineNumber
        );
      }
      return { value: scalar.value, next: scalar.next };
    }
    let end = i;
    while (end < text.length && !",]}".includes(text.charAt(end))) {
      end += 1;
    }
    return { value: resolvePlain(text.slice(i, end)), next: end };
  }

  private parseFlowKey(
    text: string,
    start: number,
    lineNumber: number
  ): { value: string; next: number } {
    const i = skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const scalar = readQuoted(text, i);
      if (scalar === null) {
        throw new YamlSubsetError(
          "invalid",
          "Unterminated quoted key in a flow mapping.",
          lineNumber
        );
      }
      return { value: scalar.value, next: scalar.next };
    }
    let end = i;
    while (end < text.length && !",}:".includes(text.charAt(end))) {
      end += 1;
    }
    const value = text.slice(i, end).trim();
    if (value === "") {
      throw new YamlSubsetError(
        "invalid",
        "Empty key in a flow mapping.",
        lineNumber
      );
    }
    return { value, next: end };
  }
}

function skipFlowSpace(text: string, start: number): number {
  let i = start;
  while (i < text.length && isSpace(text.charAt(i))) {
    i += 1;
  }
  return i;
}
