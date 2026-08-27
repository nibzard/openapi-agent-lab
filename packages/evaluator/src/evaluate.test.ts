import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isJsonObject,
  SchemaValidator,
  type Json,
  type JsonObject
} from "@oal/core";
import type {
  DocumentationExchange,
  SemanticEvent,
  TraceBody,
  TraceEvent
} from "@oal/evidence";
import { EVALUATOR_NAME, EVALUATOR_VERSION } from "./evaluation.ts";
import { loadRubric } from "./rubric.ts";
import {
  evaluateRubric,
  toEvaluation,
  type CheckResult,
  type EvaluateOptions,
  type EvaluationResult
} from "./evaluate.ts";
import type { Rubric } from "./rubric.ts";

const EVALUATION_SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "evaluation.v1.schema.json"
);

const CLEAN_SHA = `a`.repeat(64);
const CHANGED_SHA = `b`.repeat(64);
const WRONG_SHA = `c`.repeat(64);
const RUN_ID = "run-1";
const RUN: JsonObject = { run_id: RUN_ID, mode: "record" };
const REPORT: JsonObject = {
  fan_out: { supported: false },
  checkpoint_used: true
};
const RESULT_SCHEMA: Json = {
  type: "object",
  required: ["fan_out", "checkpoint_used"],
  properties: {
    fan_out: {
      type: "object",
      required: ["supported"],
      properties: { supported: { type: "boolean" } }
    },
    checkpoint_used: { type: "boolean" }
  }
};

/**
 * The steel-recovery rubric of specification section 26.3, adapted to
 * the check kinds of version 1: the filter and exists macros become a
 * counted event check, and the report assertion becomes a predicate.
 */
const STEEL_CHECKS: Json[] = [
  {
    id: "recovery_flow",
    description: "The same computer returns to the verified clean bytes",
    kind: "sequence",
    weight: 8,
    required: true,
    match: "any",
    max_candidates: 10000,
    steps: [
      {
        id: "create",
        where:
          'event.operation.operation_id == "createComputer" && ' +
          "event.response.status >= 200 && event.response.status < 300 && " +
          'event.response.body.kind == "json" && ' +
          'event.response.body.value.template == "system/chrome"',
        capture: { computer_id: "event.response.body.value.id" }
      },
      {
        id: "initial_write",
        where:
          'event.operation.operation_id == "uploadFile" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id && " +
          'event.request.body.kind == "binary"',
        capture: { clean_sha: "event.request.body.sha256" }
      },
      {
        id: "initial_read",
        where:
          'event.operation.operation_id == "downloadFile" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id && " +
          "event.response.status >= 200 && event.response.status < 300 && " +
          'event.response.body.kind == "binary" && ' +
          "event.response.body.sha256 == vars.clean_sha"
      },
      {
        id: "checkpoint",
        where:
          'event.operation.operation_id == "createCheckpoint" && ' +
          "event.response.status >= 200 && event.response.status < 300 && " +
          "event.response.body.value.computer_id == vars.computer_id",
        capture: { checkpoint_id: "event.response.body.value.id" }
      },
      {
        id: "changed_write",
        where:
          'event.operation.operation_id == "uploadFile" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id && " +
          'event.request.body.kind == "binary" && ' +
          "event.request.body.sha256 != vars.clean_sha"
      },
      {
        id: "restore",
        where:
          'event.operation.operation_id == "restoreComputer" && ' +
          'event.request.body.kind == "json" && ' +
          "event.request.body.value.checkpoint_id == vars.checkpoint_id && " +
          "event.response.body.value.id == vars.computer_id && " +
          "event.response.status >= 200 && event.response.status < 300"
      },
      {
        id: "recovered_read",
        where:
          'event.operation.operation_id == "downloadFile" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id && " +
          'event.response.body.kind == "binary" && ' +
          "event.response.body.sha256 == vars.clean_sha && " +
          "event.response.status >= 200 && event.response.status < 300"
      },
      {
        id: "pause",
        where:
          'event.operation.operation_id == "pauseComputer" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id && " +
          "event.response.status >= 200 && event.response.status < 300"
      }
    ],
    postconditions: [
      {
        id: "final_paused",
        expression: 'state.computers[vars.computer_id].state == "paused"'
      }
    ]
  },
  {
    id: "result_report",
    description: "The participant returned the required report",
    kind: "json_schema",
    weight: 1,
    required: true,
    value: "report",
    schema: "result.schema.json"
  },
  {
    id: "single_create",
    description: "Exactly one computer was created with success",
    kind: "event",
    weight: 1,
    required: false,
    match: "counted",
    min_count: 1,
    max_count: 1,
    where:
      'event.operation.operation_id == "createComputer" && ' +
      "event.response.status >= 200 && event.response.status < 300"
  },
  {
    id: "fan_out_reported",
    kind: "predicate",
    weight: 1,
    required: false,
    expression: "report.fan_out.supported == false"
  }
];

