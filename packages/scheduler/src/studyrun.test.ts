import { describe, expect, it } from "vitest";
import { SchemaValidator, sha256Hex } from "@oal/core";

import {
  CHILD_BATCH_ROOT,
  buildStudyRunHeader,
  serializeStudyRun,
  studyRunJson,
  studyRunSha256,
  type StudyRunHeaderInput
} from "./studyrun.ts";
import {
  assignmentScheduleSha256,
  type AssignmentSchedule
} from "./schedule.ts";
import { buildAssignmentSchedule } from "./schedule.ts";
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

const runSchema = new SchemaValidator(loadSchema("study-run.v1.schema.json"));

const CREATED_AT = "2026-08-27T09:30:00.000Z";
const PHASE_LOCK_SHA256 = sha256Hex("fixture phase lock");

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

function headerInputOf(
  schedule: AssignmentSchedule = fixtureSchedule()
): StudyRunHeaderInput {
  return {
    study_run_id: STUDY_RUN_ID,
    created_at: CREATED_AT,
    protocol: {
      id: "prepared-workspace-api-v1",
      version: "1.0.0",
      protocol_lock_sha256: PROTOCOL_LOCK_SHA256
    },
    phase: {
      id: "pilot",
      kind: "pilot",
      analytical: true,
      phase_plan_sha256: PHASE_PLAN_SHA256,
      phase_lock_sha256: PHASE_LOCK_SHA256
    },
    schedule,
    study_compatibility_sha256: sha256Hex("fixture study compatibility"),
    implementation_sha256: sha256Hex("fixture implementation"),
    analysis_plan_sha256: sha256Hex("fixture analysis plan"),
    cells: FIXTURE_CELLS.map((cellId) => ({
      cell_id: cellId,
      factor_levels:
        schedule.assignments.find((assignment) => assignment.cell_id === cellId)
          ?.factor_levels ?? {},
      cell_compatibility_sha256: sha256Hex(`cell compatibility ${cellId}`)
    }))
  };
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

describe("buildStudyRunHeader", () => {
  it("assembles the section 12.14 header over the fixture study", () => {
    const result = buildStudyRunHeader(headerInputOf());
    const header = result.header;
    if (header === null) {
      throw new Error(
        `Fixture header must build: ${JSON.stringify(result.diagnostics)}`
      );
    }
    expect(result.diagnostics).toEqual([]);
    expect(header.schema_version).toBe(1);
    expect(header.study_run_id).toBe(STUDY_RUN_ID);
    expect(header.created_at).toBe(CREATED_AT);
    expect(header.protocol).toEqual({
      id: "prepared-workspace-api-v1",
      version: "1.0.0",
      protocol_lock_sha256: PROTOCOL_LOCK_SHA256
    });
    expect(header.phase).toEqual({
      id: "pilot",
      kind: "pilot",
      analytical: true,
      phase_plan_sha256: PHASE_PLAN_SHA256,
      phase_lock_sha256: PHASE_LOCK_SHA256
    });
    expect(header.extensions).toEqual({});
    expect(Object.keys(header)).toEqual([
      "schema_version",
      "study_run_id",
      "created_at",
      "protocol",
      "phase",
      "assignment_schedule",
      "study_compatibility_sha256",
      "implementation_sha256",
      "analysis_plan_sha256",
      "child_batches",
      "extensions"
    ]);
  });

  it("lists child batches in canonical cell-ID order with derived IDs", () => {
    const result = buildStudyRunHeader(headerInputOf());
    const header = result.header;
    if (header === null) {
      throw new Error("Fixture header must build.");
    }
    expect(header.child_batches.map((batch) => batch.cell_id)).toEqual(
      FIXTURE_CELLS
    );
    for (const batch of header.child_batches) {
      expect(batch.batch_id).toMatch(/^bat_[a-f0-9]{24,32}$/);
      expect(batch.relative_path).toBe(`${CHILD_BATCH_ROOT}/${batch.batch_id}`);
      expect(batch.cell_compatibility_sha256).toBe(
        sha256Hex(`cell compatibility ${batch.cell_id}`)
      );
    }
    const blind = header.child_batches.find(
      (batch) => batch.cell_id === "shape_a__blind"
    );
    expect(blind?.batch_id).toBe("bat_175afb0546fc2a0a8dba7cfa");
    expect(blind?.relative_path).toBe(
      `${CHILD_BATCH_ROOT}/bat_175afb0546fc2a0a8dba7cfa`
    );
    expect(blind?.factor_levels).toEqual({
      api_shape: "shape_a",
      documentation: "blind"
    });
    expect(
      new Set(header.child_batches.map((batch) => batch.batch_id)).size
    ).toBe(6);
    expect(
      new Set(header.child_batches.map((batch) => batch.relative_path)).size
    ).toBe(6);
  });

  it("binds every child batch to the batch the schedule already recorded", () => {
    const schedule = fixtureSchedule();
    const result = buildStudyRunHeader(headerInputOf(schedule));
    const header = result.header;
    if (header === null) {
      throw new Error("Fixture header must build.");
    }
    for (const batch of header.child_batches) {
      expect(batch.batch_id).toMatch(/^bat_[a-f0-9]{24,32}$/);
      for (const assignment of schedule.assignments) {
        if (assignment.cell_id === batch.cell_id) {
          expect(assignment.child_batch_id).toBe(batch.batch_id);
        }
      }
    }
  });

  it("records the schedule identity, digest, and launch ceiling", () => {
    const schedule = fixtureSchedule();
    const result = buildStudyRunHeader(headerInputOf(schedule));
    const header = result.header;
    if (header === null) {
      throw new Error("Fixture header must build.");
    }
    expect(header.assignment_schedule).toEqual({
      algorithm: "canonical-sha256-sort-v1",
      sha256: assignmentScheduleSha256(schedule),
      primary_count: 12,
      held_replacement_count: 6,
      maximum_agent_launches: 18
    });
    expect(header.assignment_schedule.sha256).toBe(
      "ee0c4853c7a9656205511cbe71abc5c8d2878f40b0ad142316409b42aa2fa256"
    );
  });

  it("validates against study-run.v1.schema.json", () => {
    const result = buildStudyRunHeader(headerInputOf());
    const header = result.header;
    if (header === null) {
      throw new Error("Fixture header must build.");
    }
    expect(runSchema.errors(studyRunJson(header))).toEqual([]);
    expect(serializeStudyRun(header)).not.toContain("\n");
  });

  it("is deterministic and pins the canonical header bytes", () => {
    const left = buildStudyRunHeader(headerInputOf()).header;
    const right = buildStudyRunHeader(headerInputOf()).header;
    if (left === null || right === null) {
      throw new Error("Fixture header must build.");
    }
    expect(serializeStudyRun(left)).toBe(serializeStudyRun(right));
    expect(studyRunSha256(left)).toBe(studyRunSha256(right));
    expect(studyRunSha256(left)).toBe(
      "e1762400284b8242c1b3d8a119fb7d92b8ed70ff048f9c9446b299781ce76162"
    );
  });

  it("rejects a StudyRun or phase that contradicts the schedule", () => {
    const mismatched = headerInputOf();
    const otherRun = buildStudyRunHeader({
      ...mismatched,
      study_run_id: "another-study-run"
    });
    expect(otherRun.header).toBeNull();
    expect(codes(otherRun.diagnostics)).toContain(
      "OAL-SCHEDULE-STUDY-RUN-MISMATCH"
    );
    const otherPhase = buildStudyRunHeader({
      ...mismatched,
      phase: { ...mismatched.phase, id: "smoke" }
    });
    expect(otherPhase.header).toBeNull();
    expect(codes(otherPhase.diagnostics)).toContain(
      "OAL-SCHEDULE-STUDY-RUN-MISMATCH"
    );
  });

  it("rejects a malformed creation time and malformed digests", () => {
    const base = headerInputOf();
    const badTime = buildStudyRunHeader({
      ...base,
      created_at: "2026-08-27T09:30:00Z"
    });
    expect(badTime.header).toBeNull();
    expect(codes(badTime.diagnostics)).toContain("OAL-SCHEDULE-HEADER-INVALID");
    const badDigest = buildStudyRunHeader({
      ...base,
      implementation_sha256: "not-a-digest"
    });
    expect(badDigest.header).toBeNull();
    expect(codes(badDigest.diagnostics)).toContain(
      "OAL-SCHEDULE-HEADER-INVALID"
    );
    const badCellDigest = buildStudyRunHeader({
      ...base,
      cells: base.cells.map((cell) => ({
        ...cell,
        cell_compatibility_sha256: "short"
      }))
    });
    expect(badCellDigest.header).toBeNull();
    expect(codes(badCellDigest.diagnostics)).toContain(
      "OAL-SCHEDULE-CELL-DIGEST-MISSING"
    );
  });

  it("rejects a cell inventory that disagrees with the schedule", () => {
    const base = headerInputOf();
    const missingBatch = buildStudyRunHeader({
      ...base,
      cells: base.cells.slice(1)
    });
    expect(missingBatch.header).toBeNull();
    expect(codes(missingBatch.diagnostics)).toContain(
      "OAL-SCHEDULE-CELL-INVENTORY-INVALID"
    );
    const unscheduled = buildStudyRunHeader({
      ...base,
      cells: [
        ...base.cells,
        {
          cell_id: "shape_c__blind",
          factor_levels: { api_shape: "shape_c", documentation: "blind" },
          cell_compatibility_sha256: sha256Hex("cell compatibility extra")
        }
      ]
    });
    expect(unscheduled.header).toBeNull();
    expect(codes(unscheduled.diagnostics)).toContain(
      "OAL-SCHEDULE-CELL-INVENTORY-INVALID"
    );
    const duplicated = buildStudyRunHeader({
      ...base,
      cells: [...base.cells, base.cells[0] as (typeof base.cells)[number]]
    });
    expect(duplicated.header).toBeNull();
    expect(codes(duplicated.diagnostics)).toContain(
      "OAL-SCHEDULE-CELL-INVENTORY-INVALID"
    );
    const empty = buildStudyRunHeader({ ...base, cells: [] });
    expect(empty.header).toBeNull();
    expect(codes(empty.diagnostics)).toContain(
      "OAL-SCHEDULE-CELL-INVENTORY-INVALID"
    );
  });
});
