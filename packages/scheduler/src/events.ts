/**
 * Append-only assignment events (specification sections 12.11, 22.3, and
 * 24.3).
 *
 * `assignment-events.jsonl` is the only mutable owner of held-slot
 * activation and of assignment launch and terminal transitions. Activation
 * never rewrites `assignments.json`: an activated held slot maps to exactly
 * one eligible failed assignment, inherits that assignment's registered
 * block and repetition for analysis, and keeps its own later launch
 * position.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isRfc3339,
  isSafeId,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type {
  ActivationRule,
  CensorClass,
  Disposition,
  PhasePlan
} from "@oal/study-ir";

import { SchedulerCode } from "./codes.ts";
import { isControlId } from "./ids.ts";

export const ASSIGNMENT_EVENT_SCHEMA_VERSION = 1;

/** Millisecond RFC 3339 form every persisted timestamp uses. */
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AssignmentEventKind =
  | "planned"
  | "activated"
  | "launched"
  | "terminal"
  | "not_started";

export type EvidenceIntegrityValue = "intact" | "corrupt" | "missing";

export type AssignmentState =
  | "planned"
  | "held"
  | "held_unused"
  | "activated"
  | "launched"
  | "terminal"
  | "not_started";

/** Schedule fields the ledger rules read. `AssignmentSchedule` satisfies it. */
export interface ScheduledAssignmentView {
  readonly assignment_id: string;
  readonly kind: string;
  readonly cell_id: string;
  readonly child_batch_id: string;
  readonly block_id: number | null;
  readonly repetition_index: number | null;
  readonly reserve_index: number | null;
}

export interface ScheduleView {
  readonly study_run_id: string;
  readonly assignments: readonly ScheduledAssignmentView[];
}

/** One record of `assignment-events.jsonl`. */
export interface AssignmentEvent {
  readonly schema_version: typeof ASSIGNMENT_EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly event_id: string;
  readonly recorded_at: string;
  readonly study_run_id: string;
  readonly batch_id: string | null;
  readonly assignment_id: string;
  readonly kind: AssignmentEventKind;
  readonly replacement_target: string | null;
  readonly inherited_block_id: number | null;
  readonly inherited_repetition_index: number | null;
  readonly launch_order: number | null;
  readonly run_id: string | null;
  readonly disposition: Disposition | null;
  readonly censor_class: CensorClass | null;
  readonly evidence_integrity: EvidenceIntegrityValue | null;
  readonly reason_code: string | null;
  readonly extensions: JsonObject;
}

/** Event before the ledger assigns sequence and event ID. */
export interface AssignmentEventDraft {
  readonly study_run_id: string;
  readonly recorded_at: string;
  readonly assignment_id: string;
  readonly kind: AssignmentEventKind;
  readonly batch_id?: string | null | undefined;
  readonly replacement_target?: string | null | undefined;
  readonly inherited_block_id?: number | null | undefined;
  readonly inherited_repetition_index?: number | null | undefined;
  readonly launch_order?: number | undefined;
  readonly run_id?: string | null | undefined;
  readonly disposition?: Disposition | undefined;
  readonly censor_class?: CensorClass | null | undefined;
  readonly evidence_integrity?: EvidenceIntegrityValue | null | undefined;
  readonly reason_code?: string | undefined;
  readonly extensions?: JsonObject | undefined;
}

export interface AssignmentLedger {
  readonly study_run_id: string;
  readonly events: readonly AssignmentEvent[];
}

export function createAssignmentLedger(studyRunId: string): AssignmentLedger {
  if (!isSafeId(studyRunId)) {
    throw new Error(
      `study_run_id ${JSON.stringify(studyRunId)} is not a safe identifier.`
    );
  }
  return { study_run_id: studyRunId, events: [] };
}

