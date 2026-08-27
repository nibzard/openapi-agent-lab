import { describe, expect, it } from "vitest";
import {
  SchemaValidator,
  diagnostic,
  sha256Hex,
  type Diagnostic
} from "@oal/core";
import {
  assignmentRunBindings,
  heldUnusedAssignments,
  studyRunJson,
  type AssignmentSchedule
} from "@oal/scheduler";

import {
  AbortReason,
  deriveStudyCompleted,
  executeStudyRun,
  planStudyRun,
  RunCode,
  studyCompletedJson,
  type StudyRunPlanInput,
  type StudyRunPreflight,
  type TrialLaunch,
  type TrialOutcome
} from "./run.ts";
import {
  TWO_CELL_ANALYSIS_PLAN,
  TWO_CELL_CELLS,
  TWO_CELL_CREATED_AT,
  TWO_CELL_IMPLEMENTATION,
  TWO_CELL_PHASE_LOCK,
  TWO_CELL_PHASE_PLAN_SHA256,
  TWO_CELL_PROTOCOL_LOCK,
  TWO_CELL_RUN_ID,
  TWO_CELL_STUDY_COMPATIBILITY,
  loadSchema,
  twoCellStudy,
  type TwoCellStudy
} from "./fixtures.ts";

const runSchema = new SchemaValidator(loadSchema("study-run.v1.schema.json"));
const completedSchema = new SchemaValidator(
  loadSchema("study-completed.v1.schema.json")
);

/** Fixed, strictly increasing millisecond clock. */
function fixedClock(): () => string {
  let tick = 0;
  return (): string => {
    tick += 1;
    return `2026-08-27T12:00:${(tick % 60).toString(10).padStart(2, "0")}.${(
      (tick * 7) %
      1000
    )
      .toString(10)
      .padStart(3, "0")}Z`;
  };
}

const COHORT_SEED_BASE = {
  contractExecutionSha256: sha256Hex("two cell contract execution"),
  participantSurfaceTemplateSha256: sha256Hex("two cell surface"),
  packSha256: sha256Hex("two cell pack"),
  scenario: {
    id: "baseline",
    sha256: sha256Hex("two cell scenario")
  },
  behaviorSha256: sha256Hex("two cell behavior"),
  eval: {
    id: "prepare-and-replicate",
    sha256: sha256Hex("two cell eval")
  },
  caseRef: null
} as const;

function planInputOf(
  study: TwoCellStudy,
  preflight: StudyRunPreflight
): StudyRunPlanInput {
  return {
    study_run_id: TWO_CELL_RUN_ID,
    created_at: TWO_CELL_CREATED_AT,
    protocol: {
      id: "two-cell-api-shape-v1",
      version: "1.0.0",
      protocol_lock_sha256: TWO_CELL_PROTOCOL_LOCK
    },
    phasePlan: study.phasePlan,
    phase_plan_sha256: TWO_CELL_PHASE_PLAN_SHA256,
    phase_lock_sha256: TWO_CELL_PHASE_LOCK,
    schedule: study.schedule,
    study_compatibility_sha256: TWO_CELL_STUDY_COMPATIBILITY,
    implementation_sha256: TWO_CELL_IMPLEMENTATION,
    analysis_plan_sha256: TWO_CELL_ANALYSIS_PLAN,
    cells: TWO_CELL_CELLS.map((cellId) => ({
      cell_id: cellId,
      factor_levels:
        study.schedule.assignments.find(
          (assignment) => assignment.cell_id === cellId
        )?.factor_levels ?? {},
      cell_compatibility_sha256: sha256Hex(`two cell key ${cellId}`)
    })),
    cohort_seed_base: COHORT_SEED_BASE,
    preflight
  };
}

const PASSING_PREFLIGHT: StudyRunPreflight = {
  ok: true,
  diagnostics: []
};

/** Resolve one terminal outcome, so literal unions stay narrow. */
function outcomeOf(outcome: TrialOutcome): Promise<TrialOutcome> {
  return Promise.resolve(outcome);
}

/** Executor that completes every trial cleanly. */
function cleanExecutor(): (launch: TrialLaunch) => Promise<TrialOutcome> {
  return (launch: TrialLaunch): Promise<TrialOutcome> => {
    expect(launch.run_seed).toMatch(/^[a-f0-9]{64}$/);
    return outcomeOf({
      disposition: "completed",
      evidence_integrity: "intact"
    });
  };
}