const STEEL_SIGNALS: Json[] = [
  {
    id: "first_call_is_create",
    kind: "predicate",
    expression: 'events[0].operation.operation_id == "createComputer"'
  },
  {
    id: "recorded_mode",
    kind: "predicate",
    expression: 'run.mode == "record"'
  }
];

const STEEL_RECOVERY: JsonObject = {
  rubric_version: 1,
  id: "steel-recovery",
  description: "Prepare, checkpoint, alter, restore, and pause one computer",
  scoring: { method: "weighted_binary", pass_threshold: 0.9 },
  checks: STEEL_CHECKS,
  signals: STEEL_SIGNALS
};
const NO_BODY: TraceBody = { kind: "none" };

function jsonBody(value: Json): TraceBody {
  return {
    kind: "json",
    size_bytes: JSON.stringify(value).length,
    value,
    truncated: false
  };
}

function binaryBody(sha256: string): TraceBody {
  return { kind: "binary", size_bytes: 32, sha256, blob_ref: null };
}

interface ExchangeInit {
  event_id: string;
  sequence: number;
  operation_id: string;
  method: string;
  path: string;
  status: number;
  path_parameters?: Record<string, string>;
  request_body?: TraceBody;
  response_body?: TraceBody;
}

function exchange(init: ExchangeInit): TraceEvent {
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: init.event_id,
    sequence: init.sequence,
    participant_ingress_sequence: init.sequence,
    observed_at: "2026-01-01T00:00:00.000Z",
    logical_time: null,
    batch_id: null,
    run_id: RUN_ID,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: true,
      key: init.operation_id,
      uid: `op-${init.operation_id}`,
      operation_id: init.operation_id,
      method: init.method,
      path_template: init.path,
      support: "supported"
    },
    request: {
      received_at: "2026-01-01T00:00:00.000Z",
      method: init.method,
      path: init.path,
      query_string: "",
      query: [],
      path_parameters: init.path_parameters ?? {},
      headers: [],
      credential_present: true,
      content_type: "application/json",
      body: init.request_body ?? NO_BODY
    },
    authentication: {
      status: "authenticated",
      alternative_index: null,
      schemes: ["bearer"],
      principal_ref: null
    },
    validation: {
      request: { status: "valid", violations: [] },
      response: { status: "valid", violations: [] }
    },
    backend: null,
    response: {
      completed_at: "2026-01-01T00:00:00.000Z",
      status: init.status,
      headers: [],
      content_type: "application/json",
      body: init.response_body ?? NO_BODY
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: null,
    duration_ms: 4,
    resource_usage: null,
    extensions: {}
  };
}

