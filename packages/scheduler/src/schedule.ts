/**
 * Deterministic StudyRun assignment schedules (specification section 12.11).
 *
 * A StudyRun owns one immutable `assignments.json` generated before any
 * server or participant starts. The schedule holds prospective assignment
 * kind and status only; activation facts belong to the append-only
 * assignment-event ledger. Order depends on nothing but the locked inputs:
 * no PRNG library, worker count, provider latency, completion order, or
 * replacement activation can move an assignment.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isSafeId,
  isSha256Hex,
  sha256Hex,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { IrFactorLevel, PhasePlan, StudyIR } from "@oal/study-ir";

import { SchedulerCode } from "./codes.ts";
import {
  allocateControlIds,
  assignmentDomainObject,
  childBatchDomainObject,
  type ControlIdAllocation
} from "./ids.ts";

export const ASSIGNMENT_SCHEDULE_SCHEMA_VERSION = 1;
export const ASSIGNMENT_SCHEDULE_KIND = "AssignmentSchedule";

/** The only version 1 ordering algorithm. */
export const SCHEDULE_SORT_ALGORITHM = "canonical-sha256-sort-v1";

/** Longest cohort seed the schedule accepts. */
export const MAX_SCHEDULE_SEED_LENGTH = 256;

export type AssignmentKind = "primary" | "held_replacement";
export type AssignmentStatus = "planned" | "held";

/**
 * Protocol-time digests shared by every assignment of one cell. Runtime
 * dependent effective values belong to the later phase lock.
 */
export interface CellProtocolDigests {
  readonly participant_surface_policy_sha256: string;
  readonly eval_sha256: string;
  readonly scenario_sha256: string;
  readonly rubric_sha256: string;
  readonly run_profile_template_sha256: string;
}

/** Every protocol-time digest field of one cell, in schema order. */
const CELL_DIGEST_FIELDS: readonly (keyof CellProtocolDigests)[] = [
  "participant_surface_policy_sha256",
  "eval_sha256",
  "scenario_sha256",
  "rubric_sha256",
  "run_profile_template_sha256"
];

/** Inputs of one schedule build. Everything here is frozen before preflight. */
export interface AssignmentScheduleInput {
  readonly study_run_id: string;
  /** Compiled study: supplies the resolved cell inventory and factor levels. */
  readonly ir: StudyIR;
  readonly phasePlan: PhasePlan;
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  /** Cohort seed; also the `cohort_seed` of every run-seed derivation. */
  readonly schedule_seed: string;
  /** Variant ID to effective-contract digest, from the protocol lock. */
  readonly effective_contracts: Readonly<Record<string, string>>;
  /** Protocol-time digests by cell ID. */
  readonly cell_digests: ReadonlyMap<string, CellProtocolDigests>;
}

export interface AssignmentRecord {
  readonly assignment_id: string;
  readonly kind: AssignmentKind;
  readonly status: AssignmentStatus;
  readonly study_run_id: string;
  readonly phase_id: string;
  readonly cell_id: string;
  readonly child_batch_id: string;
  readonly slot: number;
  readonly block_id: number | null;
  readonly repetition_index: number | null;
  readonly reserve_index: number | null;
  readonly eligible_stratum_policy: string | null;
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly factor_level_digests: Readonly<Record<string, string>>;
  readonly contract_variant_sha256: string | null;
  readonly participant_surface_policy_sha256: string;
  readonly eval_sha256: string;
  readonly scenario_sha256: string;
  readonly rubric_sha256: string;
  readonly run_profile_template_sha256: string;
  readonly sort_key: string;
}

/** Immutable `assignments.json` document. */
export interface AssignmentSchedule {
  readonly schema_version: typeof ASSIGNMENT_SCHEDULE_SCHEMA_VERSION;
  readonly kind: typeof ASSIGNMENT_SCHEDULE_KIND;
  readonly study_run_id: string;
  readonly phase_id: string;
  readonly algorithm: typeof SCHEDULE_SORT_ALGORITHM;
  readonly schedule_seed: string;
  readonly assignments: readonly AssignmentRecord[];
}

