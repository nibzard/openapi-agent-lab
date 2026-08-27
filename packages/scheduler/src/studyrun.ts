/**
 * StudyRun persisted header (specification section 12.14).
 *
 * `study-run.v1.schema.json` is the immutable execution header of one
 * PhasePlan. It is written only after every no-paid preflight check
 * succeeds, and before the first listener or participant starts. This
 * module is a pure function: the caller owns the filesystem.
 */

import {
  canonicalJson,
  diagnostic,
  isRfc3339,
  isSafeId,
  isSha256Hex,
  sha256Hex,
  type Diagnostic,
  type Json
} from "@oal/core";

import { SchedulerCode } from "./codes.ts";
import { allocateControlIds, childBatchDomainObject } from "./ids.ts";
import {
  ASSIGNMENT_SCHEDULE_KIND,
  assignmentScheduleSha256,
  SCHEDULE_SORT_ALGORITHM,
  type AssignmentSchedule
} from "./schedule.ts";

export const STUDY_RUN_SCHEMA_VERSION = 1;

/** Millisecond RFC 3339 form every persisted timestamp uses. */
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Safe relative path every child batch directory lives under. */
export const CHILD_BATCH_ROOT = "batches";

export type StudyRunPhaseKind =
  | "smoke"
  | "pilot"
  | "confirmatory"
  | "exploratory"
  | "operational";

/** One resolved cell of the header, with its compatibility digest. */
export interface StudyRunCellInput {
  readonly cell_id: string;
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly cell_compatibility_sha256: string;
}

export interface StudyRunHeaderInput {
  readonly study_run_id: string;
  readonly created_at: string;
  readonly protocol: {
    readonly id: string;
    readonly version: string;
    readonly protocol_lock_sha256: string;
  };
  readonly phase: {
    readonly id: string;
    readonly kind: StudyRunPhaseKind;
    readonly analytical: boolean;
    readonly phase_plan_sha256: string;
    readonly phase_lock_sha256: string;
  };
  readonly schedule: AssignmentSchedule;
  readonly study_compatibility_sha256: string;
  readonly implementation_sha256: string;
  readonly analysis_plan_sha256: string;
  readonly cells: readonly StudyRunCellInput[];
}

export interface StudyRunChildBatch {
  readonly cell_id: string;
  readonly batch_id: string;
  readonly relative_path: string;
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly cell_compatibility_sha256: string;
}

/** Immutable execution header of one PhasePlan. */
export interface StudyRunHeader {
  readonly schema_version: typeof STUDY_RUN_SCHEMA_VERSION;
  readonly study_run_id: string;
  readonly created_at: string;
  readonly protocol: {
    readonly id: string;
    readonly version: string;
    readonly protocol_lock_sha256: string;
  };
  readonly phase: {
    readonly id: string;
    readonly kind: StudyRunPhaseKind;
    readonly analytical: boolean;
    readonly phase_plan_sha256: string;
    readonly phase_lock_sha256: string;
  };
  readonly assignment_schedule: {
    readonly algorithm: typeof SCHEDULE_SORT_ALGORITHM;
    readonly sha256: string;
    readonly primary_count: number;
    readonly held_replacement_count: number;
    readonly maximum_agent_launches: number;
  };
  readonly study_compatibility_sha256: string;
  readonly implementation_sha256: string;
  readonly analysis_plan_sha256: string;
  readonly child_batches: readonly StudyRunChildBatch[];
  readonly extensions: Readonly<Record<string, never>>;
}

