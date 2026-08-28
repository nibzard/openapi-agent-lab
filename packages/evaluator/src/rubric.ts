/**
 * Rubric model and loader (specification sections 26.3 through 26.7).
 *
 * A rubric is a hidden deterministic document: one scoring method,
 * typed checks, and non-scoring signals. The loader validates the
 * document shape, then applies the semantic rules the JSON Schema
 * cannot express: unique identifiers, nonnegative finite weights, a
 * positive total weight, immutable capture names, resolvable schema
 * references, and expressions that parse against the variable set the
 * evaluator exposes at that position.
 */

import {
  diagnostic,
  isJsonObject,
  isSafeId,
  SchemaValidator,
  DiagnosticCode,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  compileExpression,
  DEFAULT_EXPRESSION_LIMITS,
  ExpressionError,
  type CompiledExpression,
  type ExpressionLimits
} from "./expression.ts";

export const RUBRIC_SCHEMA_VERSION = 1;

/** Behavior when a referenced evaluation input is absent. */
export type OnMissing = "fail" | "skip" | "error";

/** Who can observe the evidence a check asserts (section 26.5). */
export type EvidenceClass =
  | "participant_observable"
  | "private_domain"
  | "mixed";

/** Quantifier used by the stream check kinds. */
export type MatchQuantifier = "existential" | "universal" | "counted";

/** Sequence search mode (section 26.6). */
export type SequenceMatch = "any" | "all";

export interface RubricScoring {
  method: "weighted_binary";
  pass_threshold: number;
}

export interface RubricStep {
  id: string;
  where: string;
  capture?: Record<string, string> | undefined;
}

export interface RubricPostcondition {
  id: string;
  expression: string;
}

interface CheckCommon {
  id: string;
  weight: number;
  required: boolean;
  description?: string | undefined;
  evidence_class?: EvidenceClass | undefined;
  on_missing?: OnMissing | undefined;
}

export type RubricCheck = CheckCommon &
  (
    | { kind: "predicate"; expression: string }
    | {
        kind: "event";
        match: MatchQuantifier;
        where: string;
        min_count?: number | undefined;
        max_count?: number | undefined;
      }
    | {
        kind: "sequence";
        match: SequenceMatch;
        max_candidates?: number | undefined;
        steps: RubricStep[];
        postconditions?: RubricPostcondition[] | undefined;
      }
    | {
        kind: "json_schema";
        value: "report" | "state" | "response";
        schema: string;
      }
    | {
        kind: "artifact";
        path: string;
        exists?: boolean | undefined;
        sha256?: string | undefined;
        media_type?: string | undefined;
        max_bytes?: number | undefined;
      }
    | {
        kind: "documentation_event";
        match: MatchQuantifier;
        where: string;
        min_count?: number | undefined;
        max_count?: number | undefined;
        ordered?: boolean | undefined;
        steps?: RubricStep[] | undefined;
      }
    | {
        kind: "semantic_event";
        match: MatchQuantifier;
        where: string;
        min_count?: number | undefined;
        max_count?: number | undefined;
        ordered?: boolean | undefined;
        steps?: RubricStep[] | undefined;
      }
  );

export interface RubricSignal {
  id: string;
  kind: "predicate";
  expression: string;
  description?: string | undefined;
  on_missing?: OnMissing | undefined;
}

export interface Rubric {
  rubric_version: 1;
  id: string;
  description?: string | undefined;
  scoring: RubricScoring;
  checks: RubricCheck[];
  signals: RubricSignal[];
}

/** Variables visible to a predicate or signal expression. */
const PREDICATE_ROOTS: ReadonlySet<string> = new Set([
  "state",
  "report",
  "run",
  "artifacts",
  "events",
  "documentation_events",
  "semantic_events"
]);

/** Variables visible to one step of an ordered stream search. */
const STEP_ROOTS: ReadonlySet<string> = new Set(["event", "vars", "steps"]);

