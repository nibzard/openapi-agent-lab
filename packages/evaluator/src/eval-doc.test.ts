import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SchemaValidator, type Diagnostic, type Json } from "@oal/core";
import {
  loadEval,
  loadEvalCase,
  loadEvalCases,
  type Eval
} from "./eval-doc.ts";

const SCHEMA_DIR = join(process.cwd(), "schemas");

const TASK_TEXT = `# Task

List every operation the contract declares and answer in JSON.
`;

const CASE_LINES = [
  { id: "happy", input: { topic: "operations" }, description: "Happy path." },
  { id: "empty", input: { topic: "errors" } }
];

const CASE_SCHEMA: Json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["topic"],
  properties: { topic: { type: "string", minLength: 1 } }
};

const RESULT_SCHEMA: Json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: { operations: { type: "array", items: { type: "string" } } }
};

const RUBRIC: Json = {
  rubric_version: 1,
  id: "create-issue",
  description: "The participant produced a structured result.",
  scoring: { method: "weighted_binary", pass_threshold: 1 },
  checks: [
    {
      id: "structured-result",
      kind: "predicate",
      weight: 1,
      required: true,
      evidence_class: "participant_observable",
      expression: "report.operations != null",
      on_missing: "fail"
    }
  ],
  signals: []
};

/** In-memory pack assets the sample eval references. */
function sampleFiles(): Record<string, string> {
  return {
    "task.md": TASK_TEXT,
    "cases/cases.jsonl": CASE_LINES.map((line) => JSON.stringify(line))
      .join("\n")
      .concat("\n"),
    "cases/case.schema.json": `${JSON.stringify(CASE_SCHEMA, null, 2)}\n`,
    "result.schema.json": `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`,
    "rubric.yaml": `${JSON.stringify(RUBRIC, null, 2)}\n`
  };
}

const SAMPLE_EVAL: Json = {
  id: "create-issue",
  prompt_set: "smoke",
  task: { source: "task.md", engine: "literal", target: "TASK.md" },
  participant_files: [
    { source: "result.schema.json", target: "result.schema.json" }
  ],
  operation_scope: { mode: "all" },
  cases: {
    source: "cases/cases.jsonl",
    schema: "cases/case.schema.json",
    id_pointer: "/id"
  },
  result: {
    source: "adapter_final",
    schema: "result.schema.json",
    required: true
  },
  rubric: "rubric.yaml",
  scenario: "baseline"
};

async function schemaFile(name: string): Promise<Json> {
  return JSON.parse(await readFile(join(SCHEMA_DIR, name), "utf8")) as Json;
}

/** Resolvers backed by one in-memory file map, like the CLI builds. */
function resolversOf(files: Record<string, string>): {
  resolveText: (reference: string) => string | undefined;
  resolveDocument: (reference: string) => Json | undefined;
} {
  return {
    resolveText: (reference: string): string | undefined => files[reference],
    resolveDocument: (reference: string): Json | undefined => {
      const text = files[reference];
      if (text === undefined) {
        return undefined;
      }
      try {
        return JSON.parse(text) as Json;
      } catch {
        return undefined;
      }
    }
  };
}

async function load(
  document: Json,
  files: Record<string, string> = sampleFiles(),
  options: Record<string, unknown> = {}
) {
  return loadEval(document, {
    schema: await schemaFile("eval.v1.schema.json"),
    caseSchema: await schemaFile("eval-case.v1.schema.json"),
    rubricSchema: await schemaFile("rubric.v1.schema.json"),
    ...resolversOf(files),
    ...options
  });
}

function errorsOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

function warningsOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => diagnostic.code);
}

