import { describe, expect, it } from "vitest";
import {
  createProtocolLock,
  loadPhasePlan,
  loadProtocol,
  verifyProtocolLock,
  type PhasePlan,
  type ProtocolLock,
  type StudyProtocol
} from "@oal/study-ir";
import { sha256Hex, type JsonObject } from "@oal/core";

import {
  checkAnalysisSupport,
  protocolCellViews,
  SupportCode
} from "./support.ts";
import {
  preflightAnalyticalRun,
  reviewStudyDesign,
  type StudyFinding
} from "./validate.ts";
import { planStudyRun } from "./run.ts";
import {
  TWO_CELL_ANALYSIS_PLAN,
  TWO_CELL_CELLS,
  TWO_CELL_CREATED_AT,
  TWO_CELL_IMPLEMENTATION,
  TWO_CELL_PHASE_LOCK,
  TWO_CELL_PHASE_PLAN_SHA256,
  TWO_CELL_PROTOCOL_LOCK,
  TWO_CELL_RUN_ID,
  TWO_CELL_STUDY_COMPATIBILITY,
  basePhasePlanDoc,
  baseProtocolDoc,
  loadSchema,
  twoCellMembers,
  twoCellPhasePlanDoc,
  twoCellProtocolDoc,
  twoCellStudy
} from "./fixtures.ts";

const protocolSchema = loadSchema("study-protocol.v1.schema.json");
const phaseSchema = loadSchema("phase-plan.v1.schema.json");
const lockSchema = loadSchema("protocol-lock.v1.schema.json");

function codesOf(findings: readonly StudyFinding[]): string[] {
  return findings.map((entry) => entry.code);
}

function twoCellProtocol(): StudyProtocol {
  const loaded = loadProtocol(twoCellProtocolDoc(), {
    schema: protocolSchema
  }).protocol;
  if (loaded === null) {
    throw new Error("Two-cell fixture protocol must load.");
  }
  return loaded;
}

/**
 * Load a two-cell phase plan after applying one document mutation, and
 * optionally one mutation to the protocol document. A mutation that the
 * loader rejects throws, which fails the test as a broken fixture.
 */
function twoCellPlan(
  mutate: (document: JsonObject) => void,
  mutateProtocol?: (document: JsonObject) => void
): PhasePlan {
  const document = twoCellPhasePlanDoc();
  mutate(document);
  const protocolDocument = twoCellProtocolDoc();
  if (mutateProtocol !== undefined) {
    mutateProtocol(protocolDocument);
  }
  const loaded = loadPhasePlan(document, {
    schema: phaseSchema,
    protocol: twoCellProtocolOf(protocolDocument),
    cellCount: 2
  }).phasePlan;
  if (loaded === null) {
    throw new Error("Mutated fixture plan must load.");
  }
  return loaded;
}

function twoCellProtocolOf(document: JsonObject): StudyProtocol {
  const loaded = loadProtocol(document, { schema: protocolSchema }).protocol;
  if (loaded === null) {
    throw new Error("Mutated fixture protocol must load.");
  }
  return loaded;
}

function baseProtocol(): StudyProtocol {
  const loaded = loadProtocol(baseProtocolDoc(), {
    schema: protocolSchema
  }).protocol;
  if (loaded === null) {
    throw new Error("Base fixture protocol must load.");
  }
  return loaded;
}

/** Six-cell plan of the base protocol, with or without strata. */
function basePlan(within: boolean): PhasePlan {
  const document = basePhasePlanDoc();
  const contrasts = (
    (document["analysis"] as JsonObject)["contrasts"] as JsonObject[]
  )[0] as JsonObject;
  if (!within) {
    delete contrasts["within"];
  }
  const loaded = loadPhasePlan(document, {
    schema: phaseSchema,
    protocol: baseProtocol(),
    cellCount: 6
  }).phasePlan;
  if (loaded === null) {
    throw new Error("Base fixture plan must load.");
  }
  return loaded;
}

/** The two cells of the two-cell design. */
const TWO_CELLS = [
  { cell_id: "shape_a", factor_levels: { api_shape: "shape_a" } },
  { cell_id: "shape_b", factor_levels: { api_shape: "shape_b" } }
] as const;

