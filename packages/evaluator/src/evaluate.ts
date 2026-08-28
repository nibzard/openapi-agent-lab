/**
 * Deterministic evaluator (specification sections 26.2 through 26.8).
 *
 * The evaluator consumes frozen evidence: normalized API exchanges in
 * ingress order, documentation and semantic streams, final state, the
 * parsed participant report, run metadata, and bounded artifact
 * metadata. It never reads the clock, the filesystem, or the network,
 * so the same inputs always produce the same document.
 *
 * Evaluator problems are infrastructure outcomes with stable codes.
 * They set the check status to error and append an infrastructure
 * error record. They never count as a participant task failure.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  SchemaValidator,
  toOalError,
  type Json,
  type JsonObject,
  type SchemaViolation
} from "@oal/core";
import type {
  DocumentationExchange,
  SemanticEvent,
  TraceEvent
} from "@oal/evidence";
import {
  compileExpression,
  ExpressionError,
  type CompiledExpression,
  type ExpressionLimits
} from "./expression.ts";
import type {
  MatchQuantifier,
  OnMissing,
  Rubric,
  RubricCheck,
  RubricPostcondition,
  RubricSignal,
  RubricStep
} from "./rubric.ts";
import {
  EVALUATOR_NAME,
  EVALUATOR_VERSION,
  EVALUATION_SCHEMA_VERSION,
  EvaluatorErrorCode,
  infrastructureError,
  type Evaluation,
  type EvaluationCheckRecord,
  type EvaluationStatus,
  type InfrastructureErrorRecord
} from "./evaluation.ts";

/** Bounded artifact metadata supplied by the evidence store. */
export interface ArtifactMetadata {
  present: boolean;
  bytes: number | null;
  sha256: string | null;
  media_type: string | null;
}

export interface EvaluatorLimits extends ExpressionLimits {
  /** Maximum number of step and event pairs one search may try. */
  maxCandidates: number;
  /** Maximum canonical JSON length of one captured value. */
  maxCaptureBytes: number;
}

export const DEFAULT_EVALUATOR_LIMITS: EvaluatorLimits = {
  maxSourceLength: 4096,
  maxDepth: 64,
  maxSteps: 200000,
  maxCandidates: 200000,
  maxCaptureBytes: 4096
};

/**
 * Artifact reference recorded by every check whose evidence is the
 * parsed participant report (section 26.8). The runner persists that
 * report as participant-report.json beside the evaluation.
 */
export const REPORT_ARTIFACT_REF = "participant-report.json";

export interface EvaluateOptions {
  rubric: Rubric;
  /** Safe identifier of the evaluated run. */
  runId: string;
  /** Frozen run metadata, exposed verbatim to expressions as run. */
  run: JsonObject;
  /** api.exchange records in ingress order. */
  events: readonly TraceEvent[];
  documentationEvents?: readonly DocumentationExchange[] | undefined;
  semanticEvents?: readonly SemanticEvent[] | undefined;
  /** Final backend JSON state. */
  state: Json;
  /** Parsed participant-report.json, or null when absent. */
  report: Json | null;
  artifacts?: Readonly<Record<string, ArtifactMetadata>> | undefined;
  /** Resolves the reference named by a json_schema check. */
  resolveSchema?: ((reference: string) => Json | undefined) | undefined;
  /** Timestamp recorded in the document. Omit it for stable tests. */
  evaluatedAt?: string | undefined;
  limits?: Partial<EvaluatorLimits> | undefined;
}

/** Outcome of one step of an ordered search. */
export interface StepOutcome {
  id: string;
  status: "selected" | "unmatched";
  event_id: string | null;
  sequence: number | null;
  captured: JsonObject;
}

export interface PostconditionOutcome {
  id: string;
  status: "passed" | "failed" | "error";
  expression: string;
}

/**
 * One evaluated check. The fields beyond the wire document carry the
 * step outcomes and the expression source that the wire form omits.
 */
export interface CheckResult {
  id: string;
  kind: RubricCheck["kind"];
  status: EvaluationStatus;
  weight: number;
  required: boolean;
  message: string;
  eventIds: string[];
  captures: JsonObject;
  failedPointers: string[];
  artifactRefs: string[];
  steps: StepOutcome[];
  postconditions: PostconditionOutcome[];
  expressionSource: string | null;
  error: InfrastructureErrorRecord | null;
}

export interface EvaluationResult {
  rubricId: string;
  runId: string;
  rubricSha256: string;
  evaluatedAt: string | undefined;
  status: EvaluationStatus;
  score: number;
  passedWeight: number;
  totalWeight: number;
  checks: CheckResult[];
  signals: Record<string, boolean>;
  infrastructureErrors: InfrastructureErrorRecord[];
}

