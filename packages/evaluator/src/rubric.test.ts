import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SchemaValidator, type Diagnostic, type Json } from "@oal/core";
import { loadRubric, type Rubric } from "./rubric.ts";

const RUBRIC_SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "rubric.v1.schema.json"
);

/**
 * A compact but complete rubric. It uses every field the schema
 * requires for a sequence check, a predicate check, and a signal.
 */
const SAMPLE_CHECKS: Json[] = [
  {
    id: "recovery_flow",
    description: "The same computer returns to the verified clean bytes",
    kind: "sequence",
    weight: 8,
    required: true,
    evidence_class: "participant_observable",
    match: "any",
    max_candidates: 10000,
    steps: [
      {
        id: "create",
        where:
          'event.operation.operation_id == "createComputer" && ' +
          "event.response.status >= 200 && event.response.status < 300",
        capture: { computer_id: "event.response.body.value.id" }
      },
      {
        id: "initial_write",
        where:
          'event.operation.operation_id == "uploadFile" && ' +
          "event.request.path_parameters.computer_id == vars.computer_id"
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
    id: "fan_out_reported",
    kind: "predicate",
    weight: 1,
    required: false,
    evidence_class: "participant_observable",
    expression: "report.fan_out.supported == false"
  }
];

const SAMPLE_SIGNALS: Json[] = [
  {
    id: "first_call_is_create",
    kind: "predicate",
    expression: 'events[0].operation.operation_id == "createComputer"'
  }
];

const SAMPLE_RUBRIC: Json = {
  rubric_version: 1,
  id: "steel-recovery",
  description: "Prepare, checkpoint, alter, restore, and pause one computer",
  scoring: { method: "weighted_binary", pass_threshold: 0.9 },
  checks: SAMPLE_CHECKS,
  signals: SAMPLE_SIGNALS
};

async function schema(): Promise<Json> {
  return JSON.parse(await readFile(RUBRIC_SCHEMA_PATH, "utf8")) as Json;
}

function errorsOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

async function load(document: Json, options: Record<string, unknown> = {}) {
  return loadRubric(document, {
    schema: await schema(),
    ...options
  });
}

describe("rubric schema conformance", () => {
  it("accepts the sample rubric", async () => {
    const validator = new SchemaValidator(await schema());
    expect(validator.errors(SAMPLE_RUBRIC)).toEqual([]);
  });

  it("rejects a rubric that misses required fields", async () => {
    const validator = new SchemaValidator(await schema());
    const violations = validator.errors({
      rubric_version: 1,
      id: "broken",
      scoring: { method: "weighted_binary", pass_threshold: 0.5 },
      checks: [{ id: "a", kind: "predicate", weight: 1, required: true }],
      signals: []
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("loadRubric", () => {
  it("loads a valid rubric without error diagnostics", async () => {
    const result = await load(SAMPLE_RUBRIC);
    expect(result.rubric).not.toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual([]);
    const rubric: Rubric = result.rubric as Rubric;
    expect(rubric.id).toBe("steel-recovery");
    expect(rubric.checks).toHaveLength(2);
    expect(rubric.signals).toHaveLength(1);
    const flow = rubric.checks[0];
    if (flow?.kind !== "sequence") {
      throw new Error("The first sample check is not a sequence.");
    }
    expect(flow.steps).toHaveLength(2);
    expect(flow.postconditions).toHaveLength(1);
  });

  it("reports a warning when a check declares no evidence class", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "bare",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "state.ready == true"
        }
      ]
    });
    expect(result.rubric).not.toBeNull();
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning"
      )
    ).toHaveLength(1);
  });

  it("rejects a duplicate check id", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        ...SAMPLE_CHECKS,
        {
          id: "recovery_flow",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "state.ready == true"
        }
      ]
    });
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects a duplicate signal id", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      signals: [
        ...SAMPLE_SIGNALS,
        {
          id: "first_call_is_create",
          kind: "predicate",
          expression: "state.ready == true"
        }
      ]
    });
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects a duplicate step id inside one check", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "flow",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [
            { id: "same", where: "true" },
            { id: "same", where: "true" }
          ]
        }
      ]
    });
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects a capture name bound by two steps", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "flow",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [
            { id: "one", where: "true", capture: { key: "event.event_id" } },
            { id: "two", where: "true", capture: { key: "event.sequence" } }
          ]
        }
      ]
    });
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects weights that are negative or all zero", async () => {
    const negative = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "negative",
          kind: "predicate",
          weight: -1,
          required: true,
          expression: "true"
        }
      ]
    });
    expect(negative.rubric).toBeNull();
    const zero = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "zero",
          kind: "predicate",
          weight: 0,
          required: true,
          expression: "true"
        }
      ]
    });
    expect(zero.rubric).toBeNull();
    expect(errorsOf(zero.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects a pass threshold outside the unit interval", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      scoring: { method: "weighted_binary", pass_threshold: 1.5 }
    });
    expect(result.rubric).toBeNull();
  });

  it("rejects an unknown scoring method", async () => {
    const result = loadRubric(
      {
        ...SAMPLE_RUBRIC,
        scoring: { method: "sum_of_weights", pass_threshold: 1 }
      },
      { schema: await schema() }
    );
    expect(result.rubric).toBeNull();
    // The schema enum and the semantic check both report the problem.
    expect(errorsOf(result.diagnostics).length).toBeGreaterThan(0);
    expect(new Set(errorsOf(result.diagnostics))).toEqual(
      new Set(["OAL-RUBRIC-INVALID"])
    );
  });

  it("rejects an unsupported schema version", async () => {
    const result = await load({ ...SAMPLE_RUBRIC, rubric_version: 2 });
    expect(result.rubric).toBeNull();
  });

  it("rejects an unknown check kind", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "odd",
          kind: "model_judge",
          weight: 1,
          required: true,
          expression: "true"
        }
      ]
    });
    expect(result.rubric).toBeNull();
  });

  it("rejects a counted check without a count bound", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "counted",
          kind: "event",
          weight: 1,
          required: true,
          match: "counted",
          where: "true"
        }
      ]
    });
    expect(result.rubric).toBeNull();
  });

  it("rejects ordered steps without the ordered flag", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "docs",
          kind: "documentation_event",
          weight: 1,
          required: true,
          match: "existential",
          where: 'event.outcome == "served"',
          steps: [{ id: "one", where: "true" }]
        }
      ]
    });
    expect(result.rubric).toBeNull();
  });

  it("rejects a json_schema reference that traverses outside the pack", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "report_shape",
          kind: "json_schema",
          weight: 1,
          required: true,
          value: "report",
          schema: "../../schemas/escape.json"
        }
      ]
    });
    expect(result.rubric).toBeNull();
  });

  it("rejects a json_schema reference the resolver cannot load", async () => {
    const result = await load(
      {
        ...SAMPLE_RUBRIC,
        checks: [
          {
            id: "report_shape",
            kind: "json_schema",
            weight: 1,
            required: true,
            value: "report",
            schema: "result.schema.json"
          }
        ]
      },
      { resolveSchema: () => undefined }
    );
    expect(result.rubric).toBeNull();
  });

  it("accepts a json_schema reference the resolver can load", async () => {
    const result = await load(
      {
        ...SAMPLE_RUBRIC,
        checks: [
          {
            id: "report_shape",
            kind: "json_schema",
            weight: 1,
            required: true,
            value: "report",
            schema: "result.schema.json"
          }
        ]
      },
      { resolveSchema: () => ({ type: "object" }) as Json }
    );
    expect(result.rubric).not.toBeNull();
  });
});

