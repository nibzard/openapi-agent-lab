/**
 * Corpus execution (specification section 48.5). Cases run in
 * declaration order, each against a fresh world the target prepares.
 * Bindings are captured after a response is decoded and before
 * assertions run, so cleanup can use an identifier even when a later
 * assertion fails. Missing bindings, exhausted polls, and operator
 * refusals fail explicitly; nothing is skipped silently. The engine
 * never imports the runner or the agent evaluator.
 */

import {
  canonicalJson,
  isJsonObject,
  resolveJsonPointer,
  validateSchemaInstance,
  type Json,
  type JsonObject
} from "@oal/core";

import type {
  CorpusAssertion,
  CorpusCase,
  CorpusDocument,
  CorpusOperand,
  CorpusStep
} from "@oal/pack";

import type {
  CorpusOperatorCommand,
  CorpusTarget,
  CorpusTargetResponse
} from "./target.ts";

/** Report-level diagnostic. */
export interface ReportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly case_id?: string;
  readonly step_id?: string;
}

/** One redacted exchange a step recorded. */
export interface ExchangeRecord {
  readonly method?: string;
  readonly url?: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Json;
}

/** Provenance of one captured binding. */
export interface BindingRecord {
  readonly name: string;
  readonly step: string;
  readonly source: "status" | "headers" | "body";
  readonly pointer: string | null;
  readonly value?: Json;
  readonly missing: boolean;
}

/** Result of one assertion. */
export interface AssertionRecord {
  readonly op: string;
  readonly passed: boolean;
  readonly message: string;
  readonly expected?: Json;
  readonly actual?: Json;
}

/** One recorded poll attempt. */
export interface AttemptRecord {
  readonly ordinal: number;
  readonly waited_ms: number;
  readonly exchange?: ExchangeRecord;
  readonly assertions: readonly AssertionRecord[];
  readonly passed: boolean;
}

/** Result of one executed step. */
export interface StepRecord {
  readonly id: string;
  readonly phase: "setup" | "steps" | "cleanup";
  status: "passed" | "failed" | "error";
  operation_id?: string;
  operator?: Json;
  operator_result?: Json;
  exchange?: ExchangeRecord;
  readonly bindings: BindingRecord[];
  readonly attempts: AttemptRecord[];
  assertions: AssertionRecord[];
  diagnostic?: ReportDiagnostic;
}

/** Result of one case. */
export interface CaseRecord {
  readonly id: string;
  readonly claim_ids: readonly string[];
  readonly scope: "black_box" | "emulator_only";
  status: "passed" | "failed" | "skipped" | "error";
  readonly skip_reason?: string;
  readonly contract_conformance: "pass" | "fail" | "not_evaluated";
  behavioral_conformance: "pass" | "fail" | "not_evaluated";
  readonly agent_success: "pass" | "fail" | "not_evaluated";
  readonly steps: StepRecord[];
  readonly cleanup: {
    status: "passed" | "failed" | "error" | "not_run";
    steps: number;
  };
  diagnostics: ReportDiagnostic[];
}

/** The corpus-report.v1 document a run produces. */
export interface CorpusReport {
  readonly schema_version: 1;
  readonly kind: "CorpusReport";
  readonly generated_at: string;
  readonly corpus: {
    readonly id: string;
    readonly version: string;
    readonly scenario: string;
  };
  readonly target: {
    readonly id: string;
    readonly version: string;
    readonly capabilities: {
      readonly operators: boolean;
      readonly virtual_time: boolean;
    };
  };
  readonly inputs: Record<string, Json>;
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly error: number;
  };
  readonly cases: readonly CaseRecord[];
  readonly diagnostics: readonly ReportDiagnostic[];
}

/** Options for one corpus run. */
export interface RunCorpusOptions {
  /** Values for every input the corpus declares. */
  readonly inputs?: Readonly<Record<string, Json>>;
  /** Clock for the report timestamp. */
  readonly now?: () => Date;
  /**
   * Loads the local schema a matches_schema assertion names. Targets
   * and callers that provide none leave those assertions unevaluated
   * and failed.
   */
  readonly loadSchema?: (relativePath: string) => Promise<JsonObject | null>;
}

