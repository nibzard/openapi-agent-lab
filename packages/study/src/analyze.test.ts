import { describe, expect, it } from "vitest";
import { SchemaValidator, sha256Hex } from "@oal/core";
import type { AssignmentLedger } from "@oal/scheduler";

import {
  AnalysisCode,
  analyzeStudyRun,
  serializeStudyAnalysis,
  studyAnalysisJson,
  studyAnalysisSha256,
  type CellEvidence,
  type StudyAnalysisInput
} from "./analyze.ts";
import {
  executeStudyRun,
  planStudyRun,
  type StudyRunPlan,
  type StudyRunPreflight,
  type TrialLaunch,
  type TrialOutcome
} from "./run.ts";
import {
  TWO_CELL_ANALYSIS_PLAN,
  TWO_CELL_CELLS,
  TWO_CELL_CREATED_AT,
  TWO_CELL_EVIDENCE_REQUIREMENTS,
  TWO_CELL_IMPLEMENTATION,
  TWO_CELL_PHASE_LOCK,
  TWO_CELL_PHASE_PLAN_SHA256,
  TWO_CELL_PROTOCOL_LOCK,
  TWO_CELL_RUN_ID,
  TWO_CELL_STUDY_COMPATIBILITY,
  loadSchema,
  studyTrial,
  twoCellStudy,
  type TwoCellStudy
} from "./fixtures.ts";
const analysisSchema = new SchemaValidator(
  loadSchema("study-analysis.v1.schema.json")
);

