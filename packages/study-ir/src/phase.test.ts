import { describe, expect, it } from "vitest";

import type { JsonObject } from "@oal/core";

import { loadPhasePlan } from "./phase.ts";
import { loadProtocol } from "./protocol.ts";
import { basePhasePlanDoc, baseProtocolDoc, loadSchema } from "./fixtures.ts";

const schema = loadSchema("phase-plan.v1.schema.json");
const protocolSchema = loadSchema("study-protocol.v1.schema.json");

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

function loadedProtocol(): ReturnType<typeof loadProtocol>["protocol"] {
  return loadProtocol(baseProtocolDoc(), { schema: protocolSchema }).protocol;
}

/** Mutate one contrast field of the fixture plan. */
function withContrast(
  mutate: (contrast: Record<string, unknown>) => void
): JsonObject {
  const doc = basePhasePlanDoc();
  const analysis = doc["analysis"] as Record<string, unknown>;
  const contrasts = analysis["contrasts"] as Record<string, unknown>[];
  const contrast = contrasts[0];
  if (contrast === undefined) {
    throw new Error("Fixture plan has no contrast.");
  }
  mutate(contrast);
  return doc;
}

describe("loadPhasePlan schema conformance", () => {
  it("loads a schema-valid plan without diagnostics", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const result = loadPhasePlan(basePhasePlanDoc(), {
      schema,
      protocol,
      cellCount: 6
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.phasePlan?.metadata.id).toBe("pilot");
    expect(result.phasePlan?.design.block?.repetitions).toBe(2);
  });

  it("rejects a plan that misses a required member", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    delete doc["paid_calls"];
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects a non-balanced primary count against the cell inventory", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const design = doc["design"] as Record<string, unknown>;
    design["primary_assignments"] = 10;
    delete design["block"];
    const paid = doc["paid_calls"] as Record<string, number>;
    paid["primary"] = 10;
    const result = loadPhasePlan(doc, { schema, protocol, cellCount: 4 });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-DESIGN-UNBALANCED"
    );
  });

  it("rejects a block structure that needs a different primary count", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const design = doc["design"] as Record<string, unknown>;
    design["primary_assignments"] = 13;
    const paid = doc["paid_calls"] as Record<string, number>;
    paid["primary"] = 13;
    const result = loadPhasePlan(doc, { schema, protocol, cellCount: 6 });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-DESIGN-UNBALANCED"
    );
  });

  it("rejects paid calls that disagree with the design", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const paid = doc["paid_calls"] as Record<string, number>;
    paid["primary"] = 11;
    const result = loadPhasePlan(doc, { schema, protocol, cellCount: 6 });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-PAID-CALLS-INCONSISTENT"
    );
  });
});

describe("loadPhasePlan analysis references", () => {
  it("rejects a contrast over an unknown metric", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = withContrast((contrast) => {
      contrast["metric"] = "not_a_metric";
    });
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-METRIC-UNKNOWN");
  });

  it("rejects a contrast over an unknown factor", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = withContrast((contrast) => {
      contrast["factor"] = "not_a_factor";
    });
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONTRAST-FACTOR-UNKNOWN"
    );
  });

  it("rejects a contrast over an unknown level", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = withContrast((contrast) => {
      contrast["levels"] = ["shape_a", "shape_z"];
    });
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONTRAST-LEVEL-UNKNOWN"
    );
  });

  it("rejects a stratum that names an unknown level", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = withContrast((contrast) => {
      contrast["within"] = { documentation: "telepathic" };
    });
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-STRATUM-UNKNOWN");
  });

  it("rejects an estimand over an unknown contrast", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const analysis = doc["analysis"] as Record<string, unknown>;
    const estimand = analysis["primary_estimand"] as Record<string, unknown>;
    estimand["contrast"] = "not_a_contrast";
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-CONTRAST-UNKNOWN");
  });

  it("rejects a comparison family over an unknown contrast", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const analysis = doc["analysis"] as Record<string, unknown>;
    const families = analysis["comparison_families"] as Record<
      string,
      unknown
    >[];
    const family = families[0];
    if (family === undefined) {
      throw new Error("Fixture plan has no comparison family.");
    }
    family["contrasts"] = ["not_a_contrast"];
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-CONTRAST-UNKNOWN");
  });

  it("rejects a risk measure over a non-binary outcome", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const analysis = doc["analysis"] as Record<string, unknown>;
    const contrasts = analysis["contrasts"] as Record<string, unknown>[];
    const contrast = contrasts[0];
    if (contrast === undefined) {
      throw new Error("Fixture plan has no contrast.");
    }
    contrast["metric"] = "request_count";
    const estimand = analysis["primary_estimand"] as Record<string, unknown>;
    estimand["outcome"] = "request_count";
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-MEASURE-INCOMPATIBLE"
    );
  });

  it("rejects a floor and ceiling rule over an unknown factor", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    const analysis = doc["analysis"] as Record<string, unknown>;
    const floor = analysis["floor_ceiling"] as Record<string, unknown>;
    floor["apply_by_factor_level"] = "not_a_factor";
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-FACTOR-UNKNOWN");
  });

  it("rejects a contrast over a nonvarying factor", () => {
    const protocolDoc = baseProtocolDoc();
    const factors = protocolDoc["factors"] as Record<string, unknown>[];
    const documentation = factors[1];
    if (documentation === undefined) {
      throw new Error("Fixture protocol has no second factor.");
    }
    documentation["levels"] = [
      (documentation["levels"] as Record<string, unknown>[])[0]
    ];
    const protocol = loadProtocol(protocolDoc, {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Modified fixture protocol must load.");
    }
    const doc = withContrast((contrast) => {
      contrast["factor"] = "documentation";
      contrast["levels"] = ["blind", "blind"];
      contrast["within"] = { api_shape: "shape_a" };
    });
    const result = loadPhasePlan(doc, { schema, protocol });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONTRAST-NONVARYING"
    );
  });

  it("rejects a rubric check the rubric does not declare", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const result = loadPhasePlan(basePhasePlanDoc(), {
      schema,
      protocol,
      knownChecks: new Set(["other_check"])
    });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-METRIC-SOURCE-UNKNOWN"
    );
  });

  it("rejects a confirmatory phase without a multiplicity policy", () => {
    const protocol = loadedProtocol();
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const doc = basePhasePlanDoc();
    doc["purpose"] = "confirmatory";
    const analysis = doc["analysis"] as Record<string, unknown>;
    const families = analysis["comparison_families"] as Record<
      string,
      unknown
    >[];
    const family = families[0];
    if (family === undefined) {
      throw new Error("Fixture plan has no comparison family.");
    }
    family["multiplicity"] = "none";
    analysis["small_sample_label"] = "confirmatory";
    const result = loadPhasePlan(doc, { schema, protocol, cellCount: 6 });
    expect(result.phasePlan).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-CONFIRMATORY-INCOMPLETE"
    );
  });
});