/** The full happy path of the steel-recovery scenario. */
function passingEvents(): TraceEvent[] {
  return [
    exchange({
      event_id: "evt-1",
      sequence: 1,
      operation_id: "createComputer",
      method: "POST",
      path: "/computers",
      status: 201,
      response_body: jsonBody({ id: "cmp-1", template: "system/chrome" })
    }),
    exchange({
      event_id: "evt-2",
      sequence: 2,
      operation_id: "uploadFile",
      method: "PUT",
      path: "/computers/cmp-1/files/main",
      status: 204,
      path_parameters: { computer_id: "cmp-1" },
      request_body: binaryBody(CLEAN_SHA)
    }),
    exchange({
      event_id: "evt-3",
      sequence: 3,
      operation_id: "downloadFile",
      method: "GET",
      path: "/computers/cmp-1/files/main",
      status: 200,
      path_parameters: { computer_id: "cmp-1" },
      response_body: binaryBody(CLEAN_SHA)
    }),
    exchange({
      event_id: "evt-4",
      sequence: 4,
      operation_id: "createCheckpoint",
      method: "POST",
      path: "/computers/cmp-1/checkpoints",
      status: 201,
      path_parameters: { computer_id: "cmp-1" },
      response_body: jsonBody({ id: "chk-9", computer_id: "cmp-1" })
    }),
    exchange({
      event_id: "evt-5",
      sequence: 5,
      operation_id: "uploadFile",
      method: "PUT",
      path: "/computers/cmp-1/files/main",
      status: 204,
      path_parameters: { computer_id: "cmp-1" },
      request_body: binaryBody(CHANGED_SHA)
    }),
    exchange({
      event_id: "evt-6",
      sequence: 6,
      operation_id: "restoreComputer",
      method: "POST",
      path: "/computers/cmp-1/restore",
      status: 200,
      path_parameters: { computer_id: "cmp-1" },
      request_body: jsonBody({ checkpoint_id: "chk-9" }),
      response_body: jsonBody({ id: "cmp-1" })
    }),
    exchange({
      event_id: "evt-7",
      sequence: 7,
      operation_id: "downloadFile",
      method: "GET",
      path: "/computers/cmp-1/files/main",
      status: 200,
      path_parameters: { computer_id: "cmp-1" },
      response_body: binaryBody(CLEAN_SHA)
    }),
    exchange({
      event_id: "evt-8",
      sequence: 8,
      operation_id: "pauseComputer",
      method: "POST",
      path: "/computers/cmp-1/pause",
      status: 204,
      path_parameters: { computer_id: "cmp-1" }
    })
  ];
}

const PASSING_STATE: JsonObject = {
  computers: { "cmp-1": { state: "paused", revision: 6 } }
};

async function evaluationSchema(): Promise<Json> {
  return JSON.parse(await readFile(EVALUATION_SCHEMA_PATH, "utf8")) as Json;
}

function steelRubric(): Rubric {
  const result = loadRubric(STEEL_RECOVERY, {
    resolveSchema: () => RESULT_SCHEMA
  });
  if (result.rubric === null) {
    throw new Error("The steel-recovery fixture did not load.");
  }
  return result.rubric;
}

function loadFixture(
  document: Json,
  options: Record<string, unknown> = {}
): Rubric {
  const result = loadRubric(document, {
    resolveSchema: () => RESULT_SCHEMA,
    ...options
  });
  if (result.rubric === null) {
    throw new Error("The fixture did not load.");
  }
  return result.rubric;
}

function evaluate(
  rubric: Rubric,
  overrides: Partial<EvaluateOptions> = {}
): EvaluationResult {
  return evaluateRubric({
    rubric,
    runId: RUN_ID,
    run: RUN,
    events: passingEvents(),
    state: PASSING_STATE,
    report: REPORT,
    resolveSchema: () => RESULT_SCHEMA,
    ...overrides
  });
}

function checkOf(result: EvaluationResult, id: string): CheckResult {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`Check ${id} is missing from the result.`);
  }
  return found;
}