interface EvaluationContext {
  events: readonly TraceEvent[];
  documentationEvents: readonly DocumentationExchange[];
  semanticEvents: readonly SemanticEvent[];
  state: Json;
  report: Json | null;
  run: JsonObject;
  artifacts: Readonly<Record<string, ArtifactMetadata>>;
  limits: EvaluatorLimits;
  resolveSchema: (reference: string) => Json | undefined;
  compiled(source: string): CompiledExpression;
}

interface StreamCandidate {
  event: Json;
  eventId: string;
  sequence: number | null;
}

interface StepSelection {
  step: RubricStep;
  eventIndex: number;
  eventId: string;
  sequence: number | null;
  captured: JsonObject;
}

interface SequenceQuery {
  checkId: string;
  steps: readonly RubricStep[];
  postconditions: readonly RubricPostcondition[];
  maxCandidates: number | undefined;
}

type SequenceOutcome =
  | { kind: "matched"; selections: StepSelection[]; captures: JsonObject }
  | { kind: "unmatched"; deepest: StepSelection[]; failedStepId: string | null }
  | { kind: "candidate-limit"; attempted: number }
  | { kind: "capture-limit"; name: string; bytes: number };

function toJsonValue(value: unknown): Json {
  return value as Json;
}

function apiCandidates(events: readonly TraceEvent[]): StreamCandidate[] {
  return events.map((event) => ({
    event: toJsonValue(event),
    eventId: event.event_id,
    sequence: event.sequence
  }));
}

function documentationCandidates(
  events: readonly DocumentationExchange[]
): StreamCandidate[] {
  return events.map((event) => ({
    event: toJsonValue(event),
    eventId: event.event_id,
    sequence: event.sequence
  }));
}

function semanticCandidates(
  events: readonly SemanticEvent[]
): StreamCandidate[] {
  return events.map((event) => ({
    event: toJsonValue(event),
    eventId: event.event_id,
    sequence: event.semantic_sequence
  }));
}

/** Already selected step evidence, exposed to later steps. */
function stepEvidence(selections: readonly StepSelection[]): Json {
  return selections.map((selection) => ({
    id: selection.step.id,
    event_id: selection.eventId,
    sequence: selection.sequence
  }));
}

function stepOutcome(selection: StepSelection): StepOutcome {
  return {
    id: selection.step.id,
    status: "selected",
    event_id: selection.eventId,
    sequence: selection.sequence,
    captured: selection.captured
  };
}

function unmatchedStep(id: string): StepOutcome {
  return {
    id,
    status: "unmatched",
    event_id: null,
    sequence: null,
    captured: {}
  };
}

/**
 * Evaluate one run against one rubric. The function is synchronous and
 * free of side effects; it reads only the frozen inputs.
 */
export function evaluateRubric(options: EvaluateOptions): EvaluationResult {
  const limits: EvaluatorLimits = {
    ...DEFAULT_EVALUATOR_LIMITS,
    ...(options.limits ?? {})
  };
  const cache = new Map<string, CompiledExpression>();
  const context: EvaluationContext = {
    events: options.events,
    documentationEvents: options.documentationEvents ?? [],
    semanticEvents: options.semanticEvents ?? [],
    state: options.state,
    report: options.report,
    run: options.run,
    artifacts: options.artifacts ?? {},
    limits,
    resolveSchema: options.resolveSchema ?? (() => undefined),
    compiled: (source: string): CompiledExpression => {
      const cached = cache.get(source);
      if (cached !== undefined) {
        return cached;
      }
      const compiled = compileExpression(source, limits);
      cache.set(source, compiled);
      return compiled;
    }
  };
  const checks = options.rubric.checks.map((check) =>
    evaluateCheck(check, context)
  );
  const signals: Record<string, boolean> = {};
  const infrastructureErrors: InfrastructureErrorRecord[] = [];
  for (const check of checks) {
    if (check.error !== null) {
      infrastructureErrors.push(check.error);
    }
  }
  for (const signal of options.rubric.signals) {
    const outcome = signalOutcome(signal, context);
    signals[signal.id] = outcome.value;
    if (outcome.error !== null) {
      infrastructureErrors.push(outcome.error);
    }
  }
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = checks
    .filter((check) => check.status === "passed")
    .reduce((sum, check) => sum + check.weight, 0);
  const score = totalWeight > 0 ? passedWeight / totalWeight : 0;
  return {
    rubricId: options.rubric.id,
    runId: options.runId,
    rubricSha256: canonicalJsonSha256(toJsonValue(options.rubric)),
    evaluatedAt: options.evaluatedAt,
    status: overallStatus(checks, score, options.rubric.scoring.pass_threshold),
    score,
    passedWeight,
    totalWeight,
    checks,
    signals,
    infrastructureErrors
  };
}

