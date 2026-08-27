import { afterEach, describe, expect, it } from "vitest";

import {
  DiagnosticCode,
  invalidInput,
  isJsonObject,
  sha256HexBytes,
  type JsonObject
} from "@oal/core";

import { PackCode } from "./codes.ts";
import {
  loadPack,
  PACK_MANIFEST_NAMES,
  parsePackDocument
} from "./manifest.ts";
import {
  baseFiles,
  baseManifest,
  baseYamlFiles,
  cleanupPacks,
  containing,
  textContaining,
  writePack
} from "./testkit.ts";

afterEach(async () => {
  await cleanupPacks();
});

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

describe("loadPack happy path", () => {
  it("loads a YAML manifest pack without content diagnostics", async () => {
    const root = await writePack(baseYamlFiles());
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toEqual([]);
    expect(loaded.manifestName).toBe("pack.yaml");
    expect(loaded.manifest["metadata"]).toMatchObject({ id: "test-pack" });
    expect(loaded.semanticEventRegistry).toBeNull();
  });

  it("loads a JSON manifest pack and resolves every reference", async () => {
    const root = await writePack(baseFiles());
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toEqual([]);
    expect(loaded.manifestName).toBe("pack.json");

    const byRole = new Map(loaded.references.map((r) => [r.role, r]));
    expect([...byRole.keys()]).toEqual([
      "contract_entrypoint",
      "prompt_instructions",
      "prompt_launch",
      "task",
      "participant_file",
      "result_schema",
      "rubric"
    ]);
    const contract = byRole.get("contract_entrypoint");
    expect(contract?.document).toMatchObject({ openapi: "3.1.0" });
    expect(contract?.bytes).toBeGreaterThan(0);
    expect(contract?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const instructions = byRole.get("prompt_instructions");
    expect(instructions?.text).toContain("Participant instructions");
    expect(instructions?.document).toBeNull();
  });

  it("digests the manifest bytes it read", async () => {
    const root = await writePack(baseFiles());
    const loaded = await loadPack(root);
    const expected = sha256HexBytes(
      new TextEncoder().encode(baseFiles()["pack.json"] ?? "")
    );
    expect(loaded.manifestSha256).toBe(expected);
    expect(loaded.manifestBytes).toBe(baseFiles()["pack.json"]?.length);
  });
});

describe("manifest discovery", () => {
  it("throws when the pack directory does not exist", async () => {
    await expect(
      loadPack("/tmp/oal-pack-does-not-exist")
    ).rejects.toMatchObject({ code: PackCode.ManifestMissing });
  });

  it("throws when no manifest is present", async () => {
    const files = baseFiles();
    delete files["pack.json"];
    const root = await writePack(files);
    await expect(loadPack(root)).rejects.toMatchObject({
      code: PackCode.ManifestMissing
    });
  });

  it("throws when both manifest names are present", async () => {
    const root = await writePack({ ...baseFiles(), ...baseYamlFiles() });
    await expect(loadPack(root)).rejects.toMatchObject({
      code: PackCode.ManifestAmbiguous
    });
    expect(PACK_MANIFEST_NAMES).toEqual(["pack.yaml", "pack.json"]);
  });

  it("reports a schema violation with a manifest pointer", async () => {
    const manifest = baseManifest();
    (manifest["metadata"] as JsonObject)["version"] = "not-semver";
    const root = await writePack(baseFiles(manifest));
    const loaded = await loadPack(root);
    const violation = loaded.diagnostics.find(
      (entry) => entry.code === DiagnosticCode.PackSchemaInvalid
    );
    expect(violation?.json_pointer).toBe("/metadata/version");
  });

  it("rejects an unsupported manifest api version before load completes", async () => {
    const manifest = baseManifest();
    manifest["apiVersion"] = "agentlab.dev/v2";
    const root = await writePack(baseFiles(manifest));
    const loaded = await loadPack(root);
    expect(loaded.diagnostics).toContainEqual(
      containing({
        code: DiagnosticCode.PackSchemaInvalid,
        json_pointer: "/apiVersion"
      })
    );
  });

  it("reports an unparsable manifest as a diagnostic, not a throw", async () => {
    const root = await writePack({ "pack.yaml": "metadata:\n  broken\n" });
    const loaded = await loadPack(root);
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    expect(loaded.manifest).toEqual({});
  });
});

describe("referenced assets", () => {
  it("reports a missing asset file", async () => {
    const manifest = baseManifest();
    const evaluation = (manifest["evals"] as JsonObject[])[0] as JsonObject;
    (evaluation["task"] as JsonObject)["source"] = "tasks/smoke/missing.md";
    const root = await writePack(baseFiles(manifest));
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toContain(PackCode.AssetNotFile);
  });

  it("rejects a path that escapes the pack root", async () => {
    const manifest = baseManifest();
    const evaluation = (manifest["evals"] as JsonObject[])[0] as JsonObject;
    (evaluation["task"] as JsonObject)["source"] = "../outside.md";
    const root = await writePack(baseFiles(manifest));
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toContain(PackCode.PathUnsafe);
  });

  it("enforces the artifact byte limit", async () => {
    const root = await writePack(baseFiles());
    const loaded = await loadPack(root, { maxArtifactBytes: 8 });
    expect(loaded.diagnostics).toContainEqual(
      containing({ code: PackCode.AssetTooLarge })
    );
  });

  it("reports a contract that is not OpenAPI 3", async () => {
    const files = baseFiles();
    files["contract/openapi.json"] = `${JSON.stringify({
      openapi: "2.0",
      info: { title: "x", version: "1" },
      paths: {}
    })}\n`;
    const root = await writePack(files);
    const loaded = await loadPack(root);
    expect(loaded.diagnostics).toContainEqual(
      containing({
        code: PackCode.ContractInvalid,
        message: textContaining("OpenAPI 3")
      })
    );
  });

  it("warns when a result schema declares another draft", async () => {
    const files = baseFiles();
    files["schemas/result.schema.json"] = `${JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object"
    })}\n`;
    const root = await writePack(files);
    const loaded = await loadPack(root);
    const warning = loaded.diagnostics.find(
      (entry) => entry.code === PackCode.SchemaDraft
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("draft-07");
  });

  it("loads a json_file response fixture body as a document", async () => {
    const manifest = baseManifest();
    const contract = manifest["contract"] as {
      response_fixtures: unknown[];
    };
    contract["response_fixtures"] = [
      {
        id: "widgets-ok",
        operation: "path:GET /widgets",
        status: 200,
        media_type: "application/json",
        headers: {},
        body: { kind: "json_file", source: "fixtures/widgets.json" }
      }
    ];
    const files = baseFiles(manifest);
    files["fixtures/widgets.json"] = `${JSON.stringify({ total: 0 })}\n`;
    const root = await writePack(files);
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toEqual([]);
    const fixture = loaded.references.find((r) => r.role === "fixture_body");
    expect(fixture?.document).toEqual({ total: 0 });
  });
});

const EVENT_SCHEMA = `${JSON.stringify({ type: "object" })}\n`;

function eventSchemaDigest(): string {
  return sha256HexBytes(new TextEncoder().encode(EVENT_SCHEMA));
}

describe("semantic event registry", () => {
  function registryFiles(
    packId: string,
    digest: string
  ): Record<string, string> {
    const files = baseFiles();
    files["schemas/event.schema.json"] = EVENT_SCHEMA;
    files["events/registry.json"] = `${JSON.stringify({
      schema_version: 1,
      kind: "SemanticEventRegistry",
      pack_id: packId,
      events: [
        {
          name: "widget.created",
          event_version: 1,
          payload_schema: "schemas/event.schema.json",
          payload_schema_sha256: digest
        }
      ],
      extensions: {}
    })}\n`;
    return files;
  }

  it("loads a registry whose digests match", async () => {
    const files = registryFiles("test-pack", eventSchemaDigest());
    const root = await writePack(files);
    const loaded = await loadPack(root);
    expect(codesOf(loaded.diagnostics)).toEqual([]);
    expect(loaded.semanticEventRegistry).toMatchObject({
      pack_id: "test-pack"
    });
  });

  it("reports a pack identifier mismatch", async () => {
    const files = registryFiles("other-pack", eventSchemaDigest());
    const root = await writePack(files);
    const loaded = await loadPack(root);
    expect(loaded.diagnostics).toContainEqual(
      containing({ code: PackCode.RegistryPackMismatch })
    );
  });

  it("reports a payload schema digest mismatch", async () => {
    const files = registryFiles("test-pack", "1".repeat(64));
    const root = await writePack(files);
    const loaded = await loadPack(root);
    expect(loaded.diagnostics).toContainEqual(
      containing({ code: PackCode.RegistryDigestMismatch })
    );
  });
});

describe("parsePackDocument", () => {
  it("parses strict JSON and the YAML subset by shape", () => {
    expect(parsePackDocument('{"a": 1}', "x").value).toEqual({ a: 1 });
    expect(parsePackDocument("a: 1\n", "x").value).toEqual({ a: 1 });
    expect(parsePackDocument("[1]", "x").value).toEqual([1]);
  });

  it("returns a diagnostic for broken JSON and broken YAML", () => {
    const json = parsePackDocument("{", "pack.json");
    expect(json.value).toBeNull();
    expect(json.diagnostic?.code).toBe(DiagnosticCode.JsonInvalid);
    const yaml = parsePackDocument("a: *alias\n", "pack.yaml");
    expect(yaml.value).toBeNull();
    expect(yaml.diagnostic?.code).toBe(DiagnosticCode.YamlInvalid);
  });
});

describe("invalidInput mapping", () => {
  it("produces the OAL error shape with exit code 2", () => {
    const error = invalidInput(PackCode.ManifestMissing, "gone");
    expect(error.code).toBe(PackCode.ManifestMissing);
    expect(error.category).toBe("input");
    expect(error.exitCode).toBe(2);
  });

  it("keeps the manifest an object after loading", async () => {
    const root = await writePack(baseFiles());
    const loaded = await loadPack(root);
    expect(isJsonObject(loaded.manifest)).toBe(true);
  });
});