export interface AppendResult {
  /** Updated ledger, or the unchanged ledger when the append was rejected. */
  readonly ledger: AssignmentLedger;
  readonly event: AssignmentEvent | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Frozen replacement policy of a phase plan. */
export interface ReplacementPolicy {
  readonly kind: "none" | "held-same-cell";
  readonly activation_timing:
    | "immediate_after_terminal"
    | "after_primary_schedule";
  readonly activate_on: readonly ActivationRule[];
  readonly maximum_activated_per_cell: number;
}

/** Read the frozen replacement policy of one phase plan. */
export function replacementPolicyOf(phasePlan: PhasePlan): ReplacementPolicy {
  const replacements = phasePlan.replacements;
  return {
    kind: replacements?.kind ?? "none",
    activation_timing:
      replacements?.activation_timing ?? "after_primary_schedule",
    activate_on: replacements?.activate_on ?? [],
    maximum_activated_per_cell: replacements?.maximum_activated_per_cell ?? 0
  };
}

function isMillisecondRfc3339(value: string): boolean {
  return RFC3339_MILLIS.test(value) && isRfc3339(value);
}

function isClean(diagnostics: readonly Diagnostic[]): boolean {
  return !diagnostics.some((entry) => entry.severity === "error");
}

interface LedgerIndex {
  readonly byAssignment: ReadonlyMap<string, readonly AssignmentEvent[]>;
  readonly eventIds: ReadonlySet<string>;
  readonly replacedTargets: ReadonlySet<string>;
  readonly activatedSlots: ReadonlySet<string>;
  readonly launchedCount: number;
  readonly highestLaunchOrder: number;
  readonly settled: ReadonlySet<string>;
}

function indexLedger(ledger: AssignmentLedger): LedgerIndex {
  const byAssignment = new Map<string, AssignmentEvent[]>();
  const eventIds = new Set<string>();
  const replacedTargets = new Set<string>();
  const activatedSlots = new Set<string>();
  const settled = new Set<string>();
  let launchedCount = 0;
  let highestLaunchOrder = -1;
  for (const event of ledger.events) {
    const mine = byAssignment.get(event.assignment_id) ?? [];
    mine.push(event);
    byAssignment.set(event.assignment_id, mine);
    eventIds.add(event.event_id);
    if (event.replacement_target !== null) {
      replacedTargets.add(event.replacement_target);
    }
    if (event.kind === "activated") {
      activatedSlots.add(event.assignment_id);
    }
    if (event.kind === "launched") {
      launchedCount += 1;
    }
    if (event.kind === "terminal" || event.kind === "not_started") {
      settled.add(event.assignment_id);
    }
    if (
      event.launch_order !== null &&
      event.launch_order > highestLaunchOrder
    ) {
      highestLaunchOrder = event.launch_order;
    }
  }
  return {
    byAssignment,
    eventIds,
    replacedTargets,
    activatedSlots,
    launchedCount,
    highestLaunchOrder,
    settled
  };
}

/** True when every primary assignment reached a terminal or not-started fact. */
export function primaryScheduleSettled(
  schedule: ScheduleView,
  ledger: AssignmentLedger
): boolean {
  const index = indexLedger(ledger);
  return schedule.assignments.every(
    (assignment) =>
      assignment.kind !== "primary" ||
      index.settled.has(assignment.assignment_id)
  );
}

/**
 * Append one event. The ledger is returned unchanged when any rule is
 * violated: sequences stay contiguous, event IDs stay unique, every
 * assignment holds at most one event of each kind, stage order stays
 * monotonic, and one held slot never satisfies two primaries.
 */
export function appendAssignmentEvent(
  ledger: AssignmentLedger,
  schedule: ScheduleView,
  draft: AssignmentEventDraft
): AppendResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string): void => {
    diagnostics.push(
      diagnostic({ severity: "error", phase: "run", code, message })
    );
  };

  if (draft.study_run_id !== ledger.study_run_id) {
    report(
      SchedulerCode.StudyRunMismatch,
      `Event study_run_id ${JSON.stringify(
        draft.study_run_id
      )} does not belong to ledger ${JSON.stringify(ledger.study_run_id)}.`
    );
  }
  if (draft.study_run_id !== schedule.study_run_id) {
    report(
      SchedulerCode.StudyRunMismatch,
      `Event study_run_id ${JSON.stringify(
        draft.study_run_id
      )} does not belong to schedule ${JSON.stringify(schedule.study_run_id)}.`
    );
  }
  if (!isMillisecondRfc3339(draft.recorded_at)) {
    report(
      SchedulerCode.EventAppendInvalid,
      `recorded_at ${JSON.stringify(
        draft.recorded_at
      )} is not a millisecond RFC 3339 UTC timestamp.`
    );
  }
  if (draft.launch_order !== undefined && draft.launch_order < 0) {
    report(
      SchedulerCode.EventAppendInvalid,
      "launch_order must be a nonnegative integer."
    );
  }
  if (
    draft.run_id !== undefined &&
    draft.run_id !== null &&
    !isControlId(draft.run_id)
  ) {
    report(
      SchedulerCode.EventAppendInvalid,
      `run_id ${JSON.stringify(draft.run_id)} is not a control ID.`
    );
  }

  const assignment = schedule.assignments.find(
    (entry) => entry.assignment_id === draft.assignment_id
  );
  if (assignment === undefined) {
    report(
      SchedulerCode.EventAppendInvalid,
      `Assignment ${JSON.stringify(
        draft.assignment_id
      )} is not part of the schedule.`
    );
  }

  const index = indexLedger(ledger);
  const mine = index.byAssignment.get(draft.assignment_id) ?? [];
  if (mine.some((event) => event.kind === draft.kind)) {
    report(
      SchedulerCode.EventAppendInvalid,
      `Assignment ${JSON.stringify(
        draft.assignment_id
      )} already holds one ${draft.kind} event; the ledger is append-only.`
    );
  }

  if (assignment !== undefined) {
    checkStageOrder(draft, assignment.kind, mine, report);
    if (
      draft.batch_id !== undefined &&
      draft.batch_id !== assignment.child_batch_id
    ) {
      report(
        SchedulerCode.EventAppendInvalid,
        `batch_id ${JSON.stringify(
          draft.batch_id
        )} does not match the scheduled child batch ${JSON.stringify(
          assignment.child_batch_id
        )}.`
      );
    }
  }
  if (draft.kind === "activated") {
    checkActivation(draft, schedule, index, mine, report);
  }
  if (draft.kind === "launched" && draft.run_id === undefined) {
    report(
      SchedulerCode.EventAppendInvalid,
      "A launched event must name the run it started."
    );
  }

  const launchOrder =
    draft.launch_order === undefined ? index.launchedCount : draft.launch_order;
  if (launchOrder <= index.highestLaunchOrder) {
    report(
      SchedulerCode.EventAppendInvalid,
      `launch_order ${String(launchOrder)} does not follow the highest recorded launch order ${String(
        index.highestLaunchOrder
      )}.`
    );
  }

  if (!isClean(diagnostics)) {
    return { ledger, event: null, diagnostics };
  }

  const sequence = ledger.events.length + 1;
  const event: AssignmentEvent = {
    schema_version: ASSIGNMENT_EVENT_SCHEMA_VERSION,
    sequence,
    event_id: assignmentEventId(sequence, draft),
    recorded_at: draft.recorded_at,
    study_run_id: draft.study_run_id,
    batch_id: draft.batch_id ?? assignment?.child_batch_id ?? null,
    assignment_id: draft.assignment_id,
    kind: draft.kind,
    replacement_target: draft.replacement_target ?? null,
    inherited_block_id: draft.inherited_block_id ?? null,
    inherited_repetition_index: draft.inherited_repetition_index ?? null,
    launch_order: draft.kind === "launched" ? launchOrder : null,
    run_id: draft.run_id ?? null,
    disposition: draft.disposition ?? null,
    censor_class: draft.censor_class ?? null,
    evidence_integrity: draft.evidence_integrity ?? null,
    reason_code: draft.reason_code ?? null,
    extensions: draft.extensions ?? {}
  };
  if (index.eventIds.has(event.event_id)) {
    report(
      SchedulerCode.EventAppendInvalid,
      `event_id ${JSON.stringify(event.event_id)} already exists.`
    );
    return { ledger, event: null, diagnostics };
  }
  return {
    ledger: {
      study_run_id: ledger.study_run_id,
      events: [...ledger.events, event]
    },
    event,
    diagnostics
  };
}

