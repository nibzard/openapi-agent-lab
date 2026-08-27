import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@oal/core";

import { PackCode } from "./codes.ts";
import { validatePack } from "./validate.ts";
import {
  baseFiles,
  baseManifest,
  cleanupPacks,
  containing,
  textContaining,
  writePack
} from "./testkit.ts";

afterEach(async () => {
  await cleanupPacks();
});

/** Write a pack whose manifest is mutated, then validate it. */
async function check(
  mutate: (manifest: JsonObject) => void,
  files: Record<string, string> = {}
) {
  const manifest = baseManifest();
  mutate(manifest);
  const root = await writePack({ ...baseFiles(manifest), ...files });
  return validatePack(root);
}

function evaluation(manifest: JsonObject, index = 0): JsonObject {
  return (manifest["evals"] as JsonObject[])[index] as JsonObject;
}

function promptSet(manifest: JsonObject, index = 0): JsonObject {
  return (manifest["prompt_sets"] as JsonObject[])[index] as JsonObject;
}

describe("identifier uniqueness", () => {
  it("reports a repeated prompt set id", async () => {
    const result = await check((manifest) => {
      const sets = manifest["prompt_sets"] as JsonObject[];
      sets.push(structuredClone(promptSet(manifest)));
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.DuplicateId,
        message: textContaining("prompt set")
      })
    );
  });

  it("reports a repeated eval id", async () => {
    const result = await check((manifest) => {
      const evals = manifest["evals"] as JsonObject[];
      evals.push(structuredClone(evaluation(manifest)));
    });
    expect(result.errors).toContainEqual(
      containing({ code: PackCode.DuplicateId })
    );
  });

  it("reports a repeated scenario id", async () => {
    const result = await check((manifest) => {
      (manifest["scenarios"] as JsonObject[]).push({ id: "baseline" });
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.DuplicateId,
        message: textContaining("scenario")
      })
    );
  });
});

describe("cross references", () => {
  it("reports an eval that names an unknown prompt set", async () => {
    const result = await check((manifest) => {
      evaluation(manifest)["prompt_set"] = "ghost";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.PromptSetUnknown,
        json_pointer: "/evals/0/prompt_set"
      })
    );
  });

  it("reports an eval that names an unknown scenario", async () => {
    const result = await check((manifest) => {
      evaluation(manifest)["scenario"] = "ghost";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.ScenarioUnknown,
        json_pointer: "/evals/0/scenario"
      })
    );
  });

  it("reports an eval whose result asset is missing", async () => {
    const result = await check((manifest) => {
      (evaluation(manifest)["result"] as JsonObject)["schema"] =
        "schemas/missing.schema.json";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.AssetMissing,
        json_pointer: "/evals/0/result"
      })
    );
  });

  it("reports an eval whose rubric asset is missing", async () => {
    const result = await check((manifest) => {
      evaluation(manifest)["rubric"] = "evals/missing/rubric.yaml";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.AssetMissing,
        json_pointer: "/evals/0/rubric"
      })
    );
  });
});