describe("analysis support check", () => {
  it("accepts the implemented binary risk difference plan", () => {
    expect(
      checkAnalysisSupport({
        phasePlan: twoCellPlan(() => {}),
        cells: TWO_CELLS
      })
    ).toEqual([]);
  });

  it("rejects a risk ratio measure without substituting a difference", () => {
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const estimand = (document["analysis"] as JsonObject)[
          "primary_estimand"
        ] as JsonObject;
        estimand["measure"] = "risk_ratio";
      })
    });
    expect(codesOf(findings)).toEqual([SupportCode.MeasureUnsupported]);
    expect(findings[0]?.message).toContain("risk_ratio");
    expect(findings[0]?.severity).toBe("error");
  });

  it("rejects a generic difference measure", () => {
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const estimand = (document["analysis"] as JsonObject)[
          "primary_estimand"
        ] as JsonObject;
        estimand["measure"] = "difference";
      })
    });
    expect(codesOf(findings)).toEqual([SupportCode.MeasureUnsupported]);
  });

  it("rejects wald intervals before any estimate is computed", () => {
    const binary = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const methods = (document["analysis"] as JsonObject)[
          "methods"
        ] as JsonObject;
        methods["binary_interval"] = "wald";
      })
    });
    expect(codesOf(binary)).toEqual([SupportCode.MethodUnsupported]);
    expect(binary[0]?.message).toContain("binary_interval");

    const risk = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const methods = (document["analysis"] as JsonObject)[
          "methods"
        ] as JsonObject;
        methods["risk_difference_interval"] = "wald";
      })
    });
    expect(codesOf(risk)).toEqual([SupportCode.MethodUnsupported]);
    expect(risk[0]?.message).toContain("risk_difference_interval");
  });

  it("rejects marginal weighting beyond none", () => {
    for (const value of ["equal_cells", "equal_assignments"]) {
      const findings = checkAnalysisSupport({
        phasePlan: twoCellPlan((document) => {
          (document["analysis"] as JsonObject)["marginal_weighting"] = value;
        })
      });
      expect(codesOf(findings)).toEqual([SupportCode.WeightingUnsupported]);
      expect(findings[0]?.message).toContain(value);
    }
  });

  it("rejects a declared floor-ceiling factor", () => {
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        ((document["analysis"] as JsonObject)["floor_ceiling"] as JsonObject)[
          "apply_by_factor_level"
        ] = "api_shape";
      })
    });
    expect(codesOf(findings)).toEqual([SupportCode.FloorCeilingUnsupported]);
    expect(findings[0]?.message).toContain("api_shape");
  });

  it("rejects populations the analyzer does not compose", () => {
    // The loader resolves an estimand population when the referenced
    // contrast declares the same one, so both fields must move together
    // for the archived vocabulary to parse; execution still refuses it.
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const analysis = document["analysis"] as JsonObject;
        const estimand = analysis["primary_estimand"] as JsonObject;
        estimand["population"] = "per_protocol";
        const contrasts = analysis["contrasts"] as JsonObject[];
        (contrasts[0] as JsonObject)["population"] = "per_protocol";
      })
    });
    expect(codesOf(findings)).toEqual([
      SupportCode.PopulationUnsupported,
      SupportCode.PopulationUnsupported
    ]);
    expect(findings[0]?.message).toContain("per_protocol");
  });

  it("rejects a primary outcome that mismatches its contrast metric", () => {
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan(
        (document) => {
          const estimand = (document["analysis"] as JsonObject)[
            "primary_estimand"
          ] as JsonObject;
          estimand["outcome"] = "spare_binary";
        },
        (protocolDocument) => {
          const metrics = protocolDocument["metrics"] as JsonObject;
          metrics["secondary"] = [
            {
              id: "spare_binary",
              type: "binary",
              source: { kind: "rubric_check", check_id: "spare_binary" }
            }
          ];
        }
      )
    });
    expect(codesOf(findings)).toEqual([SupportCode.OutcomeInconsistent]);
    expect(findings[0]?.message).toContain("spare_binary");
  });

  it("rejects a contrast that belongs to two comparison families", () => {
    // A duplicate inside one family cannot load: the schema pins
    // uniqueItems. Two families sharing one contrast do load, and
    // execution refuses the undefined double adjustment.
    const findings = checkAnalysisSupport({
      phasePlan: twoCellPlan((document) => {
        const analysis = document["analysis"] as JsonObject;
        const families = analysis["comparison_families"] as JsonObject[];
        families.push({
          id: "secondary",
          contrasts: ["shape_a_minus_shape_b"],
          alpha: 0.01,
          multiplicity: "none"
        });
      })
    });
    expect(codesOf(findings)).toEqual([SupportCode.FamilyOverlapping]);
  });

  it("rejects a contrast side that matches several cells", () => {
    // The base design crosses api_shape with documentation, so a
    // contrast without strata matches three cells per side.
    const cells = protocolCellViews(baseProtocol());
    expect(cells).toHaveLength(6);
    const findings = checkAnalysisSupport({
      phasePlan: basePlan(false),
      cells
    });
    expect(codesOf(findings)).toEqual([
      SupportCode.ContrastAmbiguous,
      SupportCode.ContrastAmbiguous
    ]);
    expect(findings[0]?.message).toContain("3 cells");
  });

  it("accepts a fully pinned contrast over the same cells", () => {
    expect(
      checkAnalysisSupport({
        phasePlan: basePlan(true),
        cells: protocolCellViews(baseProtocol())
      })
    ).toEqual([]);
  });

  it("skips the side check when no cell inventory is supplied", () => {
    expect(checkAnalysisSupport({ phasePlan: basePlan(false) })).toEqual([]);
  });
});