describe("rubric expression compilation", () => {
  it("rejects an expression that does not parse", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "broken",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "state.ready == "
        }
      ]
    });
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EXPRESSION-SYNTAX"]);
  });

  it("rejects a forbidden host global in an expression", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "unsafe",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "process.env.HOME != null"
        }
      ]
    });
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EXPRESSION-FORBIDDEN"]);
  });

  it("rejects a variable that the position does not expose", async () => {
    const stepUsesState = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "flow",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [{ id: "one", where: "state.ready == true" }]
        }
      ]
    });
    expect(stepUsesState.rubric).toBeNull();

    const predicateUsesEvent = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "mixed",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: 'event.operation.operation_id == "createComputer"'
        }
      ]
    });
    expect(predicateUsesEvent.rubric).toBeNull();
  });

  it("rejects a postcondition that reads the event variable", async () => {
    const result = await load({
      ...SAMPLE_RUBRIC,
      checks: [
        {
          id: "flow",
          kind: "sequence",
          weight: 1,
          required: true,
          match: "any",
          steps: [{ id: "one", where: "true" }],
          postconditions: [
            { id: "after", expression: "event.response.status == 200" }
          ]
        }
      ]
    });
    expect(result.rubric).toBeNull();
  });

  it("applies the expression limits it is given", async () => {
    const long = `state.counter + ${"1 + ".repeat(40)}1`;
    const result = await load(
      {
        ...SAMPLE_RUBRIC,
        checks: [
          {
            id: "long",
            kind: "predicate",
            weight: 1,
            required: true,
            expression: long
          }
        ]
      },
      { limits: { maxSourceLength: 64 } }
    );
    expect(result.rubric).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EXPRESSION-LENGTH"]);
  });
});
