/**
 * Corpus parsing and validation tests (specification section 48.5).
 * Old packs load without a corpus; the normative YAML fragment parses;
 * forward bindings, duplicate identifiers, unsupported operators,
 * unbounded polling, and script-shaped values fail before any run.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticCode, type JsonObject } from "@oal/core";

import { PackCode } from "./codes.ts";
import { corporaOf, corpusReferences, parseCorpus } from "./corpus.ts";
import { loadPack } from "./manifest.ts";
import { parsePackYaml } from "./yaml.ts";
import {
  baseFiles,
  baseYamlFiles,
  cleanupPacks,
  writePack
} from "./testkit.ts";

afterEach(async () => {
  await cleanupPacks();
});

/** The request and binding syntax fragment section 48.5 fixes. */
const SPEC_FRAGMENT_STEPS = `steps:
  - id: create
    request:
      operation_id: createIssue
      parameters:
        path:
          owner: { input: owner }
          repo: { input: repository }
      body:
        title: Corpus issue
        body: { input: run_marker }
    bind:
      number: { source: body, pointer: /number }
    assert:
      - op: status
        expected: 201
  - id: read
    request:
      operation_id: getIssue
      parameters:
        path:
          owner: { input: owner }
          repo: { input: repository }
          issue_number: { binding: create.number }
    assert:
      - op: equals
        actual: { source: body, pointer: /number }
        expected: { binding: create.number }
`;

/** A full corpus document around the fragment, with inputs declared. */
function fragmentCorpus(): JsonObject {
  const fragment = parsePackYaml(SPEC_FRAGMENT_STEPS) as JsonObject;
  const steps = fragment["steps"];
  if (!Array.isArray(steps)) {
    throw new Error("The fixture fragment declares no steps.");
  }
  return {
    api_version: 1,
    id: "fragment",
    version: "1.0.0",
    scenario: "baseline",
    inputs: [{ name: "owner" }, { name: "repository" }, { name: "run_marker" }],
    cases: [
      {
        id: "create-read",
        claim_ids: ["create", "read"],
        scope: "black_box",
        steps
      }
    ]
  };
}

/** A fresh copy of the fragment corpus the rejection cases mutate. */
function baseCorpus(): JsonObject {
  return structuredClone(fragmentCorpus());
}

/** The first case of a corpus, for mutation. */
function firstCase(corpus: JsonObject): JsonObject {
  return (corpus["cases"] as JsonObject[])[0] as JsonObject;
}

/** parseCorpus must reject the corpus with OAL-CORPUS-INVALID. */
function expectInvalid(corpus: JsonObject): void {
  try {
    parseCorpus(corpus);
  } catch (cause) {
    expect(cause).toMatchObject({ code: DiagnosticCode.CorpusInvalid });
    return;
  }
  throw new Error("parseCorpus accepted a corpus it must reject.");
}

/** The base manifest with one corpora entry pointing at corpus.json. */
async function packWithCorpus(
  entry: JsonObject,
  corpusText: string
): Promise<string> {
  const manifest = JSON.parse(baseFiles()["pack.json"] ?? "{}") as JsonObject;
  manifest["corpora"] = [entry];
  return writePack({
    ...baseFiles(manifest),
    "corpus.json": corpusText
  });
}