export interface AssignmentScheduleResult {
  readonly schedule: AssignmentSchedule | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Canonical document of one primary sort key, exactly as section 12.11. */
export function primarySortKeyDocument(input: {
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  readonly schedule_seed: string;
  readonly block_id: number;
  readonly cell_id: string;
}): JsonObject {
  return {
    schema_version: ASSIGNMENT_SCHEDULE_SCHEMA_VERSION,
    algorithm: SCHEDULE_SORT_ALGORITHM,
    protocol_lock_sha256: input.protocol_lock_sha256,
    phase_plan_sha256: input.phase_plan_sha256,
    schedule_seed: input.schedule_seed,
    block_id: input.block_id,
    cell_id: input.cell_id,
    assignment_kind: "primary"
  };
}

/**
 * Canonical document of one held-replacement sort key: the primary object
 * without `block_id`, plus the zero-based `reserve_index`.
 */
export function heldSortKeyDocument(input: {
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  readonly schedule_seed: string;
  readonly cell_id: string;
  readonly reserve_index: number;
}): JsonObject {
  return {
    schema_version: ASSIGNMENT_SCHEDULE_SCHEMA_VERSION,
    algorithm: SCHEDULE_SORT_ALGORITHM,
    protocol_lock_sha256: input.protocol_lock_sha256,
    phase_plan_sha256: input.phase_plan_sha256,
    schedule_seed: input.schedule_seed,
    cell_id: input.cell_id,
    assignment_kind: "held_replacement",
    reserve_index: input.reserve_index
  };
}

/** Lexicographic SHA-256 sort key of one primary assignment. */
export function primarySortKey(input: {
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  readonly schedule_seed: string;
  readonly block_id: number;
  readonly cell_id: string;
}): string {
  return canonicalJsonSha256(primarySortKeyDocument(input));
}

/** Lexicographic SHA-256 sort key of one held-replacement assignment. */
export function heldSortKey(input: {
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  readonly schedule_seed: string;
  readonly cell_id: string;
  readonly reserve_index: number;
}): string {
  return canonicalJsonSha256(heldSortKeyDocument(input));
}

/** Canonical document of one factor level, the schedule digest basis. */
export function factorLevelDocument(
  factorId: string,
  level: IrFactorLevel
): JsonObject {
  return {
    schema_version: ASSIGNMENT_SCHEDULE_SCHEMA_VERSION,
    factor: factorId,
    level: {
      id: level.id,
      ...(level.contract_variant === undefined
        ? {}
        : { contract_variant: level.contract_variant }),
      ...(level.run_profile_patch === undefined
        ? {}
        : { run_profile_patch: level.run_profile_patch })
    }
  };
}

/** Digest of every ordered factor-level binding of one cell. */
export function factorLevelDigests(
  ir: StudyIR,
  factorLevels: Readonly<Record<string, string>>
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const factor of ir.factors) {
    const level = factor.levels.find(
      (entry) => entry.id === factorLevels[factor.id]
    );
    if (level === undefined) {
      continue;
    }
    digests[factor.id] = canonicalJsonSha256(
      factorLevelDocument(factor.id, level)
    );
  }
  return digests;
}

/** Order strings by Unicode code point. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Cell fields the schedule reads; `StudyIR.cells` satisfies this shape. */
export interface ScheduledCellView {
  readonly cell_id: string;
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly why_absent: string | null;
}

/** Present cells of the compiled study, in canonical cell-ID order. */
export function scheduleCells(ir: {
  readonly cells: readonly ScheduledCellView[];
}): readonly ScheduledCellView[] {
  return ir.cells
    .filter((cell) => cell.why_absent === null)
    .sort((a, b) => byCodePoint(a.cell_id, b.cell_id));
}

/** One resolved cell with the protocol-time values the schedule records. */
interface CellPlan {
  readonly cell: ScheduledCellView;
  readonly digests: CellProtocolDigests;
  readonly contract_variant_sha256: string | null;
}

