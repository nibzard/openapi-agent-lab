import { describe, expect, it } from "vitest";

import { sha256Hex, type JsonObject } from "@oal/core";

import {
  checkContractVariantSetSemantics,
  documentationFactsSha256,
  loadContractVariantDiff,
  loadContractVariantManifest,
  loadContractVariantSet,
  packRegistrySnapshot,
  packSemanticEntriesFromEventRegistry,
  scanForExecutableContent,
  surfaceEntryMatches,
  SURFACE_ID_PATTERN,
  VariantCode,
  type ContractVariantSet
} from "./model.ts";
import { BASE_CONTRACT, buildSet, loadSchemas, loadSet } from "./testkit.ts";
import type { VariantFixture } from "./testkit.ts";

const schemas = loadSchemas();

function codes(diagnostics: readonly { code: string }[]): string[] {
  return [...new Set(diagnostics.map((entry) => entry.code))].sort();
}

const variant: VariantFixture = {
  id: "verbose",
  allowlist: ["/paths/~1tasks/get/responses/200"],
  patch: [
    {
      op: "replace",
      path: "/paths/~1tasks/get/responses/200/description",
      value: "The task list with every field."
    }
  ]
};

function minimalSet(): JsonObject {
  return buildSet({
    common: {
      patch: [{ op: "add", path: "/info/contact", value: { name: "Support" } }],
      allowlist: ["/info/contact"]
    },
    variants: [variant]
  });
}

describe("loading a ContractVariantSet", () => {
  it("accepts a schema-valid set with a common projection", async () => {
    const result = await loadContractVariantSet(minimalSet(), schemas);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("tasks-counterfactual");
      expect(result.value.common_projection?.allowlist).toEqual([
        "/info/contact"
      ]);
      expect(result.value.variants[0]?.id).toBe("verbose");
    }
  });

  it("accepts a set without a common projection", async () => {
    const result = await loadContractVariantSet(
      buildSet({ common: null, variants: [variant] }),
      schemas
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a document that violates the schema", async () => {
    const broken = minimalSet();
    delete (broken as { variants?: unknown }).variants;
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.SchemaInvalid]);
    }
  });

  it("rejects text that is not JSON", async () => {
    const result = await loadContractVariantSet("{ not json", schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.SchemaInvalid]);
    }
  });

  it("rejects a document that is not an object", async () => {
    const result = await loadContractVariantSet("[1,2]", schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.NotAnObject]);
    }
  });

  it("rejects base bytes that do not match the pinned digest", async () => {
    const broken = minimalSet();
    const base = broken.base as { sha256: string };
    base.sha256 = sha256Hex("other bytes");
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.DigestMismatch]);
    }
  });

  it("rejects duplicate variant ids", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: null,
        variants: [variant, { ...variant, patch: variant.patch }]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([
        VariantCode.DuplicateVariantId
      ]);
    }
  });

  it("rejects a common projection patch outside its allowlist", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: {
          patch: [
            {
              op: "replace",
              path: "/info/title",
              value: "Other"
            }
          ],
          allowlist: ["/info/contact"]
        },
        variants: [variant]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toContain(
        VariantCode.AllowlistViolation
      );
    }
  });

  it("rejects a variant patch outside its allowlist", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: null,
        variants: [
          {
            id: "drifty",
            allowlist: ["/paths/~1tasks/get/summary"],
            patch: [
              {
                op: "replace",
                path: "/paths/~1tasks/get/responses/200/description",
                value: "The task list."
              }
            ]
          }
        ]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toContain(
        VariantCode.AllowlistViolation
      );
    }
  });

  it("rejects allowlists that overlap between layers", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: {
          patch: [
            { op: "add", path: "/info/contact", value: { name: "Support" } }
          ],
          allowlist: ["/info"]
        },
        variants: [
          {
            id: "retitled",
            allowlist: ["/info/title"],
            patch: [
              {
                op: "replace",
                path: "/info/title",
                value: "Renamed Task Service"
              }
            ]
          }
        ]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.LayerOverlap]);
    }
  });

  it("rejects a declared transform digest that does not match the patch", async () => {
    const broken = minimalSet();
    const first = (broken.variants as unknown as Array<JsonObject>)[0] as {
      transform: JsonObject;
    };
    first.transform.sha256 = sha256Hex("other patch");
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.DigestMismatch]);
    }
  });

  it("rejects an adapter selection for an undeclared operation", async () => {
    const broken = minimalSet();
    const first = (broken.variants as unknown as Array<JsonObject>)[0] as {
      behavior_adapters: Array<JsonObject>;
    };
    first.behavior_adapters.push({
      operation: "path:DELETE /tasks",
      adapter_id: "tasks-read-adapter",
      adapter_sha256: sha256Hex("tasks-read-adapter v1")
    });
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.OperationUnknown]);
    }
  });

  it("rejects an operation key with an unsupported method", async () => {
    const broken = minimalSet();
    const first = (broken.variants as unknown as Array<JsonObject>)[0] as {
      expected_operations: string[];
    };
    // The schema pattern accepts any uppercase method, so only the semantic
    // check can reject this key.
    first.expected_operations = first.expected_operations.map((key) =>
      key.replace("path:GET ", "path:FETCH ")
    );
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toContain(
        VariantCode.OperationKeyInvalid
      );
    }
  });

  it("rejects duplicate documentation example ids", async () => {
    const broken = minimalSet();
    const first = (broken.variants as unknown as Array<JsonObject>)[0] as {
      documentation: { examples: Array<JsonObject> };
    };
    first.documentation.examples.push({ ...first.documentation.examples[0] });
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([
        VariantCode.DuplicateExampleId
      ]);
    }
  });

  it("rejects a documentation digest that does not match the inventory", async () => {
    const broken = minimalSet();
    const first = (broken.variants as unknown as Array<JsonObject>)[0] as {
      documentation: { facts_sha256: string };
    };
    first.documentation.facts_sha256 = sha256Hex("other facts");
    const result = await loadContractVariantSet(broken, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.DigestMismatch]);
    }
  });

  it("rejects a surface declared both constant and variable", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: null,
        variants: [variant],
        expectedConstant: ["api:title"],
        expectedVariable: ["api:title"]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.SurfaceConflict]);
    }
  });

  it("rejects a malformed surface id", async () => {
    const result = await loadContractVariantSet(
      buildSet({
        common: null,
        variants: [variant],
        expectedConstant: ["not a surface"]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.SurfaceIdInvalid]);
    }
  });

  it("requires the root pointer for a static variant", async () => {
    const staticSet = buildSet({ common: null, variants: [variant] });
    const first = (staticSet.variants as unknown as Array<JsonObject>)[0] as {
      transform: JsonObject;
      allowlist: string[];
      effective_sha256: string;
    };
    first.transform = {
      kind: "static",
      source: BASE_CONTRACT,
      sha256: sha256Hex(BASE_CONTRACT)
    };
    first.effective_sha256 = sha256Hex(BASE_CONTRACT);
    first.allowlist = ["/info"];
    const result = await loadContractVariantSet(staticSet, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.StaticAllowlist]);
    }
  });

  it("accepts a static variant that declares the root pointer", async () => {
    const staticSet = buildSet({ common: null, variants: [variant] });
    const first = (staticSet.variants as unknown as Array<JsonObject>)[0] as {
      transform: JsonObject;
      allowlist: string[];
      effective_sha256: string;
    };
    first.transform = {
      kind: "static",
      source: BASE_CONTRACT,
      sha256: sha256Hex(BASE_CONTRACT)
    };
    first.effective_sha256 = sha256Hex(BASE_CONTRACT);
    first.allowlist = [""];
    const result = await loadContractVariantSet(staticSet, schemas);
    expect(result.ok).toBe(true);
  });
});

