import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type Json } from "@oal/core";

import {
  documentationFactsSha256,
  loadContractVariantSet,
  patchTransformSha256,
  type ContractVariant,
  type ContractVariantSet
} from "./model.ts";
import {
  materializeContractVariantSet,
  materializeVariant,
  scanForLeakedLabels,
  transformSha256,
  GenerateCode,
  type MaterializeResult,
  type MaterializeSetResult
} from "./generate.ts";
import { applyJsonPatch, type JsonPatchOperation } from "./patch.ts";
import {
  BASE_CONTRACT,
  buildSet,
  fixturePack,
  loadSet,
  loadSchemas,
  type SetFixture,
  type VariantFixture
} from "./testkit.ts";

const schemas = loadSchemas();
const pack = fixturePack();

const COMMON: NonNullable<SetFixture["common"]> = {
  patch: [{ op: "add", path: "/info/contact", value: { name: "Support" } }],
  allowlist: ["/info/contact"]
};

const VERBOSE: VariantFixture = {
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

const TERSE: VariantFixture = {
  id: "terse",
  allowlist: [
    "/paths/~1tasks/get/responses/200",
    "/paths/~1tasks/get/responses/429"
  ],
  patch: [
    {
      op: "replace",
      path: "/paths/~1tasks/get/responses/200/description",
      value: "Tasks."
    },
    {
      op: "add",
      path: "/paths/~1tasks/get/responses/429",
      value: { description: "Rate limited." }
    }
  ]
};

function failureCodes(
  result: MaterializeResult | MaterializeSetResult
): string[] {
  if (result.ok) {
    throw new Error("Expected the materialization to fail.");
  }
  return [...new Set(result.diagnostics.map((entry) => entry.code))].sort();
}

function replaceVariant(
  set: ContractVariantSet,
  id: string,
  change: (variant: ContractVariant) => ContractVariant
): ContractVariantSet {
  return {
    ...set,
    variants: set.variants.map((entry) =>
      entry.id === id ? change(entry) : entry
    )
  };
}

function mustLoad(text: string): ContractVariantSet {
  const result = loadContractVariantSet(text, schemas);
  if (!result.ok) {
    throw new Error(
      result.diagnostics.map((entry) => entry.message).join("; ")
    );
  }
  return result.value;
}

function mustApply(document: Json, patch: readonly JsonPatchOperation[]): Json {
  const result = applyJsonPatch(document, patch);
  if (!result.ok) {
    throw new Error(
      `The fixture patch does not apply: ${result.issues[0]?.message}`
    );
  }
  return result.document;
}

describe("scanForLeakedLabels", () => {
  it("finds a planted label with its index and excerpt", () => {
    const findings = scanForLeakedLabels(
      '{"description":"The task list for factor B."}'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.label).toBe("factor");
    expect(findings[0]?.index).toBe(34);
    expect(findings[0]?.excerpt).toContain("factor B.");
  });

  it("folds case and honors a custom label set", () => {
    expect(scanForLeakedLabels("ARM GROUP A", ["arm"])).toHaveLength(1);
    expect(scanForLeakedLabels("protocol", [])).toEqual([]);
  });

  it("leaves the hand-built base contract bytes alone", () => {
    expect(scanForLeakedLabels(BASE_CONTRACT)).toEqual([]);
  });
});

describe("materializeVariant", () => {
  it("materializes one variant and verifies it", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const result = materializeVariant(set, "verbose", pack);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { value } = result;
      expect(value.diff.verified).toBe(true);
      expect(value.effectiveText).toContain("Support");
      expect(value.effectiveText).toContain("The task list with every field.");
      expect(value.manifest.variant_id).toBe("verbose");
      expect(value.manifest.common_projection_sha256).toBe(
        patchTransformSha256(COMMON.patch)
      );
      expect(value.manifest.transform_sha256).toBe(
        transformSha256(value.variant)
      );
      expect(sha256Hex(value.effectiveText)).toBe(
        value.manifest.effective.openapi_sha256
      );
      expect(value.manifest.diff_path).toBe(
        "variants/verbose/contract-variant-diff.json"
      );
      expect(value.surfaces.map((surface) => surface.id)).toContain(
        "operation:path:GET /tasks"
      );
    }
  });

  it("rejects a variant the set does not declare", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    expect(failureCodes(materializeVariant(set, "missing", pack))).toEqual([
      GenerateCode.VariantUnknown
    ]);
  });

  it("rejects base bytes that no longer match the pinned digest", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed: ContractVariantSet = {
      ...set,
      base: { ...set.base, source: `${set.base.source}\n` }
    };
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.BaseBytesChanged
    ]);
  });

  it("rejects a declared effective digest that disagrees", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      effective_sha256: sha256Hex("other bytes")
    }));
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.EffectiveDigestMismatch
    ]);
  });

  it("rejects a patch outside its allowlist at materialization time", () => {
    // The loader is the first net. This set skipped validation, so
    // materialization must still refuse to apply an undeclared operation
    // instead of applying it silently.
    const set = loadSet({
      common: null,
      variants: [
        {
          id: "drifty",
          allowlist: [
            "/paths/~1tasks/get/responses/200",
            "/paths/~1tasks/get/summary"
          ],
          patch: [
            {
              op: "replace",
              path: "/paths/~1tasks/get/summary",
              value: "Everything about tasks"
            }
          ]
        }
      ]
    });
    const stripped = replaceVariant(set, "drifty", (variant) => ({
      ...variant,
      allowlist: ["/paths/~1tasks/get/responses/200"]
    }));
    const result = materializeVariant(stripped, "drifty", pack);
    expect(failureCodes(result)).toEqual([GenerateCode.PatchRejected]);
  });

  it("flags an undeclared change as drift", () => {
    // A static transform replaces the whole document, so the allowlist of a
    // loaded set normally covers the root. This set declares a narrow
    // allowlist, and the diff classifier must catch the extra change.
    const set = loadSet({ common: null, variants: [VERBOSE] });
    const staticDocument = mustApply(
      JSON.parse(BASE_CONTRACT) as Json,
      VERBOSE.patch
    );
    const drifted = mustApply(staticDocument, [
      { op: "replace", path: "/info/title", value: "Undeclared Title" }
    ]);
    const source = canonicalJson(drifted);
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      transform: {
        kind: "static",
        source,
        sha256: sha256Hex(source)
      },
      effective_sha256: sha256Hex(source)
    }));
    const result = materializeVariant(changed, "verbose", pack);
    expect(failureCodes(result)).toEqual([GenerateCode.DriftDetected]);
  });

  it("detects a factor label planted in a response description", () => {
    const set = loadSet({
      common: null,
      variants: [
        {
          id: "leaky",
          allowlist: ["/paths/~1tasks/get/responses/200"],
          patch: [
            {
              op: "replace",
              path: "/paths/~1tasks/get/responses/200/description",
              value: "The task list for factor B."
            }
          ]
        }
      ]
    });
    expect(failureCodes(materializeVariant(set, "leaky", pack))).toEqual([
      GenerateCode.LeakDetected
    ]);
  });

  it("detects an assignment label planted in an extension name", () => {
    const set = loadSet({
      common: null,
      variants: [
        {
          id: "leaky",
          allowlist: ["/paths/~1tasks/get/responses/429"],
          patch: [
            {
              op: "add",
              path: "/paths/~1tasks/get/responses/429",
              value: {
                description: "Rate limited.",
                "x-oal-assignment": "B"
              }
            }
          ]
        }
      ]
    });
    expect(failureCodes(materializeVariant(set, "leaky", pack))).toEqual([
      GenerateCode.LeakDetected
    ]);
  });

  it("rejects an adapter digest that disagrees with the pack", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      behavior_adapters: variant.behavior_adapters.map((adapter) => ({
        ...adapter,
        adapter_sha256: sha256Hex("other adapter")
      }))
    }));
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.AdapterDigestMismatch
    ]);
  });

  it("rejects an adapter the pack does not carry", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      behavior_adapters: variant.behavior_adapters.map((adapter) => ({
        ...adapter,
        adapter_id: "missing-adapter"
      }))
    }));
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.AdapterUnresolved
    ]);
  });

  it("rejects an adapter capability that disagrees with the contract", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const downgraded = {
      ...pack,
      adapters: pack.adapters.map((adapter) =>
        adapter.adapter_id === "tasks-read-adapter"
          ? { ...adapter, capability: "approximated" }
          : adapter
      )
    };
    expect(
      failureCodes(materializeVariant(set, "verbose", downgraded))
    ).toEqual([GenerateCode.AdapterCapabilityMismatch]);
  });

  it("rejects a semantic action the pack does not publish", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      semantic: {
        ...variant.semantic,
        action_ids: [...variant.semantic.action_ids, "tasks.unknown"]
      }
    }));
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.SemanticUnresolved
    ]);
  });

  it("rejects a documentation example the pack does not publish", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    const changed = replaceVariant(set, "verbose", (variant) => ({
      ...variant,
      documentation: {
        ...variant.documentation,
        examples: variant.documentation.examples.map((example) => ({
          ...example,
          sha256: sha256Hex("other example")
        }))
      }
    }));
    expect(failureCodes(materializeVariant(changed, "verbose", pack))).toEqual([
      GenerateCode.DocumentationUnresolved
    ]);
  });

  it("rejects an effective contract that does not compile", () => {
    const set = loadSet({
      base: BASE_CONTRACT.replace(
        "#/components/schemas/Task",
        "#/components/schemas/Missing"
      ),
      common: null,
      variants: [VERBOSE]
    });
    expect(failureCodes(materializeVariant(set, "verbose", pack))).toEqual([
      GenerateCode.CompileFailed
    ]);
  });

  it("reports unwaived compiler diagnostics and honors waivers", () => {
    const unsupportedMedia = BASE_CONTRACT.replace(
      '"application/json"',
      '"application/x-custom"'
    );
    const set = loadSet({
      base: unsupportedMedia,
      common: null,
      variants: [VERBOSE]
    });
    const downgraded = {
      ...pack,
      adapters: pack.adapters.map((adapter) =>
        adapter.adapter_id === "tasks-read-adapter"
          ? { ...adapter, capability: "unsupported" }
          : adapter
      )
    };
    expect(
      failureCodes(materializeVariant(set, "verbose", downgraded))
    ).toEqual([GenerateCode.UnwaivedDiagnostic]);
    const waived = materializeVariant(set, "verbose", downgraded, {
      waivedDiagnosticCodes: ["OAL-CAP-MEDIA-UNSUPPORTED"]
    });
    expect(waived.ok).toBe(true);
  });
});

