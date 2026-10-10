/**
 * Behavioral corpus parsing and validation (specification section
 * 48.5). A corpus is data, never code: values move through typed
 * references and JSON Pointer bindings, polls carry their own
 * bounds, and operator steps stay inside emulator-only cases. The
 * parser rejects forward bindings, duplicate identifiers,
 * unsupported operators, unbounded polling, and anything shaped
 * like a script before any case runs.
 */

import {
  DiagnosticCode,
  invalidInput,
  type Json,
  type JsonObject
} from "@oal/core";

import type { LoadedPack, PackReference } from "./manifest.ts";

/** Version of the corpus format this build reads. */
export const CORPUS_API_VERSION = 1;

/** The assertion operators version one defines. */
export const CORPUS_OPERATORS: readonly string[] = [
  "status",
  "exists",
  "equals",
  "not_equals",
  "contains",
  "length",
  "matches_schema"
];

/** Where an operand reads from. */
export type CorpusOperand =
  | { readonly kind: "literal"; readonly value: Json }
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "binding"; readonly step: string; readonly name: string }
  | {
      readonly kind: "response";
      readonly source: "status" | "headers" | "body";
      readonly pointer: string | null;
    };

/** One captured binding of a step. */
export interface CorpusBinding {
  readonly source: "status" | "headers" | "body";
  readonly pointer: string | null;
}

/** One assertion of a step. */
export interface CorpusAssertion {
  readonly op: string;
  readonly expected: CorpusOperand | null;
  readonly actual: CorpusOperand | null;
  readonly setComparison: boolean;
  readonly schema: string | null;
}

/** A request, poll, or operator body of a step. */
export type CorpusStepBody =
  | {
      readonly kind: "request";
      readonly operationId: string;
      readonly parameters: Readonly<Record<string, JsonObject>>;
      readonly body: Json | undefined;
    }
  | {
      readonly kind: "poll";
      readonly operationId: string;
      readonly parameters: Readonly<Record<string, JsonObject>>;
      readonly body: Json | undefined;
      readonly attempts: number;
      readonly intervalMs: number;
      readonly deadlineMs: number;
    }
  | {
      readonly kind: "operator";
      readonly operator: JsonObject;
    };

/** One ordered step. */
export interface CorpusStep {
  readonly id: string;
  readonly body: CorpusStepBody;
  readonly bind: Readonly<Record<string, CorpusBinding>>;
  readonly assertions: readonly CorpusAssertion[];
}

/** One case: setup, steps, and always-attempted cleanup. */
export interface CorpusCase {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly scope: "black_box" | "emulator_only";
  readonly setup: readonly CorpusStep[];
  readonly steps: readonly CorpusStep[];
  readonly cleanup: readonly CorpusStep[];
}

/** One parsed corpus. */
export interface CorpusDocument {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly scenario: string;
  readonly inputs: readonly string[];
  readonly cases: readonly CorpusCase[];
}

function fail(message: string, details?: Json): never {
  throw invalidInput(DiagnosticCode.CorpusInvalid, message, details);
}

function isRecord(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One operand of an assertion or parameter: a literal, an input
 * reference, a binding reference, or a response pointer. Response
 * pointers are legal only where a current response exists.
 */
function operandOf(
  value: Json | undefined,
  what: string,
  options: { readonly allowResponse: boolean }
): CorpusOperand {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "input") {
      const name = value["input"];
      if (typeof name !== "string" || name.length === 0) {
        fail(`${what} names an input with a nonempty string.`);
      }
      return { kind: "input", name };
    }
    if (keys.length === 1 && keys[0] === "binding") {
      const reference = value["binding"];
      if (typeof reference !== "string" || !reference.includes(".")) {
        fail(
          `${what} binding reference must be "step.name", got ${JSON.stringify(reference)}.`
        );
      }
      const separator = reference.indexOf(".");
      return {
        kind: "binding",
        step: reference.slice(0, separator),
        name: reference.slice(separator + 1)
      };
    }
    if (keys.includes("source")) {
      if (!options.allowResponse) {
        fail(
          `${what} cannot read a response pointer; request values use inputs and bindings.`
        );
      }
      const source = value["source"];
      if (source !== "status" && source !== "headers" && source !== "body") {
        fail(`${what} source must be status, headers, or body.`);
      }
      const pointer = value["pointer"];
      if (source !== "status") {
        checkPointer(pointer, what, source);
      }
      return {
        kind: "response",
        source,
        pointer: typeof pointer === "string" ? pointer : null
      };
    }
  }
  return { kind: "literal", value: value ?? null };
}

