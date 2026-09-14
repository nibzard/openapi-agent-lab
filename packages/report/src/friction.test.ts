import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SchemaValidator, stableJsonStringify, type Json } from "@oal/core";
import type { TraceBody, TraceEvent } from "@oal/evidence";

import {
  buildFrictionReport,
  type FrictionBuildInput,
  type FrictionReport,
  type FrictionTrialInput
} from "./friction.ts";
import { traceError, traceEvent } from "./fixtures.ts";

const FRICTION_SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "friction.v1.schema.json"
);

async function loadSchema(): Promise<Json> {
  return JSON.parse(await readFile(FRICTION_SCHEMA_PATH, "utf8")) as Json;
}

const SCOPE = { level: "batch" as const, id: "test-batch" };

const CREATE_OP = {
  matched: true,
  key: "path:POST /v1/clips",
  uid: "op-1",
  operation_id: "create_clip",
  method: "POST",
  path_template: "/v1/clips"
};

const GET_CLIP_OP = {
  matched: true,
  key: "path:GET /v1/clips/{clipId}",
  uid: "op-2",
  operation_id: "get_clip",
  method: "GET",
  path_template: "/v1/clips/{clipId}"
};

const LIST_OP = {
  matched: true,
  key: "path:GET /v1/clips",
  uid: "op-3",
  operation_id: "list_clips",
  method: "GET",
  path_template: "/v1/clips"
};

const UNMATCHED_OP = {
  matched: false,
  key: null,
  uid: null,
  operation_id: null,
  method: null,
  path_template: null
};

function backendOf(
  overrides: {
    provenance?: "fixture" | "behavior" | "example" | "generated";
    approximation?: string | null;
  } = {}
): TraceEvent["backend"] {
  return {
    mode: "contract",
    name: null,
    outcome: "handled",
    duration_ms: 1,
    response_provenance: overrides.provenance ?? "generated",
    effects: [],
    observations:
      overrides.approximation === undefined
        ? {}
        : { approximation: overrides.approximation }
  };
}

function jsonBody(value: Json): TraceBody {
  return { kind: "json", size_bytes: 16, value, truncated: false };
}

/** Patches the fixed response body of a fixture event. */
function responseBody(event: TraceEvent, value: Json): TraceEvent {
  if (event.response !== null) {
    event.response.body = jsonBody(value);
  }
  return event;
}

function build(trials: readonly FrictionTrialInput[]): FrictionReport {
  return buildFrictionReport({ scope: SCOPE, trials });
}

function schemaRejected(sequence: number, runId = "run-1"): TraceEvent {
  return responseBody(
    traceEvent({
      sequence,
      runId,
      method: "POST",
      path: "/v1/clips",
      status: 422,
      error: traceError("validation", "request_schema_invalid"),
      operation: CREATE_OP
    }),
    {
      violations: [
        {
          location: "body",
          pointer: "/format",
          code: "enum",
          message: "value must be one of the declared enum"
        }
      ]
    }
  );
}