describe("materializeContractVariantSet", () => {
  const TWO_VARIANTS = { common: COMMON, variants: [VERBOSE, TERSE] };

  it("materializes the same set bytes identically twice", () => {
    const text = canonicalJson(buildSet(TWO_VARIANTS));
    const first = materializeContractVariantSet(mustLoad(text), pack);
    const second = materializeContractVariantSet(mustLoad(text), pack);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.map((entry) => entry.effectiveText)).toEqual(
        second.value.map((entry) => entry.effectiveText)
      );
      expect(first.value.map((entry) => entry.manifest)).toEqual(
        second.value.map((entry) => entry.manifest)
      );
      expect(first.value.map((entry) => entry.diff)).toEqual(
        second.value.map((entry) => entry.diff)
      );
      const texts = first.value.map((entry) => entry.effectiveText);
      expect(texts[0]).not.toBe(texts[1]);
    }
  });

  it("flags a surface that varies without a declaration", () => {
    const set = loadSet({ ...TWO_VARIANTS, expectedVariable: [] });
    expect(failureCodes(materializeContractVariantSet(set, pack))).toEqual([
      GenerateCode.SurfaceDrift
    ]);
  });

  it("flags a surface declared constant that varies", () => {
    const set = loadSet({
      ...TWO_VARIANTS,
      expectedVariable: ["operation:path:GET /tasks"]
    });
    expect(failureCodes(materializeContractVariantSet(set, pack))).toEqual([
      GenerateCode.SurfaceDrift
    ]);
  });

  it("flags a declared surface absent from every variant", () => {
    const set = loadSet({ common: COMMON, variants: [VERBOSE] });
    expect(failureCodes(materializeContractVariantSet(set, pack))).toEqual([
      GenerateCode.SurfaceMissing
    ]);
  });

  it("flags documentation inventories that are not parallel", () => {
    const set = loadSet(TWO_VARIANTS);
    const widened = {
      ...pack,
      documentation: {
        ...pack.documentation,
        facts: [
          ...pack.documentation.facts,
          { id: "tasks.other", sha256: sha256Hex("tasks.other") }
        ]
      }
    };
    const changed = replaceVariant(set, "terse", (variant) => ({
      ...variant,
      documentation: {
        ...variant.documentation,
        fact_ids: ["tasks.other"],
        facts_sha256: documentationFactsSha256({
          ...variant.documentation,
          fact_ids: ["tasks.other"]
        })
      }
    }));
    expect(
      failureCodes(materializeContractVariantSet(changed, widened))
    ).toEqual([GenerateCode.DocumentationNotParallel]);
  });
});