describe("StudyRun planning", () => {
  it("refuses to assemble a header when preflight failed", () => {
    const study = twoCellStudy();
    const failing = {
      ok: false,
      diagnostics: []
    } as const;
    const result = planStudyRun(planInputOf(study, failing));
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      RunCode.PreflightFailed
    );
  });

  it("refuses to assemble a header when preflight holds an error", () => {
    const study = twoCellStudy();
    const diagnostics: Diagnostic[] = [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: "OAL-OTHER",
        message: "one check failed"
      })
    ];
    const result = planStudyRun(planInputOf(study, { ok: true, diagnostics }));
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "OAL-OTHER"
    );
  });

  it("assembles a schema-valid header and one binding per assignment", () => {
    const study = twoCellStudy();
    const result = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = result.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }
    expect(runSchema.errors(studyRunJson(plan.header))).toEqual([]);

    expect(plan.bindings).toHaveLength(study.schedule.assignments.length);
    // Run IDs stay per assignment; run seeds do not carry the cell, so the
    // two cells share the paired seed of one repetition index (section 12.14).
    expect(new Set(plan.bindings.map((binding) => binding.run_id)).size).toBe(
      plan.bindings.length
    );
    expect(new Set(plan.bindings.map((binding) => binding.run_seed)).size).toBe(
      3
    );
    const expected = assignmentRunBindings(study.schedule, COHORT_SEED_BASE);
    expect(plan.bindings).toEqual(expected);
    expect(plan.primaries).toHaveLength(4);
    expect(plan.held).toHaveLength(2);
  });
});