function checkStageOrder(
  draft: AssignmentEventDraft,
  assignmentKind: string,
  mine: readonly AssignmentEvent[],
  report: (code: string, message: string) => void
): void {
  const kinds = new Set(mine.map((event) => event.kind));
  const has = (kind: AssignmentEventKind): boolean => kinds.has(kind);
  switch (draft.kind) {
    case "planned": {
      if (assignmentKind !== "primary") {
        report(
          SchedulerCode.EventTransitionInvalid,
          "Only a primary assignment receives a planned event."
        );
      }
      if (mine.length > 0) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "A planned event must be the first event of its assignment."
        );
      }
      return;
    }
    case "activated": {
      if (assignmentKind !== "held_replacement") {
        report(
          SchedulerCode.EventTransitionInvalid,
          "Only a held slot can be activated."
        );
      }
      if (mine.length > 0) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "An activation must be the first event of its held slot."
        );
      }
      return;
    }
    case "launched": {
      if (!has("planned") && !has("activated")) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "A launch requires a planned primary or an activated held slot."
        );
      }
      if (has("terminal") || has("not_started")) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "An assignment that reached a terminal or not-started fact cannot launch again."
        );
      }
      return;
    }
    case "terminal": {
      if (!has("launched")) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "A terminal event requires a launched event."
        );
      }
      return;
    }
    case "not_started": {
      if (has("launched") || has("terminal")) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "A not-started fact cannot follow a launch."
        );
      }
      if (!has("planned") && !has("activated")) {
        report(
          SchedulerCode.EventTransitionInvalid,
          "A not-started fact requires a scheduled assignment."
        );
      }
      return;
    }
  }
}