describe("pack corpora references", () => {
  it("accepts old packs without a corpora list", async () => {
    for (const files of [baseFiles(), baseYamlFiles()]) {
      const root = await writePack(files);
      const loaded = await loadPack(root);
      expect(
        loaded.diagnostics.filter((entry) => entry.severity === "error")
      ).toEqual([]);
      expect(corpusReferences(loaded)).toEqual([]);
      expect(corporaOf(loaded)).toEqual([]);
    }
  });

  it("loads a declared corpus and keeps ids aligned", async () => {
    const root = await packWithCorpus(
      { id: "fragment", source: "corpus.json" },
      JSON.stringify(fragmentCorpus())
    );
    const loaded = await loadPack(root);
    expect(
      loaded.diagnostics.filter((entry) => entry.severity === "error")
    ).toEqual([]);
    const references = corpusReferences(loaded);
    expect(references).toHaveLength(1);
    expect(references[0]?.pointer).toBe("/corpora/0/source");
    expect(references[0]?.path).toBe("corpus.json");
    const documents = corporaOf(loaded);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.id).toBe("fragment");
    expect(documents[0]?.cases[0]?.steps).toHaveLength(2);
  });

  it("reports a corpus id that disagrees with the manifest", async () => {
    const root = await packWithCorpus(
      { id: "other-id", source: "corpus.json" },
      JSON.stringify(fragmentCorpus())
    );
    const loaded = await loadPack(root);
    const mismatch = loaded.diagnostics.find(
      (entry) => entry.code === PackCode.CorpusIdMismatch
    );
    expect(mismatch?.message).toContain("other-id");
    expect(mismatch?.message).toContain("fragment");
  });

  it("reports a corpus document that violates the schema", async () => {
    const corpus = fragmentCorpus();
    corpus["api_version"] = 2;
    const root = await packWithCorpus(
      { id: "fragment", source: "corpus.json" },
      JSON.stringify(corpus)
    );
    const loaded = await loadPack(root);
    expect(
      loaded.diagnostics.some(
        (entry) =>
          entry.code === DiagnosticCode.PackSchemaInvalid &&
          entry.json_pointer === "/corpora/0/source"
      )
    ).toBe(true);
    // The semantic parser refuses the same document independently.
    expectInvalid(corpus);
  });

  it("reports a corpus file that is missing", async () => {
    const manifest = JSON.parse(baseFiles()["pack.json"] ?? "{}") as JsonObject;
    manifest["corpora"] = [{ id: "fragment", source: "corpora/absent.json" }];
    const root = await writePack(baseFiles(manifest));
    const loaded = await loadPack(root);
    expect(
      loaded.diagnostics.some((entry) => entry.code === PackCode.AssetNotFile)
    ).toBe(true);
    expect(corporaOf(loaded)).toEqual([]);
  });
});