/**
 * A pointer into headers or body is "" for the whole source or a
 * JSON Pointer starting at "/" (RFC 6901).
 */
function checkPointer(
  pointer: Json | undefined,
  what: string,
  source: string
): void {
  if (
    typeof pointer !== "string" ||
    (pointer !== "" && !pointer.startsWith("/"))
  ) {
    fail(
      `${what} reads ${source} with "" for the whole source or a JSON Pointer starting at "/".`
    );
  }
}

/** Walk a request value and reject nested script-like shapes. */
function validateValueTree(value: Json, what: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateValueTree(item, what);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "script" ||
      key === "shell" ||
      key === "command" ||
      key === "expr"
    ) {
      fail(
        `${what} carries a ${JSON.stringify(key)} field; corpora execute no scripts (section 48.5).`
      );
    }
    validateValueTree(item, what);
  }
}

/** Parse one step body and its bindings and assertions. */
function stepOf(value: Json, what: string): CorpusStep {
  if (!isRecord(value)) {
    fail(`${what} must be an object.`);
  }
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    fail(`${what} carries a nonempty id.`);
  }
  const hasRequest = isRecord(value["request"]);
  const hasPoll = isRecord(value["poll"]);
  const hasOperator = isRecord(value["operator"]);
  const bodyCount = Number(hasRequest) + Number(hasPoll) + Number(hasOperator);
  if (bodyCount !== 1) {
    fail(
      `Step ${JSON.stringify(id)} must carry exactly one of request, poll, or operator.`
    );
  }

  let body: CorpusStepBody;
  if (hasRequest) {
    const request = value["request"] as JsonObject;
    const operationId = request["operation_id"];
    if (typeof operationId !== "string" || operationId.length === 0) {
      fail(`Step ${JSON.stringify(id)} request names no operation_id.`);
    }
    const parameters = parametersOf(request, id);
    validateValueTree(
      request["body"] ?? null,
      `Step ${JSON.stringify(id)} body`
    );
    body = {
      kind: "request",
      operationId,
      parameters,
      body: request["body"]
    };
  } else if (hasPoll) {
    const poll = value["poll"] as JsonObject;
    const operationId = poll["operation_id"];
    if (typeof operationId !== "string" || operationId.length === 0) {
      fail(`Step ${JSON.stringify(id)} poll names no operation_id.`);
    }
    // Polling is a harness tolerance with explicit bounds; defaults
    // are forbidden, so a missing limit fails here, before any run
    // (section 48.5).
    const attempts = poll["attempts"];
    const intervalMs = poll["interval_ms"];
    const deadlineMs = poll["deadline_ms"];
    if (
      typeof attempts !== "number" ||
      !Number.isInteger(attempts) ||
      attempts < 1
    ) {
      fail(
        `Step ${JSON.stringify(id)} poll needs attempts as an integer of at least 1.`
      );
    }
    if (
      typeof intervalMs !== "number" ||
      !Number.isInteger(intervalMs) ||
      intervalMs < 0
    ) {
      fail(
        `Step ${JSON.stringify(id)} poll needs interval_ms as a nonnegative integer.`
      );
    }
    if (
      typeof deadlineMs !== "number" ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 1
    ) {
      fail(
        `Step ${JSON.stringify(id)} poll needs deadline_ms as a positive integer.`
      );
    }
    const parameters = parametersOf(poll, id);
    validateValueTree(
      poll["body"] ?? null,
      `Step ${JSON.stringify(id)} poll body`
    );
    body = {
      kind: "poll",
      operationId,
      parameters,
      body: poll["body"],
      attempts,
      intervalMs,
      deadlineMs
    };
  } else {
    const operator = value["operator"] as JsonObject;
    validateValueTree(operator, `Step ${JSON.stringify(id)} operator`);
    body = { kind: "operator", operator };
  }

  const bind: Record<string, CorpusBinding> = {};
  if (value["bind"] !== undefined) {
    if (!isRecord(value["bind"])) {
      fail(`Step ${JSON.stringify(id)} bind must be an object.`);
    }
    for (const [name, pointer] of Object.entries(value["bind"])) {
      if (!isRecord(pointer)) {
        fail(`Binding ${JSON.stringify(name)} must be a response pointer.`);
      }
      const source = pointer["source"];
      if (source !== "status" && source !== "headers" && source !== "body") {
        fail(
          `Binding ${JSON.stringify(name)} source must be status, headers, or body.`
        );
      }
      const jsonPointer = pointer["pointer"];
      if (source !== "status") {
        checkPointer(jsonPointer, `Binding ${JSON.stringify(name)}`, source);
      }
      bind[name] = {
        source,
        pointer: typeof jsonPointer === "string" ? jsonPointer : null
      };
    }
  }

  const assertions: CorpusAssertion[] = [];
  if (value["assert"] !== undefined) {
    if (!Array.isArray(value["assert"])) {
      fail(`Step ${JSON.stringify(id)} assert must be an array.`);
    }
    for (const raw of value["assert"]) {
      if (!isRecord(raw)) {
        fail(`Step ${JSON.stringify(id)} carries a non-object assertion.`);
      }
      const op = raw["op"];
      if (typeof op !== "string") {
        fail(`Step ${JSON.stringify(id)} carries an assertion without op.`);
      }
      if (!CORPUS_OPERATORS.includes(op)) {
        fail(
          `Step ${JSON.stringify(id)} uses operator ${JSON.stringify(op)}; version 1 defines ${CORPUS_OPERATORS.join(", ")} only.`
        );
      }
      validateValueTree(
        raw["expected"] ?? null,
        `Step ${JSON.stringify(id)} expected`
      );
      assertions.push({
        op,
        expected:
          raw["expected"] === undefined
            ? null
            : operandOf(
                raw["expected"],
                `Step ${JSON.stringify(id)} expected`,
                { allowResponse: true }
              ),
        actual:
          raw["actual"] === undefined
            ? null
            : operandOf(raw["actual"], `Step ${JSON.stringify(id)} actual`, {
                allowResponse: true
              }),
        setComparison: raw["set_comparison"] === true,
        schema: typeof raw["schema"] === "string" ? raw["schema"] : null
      });
      if (op === "matches_schema" && typeof raw["schema"] !== "string") {
        fail(
          `Step ${JSON.stringify(id)} matches_schema names no local schema path.`
        );
      }
    }
  }

  return { id, body, bind, assertions };
}