describe("steel-recovery evaluation", () => {
  it("passes the happy path and records the captures", () => {
    const result = evaluate(steelRubric());
    expect(result.status).toBe("passed");
    expect(result.score).toBe(1);
    expect(result.passedWeight).toBe(11);
    expect(result.totalWeight).toBe(11);
    expect(result.signals).toEqual({
      first_call_is_create: true,
      recorded_mode: true
    });
    const flow = checkOf(result, "recovery_flow");
    expect(flow.status).toBe("passed");
    expect(flow.captures).toEqual({
      computer_id: "cmp-1",
      clean_sha: CLEAN_SHA,
      checkpoint_id: "chk-9"
    });
    expect(flow.eventIds).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
      "evt-4",
      "evt-5",
      "evt-6",
      "evt-7",
      "evt-8"
    ]);
    expect(flow.steps).toHaveLength(8);
    expect(flow.steps.every((step) => step.status === "selected")).toBe(true);
    expect(flow.postconditions.map((outcome) => outcome.status)).toEqual([
      "passed"
    ]);
    expect(result.infrastructureErrors).toEqual([]);
  });

  it("fails at a step and names that step in the evidence", () => {
    const events = passingEvents();
    const recovered = events[6];
    if (recovered === undefined || recovered.response === null) {
      throw new Error("The fixture is missing the recovered read.");
    }
    recovered.response.body = binaryBody(WRONG_SHA);
    const result = evaluate(steelRubric(), { events });
    expect(result.status).toBe("failed");
    const flow = checkOf(result, "recovery_flow");
    expect(flow.status).toBe("failed");
    expect(flow.failedPointers).toEqual(["steps/recovered_read"]);
    const failed = flow.steps.find((step) => step.status === "unmatched");
    expect(failed?.id).toBe("recovered_read");
    expect(failed?.event_id).toBe(null);
    expect(
      flow.steps.filter((step) => step.status === "selected")
    ).toHaveLength(6);
    expect(flow.message).toContain("recovered_read");
  });

  it("fails a postcondition and points at the postcondition", () => {
    const state: JsonObject = {
      computers: { "cmp-1": { state: "running", revision: 6 } }
    };
    const result = evaluate(steelRubric(), { state });
    const flow = checkOf(result, "recovery_flow");
    expect(flow.status).toBe("failed");
    expect(flow.failedPointers).toEqual(["postconditions/final_paused"]);
    expect(flow.postconditions[0]?.status).toBe("failed");
    expect(result.status).toBe("failed");
  });

  it("backtracks instead of committing to the first candidate", () => {
    const document: Json = {
      rubric_version: 1,
      id: "backtrack",
      scoring: { method: "weighted_binary", pass_threshold: 1 },
      checks: [
        {
          id: "write_after_create",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [
            {
              id: "create",
              where:
                'event.operation.operation_id == "createComputer" && ' +
                "event.response.status < 300",
              capture: { computer_id: "event.response.body.value.id" }
            },
            {
              id: "write",
              where:
                'event.operation.operation_id == "uploadFile" && ' +
                "event.request.path_parameters.computer_id == vars.computer_id"
            }
          ]
        }
      ],
      signals: []
    };
    const events = [
      exchange({
        event_id: "evt-1",
        sequence: 1,
        operation_id: "createComputer",
        method: "POST",
        path: "/computers",
        status: 201,
        response_body: jsonBody({ id: "cmp-1", template: "system/chrome" })
      }),
      exchange({
        event_id: "evt-2",
        sequence: 2,
        operation_id: "createComputer",
        method: "POST",
        path: "/computers",
        status: 201,
        response_body: jsonBody({ id: "cmp-2", template: "system/chrome" })
      }),
      exchange({
        event_id: "evt-3",
        sequence: 3,
        operation_id: "uploadFile",
        method: "PUT",
        path: "/computers/cmp-2/files/main",
        status: 204,
        path_parameters: { computer_id: "cmp-2" },
        request_body: binaryBody(CLEAN_SHA)
      })
    ];
    const result = evaluate(loadFixture(document), { events });
    const flow = checkOf(result, "write_after_create");
    expect(flow.status).toBe("passed");
    expect(flow.captures).toEqual({ computer_id: "cmp-2" });
    expect(flow.eventIds).toEqual(["evt-2", "evt-3"]);
    expect(result.status).toBe("passed");
  });

  it("requires every event to be consumed by match all", () => {
    const document: Json = {
      rubric_version: 1,
      id: "all-steps",
      scoring: { method: "weighted_binary", pass_threshold: 1 },
      checks: [
        {
          id: "two_calls",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "all",
          steps: [
            {
              id: "first",
              where: 'event.operation.operation_id == "createComputer"'
            },
            {
              id: "second",
              where: 'event.operation.operation_id == "pauseComputer"'
            }
          ]
        }
      ],
      signals: []
    };
    const all = passingEvents();
    const create = all[0];
    const pause = all[7];
    if (create === undefined || pause === undefined) {
      throw new Error("The fixture is missing the boundary events.");
    }
    const matched = evaluate(loadFixture(document), {
      events: [create, pause]
    });
    expect(checkOf(matched, "two_calls").status).toBe("passed");
    expect(checkOf(matched, "two_calls").eventIds).toEqual(["evt-1", "evt-8"]);

    const crowded = evaluate(loadFixture(document));
    expect(checkOf(crowded, "two_calls").status).toBe("failed");
    expect(checkOf(crowded, "two_calls").steps[0]?.status).toBe("selected");
    expect(checkOf(crowded, "two_calls").steps[1]?.status).toBe("unmatched");
  });
});

