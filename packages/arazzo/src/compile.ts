/**
 * Arazzo-to-ContractIR compiler (specification section 20.2).
 *
 * The compiler maps every step operation reference to one canonical
 * ContractIR operation key (`path:<METHOD> <template>`), validates parameter
 * and request mappings against the resolved operation, and validates success
 * criteria and outputs against the supported runtime-expression subset.
 * Anything outside the subset produces an error diagnostic; nothing is
 * dropped silently.
 *
 * Steps in the produced WorkflowIR are dependency ordered. A dependency cycle
 * is an error, and the workflow keeps document order so the failure stays
 * inspectable.
 */

import type { ContractIR, OperationIR } from "@oal/contract-ir";
import { diagnostic, type Diagnostic, type Json } from "@oal/core";

import { ArazzoCode } from "./codes.ts";
import {
  ArazzoExpressionError,
  collectRuntimeSources,
  DEFAULT_EXPRESSION_LIMITS,
  parseCriterion,
  parseRuntimeExpression,
  parseTemplate,
  type ArazzoExpressionLimits,
  type CriterionNode,
  type RuntimeSource,
  type TemplatePart
} from "./expressions.ts";
import {
  isSupportedArazzoVersion,
  type ArazzoDocument,
  type CriterionDoc,
  type ParameterDoc,
  type RequestBodyDoc,
  type StepDoc,
  type WorkflowDoc
} from "./parse.ts";

export const WORKFLOW_IR_SCHEMA_VERSION = 1 as const;
export const ARRAZZO_COMPILER_NAME = "oal-arazzo";
export const ARRAZZO_COMPILER_VERSION = "0.1.0";

/** Parameter locations this compiler can map. */
export type MappedLocation =
  | "path"
  | "query"
  | "querystring"
  | "header"
  | "cookie";

/** One bound value: a literal, one runtime expression, or a template. */
export type BoundValue =
  | { readonly kind: "literal"; readonly value: Json }
  | {
      readonly kind: "expression";
      readonly text: string;
      readonly source: RuntimeSource;
    }
  | {
      readonly kind: "template";
      readonly text: string;
      readonly parts: readonly TemplatePart[];
    };

export interface CompiledParameter {
  readonly name: string;
  readonly location: MappedLocation;
  readonly binding: BoundValue;
}

export interface CompiledRequestBody {
  /** Declared media type, or the first type the operation declares. */
  readonly content_type: string;
  readonly binding: BoundValue | null;
}

export interface CompiledCriterion {
  readonly condition: string;
  readonly type: "simple";
  readonly context: string | null;
  readonly node: CriterionNode;
}

export interface CompiledOutput {
  readonly name: string;
  readonly text: string;
  readonly source: RuntimeSource;
}

export interface CompiledStep {
  readonly step_id: string;
  /** Position of the step in the source document, zero based. */
  readonly source_index: number;
  /** Canonical ContractIR operation key, or null when unresolved. */
  readonly operation_key: string | null;
  readonly depends_on: readonly string[];
  readonly parameters: readonly CompiledParameter[];
  readonly request_body: CompiledRequestBody | null;
  readonly criteria: readonly CompiledCriterion[];
  readonly outputs: readonly CompiledOutput[];
}

export interface CompiledWorkflow {
  readonly workflow_id: string;
  readonly summary: string | null;
  /** Steps in dependency order. */
  readonly steps: readonly CompiledStep[];
  readonly outputs: readonly CompiledOutput[];
}