/** Parameters of a request or poll, rejecting response references. */
function parametersOf(
  value: JsonObject,
  stepId: string
): Record<string, JsonObject> {
  const raw = value["parameters"];
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    fail(`Step ${JSON.stringify(stepId)} parameters must be an object.`);
  }
  const out: Record<string, JsonObject> = {};
  for (const place of ["path", "query", "header"]) {
    const section = raw[place];
    if (section === undefined) {
      continue;
    }
    if (!isRecord(section)) {
      fail(
        `Step ${JSON.stringify(stepId)} ${place} parameters must be an object.`
      );
    }
    for (const [name, operand] of Object.entries(section)) {
      operandOf(
        operand,
        `Step ${JSON.stringify(stepId)} parameter ${JSON.stringify(name)}`,
        {
          allowResponse: false
        }
      );
      validateValueTree(operand, `Step ${JSON.stringify(stepId)} parameter`);
    }
    out[place] = section;
  }
  return out;
}

/** One case with its setup, steps, and cleanup. */
function caseOf(
  value: Json,
  what: string,
  inputs: readonly string[]
): CorpusCase {
  if (!isRecord(value)) {
    fail(`${what} must be an object.`);
  }
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    fail(`${what} carries a nonempty id.`);
  }
  const claims = value["claim_ids"];
  if (!Array.isArray(claims) || claims.length === 0) {
    fail(`Case ${JSON.stringify(id)} names at least one claim id.`);
  }
  for (const claim of claims) {
    if (typeof claim !== "string" || claim.length === 0) {
      fail(`Case ${JSON.stringify(id)} claim ids are nonempty strings.`);
    }
  }
  const scope = value["scope"];
  if (scope !== "black_box" && scope !== "emulator_only") {
    fail(
      `Case ${JSON.stringify(id)} scope must be black_box or emulator_only.`
    );
  }

  const setup = stepsOf(value["setup"], `Case ${JSON.stringify(id)} setup`);
  const steps = stepsOf(value["steps"], `Case ${JSON.stringify(id)} steps`);
  if (steps.length === 0) {
    fail(`Case ${JSON.stringify(id)} declares no steps.`);
  }
  const cleanup = stepsOf(
    value["cleanup"],
    `Case ${JSON.stringify(id)} cleanup`
  );

  // Identifiers are unique across the whole case, and bindings only
  // point backwards: a value reference may use what setup or an
  // earlier step established, never a later one. An assertion may
  // also use the bindings its own step captured, because bindings
  // exist before assertions run (section 48.5). Cleanup steps never
  // establish bindings.
  const seenSteps = new Set<string>();
  const established = new Set<string>();
  const check = (
    step: CorpusStep,
    references: readonly CorpusOperand[],
    phase: "steps" | "cleanup"
  ): void => {
    for (const reference of references) {
      if (reference.kind === "input" && !inputs.includes(reference.name)) {
        fail(
          `Step ${JSON.stringify(step.id)} uses input ${JSON.stringify(reference.name)}, which the corpus does not declare.`
        );
      }
      if (
        reference.kind === "binding" &&
        !established.has(`${reference.step}.${reference.name}`)
      ) {
        fail(
          `${phase === "cleanup" ? "Cleanup step" : "Step"} ${JSON.stringify(step.id)} binds ${JSON.stringify(`${reference.step}.${reference.name}`)}, which no earlier step established.`
        );
      }
    }
  };
  for (const step of [...setup, ...steps]) {
    if (seenSteps.has(step.id)) {
      fail(
        `Step id ${JSON.stringify(step.id)} appears twice in case ${JSON.stringify(id)}.`
      );
    }
    seenSteps.add(step.id);
    if (step.body.kind === "operator" && scope !== "emulator_only") {
      fail(
        `Step ${JSON.stringify(step.id)} operates the world; only emulator_only cases may (section 48.5).`
      );
    }
    check(step, valueReferencesOf(step), "steps");
    for (const name of Object.keys(step.bind)) {
      established.add(`${step.id}.${name}`);
    }
    check(step, assertionReferencesOf(step), "steps");
  }
  for (const step of cleanup) {
    if (seenSteps.has(step.id)) {
      fail(
        `Step id ${JSON.stringify(step.id)} appears twice in case ${JSON.stringify(id)}.`
      );
    }
    seenSteps.add(step.id);
    if (step.body.kind === "operator" && scope !== "emulator_only") {
      fail(
        `Step ${JSON.stringify(step.id)} operates the world; only emulator_only cases may (section 48.5).`
      );
    }
    check(step, valueReferencesOf(step), "cleanup");
    check(step, assertionReferencesOf(step), "cleanup");
  }

  return {
    id,
    claimIds: claims.map((claim) => claim as string),
    scope,
    setup,
    steps,
    cleanup
  };
}

