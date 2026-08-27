/**
 * Hidden trace alignment for one compiled workflow (specification section
 * 20.3).
 *
 * Alignment is a pure search. It never makes an API call, never reads the
 * clock, and never inspects participant state. Steps are processed in
 * dependency order and matched against events in sequence order. The search
 * is a depth-first walk with backtracking, so an incidental early event that
 * later breaks a criterion does not consume it.
 *
 * Every complete assignment of steps to events is enumerated inside a
 * candidate budget. A step that no assignment fixes on one event is reported
 * as ambiguous. When no complete assignment exists, the deepest partial
 * assignment explains the break: the failing step is `failed` when events with
 * the right operation key existed but criteria rejected them, `unmatched` when
 * no event carried the key, and every later step is `skipped` because its
 * dependency chain broke.
 */

import type { Json, JsonObject } from "@oal/core";

import type {
  CompiledCriterion,
  CompiledOutput,
  CompiledStep,
  CompiledWorkflow
} from "./compile.ts";
import {
  evaluateCriterion,
  evaluateRuntimeSource,
  type CriterionEvaluation,
  type RuntimeContext
} from "./expressions.ts";

/**
 * Minimal structural event shape. The runner adapts its normalized trace
 * events to this type; alignment reads nothing else from them.
 */
export interface AlignmentEvent {
  readonly sequence: number;
  readonly operationKey: string | null;
  readonly request: { readonly body: unknown } | null;
  readonly response: { readonly status: number; readonly body: unknown } | null;
}

export type StepOutcome =
  | "matched"
  | "unmatched"
  | "ambiguous"
  | "skipped"
  | "failed";

export type AlignmentReason =
  | "dependency-unmatched"
  | "no-candidate-event"
  | "criteria-failed"
  | "operation-unresolved"
  | "ambiguous-assignment";

export interface CriterionOutcome {
  readonly condition: string;
  readonly passed: boolean;
  readonly error: string | null;
}

export interface StepAlignment {
  readonly step_id: string;
  readonly outcome: StepOutcome;
  readonly reason: AlignmentReason | null;
  /** Event sequences this step used in the chosen assignment. */
  readonly event_sequences: readonly number[];
  /** Other event sequences that also complete the workflow. */
  readonly alternative_sequences: readonly number[];
  readonly resolved_outputs: Readonly<Record<string, Json>>;
  readonly criteria: readonly CriterionOutcome[];
}

export interface WorkflowAlignment {
  readonly workflow_id: string;
  /** True when at least one complete assignment exists. */
  readonly matched: boolean;
  /** True when more than one complete assignment exists. */
  readonly ambiguous: boolean;
  /** True when a budget stopped the search early. */
  readonly truncated: boolean;
  readonly candidates_tried: number;
  readonly assignment_count: number;
  readonly steps: readonly StepAlignment[];
}

export interface AlignOptions {
  /** Maximum candidate events examined. Default 10_000. */
  readonly maxCandidates?: number;
  /** Maximum complete assignments kept. Default 16. */
  readonly maxAssignments?: number;
  /** Workflow inputs used to resolve `$inputs.<name>`. */
  readonly inputs?: JsonObject;
}

export const DEFAULT_MAX_CANDIDATES = 10_000;
export const DEFAULT_MAX_ASSIGNMENTS = 16;

interface NormalizedEvent {
  readonly sequence: number;
  readonly operationKey: string | null;
  readonly status: number | null;
  readonly requestBody: Json | null;
  readonly responseBody: Json | null;
}

interface SearchState {
  readonly events: readonly NormalizedEvent[];
  readonly steps: readonly CompiledStep[];
  readonly inputs: JsonObject;
  readonly maxCandidates: number;
  readonly maxAssignments: number;
  tried: number;
  truncated: boolean;
  assignments: number[][];
  firstCriteria: CriterionOutcome[][];
  firstOutputs: JsonObject[];
  sequencesPerStep: Set<number>[];
  deepest: number;
  deepestAssignment: number[];
  deepestCriteria: CriterionOutcome[][];
  deepestOutputs: JsonObject[];
  deepestBreak: {
    candidateSeen: boolean;
    criteria: readonly CriterionOutcome[];
  } | null;
}

