import { describe, expect, it } from "vitest";
import { sha256Hex } from "@oal/core";

import {
  cellCompatibility,
  CompatibilityCode,
  poolCompatibleCells,
  studyCompatibility,
  studyCompatibilityDocument,
  type CellCompatibilityAdditions,
  type StudyCompatibilityInput
} from "./compatibility.ts";

/** Digest of one literal, so no expected value derives from the code. */
function digestOf(text: string): string {
  return sha256Hex(text);
}

function studyInput(): StudyCompatibilityInput {
  return {
    protocol_lock_sha256: digestOf("protocol lock"),
    phase_plan_sha256: digestOf("phase plan"),
    common: {
      pack_sha256: digestOf("pack"),
      eval_sha256: digestOf("eval"),
      scenario_sha256: digestOf("scenario"),
      rubric_sha256: digestOf("rubric"),
      metrics_sha256: digestOf("metrics")
    },
    factor_bound: [{ field: "effective_contract_sha256", factor: "api_shape" }],
    factors: [
      {
        id: "api_shape",
        role: "treatment",
        levels: [
          { id: "shape_a", sha256: digestOf("variant shape a") },
          { id: "shape_b", sha256: digestOf("variant shape b") }
        ]
      }
    ],
    components: {
      runner_sha256: digestOf("runner"),
      report_builder: digestOf("report builder")
    },
    contract_variants: {
      base_sha256: digestOf("base contract"),
      projection_sha256: null,
      variants: [
        {
          id: "shape-a",
          manifest_sha256: digestOf("manifest a"),
          effective_contract_sha256: digestOf("effective a")
        },
        {
          id: "shape-b",
          manifest_sha256: digestOf("manifest b"),
          effective_contract_sha256: digestOf("effective b")
        }
      ]
    },
    design: {
      eligibility_sha256: digestOf("eligibility"),
      replacement_sha256: digestOf("replacement policy"),
      analysis_plan_sha256: digestOf("analysis plan")
    }
  };
}

function cellAdditions(level: string): CellCompatibilityAdditions {
  return {
    factor_levels: { api_shape: level },
    run_profile_sha256: digestOf(`run profile ${level}`),
    contract_execution_sha256: digestOf(`contract execution ${level}`),
    scenario_sha256: digestOf(`scenario ${level}`),
    participant_surface_manifest_sha256: digestOf(`surface ${level}`)
  };
}

/** Copy of the fixture input with one treatment-common field replaced. */
function withCommon(field: string, value: string): StudyCompatibilityInput {
  return {
    ...studyInput(),
    common: { ...studyInput().common, [field]: value }
  };
}

describe("study compatibility key", () => {
  it("is deterministic for the same locked inputs", () => {
    const first = studyCompatibility(studyInput());
    const second = studyCompatibility(studyInput());
    expect(first.sha256).toBe(second.sha256);
    expect(first.diagnostics).toEqual([]);
  });

  it("changes when one treatment-common digest changes", () => {
    const base = studyCompatibility(studyInput());
    const other = studyCompatibility(
      withCommon("rubric_sha256", digestOf("other"))
    );
    expect(other.sha256).not.toBe(base.sha256);
  });

  it("keeps the study key fixed while a factor level differs", () => {
    // Selecting the other variant changes no treatment-common digest.
    const base = studyCompatibility(studyInput());
    expect(studyCompatibility(studyInput()).sha256).toBe(base.sha256);
  });

  it("rejects a field that is both common and factor-bound", () => {
    const result = studyCompatibility(
      withCommon("effective_contract_sha256", digestOf("conflicting"))
    );
    expect(result.sha256).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      CompatibilityCode.FieldConflict
    );
  });

  it("rejects a malformed digest with no partial key", () => {
    const result = studyCompatibility(
      withCommon("pack_sha256", "not-a-digest")
    );
    expect(result.sha256).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      CompatibilityCode.DigestMalformed
    );
  });

  it("holds the ordered factor manifest, not a selected level", () => {
    const document = studyCompatibilityDocument(studyInput());
    expect(document["factors"]).toEqual([
      {
        id: "api_shape",
        role: "treatment",
        levels: [
          { id: "shape_a", sha256: digestOf("variant shape a") },
          { id: "shape_b", sha256: digestOf("variant shape b") }
        ]
      }
    ]);
    expect(document["common"]).not.toHaveProperty("effective_contract_sha256");
  });
});