/** Variables visible to a stream quantifier over single events. */
const EVENT_ROOTS: ReadonlySet<string> = new Set(["event"]);

/** Variables visible to a postcondition of a completed sequence. */
const POSTCONDITION_ROOTS: ReadonlySet<string> = new Set([
  "state",
  "report",
  "run",
  "artifacts",
  "vars"
]);

export interface RubricLoadOptions {
  /** Draft 2020-12 rubric schema. The caller reads it from schemas/. */
  schema?: Json | undefined;
  /** Resolves the reference named by a json_schema check. */
  resolveSchema?: ((reference: string) => Json | undefined) | undefined;
  /** Expression limits applied while the rubric compiles. */
  limits?: ExpressionLimits | undefined;
  /** Document URI recorded in diagnostics. */
  documentUri?: string | undefined;
}

export interface RubricLoadResult {
  /** The typed rubric, or null when any error was reported. */
  rubric: Rubric | null;
  diagnostics: Diagnostic[];
}

const KNOWN_SCORING_METHODS: ReadonlySet<string> = new Set(["weighted_binary"]);

/**
 * Load and compile one rubric document. The function never throws on
 * document content; every problem is reported as a diagnostic.
 */
export function loadRubric(
  document: Json,
  options: RubricLoadOptions = {}
): RubricLoadResult {
  const loader = new RubricLoader(options);
  const rubric = loader.load(document);
  return {
    rubric: rubric === null || loader.failed ? null : rubric,
    diagnostics: loader.diagnostics
  };
}

/** Read one object field. A missing field reads as undefined. */
function fieldOf(value: JsonObject, key: string): Json | undefined {
  return value[key];
}

class RubricLoader {
  readonly diagnostics: Diagnostic[] = [];
  failed = false;
  private droppedChecks = 0;
  private readonly limits: ExpressionLimits;
  private readonly documentUri: string | null;
  private readonly resolveSchema:
    | ((reference: string) => Json | undefined)
    | undefined;

  constructor(private readonly options: RubricLoadOptions) {
    this.limits = options.limits ?? DEFAULT_EXPRESSION_LIMITS;
    this.documentUri = options.documentUri ?? null;
    this.resolveSchema = options.resolveSchema;
  }