describe("executable content", () => {
  it("flags module paths and handler source", () => {
    const withModule = scanForExecutableContent(
      { note: "load backend.js before start" },
      "#"
    );
    expect(codes(withModule)).toEqual([VariantCode.ExecutableContent]);

    const withRequire = scanForExecutableContent(
      { note: "calls require('./x')" },
      "#"
    );
    expect(codes(withRequire)).toEqual([VariantCode.ExecutableContent]);

    const clean = scanForExecutableContent({ note: "plain text" }, "#");
    expect(clean).toEqual([]);
  });

  it("flags executable content inside base source bytes", async () => {
    const poisoned = BASE_CONTRACT.replace(
      '"title": "Task Service"',
      '"title": "Task Service", "description": "see runner.mjs for details"'
    );
    const result = await loadContractVariantSet(
      buildSet({
        base: poisoned,
        common: null,
        variants: [variant]
      }),
      schemas
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([
        VariantCode.ExecutableContent
      ]);
    }
  });
});

describe("semantic checks called directly", () => {
  it("flags an allowlist entry that is not a valid pointer", async () => {
    const set = await loadSet({ common: null, variants: [variant] });
    const first = set.variants[0];
    const broken: ContractVariantSet =
      first === undefined
        ? set
        : {
            ...set,
            variants: [{ ...first, allowlist: ["info/description"] }]
          };
    const diagnostics = checkContractVariantSetSemantics(broken);
    // The invalid entry also stops covering the patch, so both codes appear.
    expect(codes(diagnostics)).toEqual([
      VariantCode.AllowlistViolation,
      VariantCode.PointerInvalid
    ]);
  });
});

describe("surface expectations", () => {
  it("matches exact ids and kind wildcards", () => {
    expect(surfaceEntryMatches("api:title", "api:title")).toBe(true);
    expect(surfaceEntryMatches("api", "api:title")).toBe(true);
    expect(surfaceEntryMatches("api", "api")).toBe(true);
    expect(surfaceEntryMatches("api:version", "api:title")).toBe(false);
    expect(SURFACE_ID_PATTERN.test("operation:path:GET /tasks")).toBe(true);
    expect(SURFACE_ID_PATTERN.test("Not A Kind")).toBe(false);
  });
});

