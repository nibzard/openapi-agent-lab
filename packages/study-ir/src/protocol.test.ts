import { describe, expect, it } from "vitest";

import { parseJsonStrict, type Json, type JsonObject } from "@oal/core";

import {
  canonicalNestedPatch,
  collectOperationReferences,
  deriveCellId,
  expandCellProduct,
  loadProtocol,
  resolveCellInventory,
  type DeclaredCell
} from "./protocol.ts";
import { baseProtocolDoc, loadSchema } from "./fixtures.ts";

const schema = loadSchema("study-protocol.v1.schema.json");

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

/** One present field of a fixture object. */
function fieldOf(record: Record<string, Json>, key: string): Json {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`Fixture field ${JSON.stringify(key)} is absent.`);
  }
  return value;
}

/** The mutable factor object at one index of the fixture document. */
function factorAt(doc: JsonObject, index: number): Record<string, unknown> {
  const factors = doc["factors"] as Record<string, unknown>[];
  const factor = factors[index];
  if (factor === undefined) {
    throw new Error(`Fixture has no factor at index ${index}.`);
  }
  return factor;
}

/** The mutable level object of one factor of the fixture document. */
function levelAt(
  doc: JsonObject,
  factorIndex: number,
  levelIndex: number
): Record<string, unknown> {
  const factor = factorAt(doc, factorIndex);
  const levels = factor["levels"] as Record<string, unknown>[];
  const level = levels[levelIndex];
  if (level === undefined) {
    throw new Error(`Fixture has no level at index ${levelIndex}.`);
  }
  return level;
}

function setPatch(
  doc: JsonObject,
  factorIndex: number,
  levelIndex: number,
  patch: Record<string, string>
): void {
  levelAt(doc, factorIndex, levelIndex)["run_profile_patch"] = patch;
}

describe("loadProtocol schema conformance", () => {
  it("loads a schema-valid document without diagnostics", () => {
    const result = loadProtocol(baseProtocolDoc(), { schema });
    expect(result.diagnostics).toEqual([]);
    expect(result.protocol?.metadata.id).toBe("prepared-workspace-api-v1");
    expect(result.protocol?.factors.length).toBe(2);
  });

  it("rejects a document that misses a required member", () => {
    const doc = baseProtocolDoc();
    delete doc["objective"];
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects an unknown top-level key", () => {
    const doc = { ...baseProtocolDoc(), secret_plan: true };
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects a malformed pack digest at the semantic layer", () => {
    const doc = baseProtocolDoc();
    const evaluation = doc["evaluation"] as { pack: { sha256: string } };
    evaluation.pack.sha256 = "not-a-digest";
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-STRUCTURE-INVALID"
    );
  });
});

