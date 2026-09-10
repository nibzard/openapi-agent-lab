/**
 * Hand-built test fixtures for the review checks, derived from the
 * specification examples in sections 12.8 and 12.9 and from the schemas.
 * The two-cell study below models the run and analysis paths of sections
 * 12.11 through 12.14 and 27.
 */

import { readFileSync } from "node:fs";

import { parseJsonStrict, sha256Hex, type JsonObject } from "@oal/core";
import type {
  LifecycleEvent,
  LifecycleEventRecord,
  TerminalDisposition
} from "@oal/evidence";
import type {
  Evaluation,
  EvaluationCheckRecord,
  EvaluationStatus
} from "@oal/evaluator";
import type { TrialInput } from "@oal/report";
import {
  buildAssignmentSchedule,
  type AssignmentSchedule
} from "@oal/scheduler";
import {
  compileStudy,
  loadPhasePlan,
  loadProtocol,
  type PhasePlan,
  type StudyIR,
  type StudyProtocol
} from "@oal/study-ir";
import type { CellProtocolDigests } from "@oal/scheduler";

/** Reads one schema document from the repository schema directory. */
export function loadSchema(name: string): JsonObject {
  const url = new URL(`../../../schemas/${name}`, import.meta.url);
  return parseJsonStrict(readFileSync(url, "utf8")) as JsonObject;
}

export const PACK_DIGEST = sha256Hex("fixture pack bytes");

export const RUN_PROFILE_TEXT =
  "apiVersion: agentlab.dev/v1\nkind: RunProfile\n";
export const VARIANT_SET_TEXT =
  "apiVersion: agentlab.dev/v1\nkind: ContractVariantSet\n";
export const SURFACE_POLICY_TEXT =
  "apiVersion: agentlab.dev/v1\nkind: ParticipantSurfacePolicy\n";
export const SMOKE_PHASE_TEXT =
  "apiVersion: agentlab.dev/v1\nkind: PhasePlan\n";
export const PILOT_PHASE_TEXT =
  "apiVersion: agentlab.dev/v1\nkind: PhasePlan\npurpose: pilot\n";

/** A complete StudyProtocol document modeled on specification section 12.8. */
export function baseProtocolDoc(): JsonObject {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "StudyProtocol",
    metadata: {
      id: "prepared-workspace-api-v1",
      version: "1.0.0",
      title: "Prepared workspace API-shape study"
    },
    objective:
      "Compare equally capable API surfaces for one prepared-workspace task.",
    evaluation: {
      pack: { id: "workspace-service", version: "1.0.0", sha256: PACK_DIGEST },
      eval: "prepare-and-replicate",
      scenario: "baseline",
      contract_variant_set: "variants/api-shapes.yaml"
    },
    factors: [
      {
        id: "api_shape",
        role: "treatment",
        levels: [
          { id: "shape_a", contract_variant: "shape-a" },
          { id: "shape_b", contract_variant: "shape-b" }
        ]
      },
      {
        id: "documentation",
        role: "treatment",
        levels: [
          {
            id: "supplied",
            run_profile_patch: { "exposure.contract_visibility": "file" }
          },
          {
            id: "discoverable",
            run_profile_patch: {
              "exposure.contract_visibility": "discoverable",
              "exposure.documentation_profile": "openapi-conventional-v1"
            }
          },
          {
            id: "blind",
            run_profile_patch: { "exposure.contract_visibility": "none" }
          }
        ]
      }
    ],
    constants: {
      run_profile: "profiles/codex-high-raw-sequential.yaml",
      required_parallel: 1,
      data_plane_scope: "all",
      response_profile: "neutral-v1"
    },
    metrics: {
      primary: [
        {
          id: "clean_completion",
          type: "binary",
          source: { kind: "rubric_check", check_id: "clean_completion" }
        }
      ]
    },
    blinding: {
      mode: "strict",
      participant_surface_policy: "blinding/participant-surface.yaml",
      require_pairwise_surface_diff_review: true
    },
    phases: { smoke: "phases/smoke.yaml", pilot: "phases/pilot.yaml" },
    interpretation_limits: ["The study measures the declared end-to-end task."],
    extensions: {}
  };
}

/** Member bytes of the base protocol, keyed by protocol-root path. */
export function baseMembers(): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ["study.yaml", "{}"],
    ["profiles/codex-high-raw-sequential.yaml", RUN_PROFILE_TEXT],
    ["variants/api-shapes.yaml", VARIANT_SET_TEXT],
    ["blinding/participant-surface.yaml", SURFACE_POLICY_TEXT],
    ["phases/smoke.yaml", SMOKE_PHASE_TEXT],
    ["phases/pilot.yaml", PILOT_PHASE_TEXT]
  ]);
}