/** Align one compiled workflow with a normalized event sequence. */
export function alignWorkflow(
  workflow: CompiledWorkflow,
  events: readonly AlignmentEvent[],
  options: AlignOptions = {}
): WorkflowAlignment {
  const ordered = [...events]
    .map(toNormalized)
    .sort((left, right) => left.sequence - right.sequence);
  const steps = workflow.steps;
  const state: SearchState = {
    events: ordered,
    steps,
    inputs: options.inputs ?? {},
    maxCandidates: options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    maxAssignments: options.maxAssignments ?? DEFAULT_MAX_ASSIGNMENTS,
    tried: 0,
    truncated: false,
    assignments: [],
    firstCriteria: [],
    firstOutputs: [],
    sequencesPerStep: steps.map(() => new Set<number>()),
    deepest: -1,
    deepestAssignment: [],
    deepestCriteria: [],
    deepestOutputs: [],
    deepestBreak: null
  };
  search(state, 0, 0, new Map(), [], [], []);

  if (state.assignments.length > 0) {
    const chosen = state.assignments[0] ?? [];
    return {
      workflow_id: workflow.workflow_id,
      matched: true,
      ambiguous: state.assignments.length > 1,
      truncated: state.truncated,
      candidates_tried: state.tried,
      assignment_count: state.assignments.length,
      steps: steps.map((step, index) => {
        const sequences = state.sequencesPerStep[index] ?? new Set<number>();
        const eventIndex = chosen[index];
        const selected =
          eventIndex === undefined ? null : (ordered[eventIndex] ?? null);
        const sorted = [...sequences].sort((left, right) => left - right);
        const alternatives = sorted.filter((seq) => seq !== selected?.sequence);
        return {
          step_id: step.step_id,
          outcome: alternatives.length > 0 ? "ambiguous" : "matched",
          reason: alternatives.length > 0 ? "ambiguous-assignment" : null,
          event_sequences: selected === null ? [] : [selected.sequence],
          alternative_sequences: alternatives,
          resolved_outputs: state.firstOutputs[index] ?? {},
          criteria: state.firstCriteria[index] ?? []
        };
      })
    };
  }

  const breakIndex = state.deepest;
  const chosen = state.deepestAssignment;
  const breakInfo = state.deepestBreak;
  return {
    workflow_id: workflow.workflow_id,
    matched: false,
    ambiguous: false,
    truncated: state.truncated,
    candidates_tried: state.tried,
    assignment_count: 0,
    steps: steps.map((step, index) => {
      if (index < breakIndex) {
        const eventIndex = chosen[index];
        const selected =
          eventIndex === undefined ? null : (ordered[eventIndex] ?? null);
        return {
          step_id: step.step_id,
          outcome: "matched" as const,
          reason: null,
          event_sequences: selected === null ? [] : [selected.sequence],
          alternative_sequences: [],
          resolved_outputs: state.deepestOutputs[index] ?? {},
          criteria: state.deepestCriteria[index] ?? []
        };
      }
      if (index === breakIndex) {
        const unresolved = step.operation_key === null;
        return {
          step_id: step.step_id,
          outcome: unresolved
            ? "skipped"
            : breakInfo?.candidateSeen
              ? "failed"
              : "unmatched",
          reason: unresolved
            ? "operation-unresolved"
            : breakInfo?.candidateSeen
              ? "criteria-failed"
              : "no-candidate-event",
          event_sequences: [],
          alternative_sequences: [],
          resolved_outputs: {},
          criteria: unresolved ? [] : (breakInfo?.criteria ?? [])
        };
      }
      return {
        step_id: step.step_id,
        outcome: "skipped" as const,
        reason: "dependency-unmatched" as const,
        event_sequences: [],
        alternative_sequences: [],
        resolved_outputs: {},
        criteria: []
      };
    })
  };
}

/**
 * Depth-first search over steps in dependency order. Candidate events are
 * tried in sequence order, so the first complete assignment is the smallest
 * event tuple. The search continues after a match to detect ambiguity.
 */