function checkActivation(
  draft: AssignmentEventDraft,
  schedule: ScheduleView,
  index: LedgerIndex,
  mine: readonly AssignmentEvent[],
  report: (code: string, message: string) => void
): void {
  const target = draft.replacement_target;
  if (target === undefined || target === null) {
    report(
      SchedulerCode.EventTransitionInvalid,
      "An activated event must name the failed assignment it replaces."
    );
    return;
  }
  const failed = schedule.assignments.find(
    (entry) => entry.assignment_id === target
  );
  if (failed === undefined) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `Replacement target ${JSON.stringify(target)} is not in the schedule.`
    );
    return;
  }
  if (failed.kind !== "primary") {
    report(
      SchedulerCode.ActivationTargetInvalid,
      "A held slot replaces a primary assignment only."
    );
    return;
  }
  if (index.replacedTargets.has(target)) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `Primary ${JSON.stringify(target)} already has one mapped replacement.`
    );
  }
  if (mine.length > 0 || index.activatedSlots.has(draft.assignment_id)) {
    return;
  }
  if (draft.inherited_block_id !== failed.block_id) {
    report(
      SchedulerCode.EventTransitionInvalid,
      `An activation must inherit the registered block ${String(
        failed.block_id
      )}, not ${String(draft.inherited_block_id)}.`
    );
  }
  if (draft.inherited_repetition_index !== failed.repetition_index) {
    report(
      SchedulerCode.EventTransitionInvalid,
      `An activation must inherit the registered repetition index ${String(
        failed.repetition_index
      )}, not ${String(draft.inherited_repetition_index)}.`
    );
  }
}

/** Failure facts the locked policy may select a held slot for. */
export interface ActivationRequest {
  readonly failed_assignment_id: string;
  readonly disposition: Disposition;
  readonly censor_class?: CensorClass | undefined;
  readonly evidence_integrity?: EvidenceIntegrityValue | undefined;
}