const CODE_BINDING_MISSING = "OAL-CORPUS-BINDING-MISSING";
const CODE_INPUT_MISSING = "OAL-CORPUS-INPUT-MISSING";
const CODE_OPERATOR_UNSUPPORTED = "OAL-CORPUS-OPERATOR-UNSUPPORTED";
const CODE_POLL_EXHAUSTED = "OAL-CORPUS-POLL-EXHAUSTED";
const CODE_PREPARE_FAILED = "OAL-CORPUS-PREPARE-FAILED";
const CODE_TARGET_FAILED = "OAL-CORPUS-TARGET-FAILED";
const CODE_TEARDOWN_FAILED = "OAL-CORPUS-TEARDOWN-FAILED";

/** Header names that never enter a report. */
const SENSITIVE_HEADER =
  /authorization|cookie|token|api[-_]?key|session|secret/i;

/** The response view one step works with. */
interface ResponseView {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json | null;
}

/** Everything a case run keeps between steps. */
interface CaseContext {
  readonly bindings: Map<string, Json>;
  readonly inputs: Readonly<Record<string, Json>>;
  readonly options: RunCorpusOptions;
  readonly diagnostics: ReportDiagnostic[];
}

/** What one source read produced: a value, or nothing. */
type SourceRead =
  | { readonly value: Json; readonly missing: false }
  | { readonly missing: true };

/** Read one source of a response view through a binding or pointer. */
function readSource(
  view: ResponseView,
  source: "status" | "headers" | "body",
  pointer: string | null
): SourceRead {
  if (source === "status") {
    return view.status === null
      ? { missing: true }
      : { value: view.status, missing: false };
  }
  if (source === "headers") {
    const lowered: Record<string, string> = {};
    for (const [name, value] of Object.entries(view.headers)) {
      lowered[name.toLowerCase()] = value;
    }
    if (pointer === null || pointer === "") {
      return { value: lowered, missing: false };
    }
    const direct = resolveJsonPointer(lowered, pointer);
    if (direct !== undefined) {
      return { value: direct, missing: false };
    }
    // Header names are case-insensitive; try the last token lowercased.
    const token = pointer.slice(pointer.lastIndexOf("/") + 1);
    const byKey = lowered[token.toLowerCase()];
    return byKey === undefined
      ? { missing: true }
      : { value: byKey, missing: false };
  }
  if (view.body === null) {
    return { missing: true };
  }
  if (pointer === null || pointer === "") {
    return { value: view.body, missing: false };
  }
  const found = resolveJsonPointer(view.body, pointer);
  return found === undefined
    ? { missing: true }
    : { value: found, missing: false };
}

/** Deep JSON equality; object key order never matters. */
function jsonEquals(
  left: Json | undefined,
  right: Json | undefined,
  setComparison: boolean
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (!setComparison) {
    return canonicalJson(left) === canonicalJson(right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const sorted = (values: readonly Json[]): readonly string[] =>
      values.map((value) => canonicalJson(value)).sort();
    const leftKeys = sorted(left);
    const rightKeys = sorted(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index])
    );
  }
  return canonicalJson(left) === canonicalJson(right);
}

/** Whether every key of the subset deep-equals the candidate. */
function isSubset(subset: Json, candidate: Json | undefined): boolean {
  if (!isJsonObject(subset) || !isJsonObject(candidate)) {
    return jsonEquals(subset, candidate, false);
  }
  for (const [key, value] of Object.entries(subset)) {
    if (!isSubset(value, candidate[key])) {
      return false;
    }
  }
  return true;
}

/** One resolved operand, or why it could not resolve. */
type ResolvedOperand =
  | { readonly kind: "value"; readonly value: Json | undefined }
  | { readonly kind: "missing"; readonly reason: string };

