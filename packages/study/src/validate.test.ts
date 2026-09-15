import { describe, expect, it } from "vitest";

import {
  compileStudy,
  createProtocolLock,
  loadBlindingReview,
  loadEquivalenceReview,
  loadPhasePlan,
  loadProtocol,
  StudyCode,
  verifyProtocolLock,
  type PhasePlan,
  type ProtocolLock,
  type ProtocolLockVerifyResult,
  type StudyIR,
  type StudyProtocol
} from "@oal/study-ir";
import { sha256Hex, type Json, type JsonObject } from "@oal/core";

import {
  preflightAnalyticalRun,
  resolvedCellCount,
  ReviewCode,
  reviewStudyDesign,
  type StudyFinding,
  type StudyReviewInput
} from "./validate.ts";
import {
  baseBlindingReviewDoc,
  baseEquivalenceReviewDoc,
  baseMembers,
  basePhasePlanDoc,
  baseProtocolDoc,
  loadSchema,
  smokePhasePlanDoc
} from "./fixtures.ts";

const protocolSchema = loadSchema("study-protocol.v1.schema.json");
const phaseSchema = loadSchema("phase-plan.v1.schema.json");
const irSchema = loadSchema("study-ir.v1.schema.json");
const lockSchema = loadSchema("protocol-lock.v1.schema.json");
const blindingSchema = loadSchema("blinding-review.v1.schema.json");
const equivalenceSchema = loadSchema("equivalence-review.v1.schema.json");

function codesOf(findings: readonly { code: string }[]): string[] {
  return findings.map((entry) => entry.code);
}

function errorsOf(findings: readonly StudyFinding[]): string[] {
  return codesOf(findings.filter((entry) => entry.severity === "error"));
}

async function protocolOf(
  doc: JsonObject = baseProtocolDoc()
): Promise<StudyProtocol> {
  const loaded = (await loadProtocol(doc, { schema: protocolSchema })).protocol;
  if (loaded === null) {
    throw new Error("Fixture protocol must load.");
  }
  return loaded;
}

async function irOf(protocol: StudyProtocol): Promise<StudyIR> {
  const compiled = (
    await compileStudy(protocol, {
      schema: irSchema,
      members: baseMembers()
    })
  ).ir;
  if (compiled === null) {
    throw new Error("Fixture protocol must compile.");
  }
  return compiled;
}

async function planOf(doc: JsonObject): Promise<PhasePlan> {
  const loaded = (
    await loadPhasePlan(doc, {
      schema: phaseSchema,
      protocol: await protocolOf()
    })
  ).phasePlan;
  if (loaded === null) {
    throw new Error("Fixture phase plan must load.");
  }
  return loaded;
}

async function lockOf(protocol: StudyProtocol): Promise<ProtocolLock> {
  const created = (
    await createProtocolLock(
      protocol,
      [...baseMembers()].map(([path, text]) => ({ path, text })),
      [
        { variant: "shape-a", sha256: sha256Hex("shape a") },
        { variant: "shape-b", sha256: sha256Hex("shape b") }
      ],
      { schema: lockSchema }
    )
  ).lock;
  if (created === null) {
    throw new Error("Fixture lock must be created.");
  }
  return created;
}

async function basePhases(): Promise<Map<string, PhasePlan>> {
  return new Map<string, PhasePlan>([
    ["smoke", await planOf(smokePhasePlanDoc())],
    ["pilot", await planOf(basePhasePlanDoc())]
  ]);
}

/** A complete, coherent review input: protocol, IR, plans, lock, reviews. */
async function baseInput(): Promise<StudyReviewInput> {
  const protocol = await protocolOf();
  return {
    protocol,
    ir: await irOf(protocol),
    phases: await basePhases(),
    lock: await lockOf(protocol),
    blindingReview:
      (
        await loadBlindingReview(baseBlindingReviewDoc(), {
          schema: blindingSchema
        })
      ).review ?? undefined,
    equivalenceReview:
      (
        await loadEquivalenceReview(baseEquivalenceReviewDoc(), {
          schema: equivalenceSchema
        })
      ).review ?? undefined
  };
}

/** The protocol without one optional field, for negative review cases. */
async function protocolWithout(
  field: "contract_variant_set" | "participant_surface_policy"
): Promise<StudyProtocol> {
  const protocol = await protocolOf();
  if (field === "contract_variant_set") {
    return {
      ...protocol,
      evaluation: { ...protocol.evaluation, contract_variant_set: undefined }
    };
  }
  return {
    ...protocol,
    blinding: {
      ...protocol.blinding,
      participant_surface_policy: undefined
    }
  };
}

