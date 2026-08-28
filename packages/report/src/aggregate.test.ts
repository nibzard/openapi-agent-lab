import { describe, expect, it } from "vitest";

import { canonicalJson, type Json } from "@oal/core";

import {
  buildReport,
  buildTrialFacts,
  censorClassFor,
  reportSha256,
  reportStagesFor,
  resolveSlots,
  taskOutcomeFor,
  usageDistribution,
  type TrialInput
} from "./aggregate.ts";
import {
  CANARY_SECRET,
  completedRunEvents,
  evaluation,
  checkRecord,
  postControlFailureEvents,
  preControlFailureEvents,
  scenarioReport,
  scenarioTrials,
  SHA_A,
  traceEvent,
  traceError
} from "./fixtures.ts";

describe("censor classes (section 27.2)", () => {
  it("classifies the four censor classes", () => {
    expect(censorClassFor("completed", true, "intact")).toBe("none");
    expect(censorClassFor("operator_interrupted", true, "intact")).toBe(
      "administrative_censor"
    );
    expect(censorClassFor("completed", true, "corrupt")).toBe(
      "instrumentation_censor"
    );
    expect(
      censorClassFor("infrastructure_failed_post_control", true, "intact")
    ).toBe("instrumentation_censor");
    expect(censorClassFor("provider_failed_pre_control", false, "intact")).toBe(
      "pre_control_nonparticipant"
    );
    expect(censorClassFor("operator_interrupted", false, "intact")).toBe(
      "pre_control_nonparticipant"
    );
  });
});

describe("task outcomes (section 27.1)", () => {
  it("never collapses the outcome axes", () => {
    expect(taskOutcomeFor(null)).toBe("not_evaluated");
    expect(taskOutcomeFor(evaluation({ status: "passed", score: 1 }))).toBe(
      "passed"
    );
    expect(taskOutcomeFor(evaluation({ status: "failed", score: 0 }))).toBe(
      "failed"
    );
    expect(taskOutcomeFor(evaluation({ status: "failed", score: 0.5 }))).toBe(
      "partial"
    );
    expect(taskOutcomeFor(evaluation({ status: "error", score: 0 }))).toBe(
      "indeterminate"
    );
    expect(taskOutcomeFor(evaluation({ status: "skipped", score: 0 }))).toBe(
      "not_evaluated"
    );
  });
});

describe("report stages", () => {
  it("maps lifecycle evidence onto the report vocabulary", () => {
    const events = completedRunEvents("run-1", true);
    expect(reportStagesFor(events)).toEqual([
      "scheduled",
      "workspace_prepared",
      "server_ready",
      "participant_spawned",
      "participant_active",
      "finalizing",
      "evaluated",
      "finalized"
    ]);
  });
});