function resolveOperand(
  operand: CorpusOperand,
  view: ResponseView | null,
  context: CaseContext
): ResolvedOperand {
  if (operand.kind === "literal") {
    return { kind: "value", value: operand.value };
  }
  if (operand.kind === "input") {
    const value = context.inputs[operand.name];
    return value === undefined
      ? {
          kind: "missing",
          reason: `Input ${JSON.stringify(operand.name)} has no value.`
        }
      : { kind: "value", value };
  }
  if (operand.kind === "binding") {
    const value = context.bindings.get(`${operand.step}.${operand.name}`);
    return value === undefined
      ? {
          kind: "missing",
          reason: `Binding ${JSON.stringify(`${operand.step}.${operand.name}`)} was never established.`
        }
      : { kind: "value", value };
  }
  if (view === null) {
    return {
      kind: "missing",
      reason: "The step produced no response to read a pointer from."
    };
  }
  const found = readSource(view, operand.source, operand.pointer);
  return found.missing
    ? {
        kind: "missing",
        reason: `Pointer ${JSON.stringify(operand.pointer)} found nothing in ${operand.source}.`
      }
    : { kind: "value", value: found.value };
}

/** Resolve every typed reference inside a value tree. */
function resolveValue(
  value: Json,
  context: CaseContext
): {
  readonly value?: Json;
  readonly reason?: string;
  readonly code?: string;
} {
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const resolved = resolveValue(item, context);
      if (resolved.reason !== undefined) {
        return resolved;
      }
      items.push(resolved.value ?? null);
    }
    return { value: items };
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "input") {
      const raw = value["input"];
      if (typeof raw !== "string") {
        return {
          reason: "An input reference names no input.",
          code: CODE_INPUT_MISSING
        };
      }
      const found = context.inputs[raw];
      return found === undefined
        ? {
            reason: `Input ${JSON.stringify(raw)} has no value.`,
            code: CODE_INPUT_MISSING
          }
        : { value: found };
    }
    if (keys.length === 1 && keys[0] === "binding") {
      const raw = value["binding"];
      if (typeof raw !== "string") {
        return {
          reason: "A binding reference names no binding.",
          code: CODE_BINDING_MISSING
        };
      }
      const bound = context.bindings.get(raw);
      return bound === undefined
        ? {
            reason: `Binding ${JSON.stringify(raw)} was never established.`,
            code: CODE_BINDING_MISSING
          }
        : { value: bound };
    }
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveValue(item, context);
      if (resolved.reason !== undefined) {
        return resolved;
      }
      out[key] = resolved.value ?? null;
    }
    return { value: out };
  }
  return { value };
}

/** Redact one response into a report exchange. */
function exchangeOf(
  response: CorpusTargetResponse,
  statusOverride?: number
): ExchangeRecord {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (!SENSITIVE_HEADER.test(name)) {
      headers[name.toLowerCase()] = value;
    }
  }
  return {
    ...(response.method === undefined ? {} : { method: response.method }),
    ...(response.url === undefined ? {} : { url: response.url }),
    status: statusOverride ?? response.status,
    headers,
    ...(response.body === null ? {} : { body: response.body })
  };
}

/** The operator command one operator step carries. */
function commandOf(operator: JsonObject): CorpusOperatorCommand {
  const kind = operator["kind"];
  if (
    kind !== "inspect" &&
    kind !== "reset" &&
    kind !== "checkpoint" &&
    kind !== "fork" &&
    kind !== "advance_time" &&
    kind !== "install_fault"
  ) {
    throw new Error(`Unknown operator kind ${JSON.stringify(kind)}.`);
  }
  const byMs = operator["by_ms"];
  const expectGeneration = operator["expect_generation"];
  const fixture = operator["fixture"];
  const out = operator["out"];
  return {
    kind,
    ...(typeof byMs === "number" ? { byMs } : {}),
    ...(typeof expectGeneration === "number" ? { expectGeneration } : {}),
    ...(typeof fixture === "string" ? { fixture } : {}),
    ...(typeof out === "string" ? { out } : {})
  };
}

