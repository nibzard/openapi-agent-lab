/**
 * StudyRun orchestration (specification sections 12.11, 12.14, 23.16, and
 * 27.2).
 *
 * This module plans and reduces; it never launches anything itself. The
 * plan is a pure function of the locked inputs plus the result of every
 * no-paid preflight check: the immutable `study-run.v1` header exists only
 * after preflight succeeds, which is what keeps the write-after-preflight
 * ordering of section 12.14. Execution drives one assignment at a time
 * through an injected trial executor, applies the frozen replacement
 * policy through the scheduler's append-only assignment ledger, and holds
 * every unused held slot: no executor call, no run directory, and no
 * denominator entry.
 *
 * Abort semantics: an aborted analytical StudyRun is never resumed in
 * place, because execution always starts from an empty ledger and the
 * derived completion record names the abort reason. A batch-wide
 * launcher or configuration defect aborts without consuming held slots.
 */

import { diagnostic, isRfc3339, type Diagnostic, type Json } from "@oal/core";
import {
  activateHeldSlot,
  appendAssignmentEvent,
  assignmentRunBindings,
  blockCompletion,
  buildStudyRunHeader,
  createAssignmentLedger,
  heldUnusedAssignments,
  replacementPolicyOf,
  type ActivationRequest,
  type AssignmentEvent,
  type AssignmentLedger,
  type AssignmentRunBinding,
  type AssignmentSchedule,
  type EvidenceIntegrityValue,
  type ReplacementPolicy,
  type ScheduleView
} from "@oal/scheduler";
import type {
  CohortSeedBase,
  StudyRunCellInput,
  StudyRunHeader,
  StudyRunHeaderInput
} from "@oal/scheduler";
import type { CensorClass, Disposition, PhasePlan } from "@oal/study-ir";

import { checkAnalysisSupport } from "./support.ts";

/** Stable diagnostic codes of the StudyRun orchestration. */
export const RunCode = {
  PreflightFailed: "OAL-STUDY-RUN-PREFLIGHT-FAILED",
  PlanInvalid: "OAL-STUDY-RUN-PLAN-INVALID",
  ClockInvalid: "OAL-STUDY-RUN-CLOCK-INVALID",
  ExecutorFailed: "OAL-STUDY-RUN-EXECUTOR-FAILED",
  EventRejected: "OAL-STUDY-RUN-EVENT-REJECTED",
  CompletionPremature: "OAL-STUDY-RUN-COMPLETION-PREMATURE"
} as const;

/** Abort reason codes recorded on the completion record. */
export const AbortReason = {
  BatchWideLauncherDefect: "batch_wide_launcher_defect",
  OperatorInterrupted: "operator_interrupted",
  HarnessAborted: "harness_aborted",
  ExecutorFailed: "executor_failed"
} as const;

