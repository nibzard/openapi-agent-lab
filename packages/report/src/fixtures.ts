/**
 * Hand-built evidence fixtures for the report tests. Every timestamp is
 * a fixed RFC 3339 literal and every digest is a fixed hex string, so
 * the scenarios stay deterministic.
 */

import type {
  DocumentationExchange,
  LifecycleEvent,
  LifecycleEventRecord,
  LifecycleEvidenceSource,
  LifecycleStage,
  SemanticEvent,
  TerminalDisposition,
  TraceBody,
  TraceError,
  TraceEvent,
  TraceOperation
} from "@oal/evidence";
import type {
  Evaluation,
  EvaluationCheckRecord,
  EvaluationStatus
} from "@oal/evaluator";
import { buildReport, type TrialInput } from "./aggregate.ts";
import type { Report } from "./model.ts";

export const T0 = "2026-08-27T12:00:00.000Z";
export const T1 = "2026-08-27T12:01:00.000Z";
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

interface Envelope {
  runId: string;
  sequence: number;
  observedAt?: string;
  batchId?: string | null;
}

export function stageRecord(
  envelope: Envelope,
  stage: LifecycleStage,
  evidenceSource: LifecycleEvidenceSource = "runner"
): LifecycleEventRecord<"lifecycle.stage"> {
  return {
    schema_version: 1,
    type: "lifecycle.stage",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T0,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: {
      stage,
      recorded_at: envelope.observedAt ?? T0,
      evidence_source: evidenceSource,
      details: {}
    }
  };
}

export function runCreatedEvent(
  envelope: Envelope
): LifecycleEventRecord<"run.created"> {
  return {
    schema_version: 1,
    type: "run.created",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T0,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: { run_id: envelope.runId, retry_of: null }
  };
}

export function runStartedEvent(
  envelope: Envelope,
  adapter = "codex"
): LifecycleEventRecord<"run.started"> {
  return {
    schema_version: 1,
    type: "run.started",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T0,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: { started_at: T0, adapter, model: "test-model" }
  };
}

export function mockStartedEvent(
  envelope: Envelope
): LifecycleEventRecord<"mock.started"> {
  return {
    schema_version: 1,
    type: "mock.started",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T0,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: { port: 34567, documentation_facade: true }
  };
}

export function evaluatorFinishedEvent(
  envelope: Envelope,
  status: EvaluationStatus
): LifecycleEventRecord<"evaluator.finished"> {
  return {
    schema_version: 1,
    type: "evaluator.finished",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T0,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: {
      status: status === "passed" ? "pass" : "fail",
      case_count: 1,
      checks_total: 2,
      checks_failed: status === "passed" ? 0 : 1
    }
  };
}

export function runFinishedEvent(
  envelope: Envelope,
  disposition: TerminalDisposition,
  integrity: "intact" | "corrupt" | "missing",
  durationMs: number
): LifecycleEventRecord<"run.finished"> {
  return {
    schema_version: 1,
    type: "run.finished",
    event_id: `lif${envelope.sequence.toString(10).padStart(6, "0")}`,
    sequence: envelope.sequence,
    observed_at: envelope.observedAt ?? T1,
    batch_id: envelope.batchId ?? null,
    run_id: envelope.runId,
    payload: {
      disposition,
      evidence_integrity: integrity,
      duration_ms: durationMs
    }
  };
}

export interface TraceOverrides {
  sequence?: number;
  actor?: "participant" | "control";
  runId?: string;
  operation?: Partial<TraceOperation>;
  method?: string;
  path?: string;
  status?: number | null;
  error?: TraceEvent["error"];
  authenticationStatus?: TraceEvent["authentication"]["status"];
  body?: TraceBody | undefined;
  support?: TraceOperation["support"];
}

const JSON_BODY: TraceBody = {
  kind: "json",
  size_bytes: 2,
  value: { ok: true },
  truncated: false
};