describe("StudyRun execution", () => {
  it("launches every primary once and holds every held slot", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const execution = await executeStudyRun(plan, cleanExecutor(), {
      clock: fixedClock()
    });

    expect(execution.launches).toHaveLength(4);
    expect(execution.abort_reason).toBeNull();
    expect(execution.completed).not.toBeNull();
    const completed = execution.completed;
    if (completed === null) {
      throw new Error("Completion must derive.");
    }
    expect(completedSchema.errors(studyCompletedJson(completed))).toEqual([]);
    expect(completed.status).toBe("completed");
    expect(completed.counts).toEqual({
      primary_assignments: 4,
      activated_replacements: 0,
      held_unused: 2,
      not_started: 0,
      child_batches: 2
    });
    expect(
      heldUnusedAssignments(
        {
          study_run_id: TWO_CELL_RUN_ID,
          assignments: study.schedule.assignments
        },
        execution.ledger
      )
    ).toHaveLength(2);
  });

  it("binds each launch to its assignment run seed and identity", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const execution = await executeStudyRun(plan, cleanExecutor(), {
      clock: fixedClock()
    });
    const byAssignment = new Map(
      plan.bindings.map((binding) => [binding.assignment_id, binding])
    );
    for (const launch of execution.launches) {
      const binding = byAssignment.get(launch.assignment_id);
      expect(binding).toBeDefined();
      if (binding === undefined) {
        continue;
      }
      expect(launch.run_id).toBe(binding.run_id);
      expect(launch.run_seed).toBe(binding.run_seed);
      expect(launch.child_batch_id).toBe(binding.child_batch_id);
      expect(launch.replacement_target).toBeNull();
    }
    const runIds = execution.launches.map((launch) => launch.run_id);
    expect(new Set(runIds).size).toBe(runIds.length);
    // Both cells draw the paired scenario at one repetition index, so their
    // primaries share a run seed while keeping distinct run identities.
    const byCell = new Map(
      ["shape_a", "shape_b"].map((cellId) => [
        cellId,
        execution.launches
          .filter((launch) => launch.cell_id === cellId)
          .sort((a, b) => (a.repetition_index ?? 0) - (b.repetition_index ?? 0))
      ])
    );
    const firstCell = byCell.get("shape_a") ?? [];
    const secondCell = byCell.get("shape_b") ?? [];
    expect(firstCell).toHaveLength(2);
    expect(secondCell).toHaveLength(2);
    for (const [index, launch] of firstCell.entries()) {
      expect(launch.run_seed).toBe(secondCell[index]?.run_seed);
    }
    expect(firstCell[0]?.run_seed).not.toBe(firstCell[1]?.run_seed);
  });

  it("aborts on a batch-wide defect without consuming held slots", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const seen: TrialLaunch[] = [];
    const execution = await executeStudyRun(
      plan,
      (launch: TrialLaunch): Promise<TrialOutcome> => {
        seen.push(launch);
        if (seen.length === 1) {
          return Promise.resolve({
            disposition: "infrastructure_failed_pre_control",
            evidence_integrity: "intact",
            censor_class: "pre_control_nonparticipant",
            batch_wide: true
          });
        }
        return outcomeOf({
          disposition: "completed",
          evidence_integrity: "intact"
        });
      },
      { clock: fixedClock() }
    );

    expect(execution.abort_reason).toBe(AbortReason.BatchWideLauncherDefect);
    expect(seen).toHaveLength(1);
    const completed = execution.completed;
    expect(completed).not.toBeNull();
    if (completed === null) {
      return;
    }
    expect(completed.status).toBe("aborted");
    expect(completed.reason).toBe(AbortReason.BatchWideLauncherDefect);
    expect(completed.counts).toEqual({
      primary_assignments: 4,
      activated_replacements: 0,
      held_unused: 2,
      not_started: 3,
      child_batches: 2
    });
    expect(
      execution.ledger.events.filter((event) => event.kind === "not_started")
    ).toHaveLength(3);
  });

  it("aborts on an operator interruption", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    let calls = 0;
    const execution = await executeStudyRun(
      plan,
      (): Promise<TrialOutcome> => {
        calls += 1;
        if (calls === 2) {
          return outcomeOf({
            disposition: "operator_interrupted",
            evidence_integrity: "intact"
          });
        }
        return outcomeOf({ disposition: "completed" });
      },
      { clock: fixedClock() }
    );
    expect(execution.abort_reason).toBe(AbortReason.OperatorInterrupted);
    expect(calls).toBe(2);
    expect(execution.completed?.status).toBe("aborted");
  });

  it("records an executor failure as a harness abort that settles the ledger", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    let calls = 0;
    const execution = await executeStudyRun(
      plan,
      (): Promise<TrialOutcome> => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error("launcher exploded"));
        }
        return outcomeOf({ disposition: "completed" });
      },
      { clock: fixedClock() }
    );
    expect(calls).toBe(2);
    expect(execution.abort_reason).toBe(AbortReason.ExecutorFailed);
    expect(execution.diagnostics.map((entry) => entry.code)).toContain(
      RunCode.ExecutorFailed
    );
    const terminal = execution.ledger.events.find(
      (event) =>
        event.kind === "terminal" && event.disposition === "harness_aborted"
    );
    expect(terminal).toBeDefined();
    expect(execution.completed?.status).toBe("aborted");
  });

  it("activates one held replacement for an eligible pre-control failure", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const seen: TrialLaunch[] = [];
    const execution = await executeStudyRun(
      plan,
      (launch: TrialLaunch): Promise<TrialOutcome> => {
        seen.push(launch);
        const failedPrimary =
          launch.kind === "primary" &&
          launch.cell_id === "shape_a" &&
          launch.repetition_index === 0;
        if (failedPrimary) {
          return outcomeOf({
            disposition: "infrastructure_failed_pre_control",
            evidence_integrity: "intact",
            censor_class: "pre_control_nonparticipant"
          });
        }
        return outcomeOf({
          disposition: "completed",
          evidence_integrity: "intact"
        });
      },
      { clock: fixedClock() }
    );

    expect(seen).toHaveLength(5);
    const replacement = seen.find(
      (launch) => launch.kind === "held_replacement"
    );
    expect(replacement).toBeDefined();
    if (replacement === undefined) {
      return;
    }
    expect(replacement.replacement_target).not.toBeNull();
    expect(replacement.cell_id).toBe("shape_a");
    const completed = execution.completed;
    expect(completed?.counts.activated_replacements).toBe(1);
    expect(completed?.counts.held_unused).toBe(1);
    expect(completed?.status).toBe("completed");
  });

  it("never activates a replacement for an agent failure", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const seen: TrialLaunch[] = [];
    const execution = await executeStudyRun(
      plan,
      (launch: TrialLaunch): Promise<TrialOutcome> => {
        seen.push(launch);
        return outcomeOf({
          disposition: "agent_failed",
          evidence_integrity: "intact"
        });
      },
      { clock: fixedClock() }
    );
    expect(seen).toHaveLength(4);
    expect(
      execution.ledger.events.filter((event) => event.kind === "activated")
    ).toHaveLength(0);
    expect(execution.completed?.counts.held_unused).toBe(2);
  });

  it("applies the after-primary-schedule timing rule", async () => {
    const study = twoCellStudy({
      activation_timing: "after_primary_schedule"
    });
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const seen: TrialLaunch[] = [];
    const execution = await executeStudyRun(
      plan,
      (launch: TrialLaunch): Promise<TrialOutcome> => {
        seen.push(launch);
        if (
          launch.kind === "primary" &&
          launch.cell_id === "shape_b" &&
          launch.repetition_index === 1
        ) {
          return outcomeOf({
            disposition: "infrastructure_failed_pre_control",
            evidence_integrity: "intact",
            censor_class: "pre_control_nonparticipant"
          });
        }
        return outcomeOf({
          disposition: "completed",
          evidence_integrity: "intact"
        });
      },
      { clock: fixedClock() }
    );
    expect(seen).toHaveLength(5);
    const replacement = seen[4];
    expect(replacement?.kind).toBe("held_replacement");
    expect(seen.slice(0, 4).every((launch) => launch.kind === "primary")).toBe(
      true
    );
    expect(execution.completed?.counts.activated_replacements).toBe(1);
  });
});