export interface ActivationResult {
  readonly ledger: AssignmentLedger;
  readonly event: AssignmentEvent | null;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Select and activate one held slot for one eligible failed primary. The
 * choice is outcome-blind and cell-matched: the unused held slot of the
 * failed cell with the lowest reserve index. Selection is capacity-bounded
 * by the frozen per-cell activation ceiling.
 */
export function activateHeldSlot(
  ledger: AssignmentLedger,
  schedule: ScheduleView,
  policy: ReplacementPolicy,
  request: ActivationRequest,
  recordedAt: string
): ActivationResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string): void => {
    diagnostics.push(
      diagnostic({ severity: "error", phase: "run", code, message })
    );
  };
  const reject = (): ActivationResult => ({ ledger, event: null, diagnostics });

  const failed = schedule.assignments.find(
    (entry) => entry.assignment_id === request.failed_assignment_id
  );
  if (failed === undefined) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `Assignment ${JSON.stringify(
        request.failed_assignment_id
      )} is not part of the schedule.`
    );
    return reject();
  }
  if (failed.kind !== "primary") {
    report(
      SchedulerCode.ActivationTargetInvalid,
      "A held slot replaces a primary assignment only."
    );
    return reject();
  }

  const index = indexLedger(ledger);
  const mine = index.byAssignment.get(failed.assignment_id) ?? [];
  const last = mine[mine.length - 1];
  if (last === undefined) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `Primary ${JSON.stringify(
        failed.assignment_id
      )} has no terminal fact yet, so no replacement may map to it.`
    );
    return reject();
  }
  if (last.disposition !== request.disposition) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `The recorded disposition ${JSON.stringify(
        last.disposition
      )} does not match the requested ${JSON.stringify(request.disposition)}.`
    );
    return reject();
  }
  if (index.replacedTargets.has(failed.assignment_id)) {
    report(
      SchedulerCode.ActivationTargetInvalid,
      `Primary ${JSON.stringify(
        failed.assignment_id
      )} already has one mapped replacement; one held slot cannot satisfy two primaries.`
    );
    return reject();
  }
  if (!policyMatches(policy, request)) {
    report(
      SchedulerCode.ActivationNotEligible,
      `The locked replacement policy does not select a held slot for disposition ${JSON.stringify(
        request.disposition
      )}.`
    );
    return reject();
  }
  if (policy.kind !== "held-same-cell") {
    report(
      SchedulerCode.ActivationNotEligible,
      "The phase plan freezes replacement kind none, so no slot can activate."
    );
    return reject();
  }

  const timing = checkActivationTiming(ledger, policy, index, last, schedule);
  if (timing !== null) {
    report(SchedulerCode.ActivationTimingForbidden, timing);
    return reject();
  }

  const activatedInCell = schedule.assignments.filter(
    (entry) =>
      entry.cell_id === failed.cell_id &&
      index.activatedSlots.has(entry.assignment_id)
  ).length;
  if (activatedInCell >= policy.maximum_activated_per_cell) {
    report(
      SchedulerCode.ActivationCapacityExhausted,
      `Cell ${JSON.stringify(
        failed.cell_id
      )} reached its frozen ceiling of ${String(
        policy.maximum_activated_per_cell
      )} activated replacements.`
    );
    return reject();
  }

  const candidates = schedule.assignments
    .filter(
      (entry) =>
        entry.kind === "held_replacement" &&
        entry.cell_id === failed.cell_id &&
        !index.activatedSlots.has(entry.assignment_id)
    )
    .sort((a, b) => (a.reserve_index ?? 0) - (b.reserve_index ?? 0));
  const chosen = candidates[0];
  if (chosen === undefined) {
    report(
      SchedulerCode.ActivationCapacityExhausted,
      `Cell ${JSON.stringify(failed.cell_id)} has no unused held slot left.`
    );
    return reject();
  }

  return appendAssignmentEvent(ledger, schedule, {
    study_run_id: schedule.study_run_id,
    recorded_at: recordedAt,
    assignment_id: chosen.assignment_id,
    kind: "activated",
    replacement_target: failed.assignment_id,
    inherited_block_id: failed.block_id,
    inherited_repetition_index: failed.repetition_index,
    reason_code: request.disposition,
    ...(request.censor_class === undefined
      ? {}
      : { censor_class: request.censor_class }),
    ...(request.evidence_integrity === undefined
      ? {}
      : { evidence_integrity: request.evidence_integrity })
  });
}