/** One complete api.exchange record with test-friendly defaults. */
export function traceEvent(overrides: TraceOverrides = {}): TraceEvent {
  const matched = overrides.operation?.matched ?? true;
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: `evt${(overrides.sequence ?? 1).toString(10).padStart(6, "0")}`,
    sequence: overrides.sequence ?? 1,
    participant_ingress_sequence: overrides.sequence ?? 1,
    observed_at: T0,
    logical_time: null,
    batch_id: null,
    run_id: overrides.runId ?? "run-1",
    eval_id: null,
    actor: overrides.actor ?? "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched,
      key:
        overrides.operation?.key === undefined
          ? `path:${overrides.method ?? "GET"} ${overrides.path ?? "/widgets"}`
          : overrides.operation.key,
      uid: overrides.operation?.uid ?? "op-1",
      operation_id:
        overrides.operation?.operation_id === undefined
          ? "listWidgets"
          : overrides.operation.operation_id,
      method: overrides.method ?? "GET",
      path_template: overrides.path ?? "/widgets",
      support: overrides.support ?? overrides.operation?.support ?? "supported"
    },
    request: {
      received_at: T0,
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/widgets",
      query_string: "",
      query: [],
      path_parameters: {},
      headers: [],
      credential_present: true,
      content_type: "application/json",
      body: overrides.body === undefined ? JSON_BODY : overrides.body
    },
    authentication: {
      status: overrides.authenticationStatus ?? "authenticated",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: { status: "valid", violations: [] },
      response: { status: "valid", violations: [] }
    },
    backend: null,
    response:
      overrides.status === null || overrides.status === undefined
        ? null
        : {
            completed_at: T0,
            status: overrides.status,
            headers: [],
            content_type: "application/json",
            body: JSON_BODY
          },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: overrides.error ?? null,
    duration_ms: 12,
    resource_usage: null,
    extensions: {}
  };
}

export function traceError(
  layer: TraceError["layer"],
  code: string
): TraceError {
  return {
    layer,
    code,
    message: code,
    retryable: false,
    details: {}
  };
}

export interface DocumentationOverrides {
  sequence?: number;
  runId?: string;
  actor?: "participant" | "control";
  routeId?: string;
  outcome?: string;
}

export function documentationExchange(
  overrides: DocumentationOverrides = {}
): DocumentationExchange {
  return {
    schema_version: 1,
    type: "documentation.exchange",
    event_id: `doc${(overrides.sequence ?? 1).toString(10).padStart(6, "0")}`,
    sequence: overrides.sequence ?? 1,
    participant_ingress_sequence: overrides.sequence ?? 1,
    observed_at: T0,
    batch_id: null,
    run_id: overrides.runId ?? "run-1",
    actor: overrides.actor ?? "participant",
    request: { method: "GET", path: "/docs" },
    candidate: { profile: "default", route_id: overrides.routeId ?? "index" },
    authentication: { status: "authenticated" },
    visibility: "visible",
    outcome: overrides.outcome ?? "index_served",
    response: {
      status: 200,
      content_type: "text/html",
      bytes: 128,
      body_sha256: null
    },
    duration_ms: 5,
    extensions: {}
  };
}

export interface SemanticOverrides {
  runId?: string;
  name?: string;
  sequence?: number;
}

export function semanticEvent(
  overrides: SemanticOverrides = {}
): SemanticEvent {
  return {
    schema_version: 1,
    type: "semantic.event",
    event_id: `sem${(overrides.sequence ?? 1).toString(10).padStart(6, "0")}`,
    semantic_sequence: overrides.sequence ?? 1,
    run_id: overrides.runId ?? "run-1",
    pack_id: "steel",
    name: overrides.name ?? "computer.created",
    event_version: 1,
    logical_time: "1",
    caused_by_api_event_id: null,
    actor: "participant",
    state_revision_before: 0,
    state_revision_after: 1,
    payload_schema: "urn:test",
    payload: {}
  };
}

export interface CheckOverrides {
  id?: string;
  status?: EvaluationStatus;
  weight?: number;
}

export function checkRecord(
  overrides: CheckOverrides = {}
): EvaluationCheckRecord {
  return {
    id: overrides.id ?? "recovery_flow",
    status: overrides.status ?? "passed",
    weight: overrides.weight ?? 1,
    required: true
  };
}

export interface EvaluationOverrides {
  runId?: string;
  status?: EvaluationStatus;
  score?: number;
  checks?: EvaluationCheckRecord[];
  signals?: Record<string, boolean>;
  infrastructureErrors?: Evaluation["infrastructure_errors"];
}