/**
 * Overall status. An error dominates everything else, a skip comes
 * next, and only then do the threshold and the required checks decide
 * between passed and failed.
 */
function overallStatus(
  checks: readonly CheckResult[],
  score: number,
  threshold: number
): EvaluationStatus {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  if (checks.some((check) => check.status === "skipped")) {
    return "skipped";
  }
  const requiredFailed = checks.some(
    (check) => check.required && check.status !== "passed"
  );
  if (requiredFailed || score < threshold) {
    return "failed";
  }
  return "passed";
}

function evaluateCheck(
  check: RubricCheck,
  context: EvaluationContext
): CheckResult {
  const base: CheckResult = {
    id: check.id,
    kind: check.kind,
    status: "failed",
    weight: check.weight,
    required: check.required,
    message: "",
    eventIds: [],
    captures: {},
    failedPointers: [],
    artifactRefs: [],
    steps: [],
    postconditions: [],
    expressionSource: null,
    error: null
  };
  try {
    switch (check.kind) {
      case "predicate":
        return predicateCheck(check, context, base);
      case "event":
        return streamCheck(check, context, base, apiCandidates(context.events));
      case "documentation_event":
        return orderedOrQuantifiedCheck(
          check,
          context,
          base,
          documentationCandidates(context.documentationEvents)
        );
      case "semantic_event":
        return orderedOrQuantifiedCheck(
          check,
          context,
          base,
          semanticCandidates(context.semanticEvents)
        );
      case "sequence":
        return runSequence(
          {
            checkId: check.id,
            steps: check.steps,
            postconditions: check.postconditions ?? [],
            maxCandidates: check.max_candidates
          },
          check.match,
          apiCandidates(context.events),
          context,
          base
        );
      case "json_schema":
        return jsonSchemaCheck(check, context, base);
      case "artifact":
        return artifactCheck(check, context, base);
    }
  } catch (error: unknown) {
    if (error instanceof ExpressionError) {
      return expressionErrorResult(base, check.id, error);
    }
    return crashed(base, check.id, error);
  }
}

function crashed(
  base: CheckResult,
  checkId: string,
  error: unknown
): CheckResult {
  return {
    ...base,
    status: "error",
    message: "The evaluator failed while running this check.",
    error: infrastructureError({
      code: EvaluatorErrorCode.EvaluatorCrashed,
      message: toOalError(error).message,
      checkId
    })
  };
}

function onMissingPolicy(onMissing: OnMissing | undefined): OnMissing {
  return onMissing ?? "fail";
}

/** Apply the on_missing policy of one check to a missing input. */
function missingResult(
  base: CheckResult,
  onMissing: OnMissing | undefined,
  what: string
): CheckResult {
  const policy = onMissingPolicy(onMissing);
  if (policy === "skip") {
    return { ...base, status: "skipped", message: `${what} missing.` };
  }
  if (policy === "error") {
    return {
      ...base,
      status: "error",
      message: `${what} missing.`,
      error: infrastructureError({
        code: EvaluatorErrorCode.CheckMissingValue,
        message: `${what} missing.`,
        checkId: base.id
      })
    };
  }
  return { ...base, status: "failed", message: `${what} missing.` };
}

function predicateScope(context: EvaluationContext): JsonObject {
  return {
    state: context.state,
    report: context.report,
    run: context.run,
    artifacts: toJsonValue(context.artifacts),
    events: toJsonValue(context.events),
    documentation_events: toJsonValue(context.documentationEvents),
    semantic_events: toJsonValue(context.semanticEvents)
  };
}

function postconditionScope(
  context: EvaluationContext,
  vars: JsonObject
): JsonObject {
  return {
    state: context.state,
    report: context.report,
    run: context.run,
    artifacts: toJsonValue(context.artifacts),
    vars
  };
}

function predicateCheck(
  check: Extract<RubricCheck, { kind: "predicate" }>,
  context: EvaluationContext,
  base: CheckResult
): CheckResult {
  const started: CheckResult = {
    ...base,
    expressionSource: check.expression,
    ...(readsReport(check.expression, context)
      ? { artifactRefs: [REPORT_ARTIFACT_REF] }
      : {})
  };
  if (referencesReport(check.expression, context)) {
    return missingResult(started, check.on_missing, "The report is");
  }
  const matched = context
    .compiled(check.expression)
    .evaluatePredicate(predicateScope(context));
  return {
    ...started,
    status: matched ? "passed" : "failed",
    message: matched ? "The predicate held." : "The predicate did not hold."
  };
}