describe("evaluator scoring and status", () => {
  it("keeps the score under the threshold as a failure", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        ...STEEL_CHECKS,
        {
          id: "extra_weight",
          kind: "predicate",
          weight: 30,
          required: false,
          expression: "false"
        }
      ]
    };
    const result = evaluate(loadFixture(document));
    expect(result.passedWeight).toBe(11);
    expect(result.totalWeight).toBe(41);
    expect(result.score).toBeCloseTo(0.268, 3);
    expect(result.status).toBe("failed");
  });

  it("reports an error status when any check errors", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        ...STEEL_CHECKS.filter(
          (check) => !isJsonObject(check) || check.id !== "result_report"
        ),
        {
          id: "result_report",
          kind: "json_schema",
          weight: 1,
          required: true,
          value: "report",
          schema: "result.schema.json",
          on_missing: "error"
        }
      ]
    };
    const result = evaluate(loadFixture(document), { report: null });
    expect(result.status).toBe("error");
    const reported = checkOf(result, "result_report");
    expect(reported.status).toBe("error");
    expect(reported.error?.code).toBe("OAL-CHECK-MISSING-VALUE");
    const fanOut = checkOf(result, "fan_out_reported");
    expect(fanOut.status).toBe("failed");
    expect(result.infrastructureErrors.map((error) => error.code)).toEqual([
      "OAL-CHECK-MISSING-VALUE"
    ]);
  });

  it("produces the same document twice", () => {
    const first = evaluate(steelRubric());
    const second = evaluate(steelRubric());
    expect(first).toEqual(second);
    expect(toEvaluation(first)).toEqual(toEvaluation(second));
  });
});