/** Evaluate one assertion against the current response view. */
async function evaluateAssertion(
  assertion: CorpusAssertion,
  view: ResponseView | null,
  context: CaseContext
): Promise<AssertionRecord> {
  const actualOperand =
    assertion.actual ??
    (assertion.op === "status"
      ? { kind: "response", source: "status", pointer: null }
      : { kind: "response", source: "body", pointer: "" });
  const expected = resolveOperand(
    assertion.expected ?? { kind: "literal", value: null },
    view,
    context
  );
  const actual = resolveOperand(actualOperand, view, context);
  const record = (passed: boolean, message: string): AssertionRecord => ({
    op: assertion.op,
    passed,
    message: passed ? "" : message,
    ...(expected.kind === "value" ? { expected: expected.value ?? null } : {}),
    ...(actual.kind === "value" ? { actual: actual.value ?? null } : {})
  });
  if (expected.kind === "missing") {
    return record(
      false,
      `Expected operand did not resolve: ${expected.reason}`
    );
  }
  if (actual.kind === "missing") {
    return record(false, `Actual operand did not resolve: ${actual.reason}`);
  }
  const expectedValue = expected.value ?? null;
  const actualValue = actual.value ?? null;
  switch (assertion.op) {
    case "status":
    case "equals":
      return record(
        jsonEquals(expectedValue, actualValue, assertion.setComparison),
        `Expected ${canonicalJson(expectedValue)}, found ${canonicalJson(actualValue)}.`
      );
    case "not_equals":
      return record(
        !jsonEquals(expectedValue, actualValue, assertion.setComparison),
        `Expected a value other than ${canonicalJson(expectedValue)}.`
      );
    case "exists":
      return record(
        actual.value !== undefined && actual.value !== null,
        "The operand points at nothing."
      );
    case "contains": {
      if (Array.isArray(actualValue)) {
        const member = actualValue.some((item) =>
          isSubset(expectedValue, item)
        );
        return record(
          member,
          `No list member contains ${canonicalJson(expectedValue)}.`
        );
      }
      if (
        typeof actualValue === "string" &&
        typeof expectedValue === "string"
      ) {
        return record(
          actualValue.includes(expectedValue),
          `String does not contain ${JSON.stringify(expectedValue)}.`
        );
      }
      return record(
        false,
        "contains needs a list with a subset or a string with a substring."
      );
    }
    case "length": {
      const length = Array.isArray(actualValue)
        ? actualValue.length
        : typeof actualValue === "string"
          ? Array.from(actualValue).length
          : null;
      return record(
        length !== null && expectedValue === length,
        `Expected length ${canonicalJson(expectedValue)}, found ${length === null ? "none" : length.toString(10)}.`
      );
    }
    case "matches_schema": {
      if (assertion.schema === null) {
        return record(false, "The assertion names no schema path.");
      }
      const loader = context.options.loadSchema;
      if (loader === undefined) {
        return record(false, `No schema loader can read ${assertion.schema}.`);
      }
      const schema = await loader(assertion.schema);
      if (schema === null) {
        return record(false, `Schema ${assertion.schema} is missing.`);
      }
      const violations = await validateSchemaInstance(schema, actualValue);
      return record(
        violations.length === 0,
        violations.map((violation) => violation.message).join("; ")
      );
    }
    default:
      return record(false, `Unknown operator ${assertion.op}.`);
  }
}

