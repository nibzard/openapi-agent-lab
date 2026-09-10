import { describe, expect, it } from "vitest";
import { SchemaValidator, sha256Hex, type JsonObject } from "@oal/core";
import type { AssignmentLedger } from "@oal/scheduler";
import { loadPhasePlan } from "@oal/study-ir";

import {
  AnalysisCode,
  analyzeStudyRun,
  serializeStudyAnalysis,
  STUDY_ANALYZER_IDENTITY,
  studyAnalysisJson,
  studyAnalysisSha256,
  type CellEvidence,
  type StudyAnalysisInput
} from "./analyze.ts";
import { SupportCode } from "./support.ts";
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
  twoCellPhasePlanDoc,
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
  /** Assignments whose trials were censored after participant control. */
  readonly censoredAssignments: ReadonlySet<string>;
}

/**
 * Drive the two-cell study through the injected executor. The failure
 * selector names the assignments whose trials fail before participant
 * control with an infrastructural disposition the frozen policy replaces.
 * The post-control selector names the assignments whose trials fail
 * after participant control with corrupt evidence.
 */
async function executedStudy(
  options: {
    readonly activation_timing?:
      | "immediate_after_terminal"
      | "after_primary_schedule";
    readonly activateOnCorruptEvidence?: boolean;
    readonly direction?: "first_minus_second" | "second_minus_first";
    readonly fail?: (launch: TrialLaunch) => boolean;
    readonly postControlCensor?: (launch: TrialLaunch) => boolean;
    readonly cleanCompletion?: (launch: TrialLaunch) => boolean;
  } = {}
): Promise<ExecutedStudy> {
  const study = twoCellStudy({
    ...(options.activation_timing === undefined
      ? {}
      : { activation_timing: options.activation_timing }),
    ...(options.activateOnCorruptEvidence === undefined
      ? {}
      : { activateOnCorruptEvidence: options.activateOnCorruptEvidence }),
    ...(options.direction === undefined ? {} : { direction: options.direction })
  });
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
  const censoredAssignments = new Set<string>();
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
      if (options.postControlCensor?.(launch) === true) {
        censoredAssignments.add(launch.assignment_id);
        return outcomeOf({
          disposition: "infrastructure_failed_post_control",
          evidence_integrity: "corrupt",
          censor_class: "instrumentation_censor"
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
    failedAssignments,
    censoredAssignments
  };
}

/** Build the frozen cell evidence of one executed study. */
function cellEvidenceOf(
  executed: ExecutedStudy,
  options: {
    readonly cleanCompletion?: (launch: TrialLaunch) => boolean;
    readonly driftCellKeyOf?: (cellId: string) => string | undefined;
    /**
     * Marks extra trials whose evidence the runner lost after
     * participant control, beyond what the launcher recorded.
     */
    readonly postControlCensorOf?: (launch: TrialLaunch) => boolean;
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
        const censored =
          executed.censoredAssignments.has(launch.assignment_id) ||
          options.postControlCensorOf?.(launch) === true;
        return studyTrial({
          runId: launch.run_id,
          assignmentId: launch.assignment_id,
          replacementOf: launch.replacement_target,
          cleanCompletion:
            options.cleanCompletion?.(launch) === false ? "failed" : "passed",
          controlStarted: !failed,
          disposition: failed
            ? "infrastructure_failed_pre_control"
            : censored
              ? "infrastructure_failed_post_control"
              : "completed",
          ...(censored ? { integrity: "corrupt" as const } : {})
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
    // The document names its executing analyzer by digest.
    expect(analysis.inputs.analyzer_sha256).toBe(
      sha256Hex(STUDY_ANALYZER_IDENTITY)
    );
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
    // The refused main estimate does not erase the estimable sensitivity:
    // shape_a = 1/1 and shape_b = 2/2 from the resolved slots alone.
    expect(analysis.sensitivity).toHaveLength(1);
    expect(analysis.sensitivity[0]?.estimates).toEqual([
      { contrast_id: "shape_a_minus_shape_b", estimate: 0 }
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
    // The excluded level cell withholds the worst-case difference too,
    // with the reason recorded in the warnings.
    expect(analysis.sensitivity).toEqual([]);
    expect(
      analysis.warnings.some((warning) =>
        warning.startsWith(AnalysisCode.SensitivityWithheld)
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

  it("refuses a risk ratio plan and never substitutes a difference", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed);
    const document = twoCellPhasePlanDoc();
    const estimand = (document["analysis"] as JsonObject)[
      "primary_estimand"
    ] as JsonObject;
    estimand["measure"] = "risk_ratio";
    const loaded = loadPhasePlan(document, {
      schema: loadSchema("phase-plan.v1.schema.json"),
      protocol: executed.study.protocol,
      cellCount: TWO_CELL_CELLS.length
    }).phasePlan;
    if (loaded === null) {
      throw new Error("Risk ratio fixture plan must load.");
    }
    const result = analyzeStudyRun({
      ...analysisInputOf(executed, cells),
      phasePlan: loaded
    });
    // No analysis document exists at all, so no difference estimate can
    // appear under a plan that requested a risk ratio.
    expect(result.analysis).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      SupportCode.MeasureUnsupported
    );
    expect(
      result.diagnostics.find(
        (entry) => entry.code === SupportCode.MeasureUnsupported
      )?.message
    ).toContain("risk_ratio");
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

describe("worst-case sensitivity (one outcome per slot)", () => {
  /** The -0.5 fixture: one censored original, one passing replacement. */
  async function censoredOriginalStudy(
    direction?: "first_minus_second" | "second_minus_first"
  ) {
    const executed = await executedStudy({
      activateOnCorruptEvidence: true,
      ...(direction === undefined ? {} : { direction }),
      postControlCensor: (launch) =>
        launch.kind === "primary" &&
        launch.cell_id === "shape_a" &&
        launch.repetition_index === 0
    });
    // The frozen policy activated one held slot for the corrupt
    // original, so five trials launched: four primaries plus one
    // replacement.
    expect(executed.launches).toHaveLength(5);
    const replacement = executed.launches.find(
      (launch) => launch.kind === "held_replacement"
    );
    expect(replacement?.replacement_target).not.toBeNull();
    const result = analyzeStudyRun(
      analysisInputOf(executed, cellEvidenceOf(executed))
    );
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error(
        `Fixture analysis must build: ${JSON.stringify(result.diagnostics)}`
      );
    }
    return { executed, result, analysis };
  }

  it("scores a censored original with a passing replacement as -0.5", async () => {
    const { executed, result, analysis } = await censoredOriginalStudy();

    // Hand-derived slot table. The schedule holds six assignments
    // (four primaries plus one held reserve per cell); the unused
    // reserve of shape_b never ran, so it contributes no slot.
    expect(executed.study.schedule.assignments).toHaveLength(6);
    expect(result.slots).toHaveLength(4);
    //   shape_a rep0: original censored post control, replacement
    //                passed -> resolved, one worst-case failure
    //   shape_a rep1: resolved, passed, clean chain -> one success
    //   shape_b rep0: resolved, passed -> one success
    //   shape_b rep1: resolved, passed -> one success
    const shapeA = result.slots.filter((slot) => slot.cell_id === "shape_a");
    expect(shapeA).toHaveLength(2);
    expect(shapeA.filter((slot) => slot.worst_case_failure)).toHaveLength(1);
    expect(shapeA.filter((slot) => slot.resolved)).toHaveLength(2);
    expect(new Set(result.slots.map((slot) => slot.slot_id)).size).toBe(4);

    // Main estimates use the eligible outcome of each resolved slot:
    // shape_a 2/2, shape_b 2/2, difference 0.
    expect(analysis.populations).toEqual([
      { id: "clean_completion", numerator: 4, denominator: 4 }
    ]);
    expect(analysis.estimates[0]?.estimate).toBe(0);

    // Worst case, per the shared slot tally:
    //   shape_a = 1 success / (1 success + 1 forced failure) = 1/2
    //   shape_b = 2 successes / 2 = 1
    //   direction first_minus_second: 1/2 - 1 = -0.5.
    expect(analysis.sensitivity).toHaveLength(1);
    const entry = analysis.sensitivity[0];
    expect(entry?.id).toBe("worst_case_censor_failure");
    expect(entry?.estimates).toEqual([
      { contrast_id: "shape_a_minus_shape_b", estimate: -0.5 }
    ]);
  });

  it("flips the worst-case sign with the contrast direction", async () => {
    const { analysis } = await censoredOriginalStudy("second_minus_first");
    expect(analysis.sensitivity[0]?.estimates).toEqual([
      { contrast_id: "shape_a_minus_shape_b", estimate: 0.5 }
    ]);
  });

  it("keeps a censored replacement unresolved without inventing a failure", async () => {
    const executed = await executedStudy();
    // shape_a rep0 holds only a post-control censored trial: no
    // replacement ran, so the slot never resolves.
    const cells = cellEvidenceOf(executed, {
      postControlCensorOf: (launch) =>
        launch.kind === "primary" &&
        launch.cell_id === "shape_a" &&
        launch.repetition_index === 0
    });
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    const censored = result.slots.find((slot) => slot.worst_case_failure);
    expect(censored?.resolved).toBe(false);
    // The unresolved censored slot joins no worst-case denominator:
    // shape_a = 1/1, shape_b = 2/2, difference 0. Counting the
    // unresolved censor as a failure would give 1/2 - 1 = -0.5.
    expect(analysis.populations).toEqual([
      {
        id: "clean_completion",
        numerator: 3,
        denominator: 3,
        unresolved_slots: 1
      }
    ]);
    expect(analysis.sensitivity[0]?.estimates).toEqual([
      { contrast_id: "shape_a_minus_shape_b", estimate: 0 }
    ]);
  });

  it("invents no failure for a chain of pre-control failures only", async () => {
    const executed = await executedStudy({
      fail: (launch) =>
        launch.kind === "primary" &&
        launch.cell_id === "shape_a" &&
        launch.repetition_index === 0
    });
    // The replacement never reported evidence, so the slot holds only
    // its pre-control failed original.
    const cells = cellEvidenceOf(executed).map((cell) => ({
      ...cell,
      trials: cell.trials.filter((trial) => trial.replacement_of === null)
    }));
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    const unresolved = result.slots.find((slot) => !slot.resolved);
    expect(unresolved?.worst_case_failure).toBe(false);
    expect(analysis.populations).toEqual([
      {
        id: "clean_completion",
        numerator: 3,
        denominator: 3,
        unresolved_slots: 1
      }
    ]);
    expect(analysis.sensitivity[0]?.estimates).toEqual([
      { contrast_id: "shape_a_minus_shape_b", estimate: 0 }
    ]);
  });

  it("withholds sensitivity with a reason when a side resolves no slot", async () => {
    const executed = await executedStudy();
    const cells = cellEvidenceOf(executed).map((cell) =>
      cell.cell_id === "shape_b" ? { ...cell, trials: [] } : cell
    );
    const result = analyzeStudyRun(analysisInputOf(executed, cells));
    const analysis = result.analysis;
    if (analysis === null) {
      throw new Error("Fixture analysis must build.");
    }
    expect(analysis.sensitivity).toEqual([]);
    expect(
      analysis.warnings.some((warning) =>
        warning.startsWith(AnalysisCode.SensitivityWithheld)
      )
    ).toBe(true);
    expect(analysis.estimates).toEqual([]);
    // The empty side also refuses the main estimate: its promised
    // primaries never resolved, so the block stays incomplete.
    expect(
      analysis.warnings.some((warning) =>
        warning.startsWith(AnalysisCode.BlockIncomplete)
      )
    ).toBe(true);
  });
});