describe("evaluator limits", () => {
  it("turns a candidate overflow into an infrastructure error", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "create_then_pause",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [
            {
              id: "create",
              where: 'event.operation.operation_id == "createComputer"'
            },
            {
              id: "pause",
              where: 'event.operation.operation_id == "pauseComputer"'
            }
          ]
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document), {
      limits: { maxCandidates: 3 }
    });
    const flow = checkOf(result, "create_then_pause");
    expect(flow.status).toBe("error");
    expect(flow.error?.code).toBe("OAL-CHECK-CANDIDATE-LIMIT");
    expect(flow.message).toContain("candidate limit");
    expect(result.infrastructureErrors[0]?.check_id).toBe("create_then_pause");
    expect(result.status).toBe("error");
  });

  it("turns an oversized capture into an infrastructure error", () => {
    const result = evaluate(steelRubric(), {
      limits: { maxCaptureBytes: 4 }
    });
    const flow = checkOf(result, "recovery_flow");
    expect(flow.status).toBe("error");
    expect(flow.error?.code).toBe("OAL-CHECK-CAPTURE-LIMIT");
  });

  it("keeps a type error out of the task score", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "broken_predicate",
          kind: "predicate",
          weight: 5,
          required: true,
          expression: "report.fan_out.supported + 1 == 1"
        }
      ],
      signals: [
        {
          id: "broken_signal",
          kind: "predicate",
          expression: "run.mode + 1 == 1"
        }
      ]
    };
    const result = evaluate(loadFixture(document));
    const broken = checkOf(result, "broken_predicate");
    expect(broken.status).toBe("error");
    expect(result.infrastructureErrors.map((error) => error.code)).toEqual([
      "OAL-EXPRESSION-TYPE",
      "OAL-EXPRESSION-TYPE"
    ]);
    expect(result.infrastructureErrors[0]?.check_id).toBe("broken_predicate");
    expect(result.infrastructureErrors[1]?.check_id).toBe("broken_signal");
    expect(result.signals.broken_signal).toBe(false);
    expect(result.status).toBe("error");
  });
});

describe("on_missing policies", () => {
  function reportCheck(onMissing: string): CheckResult {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "result_report",
          kind: "json_schema",
          weight: 1,
          required: true,
          value: "report",
          schema: "result.schema.json",
          on_missing: onMissing
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document), { report: null });
    return checkOf(result, "result_report");
  }

  it("fails by default", () => {
    expect(reportCheck("fail").status).toBe("failed");
  });

  it("skips when the policy is skip and skips the whole run", () => {
    const skipped = reportCheck("skip");
    expect(skipped.status).toBe("skipped");
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "result_report",
          kind: "json_schema",
          weight: 1,
          required: true,
          value: "report",
          schema: "result.schema.json",
          on_missing: "skip"
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document), { report: null });
    expect(result.status).toBe("skipped");
    expect(result.score).toBe(0);
  });

  it("errors when the policy is error", () => {
    const errored = reportCheck("error");
    expect(errored.status).toBe("error");
    expect(errored.error?.code).toBe("OAL-CHECK-MISSING-VALUE");
  });
});

describe("json schema checks", () => {
  it("reports the violating pointers of the report", () => {
    const result = evaluate(steelRubric(), {
      report: { fan_out: { supported: false } }
    });
    const reported = checkOf(result, "result_report");
    expect(reported.status).toBe("failed");
    expect(reported.failedPointers).toEqual(["/checkpoint_used"]);
    expect(result.status).toBe("failed");
  });

  it("errors when the referenced schema is not loaded", () => {
    const result = evaluate(steelRubric(), {
      resolveSchema: () => undefined
    });
    const reported = checkOf(result, "result_report");
    expect(reported.status).toBe("error");
    expect(reported.error?.code).toBe("OAL-RUBRIC-SCHEMA-UNRESOLVED");
  });

  it("validates the last JSON response body", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "pause_response",
          kind: "json_schema",
          weight: 1,
          required: true,
          value: "response",
          schema: "result.schema.json"
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document));
    const pause = checkOf(result, "pause_response");
    expect(pause.status).toBe("failed");
    expect(pause.failedPointers).toEqual(["/fan_out", "/checkpoint_used"]);
  });
});