describe("loadProtocol semantic rejections", () => {
  it("rejects a duplicate factor ID", () => {
    const doc = baseProtocolDoc();
    factorAt(doc, 1)["id"] = factorAt(doc, 0)["id"];
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-DUPLICATE-ID");
  });

  it("rejects a duplicate level ID inside one factor", () => {
    const doc = baseProtocolDoc();
    const levels = factorAt(doc, 0)["levels"] as { id: string }[];
    const first = levels[0];
    const second = levels[1];
    if (first === undefined || second === undefined) {
      throw new Error("Fixture factor has fewer than two levels.");
    }
    second.id = first.id;
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-DUPLICATE-ID");
  });

  it("rejects a metric ID declared twice", () => {
    const doc = baseProtocolDoc();
    const metrics = doc["metrics"] as {
      secondary: { id: string }[];
    };
    const secondary = metrics.secondary[0];
    if (secondary === undefined) {
      throw new Error("Fixture has no secondary metric.");
    }
    secondary.id = "clean_completion";
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-DUPLICATE-ID");
  });

  it("rejects a patch field outside the allowlist", () => {
    const doc = baseProtocolDoc();
    setPatch(doc, 1, 0, { "evaluation.model_judge": "enabled" });
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PATCH-FIELD-UNKNOWN"
    );
  });

  it("rejects a patch value the field does not accept", () => {
    const doc = baseProtocolDoc();
    setPatch(doc, 1, 0, { "exposure.contract_visibility": "telepathy" });
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PATCH-VALUE-INVALID"
    );
  });

  it("rejects two factors binding the same treatment field", () => {
    const doc = baseProtocolDoc();
    setPatch(doc, 0, 0, { "exposure.contract_visibility": "file" });
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PATCH-FIELD-BOUND-TWICE"
    );
  });

  it("rejects a contract variant the variant set does not declare", () => {
    const doc = baseProtocolDoc();
    const result = loadProtocol(doc, {
      schema,
      references: { contractVariants: new Set(["shape-a"]) }
    });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONTRACT-VARIANT-UNKNOWN"
    );
  });

  it("rejects a referenced contract operation missing from the contract", () => {
    const doc = baseProtocolDoc();
    setPatch(doc, 1, 1, {
      "exposure.documentation_profile": "path:DELETE /v1/gone"
    });
    const result = loadProtocol(doc, {
      schema,
      references: {
        contractOperations: new Set(["path:GET /v1/widgets"])
      }
    });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-OPERATION-UNKNOWN"
    );
  });

  it("accepts a referenced contract operation the contract declares", () => {
    const doc = baseProtocolDoc();
    setPatch(doc, 1, 1, {
      "exposure.documentation_profile": "path:GET /v1/widgets"
    });
    const result = loadProtocol(doc, {
      schema,
      references: {
        contractOperations: new Set(["path:GET /v1/widgets"])
      }
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.protocol).not.toBeNull();
  });

  it("rejects a level ID that makes the derived cell ID ambiguous", () => {
    const doc = baseProtocolDoc();
    levelAt(doc, 0, 0)["id"] = "shape__a";
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-CELL-ID-UNSAFE");
  });

  it("rejects a protocol member path that escapes the study root", () => {
    const doc = baseProtocolDoc();
    (doc["phases"] as { pilot: string }).pilot = "../outside/pilot.yaml";
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PHASE-PATH-UNSAFE"
    );
  });

  it("rejects a variant selection without a variant set declaration", () => {
    const doc = baseProtocolDoc();
    const evaluation = doc["evaluation"] as {
      contract_variant_set?: string;
    };
    delete evaluation.contract_variant_set;
    const result = loadProtocol(doc, { schema });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONTRACT-VARIANT-UNKNOWN"
    );
  });

  it("reports a missing and an orphan phase plan", () => {
    const plan = { metadata: { id: "smoke" } };
    const doc = baseProtocolDoc();
    const result = loadProtocol(doc, {
      schema,
      references: {
        phasePlans: new Map([
          ["smoke", plan as never],
          ["extra", plan as never]
        ])
      }
    });
    const codes = codesOf(result.diagnostics);
    expect(codes).toContain("OAL-STUDY-PHASE-PLAN-MISSING");
    expect(codes).toContain("OAL-STUDY-PHASE-PLAN-ORPHAN");
  });

  it("rejects a phase plan whose ID differs from the phase key", () => {
    const doc = baseProtocolDoc();
    const result = loadProtocol(doc, {
      schema,
      references: {
        phasePlans: new Map([
          ["smoke", { metadata: { id: "wrong" } } as never],
          ["pilot", { metadata: { id: "pilot" } } as never]
        ])
      }
    });
    expect(result.protocol).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PHASE-PLAN-ID-MISMATCH"
    );
  });
});

describe("patch helpers", () => {
  it("joins dotted keys into one canonical nested object", () => {
    expect(
      canonicalNestedPatch({
        "exposure.contract_visibility": "file",
        "exposure.documentation_profile": "profile-a",
        "agent.model": "model-x"
      })
    ).toEqual({
      exposure: {
        contract_visibility: "file",
        documentation_profile: "profile-a"
      },
      agent: { model: "model-x" }
    });
  });

  it("reports ambiguous key nesting as null", () => {
    expect(
      canonicalNestedPatch({
        exposure: "file",
        "exposure.mode": "raw-http"
      })
    ).toBeNull();
  });

  it("collects canonical operation references from any depth", () => {
    const value = parseJsonStrict(
      '{"a":"path:POST /v1/widgets","b":["path:GET /v1/items"],"c":"plain"}'
    );
    expect(collectOperationReferences(value)).toEqual([
      "path:POST /v1/widgets",
      "path:GET /v1/items"
    ]);
  });
});