export interface StudyRunHeaderResult {
  readonly header: StudyRunHeader | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Order strings by Unicode code point. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Assemble the StudyRun header. Child batches are listed in canonical
 * cell-ID order, their IDs are derived from domain-separated objects, and
 * their safe relative paths are checked for collisions.
 */
export function buildStudyRunHeader(
  input: StudyRunHeaderInput
): StudyRunHeaderResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string): void => {
    diagnostics.push(
      diagnostic({ severity: "error", phase: "preflight", code, message })
    );
  };

  if (!isSafeId(input.study_run_id)) {
    report(
      SchedulerCode.StudyRunMismatch,
      `study_run_id ${JSON.stringify(input.study_run_id)} is not a safe identifier.`
    );
  }
  if (input.study_run_id !== input.schedule.study_run_id) {
    report(
      SchedulerCode.StudyRunMismatch,
      `study_run_id ${JSON.stringify(
        input.study_run_id
      )} does not match the schedule StudyRun ${JSON.stringify(
        input.schedule.study_run_id
      )}.`
    );
  }
  if (input.phase.id !== input.schedule.phase_id) {
    report(
      SchedulerCode.StudyRunMismatch,
      `phase id ${JSON.stringify(
        input.phase.id
      )} does not match the schedule phase ${JSON.stringify(
        input.schedule.phase_id
      )}.`
    );
  }
  if (!isSafeId(input.phase.id)) {
    report(
      SchedulerCode.HeaderInvalid,
      `phase id ${JSON.stringify(input.phase.id)} is not a safe identifier.`
    );
  }
  if (!isSafeId(input.protocol.id)) {
    report(
      SchedulerCode.HeaderInvalid,
      `protocol id ${JSON.stringify(input.protocol.id)} is not a safe identifier.`
    );
  }
  if (!(RFC3339_MILLIS.test(input.created_at) && isRfc3339(input.created_at))) {
    report(
      SchedulerCode.HeaderInvalid,
      `created_at ${JSON.stringify(
        input.created_at
      )} is not a millisecond RFC 3339 UTC timestamp.`
    );
  }
  const algorithm: string = input.schedule.algorithm;
  if (algorithm !== SCHEDULE_SORT_ALGORITHM) {
    report(
      SchedulerCode.OrderingUnsupported,
      `The schedule algorithm ${JSON.stringify(
        algorithm
      )} is not ${SCHEDULE_SORT_ALGORITHM}.`
    );
  }
  const scheduleKind: string = input.schedule.kind;
  if (scheduleKind !== ASSIGNMENT_SCHEDULE_KIND) {
    report(
      SchedulerCode.HeaderInvalid,
      `The schedule kind ${JSON.stringify(
        scheduleKind
      )} is not ${ASSIGNMENT_SCHEDULE_KIND}.`
    );
  }
  for (const [name, value] of [
    ["protocol.protocol_lock_sha256", input.protocol.protocol_lock_sha256],
    ["phase.phase_plan_sha256", input.phase.phase_plan_sha256],
    ["phase.phase_lock_sha256", input.phase.phase_lock_sha256],
    ["study_compatibility_sha256", input.study_compatibility_sha256],
    ["implementation_sha256", input.implementation_sha256],
    ["analysis_plan_sha256", input.analysis_plan_sha256]
  ] as const) {
    if (!isSha256Hex(value)) {
      report(
        SchedulerCode.HeaderInvalid,
        `${name} must be a lowercase 64-character SHA-256 digest.`
      );
    }
  }

  const cells = [...input.cells].sort((a, b) =>
    byCodePoint(a.cell_id, b.cell_id)
  );
  if (cells.length === 0) {
    report(
      SchedulerCode.CellInventoryInvalid,
      "A StudyRun header lists at least one child batch."
    );
  }
  const seenCells = new Set<string>();
  for (const cell of cells) {
    if (!isSafeId(cell.cell_id)) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `cell_id ${JSON.stringify(cell.cell_id)} is not a safe identifier.`
      );
    }
    if (seenCells.has(cell.cell_id)) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `cell_id ${JSON.stringify(cell.cell_id)} is listed more than once.`
      );
    }
    seenCells.add(cell.cell_id);
    if (!isSha256Hex(cell.cell_compatibility_sha256)) {
      report(
        SchedulerCode.CellDigestMissing,
        `Cell ${JSON.stringify(
          cell.cell_id
        )} records a malformed cell_compatibility_sha256.`
      );
    }
    if (Object.keys(cell.factor_levels).length === 0) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `Cell ${JSON.stringify(cell.cell_id)} declares no factor level.`
      );
    }
  }

  const scheduledCells = new Set(
    input.schedule.assignments.map((assignment) => assignment.cell_id)
  );
  for (const cellId of scheduledCells) {
    if (!seenCells.has(cellId)) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `Scheduled cell ${JSON.stringify(cellId)} has no child batch.`
      );
    }
  }
  for (const cell of cells) {
    if (!scheduledCells.has(cell.cell_id)) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `Cell ${JSON.stringify(cell.cell_id)} has no scheduled assignment.`
      );
    }
  }

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { header: null, diagnostics };
  }

  const ids = allocateControlIds(
    cells.map((cell) => ({
      key: cell.cell_id,
      prefix: "bat" as const,
      domain: childBatchDomainObject({
        study_run_id: input.study_run_id,
        phase_id: input.phase.id,
        cell_id: cell.cell_id
      })
    }))
  );

  const childBatches: StudyRunChildBatch[] = cells.map((cell) => {
    const batchId = ids.byKey.get(cell.cell_id)?.id ?? "";
    return {
      cell_id: cell.cell_id,
      batch_id: batchId,
      relative_path: `${CHILD_BATCH_ROOT}/${batchId}`,
      factor_levels: { ...cell.factor_levels },
      cell_compatibility_sha256: cell.cell_compatibility_sha256
    };
  });

  const paths = new Set<string>();
  for (const batch of childBatches) {
    if (paths.has(batch.relative_path)) {
      report(
        SchedulerCode.ControlIdCollision,
        `Child batch path ${JSON.stringify(batch.relative_path)} collides with another batch.`
      );
    }
    paths.add(batch.relative_path);
  }
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { header: null, diagnostics };
  }

  const primaries = input.schedule.assignments.filter(
    (assignment) => assignment.kind === "primary"
  ).length;

  return {
    header: {
      schema_version: STUDY_RUN_SCHEMA_VERSION,
      study_run_id: input.study_run_id,
      created_at: input.created_at,
      protocol: { ...input.protocol },
      phase: { ...input.phase },
      assignment_schedule: {
        algorithm: SCHEDULE_SORT_ALGORITHM,
        sha256: assignmentScheduleSha256(input.schedule),
        primary_count: primaries,
        held_replacement_count: input.schedule.assignments.length - primaries,
        maximum_agent_launches: input.schedule.assignments.length
      },
      study_compatibility_sha256: input.study_compatibility_sha256,
      implementation_sha256: input.implementation_sha256,
      analysis_plan_sha256: input.analysis_plan_sha256,
      child_batches: childBatches,
      extensions: {}
    },
    diagnostics
  };
}

/** JSON view of the header for validation and serialization. */
export function studyRunJson(header: StudyRunHeader): Json {
  return {
    schema_version: header.schema_version,
    study_run_id: header.study_run_id,
    created_at: header.created_at,
    protocol: { ...header.protocol },
    phase: { ...header.phase },
    assignment_schedule: { ...header.assignment_schedule },
    study_compatibility_sha256: header.study_compatibility_sha256,
    implementation_sha256: header.implementation_sha256,
    analysis_plan_sha256: header.analysis_plan_sha256,
    child_batches: header.child_batches.map((batch) => ({
      cell_id: batch.cell_id,
      batch_id: batch.batch_id,
      relative_path: batch.relative_path,
      factor_levels: { ...batch.factor_levels },
      cell_compatibility_sha256: batch.cell_compatibility_sha256
    })),
    extensions: {}
  };
}

/** Canonical JSON bytes of the header. */
export function serializeStudyRun(header: StudyRunHeader): string {
  return canonicalJson(studyRunJson(header));
}

/** SHA-256 over the canonical header bytes. */
export function studyRunSha256(header: StudyRunHeader): string {
  return sha256Hex(serializeStudyRun(header));
}