describe("aggregation on a hand-built evidence stream", () => {
  const report = scenarioReport();

  it("counts attempts and slots separately", () => {
    expect(report.counts.primary_assignments).toBe(3);
    expect(report.counts.activated_replacements).toBe(1);
    expect(report.counts.operational_assignments).toBe(4);
    expect(report.counts.launched_trials).toBe(4);
    expect(report.counts.not_started).toBe(0);
    expect(report.counts.dispositions).toEqual({
      completed: 2,
      infrastructure_failed_post_control: 1,
      provider_failed_pre_control: 1
    });
    expect(report.counts.evidence_integrity).toEqual({
      intact: 3,
      corrupt: 1,
      missing: 0
    });
    expect(report.counts.censor_classes).toEqual({
      none: 2,
      pre_control_nonparticipant: 1,
      administrative_censor: 0,
      instrumentation_censor: 1
    });
    expect(report.counts.task_outcomes).toEqual({
      passed: 2,
      failed: 0,
      partial: 0,
      indeterminate: 0,
      not_evaluated: 0
    });
  });

  it("emits every required denominator of section 27.3", () => {
    expect(report.extensions["denominators"]).toEqual({
      primary_assignment_count: 3,
      activated_replacement_count: 1,
      operational_assignment_count: 4,
      launched_trial_count: 4,
      not_started_count: 0,
      participant_control_started_count: 3,
      primary_agent_outcome_count: 2,
      api_behavior_count: 2,
      task_evaluation_count: 2,
      report_agreement_count: 2,
      usage_observed_count: 4,
      valid_evaluation_count: 2,
      held_unused_count: 0
    });
  });

  it("resolves slots with substitution lineage and outcome source", () => {
    const slots = report.extensions["slot_resolution"];
    expect(slots).toEqual([
      {
        slot_id: "asg_000000000000000000000001",
        attempt_run_ids: ["run-1"],
        resolved: true,
        source: "primary",
        supplying_run_id: "run-1",
        task_outcome: "passed",
        worst_case_failure: false
      },
      {
        slot_id: "asg_000000000000000000000002",
        attempt_run_ids: ["run-2", "run-2b"],
        resolved: true,
        source: "replacement",
        supplying_run_id: "run-2b",
        task_outcome: "passed",
        worst_case_failure: true
      },
      {
        slot_id: "asg_000000000000000000000003",
        attempt_run_ids: ["run-3"],
        resolved: false,
        source: null,
        supplying_run_id: null,
        task_outcome: null,
        worst_case_failure: false
      }
    ]);
  });

  it("rolls up rubric criteria with availability and reasons", () => {
    const recovery = report.metrics.find(
      (metric) => metric.id === "recovery_flow"
    );
    expect(recovery?.numerator).toBe(2);
    expect(recovery?.denominator).toBe(2);
    expect(recovery?.availability).toEqual({
      observed: 2,
      unknown: 1,
      not_applicable: 0,
      unavailable_due_to_evidence: 1
    });
    expect(recovery?.reasons).toEqual([
      "evaluation_missing=1",
      "evidence_corrupt=1"
    ]);
    expect(recovery?.per_run?.map((link) => link.run_id)).toEqual([
      "run-1",
      "run-2",
      "run-2b",
      "run-3"
    ]);
    const signal = report.metrics.find(
      (metric) => metric.id === "clean_bytes_restored"
    );
    expect(signal?.numerator).toBe(2);
    expect(signal?.denominator).toBe(2);
  });

  it("keeps the primary estimand slot-based", () => {
    const taskPass = report.metrics.find((metric) => metric.id === "task_pass");
    expect(taskPass?.numerator).toBe(2);
    expect(taskPass?.denominator).toBe(2);
    expect(taskPass?.availability.unknown).toBe(1);
    const reportValid = report.metrics.find(
      (metric) => metric.id === "report_valid"
    );
    expect(reportValid?.numerator).toBe(2);
    expect(reportValid?.denominator).toBe(2);
    expect(report.surfaces.participant_reports.agreement).toBe(1);
    expect(report.surfaces.participant_reports.valid).toBe(2);
  });

  it("computes the worst-case sensitivity from censor bounds", () => {
    expect(report.estimates).toHaveLength(1);
    const estimate = report.estimates[0];
    expect(estimate?.contrast_id).toBe("task_pass");
    // Two resolved slots, both passed, so the main rate is 1.
    expect(estimate?.estimate).toBe(1);
    // Worst case: the censored original counts as one failure, so
    // 2 / (2 + 0 + 1) = 2/3.
    const sensitivity = estimate?.sensitivity[0];
    expect(sensitivity?.kind).toBe("worst_case_sensitivity");
    expect(sensitivity?.estimate).toBeCloseTo(2 / 3, 12);
  });

  it("aggregates API behavior without pooling smoke traffic", () => {
    expect(report.behavior.api.request_total).toBe(6);
    expect(report.behavior.api.status_distribution).toEqual({
      "200": 3,
      "201": 1,
      "500": 1
    });
    expect(report.behavior.api.operation_frequency).toEqual({
      createComputer: 2,
      getComputer: 1,
      listWidgets: 2
    });
    expect(report.behavior.api.unknown_endpoints).toBe(1);
    expect(report.behavior.api.invalid_transitions).toBe(1);
    expect(report.extensions["smoke_request_total"]).toBe(1);
    expect(report.extensions["documentation_smoke_request_total"]).toBe(1);
  });

  it("aggregates documentation and semantic behavior", () => {
    // Participant-actor documentation exchanges: two in run-1, one in
    // run-2, one in run-2b. The control probe stays out of this total.
    expect(report.behavior.documentation.request_total).toBe(4);
    expect(report.behavior.documentation.outcome_distribution).toEqual({
      contract_served: 1,
      index_served: 2,
      rejected_authentication: 1
    });
    expect(
      report.behavior.documentation.probe_chronology?.map((probe) => [
        probe.run_id,
        probe.sequence,
        probe.route_id
      ])
    ).toEqual([
      ["run-1", 1, "index"],
      ["run-1", 2, "openapi"],
      ["run-2", 1, "index"],
      ["run-2b", 1, "index"]
    ]);
    expect(report.behavior.semantic?.facts).toEqual({
      "computer.created": 2,
      "computer.patched": 1
    });
    expect(report.behavior.semantic?.sequence_variants).toHaveLength(3);
  });

  it("summarizes usage with observed values only", () => {
    expect(report.behavior.usage?.available).toBe(true);
    expect(report.behavior.usage?.tokens?.counts).toEqual([1000, 2000]);
    expect(report.behavior.usage?.tokens?.median).toBe(1500);
    expect(report.behavior.usage?.tokens?.mean).toBe(1500);
    expect(report.behavior.usage?.tokens?.p95).toBeUndefined();
    expect(report.behavior.usage?.duration_ms?.counts).toEqual([
      10000, 60000, 240000, 240000
    ]);
    expect(report.behavior.usage?.duration_ms?.median).toBe(150000);
    expect(report.behavior.usage?.duration_ms?.mean).toBe(137500);
    expect(report.extensions["usage_missing"]).toEqual({
      duration_ms: 0,
      provider_cost: 2,
      requests: 1,
      tokens: 2,
      tool_calls: 2
    });
  });

  it("reports integrity and unresolved-slot warnings", () => {
    const corrupt = report.warnings.find(
      (entry) => entry.kind === "corrupt_evidence"
    );
    expect(corrupt?.run_id).toBe("run-2");
    expect(corrupt?.message).toContain("digest_mismatch");
    const unresolved = report.warnings.find((entry) =>
      entry.message.includes("unresolved")
    );
    expect(unresolved?.message).toBe("1 primary analysis slot(s) unresolved");
    expect(
      report.warnings.find((entry) =>
        entry.message.includes("environment name")
      )
    ).toBeDefined();
  });

  it("drops environment names outside the schema pattern", () => {
    expect(report.provenance.environment_names).toEqual(["OAL_SANDBOX"]);
    expect(report.provenance.implementation["statistics"]).toBe("b".repeat(64));
    expect(report.provenance.implementation["report_builder"]).toMatch(
      /^[0-f]{64}$/
    );
  });
});