/** Capture the bindings one step declares from its response. */
function captureBindings(
  step: CorpusStep,
  view: ResponseView | null,
  record: StepRecord,
  context: CaseContext
): void {
  for (const [name, binding] of Object.entries(step.bind)) {
    const found: SourceRead =
      view === null
        ? { missing: true }
        : readSource(view, binding.source, binding.pointer);
    record.bindings.push({
      name,
      step: step.id,
      source: binding.source,
      pointer: binding.pointer,
      ...(found.missing ? {} : { value: found.value ?? null }),
      missing: found.missing
    });
    if (found.missing) {
      record.status = "failed";
      context.diagnostics.push({
        code: CODE_BINDING_MISSING,
        message: `Binding ${JSON.stringify(name)} of step ${JSON.stringify(step.id)} found nothing at ${JSON.stringify(binding.pointer)} in ${binding.source}.`,
        step_id: step.id
      });
      continue;
    }
    context.bindings.set(`${step.id}.${name}`, found.value ?? null);
  }
}

/** Resolve the parameters of a request or poll. */
function resolveParameters(
  parameters: Readonly<Record<string, JsonObject>>,
  context: CaseContext
): {
  readonly value?: {
    readonly path: Record<string, Json>;
    readonly query: Record<string, Json>;
    readonly header: Record<string, Json>;
  };
  readonly reason?: string;
  readonly code?: string;
} {
  const out: {
    readonly path: Record<string, Json>;
    readonly query: Record<string, Json>;
    readonly header: Record<string, Json>;
  } = { path: {}, query: {}, header: {} };
  for (const place of ["path", "query", "header"] as const) {
    const section = parameters[place];
    if (section === undefined) {
      continue;
    }
    for (const [name, operand] of Object.entries(section)) {
      const resolved = resolveValue(operand, context);
      if (resolved.reason !== undefined) {
        return {
          reason: `Parameter ${JSON.stringify(`${place}.${name}`)} did not resolve: ${resolved.reason}`,
          ...(resolved.code === undefined ? {} : { code: resolved.code })
        };
      }
      out[place][name] = resolved.value ?? null;
    }
  }
  return { value: out };
}