/** Frozen compiled workflow document. */
export interface WorkflowIR {
  readonly schema_version: typeof WORKFLOW_IR_SCHEMA_VERSION;
  readonly kind: "WorkflowIR";
  readonly compiler: { readonly name: string; readonly version: string };
  readonly source: {
    readonly document_uri: string | null;
    readonly arazzo_version: string;
    readonly source_descriptions: readonly string[];
  };
  readonly workflows: readonly CompiledWorkflow[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ArazzoCompileOptions {
  readonly documentUri?: string | null;
  readonly limits?: ArazzoExpressionLimits;
}

const CANONICAL_KEY = /^path:[A-Za-z]+ \S+$/;
const SOURCE_PREFIX = "$sourceDescriptions.";
const BRACED_SOURCE_PREFIX = "{$sourceDescriptions.";

/** Compile one parsed Arazzo document against one contract. */
export function compileArazzo(
  document: ArazzoDocument,
  contract: ContractIR,
  options: ArazzoCompileOptions = {}
): WorkflowIR {
  const uri = options.documentUri ?? null;
  const limits = options.limits ?? DEFAULT_EXPRESSION_LIMITS;
  const diagnostics: Diagnostic[] = [];
  const sourceNames = new Set(document.sourceDescriptions.map((s) => s.name));
  const byKey = new Map<string, OperationIR>();
  const byOperationId = new Map<string, OperationIR[]>();
  for (const operation of contract.operations) {
    byKey.set(operation.key, operation);
    if (operation.operation_id !== null) {
      const known = byOperationId.get(operation.operation_id);
      if (known === undefined) {
        byOperationId.set(operation.operation_id, [operation]);
      } else {
        known.push(operation);
      }
    }
  }

  if (!isSupportedArazzoVersion(document.arazzo_version)) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.VersionUnsupported,
        message: `Arazzo version '${document.arazzo_version}' is not supported; this compiler targets 1.1.x.`,
        document_uri: uri,
        json_pointer: "/arazzo",
        details: { found: document.arazzo_version, supported: "1.1.x" }
      })
    );
    return emptyIr(document, uri, diagnostics);
  }

  const workflows = document.workflows.map((workflow) =>
    compileWorkflow(workflow, {
      uri,
      limits,
      sourceNames,
      byKey,
      byOperationId,
      diagnostics
    })
  );

  return {
    schema_version: WORKFLOW_IR_SCHEMA_VERSION,
    kind: "WorkflowIR",
    compiler: {
      name: ARRAZZO_COMPILER_NAME,
      version: ARRAZZO_COMPILER_VERSION
    },
    source: {
      document_uri: uri,
      arazzo_version: document.arazzo_version,
      source_descriptions: [...sourceNames]
    },
    workflows,
    diagnostics
  };
}

interface ContractIndex {
  readonly uri: string | null;
  readonly limits: ArazzoExpressionLimits;
  readonly sourceNames: ReadonlySet<string>;
  readonly byKey: ReadonlyMap<string, OperationIR>;
  readonly byOperationId: ReadonlyMap<string, readonly OperationIR[]>;
  readonly diagnostics: Diagnostic[];
}

function emptyIr(
  document: ArazzoDocument,
  uri: string | null,
  diagnostics: Diagnostic[]
): WorkflowIR {
  return {
    schema_version: WORKFLOW_IR_SCHEMA_VERSION,
    kind: "WorkflowIR",
    compiler: {
      name: ARRAZZO_COMPILER_NAME,
      version: ARRAZZO_COMPILER_VERSION
    },
    source: {
      document_uri: uri,
      arazzo_version: document.arazzo_version,
      source_descriptions: document.sourceDescriptions.map((s) => s.name)
    },
    workflows: [],
    diagnostics
  };
}

function compileWorkflow(
  workflow: WorkflowDoc,
  index: ContractIndex
): CompiledWorkflow {
  const steps = orderSteps(workflow.steps);
  if (steps.cycle !== null) {
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.DependencyCycle,
        message: `Workflow '${workflow.workflowId}' has a dependency cycle: ${steps.cycle.join(" -> ")}.`,
        document_uri: index.uri,
        json_pointer: "/workflows",
        details: { cycle: steps.cycle }
      })
    );
  }
  const ordered = steps.ordered.map((step) =>
    compileStep(workflow, step, index)
  );
  const outputs = compileOutputs(
    Object.entries(workflow.outputs),
    index,
    "/workflows/-/outputs"
  );
  return {
    workflow_id: workflow.workflowId,
    summary: workflow.summary,
    steps: ordered,
    outputs
  };
}