function signalOutcome(
  signal: RubricSignal,
  context: EvaluationContext
): { value: boolean; error: InfrastructureErrorRecord | null } {
  if (referencesReport(signal.expression, context)) {
    if (onMissingPolicy(signal.on_missing) === "error") {
      return {
        value: false,
        error: infrastructureError({
          code: EvaluatorErrorCode.CheckMissingValue,
          message: "The report is missing.",
          checkId: signal.id
        })
      };
    }
    return { value: false, error: null };
  }
  try {
    return {
      value: context
        .compiled(signal.expression)
        .evaluatePredicate(predicateScope(context)),
      error: null
    };
  } catch (error: unknown) {
    return {
      value: false,
      error: infrastructureError({
        code: errorCodeOf(error),
        message: errorMessageOf(error),
        checkId: signal.id
      })
    };
  }
}

/** A null report never satisfies a predicate that reads it. */
function referencesReport(
  expression: string,
  context: EvaluationContext
): boolean {
  return context.report === null && readsReport(expression, context);
}

/** Whether an expression reads the parsed participant report. */
function readsReport(expression: string, context: EvaluationContext): boolean {
  return context.compiled(expression).rootIdentifiers.includes("report");
}

/**
 * Documentation and semantic checks either quantify over single
 * events, or run an ordered search over the events that pass the
 * where filter. The declared match mode governs both shapes:
 * existential needs one complete match, universal walks the steps in
 * stream order, and counted bounds the number of complete matches.
 */
function orderedOrQuantifiedCheck(
  check:
    | Extract<RubricCheck, { kind: "documentation_event" }>
    | Extract<RubricCheck, { kind: "semantic_event" }>,
  context: EvaluationContext,
  base: CheckResult,
  candidates: readonly StreamCandidate[]
): CheckResult {
  if (check.steps !== undefined && check.steps.length > 0) {
    const filtered = candidates.filter((candidate) =>
      context.compiled(check.where).evaluatePredicate({
        event: candidate.event
      })
    );
    const started: CheckResult = { ...base, expressionSource: check.where };
    if (check.match === "counted") {
      return countedSequence(check, filtered, context, started);
    }
    return runSequence(
      {
        checkId: check.id,
        steps: check.steps,
        postconditions: [],
        maxCandidates: undefined
      },
      check.match === "universal" ? "all" : "any",
      filtered,
      context,
      started
    );
  }
  return streamCheck(check, context, base, candidates);
}

/**
 * A counted ordered check bounds the number of complete ordered
 * matches. Matches are counted greedily and without overlap: every
 * search resumes after the last event of the previous match and picks
 * the lexicographically smallest complete match, so the count never
 * depends on search order (sections 26.4 and 26.6).
 */
function countedSequence(
  check:
    | Extract<RubricCheck, { kind: "documentation_event" }>
    | Extract<RubricCheck, { kind: "semantic_event" }>,
  candidates: readonly StreamCandidate[],
  context: EvaluationContext,
  base: CheckResult
): CheckResult {
  const outcome = countMatches(check.steps ?? [], candidates, context);
  if (outcome.kind === "candidate-limit" || outcome.kind === "capture-limit") {
    return limitResult(base, check.id, outcome);
  }
  const status = quantifierStatus(
    "counted",
    check.min_count,
    check.max_count,
    outcome.count,
    outcome.count
  );
  if (outcome.first === null) {
    const failedStepId = status === "failed" ? outcome.failedStepId : null;
    return {
      ...base,
      status,
      steps: [
        ...outcome.deepest.map((selection) => stepOutcome(selection)),
        ...(failedStepId === null ? [] : [unmatchedStep(failedStepId)])
      ],
      eventIds: outcome.deepest.map((selection) => selection.eventId),
      failedPointers: failedStepId === null ? [] : [`steps/${failedStepId}`],
      message:
        failedStepId === null
          ? `${String(outcome.count)} ordered matches met the counted bounds.`
          : `No ordered match; step ${JSON.stringify(
              failedStepId
            )} found no event.`
    };
  }
  return {
    ...base,
    status,
    steps: outcome.first.selections.map((selection) => stepOutcome(selection)),
    eventIds: outcome.first.selections.map((selection) => selection.eventId),
    captures: outcome.first.captures,
    message:
      status === "passed"
        ? `${String(outcome.count)} ordered matches met the counted bounds.`
        : `${String(outcome.count)} ordered matches broke the counted bounds.`
  };
}