function search(
  state: SearchState,
  stepIndex: number,
  fromIndex: number,
  outputs: ReadonlyMap<string, JsonObject>,
  assignment: number[],
  criteriaSoFar: CriterionOutcome[][],
  outputsSoFar: JsonObject[]
): void {
  if (stepIndex >= state.steps.length) {
    recordAssignment(state, assignment, criteriaSoFar, outputsSoFar);
    return;
  }
  const step = state.steps[stepIndex];
  if (step === undefined) {
    return;
  }
  if (step.operation_key === null) {
    recordDeadEnd(state, assignment, criteriaSoFar, outputsSoFar, false, []);
    return;
  }
  let candidateSeen = false;
  let lastCriteria: CriterionOutcome[] | null = null;
  for (let index = fromIndex; index < state.events.length; index += 1) {
    state.tried += 1;
    if (state.tried > state.maxCandidates) {
      state.truncated = true;
      break;
    }
    const event = state.events[index];
    if (event === undefined || event.operationKey !== step.operation_key) {
      continue;
    }
    candidateSeen = true;
    const context = contextFor(event, outputs, state.inputs);
    const criteria = evaluateCriteria(step.criteria, context);
    if (criteria.every((outcome) => outcome.passed)) {
      const resolved = resolveOutputs(step.outputs, context);
      const nextOutputs = new Map(outputs);
      nextOutputs.set(step.step_id, resolved);
      search(
        state,
        stepIndex + 1,
        index + 1,
        nextOutputs,
        [...assignment, index],
        [...criteriaSoFar, criteria],
        [...outputsSoFar, resolved]
      );
      if (state.assignments.length >= state.maxAssignments || state.truncated) {
        break;
      }
    } else {
      lastCriteria = criteria;
    }
  }
  recordDeadEnd(
    state,
    assignment,
    criteriaSoFar,
    outputsSoFar,
    candidateSeen,
    lastCriteria ?? []
  );
}

function recordAssignment(
  state: SearchState,
  assignment: readonly number[],
  criteriaSoFar: readonly CriterionOutcome[][],
  outputsSoFar: readonly JsonObject[]
): void {
  state.assignments.push([...assignment]);
  if (state.assignments.length === 1) {
    state.firstCriteria = criteriaSoFar.map((entry) => [...entry]);
    state.firstOutputs = outputsSoFar.map((entry) => ({ ...entry }));
  }
  assignment.forEach((eventIndex, stepIndex) => {
    const bucket = state.sequencesPerStep[stepIndex];
    if (bucket !== undefined) {
      const event = state.events[eventIndex];
      if (event !== undefined) {
        bucket.add(event.sequence);
      }
    }
  });
}

function recordDeadEnd(
  state: SearchState,
  assignment: readonly number[],
  criteriaSoFar: readonly CriterionOutcome[][],
  outputsSoFar: readonly JsonObject[],
  candidateSeen: boolean,
  criteria: readonly CriterionOutcome[]
): void {
  if (assignment.length > state.deepest) {
    state.deepest = assignment.length;
    state.deepestAssignment = [...assignment];
    state.deepestCriteria = criteriaSoFar.map((entry) => [...entry]);
    state.deepestOutputs = outputsSoFar.map((entry) => ({ ...entry }));
    state.deepestBreak = { candidateSeen, criteria: [...criteria] };
  }
}

function evaluateCriteria(
  criteria: readonly CompiledCriterion[],
  context: RuntimeContext
): CriterionOutcome[] {
  return criteria.map((criterion) => {
    const outcome: CriterionEvaluation = evaluateCriterion(
      criterion.node,
      context
    );
    return {
      condition: criterion.condition,
      passed: outcome.passed,
      error: outcome.error
    };
  });
}

function resolveOutputs(
  outputs: readonly CompiledOutput[],
  context: RuntimeContext
): JsonObject {
  const resolved: Record<string, Json> = {};
  for (const output of outputs) {
    resolved[output.name] = evaluateRuntimeSource(output.source, context);
  }
  return resolved;
}

function contextFor(
  event: NormalizedEvent,
  outputs: ReadonlyMap<string, JsonObject>,
  inputs: JsonObject
): RuntimeContext {
  return {
    url: null,
    statusCode: event.status,
    requestBody: event.requestBody,
    responseBody: event.responseBody,
    inputs,
    stepOutputs: outputs
  };
}

/** Coerce one event payload to a JSON value; unsupported values become null. */
function toNormalized(event: AlignmentEvent): NormalizedEvent {
  return {
    sequence: event.sequence,
    operationKey: event.operationKey,
    status: event.response?.status ?? null,
    requestBody: toJson(event.request?.body, 0),
    responseBody: toJson(event.response?.body, 0)
  };
}

function toJson(value: unknown, depth: number): Json {
  if (depth > 32) {
    return null;
  }
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object":
      if (value === null) {
        return null;
      }
      if (Array.isArray(value)) {
        return value.map((entry) => toJson(entry, depth + 1));
      }
      return objectEntries(value, depth);
    default:
      return null;
  }
}

function objectEntries(value: object, depth: number): JsonObject {
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toJson(entry, depth + 1);
  }
  return out;
}