/** Held capacity of a phase plan: slots per present cell. */
export function heldSlotsPerCell(phasePlan: PhasePlan): number {
  return phasePlan.replacements?.kind === "held-same-cell"
    ? phasePlan.replacements.slots_per_cell
    : 0;
}

/** Number of balanced blocks a complete-balanced-blocks design produces. */
export function primaryBlockCount(
  primaryCount: number,
  cellCount: number
): number {
  if (cellCount < 1 || primaryCount % cellCount !== 0) {
    return 0;
  }
  return Math.floor(primaryCount / cellCount);
}

/**
 * Build the immutable assignment schedule. Content problems are reported as
 * error diagnostics; a schedule is returned only when no error was reported.
 */
export function buildAssignmentSchedule(
  input: AssignmentScheduleInput
): AssignmentScheduleResult {
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: string,
    message: string,
    pointer: string | null = null
  ): void => {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code,
        message,
        json_pointer: pointer
      })
    );
  };

  validateScheduleInput(input, report);

  const cells = scheduleCells(input.ir);
  const cellCount = cells.length;
  const primaryCount = input.phasePlan.design.primary_assignments;
  const blockCount = primaryBlockCount(primaryCount, cellCount);
  const slotsPerCell = heldSlotsPerCell(input.phasePlan);
  const plans = resolveCellPlans(input, cells, report);

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { schedule: null, diagnostics };
  }

  const ids = allocateControlIds([
    ...cells.map((cell) => ({
      key: `batch:${cell.cell_id}`,
      prefix: "bat" as const,
      domain: childBatchDomainObject({
        study_run_id: input.study_run_id,
        phase_id: input.phasePlan.metadata.id,
        cell_id: cell.cell_id
      })
    })),
    ...cells.flatMap((cell) =>
      [...Array(blockCount).keys()].map((block) => ({
        key: `primary:${block}:${cell.cell_id}`,
        prefix: "asg" as const,
        domain: assignmentDomainObject({
          study_run_id: input.study_run_id,
          phase_id: input.phasePlan.metadata.id,
          cell_id: cell.cell_id,
          assignment_kind: "primary",
          block_id: block,
          repetition_index: block,
          reserve_index: null
        })
      }))
    ),
    ...cells.flatMap((cell) =>
      [...Array(slotsPerCell).keys()].map((reserve) => ({
        key: `held:${cell.cell_id}:${reserve}`,
        prefix: "asg" as const,
        domain: assignmentDomainObject({
          study_run_id: input.study_run_id,
          phase_id: input.phasePlan.metadata.id,
          cell_id: cell.cell_id,
          assignment_kind: "held_replacement",
          block_id: null,
          repetition_index: null,
          reserve_index: reserve
        })
      }))
    )
  ]);

  const batchIds = new Map<string, string>();
  for (const cell of cells) {
    const allocated = ids.byKey.get(`batch:${cell.cell_id}`);
    if (allocated !== undefined) {
      batchIds.set(cell.cell_id, allocated.id);
    }
  }

  const assignments: AssignmentRecord[] = [];
  for (let block = 0; block < blockCount; block += 1) {
    const row = cells
      .map((cell) => ({ cell, plan: plans.get(cell.cell_id) }))
      .filter(
        (entry): entry is { cell: ScheduledCellView; plan: CellPlan } =>
          entry.plan !== undefined
      )
      .map((entry) => ({
        entry,
        sortKey: primarySortKey({
          protocol_lock_sha256: input.protocol_lock_sha256,
          phase_plan_sha256: input.phase_plan_sha256,
          schedule_seed: input.schedule_seed,
          block_id: block,
          cell_id: entry.cell.cell_id
        })
      }));
    row.sort((a, b) => {
      const byDigest = byCodePoint(a.sortKey, b.sortKey);
      return byDigest !== 0
        ? byDigest
        : byCodePoint(a.entry.cell.cell_id, b.entry.cell.cell_id);
    });
    for (const item of row) {
      assignments.push(
        primaryRecord(
          input,
          item.entry.cell,
          item.entry.plan,
          ids,
          block,
          item.sortKey,
          assignments.length
        )
      );
    }
  }

  for (const cell of cells) {
    const plan = plans.get(cell.cell_id);
    if (plan === undefined) {
      continue;
    }
    for (let reserve = 0; reserve < slotsPerCell; reserve += 1) {
      assignments.push(
        heldRecord(
          input,
          cell,
          plan,
          ids,
          reserve,
          batchIds.get(cell.cell_id) ?? "",
          assignments.length
        )
      );
    }
  }

  return {
    schedule: {
      schema_version: ASSIGNMENT_SCHEDULE_SCHEMA_VERSION,
      kind: ASSIGNMENT_SCHEDULE_KIND,
      study_run_id: input.study_run_id,
      phase_id: input.phasePlan.metadata.id,
      algorithm: SCHEDULE_SORT_ALGORITHM,
      schedule_seed: input.schedule_seed,
      assignments
    },
    diagnostics
  };
}

