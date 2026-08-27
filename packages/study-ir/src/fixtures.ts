/**
 * Hand-built test fixtures derived from the specification examples in
 * sections 12.8 and 12.9 and from the JSON schemas. Tests never derive
 * expected values from the implementation under test.
 */

import { readFileSync } from "node:fs";

import { parseJsonStrict, sha256Hex, type JsonObject } from "@oal/core";

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
      pack: {
        id: "workspace-service",
        version: "1.0.0",
        sha256: PACK_DIGEST
      },
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
      ],
      secondary: [
        {
          id: "request_count",
          type: "integer",
          source: {
            kind: "trace_aggregate",
            aggregate: "participant_api_request_count"
          }
        }
      ]
    },
    blinding: {
      mode: "strict",
      participant_surface_policy: "blinding/participant-surface.yaml",
      require_pairwise_surface_diff_review: true
    },
    phases: {
      smoke: "phases/smoke.yaml",
      pilot: "phases/pilot.yaml"
    },
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

/** A complete PhasePlan document modeled on specification section 12.9. */
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
      required_fields: [
        "agent.adapter",
        "agent.model",
        "execution.timeout_ms",
        "limits.max_api_requests"
      ]
    },
    eligibility: {
      primary_agent_outcome: {
        require: "participant_control_started",
        exclude: [{ censor_class: "administrative_censor" }]
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
      floor_ceiling: { apply_by_factor_level: "documentation" },
      small_sample_label: "directional"
    },
    paid_calls: { primary: 12, maximum_with_replacements: 18 }
  };
}

/** A schema-valid BlindingReview over every base cell. */
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