describe("parseCorpus accepts", () => {
  it("parses the section 48.5 fragment with typed references", () => {
    const parsed = parseCorpus(fragmentCorpus());
    expect(parsed.apiVersion).toBe(1);
    expect(parsed.inputs).toEqual(["owner", "repository", "run_marker"]);
    expect(parsed.cases[0]?.claimIds).toEqual(["create", "read"]);
    const create = parsed.cases[0]?.steps[0];
    const read = parsed.cases[0]?.steps[1];
    expect(create?.id).toBe("create");
    if (create?.body.kind !== "request") {
      throw new Error("The create step carries no request.");
    }
    expect(create.body.operationId).toBe("createIssue");
    expect(create.bind["number"]).toEqual({
      source: "body",
      pointer: "/number"
    });
    expect(create.assertions[0]).toEqual({
      op: "status",
      expected: { kind: "literal", value: 201 },
      actual: null,
      setComparison: false,
      schema: null
    });
    if (read?.body.kind !== "request") {
      throw new Error("The read step carries no request.");
    }
    expect(read.body.parameters["path"]).toEqual({
      owner: { input: "owner" },
      repo: { input: "repository" },
      issue_number: { binding: "create.number" }
    });
    expect(read.assertions[0]?.expected).toEqual({
      kind: "binding",
      step: "create",
      name: "number"
    });
    expect(read.assertions[0]?.actual).toEqual({
      kind: "response",
      source: "body",
      pointer: "/number"
    });
  });

  it("lets setup bindings flow into steps and cleanup", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    first["setup"] = [
      {
        id: "seed",
        request: { operation_id: "createIssue", parameters: {} },
        bind: { number: { source: "body", pointer: "/number" } },
        assert: [{ op: "status", expected: 201 }]
      }
    ];
    first["steps"] = [
      {
        id: "read",
        request: {
          operation_id: "getIssue",
          parameters: {
            path: { issue_number: { binding: "seed.number" } }
          }
        },
        assert: [
          {
            op: "equals",
            actual: { source: "body", pointer: "/number" },
            expected: { binding: "seed.number" }
          }
        ]
      }
    ];
    first["cleanup"] = [
      {
        id: "close",
        request: {
          operation_id: "updateIssue",
          parameters: {
            path: { issue_number: { binding: "seed.number" } }
          }
        }
      }
    ];
    const parsed = parseCorpus(corpus);
    expect(parsed.cases[0]?.setup).toHaveLength(1);
    expect(parsed.cases[0]?.steps).toHaveLength(1);
    expect(parsed.cases[0]?.cleanup).toHaveLength(1);
  });

  it("accepts a poll with a zero interval and explicit bounds", () => {
    const corpus = baseCorpus();
    firstCase(corpus)["steps"] = [
      {
        id: "wait",
        poll: {
          operation_id: "listIssues",
          parameters: { query: { state: "open" } },
          attempts: 3,
          interval_ms: 0,
          deadline_ms: 500
        },
        assert: [
          { op: "length", actual: { source: "body", pointer: "" }, expected: 0 }
        ]
      }
    ];
    const parsed = parseCorpus(corpus);
    expect(parsed.cases[0]?.steps[0]?.body.kind).toBe("poll");
  });

  it("accepts operator steps in emulator-only cases", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    first["scope"] = "emulator_only";
    (first["steps"] as JsonObject[]).push({
      id: "advance",
      operator: { kind: "advance_time", by_ms: 1000 }
    });
    const parsed = parseCorpus(corpus);
    expect(parsed.cases[0]?.steps).toHaveLength(3);
    expect(parsed.cases[0]?.steps[2]?.body.kind).toBe("operator");
  });

  it("lets an assertion use the binding its own step captured", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    const create = (first["steps"] as JsonObject[])[0] as JsonObject;
    create["assert"] = [
      { op: "status", expected: 201 },
      {
        op: "not_equals",
        actual: { binding: "create.number" },
        expected: "clip_00000002"
      }
    ];
    const parsed = parseCorpus(corpus);
    expect(parsed.cases[0]?.steps[0]?.assertions[1]?.actual).toEqual({
      kind: "binding",
      step: "create",
      name: "number"
    });
  });

  it("keeps typed references inside nested body values", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    const create = (first["steps"] as JsonObject[])[0] as JsonObject;
    const request = create["request"] as JsonObject;
    request["body"] = {
      title: "Corpus issue",
      labels: [{ name: { input: "run_marker" } }]
    };
    const parsed = parseCorpus(corpus);
    const createStep = parsed.cases[0]?.steps[0];
    if (createStep?.body.kind !== "request") {
      throw new Error("The create step carries no request.");
    }
    expect(createStep.body.body).toEqual({
      title: "Corpus issue",
      labels: [{ name: { input: "run_marker" } }]
    });
  });
});