/** A complete analytical PhasePlan document over six cells. */
export function basePhasePlanDoc(): JsonObject {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "PhasePlan",
    metadata: { id: "pilot" },
    purpose: "pilot",
    analytical: true,
    design: {
      kind: "complete-balanced-blocks",
      primary_assignments: 12,
      explicit_seed_required: true,
      block: { cells: "all", repetitions: 2 },
      ordering: "canonical-sha256-sort-v1"
    },
    replacements: {
      kind: "held-same-cell",
      slots_per_cell: 1,
      activation_timing: "after_primary_schedule",
      activate_on: [{ disposition: "infrastructure_failed_pre_control" }],
      maximum_activated_per_cell: 1
    },
    runtime_lock: {
      required_fields: ["agent.adapter", "agent.model"]
    },
    eligibility: {
      primary_agent_outcome: {
        require: "participant_control_started"
      },
      api_behavior: {
        require: ["participant_control_started", "trace_intact"]
      }
    },
    stopping: {
      batch_wide_pre_control_failure: "abort",
      second_unreplaced_failure_in_cell: "incomplete",
      operator_interruption: "abort",
      data_dependent_success_stop: "forbidden"
    },
    analysis: {
      contrasts: [
        {
          id: "shape_a_minus_shape_b_within_discoverable",
          metric: "clean_completion",
          factor: "api_shape",
          levels: ["shape_a", "shape_b"],
          direction: "first_minus_second",
          within: { documentation: "discoverable" }
        }
      ],
      primary_estimand: {
        id: "clean_completion_risk_difference",
        outcome: "clean_completion",
        population: "primary_agent_outcome",
        contrast: "shape_a_minus_shape_b_within_discoverable",
        measure: "risk_difference"
      },
      comparison_families: [
        {
          id: "primary",
          contrasts: ["shape_a_minus_shape_b_within_discoverable"],
          alpha: 0.05,
          multiplicity: "holm"
        }
      ],
      methods: {
        binary_interval: "wilson",
        risk_difference_interval: "newcombe",
        exact_test: "fisher_two_sided"
      },
      sensitivity: {
        participant_control_started_censors_as_failure: true
      },
      marginal_weighting: "none",
      floor_ceiling: { apply_by_factor_level: null },
      small_sample_label: "directional"
    },
    paid_calls: { primary: 12, maximum_with_replacements: 18 }
  };
}

/** A non-analytical smoke PhasePlan. */
export function smokePhasePlanDoc(): JsonObject {
  const doc = basePhasePlanDoc();
  doc["metadata"] = { id: "smoke" };
  doc["purpose"] = "smoke";
  doc["analytical"] = false;
  doc["design"] = {
    kind: "complete-balanced-blocks",
    primary_assignments: 6,
    ordering: "canonical-sha256-sort-v1"
  };
  delete doc["replacements"];
  doc["paid_calls"] = { primary: 6, maximum_with_replacements: 6 };
  return doc;
}

/** A schema-valid approved BlindingReview over every base cell. */
export function baseBlindingReviewDoc(): JsonObject {
  return {
    schema_version: 1,
    kind: "BlindingReview",
    id: "surface-review-1",
    reviewed_at: "2026-08-27T12:00:00.000Z",
    reviewers: [{ name: "Ada Reviewer", role: "blinding" }],
    reviewed_surfaces: [
      "shape_a__blind",
      "shape_a__discoverable",
      "shape_a__supplied",
      "shape_b__blind",
      "shape_b__discoverable",
      "shape_b__supplied"
    ].map((cellId) => ({
      cell_id: cellId,
      manifest_sha256: sha256Hex(`surface ${cellId}`)
    })),
    cue_audit_sha256: sha256Hex("cue audit"),
    findings: [],
    approved: true,
    extensions: {}
  };
}

/** A schema-valid approved EquivalenceReview over both variants. */
export function baseEquivalenceReviewDoc(): JsonObject {
  return {
    schema_version: 1,
    kind: "EquivalenceReview",
    id: "equivalence-review-1",
    reviewed_at: "2026-08-27T12:00:00.000Z",
    reviewers: [
      { name: "Ada Reviewer", role: "contract" },
      { name: "Ben Reviewer", role: "contract" }
    ],
    reviewed: [
      { artifact: "effective/shape-a", sha256: sha256Hex("shape a") },
      { artifact: "effective/shape-b", sha256: sha256Hex("shape b") }
    ],
    findings: [],
    approved: true,
    extensions: {}
  };
}

