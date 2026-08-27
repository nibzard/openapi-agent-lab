import { describe, expect, it } from "vitest";
import { isSha256Hex, sha256Hex } from "@oal/core";
import { deriveRunSeed } from "@oal/state-store";

import {
  assignmentRunBindings,
  assignmentRunSeed,
  heldReserveRunSeed,
  primaryRunSeed
} from "./seeds.ts";
import type { AssignmentSchedule } from "./schedule.ts";
import {
  COHORT_SEED,
  EFFECTIVE_CONTRACTS,
  FIXTURE_CELLS,
  PHASE_PLAN_SHA256,
  PROTOCOL_LOCK_SHA256,
  STUDY_RUN_ID,
  fixtureStudy
} from "./fixtures.ts";
import { buildAssignmentSchedule } from "./schedule.ts";

const BASE = {
  contractExecutionSha256: sha256Hex("contract execution"),
  participantSurfaceTemplateSha256: sha256Hex("surface template"),
  packSha256: sha256Hex("pack"),
  scenario: { id: "baseline", sha256: sha256Hex("scenario") },
  behaviorSha256: sha256Hex("behavior"),
  eval: { id: "prepare-and-replicate", sha256: sha256Hex("eval") },
  caseRef: { id: "default", sha256: sha256Hex("case") }
};

function fixtureSchedule(): AssignmentSchedule {
  const study = fixtureStudy();
  const result = buildAssignmentSchedule({
    study_run_id: STUDY_RUN_ID,
    ir: study.ir,
    phasePlan: study.phasePlan,
    protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
    phase_plan_sha256: PHASE_PLAN_SHA256,
    schedule_seed: COHORT_SEED,
    effective_contracts: EFFECTIVE_CONTRACTS,
    cell_digests: study.cellDigests
  });
  if (result.schedule === null) {
    throw new Error("Fixture schedule must build.");
  }
  return result.schedule;
}

describe("assignment run seeds", () => {
  it("uses the state-store section 17.5 derivation unchanged", () => {
    expect(primaryRunSeed(BASE, COHORT_SEED, 0)).toBe(
      deriveRunSeed({
        contractExecutionSha256: BASE.contractExecutionSha256,
        participantSurfaceTemplateSha256: BASE.participantSurfaceTemplateSha256,
        packSha256: BASE.packSha256,
        scenario: BASE.scenario,
        behaviorSha256: BASE.behaviorSha256,
        eval: BASE.eval,
        case: BASE.caseRef,
        cohortSeed: COHORT_SEED,
        assignment: { kind: "primary", index: 0 }
      })
    );
  });

  it("separates primary index 0 from reserve index 0", () => {
    const primary = primaryRunSeed(BASE, COHORT_SEED, 0);
    const reserve = heldReserveRunSeed(BASE, COHORT_SEED, 0);
    expect(primary).not.toBe(reserve);
    expect(isSha256Hex(primary)).toBe(true);
    expect(isSha256Hex(reserve)).toBe(true);
  });

  it("separates every repetition index of one cell", () => {
    const first = primaryRunSeed(BASE, COHORT_SEED, 0);
    const second = primaryRunSeed(BASE, COHORT_SEED, 1);
    expect(first).not.toBe(second);
  });

  it("feeds the cohort seed recorded in the schedule", () => {
    expect(primaryRunSeed(BASE, "other-cohort", 0)).not.toBe(
      primaryRunSeed(BASE, COHORT_SEED, 0)
    );
  });

  it("rejects a negative index", () => {
    expect(() =>
      assignmentRunSeed(BASE, COHORT_SEED, { kind: "primary", index: -1 })
    ).toThrow(/nonnegative/);
  });
});

describe("assignmentRunBindings", () => {
  it("binds every assignment to one run ID, run seed, and child batch", () => {
    const schedule = fixtureSchedule();
    const bindings = assignmentRunBindings(schedule, BASE);
    expect(bindings).toHaveLength(18);
    expect(new Set(bindings.map((binding) => binding.assignment_id)).size).toBe(
      18
    );
    expect(new Set(bindings.map((binding) => binding.run_id)).size).toBe(18);
    for (const binding of bindings) {
      expect(binding.run_id).toMatch(/^run_[a-f0-9]{24}$/);
      expect(isSha256Hex(binding.run_seed)).toBe(true);
      const assignment = schedule.assignments.find(
        (entry) => entry.assignment_id === binding.assignment_id
      );
      expect(assignment?.child_batch_id).toBe(binding.child_batch_id);
    }
  });

  it("derives every held seed from the reserve index", () => {
    const schedule = fixtureSchedule();
    const bindings = assignmentRunBindings(schedule, BASE);
    const heldBinding = bindings.find((binding) => {
      const assignment = schedule.assignments.find(
        (entry) => entry.assignment_id === binding.assignment_id
      );
      return assignment?.kind === "held_replacement";
    });
    expect(heldBinding?.run_seed).toBe(
      heldReserveRunSeed(BASE, COHORT_SEED, 0)
    );
  });

  it("never reuses a run seed across a primary and a held slot of one cell", () => {
    const schedule = fixtureSchedule();
    const bindings = assignmentRunBindings(schedule, BASE);
    const cellId = FIXTURE_CELLS[0] as string;
    const ofCell = bindings.filter((binding) => {
      const assignment = schedule.assignments.find(
        (entry) => entry.assignment_id === binding.assignment_id
      );
      return assignment?.cell_id === cellId;
    });
    expect(ofCell).toHaveLength(3);
    expect(new Set(ofCell.map((binding) => binding.run_seed)).size).toBe(3);
  });

  it("is deterministic", () => {
    const schedule = fixtureSchedule();
    expect(assignmentRunBindings(schedule, BASE)).toEqual(
      assignmentRunBindings(schedule, BASE)
    );
  });
});
