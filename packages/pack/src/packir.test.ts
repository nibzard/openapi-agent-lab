import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonSha256, type JsonObject } from "@oal/core";

import { PackCode } from "./codes.ts";
import {
  buildPackIr,
  contractIndexFromDocument,
  packIrCanonicalText,
  resolveOperationScope,
  templateVariables
} from "./packir.ts";
import { loadPack } from "./manifest.ts";
import {
  baseFiles,
  baseManifest,
  cleanupPacks,
  CONTRACT_DOCUMENT,
  writePack
} from "./testkit.ts";

afterEach(async () => {
  await cleanupPacks();
});

function errorCodes(
  diagnostics: readonly { code: string; severity: string }[]
): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("digest stability", () => {
  it("builds byte-identical canonical PackIR text on rebuild", async () => {
    const root = await writePack(baseFiles());
    const loaded = await loadPack(root);
    const first = buildPackIr(loaded);
    const second = buildPackIr(loaded);
    expect(first.ir).not.toBeNull();
    expect(packIrCanonicalText(first.ir as JsonObject)).toBe(
      packIrCanonicalText(second.ir as JsonObject)
    );
  });

  it("changes the prompt digest when prompt bytes change", async () => {
    const firstRoot = await writePack(baseFiles());
    const secondFiles = baseFiles();
    secondFiles["prompts/smoke/instructions.md"] =
      "# Participant instructions\n\nChanged bytes.\n";
    const secondRoot = await writePack(secondFiles);

    const first = buildPackIr(await loadPack(firstRoot)).ir as JsonObject;
    const second = buildPackIr(await loadPack(secondRoot)).ir as JsonObject;
    expect(first["prompt_sets"]).not.toEqual(second["prompt_sets"]);
    expect(canonicalJsonSha256(first)).not.toBe(canonicalJsonSha256(second));
  });

  it("keeps the contract digests independent of manifest formatting", async () => {
    const root = await writePack(baseFiles());
    const pretty = buildPackIr(await loadPack(root)).ir as JsonObject;
    const compactFiles = baseFiles();
    compactFiles["pack.json"] = `${JSON.stringify(baseManifest())}\n`;
    const compactRoot = await writePack(compactFiles);
    const compact = buildPackIr(await loadPack(compactRoot)).ir as JsonObject;
    expect(pretty["contract"]).toEqual(compact["contract"]);
    expect((pretty["pack"] as JsonObject)["manifest_sha256"]).not.toBe(
      (compact["pack"] as JsonObject)["manifest_sha256"]
    );
  });
});

describe("resolved defaults", () => {
  it("fills the version 1 defaults for a contract-mode pack", async () => {
    const root = await writePack(baseFiles());
    const { ir } = buildPackIr(await loadPack(root));
    const packIr = ir as JsonObject;
    expect(packIr["schema_version"]).toBe(1);
    expect(packIr["kind"]).toBe("PackIR");
    expect(packIr["behavior"]).toEqual({
      mode: "contract",
      completeness: "exact",
      fallback: "none"
    });
    expect(packIr["trust"]).toEqual({
      execution_profile: "contract-safe",
      isolation: "hard"
    });
    expect(packIr["limits"]).toEqual({
      max_agent_tool_calls: 500,
      max_api_requests: 10000,
      max_artifact_bytes: 1073741824
    });
  });

  it("applies scenario trust and clock defaults for a scenario pack", async () => {
    const manifest = baseManifest();
    const behavior = manifest["behavior"] as JsonObject;
    behavior["mode"] = "scenario";
    behavior["backend"] = {
      kind: "module",
      entrypoint: "behavior/index.ts",
      export: "backend"
    };
    behavior["clock"] = { kind: "virtual" };
    const files = baseFiles(manifest);
    files["behavior/index.ts"] = "export const backend = null;\n";
    const root = await writePack(files);

    const result = buildPackIr(await loadPack(root));
    const packIr = result.ir as JsonObject;
    expect(packIr["behavior"]).toEqual({
      mode: "scenario",
      completeness: "exact",
      fallback: "none",
      clock: {
        kind: "virtual",
        initial: "2000-01-01T00:00:00.000Z",
        tick_ms: 1
      }
    });
    expect(packIr["trust"]).toEqual({
      execution_profile: "trusted-local",
      isolation: "advisory"
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: PackCode.IsolationAdvisory })
    );
  });

  it("honors explicit limits passed by the caller", async () => {
    const root = await writePack(baseFiles());
    const { ir } = buildPackIr(await loadPack(root), {
      limits: {
        max_agent_tool_calls: 5,
        max_api_requests: 6,
        max_artifact_bytes: 7
      }
    });
    expect((ir as JsonObject)["limits"]).toEqual({
      max_agent_tool_calls: 5,
      max_api_requests: 6,
      max_artifact_bytes: 7
    });
  });

  it("records mustache variables for strict templates", async () => {
    const manifest = baseManifest();
    const sets = manifest["prompt_sets"] as JsonObject[];
    (sets[0] as JsonObject)["instructions"] = {
      source: "prompts/smoke/instructions.md",
      engine: "mustache-strict",
      delivery: "file",
      target: "AGENTS.md"
    };
    (sets[0] as JsonObject)["launch"] = {
      source: "prompts/smoke/launch.txt",
      engine: "mustache-strict"
    };
    const files = baseFiles(manifest);
    files["prompts/smoke/instructions.md"] =
      "Base URL: {{base_url}}\nRepeat: {{base_url}}\n";
    files["prompts/smoke/launch.txt"] = "Token {{api_key}} only.\n";
    const root = await writePack(files);

    const { ir } = buildPackIr(await loadPack(root));
    const sets2 = (ir as JsonObject)["prompt_sets"] as JsonObject[];
    expect((sets2[0] as JsonObject)["variables"]).toEqual([
      "api_key",
      "base_url"
    ]);
  });
});