export const TWO_CELL_RUN_ID = "two-cell-pilot-01";
export const TWO_CELL_COHORT_SEED = "two-cell-fixed-seed";
export const TWO_CELL_PROTOCOL_LOCK = sha256Hex("two cell protocol lock");
export const TWO_CELL_PHASE_PLAN_SHA256 = sha256Hex("two cell phase plan");
export const TWO_CELL_PHASE_LOCK = sha256Hex("two cell phase lock");
export const TWO_CELL_STUDY_COMPATIBILITY = sha256Hex("two cell study key");
export const TWO_CELL_IMPLEMENTATION = sha256Hex("two cell implementation");
export const TWO_CELL_ANALYSIS_PLAN = sha256Hex("two cell analysis plan");
export const TWO_CELL_EVIDENCE_REQUIREMENTS = sha256Hex(
  "two cell evidence requirements"
);
export const TWO_CELL_CREATED_AT = "2026-08-27T12:00:00.000Z";
export const T0 = "2026-08-27T12:00:00.000Z";
export const T1 = "2026-08-27T12:01:00.000Z";

/** Present cells of the two-cell study, in canonical cell-ID order. */
export const TWO_CELL_CELLS: readonly string[] = ["shape_a", "shape_b"];

/** A one-factor, two-level StudyProtocol for run and analysis tests. */
export function twoCellProtocolDoc(): JsonObject {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "StudyProtocol",
    metadata: {
      id: "two-cell-api-shape-v1",
      version: "1.0.0",
      title: "Two-cell API-shape study"
    },
    objective: "Compare two API shapes on one prepared-workspace task.",
    evaluation: {
      pack: { id: "workspace-service", version: "1.0.0", sha256: PACK_DIGEST },
      eval: "prepare-and-replicate",
      scenario: "baseline",
      contract_variant_set: "variants/api-shapes.yaml"
    },
    factors: [
      {
        id: "api_shape",
        role: "treatment",
        levels: [
          { id: "shape_a", contract_variant: "shape-a" },
          { id: "shape_b", contract_variant: "shape-b" }
        ]
      }
    ],
    constants: {
      run_profile: "profiles/codex-high-raw-sequential.yaml",
      required_parallel: 1,
      data_plane_scope: "all",
      response_profile: "neutral-v1"
    },
    metrics: {
      primary: [
        {
          id: "clean_completion",
          type: "binary",
          source: { kind: "rubric_check", check_id: "clean_completion" }
        }
      ]
    },
    blinding: {
      mode: "strict",
      participant_surface_policy: "blinding/participant-surface.yaml",
      require_pairwise_surface_diff_review: true
    },
    phases: { pilot: "phases/pilot.yaml" },
    interpretation_limits: ["The study measures the declared end-to-end task."],
    extensions: {}
  };
}

/** Member bytes of the two-cell protocol, keyed by protocol-root path. */
export function twoCellMembers(): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ["study.yaml", "{}"],
    ["profiles/codex-high-raw-sequential.yaml", RUN_PROFILE_TEXT],
    ["variants/api-shapes.yaml", VARIANT_SET_TEXT],
    ["blinding/participant-surface.yaml", SURFACE_POLICY_TEXT],
    ["phases/pilot.yaml", PILOT_PHASE_TEXT]
  ]);
}

/**
 * A four-primary analytical PhasePlan over two cells: two complete blocks
 * of one repetition each, plus one held slot per cell.
 */