describe("determinism", () => {
  it("produces byte-identical canonical JSON from shuffled trials", () => {
    const first = scenarioReport();
    const trials = [...scenarioTrials()].reverse();
    const second = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials,
      provenance: {
        cells: [
          {
            cell_id: "cell-a",
            factor_levels: { model: "test-model" },
            compatibility_sha256: SHA_A,
            intended_factors: ["model"]
          }
        ],
        implementation: { statistics: "b".repeat(64) },
        environment_names: ["OAL_SANDBOX", "invalid-name!"]
      },
      redaction: {
        hmacKey: new Uint8Array(32).fill(1),
        secrets: [CANARY_SECRET]
      }
    });
    expect(canonicalJson(second as unknown as Json)).toBe(
      canonicalJson(first as unknown as Json)
    );
    expect(reportSha256(second)).toBe(reportSha256(first));
  });

  it("treats trial input mutation as a different report", () => {
    const trials = scenarioTrials();
    const base = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials
    });
    const mutated = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials: [...trials, trials[0] as TrialInput]
    });
    expect(reportSha256(mutated)).not.toBe(reportSha256(base));
  });
});

describe("not-started and held-slot accounting", () => {
  it("derives not-started primaries from the schedule override", () => {
    const trials = scenarioTrials().slice(0, 1);
    const report = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials,
      assignment_totals: {
        primary_assignments: 5,
        activated_replacements: 1,
        held_unused: 2,
        not_started: 4
      }
    });
    expect(report.counts.primary_assignments).toBe(5);
    expect(report.counts.operational_assignments).toBe(6);
    expect(report.counts.held_unused).toBe(2);
    expect(report.counts.not_started).toBe(4);
    expect(report.counts.replacements).toEqual({
      activated: 1,
      held_unused: 2
    });
    const denominators = report.extensions["denominators"] as Record<
      string,
      number
    >;
    expect(denominators["held_unused_count"]).toBe(2);
    expect(denominators["not_started_count"]).toBe(4);
  });
});

describe("retry, recovery, and correction-loop detection", () => {
  it("counts retries and recoveries from consecutive same-operation runs", () => {
    const runId = "run-1";
    const trial: TrialInput = {
      run_id: runId,
      evidence_uri: "runs/b/trials/run-1/evidence",
      events: completedRunEvents(runId, true),
      trace: [
        traceEvent({ runId, sequence: 1, status: 500 }),
        traceEvent({ runId, sequence: 2, status: 500 }),
        traceEvent({ runId, sequence: 3, status: 200 }),
        traceEvent({ runId, sequence: 4, status: 429 })
      ],
      evaluation: evaluation({
        runId,
        status: "passed",
        score: 1,
        checks: [checkRecord({ status: "passed" })]
      })
    };
    const report = buildReport({
      scope: { level: "batch", id: "b" },
      trials: [trial]
    });
    // Same-operation pairs whose previous request failed: (1, 2) and
    // (2, 3). The pair (3, 4) follows a success, so it is no retry.
    expect(report.behavior.api.retries).toBe(2);
    expect(report.behavior.api.recoveries_after_error).toBe(1);
    expect(report.behavior.api.correction_loops).toBe(1);
  });
});

describe("usage distribution rule", () => {
  it("hides extreme quantiles for small samples", () => {
    const distribution = usageDistribution([1, 2, 3, 4]);
    expect(distribution?.p95).toBeUndefined();
    expect(distribution?.median).toBe(2.5);
    expect(distribution?.mean).toBe(2.5);
  });

  it("returns null for an empty sample", () => {
    expect(usageDistribution([])).toBeNull();
  });
});