describe("artifact checks", () => {
  function artifactRubric(): Rubric {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "log_present",
          kind: "artifact",
          weight: 1,
          required: true,
          path: "logs/run.jsonl",
          exists: true,
          media_type: "application/x-ndjson",
          max_bytes: 4096
        },
        {
          id: "no_core_dump",
          kind: "artifact",
          weight: 1,
          required: false,
          path: "tmp/core",
          exists: false
        }
      ],
      signals: []
    };
    return loadFixture(document);
  }

  it("passes when every assertion holds", () => {
    const result = evaluate(artifactRubric(), {
      artifacts: {
        "logs/run.jsonl": {
          present: true,
          bytes: 512,
          sha256: CLEAN_SHA,
          media_type: "application/x-ndjson"
        },
        "tmp/core": {
          present: false,
          bytes: null,
          sha256: null,
          media_type: null
        }
      }
    });
    expect(checkOf(result, "log_present").status).toBe("passed");
    expect(checkOf(result, "no_core_dump").status).toBe("passed");
    expect(checkOf(result, "log_present").artifactRefs).toEqual([
      "logs/run.jsonl"
    ]);
  });

  it("fails when the media type differs", () => {
    const result = evaluate(artifactRubric(), {
      artifacts: {
        "logs/run.jsonl": {
          present: true,
          bytes: 512,
          sha256: CLEAN_SHA,
          media_type: "text/plain"
        }
      }
    });
    const log = checkOf(result, "log_present");
    expect(log.status).toBe("failed");
    expect(log.failedPointers).toEqual(["logs/run.jsonl"]);
  });
});

describe("documentation and semantic streams", () => {
  function documentation(
    eventId: string,
    sequence: number,
    outcome: string
  ): DocumentationExchange {
    return {
      schema_version: 1,
      type: "documentation.exchange",
      event_id: eventId,
      sequence,
      participant_ingress_sequence: sequence,
      observed_at: "2026-01-01T00:00:00.000Z",
      batch_id: null,
      run_id: RUN_ID,
      actor: "participant",
      request: { method: "GET", path: "/openapi.json" },
      candidate: { profile: "openapi-3-1", route_id: "docs" },
      authentication: { status: "not_required" },
      visibility: "public",
      outcome,
      response: {
        status: 200,
        content_type: "application/json",
        bytes: 2048,
        body_sha256: CLEAN_SHA
      },
      duration_ms: 2,
      extensions: {}
    };
  }

  const SERVED = documentation("doc-1", 1, "served");

  const SEMANTIC: SemanticEvent[] = [
    {
      schema_version: 1,
      type: "semantic.event",
      event_id: "sem-1",
      semantic_sequence: 1,
      run_id: RUN_ID,
      pack_id: "steel-recovery",
      name: "checkpoint.created",
      event_version: 1,
      logical_time: "2026-01-01T00:00:00.000Z",
      caused_by_api_event_id: "evt-4",
      actor: "participant",
      state_revision_before: 3,
      state_revision_after: 4,
      payload_schema: "steel-recovery.checkpoint.created",
      payload: { computer_id: "cmp-1", checkpoint_id: "chk-9" }
    },
    {
      schema_version: 1,
      type: "semantic.event",
      event_id: "sem-2",
      semantic_sequence: 2,
      run_id: RUN_ID,
      pack_id: "steel-recovery",
      name: "computer.paused",
      event_version: 1,
      logical_time: "2026-01-01T00:00:01.000Z",
      caused_by_api_event_id: "evt-8",
      actor: "participant",
      state_revision_before: 5,
      state_revision_after: 6,
      payload_schema: "steel-recovery.computer.paused",
      payload: { computer_id: "cmp-1" }
    }
  ];

  it("counts semantic events with a counted match", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "one_checkpoint",
          kind: "semantic_event",
          weight: 1,
          required: true,
          match: "counted",
          min_count: 1,
          max_count: 1,
          where: 'event.name == "checkpoint.created"'
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document), {
      semanticEvents: SEMANTIC
    });
    const counted = checkOf(result, "one_checkpoint");
    expect(counted.status).toBe("passed");
    expect(counted.eventIds).toEqual(["sem-1"]);
  });

  it("runs ordered steps over documentation events", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "docs_served",
          kind: "documentation_event",
          weight: 1,
          required: true,
          match: "existential",
          where: 'event.outcome == "served"',
          ordered: true,
          steps: [
            { id: "opened", where: 'event.request.path == "/openapi.json"' }
          ]
        }
      ],
      signals: []
    };
    const result = evaluate(loadFixture(document), {
      documentationEvents: [SERVED]
    });
    const docs = checkOf(result, "docs_served");
    expect(docs.status).toBe("passed");
    expect(docs.eventIds).toEqual(["doc-1"]);
    expect(docs.steps[0]?.status).toBe("selected");
  });

  it("requires every event to satisfy a universal match", () => {
    const document: Json = {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "all_served",
          kind: "documentation_event",
          weight: 1,
          required: true,
          match: "universal",
          where: 'event.outcome == "served"'
        }
      ],
      signals: []
    };
    const passing = evaluate(loadFixture(document), {
      documentationEvents: [SERVED]
    });
    expect(checkOf(passing, "all_served").status).toBe("passed");

    const failing = evaluate(loadFixture(document), {
      documentationEvents: [SERVED, documentation("doc-2", 2, "error")]
    });
    expect(checkOf(failing, "all_served").status).toBe("failed");
  });
});

