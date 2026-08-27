import { describe, expect, it } from "vitest";
import { SchemaValidator, sha256Hex } from "@oal/core";
import type { PhasePlan } from "@oal/study-ir";

import {
  assignmentScheduleJson,
  assignmentScheduleSha256,
  blocksAreComplete,
  buildAssignmentSchedule,
  describeSchedule,
  heldSortKey,
  primarySortKey,
  serializeAssignmentSchedule,
  type AssignmentSchedule
} from "./schedule.ts";
import {
  COHORT_SEED,
  EFFECTIVE_CONTRACTS,
  FIXTURE_CELLS,
  PHASE_PLAN_SHA256,
  PROTOCOL_LOCK_SHA256,
  STUDY_RUN_ID,
  fixtureStudy,
  loadSchema
} from "./fixtures.ts";

const scheduleSchema = new SchemaValidator(
  loadSchema("assignment-schedule.v1.schema.json")
);

/** Sort keys hashed independently from the section 12.11 rule. */
const BLOCK_0_ORDER = [
  [
    "shape_a__supplied",
    "4082e957c63cd4362c68c80d66a7a7ba6275445542deaff89b6e771267c4413c"
  ],
  [
    "shape_a__discoverable",
    "47868e7461ea2a06671be7f65b4f9c0eebd5055407026f1f4e94f7873cb8839b"
  ],
  [
    "shape_b__discoverable",
    "52ab5a362a9ecb959c3c6767ae13cdffad8d1c1ecef08ca66904ea7476d14206"
  ],
  [
    "shape_b__blind",
    "7e5b2287a763cf615cce2eff4ac37f53519792c3ae52f38e8598150c2816a762"
  ],
  [
    "shape_b__supplied",
    "c10b3f445059ab0a7f5740a2b8070f64a71689c91b946654c50e95fb9e484d27"
  ],
  [
    "shape_a__blind",
    "ed058296ee107679af607a449226a9e2fa4f651bf0bf660722acab63ed6e7ad3"
  ]
] as const;

const BLOCK_1_ORDER = [
  [
    "shape_a__blind",
    "1e7afe944fb0ca753f3bf4d69f859738a97cc165f8e6557e3fe6401677569e29"
  ],
  [
    "shape_a__supplied",
    "307853a0e3eb1fbbd538f68dd3f56de56fe94ecdca06fee23cd630538c000387"
  ],
  [
    "shape_b__discoverable",
    "478c5a922b8bbf8730d2978c5812ff0ae7c234ddf0f3fde75cd8cec420d85a31"
  ],
  [
    "shape_b__blind",
    "48ce374927bca5eadbfd35a489f7fee30ca46a4237ff11ee1f9af64709bbb8a9"
  ],
  [
    "shape_b__supplied",
    "67809414c3296d42e9f4f09ab262a08ebcf2ab593c575b5be860c4167556fc1a"
  ],
  [
    "shape_a__discoverable",
    "8eca11d5a52277f367e32b62c248e3af3030311897210be39c9fcfa7345af132"
  ]
] as const;

function build(phasePlanOverride?: (plan: PhasePlan) => PhasePlan) {
  const study = fixtureStudy();
  return buildAssignmentSchedule({
    study_run_id: STUDY_RUN_ID,
    ir: study.ir,
    phasePlan: phasePlanOverride?.(study.phasePlan) ?? study.phasePlan,
    protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
    phase_plan_sha256: PHASE_PLAN_SHA256,
    schedule_seed: COHORT_SEED,
    effective_contracts: EFFECTIVE_CONTRACTS,
    cell_digests: study.cellDigests
  });
}

function scheduleOf(): AssignmentSchedule {
  const result = build();
  if (result.schedule === null) {
    throw new Error(
      `Fixture schedule must build: ${JSON.stringify(result.diagnostics)}`
    );
  }
  return result.schedule;
}

