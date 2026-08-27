/**
 * Frozen schedule seeds and assignment-to-run bindings (specification
 * sections 12.11 and 17.5).
 *
 * During StudyRun preflight the cohort seed is the `schedule_seed` recorded
 * in `assignments.json` and the `cohort_seed` input of every run-seed
 * derivation. A primary uses assignment kind `primary` and its within-cell
 * repetition index; a held slot uses `held_replacement` and its reserve
 * index. The derivation itself lives in `@oal/state-store` and is reused
 * here, never reimplemented.
 */

import { deriveRunSeed, type DigestRef } from "@oal/state-store";

import { allocateControlIds, runDomainObject } from "./ids.ts";
import type { AssignmentSchedule } from "./schedule.ts";

/**
 * Runtime-resolved digests every run seed of one StudyRun shares. They are
 * frozen after no-paid preflight, before the first assignment starts.
 */
export interface CohortSeedBase {
  readonly contractExecutionSha256: string;
  /** Pre-localization participant-surface template digest. */
  readonly participantSurfaceTemplateSha256: string;
  readonly packSha256: string | null;
  readonly scenario: DigestRef | null;
  readonly behaviorSha256: string;
  readonly eval: DigestRef | null;
  readonly caseRef: DigestRef | null;
}

export type ScheduleAssignmentKind = "primary" | "held_replacement";

/** Run seed of one scheduled assignment. */
export function assignmentRunSeed(
  base: CohortSeedBase,
  scheduleSeed: string,
  assignment: {
    readonly kind: ScheduleAssignmentKind;
    readonly index: number;
  }
): string {
  return deriveRunSeed({
    contractExecutionSha256: base.contractExecutionSha256,
    participantSurfaceTemplateSha256: base.participantSurfaceTemplateSha256,
    packSha256: base.packSha256,
    scenario: base.scenario,
    behaviorSha256: base.behaviorSha256,
    eval: base.eval,
    case: base.caseRef,
    cohortSeed: scheduleSeed,
    assignment: { kind: assignment.kind, index: assignment.index }
  });
}

/** Run seed of one primary, domain separated by its repetition index. */
export function primaryRunSeed(
  base: CohortSeedBase,
  scheduleSeed: string,
  repetitionIndex: number
): string {
  return assignmentRunSeed(base, scheduleSeed, {
    kind: "primary",
    index: repetitionIndex
  });
}

/** Run seed of one held slot, domain separated by its reserve index. */
export function heldReserveRunSeed(
  base: CohortSeedBase,
  scheduleSeed: string,
  reserveIndex: number
): string {
  return assignmentRunSeed(base, scheduleSeed, {
    kind: "held_replacement",
    index: reserveIndex
  });
}

/** One row of the phase-lock assignment-binding map. */
export interface AssignmentRunBinding {
  readonly assignment_id: string;
  readonly run_id: string;
  readonly run_seed: string;
  readonly child_batch_id: string;
}

/**
 * Complete assignment-to-run ID and seed map of one schedule. Every run ID is
 * allocated in one pass, so a shortened clash extends every colliding ID.
 */
export function assignmentRunBindings(
  schedule: AssignmentSchedule,
  base: CohortSeedBase
): readonly AssignmentRunBinding[] {
  const ids = allocateControlIds(
    schedule.assignments.map((assignment) => ({
      key: assignment.assignment_id,
      prefix: "run" as const,
      domain: runDomainObject({
        study_run_id: assignment.study_run_id,
        phase_id: assignment.phase_id,
        cell_id: assignment.cell_id,
        assignment_kind: assignment.kind,
        block_id: assignment.block_id,
        repetition_index: assignment.repetition_index,
        reserve_index: assignment.reserve_index
      })
    }))
  );
  return schedule.assignments.map((assignment) => ({
    assignment_id: assignment.assignment_id,
    run_id: ids.byKey.get(assignment.assignment_id)?.id ?? "",
    run_seed:
      assignment.kind === "primary"
        ? primaryRunSeed(
            base,
            schedule.schedule_seed,
            assignment.repetition_index ?? 0
          )
        : heldReserveRunSeed(
            base,
            schedule.schedule_seed,
            assignment.reserve_index ?? 0
          ),
    child_batch_id: assignment.child_batch_id
  }));
}