/**
 * Stable topological order: at every round the earliest declared step whose
 * dependencies are all ordered comes next. A cycle is reported with its path,
 * and the unordered remainder keeps document order.
 */
function orderSteps(steps: readonly StepDoc[]): {
  ordered: StepDoc[];
  cycle: string[] | null;
} {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const ordered: StepDoc[] = [];
  const done = new Set<string>();
  let remaining = [...steps];
  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      step.dependsOn.every((dep) => done.has(dep))
    );
    if (ready.length === 0) {
      break;
    }
    for (const step of ready) {
      ordered.push(step);
      done.add(step.stepId);
    }
    remaining = remaining.filter((step) => !done.has(step.stepId));
  }
  if (remaining.length === 0) {
    return { ordered, cycle: null };
  }
  const cycle =
    findCycle(remaining, byId) ?? remaining.map((step) => step.stepId);
  return { ordered: [...ordered, ...remaining], cycle };
}

function findCycle(
  remaining: readonly StepDoc[],
  byId: ReadonlyMap<string, StepDoc>
): string[] | null {
  const state = new Map<string, "open" | "active">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "active") {
      const start = stack.indexOf(id);
      return [...stack.slice(start === -1 ? 0 : start), id];
    }
    if (state.get(id) === "open") {
      return null;
    }
    state.set(id, "active");
    stack.push(id);
    const step = byId.get(id);
    for (const dep of step?.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    state.set(id, "open");
    return null;
  };
  for (const step of remaining) {
    const cycle = visit(step.stepId);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

function compileStep(
  workflow: WorkflowDoc,
  step: StepDoc,
  index: ContractIndex
): CompiledStep {
  const pointer = `/workflows/-/steps/${String(step.sourceIndex)}`;
  const operation = resolveOperation(step, index, pointer);
  const parameters = step.parameters.map((parameter) =>
    compileParameter(parameter, operation, index, pointer)
  );
  const requestBody =
    step.requestBody === null
      ? null
      : compileRequestBody(step.requestBody, operation, index, pointer);
  const criteria: CompiledCriterion[] = [];
  step.successCriteria.forEach((criterion, position) => {
    const compiled = compileCriterion(
      criterion,
      index,
      `${pointer}/successCriteria/${String(position)}`
    );
    if (compiled !== null) {
      criteria.push(compiled);
    }
  });
  const outputs = compileOutputs(
    Object.entries(step.outputs),
    index,
    `${pointer}/outputs`
  );
  warnOnUnorderedReferences(workflow, step, criteria, outputs, index, pointer);
  if (step.declaresActions) {
    index.diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "compile",
        code: ArazzoCode.FeatureUnsupported,
        message: `Step '${step.stepId}' declares success or failure actions; trace alignment ignores them.`,
        document_uri: index.uri,
        json_pointer: pointer
      })
    );
  }
  return {
    step_id: step.stepId,
    source_index: step.sourceIndex,
    operation_key: operation?.key ?? null,
    depends_on: step.dependsOn,
    parameters,
    request_body: requestBody,
    criteria,
    outputs
  };
}

function resolveOperation(
  step: StepDoc,
  index: ContractIndex,
  pointer: string
): OperationIR | null {
  if (step.operationId !== null) {
    return resolveByOperationId(step.operationId, step, index, pointer);
  }
  if (step.operationPath !== null) {
    return resolveByOperationPath(step.operationPath, step, index, pointer);
  }
  return null;
}