describe("reviewStudyDesign", () => {
  it("raises no error for a coherent design", async () => {
    const findings = reviewStudyDesign(await baseInput());
    expect(errorsOf(findings)).toEqual([]);
  });

  it("resolves the cell count from the compiled IR", async () => {
    expect(resolvedCellCount(await baseInput())).toBe(6);
  });

  it("rejects a primary count that does not balance across cells", async () => {
    const doc = basePhasePlanDoc();
    const design = doc["design"] as Record<string, unknown>;
    design["primary_assignments"] = 10;
    delete design["block"];
    const paid = doc["paid_calls"] as Record<string, number>;
    paid["primary"] = 10;
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      phases: new Map(await basePhases()).set("pilot", await planOf(doc))
    });
    expect(errorsOf(findings)).toContain(StudyCode.DesignUnbalanced);
  });

  it("rejects a block that needs a different primary count", async () => {
    const doc = basePhasePlanDoc();
    const design = doc["design"] as Record<string, unknown>;
    (design["block"] as Record<string, unknown>)["repetitions"] = 3;
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      phases: new Map(await basePhases()).set("pilot", await planOf(doc))
    });
    expect(errorsOf(findings)).toContain(StudyCode.DesignUnbalanced);
  });

  it("rejects mixed counterfactual arms inside one factor", async () => {
    const doc = baseProtocolDoc();
    const factors = doc["factors"] as {
      levels: Record<string, unknown>[];
    }[];
    const shapeB = factors[0]?.levels[1];
    if (shapeB === undefined) {
      throw new Error("Fixture protocol has no second api_shape level.");
    }
    delete shapeB["contract_variant"];
    const findings = reviewStudyDesign({ protocol: await protocolOf(doc) });
    expect(errorsOf(findings)).toContain(ReviewCode.CounterfactualArmMixed);
  });

  it("rejects variant use without a declared variant set", async () => {
    const findings = reviewStudyDesign({
      protocol: await protocolWithout("contract_variant_set")
    });
    expect(errorsOf(findings)).toContain(ReviewCode.VariantsWithoutSet);
  });

  it("requires an approved equivalence review for analytical variants", async () => {
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      equivalenceReview: undefined
    });
    expect(errorsOf(findings)).toContain(ReviewCode.EquivalenceReviewMissing);
  });

  it("requires the review to cover every effective contract digest", async () => {
    const doc = baseEquivalenceReviewDoc();
    doc["reviewed"] = [
      { artifact: "effective/shape-a", sha256: sha256Hex("shape a") }
    ];
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      equivalenceReview:
        (await loadEquivalenceReview(doc, { schema: equivalenceSchema }))
          .review ?? undefined
    });
    expect(errorsOf(findings)).toContain(
      ReviewCode.EquivalenceReviewIncomplete
    );
  });

  it("rejects an unapproved equivalence review", async () => {
    const doc = baseEquivalenceReviewDoc();
    doc["approved"] = false;
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      equivalenceReview:
        (await loadEquivalenceReview(doc, { schema: equivalenceSchema }))
          .review ?? undefined
    });
    expect(errorsOf(findings)).toContain(
      ReviewCode.EquivalenceReviewIncomplete
    );
  });

  it("requires a surface policy under strict blinding", async () => {
    const findings = reviewStudyDesign({
      protocol: await protocolWithout("participant_surface_policy"),
      blindingReview:
        (
          await loadBlindingReview(baseBlindingReviewDoc(), {
            schema: blindingSchema
          })
        ).review ?? undefined
    });
    expect(errorsOf(findings)).toContain(ReviewCode.BlindingPolicyMissing);
  });

  it("requires the pairwise surface diff review the protocol demands", async () => {
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      blindingReview: undefined
    });
    expect(errorsOf(findings)).toContain(ReviewCode.BlindingReviewIncomplete);
  });

  it("requires the review to cover every resolved cell", async () => {
    const doc = baseBlindingReviewDoc();
    const surfaces = doc["reviewed_surfaces"] as Json[];
    doc["reviewed_surfaces"] = surfaces.slice(1);
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      blindingReview:
        (await loadBlindingReview(doc, { schema: blindingSchema })).review ??
        undefined
    });
    expect(errorsOf(findings)).toContain(ReviewCode.BlindingReviewIncomplete);
  });

  it("rejects a surface review over an unresolved cell", async () => {
    const doc = baseBlindingReviewDoc();
    const surfaces = doc["reviewed_surfaces"] as { cell_id: string }[];
    const first = surfaces[0];
    if (first === undefined) {
      throw new Error("Fixture review has no surface.");
    }
    first.cell_id = "shape_z__blind";
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      blindingReview:
        (await loadBlindingReview(doc, { schema: blindingSchema })).review ??
        undefined
    });
    expect(errorsOf(findings)).toContain(ReviewCode.BlindingReviewCellUnknown);
  });

  it("rejects a treatment factor that does not vary", async () => {
    const doc = baseProtocolDoc();
    const factors = doc["factors"] as { levels: unknown[] }[];
    const documentation = factors[1];
    const only = documentation?.levels[0];
    if (documentation === undefined || only === undefined) {
      throw new Error("Fixture protocol has no documentation levels.");
    }
    documentation.levels = [only];
    const findings = reviewStudyDesign({ protocol: await protocolOf(doc) });
    expect(errorsOf(findings)).toContain(ReviewCode.FactorNonvarying);
  });

  it("reports a missing phase plan", async () => {
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      phases: new Map([["pilot", await planOf(basePhasePlanDoc())]])
    });
    expect(errorsOf(findings)).toContain(StudyCode.PhasePlanMissing);
  });

  it("reports a phase plan the protocol does not declare", async () => {
    const findings = reviewStudyDesign({
      ...(await baseInput()),
      phases: new Map([
        ...(await basePhases()),
        ["extra", await planOf(basePhasePlanDoc())]
      ])
    });
    expect(errorsOf(findings)).toContain(ReviewCode.PhaseUndeclared);
  });
});