function streamCheck(
  check:
    | Extract<RubricCheck, { kind: "event" }>
    | Extract<RubricCheck, { kind: "documentation_event" }>
    | Extract<RubricCheck, { kind: "semantic_event" }>,
  context: EvaluationContext,
  base: CheckResult,
  candidates: readonly StreamCandidate[]
): CheckResult {
  const started: CheckResult = { ...base, expressionSource: check.where };
  const matched = candidates.filter((candidate) =>
    context.compiled(check.where).evaluatePredicate({ event: candidate.event })
  );
  const total = candidates.length;
  const count = matched.length;
  const status = quantifierStatus(
    check.match,
    check.min_count,
    check.max_count,
    count,
    total
  );
  return {
    ...started,
    status,
    eventIds: matched.map((candidate) => candidate.eventId),
    message: `${count} of ${total} events matched the ${check.match} condition.`
  };
}

function quantifierStatus(
  match: MatchQuantifier,
  minCount: number | undefined,
  maxCount: number | undefined,
  count: number,
  total: number
): EvaluationStatus {
  if (match === "existential") {
    return count > 0 ? "passed" : "failed";
  }
  if (match === "universal") {
    return count === total ? "passed" : "failed";
  }
  const aboveMinimum = minCount === undefined || count >= minCount;
  const belowMaximum = maxCount === undefined || count <= maxCount;
  return aboveMinimum && belowMaximum ? "passed" : "failed";
}

/** The two resource-limit outcomes of a sequence search. */
type LimitOutcome = Extract<
  SequenceOutcome,
  { kind: "candidate-limit" | "capture-limit" }
>;

function limitResult(
  base: CheckResult,
  checkId: string,
  outcome: LimitOutcome
): CheckResult {
  if (outcome.kind === "candidate-limit") {
    return {
      ...base,
      status: "error",
      message: `The search exceeded the candidate limit after ${outcome.attempted} attempts.`,
      error: infrastructureError({
        code: EvaluatorErrorCode.CheckCandidateLimit,
        message: `Sequence search for ${JSON.stringify(
          checkId
        )} exceeded max_candidates.`,
        checkId
      })
    };
  }
  return {
    ...base,
    status: "error",
    message: `Captured ${JSON.stringify(outcome.name)} is larger than the capture limit.`,
    error: infrastructureError({
      code: EvaluatorErrorCode.CheckCaptureLimit,
      message: `Capture ${JSON.stringify(outcome.name)} in ${JSON.stringify(
        checkId
      )} is ${String(outcome.bytes)} bytes.`,
      checkId
    })
  };
}

function runSequence(
  query: SequenceQuery,
  match: "any" | "all",
  candidates: readonly StreamCandidate[],
  context: EvaluationContext,
  base: CheckResult
): CheckResult {
  const outcome =
    match === "all"
      ? matchAllSteps(query.steps, candidates, context)
      : searchSequence(query.steps, candidates, context, query.maxCandidates);
  if (outcome.kind === "candidate-limit" || outcome.kind === "capture-limit") {
    return limitResult(base, query.checkId, outcome);
  }
  if (outcome.kind === "unmatched") {
    const failedStepId = outcome.failedStepId;
    return {
      ...base,
      status: "failed",
      steps: [
        ...outcome.deepest.map((selection) => stepOutcome(selection)),
        ...(failedStepId === null ? [] : [unmatchedStep(failedStepId)])
      ],
      eventIds: outcome.deepest.map((selection) => selection.eventId),
      failedPointers: failedStepId === null ? [] : [`steps/${failedStepId}`],
      message:
        failedStepId === null
          ? "The event stream is too short for the ordered steps."
          : `No complete match; step ${JSON.stringify(failedStepId)} found no event.`
    };
  }
  return matchedSequence(query, context, base, outcome);
}