describe("eval schema conformance", () => {
  it("accepts the sample eval", async () => {
    const validator = new SchemaValidator(
      await schemaFile("eval.v1.schema.json")
    );
    expect(validator.errors(SAMPLE_EVAL)).toEqual([]);
  });

  it("accepts the sample case line", async () => {
    const validator = new SchemaValidator(
      await schemaFile("eval-case.v1.schema.json")
    );
    expect(validator.errors(CASE_LINES[0] as Json)).toEqual([]);
  });

  it("rejects an eval that misses required fields", async () => {
    const validator = new SchemaValidator(
      await schemaFile("eval.v1.schema.json")
    );
    const violations = validator.errors({ id: "broken" });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("rejects a case with an empty input object", async () => {
    const validator = new SchemaValidator(
      await schemaFile("eval-case.v1.schema.json")
    );
    expect(validator.errors({ id: "broken", input: {} }).length).toBe(1);
  });
});

describe("loadEval", () => {
  it("loads a valid eval without error diagnostics", async () => {
    const result = await load(SAMPLE_EVAL);
    expect(result.eval).not.toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.caseCount).toBe(2);
    const evaluation: Eval = result.eval as Eval;
    expect(evaluation.id).toBe("create-issue");
    expect(evaluation.task.target).toBe("TASK.md");
    expect(evaluation.result.source).toBe("adapter_final");
    expect(evaluation.operation_scope).toEqual({ mode: "all" });
    expect(evaluation.participant_files).toEqual([
      { source: "result.schema.json", target: "result.schema.json" }
    ]);
  });

  it("checks only the document shape when no resolver is supplied", async () => {
    const result = loadEval(SAMPLE_EVAL, {
      schema: await schemaFile("eval.v1.schema.json")
    });
    expect(result.eval).not.toBeNull();
    expect(result.diagnostics).toEqual([]);
    expect(result.caseCount).toBe(0);
  });

  it("rejects a workspace_file result without a filename", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      result: {
        source: "workspace_file",
        schema: "result.schema.json",
        required: true
      }
    });
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects a workspace_file filename with directories", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      result: {
        source: "workspace_file",
        schema: "result.schema.json",
        required: true,
        filename: "out/report.json"
      }
    });
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("accepts a workspace_file result with a safe filename", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      result: {
        source: "workspace_file",
        schema: "result.schema.json",
        required: true,
        filename: "report.json"
      }
    });
    expect(result.eval?.result.filename).toBe("report.json");
    expect(errorsOf(result.diagnostics)).toEqual([]);
  });

  it("rejects an adapter_final result that declares a filename", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      result: {
        source: "adapter_final",
        schema: "result.schema.json",
        required: true,
        filename: "report.json"
      }
    });
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects an unknown task engine", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      task: { source: "task.md", engine: "handlebars", target: "TASK.md" }
    });
    expect(result.eval).toBeNull();
    expect(new Set(errorsOf(result.diagnostics))).toEqual(
      new Set(["OAL-EVAL-INVALID"])
    );
  });

  it("rejects unsafe identifiers and references", async () => {
    const badId = await load({ ...SAMPLE_EVAL, id: "../escape" });
    expect(badId.eval).toBeNull();
    const badScenario = await load({ ...SAMPLE_EVAL, scenario: "no good" });
    expect(badScenario.eval).toBeNull();
    const badPromptSet = await load({
      ...SAMPLE_EVAL,
      prompt_set: "../escape"
    });
    expect(badPromptSet.eval).toBeNull();
    const traversal = await load({ ...SAMPLE_EVAL, rubric: "../rubric.yaml" });
    expect(traversal.eval).toBeNull();
  });

  it("rejects a participant target that repeats the task target", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      participant_files: [{ source: "result.schema.json", target: "TASK.md" }]
    });
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects a task source the resolver cannot load", async () => {
    const files = sampleFiles();
    delete files["task.md"];
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects a result schema that is not an object", async () => {
    const files = sampleFiles();
    files["result.schema.json"] = "[1, 2]\n";
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("warns when a schema asset declares another draft", async () => {
    const files = sampleFiles();
    files["result.schema.json"] = `${JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object"
    })}\n`;
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).not.toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(warningsOf(result.diagnostics)).toEqual(["OAL-EVAL-SCHEMA-DRAFT"]);
  });

  it("rejects a malformed operation scope", async () => {
    const badKey = await load({
      ...SAMPLE_EVAL,
      operation_scope: { mode: "list", operations: ["GET /widgets"] }
    });
    expect(badKey.eval).toBeNull();
    const emptyTags = await load({
      ...SAMPLE_EVAL,
      operation_scope: {
        mode: "selector",
        selector: { kind: "tags", tags: [] }
      }
    });
    expect(emptyTags.eval).toBeNull();
    const lowerMethods = await load({
      ...SAMPLE_EVAL,
      operation_scope: {
        mode: "selector",
        selector: { kind: "methods", methods: ["get"] }
      }
    });
    expect(lowerMethods.eval).toBeNull();
  });

  it("accepts a valid list scope and selector scope", async () => {
    const list = await load({
      ...SAMPLE_EVAL,
      operation_scope: {
        mode: "list",
        operations: ["path:GET /widgets", "path:POST /widgets"]
      }
    });
    expect(list.eval?.operation_scope).toEqual({
      mode: "list",
      operations: ["path:GET /widgets", "path:POST /widgets"]
    });
    const selector = await load({
      ...SAMPLE_EVAL,
      operation_scope: {
        mode: "selector",
        selector: { kind: "methods", methods: ["GET", "POST"] }
      }
    });
    expect(selector.eval?.operation_scope).toEqual({
      mode: "selector",
      selector: { kind: "methods", methods: ["GET", "POST"] }
    });
  });
});

describe("loadEval case sources", () => {
  it("rejects a duplicate case id", async () => {
    const files = sampleFiles();
    files["cases/cases.jsonl"] = [
      JSON.stringify({ id: "happy", input: { topic: "operations" } }),
      JSON.stringify({ id: "happy", input: { topic: "errors" } })
    ].join("\n");
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-CASE-INVALID"]);
  });

  it("rejects a case line that is not valid JSON", async () => {
    const files = sampleFiles();
    files["cases/cases.jsonl"] = "{not json}\n";
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-CASE-INVALID"]);
  });

  it("rejects a case input that violates the case schema", async () => {
    const files = sampleFiles();
    files["cases/cases.jsonl"] = `${JSON.stringify({
      id: "happy",
      input: { topic: "" }
    })}\n`;
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects an id pointer that names no string inside the case", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      cases: {
        source: "cases/cases.jsonl",
        schema: "cases/case.schema.json",
        id_pointer: "/input"
      }
    });
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual([
      "OAL-EVAL-CASE-INVALID",
      "OAL-EVAL-CASE-INVALID"
    ]);
  });

  it("accepts an id pointer that names the case id of every line", async () => {
    const result = await load({
      ...SAMPLE_EVAL,
      cases: {
        source: "cases/cases.jsonl",
        schema: "cases/case.schema.json",
        id_pointer: "/id"
      }
    });
    expect(result.eval).not.toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.caseCount).toBe(2);
  });
});