export function evaluation(overrides: EvaluationOverrides = {}): Evaluation {
  const checks = overrides.checks ?? [
    checkRecord({ id: "recovery_flow", status: "passed" }),
    checkRecord({ id: "final_state", status: "failed" })
  ];
  const passedWeight = checks
    .filter((check) => check.status === "passed")
    .reduce((total, check) => total + check.weight, 0);
  const totalWeight = checks.reduce((total, check) => total + check.weight, 0);
  return {
    schema_version: 1,
    rubric_id: "steel-recovery",
    run_id: overrides.runId ?? "run-1",
    status: overrides.status ?? "failed",
    score:
      overrides.score ?? (totalWeight === 0 ? 0 : passedWeight / totalWeight),
    passed_weight: passedWeight,
    total_weight: totalWeight,
    checks,
    signals: overrides.signals ?? { clean_bytes_restored: true },
    infrastructure_errors: overrides.infrastructureErrors ?? []
  };
}

/** A complete trial lifecycle for a successful run. */
export function completedRunEvents(
  runId: string,
  withReportValid: boolean,
  durationMs = 240000
): LifecycleEvent[] {
  return [
    runCreatedEvent({ runId, sequence: 1 }),
    runStartedEvent({ runId, sequence: 2 }),
    stageRecord({ runId, sequence: 3 }, "workspace_prepared"),
    mockStartedEvent({ runId, sequence: 4 }),
    stageRecord({ runId, sequence: 5 }, "participant_spawned"),
    stageRecord({ runId, sequence: 6 }, "participant_control_started"),
    stageRecord({ runId, sequence: 7 }, "api_started"),
    stageRecord({ runId, sequence: 8 }, "turn_completed"),
    stageRecord({ runId, sequence: 9 }, "report_present"),
    ...(withReportValid
      ? [stageRecord({ runId, sequence: 10 }, "report_valid")]
      : []),
    stageRecord({ runId, sequence: 11 }, "finalization_started"),
    evaluatorFinishedEvent({ runId, sequence: 12 }, "passed"),
    stageRecord({ runId, sequence: 13 }, "evidence_finalized"),
    runFinishedEvent({ runId, sequence: 14 }, "completed", "intact", durationMs)
  ];
}

/** Trial lifecycle for a post-control infrastructure failure. */
export function postControlFailureEvents(runId: string): LifecycleEvent[] {
  return [
    runCreatedEvent({ runId, sequence: 1 }),
    runStartedEvent({ runId, sequence: 2 }),
    stageRecord({ runId, sequence: 3 }, "workspace_prepared"),
    stageRecord({ runId, sequence: 4 }, "participant_spawned"),
    stageRecord({ runId, sequence: 5 }, "participant_control_started"),
    stageRecord({ runId, sequence: 6 }, "api_started"),
    runFinishedEvent(
      { runId, sequence: 7 },
      "infrastructure_failed_post_control",
      "corrupt",
      60000
    )
  ];
}

/** Trial lifecycle for a pre-control provider failure. */
export function preControlFailureEvents(runId: string): LifecycleEvent[] {
  return [
    runCreatedEvent({ runId, sequence: 1 }),
    runStartedEvent({ runId, sequence: 2 }),
    stageRecord({ runId, sequence: 3 }, "workspace_prepared"),
    runFinishedEvent(
      { runId, sequence: 4 },
      "provider_failed_pre_control",
      "intact",
      10000
    )
  ];
}

export const CANARY_SECRET = "canary-secret-8f3a";
export const HMAC_KEY = new Uint8Array(32).fill(1);