/** Fixed, strictly increasing millisecond clock. */
function fixedClock(): () => string {
  let tick = 0;
  return (): string => {
    tick += 1;
    return `2026-08-27T12:00:${(tick % 60).toString(10).padStart(2, "0")}.${(
      (tick * 11) %
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

const PASSING_PREFLIGHT: StudyRunPreflight = {
  ok: true,
  diagnostics: []
};

/** Resolve one terminal outcome, so literal unions stay narrow. */
function outcomeOf(outcome: TrialOutcome): Promise<TrialOutcome> {
  return Promise.resolve(outcome);
}

interface ExecutedStudy {
  readonly study: TwoCellStudy;
  readonly plan: StudyRunPlan;
  readonly ledger: AssignmentLedger;
  readonly launches: readonly TrialLaunch[];
  /** Assignments whose trials failed before participant control. */
  readonly failedAssignments: ReadonlySet<string>;
}

/**
 * Drive the two-cell study through the injected executor. The failure
 * selector names the assignments whose trials fail before participant
 * control with an infrastructural disposition the frozen policy replaces.
 */
async function executedStudy(
  options: {
    readonly activation_timing?:
      | "immediate_after_terminal"
      | "after_primary_schedule";
    readonly fail?: (launch: TrialLaunch) => boolean;
    readonly cleanCompletion?: (launch: TrialLaunch) => boolean;
  } = {}
): Promise<ExecutedStudy> {
  const study = twoCellStudy(
    options.activation_timing === undefined
      ? undefined
      : { activation_timing: options.activation_timing }
  );
  const planned = planStudyRun({
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
    preflight: PASSING_PREFLIGHT
  });
  const plan = planned.plan;
  if (plan === null) {
    throw new Error("Fixture plan must assemble.");
  }
  const failedAssignments = new Set<string>();
  const execution = await executeStudyRun(
    plan,
    (launch: TrialLaunch): Promise<TrialOutcome> => {
      if (options.fail?.(launch) === true) {
        failedAssignments.add(launch.assignment_id);
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
  return {
    study,
    plan,
    ledger: execution.ledger,
    launches: execution.launches,
    failedAssignments
  };
}

/** Build the frozen cell evidence of one executed study. */
function cellEvidenceOf(
  executed: ExecutedStudy,
  options: {
    readonly cleanCompletion?: (launch: TrialLaunch) => boolean;
    readonly driftCellKeyOf?: (cellId: string) => string | undefined;
  } = {}
): CellEvidence[] {
  return TWO_CELL_CELLS.map((cellId) => ({
    cell_id: cellId,
    analytical: true,
    study_compatibility_sha256: TWO_CELL_STUDY_COMPATIBILITY,
    cell_compatibility_sha256:
      options.driftCellKeyOf?.(cellId) ?? sha256Hex(`two cell key ${cellId}`),
    trials: executed.launches
      .filter((launch) => launch.cell_id === cellId)
      .map((launch) => {
        const failed = executed.failedAssignments.has(launch.assignment_id);
        return studyTrial({
          runId: launch.run_id,
          assignmentId: launch.assignment_id,
          replacementOf: launch.replacement_target,
          cleanCompletion:
            options.cleanCompletion?.(launch) === false ? "failed" : "passed",
          controlStarted: !failed,
          disposition: failed
            ? "infrastructure_failed_pre_control"
            : "completed"
        });
      })
  }));
}

function analysisInputOf(
  executed: ExecutedStudy,
  cells: readonly CellEvidence[],
  options?: {
    readonly verification?: {
      readonly artifact: string;
      readonly expected_sha256: string;
      readonly observed_sha256: string;
    }[];
  }
): StudyAnalysisInput {
  return {
    analysis_id: "two-cell-analysis-01",
    generated_at: TWO_CELL_CREATED_AT,
    lineage: { kind: "preregistered" },
    header: executed.plan.header,
    phasePlan: executed.study.phasePlan,
    metrics: executed.study.protocol.metrics.primary,
    schedule: executed.study.schedule,
    ledger: executed.ledger,
    cells,
    verification: options?.verification ?? [
      {
        artifact: "assignments.json",
        expected_sha256: executed.plan.header.assignment_schedule.sha256,
        observed_sha256: executed.plan.header.assignment_schedule.sha256
      }
    ],
    evidence_requirements_sha256: TWO_CELL_EVIDENCE_REQUIREMENTS
  };
}

describe("study analysis", () => {
  it("produces a schema-valid analysis over a clean two-cell run", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed);
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error(
        `Fixture analysis must build: ${JSON.stringify(result.diagnostics)}`
      );
    }
    expect(analysisSchema.errors(studyAnalysisJson(analysis))).toEqual([]);
    expect(analysis.study_run_id).toBe(TWO_CELL_RUN_ID);
    expect(analysis.populations).toEqual([
      { id: "clean_completion", numerator: 4, denominator: 4 }
    ]);
    expect(analysis.estimates).toHaveLength(1);
    const estimate = analysis.estimates[0];
    expect(estimate?.contrast_id).toBe("shape_a_minus_shape_b");
    expect(estimate?.estimate).toBe(0);
    expect(estimate?.cells.map((cell) => cell.cell_id)).toEqual([
      "shape_a",
      "shape_b"
    ]);
    expect(estimate?.p_value).toBe(1);
    expect(estimate?.adjusted_p_value).toBe(1);
    expect(estimate?.family_id).toBe("primary");
  });

  it("is byte-identical across two runs over the same frozen inputs", async () => {
    const executed = await executedStudy();
    const first = analyzeStudyRun(
      analysisInputOf(executed, cellEvidenceOf(executed))
    );
    const second = analyzeStudyRun(
      analysisInputOf(executed, cellEvidenceOf(executed))
    );
    const firstDoc = first.analysis;
    const secondDoc = second.analysis;
    if (firstDoc === null || secondDoc === null) {
      throw new Error("Fixture analyses must build.");
    }
    expect(serializeStudyAnalysis(firstDoc)).toBe(
      serializeStudyAnalysis(secondDoc)
    );
    expect(studyAnalysisSha256(firstDoc)).toBe(studyAnalysisSha256(secondDoc));
  });

  it("maps a replacement onto the failed primary slot", async () => {
    const executed = await executedStudy({
      fail: (launch) =>
        launch.kind === "primary" &&
        launch.cell_id === "shape_a" &&
        launch.repetition_index === 0
    });
    expect(executed.launches).toHaveLength(5);
    const replacement = executed.launches.find(
      (launch) => launch.kind === "held_replacement"
    );
    const failed = executed.launches.find(
      (launch) => launch.replacement_target !== null
    );
    expect(replacement).toBe(failed);

    // The failed original never reaches the evidence: the runner collects
    // only trials that launched, and the analyzer maps the replacement.
    const cells = cellEvidenceOf(executed);
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(analysis.populations).toEqual([
      { id: "clean_completion", numerator: 4, denominator: 4 }
    ]);
    const shapeA = result.slots.filter((slot) => slot.cell_id === "shape_a");
    expect(shapeA).toHaveLength(2);
    expect(shapeA.filter((slot) => slot.source === "replacement")).toHaveLength(
      1
    );
    expect(analysisSchema.errors(studyAnalysisJson(analysis))).toEqual([]);
  });

  it("refuses pooled estimates when a required block stays incomplete", async () => {
    const executed = await executedStudy();
    // Drop one primary trial from the collected evidence: its slot never
    // resolves, so the block it belongs to stays incomplete.
    const cells = cellEvidenceOf(executed).map((cell) => ({
      ...cell,
      trials: cell.cell_id === "shape_a" ? cell.trials.slice(0, 1) : cell.trials
    }));
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(analysisSchema.errors(studyAnalysisJson(analysis))).toEqual([]);
    expect(analysis.estimates).toEqual([]);
    expect(
      analysis.warnings.some((warning) =>
        warning.startsWith(AnalysisCode.BlockIncomplete)
      )
    ).toBe(true);
    expect(analysis.populations).toEqual([
      {
        id: "clean_completion",
        numerator: 3,
        denominator: 3,
        unresolved_slots: 1
      }
    ]);
  });

  it("excludes a drifted cell from pooling with a diagnostic", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed, {
      driftCellKeyOf: (cellId) =>
        cellId === "shape_b" ? sha256Hex("drifted cell key") : undefined
    });
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(result.excluded_cell_ids).toEqual(["shape_b"]);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "OAL-STUDY-COMPATIBILITY-CELL-KEY-MISMATCH"
    );
    expect(analysis.estimates).toEqual([]);
    expect(
      analysis.warnings.some((warning) =>
        warning.startsWith(AnalysisCode.ContrastCellsMissing)
      )
    ).toBe(true);
    // The excluded cell keeps no denominator entry.
    expect(analysis.populations).toEqual([
      { id: "clean_completion", numerator: 2, denominator: 2 }
    ]);
    expect(analysis.extensions["excluded_cell_ids"]).toEqual(["shape_b"]);
  });

  it("refuses the whole analysis when a frozen hash fails verification", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed);
    const result = analyzeStudyRun(
      analysisInputOf(executed, cells, {
        verification: [
          {
            artifact: "assignments.json",
            expected_sha256: executed.plan.header.assignment_schedule.sha256,
            observed_sha256: sha256Hex("tampered")
          }
        ]
      })
    );
    expect(result.analysis).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      AnalysisCode.HashVerificationFailed
    );
  });

  it("withholds a contrast whose cells have no resolved slot", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed, {
      cleanCompletion: (): boolean => false
    });
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(analysis.populations).toEqual([
      { id: "clean_completion", numerator: 0, denominator: 4 }
    ]);
    expect(analysis.estimates).toHaveLength(1);
    expect(analysis.estimates[0]?.estimate).toBe(0);
  });

  it("rejects a ledger from another StudyRun", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed);
    const result = analyzeStudyRun({
      ...analysisInputOf(executed, cells),
      ledger: { study_run_id: "other-study-run", events: [] }
    });
    expect(result.analysis).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      AnalysisCode.StudyRunMismatch
    );
  });

  it("keeps sensitivity bounded and directional in the warnings", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed);
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(analysis.sensitivity).toHaveLength(1);
    expect(analysis.sensitivity[0]?.id).toBe("worst_case_censor_failure");
    expect(analysis.sensitivity[0]?.estimates[0]?.estimate).toBe(0);
    expect(
      analysis.warnings.some((warning) => warning.includes("directional"))
    ).toBe(true);
  });
});