describe("operation coverage", () => {
  it("indexes every operation of the contract document", () => {
    const index = contractIndexFromDocument(CONTRACT_DOCUMENT);
    expect(index.operations).toEqual([
      "path:GET /widgets",
      "path:POST /widgets"
    ]);
    expect(index.methodOf.get("path:GET /widgets")).toBe("GET");
  });

  it("resolves all, list, and selector scopes", () => {
    const index = contractIndexFromDocument(CONTRACT_DOCUMENT);
    expect(resolveOperationScope({ mode: "all" }, index)).toEqual([
      "path:GET /widgets",
      "path:POST /widgets"
    ]);
    expect(
      resolveOperationScope(
        { mode: "list", operations: ["path:GET /widgets", "path:GET /nope"] },
        index
      )
    ).toEqual(["path:GET /widgets"]);
    expect(
      resolveOperationScope(
        { mode: "selector", selector: { kind: "methods", methods: ["POST"] } },
        index
      )
    ).toEqual(["path:POST /widgets"]);
    expect(resolveOperationScope({ mode: "selector" }, index)).toEqual([]);
  });

  it("maps response fixtures and idempotency onto operations", async () => {
    const manifest = baseManifest();
    (manifest["contract"] as JsonObject)["response_fixtures"] = [
      {
        id: "widgets-ok",
        operation: "path:GET /widgets",
        status: 200,
        media_type: "application/json",
        headers: {},
        body: { kind: "none" }
      }
    ];
    manifest["idempotency"] = {
      policies: [
        {
          id: "create-widget",
          operations: ["path:POST /widgets"]
        }
      ]
    };
    const root = await writePack(baseFiles(manifest));
    const { coverage, diagnostics } = buildPackIr(await loadPack(root));
    expect(coverage.contractOperations).toEqual([
      "path:GET /widgets",
      "path:POST /widgets"
    ]);
    expect(coverage.fixtureIds.get("path:GET /widgets")).toEqual([
      "widgets-ok"
    ]);
    expect(coverage.idempotencyOperations).toEqual(["path:POST /widgets"]);
    expect(coverage.scope.get("smoke")).toEqual([
      "path:GET /widgets",
      "path:POST /widgets"
    ]);
    expect(errorCodes(diagnostics)).toEqual([]);
  });

  it("reports an empty scope as an error", async () => {
    const manifest = baseManifest();
    const evals = manifest["evals"] as JsonObject[];
    (evals[0] as JsonObject)["operation_scope"] = {
      mode: "list",
      operations: ["path:GET /nope"]
    };
    const root = await writePack(baseFiles(manifest));
    const { coverage, diagnostics } = buildPackIr(await loadPack(root));
    expect(coverage.scope.get("smoke")).toEqual([]);
    expect(errorCodes(diagnostics)).toEqual([PackCode.ScopeEmpty]);
  });

  it("fails closed when the contract entrypoint is unavailable", async () => {
    const manifest = baseManifest();
    (manifest["contract"] as JsonObject)["entrypoint"] =
      "contract/missing.json";
    const root = await writePack(baseFiles(manifest));
    const result = buildPackIr(await loadPack(root));
    expect(result.ir).toBeNull();
    expect(errorCodes(result.diagnostics)).toEqual([PackCode.ScopeEmpty]);
    expect(result.coverage.contractOperations).toEqual([]);
  });
});

describe("templateVariables", () => {
  it("collects unique sorted mustache names", () => {
    expect(templateVariables("{{b}} {{ a }} {{b}} plain {{c.d}}")).toEqual([
      "a",
      "b",
      "c.d"
    ]);
    expect(templateVariables("no tags here")).toEqual([]);
  });
});

describe("serialized shape", () => {
  it("carries exactly the sections that pack-ir.v1 requires", async () => {
    const root = await writePack(baseFiles());
    const { ir } = buildPackIr(await loadPack(root));
    expect(Object.keys(ir as JsonObject).sort()).toEqual([
      "behavior",
      "contract",
      "credentials",
      "evals",
      "extensions",
      "kind",
      "limits",
      "pack",
      "participant_files",
      "prompt_sets",
      "scenarios",
      "schema_version",
      "trust",
      "warnings"
    ]);
  });

  it("records one participant file row per materialized target", async () => {
    const root = await writePack(baseFiles());
    const { ir } = buildPackIr(await loadPack(root));
    const files = (ir as JsonObject)["participant_files"] as JsonObject[];
    expect(files.map((file) => file["target"])).toEqual([
      "AGENTS.md",
      "TASK.md",
      "result.schema.json"
    ]);
    for (const file of files) {
      expect(file["sha256"]).toMatch(/^[a-f0-9]{64}$/);
      expect(file["bytes"]).toBeGreaterThan(0);
    }
  });
});