/** Four-trial scenario: pass, censored original, replacement, pre-control. */
export function scenarioTrials(): TrialInput[] {
  const asg = (n: number): string => `asg_${n.toString(16).padStart(24, "0")}`;
  return [
    {
      run_id: "run-1",
      evidence_uri: "runs/batch-01/trials/run-01/evidence",
      eval_id: "steel-recovery",
      assignment_id: asg(1),
      replacement_of: null,
      events: completedRunEvents("run-1", true),
      trace: [
        traceEvent({ runId: "run-1", sequence: 1, status: 200 }),
        traceEvent({
          runId: "run-1",
          sequence: 2,
          method: "POST",
          path: "/computers",
          status: 201,
          operation: {
            matched: true,
            key: "path:POST /computers",
            operation_id: "createComputer",
            method: "POST",
            path_template: "/computers"
          }
        }),
        traceEvent({
          runId: "run-1",
          sequence: 3,
          path: "/computers/c-1",
          status: 200,
          operation: {
            matched: true,
            key: "path:GET /computers/{id}",
            operation_id: "getComputer",
            method: "GET",
            path_template: "/computers/{id}"
          }
        }),
        traceEvent({
          runId: "run-1",
          sequence: 4,
          actor: "control",
          status: 200
        })
      ],
      documentation: [
        documentationExchange({
          runId: "run-1",
          sequence: 1,
          routeId: "index"
        }),
        documentationExchange({
          runId: "run-1",
          sequence: 2,
          routeId: "openapi",
          outcome: "contract_served"
        }),
        documentationExchange({ runId: "run-1", sequence: 3, actor: "control" })
      ],
      semantic: [
        semanticEvent({
          runId: "run-1",
          name: "computer.created",
          sequence: 1
        }),
        semanticEvent({ runId: "run-1", name: "computer.patched", sequence: 2 })
      ],
      evaluation: evaluation({
        runId: "run-1",
        status: "passed",
        score: 1,
        checks: [
          checkRecord({ id: "recovery_flow", status: "passed" }),
          checkRecord({ id: "final_state", status: "passed" })
        ]
      }),
      usage: { tokens: 1000, tool_calls: 4, provider_cost: 0.02 },
      final_state: {
        state_sha256: SHA_A,
        summary: {
          computer_id: "c-1",
          api_token: CANARY_SECRET,
          reasoning: "hidden chain of thought must not leak",
          note: "n".repeat(300)
        }
      }
    },
    {
      run_id: "run-2",
      evidence_uri: "runs/batch-01/trials/run-02/evidence",
      eval_id: "steel-recovery",
      assignment_id: asg(2),
      replacement_of: null,
      events: postControlFailureEvents("run-2"),
      trace: [
        traceEvent({
          runId: "run-2",
          sequence: 1,
          method: "POST",
          path: "/computers",
          status: 500,
          operation: {
            matched: true,
            key: "path:POST /computers",
            operation_id: "createComputer",
            method: "POST",
            path_template: "/computers"
          },
          error: traceError("behavior", "invalid_state")
        }),
        traceEvent({
          runId: "run-2",
          sequence: 2,
          status: null,
          operation: {
            matched: false,
            key: null,
            operation_id: null,
            method: null,
            path_template: null
          },
          error: traceError("routing", "route_not_found")
        })
      ],
      documentation: [
        documentationExchange({
          runId: "run-2",
          sequence: 1,
          routeId: "index",
          outcome: "rejected_authentication"
        })
      ],
      integrity: {
        problems: ["state.final.json digest mismatch detected"]
      }
    },
    {
      run_id: "run-2b",
      evidence_uri: "runs/batch-01/trials/run-02b/evidence",
      eval_id: "steel-recovery",
      assignment_id: asg(18),
      replacement_of: asg(2),
      events: completedRunEvents("run-2b", true),
      trace: [traceEvent({ runId: "run-2b", sequence: 1, status: 200 })],
      documentation: [
        documentationExchange({
          runId: "run-2b",
          sequence: 1,
          routeId: "index"
        })
      ],
      semantic: [
        semanticEvent({
          runId: "run-2b",
          name: "computer.created",
          sequence: 1
        })
      ],
      evaluation: evaluation({
        runId: "run-2b",
        status: "passed",
        score: 1,
        checks: [
          checkRecord({ id: "recovery_flow", status: "passed" }),
          checkRecord({ id: "final_state", status: "passed" })
        ]
      }),
      usage: { tokens: 2000, tool_calls: 2, provider_cost: 0.01 }
    },
    {
      run_id: "run-3",
      evidence_uri: "runs/batch-01/trials/run-03/evidence",
      eval_id: "steel-recovery",
      assignment_id: asg(3),
      replacement_of: null,
      events: preControlFailureEvents("run-3"),
      trace: []
    }
  ];
}

/** The full scenario report with provenance and redaction context. */
export function scenarioReport(): Report {
  return buildReport({
    scope: { level: "batch", id: "batch-01" },
    trials: scenarioTrials(),
    provenance: {
      cells: [
        {
          cell_id: "cell-a",
          factor_levels: { model: "test-model" },
          compatibility_sha256: SHA_A,
          intended_factors: ["model"]
        }
      ],
      implementation: { statistics: SHA_B },
      environment_names: ["OAL_SANDBOX", "invalid-name!"]
    },
    redaction: { hmacKey: HMAC_KEY, secrets: [CANARY_SECRET] }
  });
}