describe("cell compatibility key", () => {
  it("differs between two levels of the declared factor", () => {
    const first = cellCompatibility({
      study: studyInput(),
      cell: cellAdditions("shape_a")
    });
    const second = cellCompatibility({
      study: studyInput(),
      cell: cellAdditions("shape_b")
    });
    expect(first.sha256).not.toBeNull();
    expect(first.sha256).not.toBe(second.sha256);
  });

  it("changes when an ephemeral-free run-time digest drifts", () => {
    const base = cellCompatibility({
      study: studyInput(),
      cell: cellAdditions("shape_a")
    });
    const drifted = cellAdditions("shape_a");
    const other = cellCompatibility({
      study: studyInput(),
      cell: {
        ...drifted,
        scenario_sha256: digestOf("other scenario")
      }
    });
    expect(other.sha256).not.toBe(base.sha256);
  });

  it("rejects a level the factor does not declare", () => {
    const result = cellCompatibility({
      study: studyInput(),
      cell: cellAdditions("shape_c")
    });
    expect(result.sha256).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      CompatibilityCode.LevelUnknown
    );
  });

  it("rejects a cell that selects no level of a declared factor", () => {
    const result = cellCompatibility({
      study: studyInput(),
      cell: { ...cellAdditions("shape_a"), factor_levels: {} }
    });
    expect(result.sha256).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      CompatibilityCode.LevelUnknown
    );
  });
});

describe("pooling gate", () => {
  const studyKey = digestOf("study key");
  const cellKeyA = digestOf("cell key a");
  const cellKeyB = digestOf("cell key b");

  it("includes every cell that matches the declared keys", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: studyKey,
        cells: [
          { cell_id: "shape_a", cell_compatibility_sha256: cellKeyA },
          { cell_id: "shape_b", cell_compatibility_sha256: cellKeyB }
        ]
      },
      [
        {
          cell_id: "shape_a",
          study_compatibility_sha256: studyKey,
          cell_compatibility_sha256: cellKeyA
        },
        {
          cell_id: "shape_b",
          study_compatibility_sha256: studyKey,
          cell_compatibility_sha256: cellKeyB
        }
      ]
    );
    expect(result.included_cell_ids).toEqual(["shape_a", "shape_b"]);
    expect(result.verdicts.every((verdict) => verdict.included)).toBe(true);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error")
    ).toEqual([]);
  });

  it("excludes a drifted cell and keeps the other cell pooled", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: studyKey,
        cells: [
          { cell_id: "shape_a", cell_compatibility_sha256: cellKeyA },
          { cell_id: "shape_b", cell_compatibility_sha256: cellKeyB }
        ]
      },
      [
        {
          cell_id: "shape_a",
          study_compatibility_sha256: studyKey,
          cell_compatibility_sha256: digestOf("drifted")
        },
        {
          cell_id: "shape_b",
          study_compatibility_sha256: studyKey,
          cell_compatibility_sha256: cellKeyB
        }
      ]
    );
    expect(result.included_cell_ids).toEqual(["shape_b"]);
    const excluded = result.verdicts.find(
      (verdict) => verdict.cell_id === "shape_a"
    );
    expect(excluded?.included).toBe(false);
    expect(excluded?.code).toBe(CompatibilityCode.CellKeyMismatch);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.severity === "warning" &&
          entry.code === CompatibilityCode.CellKeyMismatch
      )
    ).toBe(true);
  });

  it("excludes a cell produced under a different study key", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: studyKey,
        cells: [{ cell_id: "shape_a", cell_compatibility_sha256: cellKeyA }]
      },
      [
        {
          cell_id: "shape_a",
          study_compatibility_sha256: digestOf("another study"),
          cell_compatibility_sha256: cellKeyA
        }
      ]
    );
    expect(result.included_cell_ids).toEqual([]);
    expect(result.verdicts[0]?.code).toBe(CompatibilityCode.StudyKeyMismatch);
  });

  it("excludes a cell the StudyRun header never declared", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: studyKey,
        cells: [{ cell_id: "shape_a", cell_compatibility_sha256: cellKeyA }]
      },
      [
        {
          cell_id: "shape_z",
          study_compatibility_sha256: studyKey,
          cell_compatibility_sha256: digestOf("unknown cell")
        }
      ]
    );
    expect(result.included_cell_ids).toEqual([]);
    expect(result.verdicts[0]?.code).toBe(CompatibilityCode.CellUnknown);
  });

  it("excludes a cell with a malformed digest", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: studyKey,
        cells: [{ cell_id: "shape_a", cell_compatibility_sha256: cellKeyA }]
      },
      [
        {
          cell_id: "shape_a",
          study_compatibility_sha256: "short",
          cell_compatibility_sha256: cellKeyA
        }
      ]
    );
    expect(result.included_cell_ids).toEqual([]);
    expect(result.verdicts[0]?.code).toBe(CompatibilityCode.DigestMalformed);
  });
});

describe("pooling diagnostics", () => {
  it("keeps every diagnostic inside the analysis vocabulary", () => {
    const result = poolCompatibleCells(
      {
        study_compatibility_sha256: digestOf("study key"),
        cells: [
          { cell_id: "shape_a", cell_compatibility_sha256: digestOf("a") }
        ]
      },
      []
    );
    expect(result.included_cell_ids).toEqual([]);
    expect(
      result.diagnostics.every((entry) => entry.code.startsWith("OAL-"))
    ).toBe(true);
  });
});