describe("cell inventory", () => {
  const loaded = loadProtocol(baseProtocolDoc(), { schema });
  const protocolOfCellInventory = loaded.protocol;
  if (protocolOfCellInventory === null) {
    throw new Error("Fixture protocol must load.");
  }
  const factors = protocolOfCellInventory.factors;

  it("expands the complete product in canonical order", () => {
    const product = expandCellProduct(factors);
    expect(product.map((entry) => deriveCellId(factors, entry))).toEqual([
      "shape_a__blind",
      "shape_a__discoverable",
      "shape_a__supplied",
      "shape_b__blind",
      "shape_b__discoverable",
      "shape_b__supplied"
    ]);
  });

  it("resolves the default complete inventory", () => {
    const inventory = resolveCellInventory(factors);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.cells.length).toBe(6);
    expect(inventory.cells.every((cell) => cell.explicit)).toBe(false);
    expect(inventory.cells.every((cell) => cell.why_absent === null)).toBe(
      true
    );
  });

  it("accepts an explicit subset with stated absence reasons", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_a", documentation: "blind" } },
      { factor_levels: { api_shape: "shape_b", documentation: "blind" } }
    ];
    const reasons = new Map<string, string>([
      ["shape_a__discoverable", "Pilot scope excludes this arm."],
      ["shape_a__supplied", "Pilot scope excludes this arm."],
      ["shape_b__discoverable", "Pilot scope excludes this arm."],
      ["shape_b__supplied", "Pilot scope excludes this arm."]
    ]);
    const inventory = resolveCellInventory(factors, declared, reasons);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.cells.length).toBe(6);
    const absent = inventory.cells.filter((cell) => cell.why_absent !== null);
    expect(absent.length).toBe(4);
    expect(absent.every((cell) => !cell.explicit)).toBe(true);
  });

  it("rejects an absent combination without a stated reason", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_a", documentation: "blind" } }
    ];
    const inventory = resolveCellInventory(factors, declared, new Map());
    expect(
      inventory.diagnostics.some(
        (entry) => entry.code === "OAL-STUDY-CELL-ABSENT-UNEXPLAINED"
      )
    ).toBe(true);
  });

  it("rejects a declared map that omits a factor", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_a" } }
    ];
    const inventory = resolveCellInventory(factors, declared, new Map());
    expect(
      inventory.diagnostics.some(
        (entry) => entry.code === "OAL-STUDY-CELL-FACTOR-UNKNOWN"
      )
    ).toBe(true);
  });

  it("rejects an unknown level in a declared map", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_z", documentation: "blind" } }
    ];
    const inventory = resolveCellInventory(factors, declared, new Map());
    expect(
      inventory.diagnostics.some(
        (entry) => entry.code === "OAL-STUDY-CELL-LEVEL-UNKNOWN"
      )
    ).toBe(true);
  });

  it("rejects a duplicate declared map", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_a", documentation: "blind" } },
      { factor_levels: { documentation: "blind", api_shape: "shape_a" } }
    ];
    const inventory = resolveCellInventory(factors, declared, new Map());
    expect(
      inventory.diagnostics.some(
        (entry) => entry.code === "OAL-STUDY-CELL-DUPLICATE"
      )
    ).toBe(true);
  });

  it("rejects a claimed complete factorial with the wrong count", () => {
    const declared: DeclaredCell[] = [
      { factor_levels: { api_shape: "shape_a", documentation: "blind" } }
    ];
    const inventory = resolveCellInventory(factors, declared);
    expect(
      inventory.diagnostics.some(
        (entry) => entry.code === "OAL-STUDY-CELL-INVENTORY-INCOMPLETE"
      )
    ).toBe(true);
  });

  it("derives the cell ID from level IDs in canonical factor order", () => {
    expect(
      deriveCellId(factors, { documentation: "blind", api_shape: "shape_b" })
    ).toBe("shape_b__blind");
  });
});

describe("protocol document rebuild", () => {
  it("rebuilds an equal typed model from a reordered document", () => {
    const first = loadProtocol(baseProtocolDoc(), { schema }).protocol;
    const reordered = baseProtocolDoc();
    const evaluation = reordered["evaluation"] as Record<string, Json>;
    reordered["evaluation"] = {
      scenario: fieldOf(evaluation, "scenario"),
      contract_variant_set: fieldOf(evaluation, "contract_variant_set"),
      eval: fieldOf(evaluation, "eval"),
      pack: fieldOf(evaluation, "pack")
    };
    const second = loadProtocol(reordered, { schema }).protocol;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("keeps the authored factor order in the typed model", () => {
    const protocol = loadProtocol(baseProtocolDoc(), { schema }).protocol;
    expect(protocol?.factors.map((factor) => factor.id)).toEqual([
      "api_shape",
      "documentation"
    ]);
  });
});