describe("report agreement and availability (section 27.3)", () => {
  /** Full lifecycle minus the turn_completed stage. */
  const eventsWithoutTurnCompleted = (
    runId: string
  ): ReturnType<typeof completedRunEvents> =>
    completedRunEvents(runId, true).filter(
      (event) =>
        !(
          event.type === "lifecycle.stage" &&
          event.payload.stage === "turn_completed"
        )
    );

  it("keeps the agreement rate within [0, 1] for valid reports without a completed turn", () => {
    const report = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials: [
        {
          run_id: "run-a",
          evidence_uri: "evidence",
          events: completedRunEvents("run-a", true),
          trace: []
        },
        {
          run_id: "run-b",
          evidence_uri: "evidence",
          events: eventsWithoutTurnCompleted("run-b"),
          trace: []
        },
        {
          run_id: "run-c",
          evidence_uri: "evidence",
          events: eventsWithoutTurnCompleted("run-c"),
          trace: []
        }
      ]
    });
    // Three valid-status reports but only one trial reaching
    // turn_completed: the rate is 1, never 3.
    expect(report.surfaces.participant_reports.valid).toBe(3);
    expect(report.surfaces.participant_reports.agreement).toBe(1);
    const reportValid = report.metrics.find(
      (metric) => metric.id === "report_valid"
    );
    expect(reportValid?.numerator).toBe(1);
    expect(reportValid?.denominator).toBe(1);
  });

  it("returns a null agreement rate when no trial completed a turn", () => {
    const report = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials: [
        {
          run_id: "run-b",
          evidence_uri: "evidence",
          events: eventsWithoutTurnCompleted("run-b"),
          trace: []
        }
      ]
    });
    expect(report.surfaces.participant_reports.agreement).toBeNull();
  });

  it("places every attempt in the correct availability bucket", () => {
    const report = buildReport({
      scope: { level: "batch", id: "batch-01" },
      trials: [
        {
          // Launched, turn completed: observed.
          run_id: "run-a",
          evidence_uri: "evidence",
          events: completedRunEvents("run-a", true),
          trace: []
        },
        {
          // Launched, no completed turn, corrupt evidence:
          // unavailable due to evidence.
          run_id: "run-d",
          evidence_uri: "evidence",
          events: postControlFailureEvents("run-d"),
          trace: []
        },
        {
          // Launched, no completed turn, intact evidence: unknown.
          run_id: "run-c",
          evidence_uri: "evidence",
          events: preControlFailureEvents("run-c"),
          trace: []
        },
        {
          // Never launched: not applicable.
          run_id: "run-e",
          evidence_uri: "evidence",
          events: [],
          trace: []
        }
      ]
    });
    const reportValid = report.metrics.find(
      (metric) => metric.id === "report_valid"
    );
    expect(reportValid?.availability).toEqual({
      observed: 1,
      unknown: 1,
      not_applicable: 1,
      unavailable_due_to_evidence: 1
    });
  });
});

describe("unlaunched trials", () => {
  it("marks trials without run.started as not launched", () => {
    const trial: TrialInput = {
      run_id: "run-9",
      evidence_uri: "evidence",
      events: [],
      trace: [],
      evaluation: evaluation({ runId: "run-9" })
    };
    const facts = buildTrialFacts(trial);
    expect(facts.row.launched).toBe(false);
    expect(facts.disposition).toBe("harness_aborted");
    expect(facts.integrity).toBe("missing");
    const slots = resolveSlots([facts]);
    expect(slots[0]?.resolved).toBe(false);
  });
});

describe("trace-derived failure classification", () => {
  it("separates wrong methods, malformed requests, and auth failures", () => {
    const runId = "run-1";
    const report = buildReport({
      scope: { level: "batch", id: "b" },
      trials: [
        {
          run_id: runId,
          evidence_uri: "evidence",
          events: completedRunEvents(runId, true),
          trace: [
            traceEvent({
              runId,
              sequence: 1,
              status: 405,
              operation: { matched: false, key: null, operation_id: null },
              error: traceError("routing", "method_not_allowed")
            }),
            traceEvent({
              runId,
              sequence: 2,
              status: 400,
              error: traceError("parsing", "request_schema_invalid")
            }),
            traceEvent({
              runId,
              sequence: 3,
              status: 401,
              authenticationStatus: "rejected",
              error: traceError("authentication", "authentication_failed")
            })
          ]
        }
      ]
    });
    expect(report.behavior.api.wrong_methods).toBe(1);
    expect(report.behavior.api.malformed_requests).toBe(1);
    expect(report.behavior.api.authentication_failures).toBe(1);
    expect(report.behavior.api.unknown_endpoints).toBe(0);
  });
});
