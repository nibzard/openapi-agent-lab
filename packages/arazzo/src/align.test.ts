import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { alignWorkflow } from "./align.ts";
import type { AlignmentEvent, StepAlignment } from "./align.ts";
import { steelContract } from "./contract.fixture.ts";
import { compileArazzo } from "./compile.ts";
import type { CompiledWorkflow, WorkflowIR } from "./compile.ts";
import { parseArazzo } from "./parse.ts";

const FIXTURE_URL = new URL("./fixtures/steel-workflow.json", import.meta.url);

let steel: string;

beforeAll(async () => {
  steel = await readFile(FIXTURE_URL, "utf8");
});

const CREATE = "path:POST /v1/computers";
const UPLOAD = "path:POST /v1/computers/{computer_id}/files";
const CHECKPOINT = "path:POST /v1/computers/{computer_id}/checkpoints";
const RESTORE =
  "path:POST /v1/computers/{computer_id}/checkpoints/{checkpoint_id}/restore";
const DOWNLOAD = "path:GET /v1/computers/{computer_id}/files/{file_id}";
const PAUSE = "path:POST /v1/computers/{computer_id}/pause";

function event(
  sequence: number,
  operationKey: string,
  status: number,
  body: Record<string, unknown> | null,
  requestBody: Record<string, unknown> | null = null
): AlignmentEvent {
  return {
    sequence,
    operationKey,
    request: requestBody === null ? null : { body: requestBody },
    response: body === null ? null : { status, body }
  };
}

function compileFixture(): CompiledWorkflow {
  const parsed = parseArazzo(steel);
  const document = parsed.document;
  if (document === null) {
    throw new Error(`Parsing failed: ${JSON.stringify(parsed.diagnostics)}`);
  }
  const ir = compileArazzo(document, steelContract());
  const workflow = ir.workflows[0];
  if (workflow === undefined) {
    throw new Error("The fixture compiled to no workflow.");
  }
  return workflow;
}

function compileWorkflow(json: string): CompiledWorkflow {
  const parsed = parseArazzo(json);
  const document = parsed.document;
  if (document === null) {
    throw new Error(`Parsing failed: ${JSON.stringify(parsed.diagnostics)}`);
  }
  const ir: WorkflowIR = compileArazzo(document, steelContract());
  const workflow = ir.workflows[0];
  if (workflow === undefined) {
    throw new Error("The document compiled to no workflow.");
  }
  return workflow;
}

function steps(json: string): string {
  return JSON.stringify({
    arazzo: "1.1.0",
    info: { title: "Fixture", version: "1.0.0" },
    sourceDescriptions: [
      { name: "steel-contract", url: "../contract/openapi.yaml" }
    ],
    workflows: [{ workflowId: "w", steps: JSON.parse(json) as unknown[] }]
  });
}

function summary(alignment: {
  readonly steps: readonly StepAlignment[];
}): Array<[string, string, readonly number[]]> {
  return alignment.steps.map((step) => [
    step.step_id,
    step.outcome,
    step.event_sequences
  ]);
}

const CHAIN_WORKFLOW = steps(`[
  {
    "stepId": "first",
    "operationId": "uploadFile",
    "outputs": { "tag": "$response.body#/sha256" }
  },
  {
    "stepId": "second",
    "operationId": "createComputer",
    "dependsOn": ["first"],
    "successCriteria": [
      { "condition": "$response.body#/template == $steps.first.outputs.tag" }
    ]
  }
]`);