describe("evaluation document conformance", () => {
  it("validates the wire document of a passing run", async () => {
    const validator = new SchemaValidator(await evaluationSchema());
    const document = toEvaluation(evaluate(steelRubric()), {
      evaluator: { name: "@oal/evaluator", version: EVALUATOR_VERSION }
    });
    expect(validator.errors(document as unknown as Json)).toEqual([]);
    expect(document.rubric_id).toBe("steel-recovery");
    expect(document.run_id).toBe(RUN_ID);
    expect(document.rubric_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(document.checks[0]?.captures).toEqual({
      computer_id: "cmp-1",
      clean_sha: CLEAN_SHA,
      checkpoint_id: "chk-9"
    });
  });

  it("keeps the evaluator name and version in the document", () => {
    const document = toEvaluation(evaluate(steelRubric()));
    expect(document.evaluator).toEqual({
      name: EVALUATOR_NAME,
      version: EVALUATOR_VERSION
    });
    expect(document.evaluated_at).toBeUndefined();
  });

  it("records the timestamp it is given", () => {
    const document = toEvaluation(
      evaluate(steelRubric(), { evaluatedAt: "2026-01-01T00:00:09.000Z" })
    );
    expect(document.evaluated_at).toBe("2026-01-01T00:00:09.000Z");
  });

  it("rejects a document that breaks the schema", async () => {
    const validator = new SchemaValidator(await evaluationSchema());
    const document = toEvaluation(evaluate(steelRubric()));
    const broken = {
      ...document,
      status: "unknown",
      checks: [{ id: "bad id!", status: "passed", weight: -1, required: true }]
    } as unknown as Json;
    expect(validator.errors(broken).length).toBeGreaterThan(0);
  });

  it("omits empty evidence arrays from the wire form", () => {
    const document = toEvaluation(evaluate(projectionRubric()));
    const fanOut = document.checks.find((check) => check.id === "fan_out");
    expect(fanOut?.event_ids).toBeUndefined();
    expect(fanOut?.captures).toBeUndefined();
    expect(fanOut?.failed_pointers).toBeUndefined();
    expect(fanOut?.artifact_refs).toBeUndefined();
  });
});

function projectionRubric(): Rubric {
  const result = loadRubric(
    {
      ...STEEL_RECOVERY,
      checks: [
        {
          id: "fan_out",
          kind: "predicate",
          weight: 1,
          required: false,
          expression: "report.fan_out.supported == false"
        }
      ],
      signals: []
    } as Json,
    { resolveSchema: () => RESULT_SCHEMA }
  );
  if (result.rubric === null) {
    throw new Error("The projection fixture did not load.");
  }
  return result.rubric;
}

describe("rubric digest", () => {
  it("depends on the rubric content only", () => {
    const first = evaluate(steelRubric());
    const second = evaluate(loadFixture(STEEL_RECOVERY));
    expect(first.rubricSha256).toBe(second.rubricSha256);
    expect(first.rubricSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
