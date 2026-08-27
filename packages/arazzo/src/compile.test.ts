import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import type { ContractIR, OperationIR } from "@oal/contract-ir";
import { operationUid } from "@oal/core";

import { steelContract } from "./contract.fixture.ts";
import { ArazzoCode } from "./codes.ts";
import { compileArazzo } from "./compile.ts";
import type { WorkflowIR } from "./compile.ts";
import { parseArazzo } from "./parse.ts";

const FIXTURE_URL = new URL("./fixtures/steel-workflow.json", import.meta.url);

let steel: string;

beforeAll(async () => {
  steel = await readFile(FIXTURE_URL, "utf8");
});

function errors(ir: WorkflowIR): string[] {
  return ir.diagnostics
    .filter((entry) => entry.severity === "error")
    .map((entry) => entry.code);
}

function warnings(ir: WorkflowIR): string[] {
  return ir.diagnostics
    .filter((entry) => entry.severity === "warning")
    .map((entry) => entry.code);
}

/** Parse and compile one JSON document against one contract. */
function compile(
  json: string,
  contract: ContractIR = steelContract()
): WorkflowIR {
  const parsed = parseArazzo(json);
  if (parsed.document === null) {
    throw new Error(`Parsing failed: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return compileArazzo(parsed.document, contract, {
    documentUri: "steel-workflow.json"
  });
}

function doc(steps: unknown[]): string {
  return JSON.stringify({
    arazzo: "1.1.0",
    info: { title: "Fixture", version: "1.0.0" },
    sourceDescriptions: [
      { name: "steel-contract", url: "../contract/openapi.yaml" }
    ],
    workflows: [{ workflowId: "w", steps }]
  });
}

function one(ir: WorkflowIR): WorkflowIR["workflows"][number] {
  const workflow = ir.workflows[0];
  if (workflow === undefined) {
    throw new Error("The compiler produced no workflow.");
  }
  return workflow;
}

function stepOf(
  ir: WorkflowIR,
  stepId: string
): WorkflowIR["workflows"][number]["steps"][number] {
  const step = one(ir).steps.find((entry) => entry.step_id === stepId);
  if (step === undefined) {
    throw new Error(`Step '${stepId}' was not compiled.`);
  }
  return step;
}

describe("compileArazzo", () => {
  it("compiles the steel fixture without diagnostics", () => {
    const ir = compile(steel);
    expect(ir.diagnostics).toEqual([]);
    expect(ir.schema_version).toBe(1);
    expect(ir.kind).toBe("WorkflowIR");
    expect(ir.compiler.name).toBe("oal-arazzo");
    expect(ir.source.arazzo_version).toBe("1.1.0");
    expect(ir.source.source_descriptions).toEqual(["steel-contract"]);
  });

  it("orders steps by dependency and maps canonical keys", () => {
    const ir = compile(steel);
    expect(one(ir).steps.map((step) => step.step_id)).toEqual([
      "create-computer",
      "upload-initial-file",
      "create-checkpoint",
      "upload-changed-file",
      "restore-computer",
      "download-file"
    ]);
    expect(one(ir).steps.map((step) => step.operation_key)).toEqual([
      "path:POST /v1/computers",
      "path:POST /v1/computers/{computer_id}/files",
      "path:POST /v1/computers/{computer_id}/checkpoints",
      "path:POST /v1/computers/{computer_id}/files",
      "path:POST /v1/computers/{computer_id}/checkpoints/{checkpoint_id}/restore",
      "path:GET /v1/computers/{computer_id}/files/{file_id}"
    ]);
    expect(stepOf(ir, "download-file").depends_on).toEqual([
      "restore-computer"
    ]);
    expect(stepOf(ir, "restore-computer").source_index).toBe(4);
  });

  it("binds parameters, bodies, criteria, and outputs", () => {
    const ir = compile(steel);
    const upload = stepOf(ir, "upload-initial-file");
    expect(upload.parameters[0]?.name).toBe("computer_id");
    expect(upload.parameters[0]?.location).toBe("path");
    expect(upload.parameters[0]?.binding).toEqual({
      kind: "template",
      text: "{$steps.create-computer.outputs.computer_id}",
      parts: [
        {
          expression: "$steps.create-computer.outputs.computer_id",
          source: {
            kind: "step_output",
            stepId: "create-computer",
            name: "computer_id",
            pointer: ""
          }
        }
      ]
    });
    expect(upload.request_body?.content_type).toBe("application/octet-stream");
    expect(upload.request_body?.binding).toEqual({
      kind: "template",
      text: "{$inputs.initial_bytes}",
      parts: [
        {
          expression: "$inputs.initial_bytes",
          source: { kind: "input", name: "initial_bytes", pointer: "" }
        }
      ]
    });
    const create = stepOf(ir, "create-computer");
    expect(create.request_body?.binding).toEqual({
      kind: "literal",
      value: { template: "system/chrome", label: "{$inputs.label}" }
    });
    expect(create.criteria[0]?.condition).toContain("$statusCode == 201");
    expect(create.outputs).toEqual([
      {
        name: "computer_id",
        text: "$response.body#/id",
        source: { kind: "response_body", pointer: "/id" }
      }
    ]);
    expect(one(ir).outputs.map((output) => output.name)).toEqual([
      "computer_id",
      "recovered_sha256"
    ]);
  });

  it("resolves every operation reference form", () => {
    const ir = compile(
      doc([
        {
          stepId: "braced",
          operationPath:
            "{$sourceDescriptions.steel-contract.url}#/paths/~1v1~1computers~1{computer_id}~1checkpoints/post"
        },
        {
          stepId: "prefixed",
          operationPath:
            "$sourceDescriptions.steel-contract#/paths/~1v1~1computers/post"
        },
        {
          stepId: "bare-pointer",
          operationPath: "#/paths/~1v1~1computers~1{computer_id}~1pause/post"
        },
        {
          stepId: "canonical",
          operationPath: "path:GET /v1/computers/{computer_id}/files/{file_id}"
        }
      ])
    );
    expect(ir.diagnostics).toEqual([]);
    expect(stepOf(ir, "braced").operation_key).toBe(
      "path:POST /v1/computers/{computer_id}/checkpoints"
    );
    expect(stepOf(ir, "prefixed").operation_key).toBe(
      "path:POST /v1/computers"
    );
    expect(stepOf(ir, "bare-pointer").operation_key).toBe(
      "path:POST /v1/computers/{computer_id}/pause"
    );
    expect(stepOf(ir, "canonical").operation_key).toBe(
      "path:GET /v1/computers/{computer_id}/files/{file_id}"
    );
  });

  it("rejects an unknown source description", () => {
    const ir = compile(
      doc([
        { stepId: "a", operationId: "$sourceDescriptions.other.createComputer" }
      ])
    );
    expect(errors(ir)).toEqual([ArazzoCode.SourceUnknown]);
    expect(stepOf(ir, "a").operation_key).toBeNull();
  });

  it("rejects an unresolved operation reference", () => {
    const ir = compile(doc([{ stepId: "a", operationId: "missingOperation" }]));
    expect(errors(ir)).toEqual([ArazzoCode.OperationUnresolved]);
    expect(stepOf(ir, "a").operation_key).toBeNull();
  });

  it("rejects an ambiguous operation reference", () => {
    const base = steelContract();
    const original = base.operations[0];
    if (original === undefined) {
      throw new Error("The fixture contract has no operations.");
    }
    const key = "path:POST /v1/twin";
    const twin: OperationIR = {
      ...original,
      key,
      uid: operationUid(key),
      path_template: "/v1/twin"
    };
    const contract: ContractIR = {
      ...base,
      operations: [...base.operations, twin]
    };
    const ir = compile(
      doc([{ stepId: "a", operationId: "createComputer" }]),
      contract
    );
    expect(errors(ir)).toEqual([ArazzoCode.OperationAmbiguous]);
  });

  it("rejects an operation path outside the subset", () => {
    const ir = compile(
      doc([{ stepId: "a", operationPath: "#/components/parameters/x" }])
    );
    expect(errors(ir)).toEqual([ArazzoCode.StructureInvalid]);
  });

  it("rejects a dependency cycle", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          dependsOn: ["b"]
        },
        {
          stepId: "b",
          operationId: "uploadFile",
          dependsOn: ["a"]
        }
      ])
    );
    expect(errors(ir)).toEqual([ArazzoCode.DependencyCycle]);
    expect(ir.diagnostics[0]?.details).toEqual({ cycle: ["a", "b", "a"] });
    expect(one(ir).steps.map((step) => step.step_id)).toEqual(["a", "b"]);
  });

  it("rejects parameters the operation does not declare", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "uploadFile",
          parameters: [
            { name: "label", in: "query", value: "x" },
            { name: "computer_id", value: "c_1" },
            {
              name: "computer_id",
              in: "path",
              reference: "$components.parameters.x"
            }
          ]
        }
      ])
    );
    expect(errors(ir)).toEqual([
      ArazzoCode.ParameterUnknown,
      ArazzoCode.StructureInvalid,
      ArazzoCode.FeatureUnsupported
    ]);
    expect(warnings(ir)).toEqual([]);
  });

  it("rejects unsupported media types and bodies", () => {
    const wrongType = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          requestBody: { contentType: "text/plain", payload: "{}" }
        }
      ])
    );
    expect(errors(wrongType)).toEqual([ArazzoCode.MediaTypeUnsupported]);

    const withoutBody = compile(
      doc([
        {
          stepId: "a",
          operationId: "pauseComputer",
          requestBody: { contentType: "application/json", payload: "{}" }
        }
      ])
    );
    expect(errors(withoutBody)).toEqual([ArazzoCode.RequestBodyUnsupported]);
  });

  it("rejects criterion types and contexts outside the subset", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          successCriteria: [
            { type: "regex", condition: "$statusCode == 2..", context: "$url" },
            { type: "jsonpath", condition: "$.id" }
          ]
        }
      ])
    );
    expect(errors(ir)).toEqual([
      ArazzoCode.FeatureUnsupported,
      ArazzoCode.FeatureUnsupported
    ]);
    expect(stepOf(ir, "a").criteria).toEqual([]);
  });

  it("rejects unsupported runtime expressions", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          successCriteria: [
            { condition: "$workflows.w.outputs.x == 1" },
            { condition: "$statusCode ==" },
            { condition: "$response.headers.x-id == 1" }
          ],
          outputs: { trace: "$message.body#/id" },
          requestBody: {
            contentType: "application/json",
            payload: { nested: "{$components.parameters.x}" }
          }
        }
      ])
    );
    expect(errors(ir)).toEqual([
      ArazzoCode.ExpressionUnsupported,
      ArazzoCode.ExpressionUnsupported,
      ArazzoCode.ExpressionInvalid,
      ArazzoCode.ExpressionUnsupported,
      ArazzoCode.ExpressionUnsupported
    ]);
    expect(ir.diagnostics[0]?.details).toEqual({
      expression: "{$components.parameters.x}"
    });
    expect(ir.diagnostics[2]?.json_pointer).toContain("successCriteria");
    expect(stepOf(ir, "a").outputs).toEqual([]);
  });

  it("warns when a step reads a step it does not depend on", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          outputs: { tag: "$response.body#/template" }
        },
        {
          stepId: "b",
          operationId: "uploadFile",
          successCriteria: [
            { condition: "$response.body#/sha256 == $steps.a.outputs.tag" }
          ]
        }
      ])
    );
    expect(errors(ir)).toEqual([]);
    expect(warnings(ir)).toEqual([ArazzoCode.StepUnordered]);
  });

  it("accepts transitive references between ordered steps", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          outputs: { tag: "$response.body#/template" }
        },
        {
          stepId: "b",
          operationId: "uploadFile",
          dependsOn: ["a"],
          outputs: { sha: "$response.body#/sha256" }
        },
        {
          stepId: "c",
          operationId: "createCheckpoint",
          dependsOn: ["b"],
          successCriteria: [
            { condition: "$response.body#/sha256 == $steps.a.outputs.tag" }
          ]
        }
      ])
    );
    expect(ir.diagnostics).toEqual([]);
  });

  it("warns about success and failure actions", () => {
    const ir = compile(
      doc([
        {
          stepId: "a",
          operationId: "createComputer",
          onSuccess: { name: "retry", workflowId: "other" }
        }
      ])
    );
    expect(errors(ir)).toEqual([]);
    expect(warnings(ir)).toEqual([ArazzoCode.FeatureUnsupported]);
  });

  it("refuses to compile an unsupported version", () => {
    const parsed = parseArazzo(
      JSON.stringify({
        arazzo: "1.0.0",
        info: { title: "T", version: "1" },
        sourceDescriptions: [{ name: "steel-contract", url: "openapi.yaml" }],
        workflows: [
          { workflowId: "w", steps: [{ stepId: "a", operationId: "x" }] }
        ]
      })
    );
    const document = parsed.document;
    if (document === null) {
      throw new Error("Parsing failed.");
    }
    const ir = compileArazzo(document, steelContract());
    expect(errors(ir)).toEqual([ArazzoCode.VersionUnsupported]);
    expect(ir.workflows).toEqual([]);
  });
});