/** The references inside request values: parameters and body. */
function valueReferencesOf(step: CorpusStep): CorpusOperand[] {
  const references: CorpusOperand[] = [];
  const walk = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const keys = Object.keys(value);
    if (keys.length === 1 && (keys[0] === "input" || keys[0] === "binding")) {
      references.push(
        operandOf(value, `Step ${JSON.stringify(step.id)}`, {
          allowResponse: false
        })
      );
      return;
    }
    for (const item of Object.values(value)) {
      walk(item);
    }
  };
  for (const section of Object.values(
    step.body.kind === "operator" ? {} : step.body.parameters
  )) {
    walk(section);
  }
  if (step.body.kind !== "operator" && step.body.body !== undefined) {
    walk(step.body.body);
  }
  return references;
}

/** The input and binding references inside assertions. */
function assertionReferencesOf(step: CorpusStep): CorpusOperand[] {
  const references: CorpusOperand[] = [];
  for (const assertion of step.assertions) {
    for (const operand of [assertion.expected, assertion.actual]) {
      if (
        operand !== null &&
        (operand.kind === "input" || operand.kind === "binding")
      ) {
        references.push(operand);
      }
    }
  }
  return references;
}

function stepsOf(value: Json | undefined, what: string): CorpusStep[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${what} must be an array.`);
  }
  return value.map((step, index) =>
    stepOf(step, `${what}[${index.toString(10)}]`)
  );
}

/**
 * Parse and validate one corpus document. Every failure is
 * `OAL-CORPUS-INVALID` and lands before any case runs.
 */
export function parseCorpus(value: Json): CorpusDocument {
  if (!isRecord(value)) {
    fail("A corpus must be a JSON object.");
  }
  if (value["api_version"] !== CORPUS_API_VERSION) {
    fail(
      `Corpus api_version ${JSON.stringify(value["api_version"])} is not ${CORPUS_API_VERSION.toString(10)}.`
    );
  }
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    fail("A corpus carries a nonempty id.");
  }
  const version = value["version"];
  if (typeof version !== "string" || version.length === 0) {
    fail(`Corpus ${JSON.stringify(id)} carries a nonempty version.`);
  }
  const scenario = value["scenario"];
  if (typeof scenario !== "string" || scenario.length === 0) {
    fail(`Corpus ${JSON.stringify(id)} names its scenario.`);
  }
  const rawInputs = value["inputs"];
  if (!Array.isArray(rawInputs)) {
    fail(`Corpus ${JSON.stringify(id)} declares its inputs as an array.`);
  }
  const inputs: string[] = [];
  for (const raw of rawInputs) {
    if (!isRecord(raw)) {
      fail(`Corpus ${JSON.stringify(id)} declares each input with a name.`);
    }
    const name = raw["name"];
    if (typeof name !== "string" || name.length === 0) {
      fail(`Corpus ${JSON.stringify(id)} declares each input with a name.`);
    }
    if (inputs.includes(name)) {
      fail(`Input ${JSON.stringify(name)} is declared twice.`);
    }
    inputs.push(name);
  }
  const rawCases = value["cases"];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    fail(`Corpus ${JSON.stringify(id)} declares at least one case.`);
  }
  const caseIds = new Set<string>();
  const cases = rawCases.map((raw, index) => {
    const parsed = caseOf(raw, `Case [${index.toString(10)}]`, inputs);
    if (caseIds.has(parsed.id)) {
      fail(`Case id ${JSON.stringify(parsed.id)} appears twice.`);
    }
    caseIds.add(parsed.id);
    return parsed;
  });

  return { apiVersion: 1, id, version, scenario, inputs, cases };
}

/**
 * Load every corpus a pack declares. Packs without a corpora list
 * stay valid and load zero corpora (section 48.5).
 */
export function corporaOf(pack: LoadedPack): CorpusDocument[] {
  const documents: CorpusDocument[] = [];
  for (const reference of pack.references) {
    if (reference.role !== "corpus" || reference.document === null) {
      continue;
    }
    documents.push(parseCorpus(reference.document));
  }
  return documents;
}

/** The corpus references of one pack, in declaration order. */
export function corpusReferences(pack: LoadedPack): PackReference[] {
  return pack.references.filter((reference) => reference.role === "corpus");
}