function policyMatches(
  policy: ReplacementPolicy,
  request: ActivationRequest
): boolean {
  const integrity = request.evidence_integrity;
  const integritySelectable =
    integrity === "corrupt" || integrity === "missing";
  return policy.activate_on.some(
    (rule) =>
      rule.disposition === request.disposition ||
      (integritySelectable &&
        (rule.evidence_integrity ?? []).includes(integrity))
  );
}

function checkActivationTiming(
  ledger: AssignmentLedger,
  policy: ReplacementPolicy,
  index: LedgerIndex,
  terminal: AssignmentEvent,
  schedule: ScheduleView
): string | null {
  if (policy.activation_timing === "after_primary_schedule") {
    const unsettled = schedule.assignments.filter(
      (entry) =>
        entry.kind === "primary" && !index.settled.has(entry.assignment_id)
    );
    return unsettled.length === 0
      ? null
      : `Activation timing after_primary_schedule forbids activation while ${String(
          unsettled.length
        )} primary assignments are unsettled.`;
  }
  const last = ledger.events[ledger.events.length - 1];
  return last === undefined || last.event_id !== terminal.event_id
    ? "Activation timing immediate_after_terminal requires the activation directly after the terminal fact it answers."
    : null;
}

/** Current state of every scheduled assignment. */
export function assignmentStates(
  schedule: ScheduleView,
  ledger: AssignmentLedger
): ReadonlyMap<string, AssignmentState> {
  const index = indexLedger(ledger);
  const settled = primaryScheduleSettled(schedule, ledger);
  const states = new Map<string, AssignmentState>();
  for (const assignment of schedule.assignments) {
    const mine = index.byAssignment.get(assignment.assignment_id) ?? [];
    const latest = mine[mine.length - 1];
    if (latest !== undefined) {
      states.set(assignment.assignment_id, latest.kind);
      continue;
    }
    states.set(
      assignment.assignment_id,
      assignment.kind === "primary"
        ? "planned"
        : settled
          ? "held_unused"
          : "held"
    );
  }
  return states;
}

/** Held slots that never activated. They consume no call and no run directory. */
export function heldUnusedAssignments(
  schedule: ScheduleView,
  ledger: AssignmentLedger
): readonly string[] {
  const index = indexLedger(ledger);
  return schedule.assignments
    .filter(
      (assignment) =>
        assignment.kind === "held_replacement" &&
        !(index.byAssignment.get(assignment.assignment_id) ?? []).some(
          (event) => event.kind === "activated"
        )
    )
    .map((assignment) => assignment.assignment_id);
}

/** Analytical completeness of every required block. */
export interface BlockCompletion {
  readonly block_id: number;
  readonly total: number;
  readonly satisfied: number;
  readonly complete: boolean;
  readonly missing_assignment_ids: readonly string[];
}

/**
 * A required block is analytically complete only when every primary analysis
 * slot has either its own eligible outcome or one valid mapped replacement
 * with an eligible outcome. The frozen replacement policy decides
 * eligibility: a terminal fact whose disposition the policy would replace is
 * not an eligible outcome, so its slot stays open until a replacement
 * terminates or the analyzer applies the PhasePlan refusal rule.
 */