describe("analysis support in design review", () => {
  it("fails review of a phase plan that requests a risk ratio", () => {
    const findings = reviewStudyDesign({
      protocol: twoCellProtocol(),
      phases: new Map([
        [
          "pilot",
          twoCellPlan((document) => {
            const estimand = (document["analysis"] as JsonObject)[
              "primary_estimand"
            ] as JsonObject;
            estimand["measure"] = "risk_ratio";
          })
        ]
      ])
    });
    expect(codesOf(findings)).toContain(SupportCode.MeasureUnsupported);
    expect(
      findings.find(
        (finding) => finding.code === SupportCode.MeasureUnsupported
      )?.severity
    ).toBe("error");
  });

  it("accepts review of the implemented plan", () => {
    const findings = reviewStudyDesign({
      protocol: twoCellProtocol(),
      phases: new Map([["pilot", twoCellPlan(() => {})]])
    });
    expect(codesOf(findings)).not.toContain(SupportCode.MeasureUnsupported);
  });
});

describe("analysis support in the analytical preflight", () => {
  function lockOf(protocol: StudyProtocol): ProtocolLock {
    const created = createProtocolLock(
      protocol,
      [...twoCellMembers()].map(([path, text]) => ({ path, text })),
      [
        { variant: "shape-a", sha256: sha256Hex("two cell shape a") },
        { variant: "shape-b", sha256: sha256Hex("two cell shape b") }
      ],
      { schema: lockSchema }
    ).lock;
    if (created === null) {
      throw new Error("Fixture lock must be created.");
    }
    return created;
  }

  it("blocks a wald interval plan under a verified lock", () => {
    const protocol = twoCellProtocol();
    const lock = lockOf(protocol);
    const verification = verifyProtocolLock(lock, {
      members: [...twoCellMembers()].map(([path, text]) => ({ path, text }))
    });
    expect(verification.ok).toBe(true);
    const decision = preflightAnalyticalRun({
      protocol,
      phasePlan: twoCellPlan((document) => {
        const methods = (document["analysis"] as JsonObject)[
          "methods"
        ] as JsonObject;
        methods["binary_interval"] = "wald";
      }),
      lock,
      lockVerification: verification
    });
    expect(decision.allowed).toBe(false);
    expect(codesOf(decision.findings)).toContain(SupportCode.MethodUnsupported);
  });
});

describe("analysis support in StudyRun planning", () => {
  it("refuses to plan a StudyRun whose analysis requests a risk ratio", () => {
    const study = twoCellStudy();
    const result = planStudyRun({
      study_run_id: TWO_CELL_RUN_ID,
      created_at: TWO_CELL_CREATED_AT,
      protocol: {
        id: "two-cell-api-shape-v1",
        version: "1.0.0",
        protocol_lock_sha256: TWO_CELL_PROTOCOL_LOCK
      },
      phasePlan: twoCellPlan((document) => {
        const estimand = (document["analysis"] as JsonObject)[
          "primary_estimand"
        ] as JsonObject;
        estimand["measure"] = "risk_ratio";
      }),
      phase_plan_sha256: TWO_CELL_PHASE_PLAN_SHA256,
      phase_lock_sha256: TWO_CELL_PHASE_LOCK,
      schedule: study.schedule,
      study_compatibility_sha256: TWO_CELL_STUDY_COMPATIBILITY,
      implementation_sha256: TWO_CELL_IMPLEMENTATION,
      analysis_plan_sha256: TWO_CELL_ANALYSIS_PLAN,
      cells: TWO_CELL_CELLS.map((cellId) => ({
        cell_id: cellId,
        factor_levels: { api_shape: cellId },
        cell_compatibility_sha256: sha256Hex(`two cell key ${cellId}`)
      })),
      cohort_seed_base: {
        contractExecutionSha256: sha256Hex("two cell contract execution"),
        participantSurfaceTemplateSha256: sha256Hex("two cell surface"),
        packSha256: sha256Hex("two cell pack"),
        scenario: {
          id: "baseline",
          sha256: sha256Hex("two cell scenario")
        },
        behaviorSha256: sha256Hex("two cell behavior"),
        eval: {
          id: "prepare-and-replicate",
          sha256: sha256Hex("two cell eval")
        },
        caseRef: null
      },
      preflight: { ok: true, diagnostics: [] }
    });
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      SupportCode.MeasureUnsupported
    );
  });
});