describe("buildAssignmentSchedule", () => {
  it("builds twelve primary and six held assignments", () => {
    const schedule = scheduleOf();
    expect(schedule.assignments).toHaveLength(18);
    expect(schedule.study_run_id).toBe(STUDY_RUN_ID);
    expect(schedule.phase_id).toBe("pilot");
    expect(schedule.algorithm).toBe("canonical-sha256-sort-v1");
    expect(schedule.schedule_seed).toBe(COHORT_SEED);
    expect(
      schedule.assignments.filter((assignment) => assignment.kind === "primary")
    ).toHaveLength(12);
    expect(
      schedule.assignments.filter(
        (assignment) => assignment.kind === "held_replacement"
      )
    ).toHaveLength(6);
  });

  it("orders every block by the lexicographic SHA-256 of its sort key", () => {
    const schedule = scheduleOf();
    const primaries = schedule.assignments.filter(
      (assignment) => assignment.kind === "primary"
    );
    const block0 = primaries.filter((a) => a.block_id === 0);
    const block1 = primaries.filter((a) => a.block_id === 1);
    expect(block0.map((a) => [a.cell_id, a.sort_key])).toEqual(
      BLOCK_0_ORDER.map(([cellId, sortKey]) => [cellId, sortKey])
    );
    expect(block1.map((a) => [a.cell_id, a.sort_key])).toEqual(
      BLOCK_1_ORDER.map(([cellId, sortKey]) => [cellId, sortKey])
    );
  });

  it("sorts each block independently, so a new block cannot repeat an order", () => {
    const schedule = scheduleOf();
    const first = schedule.assignments
      .filter((a) => a.block_id === 0)
      .map((a) => a.cell_id);
    const second = schedule.assignments
      .filter((a) => a.block_id === 1)
      .map((a) => a.cell_id);
    expect(first).not.toEqual(second);
  });

  it("stores held entries after the primaries in canonical cell and reserve order", () => {
    const schedule = scheduleOf();
    const held = schedule.assignments.slice(12);
    expect(held.every((a) => a.kind === "held_replacement")).toBe(true);
    expect(held.map((a) => a.cell_id)).toEqual(FIXTURE_CELLS);
    expect(held.every((a) => a.reserve_index === 0)).toBe(true);
    expect(held.every((a) => a.status === "held")).toBe(true);
    expect(held.every((a) => a.block_id === null)).toBe(true);
    expect(
      held.every((a) => a.eligible_stratum_policy === "held-same-cell")
    ).toBe(true);
  });

  it("keeps every block complete: every cell exactly once per block", () => {
    const schedule = scheduleOf();
    expect(blocksAreComplete(schedule, FIXTURE_CELLS.length)).toBe(true);
    for (const block of [0, 1]) {
      const cells = schedule.assignments
        .filter((a) => a.block_id === block)
        .map((a) => a.cell_id);
      expect([...cells].sort()).toEqual([...FIXTURE_CELLS].sort());
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it("numbers slots, blocks, and repetition indices from zero", () => {
    const schedule = scheduleOf();
    expect(schedule.assignments.map((a) => a.slot)).toEqual([
      ...Array(18).keys()
    ]);
    const primaries = schedule.assignments.filter((a) => a.kind === "primary");
    expect(primaries.every((a) => a.repetition_index === a.block_id)).toBe(
      true
    );
  });

  it("rejects a primary count that is not divisible by the cell count", () => {
    const result = build((plan) => ({
      ...plan,
      design: { ...plan.design, primary_assignments: 7, block: undefined },
      paid_calls: { primary: 7, maximum_with_replacements: 13 }
    }));
    expect(result.schedule).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      "OAL-SCHEDULE-DESIGN-UNBALANCED"
    ]);
  });

  it("rejects a declared block structure that contradicts the counts", () => {
    const result = build((plan) => ({
      ...plan,
      design: { ...plan.design, block: { cells: "all", repetitions: 3 } }
    }));
    expect(result.schedule).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "OAL-SCHEDULE-BLOCK-STRUCTURE-INVALID"
    );
  });

  it("rejects a schedule above the frozen paid ceiling", () => {
    const result = build((plan) => ({
      ...plan,
      paid_calls: { primary: 12, maximum_with_replacements: 12 }
    }));
    expect(result.schedule).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "OAL-SCHEDULE-PAID-CEILING-EXCEEDED"
    );
  });

  it("rejects an activation ceiling above the held capacity", () => {
    const result = build((plan) => {
      const replacements = plan.replacements;
      if (replacements === undefined) {
        throw new Error("Fixture plan must declare replacements.");
      }
      return {
        ...plan,
        replacements: { ...replacements, maximum_activated_per_cell: 2 }
      };
    });
    expect(result.schedule).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "OAL-SCHEDULE-REPLACEMENT-CAPACITY-INVALID"
    );
  });

  it("drops held capacity when the plan freezes replacement kind none", () => {
    const study = fixtureStudy();
    const result = build((plan) => ({
      ...plan,
      replacements: undefined
    }));
    const schedule = result.schedule;
    expect(schedule).not.toBeNull();
    expect(schedule?.assignments).toHaveLength(12);
    const summary = describeSchedule(
      schedule as AssignmentSchedule,
      study.phasePlan
    );
    expect(summary.held_replacement_count).toBe(0);
    expect(summary.maximum_agent_launches).toBe(12);
  });

  it("produces byte-identical schedules for identical inputs", () => {
    const left = serializeAssignmentSchedule(scheduleOf());
    const right = serializeAssignmentSchedule(scheduleOf());
    expect(left).toBe(right);
    expect(assignmentScheduleSha256(scheduleOf())).toBe(
      assignmentScheduleSha256(scheduleOf())
    );
  });

  it("pins the canonical schedule bytes to a fixed digest", () => {
    expect(assignmentScheduleSha256(scheduleOf())).toBe(
      "ee0c4853c7a9656205511cbe71abc5c8d2878f40b0ad142316409b42aa2fa256"
    );
  });

  it("moves the order when the cohort seed changes", () => {
    const study = fixtureStudy();
    const other = buildAssignmentSchedule({
      study_run_id: STUDY_RUN_ID,
      ir: study.ir,
      phasePlan: study.phasePlan,
      protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
      phase_plan_sha256: PHASE_PLAN_SHA256,
      schedule_seed: "second-cohort-seed",
      effective_contracts: EFFECTIVE_CONTRACTS,
      cell_digests: study.cellDigests
    }).schedule;
    expect(other).not.toBeNull();
    const base = scheduleOf();
    const otherSchedule = other as AssignmentSchedule;
    expect(otherSchedule.assignments.map((a) => a.cell_id)).not.toEqual(
      base.assignments.map((a) => a.cell_id)
    );
    expect(
      otherSchedule.assignments
        .filter((a) => a.block_id === 0)
        .map((a) => a.cell_id)
        .sort()
    ).toEqual([...FIXTURE_CELLS].sort());
  });

  it("moves the order when the protocol lock digest changes", () => {
    const study = fixtureStudy();
    const other = buildAssignmentSchedule({
      study_run_id: STUDY_RUN_ID,
      ir: study.ir,
      phasePlan: study.phasePlan,
      protocol_lock_sha256: sha256Hex("another protocol lock"),
      phase_plan_sha256: PHASE_PLAN_SHA256,
      schedule_seed: COHORT_SEED,
      effective_contracts: EFFECTIVE_CONTRACTS,
      cell_digests: study.cellDigests
    }).schedule;
    expect(other?.assignments.map((a) => a.sort_key)).not.toEqual(
      scheduleOf().assignments.map((a) => a.sort_key)
    );
  });

  it("records ordered factor levels, their digests, and the cell digests", () => {
    const schedule = scheduleOf();
    const shapeABlind = schedule.assignments.find(
      (a) => a.cell_id === "shape_a__blind" && a.kind === "primary"
    );
    expect(shapeABlind?.factor_levels).toEqual({
      api_shape: "shape_a",
      documentation: "blind"
    });
    expect(Object.keys(shapeABlind?.factor_level_digests ?? {})).toEqual([
      "api_shape",
      "documentation"
    ]);
    expect(shapeABlind?.contract_variant_sha256).toBe(
      EFFECTIVE_CONTRACTS["shape-a"]
    );
    expect(shapeABlind?.participant_surface_policy_sha256).toBe(
      sha256Hex("surface policy shape_a__blind")
    );
    expect(shapeABlind?.run_profile_template_sha256).toBe(
      sha256Hex("run profile shape_a__blind")
    );
    expect(shapeABlind?.child_batch_id).toMatch(/^bat_[a-f0-9]{24}$/);
    expect(shapeABlind?.assignment_id).toMatch(/^asg_[a-f0-9]{24}$/);
  });

  it("binds every assignment of one cell to one child batch", () => {
    const schedule = scheduleOf();
    for (const cellId of FIXTURE_CELLS) {
      const batches = new Set(
        schedule.assignments
          .filter((a) => a.cell_id === cellId)
          .map((a) => a.child_batch_id)
      );
      expect(batches.size).toBe(1);
    }
    expect(new Set(schedule.assignments.map((a) => a.assignment_id)).size).toBe(
      18
    );
  });

  it("validates against assignment-schedule.v1.schema.json", () => {
    expect(scheduleSchema.errors(assignmentScheduleJson(scheduleOf()))).toEqual(
      []
    );
  });

  it("reports the counts a schedule preview prints", () => {
    const study = fixtureStudy();
    const summary = describeSchedule(scheduleOf(), study.phasePlan);
    expect(summary).toEqual({
      primary_count: 12,
      held_replacement_count: 6,
      maximum_agent_launches: 18,
      block_count: 2,
      cell_count: 6,
      analytical: true,
      purpose: "pilot"
    });
  });

  it("recomputes the sort keys from the documented rule", () => {
    const schedule = scheduleOf();
    const shapeASupplied = schedule.assignments.find(
      (a) => a.cell_id === "shape_a__supplied" && a.block_id === 0
    );
    expect(
      primarySortKey({
        protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
        phase_plan_sha256: PHASE_PLAN_SHA256,
        schedule_seed: COHORT_SEED,
        block_id: 0,
        cell_id: "shape_a__supplied"
      })
    ).toBe(shapeASupplied?.sort_key);
    const heldBlind = schedule.assignments.find(
      (a) => a.cell_id === "shape_a__blind" && a.kind === "held_replacement"
    );
    expect(
      heldSortKey({
        protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
        phase_plan_sha256: PHASE_PLAN_SHA256,
        schedule_seed: COHORT_SEED,
        cell_id: "shape_a__blind",
        reserve_index: 0
      })
    ).toBe(heldBlind?.sort_key);
  });
});