function matchedSequence(
  query: SequenceQuery,
  context: EvaluationContext,
  base: CheckResult,
  outcome: {
    selections: StepSelection[];
    captures: JsonObject;
  }
): CheckResult {
  const outcomes: PostconditionOutcome[] = [];
  const failedPointers: string[] = [];
  let error: InfrastructureErrorRecord | null = null;
  let errorSource: string | null = null;
  let failedPostcondition: string | null = null;
  for (const postcondition of query.postconditions) {
    if (error !== null) {
      outcomes.push({
        id: postcondition.id,
        status: "error",
        expression: postcondition.expression
      });
      continue;
    }
    try {
      const held = context
        .compiled(postcondition.expression)
        .evaluatePredicate(postconditionScope(context, outcome.captures));
      outcomes.push({
        id: postcondition.id,
        status: held ? "passed" : "failed",
        expression: postcondition.expression
      });
      if (!held && failedPostcondition === null) {
        failedPostcondition = postcondition.id;
      }
    } catch (caught) {
      outcomes.push({
        id: postcondition.id,
        status: "error",
        expression: postcondition.expression
      });
      error = infrastructureError({
        code: errorCodeOf(caught),
        message: errorMessageOf(caught),
        checkId: query.checkId
      });
      errorSource = postcondition.expression;
    }
  }
  if (error !== null) {
    return {
      ...base,
      status: "error",
      steps: outcome.selections.map((selection) => stepOutcome(selection)),
      eventIds: outcome.selections.map((selection) => selection.eventId),
      captures: outcome.captures,
      postconditions: outcomes,
      expressionSource: errorSource,
      message: "A postcondition expression failed to evaluate.",
      error
    };
  }
  if (failedPostcondition !== null) {
    failedPointers.push(`postconditions/${failedPostcondition}`);
  }
  const selected = outcome.selections.map((selection) =>
    stepOutcome(selection)
  );
  return {
    ...base,
    status: failedPostcondition === null ? "passed" : "failed",
    steps: selected,
    eventIds: outcome.selections.map((selection) => selection.eventId),
    captures: outcome.captures,
    postconditions: outcomes,
    failedPointers,
    message:
      failedPostcondition === null
        ? `Matched ${String(selected.length)} ordered steps; ${String(
            outcomes.length
          )} postconditions passed.`
        : `Matched ${String(selected.length)} ordered steps; postcondition ${JSON.stringify(
            failedPostcondition
          )} failed.`
  };
}

/** Shared candidate budget across the searches of one check. */
interface CandidateBudget {
  /** Total candidate pairs the searches may try. */
  ceiling: number;
  /** Pairs tried so far, shared so counting stays bounded. */
  attempted: number;
}

/** Result of counting the ordered matches of one stream. */
interface CountedMatches {
  kind: "counted";
  count: number;
  /** The lexicographically smallest match, reported as the evidence. */
  first: { selections: StepSelection[]; captures: JsonObject } | null;
  deepest: StepSelection[];
  failedStepId: string | null;
}

/**
 * Count complete ordered matches without overlap. Every round takes
 * the lexicographically smallest complete match from where the
 * previous one ended, and the rounds share one candidate budget, so
 * the count is deterministic and bounded.
 */
function countMatches(
  steps: readonly RubricStep[],
  candidates: readonly StreamCandidate[],
  context: EvaluationContext
): CountedMatches | LimitOutcome {
  const budget: CandidateBudget = {
    ceiling: context.limits.maxCandidates,
    attempted: 0
  };
  let start = 0;
  let count = 0;
  let first: { selections: StepSelection[]; captures: JsonObject } | null =
    null;
  let deepest: StepSelection[] = [];
  let failedStepId: string | null = null;
  for (;;) {
    const outcome = searchSequence(
      steps,
      candidates,
      context,
      undefined,
      start,
      budget
    );
    if (outcome.kind === "matched") {
      count += 1;
      if (first === null) {
        first = { selections: outcome.selections, captures: outcome.captures };
      }
      const last = outcome.selections[outcome.selections.length - 1];
      const resume = (last?.eventIndex ?? -1) + 1;
      if (resume >= candidates.length) {
        return { kind: "counted", count, first, deepest, failedStepId };
      }
      start = resume;
      continue;
    }
    if (outcome.kind === "unmatched") {
      deepest = outcome.deepest;
      failedStepId = outcome.failedStepId;
      return { kind: "counted", count, first, deepest, failedStepId };
    }
    return outcome;
  }
}

/**
 * Backtracking search for one complete ordered match. Candidates are
 * tried in stream order at every step, so the first complete match is
 * the lexicographically smallest event tuple (section 26.6).
 */