export function twoCellPhasePlanDoc(options?: {
  readonly activation_timing?:
    | "immediate_after_terminal"
    | "after_primary_schedule";
  /** Adds a corrupt-evidence activation rule to the frozen policy. */
  readonly activateOnCorruptEvidence?: boolean;
  readonly direction?: "first_minus_second" | "second_minus_first";
}): JsonObject {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "PhasePlan",
    metadata: { id: "pilot" },
    purpose: "pilot",
    analytical: true,
    design: {
      kind: "complete-balanced-blocks",
      primary_assignments: 4,
      explicit_seed_required: true,
      block: { cells: "all", repetitions: 2 },
      ordering: "canonical-sha256-sort-v1"
    },
    replacements: {
      kind: "held-same-cell",
      slots_per_cell: 1,
      activation_timing:
        options?.activation_timing ?? "immediate_after_terminal",
      activate_on: options?.activateOnCorruptEvidence
        ? [{ evidence_integrity: ["corrupt"] }]
        : [{ disposition: "infrastructure_failed_pre_control" }],
      maximum_activated_per_cell: 1
    },
    runtime_lock: { required_fields: ["agent.adapter", "agent.model"] },
    eligibility: {
      primary_agent_outcome: {
        require: "participant_control_started"
      },
      api_behavior: {
        require: ["participant_control_started", "trace_intact"]
      }
    },
    stopping: {
      batch_wide_pre_control_failure: "abort",
      second_unreplaced_failure_in_cell: "incomplete",
      operator_interruption: "abort",
      data_dependent_success_stop: "forbidden"
    },
    analysis: {
      contrasts: [
        {
          id: "shape_a_minus_shape_b",
          metric: "clean_completion",
          factor: "api_shape",
          levels: ["shape_a", "shape_b"],
          direction: options?.direction ?? "first_minus_second"
        }
      ],
      primary_estimand: {
        id: "clean_completion_risk_difference",
        outcome: "clean_completion",
        population: "primary_agent_outcome",
        contrast: "shape_a_minus_shape_b",
        measure: "risk_difference"
      },
      comparison_families: [
        {
          id: "primary",
          contrasts: ["shape_a_minus_shape_b"],
          alpha: 0.05,
          multiplicity: "holm"
        }
      ],
      methods: {
        binary_interval: "wilson",
        risk_difference_interval: "newcombe",
        exact_test: "fisher_two_sided"
      },
      sensitivity: {
        participant_control_started_censors_as_failure: true
      },
      marginal_weighting: "none",
      floor_ceiling: { apply_by_factor_level: null },
      small_sample_label: "directional"
    },
    paid_calls: { primary: 4, maximum_with_replacements: 6 }
  };
}

export interface TwoCellStudy {
  readonly protocol: StudyProtocol;
  readonly phasePlan: PhasePlan;
  readonly ir: StudyIR;
  readonly schedule: AssignmentSchedule;
  readonly cellDigests: ReadonlyMap<string, CellProtocolDigests>;
}

/**
 * Load, compile, and schedule the two-cell study, or throw when the
 * fixture is broken. The schedule is the frozen `assignments.json`.
 */
export function twoCellStudy(options?: {
  readonly activation_timing?:
    | "immediate_after_terminal"
    | "after_primary_schedule";
  readonly activateOnCorruptEvidence?: boolean;
  readonly direction?: "first_minus_second" | "second_minus_first";
}): TwoCellStudy {
  const protocolResult = loadProtocol(twoCellProtocolDoc(), {
    schema: loadSchema("study-protocol.v1.schema.json")
  });
  const protocol = protocolResult.protocol;
  if (protocol === null) {
    throw new Error("Two-cell fixture protocol must load.");
  }
  const phaseResult = loadPhasePlan(twoCellPhasePlanDoc(options), {
    schema: loadSchema("phase-plan.v1.schema.json"),
    protocol,
    cellCount: TWO_CELL_CELLS.length
  });
  const phasePlan = phaseResult.phasePlan;
  if (phasePlan === null) {
    throw new Error("Two-cell fixture phase plan must load.");
  }
  const compiled = compileStudy(protocol, {
    schema: loadSchema("study-ir.v1.schema.json"),
    members: twoCellMembers()
  });
  const ir = compiled.ir;
  if (ir === null) {
    throw new Error("Two-cell fixture study must compile.");
  }
  const cellDigests = new Map(
    TWO_CELL_CELLS.map((cellId) => [
      cellId,
      {
        participant_surface_policy_sha256: sha256Hex(`surface ${cellId}`),
        eval_sha256: sha256Hex(`eval ${cellId}`),
        scenario_sha256: sha256Hex(`scenario ${cellId}`),
        rubric_sha256: sha256Hex(`rubric ${cellId}`),
        run_profile_template_sha256: sha256Hex(`run profile ${cellId}`)
      }
    ])
  );
  const scheduled = buildAssignmentSchedule({
    study_run_id: TWO_CELL_RUN_ID,
    ir,
    phasePlan,
    protocol_lock_sha256: TWO_CELL_PROTOCOL_LOCK,
    phase_plan_sha256: TWO_CELL_PHASE_PLAN_SHA256,
    schedule_seed: TWO_CELL_COHORT_SEED,
    effective_contracts: {
      "shape-a": sha256Hex("two cell shape a"),
      "shape-b": sha256Hex("two cell shape b")
    },
    cell_digests: cellDigests
  });
  if (scheduled.schedule === null) {
    throw new Error("Two-cell fixture schedule must build.");
  }
  return { protocol, phasePlan, ir, schedule: scheduled.schedule, cellDigests };
}