describe("pack registry snapshots", () => {
  it("derives semantic entries from a pack event registry", () => {
    const entries = packSemanticEntriesFromEventRegistry({
      schema_version: 1,
      kind: "SemanticEventRegistry",
      pack_id: "tasks-pack",
      events: [
        {
          name: "tasks.listed",
          event_version: 1,
          payload_schema: "{}",
          payload_schema_sha256: sha256Hex("{}")
        }
      ],
      extensions: {}
    });
    expect(entries).toEqual([
      { id: "tasks.listed", sha256: sha256Hex("{}"), kind: "action" },
      { id: "tasks.listed", sha256: sha256Hex("{}"), kind: "schema" }
    ]);
  });

  it("drops adapters that do not carry the required members", () => {
    const snapshot = packRegistrySnapshot({
      packId: "p",
      packVersion: "1.0.0",
      packSha256: sha256Hex("p"),
      adapters: [
        {
          adapter_id: "good",
          adapter_sha256: sha256Hex("good"),
          capability: "supported",
          operations: ["path:GET /tasks"]
        },
        { adapter_id: "bad" }
      ]
    });
    expect(snapshot.adapters).toHaveLength(1);
    expect(snapshot.adapters[0]?.adapter_id).toBe("good");
  });

  it("computes the documentation digest over facts and placements", () => {
    const digest = documentationFactsSha256({
      fact_ids: ["b", "a"],
      placement_classes: ["route-index"],
      examples: []
    });
    expect(digest).toBe(
      documentationFactsSha256({
        fact_ids: ["a", "b"],
        placement_classes: ["route-index"],
        examples: [{ id: "ignored", sha256: "x" }]
      })
    );
  });
});

describe("manifest and diff loaders", () => {
  it("rejects a manifest whose diff path escapes the artifact root", async () => {
    const manifest = {
      schema_version: 1,
      kind: "ContractVariantManifest",
      variant_id: "verbose",
      set_id: "tasks-counterfactual",
      base_sha256: sha256Hex("base"),
      transform_sha256: sha256Hex("transform"),
      effective: {
        openapi_sha256: sha256Hex("openapi"),
        semantic_sha256: sha256Hex("semantic"),
        execution_sha256: sha256Hex("execution"),
        operation_count: 1
      },
      capability_report_sha256: sha256Hex("report"),
      behavior_adapters: [
        {
          operation: "path:GET /tasks",
          adapter_id: "tasks-read-adapter",
          adapter_sha256: sha256Hex("adapter")
        }
      ],
      diff_path: "../escape.json",
      extensions: {}
    };
    const result = await loadContractVariantManifest(manifest, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.PathInvalid]);
    }
  });

  it("accepts a schema-conformant manifest", async () => {
    const manifest = {
      schema_version: 1,
      kind: "ContractVariantManifest",
      variant_id: "verbose",
      set_id: "tasks-counterfactual",
      base_sha256: sha256Hex("base"),
      common_projection_sha256: null,
      transform_sha256: sha256Hex("transform"),
      effective: {
        openapi_sha256: sha256Hex("openapi"),
        semantic_sha256: sha256Hex("semantic"),
        execution_sha256: sha256Hex("execution"),
        operation_count: 2
      },
      capability_report_sha256: sha256Hex("report"),
      behavior_adapters: [
        {
          operation: "path:GET /tasks",
          adapter_id: "tasks-read-adapter",
          adapter_sha256: sha256Hex("adapter")
        }
      ],
      diff_path: "variants/verbose/contract-variant-diff.json",
      extensions: {}
    };
    const result = await loadContractVariantManifest(manifest, schemas);
    expect(result.ok).toBe(true);
  });

  it("rejects a diff that claims to be verified while carrying violations", async () => {
    const diff = {
      schema_version: 1,
      variant_id: "verbose",
      base_sha256: sha256Hex("base"),
      effective_sha256: sha256Hex("effective"),
      differences: [],
      violations: [{ pointer: "/components", reason: "drift" }],
      operation_inventory: { added: [], removed: [], unchanged_count: 1 },
      verified: true,
      extensions: {}
    };
    const result = await loadContractVariantDiff(diff, schemas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual([VariantCode.SurfaceConflict]);
    }
  });

  it("rejects an unrelated difference marked allowlisted", async () => {
    const diff = {
      schema_version: 1,
      variant_id: "verbose",
      base_sha256: sha256Hex("base"),
      effective_sha256: sha256Hex("effective"),
      differences: [
        {
          pointer: "/components",
          layer: "unrelated",
          op: "replace",
          allowlisted: true
        }
      ],
      violations: [],
      operation_inventory: { added: [], removed: [], unchanged_count: 1 },
      verified: true,
      extensions: {}
    };
    const result = await loadContractVariantDiff(diff, schemas);
    expect(result.ok).toBe(false);
  });
});