describe("alignWorkflow", () => {
  it("matches the recovery sequence and skips unrelated events", () => {
    const events = [
      event(1, CREATE, 201, {
        id: "c_1",
        template: "system/chrome",
        state: "running"
      }),
      event(2, UPLOAD, 201, { file_id: "f_1", sha256: "clean" }),
      event(3, PAUSE, 200, { id: "c_1", state: "paused" }),
      event(4, CHECKPOINT, 201, { checkpoint_id: "cp_1", sha256: "clean" }),
      event(5, UPLOAD, 201, { file_id: "f_1", sha256: "dirty" }),
      event(6, RESTORE, 200, {
        computer_id: "c_1",
        checkpoint_id: "cp_1",
        sha256: "clean"
      }),
      event(7, DOWNLOAD, 200, { sha256: "clean", content: "aGk=" })
    ];
    const alignment = alignWorkflow(compileFixture(), events);
    expect(alignment.matched).toBe(true);
    expect(alignment.ambiguous).toBe(false);
    expect(alignment.truncated).toBe(false);
    expect(alignment.assignment_count).toBe(1);
    expect(summary(alignment)).toEqual([
      ["create-computer", "matched", [1]],
      ["upload-initial-file", "matched", [2]],
      ["create-checkpoint", "matched", [4]],
      ["upload-changed-file", "matched", [5]],
      ["restore-computer", "matched", [6]],
      ["download-file", "matched", [7]]
    ]);
    const checkpoint = alignment.steps[2];
    expect(checkpoint?.resolved_outputs).toEqual({
      checkpoint_id: "cp_1",
      checkpoint_sha256: "clean"
    });
    expect(checkpoint?.criteria).toEqual([
      {
        condition:
          "$statusCode == 201 && $response.body#/sha256 == $steps.upload-initial-file.outputs.clean_sha256",
        passed: true,
        error: null
      }
    ]);
  });

  it("is deterministic when the events arrive out of order", () => {
    const events = [
      event(7, DOWNLOAD, 200, { sha256: "clean", content: "aGk=" }),
      event(3, PAUSE, 200, { id: "c_1", state: "paused" }),
      event(6, RESTORE, 200, {
        computer_id: "c_1",
        checkpoint_id: "cp_1",
        sha256: "clean"
      }),
      event(5, UPLOAD, 201, { file_id: "f_1", sha256: "dirty" }),
      event(1, CREATE, 201, {
        id: "c_1",
        template: "system/chrome",
        state: "running"
      }),
      event(4, CHECKPOINT, 201, { checkpoint_id: "cp_1", sha256: "clean" }),
      event(2, UPLOAD, 201, { file_id: "f_1", sha256: "clean" })
    ];
    const alignment = alignWorkflow(compileFixture(), events);
    expect(alignment.matched).toBe(true);
    expect(alignment.steps.map((step) => step.event_sequences)).toEqual([
      [1],
      [2],
      [4],
      [5],
      [6],
      [7]
    ]);
  });

  it("reports a failed criterion with evidence", () => {
    const events = [
      event(1, CREATE, 201, {
        id: "c_1",
        template: "system/chrome",
        state: "running"
      }),
      event(2, UPLOAD, 201, { file_id: "f_1", sha256: "clean" }),
      event(4, CHECKPOINT, 201, { checkpoint_id: "cp_1", sha256: "clean" }),
      event(5, UPLOAD, 201, { file_id: "f_1", sha256: "dirty" }),
      event(6, RESTORE, 200, {
        computer_id: "c_1",
        checkpoint_id: "cp_1",
        sha256: "clean"
      }),
      event(7, DOWNLOAD, 200, { sha256: "dirty", content: "YnllYg==" })
    ];
    const alignment = alignWorkflow(compileFixture(), events);
    expect(alignment.matched).toBe(false);
    expect(summary(alignment)).toEqual([
      ["create-computer", "matched", [1]],
      ["upload-initial-file", "matched", [2]],
      ["create-checkpoint", "matched", [4]],
      ["upload-changed-file", "matched", [5]],
      ["restore-computer", "matched", [6]],
      ["download-file", "failed", []]
    ]);
    expect(alignment.steps[5]?.reason).toBe("criteria-failed");
    expect(alignment.steps[5]?.criteria).toEqual([
      {
        condition:
          "{$response.body#/sha256} == {$steps.upload-initial-file.outputs.clean_sha256}",
        passed: false,
        error: null
      }
    ]);
  });

  it("backtracks instead of consuming the first candidate", () => {
    const events = [
      event(10, UPLOAD, 201, { file_id: "f_1", sha256: "aaa" }),
      event(20, CREATE, 201, { id: "c_1", template: "bbb" }),
      event(30, UPLOAD, 201, { file_id: "f_2", sha256: "bbb" }),
      event(40, CREATE, 201, { id: "c_2", template: "bbb" })
    ];
    const alignment = alignWorkflow(compileWorkflow(CHAIN_WORKFLOW), events);
    expect(alignment.matched).toBe(true);
    expect(alignment.assignment_count).toBe(1);
    expect(summary(alignment)).toEqual([
      ["first", "matched", [30]],
      ["second", "matched", [40]]
    ]);
    expect(alignment.candidates_tried).toBeGreaterThan(2);
  });

  it("reports an ambiguous assignment", () => {
    const open = steps(`[
      { "stepId": "first", "operationId": "uploadFile" },
      {
        "stepId": "second",
        "operationId": "createComputer",
        "dependsOn": ["first"]
      }
    ]`);
    const events = [
      event(10, UPLOAD, 201, { file_id: "f_1", sha256: "aaa" }),
      event(20, CREATE, 201, { id: "c_1", template: "t" }),
      event(30, UPLOAD, 201, { file_id: "f_2", sha256: "bbb" }),
      event(40, CREATE, 201, { id: "c_2", template: "t" })
    ];
    const alignment = alignWorkflow(compileWorkflow(open), events);
    expect(alignment.matched).toBe(true);
    expect(alignment.ambiguous).toBe(true);
    expect(alignment.assignment_count).toBe(3);
    expect(summary(alignment)).toEqual([
      ["first", "ambiguous", [10]],
      ["second", "ambiguous", [20]]
    ]);
    expect(alignment.steps[0]?.alternative_sequences).toEqual([30]);
    expect(alignment.steps[1]?.alternative_sequences).toEqual([40]);
  });

  it("skips a step whose dependency chain broke", () => {
    const workflow = steps(`[
      {
        "stepId": "first",
        "operationId": "createComputer",
        "successCriteria": [{ "condition": "$statusCode == 201" }]
      },
      {
        "stepId": "second",
        "operationId": "uploadFile",
        "dependsOn": ["first"]
      }
    ]`);
    const rejected = alignWorkflow(compileWorkflow(workflow), [
      event(1, CREATE, 500, { error: "boom" })
    ]);
    expect(rejected.matched).toBe(false);
    expect(summary(rejected)).toEqual([
      ["first", "failed", []],
      ["second", "skipped", []]
    ]);
    expect(rejected.steps[0]?.reason).toBe("criteria-failed");
    expect(rejected.steps[1]?.reason).toBe("dependency-unmatched");

    const absent = alignWorkflow(compileWorkflow(workflow), [
      event(1, UPLOAD, 201, { file_id: "f_1", sha256: "aaa" })
    ]);
    expect(absent.matched).toBe(false);
    expect(summary(absent)).toEqual([
      ["first", "unmatched", []],
      ["second", "skipped", []]
    ]);
    expect(absent.steps[0]?.reason).toBe("no-candidate-event");
  });

  it("skips a step whose operation did not resolve", () => {
    const workflow = steps(`[
      { "stepId": "first", "operationId": "missingOperation" },
      {
        "stepId": "second",
        "operationId": "uploadFile",
        "dependsOn": ["first"]
      }
    ]`);
    const alignment = alignWorkflow(compileWorkflow(workflow), [
      event(1, UPLOAD, 201, { file_id: "f_1", sha256: "aaa" })
    ]);
    expect(alignment.matched).toBe(false);
    expect(summary(alignment)).toEqual([
      ["first", "skipped", []],
      ["second", "skipped", []]
    ]);
    expect(alignment.steps[0]?.reason).toBe("operation-unresolved");
  });

  it("resolves workflow inputs inside criteria", () => {
    const workflow = steps(`[
      {
        "stepId": "first",
        "operationId": "createComputer",
        "successCriteria": [
          { "condition": "$response.body#/template == $inputs.template" }
        ]
      }
    ]`);
    const events = [
      event(1, CREATE, 201, { id: "c_1", template: "system/chrome" })
    ];
    const withInput = alignWorkflow(compileWorkflow(workflow), events, {
      inputs: { template: "system/chrome" }
    });
    expect(withInput.matched).toBe(true);
    expect(withInput.steps[0]?.outcome).toBe("matched");

    const withoutInput = alignWorkflow(compileWorkflow(workflow), events);
    expect(withoutInput.matched).toBe(false);
    expect(withoutInput.steps[0]?.outcome).toBe("failed");
  });

  it("stops the search inside the candidate budget", () => {
    const open = steps(`[
      { "stepId": "first", "operationId": "uploadFile" },
      {
        "stepId": "second",
        "operationId": "uploadFile",
        "dependsOn": ["first"]
      }
    ]`);
    const events = Array.from({ length: 8 }, (_, index) =>
      event(index + 1, UPLOAD, 201, {
        file_id: `f_${String(index)}`,
        sha256: "s"
      })
    );
    const alignment = alignWorkflow(compileWorkflow(open), events, {
      maxCandidates: 4
    });
    expect(alignment.truncated).toBe(true);
    expect(alignment.assignment_count).toBe(3);
    expect(alignment.candidates_tried).toBeLessThanOrEqual(5);
  });
});