  load(document: Json): Rubric | null {
    if (this.options.schema !== undefined) {
      const violations = new SchemaValidator(this.options.schema).errors(
        document
      );
      for (const violation of violations) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `${violation.code}: ${violation.message}`,
          violation.pointer.length === 0
            ? "#/"
            : `#/${violation.pointer.slice(1)}`
        );
      }
    }
    if (!isJsonObject(document)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "Rubric must be an object.",
        "#/"
      );
      return null;
    }
    const version = fieldOf(document, "rubric_version");
    if (version !== RUBRIC_SCHEMA_VERSION) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `rubric_version must be ${RUBRIC_SCHEMA_VERSION}.`,
        "#/rubric_version"
      );
    }
    const id = this.readSafeId(fieldOf(document, "id"), "#/id", "rubric id");
    const description = this.readOptionalString(
      fieldOf(document, "description"),
      "#/description"
    );
    const scoring = this.readScoring(fieldOf(document, "scoring"));
    const checks = this.readChecks(fieldOf(document, "checks"));
    const signals = this.readSignals(fieldOf(document, "signals"));
    if (
      id === null ||
      scoring === null ||
      checks === null ||
      signals === null
    ) {
      return null;
    }
    // Skip the aggregate rules when a broken check was dropped. The
    // first diagnostic already explains the real problem, and a
    // cascade of follow-up errors hides it.
    if (this.droppedChecks === 0) {
      if (checks.length === 0) {
        this.error(
          DiagnosticCode.RubricInvalid,
          "A rubric needs at least one check.",
          "#/checks"
        );
      }
      if (!checks.some((check) => check.weight > 0)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          "At least one check needs a positive weight.",
          "#/checks"
        );
      }
    }
    const rubric: Rubric = {
      rubric_version: RUBRIC_SCHEMA_VERSION,
      id,
      ...(description === undefined ? {} : { description }),
      scoring,
      checks,
      signals
    };
    return rubric;
  }

  private readScoring(value: Json | undefined): RubricScoring | null {
    if (!isJsonObject(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "scoring must be an object.",
        "#/scoring"
      );
      return null;
    }
    const method = fieldOf(value, "method");
    if (typeof method !== "string" || !KNOWN_SCORING_METHODS.has(method)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `Unknown scoring method ${JSON.stringify(method)}.`,
        "#/scoring/method"
      );
      return null;
    }
    const threshold = fieldOf(value, "pass_threshold");
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "pass_threshold must be a finite number between 0 and 1.",
        "#/scoring/pass_threshold"
      );
      return null;
    }
    return { method: "weighted_binary", pass_threshold: threshold };
  }

  private readChecks(value: Json | undefined): RubricCheck[] | null {
    if (!Array.isArray(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "checks must be an array.",
        "#/checks"
      );
      return null;
    }
    const checks: RubricCheck[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const pointer = `#/checks/${index}`;
      const check =
        raw === undefined ? null : this.readCheck(raw, `#/checks/${index}`);
      if (check === null) {
        this.droppedChecks += 1;
        continue;
      }
      if (seen.has(check.id)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Duplicate check id ${JSON.stringify(check.id)}.`,
          `${pointer}/id`
        );
        this.droppedChecks += 1;
        continue;
      }
      seen.add(check.id);
      checks.push(check);
    }
    return checks;
  }

  private readCheck(
    value: Json | undefined,
    pointer: string
  ): RubricCheck | null {
    if (!isJsonObject(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "A check must be an object.",
        pointer
      );
      return null;
    }
    const kind = fieldOf(value, "kind");
    if (typeof kind !== "string") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "A check needs a kind.",
        `${pointer}/kind`
      );
      return null;
    }
    const id = this.readSafeId(
      fieldOf(value, "id"),
      `${pointer}/id`,
      "check id"
    );
    const weight = this.readWeight(
      fieldOf(value, "weight"),
      `${pointer}/weight`
    );
    const required = fieldOf(value, "required");
    if (typeof required !== "boolean") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "required must be a boolean.",
        `${pointer}/required`
      );
    }
    const description = this.readOptionalString(
      fieldOf(value, "description"),
      `${pointer}/description`
    );
    const evidenceClass = this.readEvidenceClass(
      fieldOf(value, "evidence_class"),
      `${pointer}/evidence_class`,
      pointer
    );
    const onMissing = this.readOnMissing(
      fieldOf(value, "on_missing"),
      `${pointer}/on_missing`
    );
    if (id === null || weight === null) {
      return null;
    }
    const common = {
      id,
      weight,
      required: typeof required === "boolean" ? required : false,
      ...(description === undefined ? {} : { description }),
      ...(evidenceClass === undefined ? {} : { evidence_class: evidenceClass }),
      ...(onMissing === undefined ? {} : { on_missing: onMissing })
    };
    switch (kind) {
      case "predicate":
        return this.readPredicateCheck(value, common, pointer);
      case "event":
        return this.readStreamCheck(value, common, pointer, "event");
      case "documentation_event":
        return this.readStreamCheck(
          value,
          common,
          pointer,
          "documentation_event"
        );
      case "semantic_event":
        return this.readStreamCheck(value, common, pointer, "semantic_event");
      case "sequence":
        return this.readSequenceCheck(value, common, pointer);
      case "json_schema":
        return this.readJsonSchemaCheck(value, common, pointer);
      case "artifact":
        return this.readArtifactCheck(value, common, pointer);
      default:
        this.error(
          DiagnosticCode.RubricInvalid,
          `Unknown check kind ${JSON.stringify(kind)}.`,
          `${pointer}/kind`
        );
        return null;
    }
  }

  private readPredicateCheck(
    value: JsonObject,
    common: Omit<RubricCheck, "kind">,
    pointer: string
  ): RubricCheck | null {
    const expression = this.readExpression(
      fieldOf(value, "expression"),
      `${pointer}/expression`,
      PREDICATE_ROOTS
    );
    if (expression === null) {
      return null;
    }
    return { ...common, kind: "predicate", expression: expression.source };
  }

  private readStreamCheck(
    value: JsonObject,
    common: Omit<RubricCheck, "kind">,
    pointer: string,
    kind: "event" | "documentation_event" | "semantic_event"
  ): RubricCheck | null {
    const match = this.readQuantifier(
      fieldOf(value, "match"),
      `${pointer}/match`
    );
    const minCount = this.readOptionalCount(
      fieldOf(value, "min_count"),
      `${pointer}/min_count`
    );
    const maxCount = this.readOptionalCount(
      fieldOf(value, "max_count"),
      `${pointer}/max_count`
    );
    const where = this.readExpression(
      fieldOf(value, "where"),
      `${pointer}/where`,
      EVENT_ROOTS
    );
    const ordered = fieldOf(value, "ordered");
    if (ordered !== undefined && typeof ordered !== "boolean") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "ordered must be a boolean.",
        `${pointer}/ordered`
      );
    }
    const steps = this.readSteps(fieldOf(value, "steps"), pointer, STEP_ROOTS);
    const usesSteps = steps !== null && steps.length > 0;
    if (kind === "event" && steps !== null) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "Only documentation_event and semantic_event checks declare steps.",
        `${pointer}/steps`
      );
    }
    if (usesSteps && ordered !== true) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "Steps need ordered set to true.",
        `${pointer}/ordered`
      );
    }
    if (where === null) {
      return null;
    }
    if (
      match === "counted" &&
      minCount === undefined &&
      maxCount === undefined
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "A counted match needs min_count or max_count.",
        `${pointer}/match`
      );
    }
    // Bounds only carry meaning in counted mode; an existential or
    // universal check would silently ignore them at evaluation.
    if (
      match !== null &&
      match !== "counted" &&
      (minCount !== undefined || maxCount !== undefined)
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "Only a counted match declares min_count or max_count.",
        minCount !== undefined ? `${pointer}/min_count` : `${pointer}/max_count`
      );
    }
    if (
      minCount !== undefined &&
      maxCount !== undefined &&
      minCount > maxCount
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "min_count is greater than max_count.",
        `${pointer}/min_count`
      );
    }
    if (match === null) {
      return null;
    }
    return {
      ...common,
      kind,
      match,
      where: where.source,
      ...(minCount === undefined ? {} : { min_count: minCount }),
      ...(maxCount === undefined ? {} : { max_count: maxCount }),
      ...(usesSteps ? { ordered: true, steps } : {})
    };
  }

  private readSequenceCheck(
    value: JsonObject,
    common: Omit<RubricCheck, "kind">,
    pointer: string
  ): RubricCheck | null {
    const match = fieldOf(value, "match");
    if (match !== "any" && match !== "all") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "A sequence needs match any or match all.",
        `${pointer}/match`
      );
      return null;
    }
    const maxCandidates = fieldOf(value, "max_candidates");
    if (
      maxCandidates !== undefined &&
      (typeof maxCandidates !== "number" ||
        !Number.isInteger(maxCandidates) ||
        maxCandidates < 1)
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "max_candidates must be a positive integer.",
        `${pointer}/max_candidates`
      );
    }
    const steps = this.readSteps(fieldOf(value, "steps"), pointer, STEP_ROOTS);
    if (steps === null || steps.length === 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "A sequence needs at least one step.",
        `${pointer}/steps`
      );
      return null;
    }
    const capturedNames = new Set<string>();
    for (const step of steps) {
      for (const name of Object.keys(step.capture ?? {})) {
        if (capturedNames.has(name)) {
          this.error(
            DiagnosticCode.RubricInvalid,
            `Step ${JSON.stringify(step.id)} recaptures ${JSON.stringify(name)}.`,
            `${pointer}/steps`
          );
        }
        capturedNames.add(name);
      }
    }
    const postconditions = this.readPostconditions(
      fieldOf(value, "postconditions"),
      pointer
    );
    return {
      ...common,
      kind: "sequence",
      match,
      steps,
      ...(maxCandidates === undefined ||
      typeof maxCandidates !== "number" ||
      !Number.isInteger(maxCandidates)
        ? {}
        : { max_candidates: maxCandidates }),
      ...(postconditions === undefined ? {} : { postconditions })
    };
  }

  private readJsonSchemaCheck(
    value: JsonObject,
    common: Omit<RubricCheck, "kind">,
    pointer: string
  ): RubricCheck | null {
    const target = fieldOf(value, "value");
    if (target !== "report" && target !== "state" && target !== "response") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "value must be report, state, or response.",
        `${pointer}/value`
      );
      return null;
    }
    const reference = fieldOf(value, "schema");
    if (typeof reference !== "string" || reference.length === 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "schema must be a non-empty reference.",
        `${pointer}/schema`
      );
      return null;
    }
    this.checkSchemaReference(reference, `${pointer}/schema`);
    return { ...common, kind: "json_schema", value: target, schema: reference };
  }

  private readArtifactCheck(
    value: JsonObject,
    common: Omit<RubricCheck, "kind">,
    pointer: string
  ): RubricCheck | null {
    const path = fieldOf(value, "path");
    if (typeof path !== "string" || path.length === 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "path must be a non-empty relative path.",
        `${pointer}/path`
      );
      return null;
    }
    const exists = fieldOf(value, "exists");
    if (exists !== undefined && typeof exists !== "boolean") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "exists must be a boolean.",
        `${pointer}/exists`
      );
    }
    const sha256 = fieldOf(value, "sha256");
    if (
      sha256 !== undefined &&
      (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "sha256 must be a lowercase 64 character digest.",
        `${pointer}/sha256`
      );
    }
    const mediaType = fieldOf(value, "media_type");
    if (
      mediaType !== undefined &&
      (typeof mediaType !== "string" || mediaType.length === 0)
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "media_type must be a non-empty string.",
        `${pointer}/media_type`
      );
    }
    const maxBytes = fieldOf(value, "max_bytes");
    if (
      maxBytes !== undefined &&
      (typeof maxBytes !== "number" ||
        !Number.isInteger(maxBytes) ||
        maxBytes < 0)
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "max_bytes must be a non-negative integer.",
        `${pointer}/max_bytes`
      );
    }
    return {
      ...common,
      kind: "artifact",
      path,
      ...(exists !== undefined && typeof exists === "boolean"
        ? { exists }
        : {}),
      ...(typeof sha256 === "string" ? { sha256 } : {}),
      ...(typeof mediaType === "string" ? { media_type: mediaType } : {}),
      ...(typeof maxBytes === "number" ? { max_bytes: maxBytes } : {})
    };
  }

  private readSteps(
    value: Json | undefined,
    pointer: string,
    roots: ReadonlySet<string>
  ): RubricStep[] | null {
    if (value === undefined) {
      return null;
    }
    if (!Array.isArray(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "steps must be an array.",
        `${pointer}/steps`
      );
      return null;
    }
    const steps: RubricStep[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const stepPointer = `${pointer}/steps/${index}`;
      if (!isJsonObject(raw)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          "A step must be an object.",
          stepPointer
        );
        continue;
      }
      const id = this.readSafeId(
        fieldOf(raw, "id"),
        `${stepPointer}/id`,
        "step id"
      );
      const where = this.readExpression(
        fieldOf(raw, "where"),
        `${stepPointer}/where`,
        roots
      );
      if (id === null || where === null) {
        continue;
      }
      if (seen.has(id)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Duplicate step id ${JSON.stringify(id)}.`,
          `${stepPointer}/id`
        );
        continue;
      }
      seen.add(id);
      const capture = this.readCapture(
        fieldOf(raw, "capture"),
        stepPointer,
        roots
      );
      steps.push({
        id,
        where: where.source,
        ...(capture === undefined ? {} : { capture })
      });
    }
    return steps;
  }

  private readCapture(
    value: Json | undefined,
    stepPointer: string,
    roots: ReadonlySet<string>
  ): Record<string, string> | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!isJsonObject(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "capture must be an object.",
        `${stepPointer}/capture`
      );
      return undefined;
    }
    const capture: Record<string, string> = {};
    for (const name of Object.keys(value)) {
      if (!isSafeId(name)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Capture name ${JSON.stringify(name)} is not a safe identifier.`,
          `${stepPointer}/capture`
        );
        continue;
      }
      const source = fieldOf(value, name);
      if (typeof source !== "string" || source.length === 0) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Capture ${JSON.stringify(name)} needs an expression.`,
          `${stepPointer}/capture/${name}`
        );
        continue;
      }
      const compiled = this.readExpression(
        source,
        `${stepPointer}/capture/${name}`,
        roots
      );
      if (compiled === null) {
        continue;
      }
      capture[name] = source;
    }
    return capture;
  }

  private readPostconditions(
    value: Json | undefined,
    pointer: string
  ): RubricPostcondition[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "postconditions must be an array.",
        `${pointer}/postconditions`
      );
      return undefined;
    }
    const postconditions: RubricPostcondition[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const at = `${pointer}/postconditions/${index}`;
      if (!isJsonObject(raw)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          "A postcondition must be an object.",
          at
        );
        continue;
      }
      const id = this.readSafeId(
        fieldOf(raw, "id"),
        `${at}/id`,
        "postcondition id"
      );
      const expression = this.readExpression(
        fieldOf(raw, "expression"),
        `${at}/expression`,
        POSTCONDITION_ROOTS
      );
      if (id === null || expression === null) {
        continue;
      }
      if (seen.has(id)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Duplicate postcondition id ${JSON.stringify(id)}.`,
          `${at}/id`
        );
        continue;
      }
      seen.add(id);
      postconditions.push({ id, expression: expression.source });
    }
    return postconditions;
  }

  private readSignals(value: Json | undefined): RubricSignal[] | null {
    if (!Array.isArray(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "signals must be an array.",
        "#/signals"
      );
      return null;
    }
    const signals: RubricSignal[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const pointer = `#/signals/${index}`;
      if (!isJsonObject(raw)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          "A signal must be an object.",
          pointer
        );
        continue;
      }
      const id = this.readSafeId(
        fieldOf(raw, "id"),
        `${pointer}/id`,
        "signal id"
      );
      const expression = this.readExpression(
        fieldOf(raw, "expression"),
        `${pointer}/expression`,
        PREDICATE_ROOTS
      );
      const description = this.readOptionalString(
        fieldOf(raw, "description"),
        `${pointer}/description`
      );
      const onMissing = this.readOnMissing(
        fieldOf(raw, "on_missing"),
        `${pointer}/on_missing`
      );
      if (id === null || expression === null) {
        continue;
      }
      if (seen.has(id)) {
        this.error(
          DiagnosticCode.RubricInvalid,
          `Duplicate signal id ${JSON.stringify(id)}.`,
          `${pointer}/id`
        );
        continue;
      }
      seen.add(id);
      signals.push({
        id,
        kind: "predicate",
        expression: expression.source,
        ...(description === undefined ? {} : { description }),
        ...(onMissing === undefined ? {} : { on_missing: onMissing })
      });
    }
    return signals;
  }

  private readExpression(
    value: Json | undefined,
    pointer: string,
    allowedRoots: ReadonlySet<string>
  ): CompiledExpression | null {
    if (typeof value !== "string" || value.length === 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "An expression must be a non-empty string.",
        pointer
      );
      return null;
    }
    let compiled: CompiledExpression;
    try {
      compiled = compileExpression(value, this.limits);
    } catch (error: unknown) {
      if (error instanceof ExpressionError) {
        this.error(error.code, error.message, pointer);
        return null;
      }
      throw error;
    }
    const unknown = compiled.rootIdentifiers.filter(
      (name) => !allowedRoots.has(name)
    );
    if (unknown.length > 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `Unknown variable ${JSON.stringify(unknown[0])}. Allowed: ${[
          ...allowedRoots
        ]
          .sort()
          .join(", ")}.`,
        pointer
      );
      return null;
    }
    return compiled;
  }

  private readSafeId(
    value: Json | undefined,
    pointer: string,
    what: string
  ): string | null {
    if (typeof value !== "string" || !isSafeId(value)) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `The ${what} is not a safe identifier.`,
        pointer
      );
      return null;
    }
    return value;
  }

  private readWeight(value: Json | undefined, pointer: string): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "weight must be a finite non-negative number.",
        pointer
      );
      return null;
    }
    return value;
  }

  private readQuantifier(
    value: Json | undefined,
    pointer: string
  ): MatchQuantifier | null {
    if (
      value !== "existential" &&
      value !== "universal" &&
      value !== "counted"
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "match must be existential, universal, or counted.",
        pointer
      );
      return null;
    }
    return value;
  }

  private readOptionalCount(
    value: Json | undefined,
    pointer: string
  ): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "The count bound must be a non-negative integer.",
        pointer
      );
      return undefined;
    }
    return value;
  }

  private readOptionalString(
    value: Json | undefined,
    pointer: string
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "The value must be a string.",
        pointer
      );
      return undefined;
    }
    return value;
  }

  private readEvidenceClass(
    value: Json | undefined,
    pointer: string,
    checkPointer: string
  ): EvidenceClass | undefined {
    if (value === undefined) {
      this.diagnostics.push(
        diagnostic({
          severity: "warning",
          phase: "compile",
          code: DiagnosticCode.RubricInvalid,
          message:
            "The check declares no evidence_class. Section 26.5 requires one.",
          document_uri: this.documentUri,
          json_pointer: `${checkPointer}/evidence_class`
        })
      );
      return undefined;
    }
    if (
      value !== "participant_observable" &&
      value !== "private_domain" &&
      value !== "mixed"
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        "evidence_class must be participant_observable, private_domain, or mixed.",
        pointer
      );
      return undefined;
    }
    return value;
  }

  private readOnMissing(
    value: Json | undefined,
    pointer: string
  ): OnMissing | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value !== "fail" && value !== "skip" && value !== "error") {
      this.error(
        DiagnosticCode.RubricInvalid,
        "on_missing must be fail, skip, or error.",
        pointer
      );
      return undefined;
    }
    return value;
  }

  /** Reject traversal and unresolvable references (section 26.7). */
  private checkSchemaReference(reference: string, pointer: string): void {
    if (
      reference.includes("..") ||
      reference.startsWith("/") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
    ) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `Schema reference ${JSON.stringify(reference)} must be a safe relative path.`,
        pointer
      );
      return;
    }
    if (this.resolveSchema === undefined) {
      return;
    }
    if (this.resolveSchema(reference) === undefined) {
      this.error(
        DiagnosticCode.RubricInvalid,
        `Schema reference ${JSON.stringify(reference)} cannot be resolved.`,
        pointer
      );
    }
  }

  private error(code: string, message: string, pointer: string): void {
    this.failed = true;
    this.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code,
        message,
        document_uri: this.documentUri,
        json_pointer: pointer
      })
    );
  }
}