describe("buildFrictionReport detectors", () => {
  it("classes a request schema rejection as spec friction with the violation pointer", () => {
    const report = build([
      { runId: "run-1", events: [schemaRejected(3)] },
      { runId: "run-2", events: [schemaRejected(2, "run-2")] }
    ]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "request_schema_rejected"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("spec_friction");
    expect(incident?.origin).toBe("api");
    expect(incident?.trials).toEqual(["run-1", "run-2"]);
    expect(incident?.occurrences).toBe(2);
    expect(incident?.evidence[0]?.request_shape).toBe(
      "/format: value must be one of the declared enum"
    );
    expect(report.worklist).toHaveLength(1);
    expect(report.worklist[0]?.action).toBe("add_enum_values");
    expect(report.worklist[0]?.operation).toBe("path:POST /v1/clips");
    expect(report.operations[0]?.framework_codes).toEqual([
      { code: "request_schema_invalid", status: 422, count: 2 }
    ]);
  });

  it("detects an escalation that shape descriptors alone would miss", () => {
    const events = [
      traceEvent({
        sequence: 1,
        method: "POST",
        path: "/v1/clips",
        status: 422,
        error: traceError("validation", "request_schema_invalid"),
        body: jsonBody({ keys: ["CTRL"] }),
        operation: CREATE_OP
      }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/clips",
        status: 422,
        error: traceError("validation", "request_schema_invalid"),
        body: jsonBody({ keys: ["ENT"] }),
        operation: CREATE_OP
      }),
      traceEvent({
        sequence: 3,
        method: "POST",
        path: "/v1/clips",
        status: 201,
        body: jsonBody({ keys: ["ctrl+c"] }),
        operation: CREATE_OP,
        backend: backendOf({ provenance: "generated" })
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "escalation"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("mock_fidelity");
    expect(incident?.evidence[0]?.provenance).toBe("generated");
    expect(incident?.evidence[0]?.request_shape).toBe('{"keys":["keys"]}');
    const operation = report.operations.find(
      (candidate) => candidate.operation === "path:POST /v1/clips"
    );
    expect(operation?.distinct_request_shapes).toBe(1);
    expect(operation?.escalated).toBe(true);
    expect(operation?.first_success_attempt).toBe(3);
    expect(operation?.attempts_to_first_2xx).toBe(3);
    const item = report.worklist.find(
      (candidate) => candidate.action === "author_fixture"
    );
    expect(item?.fixture).toEqual({
      status: 201,
      media_type: "application/json",
      body_kind: "json_file"
    });
  });

  it("classes an escalation satisfied by authored content as spec friction", () => {
    const events = [
      traceEvent({
        sequence: 1,
        method: "POST",
        path: "/v1/clips",
        status: 422,
        error: traceError("validation", "request_schema_invalid"),
        body: jsonBody({ format: "png" }),
        operation: CREATE_OP
      }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/clips",
        status: 201,
        body: jsonBody({ format: "markdown" }),
        operation: CREATE_OP,
        backend: backendOf({ provenance: "fixture" })
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "escalation"
    );
    expect(incident?.class).toBe("spec_friction");
    expect(
      report.worklist.some((candidate) => candidate.action === "author_fixture")
    ).toBe(false);
    expect(
      report.worklist.some((candidate) => candidate.action === "investigate")
    ).toBe(true);
  });

  it("keys an escalation incident by operation and class", () => {
    const rejection = (sequence: number, runId: string): TraceEvent =>
      traceEvent({
        sequence,
        runId,
        method: "POST",
        path: "/v1/clips",
        status: 422,
        body: jsonBody({ format: "png" }),
        operation: CREATE_OP
      });
    const satisfied = (
      sequence: number,
      runId: string,
      provenance: "fixture" | "generated"
    ): TraceEvent =>
      traceEvent({
        sequence,
        runId,
        method: "POST",
        path: "/v1/clips",
        status: 201,
        body: jsonBody({ format: "markdown" }),
        operation: CREATE_OP,
        backend: backendOf({ provenance })
      });
    const report = build([
      {
        runId: "run-1",
        events: [rejection(1, "run-1"), satisfied(2, "run-1", "fixture")]
      },
      {
        runId: "run-2",
        events: [rejection(1, "run-2"), satisfied(2, "run-2", "generated")]
      }
    ]);
    const escalations = report.incidents
      .filter((candidate) => candidate.kind === "escalation")
      .map((incident) => ({
        id: incident.id,
        class: incident.class,
        trials: incident.trials
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(escalations).toHaveLength(2);
    expect(escalations[0]).toEqual({
      id: "inc_escalation_post_v1_clips_mock_fidelity",
      class: "mock_fidelity",
      trials: ["run-2"]
    });
    expect(escalations[1]).toEqual({
      id: "inc_escalation_post_v1_clips_spec_friction",
      class: "spec_friction",
      trials: ["run-1"]
    });
    expect(report.counts.incidents_by_kind.escalation).toBe(2);
    expect(
      report.worklist.filter((item) => item.action === "author_fixture")
    ).toHaveLength(1);
    expect(
      report.worklist.filter((item) => item.action === "investigate")
    ).toHaveLength(1);
  });

  it("detects an identical unchanged retry", () => {
    const events = [
      traceEvent({
        sequence: 1,
        method: "POST",
        path: "/v1/clips",
        status: 500,
        error: traceError("internal", "internal_error"),
        body: jsonBody({ url: "https://example.com" }),
        operation: CREATE_OP
      }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/clips",
        status: 500,
        error: traceError("internal", "internal_error"),
        body: jsonBody({ url: "https://example.com" }),
        operation: CREATE_OP
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "identical_retry"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("unknown");
    expect(incident?.origin).toBe("api");
    const operation = report.operations[0];
    expect(operation?.identical_retries).toBe(1);
    expect(report.worklist).toEqual([]);
  });

  it("detects abandonment when later calls elsewhere succeed", () => {
    const events = [
      traceEvent({
        sequence: 1,
        path: "/v1/clips/missing",
        status: 404,
        operation: GET_CLIP_OP
      }),
      traceEvent({
        sequence: 2,
        path: "/v1/account",
        status: 200,
        backend: backendOf({ provenance: "fixture" })
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "abandonment"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("unknown");
    expect(incident?.operation).toBe("path:GET /v1/clips/{clipId}");
    expect(incident?.evidence[0]?.sequence).toBe(1);
    const operation = report.operations.find(
      (candidate) => candidate.operation === "path:GET /v1/clips/{clipId}"
    );
    expect(operation?.abandoned).toBe(true);
    expect(report.worklist).toHaveLength(1);
    expect(report.worklist[0]?.action).toBe("investigate");
  });

  it("matches an unmatched route to its declared near miss", () => {
    const events = [
      traceEvent({
        sequence: 1,
        method: "POST",
        path: "/v1/sessions",
        status: 201,
        operation: {
          matched: true,
          key: "path:POST /v1/sessions",
          uid: "op-9",
          operation_id: "create_session",
          method: "POST",
          path_template: "/v1/sessions"
        }
      }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/sessions/",
        status: 404,
        error: traceError("routing", "route_not_found"),
        operation: UNMATCHED_OP
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "route_unmatched"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("spec_friction");
    expect(incident?.near_miss_of).toBe("path:POST /v1/sessions");
    expect(incident?.id).toBe("inc_route_unmatched_post_v1_sessions");
    const unmatched = report.operations.find(
      (candidate) => candidate.operation === "unmatched:POST /v1/sessions/"
    );
    expect(unmatched?.status_counts).toEqual({ "404": 1 });
    expect(
      report.worklist.some(
        (candidate) => candidate.action === "normalize_route"
      )
    ).toBe(true);
  });

  it("attributes quota refusals to the harness and never the worklist", () => {
    const events = [
      traceEvent({ sequence: 1, path: "/v1/clips", status: 200 }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/clips",
        status: 429,
        error: traceError("internal", "request_quota_exceeded"),
        operation: CREATE_OP
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "quota_exceeded"
    );
    expect(incident).toBeDefined();
    expect(incident?.class).toBe("harness");
    expect(incident?.origin).toBe("harness");
    expect(incident?.operation).toBe(null);
    expect(incident?.id).toBe("inc_quota_exceeded_run_1");
    expect(report.worklist).toEqual([]);
    expect(report.trials[0]?.failed_exchanges).toBe(1);
    expect(report.counts.incidents_by_class.harness).toBe(1);
  });

  it("classes mock framework errors as mock fidelity", () => {
    const invalid = build([
      {
        runId: "run-1",
        events: [
          traceEvent({
            sequence: 1,
            path: "/v1/clips/x",
            status: 500,
            error: traceError("behavior", "mock_response_invalid"),
            operation: GET_CLIP_OP
          })
        ]
      }
    ]);
    const incident = invalid.incidents.find(
      (candidate) => candidate.kind === "framework_error"
    );
    expect(incident?.class).toBe("mock_fidelity");
    expect(incident?.evidence[0]?.code).toBe("mock_response_invalid");
    expect(invalid.worklist[0]?.action).toBe("investigate");

    const unavailable = build([
      {
        runId: "run-1",
        events: [
          traceEvent({
            sequence: 1,
            path: "/v1/clips/x/extract",
            method: "POST",
            status: 500,
            error: traceError("behavior", "mock_behavior_unavailable"),
            operation: {
              matched: true,
              key: "path:POST /v1/clips/{clipId}/extract",
              uid: "op-7",
              operation_id: "extract_text",
              method: "POST",
              path_template: "/v1/clips/{clipId}/extract"
            }
          })
        ]
      }
    ]);
    const item = unavailable.worklist[0];
    expect(item?.action).toBe("requires_behavior_backend");
    expect(item?.requires_behavior_backend).toBe(true);
  });

  it("detects a generated handle reused as a path segment", () => {
    const events = [
      responseBody(
        traceEvent({
          sequence: 1,
          path: "/v1/clips",
          status: 200,
          operation: LIST_OP,
          backend: backendOf({ provenance: "generated" })
        }),
        { items: [], next: "gen_c3" }
      ),
      traceEvent({
        sequence: 2,
        path: "/v1/clips/gen_c3",
        status: 200,
        operation: GET_CLIP_OP,
        backend: backendOf({ provenance: "generated" })
      })
    ];
    const report = build([{ runId: "run-1", events }]);
    const incident = report.incidents.find(
      (candidate) => candidate.kind === "generated_handle_reuse"
    );
    expect(incident).toBeDefined();
    expect(incident?.operation).toBe("path:GET /v1/clips");
    expect(incident?.evidence).toHaveLength(2);
    expect(incident?.evidence[0]?.sequence).toBe(1);
    expect(incident?.evidence[1]?.sequence).toBe(2);
    expect(incident?.evidence[1]?.request_shape).toBe("gen_c3");
    expect(report.worklist[0]?.action).toBe("author_fixture");
    expect(report.worklist[0]?.fixture?.media_type).toBe("application/json");
  });

  it("merges handle reuse from one issuer into a single incident", () => {
    const events = [
      responseBody(
        traceEvent({
          sequence: 1,
          path: "/v1/clips",
          status: 200,
          operation: LIST_OP,
          backend: backendOf({ provenance: "generated" })
        }),
        { items: [], first: "gen_c1", second: "gen_c2", third: "gen_c3" }
      ),
      ...["gen_c1", "gen_c2", "gen_c3"].map((handle, index) =>
        traceEvent({
          sequence: index + 2,
          path: `/v1/clips/${handle}`,
          status: 200,
          operation: GET_CLIP_OP,
          backend: backendOf({ provenance: "generated" })
        })
      )
    ];
    const report = build([{ runId: "run-1", events }]);
    const incidents = report.incidents.filter(
      (candidate) => candidate.kind === "generated_handle_reuse"
    );
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    expect(incident?.operation).toBe("path:GET /v1/clips");
    expect(incident?.occurrences).toBe(3);
    expect(incident?.trials).toEqual(["run-1"]);
    expect(incident?.evidence.map((row) => row.sequence)).toEqual([
      1, 2, 1, 3, 1, 4
    ]);
    expect(incident?.evidence.map((row) => row.request_shape)).toEqual([
      "gen_c1",
      "gen_c1",
      "gen_c2",
      "gen_c2",
      "gen_c3",
      "gen_c3"
    ]);
    expect(report.counts.incidents).toBe(1);
    expect(report.counts.incidents_by_kind.generated_handle_reuse).toBe(1);
  });

  it("counts the provenance mix, approximation markers, and tolerates old traces", () => {
    const events = [
      traceEvent({
        sequence: 1,
        status: 200,
        backend: backendOf({ provenance: "fixture" })
      }),
      traceEvent({
        sequence: 2,
        method: "POST",
        path: "/v1/clips",
        status: 200,
        operation: CREATE_OP,
        backend: backendOf({
          provenance: "example",
          approximation: "example_invalid_skipped:1"
        })
      }),
      traceEvent({ sequence: 3, status: 200 })
    ];
    const report = build([{ runId: "run-1", events }]);
    const operation = report.operations.find(
      (candidate) => candidate.operation === "path:POST /v1/clips"
    );
    expect(operation?.provenance_mix).toEqual({
      fixture: 0,
      example: 1,
      generated: 0
    });
    expect(operation?.approximations).toEqual(["example_invalid_skipped:1"]);
    expect(report.counts.exchanges).toBe(3);
    expect(report.incidents).toEqual([]);
    expect(report.worklist).toEqual([]);
  });

  it("returns zeroed counts for an empty scope", () => {
    const report = buildFrictionReport({ scope: SCOPE, trials: [] });
    expect(report.counts).toEqual({
      trials: 0,
      exchanges: 0,
      operations: 0,
      incidents: 0,
      incidents_by_class: {
        spec_friction: 0,
        mock_fidelity: 0,
        harness: 0,
        unknown: 0
      },
      incidents_by_kind: {},
      worklist_items: 0
    });
    expect(report.operations).toEqual([]);
    expect(report.incidents).toEqual([]);
    expect(report.worklist).toEqual([]);
  });
});

describe("buildFrictionReport contract", () => {
  const input: FrictionBuildInput = {
    scope: SCOPE,
    trials: [
      { runId: "run-1", events: [schemaRejected(3), ...escalationChain()] },
      { runId: "run-2", events: [schemaRejected(2, "run-2")] }
    ]
  };

  function escalationChain(): TraceEvent[] {
    return [
      traceEvent({
        sequence: 4,
        method: "POST",
        path: "/v1/clips",
        status: 201,
        body: jsonBody({ format: "markdown" }),
        operation: CREATE_OP,
        backend: backendOf({ provenance: "generated" })
      })
    ];
  }

  it("is deterministic across builds and omits generated_at unless given", () => {
    const first = buildFrictionReport(input);
    const second = buildFrictionReport(input);
    expect(stableJsonStringify(first as unknown as Json)).toBe(
      stableJsonStringify(second as unknown as Json)
    );
    expect("generated_at" in first).toBe(false);
    const stamped = buildFrictionReport({
      ...input,
      generatedAt: "2026-08-30T12:00:00.000Z"
    });
    expect(stamped.generated_at).toBe("2026-08-30T12:00:00.000Z");
  });

  it("produces reports that validate against friction.v1", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const violations = validator.errors(
      buildFrictionReport(input) as unknown as Json
    );
    expect(violations).toEqual([]);
  });

  it("produces an empty report that validates against friction.v1", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const violations = validator.errors(
      buildFrictionReport({ scope: SCOPE, trials: [] }) as unknown as Json
    );
    expect(violations).toEqual([]);
  });
});

describe("buildFrictionReport over externally recorded trials", () => {
  /** One serve session trace: a rejection, then a later success. */
  function externalTrace(): TraceEvent[] {
    return [
      schemaRejected(1, "manual-20260831-085950"),
      traceEvent({
        sequence: 2,
        runId: "manual-20260831-085950",
        method: "POST",
        path: "/v1/clips",
        status: 201,
        body: jsonBody({ url: "https://example.com" }),
        operation: CREATE_OP
      })
    ];
  }

  it("labels every api-origin incident of an external trial external", () => {
    const report = build([
      {
        runId: "manual-20260831-085950",
        events: externalTrace(),
        source: "external"
      }
    ]);
    expect(report.incidents.length).toBeGreaterThan(0);
    for (const incident of report.incidents) {
      if (incident.kind === "quota_exceeded") {
        continue;
      }
      expect(incident.origin).toBe("external");
    }
    const rejected = report.incidents.find(
      (candidate) => candidate.kind === "request_schema_rejected"
    );
    expect(rejected?.origin).toBe("external");
  });

  it("classes an external escalation as spec friction, not mock fidelity", () => {
    const report = build([
      { runId: "manual-1", events: externalTrace(), source: "external" }
    ]);
    const escalation = report.incidents.find(
      (candidate) => candidate.kind === "escalation"
    );
    expect(escalation).toBeDefined();
    expect(escalation?.class).toBe("spec_friction");
    expect(
      report.worklist.some((item) => item.action === "author_fixture")
    ).toBe(false);
    const operation = report.operations.find(
      (candidate) => candidate.operation === "path:POST /v1/clips"
    );
    // No lab mock served the exchange, so no provenance is claimed.
    expect(operation?.provenance_mix).toEqual({
      fixture: 0,
      example: 0,
      generated: 0
    });
  });

  it("keeps runner trials on origin api when no source is given", () => {
    const report = build([{ runId: "run-1", events: [schemaRejected(1)] }]);
    expect(report.incidents[0]?.origin).toBe("api");
  });

  it("produces external reports that validate against friction.v1", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const violations = validator.errors(
      build([
        {
          runId: "manual-20260831-085950",
          events: [
            ...externalTrace(),
            traceEvent({
              sequence: 3,
              runId: "manual-20260831-085950",
              method: "GET",
              path: "/v1/unknown",
              status: 404,
              error: traceError("routing", "route_not_found"),
              operation: UNMATCHED_OP
            })
          ],
          source: "external"
        }
      ]) as unknown as Json
    );
    expect(violations).toEqual([]);
  });
});