interface StudyEnvelope {
  readonly runId: string;
  readonly sequence: number;
}

function stageRecord(
  envelope: StudyEnvelope,
  stage:
    | "workspace_prepared"
    | "participant_spawned"
    | "participant_control_started"
    | "api_started"
    | "turn_completed"
    | "report_present"
    | "report_valid"
    | "finalization_started"
): LifecycleEventRecord<"lifecycle.stage"> {
  return {
    schema_version: 1,
    type: "lifecycle.stage",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: T0,
    batch_id: null,
    run_id: envelope.runId,
    payload: {
      stage,
      recorded_at: T0,
      evidence_source: "runner",
      details: {}
    }
  };
}

function runStartedEvent(
  envelope: StudyEnvelope
): LifecycleEventRecord<"run.started"> {
  return {
    schema_version: 1,
    type: "run.started",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: T0,
    batch_id: null,
    run_id: envelope.runId,
    payload: { started_at: T0, adapter: "codex", model: "test-model" }
  };
}

function runFinishedEvent(
  envelope: StudyEnvelope,
  disposition: TerminalDisposition,
  integrity: "intact" | "corrupt" | "missing"
): LifecycleEventRecord<"run.finished"> {
  return {
    schema_version: 1,
    type: "run.finished",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: T1,
    batch_id: null,
    run_id: envelope.runId,
    payload: {
      disposition,
      evidence_integrity: integrity,
      duration_ms: 240000
    }
  };
}

export interface StudyEvaluationOptions {
  readonly runId: string;
  readonly status?: EvaluationStatus;
  readonly cleanCompletion?: "passed" | "failed";
}

function cleanCheck(status: "passed" | "failed"): EvaluationCheckRecord {
  return { id: "clean_completion", status, weight: 1, required: true };
}

/** One evaluation whose single check is the fixture metric. */
export function studyEvaluation(options: StudyEvaluationOptions): Evaluation {
  const status = options.status ?? "passed";
  return {
    schema_version: 1,
    rubric_id: "prepare-and-replicate",
    run_id: options.runId,
    status,
    score: status === "passed" ? 1 : 0,
    passed_weight: status === "passed" ? 1 : 0,
    total_weight: 1,
    checks: [cleanCheck(options.cleanCompletion ?? "passed")],
    signals: {},
    infrastructure_errors: []
  };
}

export interface StudyTrialOptions {
  readonly runId: string;
  readonly assignmentId: string | null;
  readonly replacementOf?: string | null | undefined;
  readonly cleanCompletion?: "passed" | "failed";
  readonly disposition?: TerminalDisposition;
  readonly integrity?: "intact" | "corrupt" | "missing";
  readonly controlStarted?: boolean;
}

/**
 * One trial of the two-cell study. The default is a clean, eligible,
 * passing trial; the options degrade it into the failure modes of the
 * section 27.2 replacement table.
 */
export function studyTrial(options: StudyTrialOptions): TrialInput {
  const runId = options.runId;
  const controlStarted = options.controlStarted ?? true;
  const disposition = options.disposition ?? "completed";
  const integrity = options.integrity ?? "intact";
  const events: LifecycleEvent[] = [
    runStartedEvent({ runId, sequence: 1 }),
    stageRecord({ runId, sequence: 2 }, "workspace_prepared"),
    ...(controlStarted
      ? [
          stageRecord({ runId, sequence: 3 }, "participant_spawned"),
          stageRecord({ runId, sequence: 4 }, "participant_control_started"),
          stageRecord({ runId, sequence: 5 }, "api_started"),
          stageRecord({ runId, sequence: 6 }, "turn_completed"),
          runFinishedEvent({ runId, sequence: 7 }, disposition, integrity)
        ]
      : [runFinishedEvent({ runId, sequence: 3 }, disposition, integrity)])
  ];
  const eligible = controlStarted && integrity === "intact";
  return {
    run_id: runId,
    evidence_uri: `batches/two/${runId}/evidence`,
    eval_id: "prepare-and-replicate",
    assignment_id: options.assignmentId,
    replacement_of: options.replacementOf ?? null,
    events,
    trace: [],
    evaluation: eligible
      ? studyEvaluation({
          runId,
          cleanCompletion: options.cleanCompletion ?? "passed"
        })
      : null
  };
}