describe("parseCorpus rejects", () => {
  it("a forward binding to a later step", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    const steps = first["steps"] as [JsonObject, JsonObject];
    // The read step now comes first, so create.number is not yet bound.
    first["steps"] = [steps[1], steps[0]];
    expectInvalid(corpus);
  });

  it("a binding that names the current step", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    const read = (first["steps"] as JsonObject[])[1] as JsonObject;
    (read["request"] as JsonObject)["parameters"] = {
      path: { issue_number: { binding: "read.number" } }
    };
    expectInvalid(corpus);
  });

  it("a duplicate step id across setup, steps, and cleanup", () => {
    const corpus = baseCorpus();
    firstCase(corpus)["cleanup"] = [
      {
        id: "create",
        request: { operation_id: "updateIssue", parameters: {} }
      }
    ];
    expectInvalid(corpus);
  });

  it("a duplicate case id", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    corpus["cases"] = [first, structuredClone(first)];
    expectInvalid(corpus);
  });

  it("an unsupported assertion operator", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    (create["assert"] as JsonObject[])[0] = {
      op: "matches_regex",
      expected: ".*"
    };
    expectInvalid(corpus);
  });

  it("a poll without a deadline", () => {
    const corpus = baseCorpus();
    firstCase(corpus)["steps"] = [
      {
        id: "wait",
        poll: {
          operation_id: "listIssues",
          parameters: {},
          attempts: 3,
          interval_ms: 100
        }
      }
    ];
    expectInvalid(corpus);
  });

  it("a poll with zero attempts", () => {
    const corpus = baseCorpus();
    firstCase(corpus)["steps"] = [
      {
        id: "wait",
        poll: {
          operation_id: "listIssues",
          parameters: {},
          attempts: 0,
          interval_ms: 100,
          deadline_ms: 500
        }
      }
    ];
    expectInvalid(corpus);
  });

  it("a script field inside a request body", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    (create["request"] as JsonObject)["body"] = {
      title: "Corpus issue",
      body: { input: "run_marker" },
      script: "rm -rf /"
    };
    expectInvalid(corpus);
  });

  it("an expression field nested in parameters", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    (create["request"] as JsonObject)["parameters"] = {
      query: { filter: { expr: "1 + 1" } }
    };
    expectInvalid(corpus);
  });

  it("an operator step in a black-box case", () => {
    const corpus = baseCorpus();
    (firstCase(corpus)["steps"] as JsonObject[]).push({
      id: "reset",
      operator: { kind: "reset" }
    });
    expectInvalid(corpus);
  });

  it("an input the corpus does not declare", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    ((create["request"] as JsonObject)["parameters"] as JsonObject)["path"] = {
      owner: { input: "absent" }
    };
    expectInvalid(corpus);
  });

  it("a cleanup binding no earlier step established", () => {
    const corpus = baseCorpus();
    const first = firstCase(corpus);
    first["cleanup"] = [
      {
        id: "close",
        request: {
          operation_id: "updateIssue",
          parameters: {
            path: { issue_number: { binding: "create.number" } }
          }
        }
      }
    ];
    delete (first["steps"] as JsonObject[])[0]?.["bind"];
    expectInvalid(corpus);
  });

  it("a step that carries both a request and a poll", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    create["poll"] = {
      operation_id: "listIssues",
      parameters: {},
      attempts: 2,
      interval_ms: 10,
      deadline_ms: 100
    };
    expectInvalid(corpus);
  });

  it("a binding reference without a step separator", () => {
    const corpus = baseCorpus();
    const read = (firstCase(corpus)["steps"] as JsonObject[])[1] as JsonObject;
    ((read["request"] as JsonObject)["parameters"] as JsonObject)["path"] = {
      issue_number: { binding: "number" }
    };
    expectInvalid(corpus);
  });

  it("an unsupported corpus api version", () => {
    const corpus = baseCorpus();
    corpus["api_version"] = 2;
    expectInvalid(corpus);
  });

  it("a body pointer that is neither empty nor root-anchored", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    (create["bind"] as JsonObject)["number"] = {
      source: "body",
      pointer: "number"
    };
    expectInvalid(corpus);
  });

  it("a case without steps", () => {
    const corpus = baseCorpus();
    firstCase(corpus)["steps"] = [];
    expectInvalid(corpus);
  });

  it("a response pointer used as a request parameter", () => {
    const corpus = baseCorpus();
    const create = (
      firstCase(corpus)["steps"] as JsonObject[]
    )[0] as JsonObject;
    ((create["request"] as JsonObject)["parameters"] as JsonObject)["path"] = {
      owner: { source: "body", pointer: "/owner" }
    };
    expectInvalid(corpus);
  });
});