function searchSequence(
  steps: readonly RubricStep[],
  candidates: readonly StreamCandidate[],
  context: EvaluationContext,
  maxCandidates: number | undefined,
  start = 0,
  budget?: CandidateBudget
): SequenceOutcome {
  const counter: CandidateBudget = budget ?? {
    ceiling: maxCandidates ?? context.limits.maxCandidates,
    attempted: 0
  };
  let deepest: StepSelection[] = [];
  const recurse = (
    stepIndex: number,
    startIndex: number,
    vars: JsonObject,
    selections: StepSelection[]
  ): SequenceOutcome | null => {
    if (selections.length > deepest.length) {
      deepest = selections;
    }
    if (stepIndex >= steps.length) {
      return { kind: "matched", selections, captures: vars };
    }
    const step = steps[stepIndex];
    if (step === undefined) {
      return null;
    }
    for (let index = startIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) {
        continue;
      }
      counter.attempted += 1;
      if (counter.attempted > counter.ceiling) {
        return { kind: "candidate-limit", attempted: counter.attempted };
      }
      const scope: JsonObject = {
        event: candidate.event,
        vars,
        steps: stepEvidence(selections)
      };
      if (!context.compiled(step.where).evaluatePredicate(scope)) {
        continue;
      }
      const captured = captureValues(step, scope, context);
      if (captured.kind !== "values") {
        return captured;
      }
      const selection: StepSelection = {
        step,
        eventIndex: index,
        eventId: candidate.eventId,
        sequence: candidate.sequence,
        captured: captured.values
      };
      const result = recurse(
        stepIndex + 1,
        index + 1,
        { ...vars, ...captured.values },
        [...selections, selection]
      );
      if (result !== null) {
        return result;
      }
    }
    return null;
  };
  const outcome = recurse(0, start, {}, []);
  if (outcome !== null) {
    return outcome;
  }
  return {
    kind: "unmatched",
    deepest,
    failedStepId: stepIdAt(steps, deepest.length)
  };
}

/** Every step consumes exactly one event, in stream order. */
function matchAllSteps(
  steps: readonly RubricStep[],
  candidates: readonly StreamCandidate[],
  context: EvaluationContext
): SequenceOutcome {
  const selections: StepSelection[] = [];
  const vars: JsonObject = {};
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const candidate = candidates[index];
    if (step === undefined || candidate === undefined) {
      return {
        kind: "unmatched",
        deepest: selections,
        failedStepId: step === undefined ? null : step.id
      };
    }
    const scope: JsonObject = {
      event: candidate.event,
      vars,
      steps: stepEvidence(selections)
    };
    if (!context.compiled(step.where).evaluatePredicate(scope)) {
      return { kind: "unmatched", deepest: selections, failedStepId: step.id };
    }
    const captured = captureValues(step, scope, context);
    if (captured.kind !== "values") {
      return captured;
    }
    selections.push({
      step,
      eventIndex: index,
      eventId: candidate.eventId,
      sequence: candidate.sequence,
      captured: captured.values
    });
    Object.assign(vars, captured.values);
  }
  return { kind: "matched", selections, captures: vars };
}

function stepIdAt(steps: readonly RubricStep[], index: number): string | null {
  const step = steps[index];
  return step === undefined ? null : step.id;
}

type CaptureOutcome =
  | { kind: "values"; values: JsonObject }
  | { kind: "capture-limit"; name: string; bytes: number };

/** Captures run only after the step predicate succeeds (26.6). */
function captureValues(
  step: RubricStep,
  scope: JsonObject,
  context: EvaluationContext
): CaptureOutcome {
  const values: JsonObject = {};
  for (const [name, source] of Object.entries(step.capture ?? {})) {
    const value = context.compiled(source).evaluate(scope);
    const encoded = canonicalJson(value);
    if (encoded.length > context.limits.maxCaptureBytes) {
      return { kind: "capture-limit", name, bytes: encoded.length };
    }
    values[name] = value;
  }
  return { kind: "values", values };
}

function errorCodeOf(error: unknown): string {
  return error instanceof ExpressionError
    ? error.code
    : EvaluatorErrorCode.EvaluatorCrashed;
}

function errorMessageOf(error: unknown): string {
  return toOalError(error).message;
}

function expressionErrorResult(
  base: CheckResult,
  checkId: string,
  error: unknown
): CheckResult {
  return {
    ...base,
    status: "error",
    message: "The expression failed to evaluate.",
    error: infrastructureError({
      code: errorCodeOf(error),
      message: errorMessageOf(error),
      checkId
    })
  };
}

function jsonSchemaCheck(
  check: Extract<RubricCheck, { kind: "json_schema" }>,
  context: EvaluationContext,
  base: CheckResult
): CheckResult {
  const schema = context.resolveSchema(check.schema);
  if (schema === undefined) {
    return {
      ...base,
      status: "error",
      message: `Schema ${JSON.stringify(check.schema)} could not be resolved.`,
      error: infrastructureError({
        code: EvaluatorErrorCode.RubricSchemaUnresolved,
        message: `Schema reference ${JSON.stringify(check.schema)} is not loaded.`,
        checkId: check.id
      })
    };
  }
  const started: CheckResult = {
    ...base,
    ...(check.value === "report" ? { artifactRefs: [REPORT_ARTIFACT_REF] } : {})
  };
  const target = jsonSchemaTarget(check.value, context);
  if (target === null) {
    return missingResult(
      started,
      check.on_missing,
      `The ${check.value} value is`
    );
  }
  const violations = new SchemaValidator(schema).errors(target);
  if (violations.length === 0) {
    return {
      ...started,
      status: "passed",
      message: `The ${check.value} value matches the required schema.`
    };
  }
  return {
    ...started,
    status: "failed",
    failedPointers: uniqueStrings(violations.map(violationPointer)),
    message: `The ${check.value} value has ${String(
      violations.length
    )} schema violations.`
  };
}