function primaryRecord(
  input: AssignmentScheduleInput,
  cell: ScheduledCellView,
  plan: CellPlan,
  ids: ControlIdAllocation,
  block: number,
  sortKey: string,
  slot: number
): AssignmentRecord {
  const allocated = ids.byKey.get(`primary:${block}:${cell.cell_id}`);
  return {
    assignment_id: allocated?.id ?? "",
    kind: "primary",
    status: "planned",
    study_run_id: input.study_run_id,
    phase_id: input.phasePlan.metadata.id,
    cell_id: cell.cell_id,
    child_batch_id: ids.byKey.get(`batch:${cell.cell_id}`)?.id ?? "",
    slot,
    block_id: block,
    repetition_index: block,
    reserve_index: null,
    eligible_stratum_policy: null,
    factor_levels: { ...cell.factor_levels },
    factor_level_digests: factorLevelDigests(input.ir, cell.factor_levels),
    contract_variant_sha256: plan.contract_variant_sha256,
    participant_surface_policy_sha256:
      plan.digests.participant_surface_policy_sha256,
    eval_sha256: plan.digests.eval_sha256,
    scenario_sha256: plan.digests.scenario_sha256,
    rubric_sha256: plan.digests.rubric_sha256,
    run_profile_template_sha256: plan.digests.run_profile_template_sha256,
    sort_key: sortKey
  };
}

function heldRecord(
  input: AssignmentScheduleInput,
  cell: ScheduledCellView,
  plan: CellPlan,
  ids: ControlIdAllocation,
  reserve: number,
  childBatchId: string,
  slot: number
): AssignmentRecord {
  const allocated = ids.byKey.get(`held:${cell.cell_id}:${reserve}`);
  return {
    assignment_id: allocated?.id ?? "",
    kind: "held_replacement",
    status: "held",
    study_run_id: input.study_run_id,
    phase_id: input.phasePlan.metadata.id,
    cell_id: cell.cell_id,
    child_batch_id: childBatchId,
    slot,
    block_id: null,
    repetition_index: null,
    reserve_index: reserve,
    eligible_stratum_policy: input.phasePlan.replacements?.kind ?? null,
    factor_levels: { ...cell.factor_levels },
    factor_level_digests: factorLevelDigests(input.ir, cell.factor_levels),
    contract_variant_sha256: plan.contract_variant_sha256,
    participant_surface_policy_sha256:
      plan.digests.participant_surface_policy_sha256,
    eval_sha256: plan.digests.eval_sha256,
    scenario_sha256: plan.digests.scenario_sha256,
    rubric_sha256: plan.digests.rubric_sha256,
    run_profile_template_sha256: plan.digests.run_profile_template_sha256,
    sort_key: heldSortKey({
      protocol_lock_sha256: input.protocol_lock_sha256,
      phase_plan_sha256: input.phase_plan_sha256,
      schedule_seed: input.schedule_seed,
      cell_id: cell.cell_id,
      reserve_index: reserve
    })
  };
}