describe("operation references", () => {
  it("reports a scope that lists an unknown operation", async () => {
    const result = await check((manifest) => {
      evaluation(manifest)["operation_scope"] = {
        mode: "list",
        operations: ["path:GET /nope"]
      };
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.OperationUnknown,
        message: textContaining("/nope")
      })
    );
  });

  it("reports a fixture that targets an unknown operation", async () => {
    const result = await check((manifest) => {
      (manifest["contract"] as JsonObject)["response_fixtures"] = [
        {
          id: "ghost",
          operation: "path:DELETE /widgets",
          status: 200,
          media_type: "application/json",
          headers: {},
          body: { kind: "none" }
        }
      ];
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.OperationUnknown,
        message: textContaining("DELETE")
      })
    );
  });

  it("reports a fixture status no response declaration matches", async () => {
    const result = await check((manifest) => {
      (manifest["contract"] as JsonObject)["response_fixtures"] = [
        {
          id: "widgets-teapot",
          operation: "path:GET /widgets",
          status: 500,
          media_type: "application/json",
          headers: {},
          body: { kind: "none" }
        }
      ];
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.FixtureSelectorUnknown,
        json_pointer: "/contract/response_fixtures/0/status"
      })
    );
  });

  it("accepts a fixture status matched by a range or default response", async () => {
    const result = await check((manifest) => {
      (manifest["contract"] as JsonObject)["response_fixtures"] = [
        {
          id: "widgets-range",
          operation: "path:GET /widgets",
          status: 404,
          media_type: "application/problem+json",
          headers: {},
          body: { kind: "none" }
        },
        {
          id: "widgets-default",
          operation: "path:POST /widgets",
          status: 503,
          media_type: "application/problem+json",
          headers: {},
          body: { kind: "none" }
        }
      ];
    }, {});
    expect(result.errors).toEqual([]);
  });

  it("reports two default fixtures for one operation", async () => {
    const result = await check((manifest) => {
      (manifest["contract"] as JsonObject)["response_fixtures"] = [
        {
          id: "first",
          operation: "path:GET /widgets",
          status: 200,
          media_type: "application/json",
          headers: {},
          default: true,
          body: { kind: "none" }
        },
        {
          id: "second",
          operation: "path:GET /widgets",
          status: 200,
          media_type: "application/json",
          headers: {},
          default: true,
          body: { kind: "none" }
        }
      ];
    });
    expect(result.errors).toContainEqual(
      containing({ code: PackCode.FixtureDefaultDuplicate })
    );
  });

  it("reports an idempotency policy over an unknown operation", async () => {
    const result = await check((manifest) => {
      manifest["idempotency"] = {
        policies: [{ id: "ghost", operations: ["path:PUT /widgets"] }]
      };
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.OperationUnknown,
        message: textContaining("policy ghost")
      })
    );
  });

  it("reports mode all when the contract declares no operation", async () => {
    const files = {
      "contract/openapi.json": `${JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Empty", version: "1.0.0" },
        paths: {}
      })}\n`
    };
    const result = await check(() => undefined, files);
    expect(result.errors).toContainEqual(
      containing({ code: PackCode.ScopeEmpty })
    );
    expect(result.coverage.contractOperations).toEqual([]);
  });
});

describe("behavior invariants", () => {
  it("reports scenario mode without a backend", async () => {
    const result = await check((manifest) => {
      (manifest["behavior"] as JsonObject)["mode"] = "scenario";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.AssetMissing,
        json_pointer: "/behavior/backend"
      })
    );
  });

  it("reports exact completeness combined with a fallback", async () => {
    const result = await check((manifest) => {
      (manifest["behavior"] as JsonObject)["fallback"] = "contract";
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.CompletenessConflict,
        json_pointer: "/behavior/fallback"
      })
    );
  });

  it("accepts partial completeness with a contract fallback", async () => {
    const result = await check((manifest) => {
      const behavior = manifest["behavior"] as JsonObject;
      behavior["completeness"] = "partial";
      behavior["fallback"] = "contract";
    });
    expect(
      result.errors.filter(
        (entry) => entry.code === PackCode.CompletenessConflict
      )
    ).toEqual([]);
  });
});

describe("participant targets", () => {
  it("reports two sources that materialize the same target path", async () => {
    const result = await check((manifest) => {
      const evaluation0 = evaluation(manifest);
      (evaluation0["participant_files"] as JsonObject[])[0] = {
        source: "schemas/result.schema.json",
        target: "TASK.md"
      };
    });
    expect(result.errors).toContainEqual(
      containing({
        code: PackCode.TargetDuplicate,
        message: textContaining("TASK.md")
      })
    );
  });
});

describe("clean pack", () => {
  it("validates the base pack with errors only from the IR build", async () => {
    const root = await writePack(baseFiles());
    const result = await validatePack(root);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.packIr).not.toBeNull();
  });
});