describe("study completion derivation", () => {
  it("refuses a completion record while a primary is unsettled", () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const ledger = {
      study_run_id: TWO_CELL_RUN_ID,
      events: []
    };
    const result = deriveStudyCompleted({
      plan,
      ledger,
      finished_at: TWO_CELL_CREATED_AT,
      artifact_manifest_sha256: sha256Hex("manifest"),
      abort_reason: null
    });
    expect(result.completed).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      RunCode.CompletionPremature
    );
  });

  it("refuses a completion record with a malformed timestamp", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    const execution = await executeStudyRun(plan, cleanExecutor(), {
      clock: fixedClock()
    });
    const result = deriveStudyCompleted({
      plan,
      ledger: execution.ledger,
      finished_at: "2026-08-27 12:00:00",
      artifact_manifest_sha256: sha256Hex("manifest"),
      abort_reason: null
    });
    expect(result.completed).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      RunCode.ClockInvalid
    );
  });

  it("marks an aborted run from the ledger alone", async () => {
    const study = twoCellStudy();
    const planned = planStudyRun(planInputOf(study, PASSING_PREFLIGHT));
    const plan = planned.plan;
    if (plan === null) {
      throw new Error("Fixture plan must assemble.");
    }
    let calls = 0;
    const execution = await executeStudyRun(
      plan,
      (): Promise<TrialOutcome> => {
        calls += 1;
        if (calls === 2) {
          return outcomeOf({
            disposition: "operator_interrupted",
            evidence_integrity: "intact"
          });
        }
        return outcomeOf({ disposition: "completed" });
      },
      { clock: fixedClock() }
    );
    // Derive again with no caller-declared reason: the terminal facts of the
    // append-only ledger alone mark the StudyRun aborted.
    const derived = deriveStudyCompleted({
      plan,
      ledger: execution.ledger,
      finished_at: TWO_CELL_CREATED_AT,
      artifact_manifest_sha256: sha256Hex("manifest"),
      abort_reason: null
    });
    expect(derived.completed?.status).toBe("aborted");
    expect(derived.completed?.reason).toBe(AbortReason.OperatorInterrupted);
    expect(derived.diagnostics).toEqual([]);
  });
});

describe("fixture schedule", () => {
  it("holds one held slot per cell over two complete blocks", () => {
    const study = twoCellStudy();
    const schedule: AssignmentSchedule = study.schedule;
    const primaries = schedule.assignments.filter(
      (assignment) => assignment.kind === "primary"
    );
    const held = schedule.assignments.filter(
      (assignment) => assignment.kind === "held_replacement"
    );
    expect(primaries).toHaveLength(4);
    expect(held).toHaveLength(2);
    const blocks = new Set(primaries.map((assignment) => assignment.block_id));
    expect(blocks.size).toBe(2);
  });
});