describe("loadEval strict templates", () => {
  const STRICT_TASK = `# Task

Report the {{ case.input.topic }} of {{ api.baseUrl }}.
`;

  it("accepts allowlisted variables and shared case inputs", async () => {
    const files = sampleFiles();
    files["task.md"] = STRICT_TASK;
    const result = await load(
      {
        ...SAMPLE_EVAL,
        task: { source: "task.md", engine: "mustache-strict" }
      },
      files
    );
    expect(result.eval?.task.engine).toBe("mustache-strict");
    expect(errorsOf(result.diagnostics)).toEqual([]);
  });

  it("rejects a variable outside the allowlist", async () => {
    const files = sampleFiles();
    files["task.md"] = "Read {{ process.env.HOME }} now.\n";
    const result = await load(
      {
        ...SAMPLE_EVAL,
        task: { source: "task.md", engine: "mustache-strict" }
      },
      files
    );
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects a case input key that one case omits", async () => {
    const files = sampleFiles();
    files["task.md"] =
      "Report the {{ case.input.topic }} and {{ case.input.extra }}.\n";
    const result = await load(
      {
        ...SAMPLE_EVAL,
        task: { source: "task.md", engine: "mustache-strict" }
      },
      files
    );
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });

  it("rejects a case input reference when the eval declares no cases", async () => {
    const files = sampleFiles();
    files["task.md"] = "Report the {{ case.input.topic }}.\n";
    const result = await load(
      {
        id: "create-issue",
        prompt_set: "smoke",
        task: { source: "task.md", engine: "mustache-strict" },
        operation_scope: { mode: "all" },
        result: {
          source: "adapter_final",
          schema: "result.schema.json",
          required: true
        },
        rubric: "rubric.yaml",
        scenario: "baseline"
      },
      files
    );
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });
});

describe("loadEval inline rubric", () => {
  it("accepts a rubric that compiles", async () => {
    const result = await load(SAMPLE_EVAL);
    expect(result.eval?.rubric).toBe("rubric.yaml");
    expect(errorsOf(result.diagnostics)).toEqual([]);
  });

  it("merges rubric diagnostics when the rubric is broken", async () => {
    const files = sampleFiles();
    files["rubric.yaml"] = `${JSON.stringify({
      ...RUBRIC,
      checks: [
        {
          id: "a",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "true"
        },
        {
          id: "a",
          kind: "predicate",
          weight: 1,
          required: true,
          expression: "true"
        }
      ]
    })}\n`;
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-RUBRIC-INVALID"]);
  });

  it("rejects a rubric reference the resolver cannot load", async () => {
    const files = sampleFiles();
    delete files["rubric.yaml"];
    const result = await load(SAMPLE_EVAL, files);
    expect(result.eval).toBeNull();
    expect(errorsOf(result.diagnostics)).toEqual(["OAL-EVAL-INVALID"]);
  });
});

describe("loadEvalCases and loadEvalCase", () => {
  async function caseOptions(): Promise<{ documentUri: string; schema: Json }> {
    return {
      documentUri: "cases/cases.jsonl",
      schema: await schemaFile("eval-case.v1.schema.json")
    };
  }

  it("skips blank lines and keeps declaration order", async () => {
    const text = [
      "",
      JSON.stringify({ id: "first", input: { topic: "operations" } }),
      "",
      JSON.stringify({ id: "second", input: { topic: "errors" } })
    ].join("\n");
    const result = loadEvalCases(`${text}\n`, {
      ...(await caseOptions()),
      idPointer: "/id"
    });
    expect(result.cases.map((oneCase) => oneCase.id)).toEqual([
      "first",
      "second"
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports the line of a broken case", async () => {
    const result = loadEvalCases("{bad}\n", await caseOptions());
    expect(result.cases).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("line 1");
    expect(result.diagnostics[0]?.code).toBe("OAL-EVAL-CASE-INVALID");
  });

  it("loads one case and rejects one without input", async () => {
    const schema = (await caseOptions()).schema;
    const good = loadEvalCase(
      { id: "one", input: { topic: "operations" } },
      { schema }
    );
    expect(good.case?.id).toBe("one");
    expect(good.diagnostics).toEqual([]);
    const bad = loadEvalCase({ id: "one", input: {} }, { schema });
    expect(bad.case).toBeNull();
    expect(errorsOf(bad.diagnostics)).toEqual(["OAL-EVAL-CASE-INVALID"]);
  });
});