function validateScheduleInput(
  input: AssignmentScheduleInput,
  report: (code: string, message: string, pointer: string | null) => void
): void {
  if (!isSafeId(input.study_run_id)) {
    report(
      SchedulerCode.StudyRunMismatch,
      `study_run_id ${JSON.stringify(input.study_run_id)} is not a safe identifier.`,
      "#/study_run_id"
    );
  }
  if (!isSafeId(input.phasePlan.metadata.id)) {
    report(
      SchedulerCode.HeaderInvalid,
      `PhasePlan metadata.id ${JSON.stringify(
        input.phasePlan.metadata.id
      )} is not a safe identifier.`,
      "#/phase_id"
    );
  }
  if (!isSha256Hex(input.protocol_lock_sha256)) {
    report(
      SchedulerCode.CellDigestMissing,
      "protocol_lock_sha256 must be a lowercase 64-character SHA-256 digest.",
      "#/"
    );
  }
  if (!isSha256Hex(input.phase_plan_sha256)) {
    report(
      SchedulerCode.CellDigestMissing,
      "phase_plan_sha256 must be a lowercase 64-character SHA-256 digest.",
      "#/"
    );
  }
  if (
    input.schedule_seed.length === 0 ||
    input.schedule_seed.length > MAX_SCHEDULE_SEED_LENGTH
  ) {
    report(
      SchedulerCode.SeedInvalid,
      `schedule_seed must hold 1 to ${String(
        MAX_SCHEDULE_SEED_LENGTH
      )} characters.`,
      "#/schedule_seed"
    );
  }
  const ordering: string = input.phasePlan.design.ordering;
  if (ordering !== SCHEDULE_SORT_ALGORITHM) {
    report(
      SchedulerCode.OrderingUnsupported,
      `design.ordering ${JSON.stringify(
        ordering
      )} is not ${SCHEDULE_SORT_ALGORITHM}.`,
      "#/algorithm"
    );
  }

  const cells = scheduleCells(input.ir);
  const cellCount = cells.length;
  if (cellCount === 0) {
    report(
      SchedulerCode.CellInventoryInvalid,
      "The compiled study resolved no present cell.",
      "#/assignments"
    );
  }
  const seen = new Set<string>();
  for (const cell of cells) {
    if (seen.has(cell.cell_id)) {
      report(
        SchedulerCode.CellInventoryInvalid,
        `Cell ${JSON.stringify(cell.cell_id)} resolves more than once.`,
        "#/assignments"
      );
    }
    seen.add(cell.cell_id);
  }

  const primaryCount = input.phasePlan.design.primary_assignments;
  const blockCount = primaryBlockCount(primaryCount, cellCount);
  if (cellCount > 0 && blockCount === 0) {
    report(
      SchedulerCode.DesignUnbalanced,
      `primary_assignments ${String(
        primaryCount
      )} is not divisible by the resolved cell count ${String(cellCount)}.`,
      "#/assignments"
    );
  }
  const declaredBlocks = input.phasePlan.design.block?.repetitions;
  if (declaredBlocks !== undefined && declaredBlocks !== blockCount) {
    report(
      SchedulerCode.BlockStructureInvalid,
      `design.block declares ${String(declaredBlocks)} balanced blocks, but ${String(
        primaryCount
      )} primary assignments over ${String(cellCount)} cells produce ${String(
        blockCount
      )}.`,
      "#/assignments"
    );
  }

  const replacements = input.phasePlan.replacements;
  const slotsPerCell = heldSlotsPerCell(input.phasePlan);
  if (replacements?.kind === "none" && replacements.slots_per_cell !== 0) {
    report(
      SchedulerCode.ReplacementCapacityInvalid,
      "replacements.kind none must declare slots_per_cell 0.",
      "#/assignments"
    );
  }
  const maximumPerCell = replacements?.maximum_activated_per_cell ?? 0;
  if (maximumPerCell > slotsPerCell) {
    report(
      SchedulerCode.ReplacementCapacityInvalid,
      `replacements.maximum_activated_per_cell ${String(
        maximumPerCell
      )} exceeds the held capacity of ${String(slotsPerCell)} slots per cell.`,
      "#/assignments"
    );
  }
  if (input.phasePlan.paid_calls.primary !== primaryCount) {
    report(
      SchedulerCode.PaidCeilingExceeded,
      `paid_calls.primary ${String(
        input.phasePlan.paid_calls.primary
      )} does not equal design.primary_assignments ${String(primaryCount)}.`,
      "#/assignments"
    );
  }
  const launches = primaryCount + slotsPerCell * cellCount;
  if (launches > input.phasePlan.paid_calls.maximum_with_replacements) {
    report(
      SchedulerCode.PaidCeilingExceeded,
      `The schedule needs ${String(launches)} launches, above the frozen paid ceiling of ${String(
        input.phasePlan.paid_calls.maximum_with_replacements
      )}.`,
      "#/assignments"
    );
  }
}