function resolveByOperationId(
  raw: string,
  step: StepDoc,
  index: ContractIndex,
  pointer: string
): OperationIR | null {
  let name: string | null = null;
  let id = raw;
  if (raw.startsWith(SOURCE_PREFIX)) {
    const rest = raw.slice(SOURCE_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot === -1) {
      fail(
        index,
        ArazzoCode.SourceUnknown,
        step,
        pointer,
        `Operation reference '${raw}' names no source description.`
      );
      return null;
    }
    name = rest.slice(0, dot);
    id = rest.slice(dot + 1);
  }
  if (name !== null && !index.sourceNames.has(name)) {
    fail(
      index,
      ArazzoCode.SourceUnknown,
      step,
      pointer,
      `Source description '${name}' is not declared.`
    );
    return null;
  }
  const matches = index.byOperationId.get(id);
  if (matches === undefined || matches.length === 0) {
    fail(
      index,
      ArazzoCode.OperationUnresolved,
      step,
      pointer,
      `Operation ID '${id}' matches no contract operation.`
    );
    return null;
  }
  if (matches.length > 1) {
    fail(
      index,
      ArazzoCode.OperationAmbiguous,
      step,
      pointer,
      `Operation ID '${id}' matches ${String(matches.length)} contract operations.`
    );
    return null;
  }
  return matches[0] ?? null;
}

function resolveByOperationPath(
  raw: string,
  step: StepDoc,
  index: ContractIndex,
  pointer: string
): OperationIR | null {
  let name: string | null = null;
  let reference = raw;
  if (raw.startsWith(BRACED_SOURCE_PREFIX)) {
    const close = raw.indexOf("}");
    if (close === -1) {
      fail(
        index,
        ArazzoCode.SourceUnknown,
        step,
        pointer,
        `Operation path '${raw}' is missing '}'.`
      );
      return null;
    }
    const inner = raw.slice(BRACED_SOURCE_PREFIX.length, close);
    name = inner.endsWith(".url") ? inner.slice(0, -".url".length) : inner;
    reference = raw.slice(close + 1);
  } else if (raw.startsWith(SOURCE_PREFIX)) {
    const hash = raw.indexOf("#");
    if (hash === -1) {
      fail(
        index,
        ArazzoCode.SourceUnknown,
        step,
        pointer,
        `Operation path '${raw}' has no JSON pointer.`
      );
      return null;
    }
    name = raw.slice(SOURCE_PREFIX.length, hash);
    reference = raw.slice(hash);
  }
  if (name !== null && !index.sourceNames.has(name)) {
    fail(
      index,
      ArazzoCode.SourceUnknown,
      step,
      pointer,
      `Source description '${name}' is not declared.`
    );
    return null;
  }
  const target = reference.startsWith("#") ? reference.slice(1) : reference;
  let key: string;
  if (CANONICAL_KEY.test(target)) {
    key = target;
  } else if (target.startsWith("/paths/")) {
    const tokens = target.split("/").slice(2).map(unescape);
    const method = tokens.pop();
    if (method === undefined || method === "") {
      fail(
        index,
        ArazzoCode.OperationUnresolved,
        step,
        pointer,
        `Operation path '${raw}' names no method.`
      );
      return null;
    }
    const template = tokens
      .filter((token) => token !== "")
      .map((token) => (token.startsWith("/") ? token : `/${token}`))
      .join("");
    key = `path:${method.toUpperCase()} ${template}`;
  } else {
    fail(
      index,
      ArazzoCode.StructureInvalid,
      step,
      pointer,
      `Operation path '${raw}' must point into '#/paths/' or hold a canonical key.`
    );
    return null;
  }
  const operation = index.byKey.get(key);
  if (operation === undefined) {
    fail(
      index,
      ArazzoCode.OperationUnresolved,
      step,
      pointer,
      `Operation key '${key}' matches no contract operation.`
    );
    return null;
  }
  return operation;
}

