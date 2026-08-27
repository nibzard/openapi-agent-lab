import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { ArazzoCode } from "./codes.ts";
import { parseArazzo } from "./parse.ts";
import type { ArazzoDocument, ArazzoParseResult } from "./parse.ts";

const FIXTURE_URL = new URL("./fixtures/steel-workflow.json", import.meta.url);

let steel: string;

beforeAll(async () => {
  steel = await readFile(FIXTURE_URL, "utf8");
});

function errors(result: ArazzoParseResult): string[] {
  return result.diagnostics
    .filter((entry) => entry.severity === "error")
    .map((entry) => entry.code);
}

function document(result: ArazzoParseResult): ArazzoDocument {
  if (result.document === null) {
    throw new Error(`Parsing failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.document;
}

/** Serialize one minimal document around the given workflows. */
function wrap(
  workflows: unknown[],
  extra: { arazzo?: string; sourceType?: string } = {}
): string {
  return JSON.stringify({
    arazzo: extra.arazzo ?? "1.1.0",
    info: { title: "Fixture", version: "1.0.0" },
    sourceDescriptions: [
      {
        name: "steel-contract",
        url: "../contract/openapi.yaml",
        type: extra.sourceType ?? "openapi"
      }
    ],
    workflows
  });
}

const ONE_STEP = [
  { workflowId: "w", steps: [{ stepId: "a", operationId: "x" }] }
];

const YAML_WORKFLOW = `
arazzo: 1.1.0
info:
  title: Steel checkpoint recovery
  version: 1.0.0
sourceDescriptions:
  - name: steel-contract
    url: ../contract/openapi.yaml
    type: openapi
workflows:
  - workflowId: checkpoint-recovery
    summary: Return one computer to its clean bytes
    steps:
      - stepId: create-computer
        description: Create one Chrome computer.
        operationId: createComputer
        successCriteria:
          - condition: $statusCode == 201
        outputs:
          computer_id: $response.body#/id
        dependsOn: []
      - stepId: upload-initial-file
        operationId: uploadFile
        parameters:
          - name: computer_id
            in: path
            value: "{$steps.create-computer.outputs.computer_id}"
        requestBody:
          contentType: application/octet-stream
          payload: "{$inputs.initial_bytes}"
        successCriteria:
          - condition: $statusCode == 201 && $response.body#/sha256 != null
        dependsOn: [create-computer]
`;

describe("parseArazzo", () => {
  it("parses the steel fixture without diagnostics", () => {
    const result = parseArazzo(steel, { documentUri: "steel-workflow.json" });
    expect(errors(result)).toEqual([]);
    const parsed = document(result);
    expect(parsed.arazzo_version).toBe("1.1.0");
    expect(parsed.title).toBe("Steel checkpoint recovery");
    expect(parsed.sourceDescriptions).toEqual([
      {
        name: "steel-contract",
        url: "../contract/openapi.yaml",
        type: "openapi"
      }
    ]);
    expect(parsed.workflows.map((workflow) => workflow.workflowId)).toEqual([
      "checkpoint-recovery"
    ]);
    expect(parsed.workflows[0]?.steps.map((step) => step.stepId)).toEqual([
      "create-computer",
      "upload-initial-file",
      "upload-changed-file",
      "create-checkpoint",
      "restore-computer",
      "download-file"
    ]);
  });

  it("keeps the source position of every step", () => {
    const parsed = document(parseArazzo(steel));
    expect(parsed.workflows[0]?.steps.map((step) => step.sourceIndex)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
  });

  it("parses a YAML document into the same shape", () => {
    const result = parseArazzo(YAML_WORKFLOW);
    expect(errors(result)).toEqual([]);
    const parsed = document(result);
    expect(parsed.arazzo_version).toBe("1.1.0");
    expect(parsed.workflows[0]?.steps.length).toBe(2);
    expect(parsed.workflows[0]?.steps[1]?.parameters[0]).toEqual({
      name: "computer_id",
      in: "path",
      value: "{$steps.create-computer.outputs.computer_id}",
      reference: null,
      source: {
        name: "computer_id",
        in: "path",
        value: "{$steps.create-computer.outputs.computer_id}"
      }
    });
    expect(parsed.workflows[0]?.steps[1]?.dependsOn).toEqual([
      "create-computer"
    ]);
    expect(parsed.workflows[0]?.steps[0]?.outputs).toEqual({
      computer_id: "$response.body#/id"
    });
  });

  it("accepts every 1.1.x version string", () => {
    for (const version of ["1.1", "1.1.0", "1.1.3"]) {
      const result = parseArazzo(wrap(ONE_STEP, { arazzo: version }));
      expect(errors(result)).toEqual([]);
      expect(document(result).arazzo_version).toBe(version);
    }
  });

  it("rejects every other version with a capability diagnostic", () => {
    for (const version of ["1.0.0", "1.2.0", "2.0.0"]) {
      const result = parseArazzo(wrap(ONE_STEP, { arazzo: version }));
      expect(errors(result)).toEqual([ArazzoCode.VersionUnsupported]);
      expect(result.diagnostics[0]?.details).toEqual({
        found: version,
        supported: "1.1.x"
      });
      expect(result.diagnostics[0]?.json_pointer).toBe("/arazzo");
      expect(document(result).workflows).toEqual([]);
    }
  });

  it("rejects a missing version field", () => {
    const result = parseArazzo(JSON.stringify({ workflows: ONE_STEP }));
    expect(result.diagnostics[0]?.code).toBe(ArazzoCode.StructureInvalid);
    expect(result.diagnostics[0]?.json_pointer).toBe("/arazzo");
  });

  it("rejects a document that is not a mapping", () => {
    const result = parseArazzo("[1, 2]");
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.StructureInvalid]);
  });

  it("rejects empty input", () => {
    const result = parseArazzo("");
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.StructureInvalid]);
  });

  it("rejects a JSON document with a syntax error", () => {
    const result = parseArazzo('{"arazzo": ');
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.JsonInvalid]);
  });

  it("enforces the byte limit", () => {
    const result = parseArazzo(steel, { maxBytes: 16 });
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.SizeLimit]);
  });

  it("enforces the node limit", () => {
    const json = parseArazzo(steel, { maxNodes: 8 });
    expect(json.document).toBeNull();
    expect(errors(json)).toEqual([ArazzoCode.NodeLimit]);

    const yaml = parseArazzo("arazzo: 1.1.0\ninfo:\n  title: t\n", {
      maxNodes: 2
    });
    expect(yaml.document).toBeNull();
    expect(errors(yaml)).toEqual([ArazzoCode.NodeLimit]);
  });

  it("enforces the depth limit", () => {
    let deep = "1";
    for (let i = 0; i < 6; i += 1) {
      deep = `{"a": ${deep}}`;
    }
    const result = parseArazzo(deep, { maxDepth: 4 });
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.DepthLimit]);

    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      lines.push(`${" ".repeat(i * 2)}a:`);
    }
    const yaml = parseArazzo(lines.join("\n"), { maxDepth: 4 });
    expect(yaml.document).toBeNull();
    expect(errors(yaml)).toEqual([ArazzoCode.DepthLimit]);
  });

  it("rejects duplicate workflow and step IDs", () => {
    const duplicated = wrap([
      { workflowId: "w", steps: [{ stepId: "a", operationId: "x" }] },
      { workflowId: "w", steps: [{ stepId: "a", operationId: "x" }] }
    ]);
    const result = parseArazzo(duplicated);
    expect(errors(result)).toEqual([ArazzoCode.IdDuplicate]);
    expect(document(result).workflows.length).toBe(1);

    const duplicatedStep = wrap([
      {
        workflowId: "w",
        steps: [
          { stepId: "a", operationId: "x" },
          { stepId: "a", operationId: "y" }
        ]
      }
    ]);
    const stepResult = parseArazzo(duplicatedStep);
    expect(errors(stepResult)).toEqual([ArazzoCode.IdDuplicate]);
    expect(document(stepResult).workflows[0]?.steps.length).toBe(1);
  });

  it("rejects unsafe IDs", () => {
    const unsafe = wrap([{ workflowId: "has space", steps: [] }]);
    expect(errors(parseArazzo(unsafe))).toEqual([ArazzoCode.IdUnsafe]);

    const unsafeStep = wrap([
      { workflowId: "w", steps: [{ stepId: "bad/id", operationId: "x" }] }
    ]);
    expect(errors(parseArazzo(unsafeStep))).toEqual([ArazzoCode.IdUnsafe]);
  });

  it("rejects an unknown step dependency", () => {
    const unknown = wrap([
      {
        workflowId: "w",
        steps: [
          { stepId: "a", operationId: "x", dependsOn: ["missing"] },
          { stepId: "b", operationId: "y", dependsOn: ["a"] }
        ]
      }
    ]);
    const result = parseArazzo(unknown);
    expect(errors(result)).toEqual([ArazzoCode.DependencyUnknown]);
    expect(result.diagnostics[0]?.message).toContain("missing");
  });

  it("rejects a dependency written as a runtime expression", () => {
    const unsupported = wrap([
      {
        workflowId: "w",
        steps: [
          { stepId: "a", operationId: "x" },
          { stepId: "b", operationId: "y", dependsOn: ["$a"] }
        ]
      }
    ]);
    const result = parseArazzo(unsupported);
    expect(errors(result)).toEqual([ArazzoCode.DependencyUnsupported]);
  });

  it("accepts a forward step dependency", () => {
    const forward = wrap([
      {
        workflowId: "w",
        steps: [
          { stepId: "a", operationId: "x", dependsOn: ["b"] },
          { stepId: "b", operationId: "y", dependsOn: [] }
        ]
      }
    ]);
    expect(errors(parseArazzo(forward))).toEqual([]);
  });

  it("rejects a step that targets a channel or a nested workflow", () => {
    const targets = [
      { stepId: "a", channelPath: "#/channels/x" },
      { stepId: "a", workflowId: "other" },
      { stepId: "a", operationId: "x", workflowId: "other" },
      { stepId: "a" }
    ];
    const expected = [
      ArazzoCode.StepTargetUnsupported,
      ArazzoCode.StepTargetUnsupported,
      ArazzoCode.StructureInvalid,
      ArazzoCode.StructureInvalid
    ];
    targets.forEach((step, index) => {
      const result = parseArazzo(wrap([{ workflowId: "w", steps: [step] }]));
      expect(errors(result)).toEqual([expected[index]]);
    });
  });

  it("rejects a source description of an unsupported type", () => {
    const result = parseArazzo(wrap(ONE_STEP, { sourceType: "asyncapi" }));
    expect(errors(result)).toEqual([ArazzoCode.SourceTypeUnsupported]);
    expect(result.diagnostics[0]?.details).toEqual({ found: "asyncapi" });
  });

  it("rejects an unknown source description type", () => {
    const result = parseArazzo(wrap(ONE_STEP, { sourceType: "graphql" }));
    expect(errors(result)).toEqual([ArazzoCode.StructureInvalid]);
  });

  it("rejects payload replacements and success actions", () => {
    const replaced = wrap([
      {
        workflowId: "w",
        steps: [
          {
            stepId: "a",
            operationId: "x",
            requestBody: {
              contentType: "application/json",
              payload: {},
              replacements: [{ target: "$response.body#/id" }]
            }
          }
        ]
      }
    ]);
    const replacedResult = parseArazzo(replaced);
    expect(errors(replacedResult)).toEqual([ArazzoCode.FeatureUnsupported]);
    expect(
      document(replacedResult).workflows[0]?.steps[0]?.declaresActions
    ).toBe(false);

    const actions = wrap([
      {
        workflowId: "w",
        steps: [
          {
            stepId: "a",
            operationId: "x",
            onSuccess: { name: "next", workflowId: "other" }
          }
        ]
      }
    ]);
    expect(
      document(parseArazzo(actions)).workflows[0]?.steps[0]?.declaresActions
    ).toBe(true);
  });
});

describe("parseArazzo YAML subset", () => {
  it("rejects anchors, aliases, and tags", () => {
    for (const body of [
      "arazzo: &anchor 1.1.0\n",
      "arazzo: *anchor\n",
      "arazzo: !!str 1.1.0\n"
    ]) {
      const result = parseArazzo(body);
      expect(result.document).toBeNull();
      expect(errors(result)).toEqual([ArazzoCode.YamlUnsupported]);
    }
  });

  it("rejects multiple documents and directives", () => {
    for (const text of [
      "arazzo: 1.1.0\n---\narazzo: 1.1.0\n",
      "%YAML 1.2\n---\narazzo: 1.1.0\n"
    ]) {
      const result = parseArazzo(text);
      expect(result.document).toBeNull();
      expect(errors(result)).toEqual([ArazzoCode.YamlUnsupported]);
    }
  });

  it("rejects a duplicate mapping key", () => {
    const result = parseArazzo("arazzo: 1.1.0\narazzo: 1.1.0\n");
    expect(result.document).toBeNull();
    expect(errors(result)).toEqual([ArazzoCode.DuplicateKey]);
  });

  it("rejects tabs in indentation", () => {
    const result = parseArazzo("arazzo: 1.1.0\ninfo:\n\ttitle: t\n");
    expect(result.document).toBeNull();
  });

  it("folds block scalars and strips the final break", () => {
    const text = [
      "arazzo: 1.1.0",
      "sourceDescriptions:",
      "  - name: s",
      "    url: openapi.yaml",
      "workflows:",
      "  - workflowId: w",
      "    steps:",
      "      - stepId: a",
      "        operationId: x",
      "        description: >-",
      "          one line",
      "          second line",
      ""
    ].join("\n");
    const result = parseArazzo(text);
    expect(errors(result)).toEqual([]);
    expect(document(result).workflows[0]?.steps[0]?.description).toBe(
      "one line second line"
    );
  });

  it("keeps literal block scalars line by line", () => {
    const text = [
      "arazzo: 1.1.0",
      "sourceDescriptions:",
      "  - name: s",
      "    url: openapi.yaml",
      "workflows:",
      "  - workflowId: w",
      "    steps:",
      "      - stepId: a",
      "        operationId: x",
      "        description: |",
      "          one line",
      "          second line",
      ""
    ].join("\n");
    const result = parseArazzo(text);
    expect(errors(result)).toEqual([]);
    expect(document(result).workflows[0]?.steps[0]?.description).toBe(
      "one line\nsecond line\n"
    );
  });

  it("ignores comments", () => {
    const text = [
      "# Steel fixture, trimmed.",
      "arazzo: 1.1.0 # version line",
      "info:",
      "  title: T # title",
      "  version: 1.0.0",
      "sourceDescriptions:",
      "  - name: s",
      "    url: ../contract/openapi.yaml",
      "    type: openapi",
      "workflows:",
      "  - workflowId: w",
      "    steps:",
      "      - stepId: a",
      "        operationId: x # target",
      "        successCriteria:",
      "          - condition: $statusCode == 201 # check",
      "        outputs:",
      "          computer_id: $response.body#/id",
      ""
    ].join("\n");
    const result = parseArazzo(text);
    expect(result.diagnostics).toEqual([]);
    const step = document(result).workflows[0]?.steps[0];
    expect(step?.successCriteria[0]?.condition).toBe("$statusCode == 201");
    expect(step?.outputs.computer_id).toBe("$response.body#/id");
  });

  it("resolves plain scalars to null, booleans, and numbers", () => {
    const text = [
      "arazzo: 1.1.0",
      "sourceDescriptions:",
      "  - name: s",
      "    url: openapi.yaml",
      "workflows:",
      "  - workflowId: w",
      "    steps:",
      "      - stepId: a",
      "        operationId: x",
      "        requestBody:",
      "          contentType: application/json",
      "          payload: [null, true, false, 201, 1.5, ~, text]",
      ""
    ].join("\n");
    const result = parseArazzo(text);
    expect(errors(result)).toEqual([]);
    expect(
      document(result).workflows[0]?.steps[0]?.requestBody?.payload
    ).toEqual([null, true, false, 201, 1.5, null, "text"]);
  });
});