/** Millisecond RFC 3339 form every persisted timestamp uses. */
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Result of every no-paid preflight check, supplied by the caller. */
export interface StudyRunPreflight {
  /** True only when every check passed and no paid call has started. */
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface StudyRunPlanInput {
  readonly study_run_id: string;
  readonly created_at: string;
  readonly protocol: {
    readonly id: string;
    readonly version: string;
    readonly protocol_lock_sha256: string;
  };
  /** Frozen phase plan that owns the schedule and the policies below. */
  readonly phasePlan: PhasePlan;
  readonly phase_plan_sha256: string;
  readonly phase_lock_sha256: string;
  readonly schedule: AssignmentSchedule;
  readonly study_compatibility_sha256: string;
  readonly implementation_sha256: string;
  readonly analysis_plan_sha256: string;
  readonly cells: readonly StudyRunCellInput[];
  /** Runtime-resolved digests every run seed of this phase shares. */
  readonly cohort_seed_base: CohortSeedBase;
  readonly preflight: StudyRunPreflight;
}

/** One assignment the executor must run as exactly one trial. */
export interface TrialLaunch {
  readonly assignment_id: string;
  readonly run_id: string;
  readonly run_seed: string;
  readonly child_batch_id: string;
  readonly cell_id: string;
  readonly kind: "primary" | "held_replacement";
  readonly block_id: number | null;
  readonly repetition_index: number | null;
  readonly reserve_index: number | null;
  readonly factor_levels: Readonly<Record<string, string>>;
  /** Failed primary this launch replaces; null for a primary. */
  readonly replacement_target: string | null;
  readonly launch_order: number;
}

/** Terminal facts of one executed trial. */
export interface TrialOutcome {
  readonly disposition: Disposition;
  readonly evidence_integrity?: EvidenceIntegrityValue | undefined;
  readonly censor_class?: CensorClass | undefined;
  /** True when a batch-wide launcher or configuration defect failed. */
  readonly batch_wide?: boolean | undefined;
}

/** Execution port for one assignment. The runner implements this. */
export type TrialExecutor = (launch: TrialLaunch) => Promise<TrialOutcome>;

/** Immutable execution plan of one PhasePlan. */
export interface StudyRunPlan {
  readonly header: StudyRunHeader;
  readonly bindings: readonly AssignmentRunBinding[];
  readonly policy: ReplacementPolicy;
  /** Primaries in frozen schedule order. */
  readonly primaries: readonly AssignmentSchedule["assignments"][number][];
  /** Held slots in canonical cell and reserve order. */
  readonly held: readonly AssignmentSchedule["assignments"][number][];
}

export interface StudyRunPlanResult {
  readonly plan: StudyRunPlan | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface StudyRunExecutionOptions {
  /** Timestamp source for every ledger event. Injected for tests. */
  readonly clock: () => string;
}

/** An activation attempt the frozen policy declined. Operational only. */
export interface ActivationNotice {
  readonly code: string;
  readonly message: string;
}

export interface StudyRunExecution {
  readonly plan: StudyRunPlan;
  readonly ledger: AssignmentLedger;
  /** Launches actually handed to the executor, in launch order. */
  readonly launches: readonly TrialLaunch[];
  readonly abort_reason: string | null;
  readonly activation_notices: readonly ActivationNotice[];
  readonly completed: StudyRunCompleted | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** `study-completed.v1` completion pointer. */
export interface StudyRunCompleted {
  readonly schema_version: 1;
  readonly study_run_id: string;
  readonly status: "completed" | "aborted";
  readonly finished_at: string;
  readonly artifact_manifest_sha256: string;
  readonly counts: {
    readonly primary_assignments: number;
    readonly activated_replacements: number;
    readonly held_unused: number;
    readonly not_started: number;
    readonly child_batches: number;
  };
  readonly reason: string | null;
  readonly extensions: Readonly<Record<string, never>>;
}

function error(diagnostics: Diagnostic[], code: string, message: string): void {
  diagnostics.push(
    diagnostic({ severity: "error", phase: "run", code, message })
  );
}

function isMillisecondRfc3339(value: string): boolean {
  return RFC3339_MILLIS.test(value) && isRfc3339(value);
}

/**
 * Plan one StudyRun. The header is assembled only when the caller's
 * no-paid preflight succeeded and the frozen analysis plan stays inside
 * the implemented calculation set; a failed check returns no plan at
 * all, so no permanent artifact can precede a failed check.
 */
export function planStudyRun(input: StudyRunPlanInput): StudyRunPlanResult {
  const diagnostics: Diagnostic[] = [];
  if (!input.preflight.ok) {
    error(
      diagnostics,
      RunCode.PreflightFailed,
      "The StudyRun header is written only after every no-paid preflight check succeeds."
    );
  }
  for (const entry of input.preflight.diagnostics) {
    if (entry.severity === "error") {
      diagnostics.push(entry);
    }
  }
  for (const finding of checkAnalysisSupport({
    phasePlan: input.phasePlan,
    cells: input.cells.map((cell) => ({
      cell_id: cell.cell_id,
      factor_levels: cell.factor_levels
    }))
  })) {
    error(diagnostics, finding.code, finding.message);
  }
  if (diagnostics.length > 0) {
    return { plan: null, diagnostics };
  }

  const headerInput: StudyRunHeaderInput = {
    study_run_id: input.study_run_id,
    created_at: input.created_at,
    protocol: input.protocol,
    phase: {
      id: input.phasePlan.metadata.id,
      kind: input.phasePlan.purpose,
      analytical: input.phasePlan.analytical,
      phase_plan_sha256: input.phase_plan_sha256,
      phase_lock_sha256: input.phase_lock_sha256
    },
    schedule: input.schedule,
    study_compatibility_sha256: input.study_compatibility_sha256,
    implementation_sha256: input.implementation_sha256,
    analysis_plan_sha256: input.analysis_plan_sha256,
    cells: input.cells
  };
  const built = buildStudyRunHeader(headerInput);
  diagnostics.push(...built.diagnostics);
  if (built.header === null) {
    return { plan: null, diagnostics };
  }

  return {
    plan: {
      header: built.header,
      bindings: assignmentRunBindings(input.schedule, input.cohort_seed_base),
      policy: replacementPolicyOf(input.phasePlan),
      primaries: input.schedule.assignments.filter(
        (assignment) => assignment.kind === "primary"
      ),
      held: input.schedule.assignments.filter(
        (assignment) => assignment.kind === "held_replacement"
      )
    },
    diagnostics
  };
}

/** Binding of one assignment: run identity plus its derived run seed. */
function bindingOf(
  plan: StudyRunPlan,
  assignmentId: string
): AssignmentRunBinding | null {
  return (
    plan.bindings.find((binding) => binding.assignment_id === assignmentId) ??
    null
  );
}

/** Build the launch view of one assignment. */
function launchOf(
  plan: StudyRunPlan,
  assignment: AssignmentSchedule["assignments"][number],
  replacementTarget: string | null,
  launchOrder: number
): TrialLaunch | null {
  const binding = bindingOf(plan, assignment.assignment_id);
  if (binding === null) {
    return null;
  }
  return {
    assignment_id: assignment.assignment_id,
    run_id: binding.run_id,
    run_seed: binding.run_seed,
    child_batch_id: binding.child_batch_id,
    cell_id: assignment.cell_id,
    kind: assignment.kind,
    block_id: assignment.block_id,
    repetition_index: assignment.repetition_index,
    reserve_index: assignment.reserve_index,
    factor_levels: assignment.factor_levels,
    replacement_target: replacementTarget,
    launch_order: launchOrder
  };
}

/** Terminal facts of one event, for a later activation request. */
function terminalOf(
  ledger: AssignmentLedger,
  assignmentId: string
): AssignmentEvent | null {
  const found = ledger.events.find(
    (event) => event.assignment_id === assignmentId && event.kind === "terminal"
  );
  return found ?? null;
}

/**
 * Execute one planned StudyRun through the injected executor. One call per
 * assignment, each carrying its derived run seed. Execution always starts
 * from an empty ledger: an aborted StudyRun is never resumed in place.
 */
export async function executeStudyRun(
  plan: StudyRunPlan,
  executor: TrialExecutor,
  options: StudyRunExecutionOptions
): Promise<StudyRunExecution> {
  const diagnostics: Diagnostic[] = [];
  const schedule: ScheduleView = {
    study_run_id: plan.header.study_run_id,
    assignments: [...plan.primaries, ...plan.held]
  };
  let ledger = createAssignmentLedger(plan.header.study_run_id);
  const launches: TrialLaunch[] = [];
  const notices: ActivationNotice[] = [];
  let launchOrder = 0;
  let abortReason: string | null = null;

  const append = (
    draft: Parameters<typeof appendAssignmentEvent>[2]
  ): boolean => {
    const result = appendAssignmentEvent(ledger, schedule, draft);
    if (result.event === null) {
      error(
        diagnostics,
        RunCode.EventRejected,
        `Ledger rejected one ${draft.kind} event: ${result.diagnostics
          .map((entry) => entry.message)
          .join("; ")}`
      );
      return false;
    }
    ledger = result.ledger;
    return true;
  };

  type RunStatus =
    | { readonly status: "ok"; readonly outcome: TrialOutcome }
    | { readonly status: "abort" }
    | { readonly status: "invalid" };

  const runAssignment = async (
    assignment: AssignmentSchedule["assignments"][number],
    replacementTarget: string | null
  ): Promise<RunStatus> => {
    const launch = launchOf(plan, assignment, replacementTarget, launchOrder);
    if (launch === null) {
      error(
        diagnostics,
        RunCode.PlanInvalid,
        `Assignment ${JSON.stringify(assignment.assignment_id)} has no run binding.`
      );
      return { status: "invalid" };
    }
    const recordedAt = options.clock();
    if (!isMillisecondRfc3339(recordedAt)) {
      error(
        diagnostics,
        RunCode.ClockInvalid,
        `The clock produced ${JSON.stringify(recordedAt)}, which is not a millisecond RFC 3339 UTC timestamp.`
      );
      return { status: "invalid" };
    }
    if (
      !append({
        study_run_id: plan.header.study_run_id,
        recorded_at: recordedAt,
        assignment_id: assignment.assignment_id,
        kind: "launched",
        run_id: launch.run_id,
        launch_order: launch.launch_order
      })
    ) {
      return { status: "invalid" };
    }
    launches.push(launch);
    launchOrder += 1;
    let outcome: TrialOutcome;
    try {
      outcome = await executor(launch);
    } catch (cause) {
      error(
        diagnostics,
        RunCode.ExecutorFailed,
        `The executor threw for assignment ${JSON.stringify(
          assignment.assignment_id
        )}: ${String(cause)}`
      );
      append({
        study_run_id: plan.header.study_run_id,
        recorded_at: options.clock(),
        assignment_id: assignment.assignment_id,
        kind: "terminal",
        disposition: "harness_aborted"
      });
      return { status: "abort" };
    }
    const terminal = append({
      study_run_id: plan.header.study_run_id,
      recorded_at: options.clock(),
      assignment_id: assignment.assignment_id,
      kind: "terminal",
      disposition: outcome.disposition,
      ...(outcome.evidence_integrity === undefined
        ? {}
        : { evidence_integrity: outcome.evidence_integrity }),
      ...(outcome.censor_class === undefined
        ? {}
        : { censor_class: outcome.censor_class })
    });
    if (!terminal) {
      return { status: "invalid" };
    }
    return { status: "ok", outcome };
  };

  const abortReasonOf = (outcome: TrialOutcome): string | null => {
    if (outcome.batch_wide === true) {
      return AbortReason.BatchWideLauncherDefect;
    }
    if (outcome.disposition === "operator_interrupted") {
      return AbortReason.OperatorInterrupted;
    }
    if (outcome.disposition === "harness_aborted") {
      return AbortReason.HarnessAborted;
    }
    return null;
  };

  const tryActivate = (
    failedAssignmentId: string,
    terminal: AssignmentEvent
  ): string | null => {
    const request: ActivationRequest = {
      failed_assignment_id: failedAssignmentId,
      disposition: terminal.disposition ?? "harness_aborted",
      ...(terminal.evidence_integrity === null
        ? {}
        : { evidence_integrity: terminal.evidence_integrity }),
      ...(terminal.censor_class === null
        ? {}
        : { censor_class: terminal.censor_class })
    };
    const result = activateHeldSlot(
      ledger,
      schedule,
      plan.policy,
      request,
      options.clock()
    );
    if (result.event === null) {
      for (const entry of result.diagnostics) {
        notices.push({ code: entry.code, message: entry.message });
      }
      return null;
    }
    ledger = result.ledger;
    return result.event.assignment_id;
  };

  for (const primary of plan.primaries) {
    if (
      !append({
        study_run_id: plan.header.study_run_id,
        recorded_at: options.clock(),
        assignment_id: primary.assignment_id,
        kind: "planned"
      })
    ) {
      break;
    }
    if (abortReason !== null) {
      append({
        study_run_id: plan.header.study_run_id,
        recorded_at: options.clock(),
        assignment_id: primary.assignment_id,
        kind: "not_started",
        reason_code: abortReason
      });
      continue;
    }
    const ran = await runAssignment(primary, null);
    if (ran.status === "invalid") {
      break;
    }
    if (ran.status === "abort") {
      abortReason = AbortReason.ExecutorFailed;
      continue;
    }
    abortReason = abortReasonOf(ran.outcome);
    if (
      abortReason === null &&
      plan.policy.activation_timing === "immediate_after_terminal"
    ) {
      const terminal = terminalOf(ledger, primary.assignment_id);
      if (terminal !== null) {
        const heldId = tryActivate(primary.assignment_id, terminal);
        if (heldId !== null) {
          const held = plan.held.find(
            (assignment) => assignment.assignment_id === heldId
          );
          const replaced =
            held === undefined
              ? undefined
              : await runAssignment(held, primary.assignment_id);
          if (replaced !== undefined && replaced.status !== "ok") {
            abortReason = AbortReason.ExecutorFailed;
          }
        }
      }
    }
  }

  if (
    abortReason === null &&
    plan.policy.activation_timing === "after_primary_schedule"
  ) {
    for (const primary of plan.primaries) {
      const terminal = terminalOf(ledger, primary.assignment_id);
      if (terminal === null) {
        continue;
      }
      const heldId = tryActivate(primary.assignment_id, terminal);
      if (heldId === null) {
        continue;
      }
      const held = plan.held.find(
        (assignment) => assignment.assignment_id === heldId
      );
      if (held === undefined) {
        continue;
      }
      const replaced = await runAssignment(held, primary.assignment_id);
      if (replaced.status !== "ok") {
        abortReason = AbortReason.ExecutorFailed;
        break;
      }
    }
  }

  const completion = deriveStudyCompleted({
    plan,
    ledger,
    finished_at: options.clock(),
    artifact_manifest_sha256: plan.header.implementation_sha256,
    abort_reason: abortReason
  });
  diagnostics.push(...completion.diagnostics);

  return {
    plan,
    ledger,
    launches,
    abort_reason: abortReason,
    activation_notices: notices,
    completed: completion.completed,
    diagnostics
  };
}

export interface StudyCompletedDerivationInput {
  readonly plan: StudyRunPlan;
  readonly ledger: AssignmentLedger;
  readonly finished_at: string;
  /** Digest of the finalized StudyRun artifact manifest. */
  readonly artifact_manifest_sha256: string;
  readonly abort_reason: string | null;
}

export interface StudyCompletedResult {
  readonly completed: StudyRunCompleted | null;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Derive the `study-completed.v1` pointer from lifecycle facts only: the
 * frozen schedule, the append-only ledger, and the header. Held slots
 * that never activated count as held_unused; primaries that never
 * launched count as not_started. An aborted run keeps its reason code
 * and is never resumable in place.
 */
export function deriveStudyCompleted(
  input: StudyCompletedDerivationInput
): StudyCompletedResult {
  const diagnostics: Diagnostic[] = [];
  const schedule: ScheduleView = {
    study_run_id: input.plan.header.study_run_id,
    assignments: [...input.plan.primaries, ...input.plan.held]
  };
  const launched = new Set(
    input.ledger.events
      .filter((event) => event.kind === "launched")
      .map((event) => event.assignment_id)
  );
  const settled = new Set(
    input.ledger.events
      .filter(
        (event) => event.kind === "terminal" || event.kind === "not_started"
      )
      .map((event) => event.assignment_id)
  );
  const activated = input.ledger.events.filter(
    (event) => event.kind === "activated"
  ).length;
  const heldUnused = heldUnusedAssignments(schedule, input.ledger).length;
  const notStarted = input.plan.primaries.filter(
    (primary) => !launched.has(primary.assignment_id)
  ).length;

  for (const primary of input.plan.primaries) {
    if (!settled.has(primary.assignment_id)) {
      error(
        diagnostics,
        RunCode.CompletionPremature,
        `Primary ${JSON.stringify(primary.assignment_id)} reached no terminal or not-started fact.`
      );
    }
  }
  if (!isMillisecondRfc3339(input.finished_at)) {
    error(
      diagnostics,
      RunCode.ClockInvalid,
      `finished_at ${JSON.stringify(input.finished_at)} is not a millisecond RFC 3339 UTC timestamp.`
    );
  }
  if (diagnostics.length > 0) {
    return { completed: null, diagnostics };
  }

  const abortingEvent = input.ledger.events.find(
    (event) =>
      event.kind === "terminal" &&
      (event.disposition === "operator_interrupted" ||
        event.disposition === "harness_aborted")
  );
  const aborted = input.abort_reason !== null || abortingEvent !== undefined;

  return {
    completed: {
      schema_version: 1,
      study_run_id: input.plan.header.study_run_id,
      status: aborted ? "aborted" : "completed",
      finished_at: input.finished_at,
      artifact_manifest_sha256: input.artifact_manifest_sha256,
      counts: {
        primary_assignments: input.plan.primaries.length,
        activated_replacements: activated,
        held_unused: heldUnused,
        not_started: notStarted,
        child_batches: input.plan.header.child_batches.length
      },
      reason: aborted
        ? (input.abort_reason ??
          (abortingEvent !== undefined &&
          abortingEvent.disposition === "operator_interrupted"
            ? AbortReason.OperatorInterrupted
            : AbortReason.HarnessAborted))
        : null,
      extensions: {}
    },
    diagnostics
  };
}

/** Analytical completeness of every required block of the plan. */
export function studyBlockCompletion(
  plan: StudyRunPlan,
  ledger: AssignmentLedger
): ReturnType<typeof blockCompletion> {
  const schedule: ScheduleView = {
    study_run_id: plan.header.study_run_id,
    assignments: [...plan.primaries, ...plan.held]
  };
  return blockCompletion(schedule, ledger, plan.policy);
}

/** JSON view of one completion record, for schema validation. */
export function studyCompletedJson(completed: StudyRunCompleted): Json {
  return {
    schema_version: completed.schema_version,
    study_run_id: completed.study_run_id,
    status: completed.status,
    finished_at: completed.finished_at,
    artifact_manifest_sha256: completed.artifact_manifest_sha256,
    counts: { ...completed.counts },
    reason: completed.reason,
    extensions: {}
  };
}