function unescape(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function fail(
  index: ContractIndex,
  code: string,
  step: StepDoc,
  pointer: string,
  message: string
): void {
  index.diagnostics.push(
    diagnostic({
      severity: "error",
      phase: "compile",
      code,
      message: `Step '${step.stepId}': ${message}`,
      document_uri: index.uri,
      json_pointer: pointer
    })
  );
}

function compileParameter(
  parameter: ParameterDoc,
  operation: OperationIR | null,
  index: ContractIndex,
  pointer: string
): CompiledParameter {
  const entryPointer = `${pointer}/parameters/${parameter.name}`;
  if (parameter.reference !== null) {
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.FeatureUnsupported,
        message: `Parameter '${parameter.name}' uses a reusable reference; references are outside the supported subset.`,
        document_uri: index.uri,
        json_pointer: entryPointer
      })
    );
  }
  if (parameter.in === null) {
    if (operation !== null) {
      index.diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: ArazzoCode.StructureInvalid,
          message: `Parameter '${parameter.name}' needs a location for an operation step.`,
          document_uri: index.uri,
          json_pointer: entryPointer
        })
      );
    }
  } else if (operation !== null) {
    const known = operation.parameters.some(
      (candidate) =>
        candidate.name === parameter.name && candidate.location === parameter.in
    );
    if (!known) {
      index.diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: ArazzoCode.ParameterUnknown,
          message: `Parameter '${parameter.name}' in '${parameter.in}' is not declared by operation '${operation.key}'.`,
          document_uri: index.uri,
          json_pointer: entryPointer,
          operation_key: operation.key
        })
      );
    }
  }
  return {
    name: parameter.name,
    location: (parameter.in ?? "path") as MappedLocation,
    binding: bind(parameter.value, index, entryPointer)
  };
}

function compileRequestBody(
  body: RequestBodyDoc,
  operation: OperationIR | null,
  index: ContractIndex,
  pointer: string
): CompiledRequestBody {
  const bodyPointer = `${pointer}/requestBody`;
  const content = operation?.request_body?.content ?? [];
  const declared = content.map((entry) => entry.media_type);
  if (operation !== null && operation.request_body === null) {
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.RequestBodyUnsupported,
        message: `Operation '${operation.key}' declares no request body.`,
        document_uri: index.uri,
        json_pointer: bodyPointer,
        operation_key: operation.key
      })
    );
  }
  let contentType = body.contentType;
  if (contentType === null) {
    contentType = declared[0] ?? "";
  } else if (declared.length > 0 && !declared.includes(contentType)) {
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.MediaTypeUnsupported,
        message: `Media type '${contentType}' is not declared by operation '${operation?.key ?? "?"}'.`,
        document_uri: index.uri,
        json_pointer: `${bodyPointer}/contentType`,
        operation_key: operation?.key ?? null
      })
    );
  }
  const binding = bind(body.payload, index, bodyPointer);
  validateEmbeddedTemplates(body.payload, index, bodyPointer);
  return { content_type: contentType, binding };
}

/** Arazzo allows interpolation inside any string of a structural payload. */
function validateEmbeddedTemplates(
  payload: Json | undefined,
  index: ContractIndex,
  pointer: string
): void {
  if (typeof payload === "string") {
    return;
  }
  if (payload === null || typeof payload !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(payload)) {
    const child = `${pointer}/${key}`;
    if (typeof value === "string" && value.includes("{$")) {
      reportExpression(
        () => parseTemplate(value, index.limits),
        index,
        child,
        value
      );
    } else {
      validateEmbeddedTemplates(value, index, child);
    }
  }
}