function resolveCellPlans(
  input: AssignmentScheduleInput,
  cells: readonly ScheduledCellView[],
  report: (code: string, message: string, pointer: string | null) => void
): Map<string, CellPlan> {
  const plans = new Map<string, CellPlan>();
  for (const cell of cells) {
    const digests = input.cell_digests.get(cell.cell_id);
    if (digests === undefined) {
      report(
        SchedulerCode.CellDigestMissing,
        `Cell ${JSON.stringify(cell.cell_id)} has no protocol-time digests.`,
        "#/assignments"
      );
      continue;
    }
    for (const name of CELL_DIGEST_FIELDS) {
      if (!isSha256Hex(digests[name])) {
        report(
          SchedulerCode.CellDigestMissing,
          `Cell ${JSON.stringify(cell.cell_id)} field ${JSON.stringify(
            name
          )} is not a SHA-256 digest.`,
          "#/assignments"
        );
      }
    }
    plans.set(cell.cell_id, {
      cell,
      digests,
      contract_variant_sha256: effectiveContractOf(cell, input, report)
    });
  }
  return plans;
}

/**
 * Effective-contract digest of one cell. A cell executes exactly one
 * contract, so a cell that binds two different variants is rejected.
 */
function effectiveContractOf(
  cell: ScheduledCellView,
  input: AssignmentScheduleInput,
  report: (code: string, message: string, pointer: string | null) => void
): string | null {
  const variants = new Set<string>();
  for (const factor of input.ir.factors) {
    const level = factor.levels.find(
      (entry) => entry.id === cell.factor_levels[factor.id]
    );
    if (level?.contract_variant !== undefined) {
      variants.add(level.contract_variant);
    }
  }
  if (variants.size > 1) {
    report(
      SchedulerCode.ContractVariantAmbiguous,
      `Cell ${JSON.stringify(cell.cell_id)} binds more than one ContractVariant: ${[
        ...variants
      ].join(", ")}.`,
      "#/assignments"
    );
    return null;
  }
  if (variants.size === 0) {
    return null;
  }
  const variant = [...variants][0] as string;
  const digest = input.effective_contracts[variant];
  if (digest === undefined) {
    report(
      SchedulerCode.ContractVariantUnknown,
      `Cell ${JSON.stringify(
        cell.cell_id
      )} binds ContractVariant ${JSON.stringify(
        variant
      )} that the protocol lock does not record.`,
      "#/assignments"
    );
    return null;
  }
  if (!isSha256Hex(digest)) {
    report(
      SchedulerCode.ContractVariantUnknown,
      `ContractVariant ${JSON.stringify(variant)} records a malformed digest.`,
      "#/assignments"
    );
    return null;
  }
  return digest;
}