export function blockCompletion(
  schedule: ScheduleView,
  ledger: AssignmentLedger,
  policy: ReplacementPolicy
): readonly BlockCompletion[] {
  const index = indexLedger(ledger);
  const replacementOf = new Map<string, string>();
  for (const event of ledger.events) {
    if (event.kind === "activated" && event.replacement_target !== null) {
      replacementOf.set(event.replacement_target, event.assignment_id);
    }
  }
  const terminalOutcome = (assignmentId: string): AssignmentEvent | undefined =>
    (index.byAssignment.get(assignmentId) ?? []).find(
      (event) => event.kind === "terminal"
    );
  const blocks = new Map<
    number,
    { total: number; satisfied: number; missing: string[] }
  >();
  for (const assignment of schedule.assignments) {
    if (assignment.kind !== "primary" || assignment.block_id === null) {
      continue;
    }
    const entry = blocks.get(assignment.block_id) ?? {
      total: 0,
      satisfied: 0,
      missing: [] as string[]
    };
    entry.total += 1;
    const own = terminalOutcome(assignment.assignment_id);
    const replacementId = replacementOf.get(assignment.assignment_id);
    const replacement =
      replacementId === undefined ? undefined : terminalOutcome(replacementId);
    const satisfied =
      (own !== undefined && isEligibleOutcome(own, policy)) ||
      (replacement !== undefined && isEligibleOutcome(replacement, policy));
    if (satisfied) {
      entry.satisfied += 1;
    } else {
      entry.missing.push(assignment.assignment_id);
    }
    blocks.set(assignment.block_id, entry);
  }
  return [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([blockId, entry]) => ({
      block_id: blockId,
      total: entry.total,
      satisfied: entry.satisfied,
      complete: entry.missing.length === 0,
      missing_assignment_ids: entry.missing
    }));
}

/** True when the frozen policy keeps this terminal fact as an outcome. */
function isEligibleOutcome(
  event: AssignmentEvent,
  policy: ReplacementPolicy
): boolean {
  if (event.disposition === null) {
    return false;
  }
  return !policyMatches(
    policy,
    event.evidence_integrity === null
      ? {
          failed_assignment_id: event.assignment_id,
          disposition: event.disposition
        }
      : {
          failed_assignment_id: event.assignment_id,
          disposition: event.disposition,
          evidence_integrity: event.evidence_integrity
        }
  );
}

/** Content-derived event ID: lowercase letters, underscore, then hex. */
export function assignmentEventId(
  sequence: number,
  draft: AssignmentEventDraft
): string {
  const digest = canonicalJsonSha256(assignmentEventDocument(sequence, draft));
  return `asgevt_${digest.slice(0, 16)}`;
}

function assignmentEventDocument(
  sequence: number,
  draft: AssignmentEventDraft
): JsonObject {
  return {
    schema_version: ASSIGNMENT_EVENT_SCHEMA_VERSION,
    sequence,
    study_run_id: draft.study_run_id,
    assignment_id: draft.assignment_id,
    kind: draft.kind,
    recorded_at: draft.recorded_at,
    batch_id: draft.batch_id ?? null,
    replacement_target: draft.replacement_target ?? null,
    inherited_block_id: draft.inherited_block_id ?? null,
    inherited_repetition_index: draft.inherited_repetition_index ?? null,
    launch_order: draft.launch_order ?? null,
    run_id: draft.run_id ?? null,
    disposition: draft.disposition ?? null,
    reason_code: draft.reason_code ?? null
  };
}

/** JSON view of one event. */
export function assignmentEventJson(event: AssignmentEvent): Json {
  return {
    schema_version: event.schema_version,
    sequence: event.sequence,
    event_id: event.event_id,
    recorded_at: event.recorded_at,
    study_run_id: event.study_run_id,
    batch_id: event.batch_id,
    assignment_id: event.assignment_id,
    kind: event.kind,
    replacement_target: event.replacement_target,
    inherited_block_id: event.inherited_block_id,
    inherited_repetition_index: event.inherited_repetition_index,
    launch_order: event.launch_order,
    run_id: event.run_id,
    disposition: event.disposition,
    censor_class: event.censor_class,
    evidence_integrity: event.evidence_integrity,
    reason_code: event.reason_code,
    extensions: { ...event.extensions }
  };
}

/** One JSONL record: canonical JSON without the trailing newline. */
export function serializeAssignmentEvent(event: AssignmentEvent): string {
  return canonicalJson(assignmentEventJson(event));
}

/** Every JSONL record of one ledger, joined by newlines. */
export function serializeAssignmentLedger(ledger: AssignmentLedger): string {
  return ledger.events.map(serializeAssignmentEvent).join("\n");
}