function compileCriterion(
  criterion: CriterionDoc,
  index: ContractIndex,
  pointer: string
): CompiledCriterion | null {
  if (criterion.type !== null && criterion.type !== "simple") {
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: ArazzoCode.FeatureUnsupported,
        message: `Criterion type '${criterion.type}' is outside the supported subset; only 'simple' is supported.`,
        document_uri: index.uri,
        json_pointer: `${pointer}/type`
      })
    );
    return null;
  }
  if (criterion.context !== null) {
    reportExpression(
      () => parseRuntimeExpression(criterion.context ?? "", index.limits),
      index,
      `${pointer}/context`,
      criterion.context
    );
  }
  const node = reportExpression(
    () => parseCriterion(criterion.condition, index.limits),
    index,
    `${pointer}/condition`,
    criterion.condition
  );
  if (node === null) {
    return null;
  }
  return {
    condition: criterion.condition,
    type: "simple",
    context: criterion.context,
    node
  };
}

function compileOutputs(
  entries: readonly (readonly [string, string])[],
  index: ContractIndex,
  pointer: string
): CompiledOutput[] {
  const out: CompiledOutput[] = [];
  for (const [name, text] of entries) {
    const source = reportExpression(
      () => parseRuntimeExpression(text, index.limits),
      index,
      `${pointer}/${name}`,
      text
    );
    if (source === null) {
      continue;
    }
    out.push({ name, text, source });
  }
  return out;
}

/**
 * Emit one strict-eval diagnostic when an expression is outside the subset
 * or does not parse. The returned value is null on failure.
 */
function reportExpression<T>(
  parse: () => T,
  index: ContractIndex,
  pointer: string,
  text: string
): T | null {
  try {
    return parse();
  } catch (caught) {
    const failure =
      caught instanceof ArazzoExpressionError
        ? caught
        : new ArazzoExpressionError({
            code: ArazzoCode.ExpressionInvalid,
            message: "The expression could not be parsed.",
            expression: text
          });
    index.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code: failure.code,
        message: failure.message,
        document_uri: index.uri,
        json_pointer: pointer,
        details: { expression: text }
      })
    );
    return null;
  }
}

function bind(
  value: Json | undefined,
  index: ContractIndex,
  pointer: string
): BoundValue {
  if (typeof value === "string") {
    if (value.includes("{$")) {
      const parts = reportExpression(
        () => parseTemplate(value, index.limits),
        index,
        pointer,
        value
      );
      if (parts !== null) {
        return { kind: "template", text: value, parts };
      }
      return { kind: "literal", value };
    }
    if (value.startsWith("$")) {
      const source = reportExpression(
        () => parseRuntimeExpression(value, index.limits),
        index,
        pointer,
        value
      );
      if (source !== null) {
        return { kind: "expression", text: value, source };
      }
    }
  }
  return { kind: "literal", value: value ?? null };
}

/** Warn when a criterion reads a step this step does not depend on. */
function warnOnUnorderedReferences(
  workflow: WorkflowDoc,
  step: StepDoc,
  criteria: readonly CompiledCriterion[],
  outputs: readonly CompiledOutput[],
  index: ContractIndex,
  pointer: string
): void {
  const closure = transitiveDependencies(workflow, step);
  const sources: RuntimeSource[] = [];
  for (const criterion of criteria) {
    sources.push(...collectRuntimeSources(criterion.node));
  }
  for (const output of outputs) {
    sources.push(output.source);
  }
  for (const source of sources) {
    if (source.kind !== "step_output" || source.stepId === step.stepId) {
      continue;
    }
    if (!closure.has(source.stepId)) {
      index.diagnostics.push(
        diagnostic({
          severity: "warning",
          phase: "compile",
          code: ArazzoCode.StepUnordered,
          message: `Step '${step.stepId}' reads step '${source.stepId}' without depending on it.`,
          document_uri: index.uri,
          json_pointer: pointer
        })
      );
    }
  }
}

function transitiveDependencies(
  workflow: WorkflowDoc,
  step: StepDoc
): Set<string> {
  const byId = new Map(workflow.steps.map((entry) => [entry.stepId, entry]));
  const seen = new Set<string>();
  const queue = [...step.dependsOn];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const target = byId.get(id);
    if (target !== undefined) {
      queue.push(...target.dependsOn);
    }
  }
  return seen;
}