/** Counts and ceilings of one built schedule, for preflight reporting. */
export interface ScheduleSummary {
  readonly primary_count: number;
  readonly held_replacement_count: number;
  readonly maximum_agent_launches: number;
  readonly block_count: number;
  readonly cell_count: number;
  readonly analytical: boolean;
  readonly purpose: string;
}

/** Report the counts `oal study schedule` prints. */
export function describeSchedule(
  schedule: AssignmentSchedule,
  phasePlan: PhasePlan
): ScheduleSummary {
  const primaries = schedule.assignments.filter(
    (assignment) => assignment.kind === "primary"
  );
  const blocks = new Set(
    primaries
      .map((assignment) => assignment.block_id)
      .filter((block): block is number => block !== null)
  );
  return {
    primary_count: primaries.length,
    held_replacement_count: schedule.assignments.length - primaries.length,
    maximum_agent_launches: schedule.assignments.length,
    block_count: blocks.size,
    cell_count: new Set(schedule.assignments.map((a) => a.cell_id)).size,
    analytical: phasePlan.analytical,
    purpose: phasePlan.purpose
  };
}

/**
 * Every block contains every resolved cell exactly once, and the primary
 * count equals blocks times cells.
 */
export function blocksAreComplete(
  schedule: AssignmentSchedule,
  cellCount: number
): boolean {
  const byBlock = new Map<number, Set<string>>();
  let primaries = 0;
  for (const assignment of schedule.assignments) {
    if (assignment.kind !== "primary") {
      continue;
    }
    primaries += 1;
    if (assignment.block_id === null) {
      return false;
    }
    const members = byBlock.get(assignment.block_id) ?? new Set<string>();
    if (members.has(assignment.cell_id)) {
      return false;
    }
    members.add(assignment.cell_id);
    byBlock.set(assignment.block_id, members);
  }
  if (byBlock.size * cellCount !== primaries) {
    return false;
  }
  for (const members of byBlock.values()) {
    if (members.size !== cellCount) {
      return false;
    }
  }
  return true;
}

/** JSON view of the schedule for validation and serialization. */
export function assignmentScheduleJson(schedule: AssignmentSchedule): Json {
  return {
    schema_version: schedule.schema_version,
    kind: schedule.kind,
    study_run_id: schedule.study_run_id,
    phase_id: schedule.phase_id,
    algorithm: schedule.algorithm,
    schedule_seed: schedule.schedule_seed,
    assignments: schedule.assignments.map(assignmentRecordJson)
  };
}

function assignmentRecordJson(assignment: AssignmentRecord): Json {
  return {
    assignment_id: assignment.assignment_id,
    kind: assignment.kind,
    status: assignment.status,
    study_run_id: assignment.study_run_id,
    phase_id: assignment.phase_id,
    cell_id: assignment.cell_id,
    child_batch_id: assignment.child_batch_id,
    slot: assignment.slot,
    block_id: assignment.block_id,
    repetition_index: assignment.repetition_index,
    reserve_index: assignment.reserve_index,
    eligible_stratum_policy: assignment.eligible_stratum_policy,
    factor_levels: { ...assignment.factor_levels },
    factor_level_digests: { ...assignment.factor_level_digests },
    contract_variant_sha256: assignment.contract_variant_sha256,
    participant_surface_policy_sha256:
      assignment.participant_surface_policy_sha256,
    eval_sha256: assignment.eval_sha256,
    scenario_sha256: assignment.scenario_sha256,
    rubric_sha256: assignment.rubric_sha256,
    run_profile_template_sha256: assignment.run_profile_template_sha256,
    sort_key: assignment.sort_key
  };
}

/** Canonical JSON bytes of the schedule: the persisted artifact basis. */
export function serializeAssignmentSchedule(
  schedule: AssignmentSchedule
): string {
  return canonicalJson(assignmentScheduleJson(schedule));
}

/** SHA-256 over the canonical schedule bytes. */
export function assignmentScheduleSha256(schedule: AssignmentSchedule): string {
  return sha256Hex(serializeAssignmentSchedule(schedule));
}