/**
 * The response target is the JSON body of the last API exchange that
 * produced one. Section 26.4 leaves the choice open; this rule is
 * deterministic and independent of timing.
 */
function jsonSchemaTarget(
  value: "report" | "state" | "response",
  context: EvaluationContext
): Json | null {
  if (value === "report") {
    return context.report;
  }
  if (value === "state") {
    return context.state;
  }
  for (let index = context.events.length - 1; index >= 0; index -= 1) {
    const event = context.events[index];
    if (event === undefined) {
      continue;
    }
    const body = event.response === null ? null : event.response.body;
    if (body !== null && body.kind === "json") {
      return body.value;
    }
  }
  return null;
}

function artifactCheck(
  check: Extract<RubricCheck, { kind: "artifact" }>,
  context: EvaluationContext,
  base: CheckResult
): CheckResult {
  const metadata: ArtifactMetadata | undefined = context.artifacts[check.path];
  if (metadata === undefined && check.exists !== false) {
    return missingResult(base, check.on_missing, `Artifact ${check.path} is`);
  }
  const present = metadata?.present ?? false;
  const failures: string[] = [];
  if (check.exists !== undefined && check.exists !== present) {
    failures.push(
      present
        ? "the artifact exists but must not"
        : "the artifact does not exist"
    );
  }
  if (check.sha256 !== undefined && metadata?.sha256 !== check.sha256) {
    failures.push(`the digest is ${JSON.stringify(metadata?.sha256 ?? null)}`);
  }
  if (
    check.media_type !== undefined &&
    metadata?.media_type !== check.media_type
  ) {
    failures.push(
      `the media type is ${JSON.stringify(metadata?.media_type ?? null)}`
    );
  }
  if (check.max_bytes !== undefined) {
    const bytes = metadata?.bytes ?? null;
    if (bytes === null || bytes > check.max_bytes) {
      failures.push(`the size is ${JSON.stringify(bytes)}`);
    }
  }
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    artifactRefs: [check.path],
    failedPointers: failures.length === 0 ? [] : [check.path],
    message:
      failures.length === 0
        ? `Artifact ${check.path} matches every assertion.`
        : `Artifact ${check.path} failed: ${failures.join("; ")}.`
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Point a required violation at the property it names. The validator
 * reports the parent pointer for a missing property, which would name
 * the whole document instead of the gap in it.
 */
function violationPointer(violation: SchemaViolation): string {
  if (violation.code !== "required") {
    return violation.pointer;
  }
  const named = /"([^"]+)" is missing/.exec(violation.message);
  return named === null
    ? violation.pointer
    : `${violation.pointer}/${named[1] ?? ""}`;
}

export interface EvaluationMetadata {
  evaluator?: { name: string; version: string } | undefined;
}

/** Project the rich result into the wire document of section 26.8. */
export function toEvaluation(
  result: EvaluationResult,
  metadata: EvaluationMetadata = {}
): Evaluation {
  const checks: EvaluationCheckRecord[] = result.checks.map((check) => ({
    id: check.id,
    status: check.status,
    weight: check.weight,
    required: check.required,
    ...(check.eventIds.length === 0 ? {} : { event_ids: check.eventIds }),
    ...(Object.keys(check.captures).length === 0
      ? {}
      : { captures: check.captures }),
    ...(check.failedPointers.length === 0
      ? {}
      : { failed_pointers: check.failedPointers }),
    ...(check.artifactRefs.length === 0
      ? {}
      : { artifact_refs: check.artifactRefs }),
    message: check.message
  }));
  return {
    schema_version: EVALUATION_SCHEMA_VERSION,
    rubric_id: result.rubricId,
    run_id: result.runId,
    ...(result.evaluatedAt === undefined
      ? {}
      : { evaluated_at: result.evaluatedAt }),
    evaluator:
      metadata.evaluator === undefined
        ? { name: EVALUATOR_NAME, version: EVALUATOR_VERSION }
        : metadata.evaluator,
    rubric_sha256: result.rubricSha256,
    status: result.status,
    score: result.score,
    passed_weight: result.passedWeight,
    total_weight: result.totalWeight,
    checks,
    signals: result.signals,
    infrastructure_errors: result.infrastructureErrors
  };
}