/** Execute one step and record everything it did. */
async function runStep(
  step: CorpusStep,
  phase: "setup" | "steps" | "cleanup",
  target: CorpusTarget,
  context: CaseContext,
  caseId: string
): Promise<StepRecord> {
  const record: StepRecord = {
    id: step.id,
    phase,
    status: "passed",
    bindings: [],
    attempts: [],
    assertions: []
  };
  const body = step.body;

  if (body.kind === "operator") {
    if (target.operate === undefined) {
      record.status = "error";
      record.diagnostic = {
        code: CODE_OPERATOR_UNSUPPORTED,
        message: `Target ${JSON.stringify(target.id)} accepts no operator controls.`,
        case_id: caseId,
        step_id: step.id
      };
      return record;
    }
    try {
      const result = await target.operate(commandOf(body.operator));
      record.operator = body.operator;
      record.operator_result = result;
      const view: ResponseView = {
        status: null,
        headers: {},
        body: result
      };
      captureBindings(step, view, record, context);
      record.assertions = [];
      for (const assertion of step.assertions) {
        record.assertions.push(
          await evaluateAssertion(assertion, view, context)
        );
      }
      if (record.assertions.some((entry) => !entry.passed)) {
        record.status = "failed";
      }
    } catch (cause) {
      record.status = "error";
      record.diagnostic = {
        code: CODE_TARGET_FAILED,
        message: describe(cause),
        case_id: caseId,
        step_id: step.id
      };
    }
    return record;
  }

  const parameters = resolveParameters(body.parameters, context);
  if (parameters.reason !== undefined) {
    record.status = "failed";
    record.diagnostic = {
      code: parameters.code ?? CODE_BINDING_MISSING,
      message: `Step ${JSON.stringify(step.id)}: ${parameters.reason}`,
      case_id: caseId,
      step_id: step.id
    };
    context.diagnostics.push(record.diagnostic);
    return record;
  }
  const requestBody =
    body.body === undefined ? undefined : resolveValue(body.body, context);
  if (requestBody?.reason !== undefined) {
    record.status = "failed";
    record.diagnostic = {
      code: requestBody.code ?? CODE_BINDING_MISSING,
      message: `Step ${JSON.stringify(step.id)} body did not resolve: ${requestBody.reason}`,
      case_id: caseId,
      step_id: step.id
    };
    context.diagnostics.push(record.diagnostic);
    return record;
  }
  record.operation_id = body.operationId;

  if (body.kind === "request") {
    try {
      const response = await target.request({
        operationId: body.operationId,
        parameters: parameters.value ?? { path: {}, query: {}, header: {} },
        body: requestBody?.value,
        poll: false
      });
      record.exchange = exchangeOf(response);
      const view: ResponseView = {
        status: response.status,
        headers: response.headers,
        body: response.body
      };
      captureBindings(step, view, record, context);
      record.assertions = [];
      for (const assertion of step.assertions) {
        record.assertions.push(
          await evaluateAssertion(assertion, view, context)
        );
      }
      if (record.assertions.some((entry) => !entry.passed)) {
        record.status = "failed";
      }
    } catch (cause) {
      record.status = "error";
      record.diagnostic = {
        code: CODE_TARGET_FAILED,
        message: describe(cause),
        case_id: caseId,
        step_id: step.id
      };
    }
    return record;
  }

  // A poll repeats a read with its own bounds; every attempt and
  // wait is recorded, and exhaustion fails the assertions rather
  // than skipping them (section 48.5).
  let waited = 0;
  let succeeded = false;
  let lastView: ResponseView | null = null;
  let lastResponse: CorpusTargetResponse | null = null;
  for (let ordinal = 1; ordinal <= body.attempts; ordinal += 1) {
    if (ordinal > 1) {
      if (waited >= body.deadlineMs) {
        break;
      }
      await target.wait(body.intervalMs);
      waited += body.intervalMs;
    }
    const response = await target.request({
      operationId: body.operationId,
      parameters: parameters.value ?? { path: {}, query: {}, header: {} },
      body: requestBody?.value,
      poll: true
    });
    const view: ResponseView = {
      status: response.status,
      headers: response.headers,
      body: response.body
    };
    const assertions: AssertionRecord[] = [];
    for (const assertion of step.assertions) {
      assertions.push(await evaluateAssertion(assertion, view, context));
    }
    const passed = assertions.every((entry) => entry.passed);
    record.attempts.push({
      ordinal,
      waited_ms: waited,
      exchange: exchangeOf(response),
      assertions,
      passed
    });
    lastView = view;
    lastResponse = response;
    if (passed) {
      succeeded = true;
      break;
    }
  }
  if (lastResponse !== null) {
    record.exchange = exchangeOf(lastResponse);
  }
  captureBindings(step, lastView, record, context);
  record.assertions = [
    ...(record.attempts[record.attempts.length - 1]?.assertions ?? [])
  ];
  if (!succeeded) {
    record.status = "failed";
    context.diagnostics.push({
      code: CODE_POLL_EXHAUSTED,
      message: `Poll ${JSON.stringify(step.id)} exhausted ${record.attempts.length.toString(10)} of ${body.attempts.toString(10)} attempts within ${body.deadlineMs.toString(10)} ms.`,
      case_id: caseId,
      step_id: step.id
    });
  }
  return record;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Execute one case end to end. */
async function runCase(
  corpusCase: CorpusCase,
  target: CorpusTarget,
  options: RunCorpusOptions
): Promise<CaseRecord> {
  const context: CaseContext = {
    bindings: new Map(),
    inputs: options.inputs ?? {},
    options,
    diagnostics: []
  };
  const record: CaseRecord = {
    id: corpusCase.id,
    claim_ids: corpusCase.claimIds,
    scope: corpusCase.scope,
    status: "passed",
    contract_conformance: "not_evaluated",
    behavioral_conformance: "not_evaluated",
    agent_success: "not_evaluated",
    steps: [],
    cleanup: { status: "not_run", steps: 0 },
    diagnostics: []
  };

  try {
    await target.prepare(corpusCase);
  } catch (cause) {
    record.status = "error";
    context.diagnostics.push({
      code: CODE_PREPARE_FAILED,
      message: describe(cause),
      case_id: corpusCase.id
    });
    record.diagnostics = context.diagnostics;
    return record;
  }

  let stopped = false;
  for (const phase of ["setup", "steps"] as const) {
    const list = phase === "setup" ? corpusCase.setup : corpusCase.steps;
    for (const step of list) {
      if (stopped) {
        break;
      }
      const stepRecord = await runStep(
        step,
        phase,
        target,
        context,
        corpusCase.id
      );
      record.steps.push(stepRecord);
      if (stepRecord.status === "error") {
        record.status = "error";
        stopped = true;
      } else if (stepRecord.status === "failed") {
        if (record.status === "passed") {
          record.status = "failed";
        }
        if (stepRecord.diagnostic !== undefined) {
          stopped = true;
        }
      }
    }
  }

  // Cleanup always runs once setup began, using established
  // bindings, and its failures never replace the primary result.
  let cleanupOutcome: "passed" | "failed" | "error" = "passed";
  for (const step of corpusCase.cleanup) {
    const stepRecord = await runStep(
      step,
      "cleanup",
      target,
      context,
      corpusCase.id
    );
    record.steps.push(stepRecord);
    record.cleanup.steps += 1;
    if (stepRecord.status === "error") {
      cleanupOutcome = "error";
    } else if (stepRecord.status === "failed" && cleanupOutcome !== "error") {
      cleanupOutcome = "failed";
    }
  }
  record.cleanup.status =
    record.cleanup.steps === 0 ? "not_run" : cleanupOutcome;
  try {
    await target.cleanup(corpusCase);
  } catch (cause) {
    context.diagnostics.push({
      code: CODE_TEARDOWN_FAILED,
      message: describe(cause),
      case_id: corpusCase.id
    });
    record.status = "error";
  }

  record.diagnostics = context.diagnostics;
  record.behavioral_conformance =
    record.status === "passed"
      ? "pass"
      : record.status === "failed"
        ? "fail"
        : "not_evaluated";
  return record;
}

/**
 * Run one corpus against one target and produce its report. Cases
 * run in declaration order; an emulator-only case on a target
 * without operator controls is skipped before setup, never passed.
 */
export async function runCorpus(
  corpus: CorpusDocument,
  target: CorpusTarget,
  options: RunCorpusOptions = {}
): Promise<CorpusReport> {
  const cases: CaseRecord[] = [];
  const diagnostics: ReportDiagnostic[] = [];
  for (const corpusCase of corpus.cases) {
    if (
      corpusCase.scope === "emulator_only" &&
      !target.capabilities.operators
    ) {
      const skipped: CaseRecord = {
        id: corpusCase.id,
        claim_ids: corpusCase.claimIds,
        scope: corpusCase.scope,
        status: "skipped",
        skip_reason:
          "The target exposes no operator controls, so emulator-only scope cannot run here.",
        contract_conformance: "not_evaluated",
        behavioral_conformance: "not_evaluated",
        agent_success: "not_evaluated",
        steps: [],
        cleanup: { status: "not_run", steps: 0 },
        diagnostics: []
      };
      cases.push(skipped);
      continue;
    }
    const record = await runCase(corpusCase, target, options);
    cases.push(record);
    diagnostics.push(...record.diagnostics);
  }
  const count = (status: string): number =>
    cases.filter((entry) => entry.status === status).length;
  return {
    schema_version: 1,
    kind: "CorpusReport",
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    corpus: {
      id: corpus.id,
      version: corpus.version,
      scenario: corpus.scenario
    },
    target: {
      id: target.id,
      version: target.version,
      capabilities: {
        operators: target.capabilities.operators,
        virtual_time: target.capabilities.virtualTime
      }
    },
    inputs: { ...(options.inputs ?? {}) },
    summary: {
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      error: count("error")
    },
    cases,
    diagnostics
  };
}