describe("preflightAnalyticalRun", () => {
  it("refuses an analytical phase without a lock", async () => {
    const decision = preflightAnalyticalRun({
      protocol: await protocolOf(),
      phasePlan: await planOf(basePhasePlanDoc())
    });
    expect(decision.allowed).toBe(false);
    expect(codesOf(decision.findings)).toContain(ReviewCode.LockMissing);
  });

  it("allows a smoke phase without a lock and warns", async () => {
    const decision = preflightAnalyticalRun({
      protocol: await protocolOf(),
      phasePlan: await planOf(smokePhasePlanDoc())
    });
    expect(decision.allowed).toBe(true);
    expect(codesOf(decision.findings)).toContain(ReviewCode.LockMissing);
    expect(decision.findings[0]?.severity).toBe("warning");
  });

  it("allows an analytical phase under a verified lock", async () => {
    const protocol = await protocolOf();
    const lock = await lockOf(protocol);
    const verification = await verifyProtocolLock(lock, {
      members: [...baseMembers()].map(([path, text]) => ({ path, text }))
    });
    expect(verification.ok).toBe(true);
    const decision = preflightAnalyticalRun({
      protocol,
      phasePlan: await planOf(basePhasePlanDoc()),
      lock,
      lockVerification: verification
    });
    expect(decision.allowed).toBe(true);
    expect(decision.findings).toEqual([]);
  });

  it("refuses an analytical phase under a drifted lock", async () => {
    const protocol = await protocolOf();
    const lock = await lockOf(protocol);
    const drifted: ProtocolLockVerifyResult = {
      ok: false,
      lockSha256: sha256Hex("verification"),
      drift: [
        {
          kind: "digest",
          path: "phases/pilot.yaml",
          detail: "Locked member bytes changed.",
          recorded: sha256Hex("old"),
          actual: sha256Hex("new")
        }
      ],
      diagnostics: []
    };
    const decision = preflightAnalyticalRun({
      protocol,
      phasePlan: await planOf(basePhasePlanDoc()),
      lock,
      lockVerification: drifted
    });
    expect(decision.allowed).toBe(false);
    expect(codesOf(decision.findings)).toContain(ReviewCode.LockDrifted);
  });

  it("refuses a lock that names a different protocol version", async () => {
    const doc = baseProtocolDoc();
    const metadata = doc["metadata"] as { version: string };
    metadata.version = "2.0.0";
    const decision = preflightAnalyticalRun({
      protocol: await protocolOf(doc),
      phasePlan: await planOf(basePhasePlanDoc()),
      lock: await lockOf(await protocolOf())
    });
    expect(decision.allowed).toBe(false);
    expect(codesOf(decision.findings)).toContain(
      ReviewCode.LockIdentityMismatch
    );
  });
});
