/**
 * Study and cell compatibility keys (specification sections 12.13 and 27.5).
 *
 * Cells may be compared only when the same Pack, Eval, primary metric
 * definition, and participant result contract apply across them. The study
 * key digests every value that must stay constant across the compared
 * cells. For every field a declared factor intentionally varies, the study
 * key holds the ordered factor and level binding manifest, never one cell's
 * selected value. The cell key then adds that cell's selected levels and
 * its effective run-time digests, so an intended difference cannot look
 * like drift and an undeclared difference cannot pass as intended.
 *
 * Ephemeral values never enter either key: run and StudyRun identifiers,
 * timestamps, random ports, generated credentials, the schedule seed and
 * order, and individual run seeds are validated elsewhere.
 *
 * Every function here is pure. The caller owns where the digests come from.
 */

import {
  canonicalJsonSha256,
  diagnostic,
  isSha256Hex,
  type Diagnostic,
  type JsonObject
} from "@oal/core";

/** Schema version of every hashed compatibility document. */
export const COMPATIBILITY_SCHEMA_VERSION = 1;

/** The only version 1 compatibility algorithm name. */
export const COMPATIBILITY_ALGORITHM = "compatibility-sha256-v1";

/** Stable diagnostic codes of the compatibility key. */
export const CompatibilityCode = {
  DigestMalformed: "OAL-STUDY-COMPATIBILITY-DIGEST-MALFORMED",
  FieldConflict: "OAL-STUDY-COMPATIBILITY-FIELD-CONFLICT",
  FactorBindingUnknown: "OAL-STUDY-COMPATIBILITY-FACTOR-BINDING-UNKNOWN",
  FactorManifestInvalid: "OAL-STUDY-COMPATIBILITY-FACTOR-MANIFEST-INVALID",
  LevelUnknown: "OAL-STUDY-COMPATIBILITY-LEVEL-UNKNOWN",
  CellUnknown: "OAL-STUDY-COMPATIBILITY-CELL-UNKNOWN",
  StudyKeyMismatch: "OAL-STUDY-COMPATIBILITY-STUDY-KEY-MISMATCH",
  CellKeyMismatch: "OAL-STUDY-COMPATIBILITY-CELL-KEY-MISMATCH"
} as const;

export type CompatibilityFactorRole =
  | "treatment"
  | "exposure"
  | "blocking"
  | "nuisance";

/** One level of one declared factor, with its locked binding digest. */
export interface CompatibilityFactorLevel {
  readonly id: string;
  readonly sha256: string;
}

/** Ordered manifest of one declared factor and every one of its levels. */
export interface CompatibilityFactorManifest {
  readonly id: string;
  readonly role: CompatibilityFactorRole;
  readonly levels: readonly CompatibilityFactorLevel[];
}

/** One field a declared factor intentionally varies. */
export interface CompatibilityFactorBinding {
  readonly field: string;
  readonly factor: string;
}

/** Common base contract and the ordered complete variant inventory. */
export interface ContractVariantInventory {
  readonly base_sha256: string;
  readonly projection_sha256: string | null;
  readonly variants: readonly {
    readonly id: string;
    readonly manifest_sha256: string;
    readonly effective_contract_sha256: string;
  }[];
}

/**
 * Locked protocol-time values the study key digests. The `common` record
 * holds every treatment-common digest: Pack, Eval, scenario, fixture,
 * behavior, task, prompt, result schema, workflow, rubric, semantic
 * registry, metrics, evidence requirements, missingness, response
 * profile, and cue policy. The `components` record holds every
 * behavior-affecting implementation digest. The `design` record holds the
 * eligibility, replacement, stopping, and analysis-plan digests.
 */
export interface StudyCompatibilityInput {
  readonly protocol_lock_sha256: string;
  readonly phase_plan_sha256: string;
  readonly common: Readonly<Record<string, string>>;
  readonly factor_bound: readonly CompatibilityFactorBinding[];
  readonly factors: readonly CompatibilityFactorManifest[];
  readonly components: Readonly<Record<string, string>>;
  readonly contract_variants: ContractVariantInventory;
  readonly design: Readonly<Record<string, string>>;
}

/** Cell values the cell key adds on top of the study key. */
export interface CellCompatibilityAdditions {
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly run_profile_sha256: string;
  readonly contract_execution_sha256: string;
  readonly scenario_sha256: string;
  readonly participant_surface_manifest_sha256: string;
}

export interface CellCompatibilityInput {
  readonly study: StudyCompatibilityInput;
  readonly cell: CellCompatibilityAdditions;
}

export interface CompatibilityKeyResult {
  readonly sha256: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

function report(
  diagnostics: Diagnostic[],
  code: string,
  message: string
): void {
  diagnostics.push(
    diagnostic({ severity: "error", phase: "preflight", code, message })
  );
}

function validateStudyInput(
  input: StudyCompatibilityInput,
  diagnostics: Diagnostic[]
): void {
  for (const [name, value] of [
    ["protocol_lock_sha256", input.protocol_lock_sha256],
    ["phase_plan_sha256", input.phase_plan_sha256]
  ] as const) {
    if (!isSha256Hex(value)) {
      report(
        diagnostics,
        CompatibilityCode.DigestMalformed,
        `${name} is not a lowercase 64-character SHA-256 digest.`
      );
    }
  }
  for (const [name, record] of [
    ["common", input.common],
    ["components", input.components],
    ["design", input.design]
  ] as const) {
    if (Object.keys(record).length === 0) {
      report(
        diagnostics,
        CompatibilityCode.FactorManifestInvalid,
        `A study key holds at least one ${name} digest.`
      );
      continue;
    }
    for (const field of Object.keys(record).sort()) {
      const value = record[field];
      if (value === undefined || !isSha256Hex(value)) {
        report(
          diagnostics,
          CompatibilityCode.DigestMalformed,
          `${name} field ${JSON.stringify(field)} is not a lowercase 64-character SHA-256 digest.`
        );
      }
    }
  }

  const factorIds = new Set<string>();
  for (const factor of input.factors) {
    if (factor.id.length === 0 || factorIds.has(factor.id)) {
      report(
        diagnostics,
        CompatibilityCode.FactorManifestInvalid,
        `Factor ${JSON.stringify(factor.id)} is empty or declared more than once.`
      );
      continue;
    }
    factorIds.add(factor.id);
    if (factor.levels.length === 0) {
      report(
        diagnostics,
        CompatibilityCode.FactorManifestInvalid,
        `Factor ${JSON.stringify(factor.id)} declares no level.`
      );
    }
    const levelIds = new Set<string>();
    for (const level of factor.levels) {
      if (levelIds.has(level.id)) {
        report(
          diagnostics,
          CompatibilityCode.FactorManifestInvalid,
          `Factor ${JSON.stringify(factor.id)} declares level ${JSON.stringify(level.id)} more than once.`
        );
      }
      levelIds.add(level.id);
      if (!isSha256Hex(level.sha256)) {
        report(
          diagnostics,
          CompatibilityCode.DigestMalformed,
          `Level ${JSON.stringify(level.id)} of factor ${JSON.stringify(factor.id)} records a malformed digest.`
        );
      }
    }
  }
  if (input.factors.length === 0) {
    report(
      diagnostics,
      CompatibilityCode.FactorManifestInvalid,
      "A study key holds the factor inventory, which is empty."
    );
  }

  for (const binding of input.factor_bound) {
    if (!factorIds.has(binding.factor)) {
      report(
        diagnostics,
        CompatibilityCode.FactorBindingUnknown,
        `Field ${JSON.stringify(binding.field)} is bound to undeclared factor ${JSON.stringify(binding.factor)}.`
      );
    }
    if (binding.field in input.common) {
      report(
        diagnostics,
        CompatibilityCode.FieldConflict,
        `Field ${JSON.stringify(binding.field)} is both treatment-common and factor-bound.`
      );
    }
  }

  if (!isSha256Hex(input.contract_variants.base_sha256)) {
    report(
      diagnostics,
      CompatibilityCode.DigestMalformed,
      "The variant inventory records a malformed base-contract digest."
    );
  }
  const projection = input.contract_variants.projection_sha256;
  if (projection !== null && !isSha256Hex(projection)) {
    report(
      diagnostics,
      CompatibilityCode.DigestMalformed,
      "The variant inventory records a malformed common-projection digest."
    );
  }
  const variantIds = new Set<string>();
  for (const variant of input.contract_variants.variants) {
    if (variantIds.has(variant.id)) {
      report(
        diagnostics,
        CompatibilityCode.FactorManifestInvalid,
        `Variant ${JSON.stringify(variant.id)} is listed more than once.`
      );
    }
    variantIds.add(variant.id);
    for (const [name, value] of [
      ["manifest_sha256", variant.manifest_sha256],
      ["effective_contract_sha256", variant.effective_contract_sha256]
    ] as const) {
      if (!isSha256Hex(value)) {
        report(
          diagnostics,
          CompatibilityCode.DigestMalformed,
          `Variant ${JSON.stringify(variant.id)} field ${name} is not a SHA-256 digest.`
        );
      }
    }
  }
}

/** Canonical document the study compatibility digest is taken over. */
export function studyCompatibilityDocument(
  input: StudyCompatibilityInput
): JsonObject {
  const projection = input.contract_variants.projection_sha256;
  return {
    schema_version: COMPATIBILITY_SCHEMA_VERSION,
    algorithm: COMPATIBILITY_ALGORITHM,
    protocol_lock_sha256: input.protocol_lock_sha256,
    phase_plan_sha256: input.phase_plan_sha256,
    common: { ...input.common },
    factor_bound: input.factor_bound.map((binding) => ({
      field: binding.field,
      factor: binding.factor
    })),
    factors: input.factors.map((factor) => ({
      id: factor.id,
      role: factor.role,
      levels: factor.levels.map((level) => ({
        id: level.id,
        sha256: level.sha256
      }))
    })),
    components: { ...input.components },
    contract_variants: {
      base_sha256: input.contract_variants.base_sha256,
      ...(projection === null ? {} : { projection_sha256: projection }),
      variants: input.contract_variants.variants.map((variant) => ({
        id: variant.id,
        manifest_sha256: variant.manifest_sha256,
        effective_contract_sha256: variant.effective_contract_sha256
      }))
    },
    design: { ...input.design }
  };
}

/**
 * Study compatibility digest over the locked protocol-time values. A
 * malformed input yields a null digest and error diagnostics instead of a
 * partial key.
 */
export function studyCompatibility(
  input: StudyCompatibilityInput
): CompatibilityKeyResult {
  const diagnostics: Diagnostic[] = [];
  validateStudyInput(input, diagnostics);
  if (diagnostics.length > 0) {
    return { sha256: null, diagnostics };
  }
  return {
    sha256: canonicalJsonSha256(studyCompatibilityDocument(input)),
    diagnostics
  };
}

/** Canonical document the cell compatibility digest is taken over. */
export function cellCompatibilityDocument(
  input: CellCompatibilityInput
): JsonObject {
  return {
    schema_version: COMPATIBILITY_SCHEMA_VERSION,
    algorithm: COMPATIBILITY_ALGORITHM,
    study: studyCompatibilityDocument(input.study),
    cell: {
      factor_levels: { ...input.cell.factor_levels },
      run_profile_sha256: input.cell.run_profile_sha256,
      contract_execution_sha256: input.cell.contract_execution_sha256,
      scenario_sha256: input.cell.scenario_sha256,
      participant_surface_manifest_sha256:
        input.cell.participant_surface_manifest_sha256
    }
  };
}

/**
 * Cell compatibility digest: the study key plus the cell's selected
 * levels and effective run-time digests. The selected levels must resolve
 * every declared factor.
 */
export function cellCompatibility(
  input: CellCompatibilityInput
): CompatibilityKeyResult {
  const diagnostics: Diagnostic[] = [];
  validateStudyInput(input.study, diagnostics);
  for (const [name, value] of [
    ["run_profile_sha256", input.cell.run_profile_sha256],
    ["contract_execution_sha256", input.cell.contract_execution_sha256],
    ["scenario_sha256", input.cell.scenario_sha256],
    [
      "participant_surface_manifest_sha256",
      input.cell.participant_surface_manifest_sha256
    ]
  ] as const) {
    if (!isSha256Hex(value)) {
      report(
        diagnostics,
        CompatibilityCode.DigestMalformed,
        `Cell field ${name} is not a lowercase 64-character SHA-256 digest.`
      );
    }
  }
  for (const factor of input.study.factors) {
    const selected = input.cell.factor_levels[factor.id];
    if (selected === undefined) {
      report(
        diagnostics,
        CompatibilityCode.LevelUnknown,
        `The cell selects no level of factor ${JSON.stringify(factor.id)}.`
      );
      continue;
    }
    if (!factor.levels.some((level) => level.id === selected)) {
      report(
        diagnostics,
        CompatibilityCode.LevelUnknown,
        `The cell selects level ${JSON.stringify(selected)}, which factor ${JSON.stringify(factor.id)} does not declare.`
      );
    }
  }
  if (diagnostics.length > 0) {
    return { sha256: null, diagnostics };
  }
  return {
    sha256: canonicalJsonSha256(cellCompatibilityDocument(input)),
    diagnostics
  };
}

/** Compatibility digests one collected cell report carries. */
export interface CellCompatibilityRecord {
  readonly cell_id: string;
  readonly study_compatibility_sha256: string;
  readonly cell_compatibility_sha256: string;
}

/** Verdict for one cell considered for pooled analysis. */
export interface CellCompatibilityVerdict {
  readonly cell_id: string;
  readonly included: boolean;
  readonly code: string | null;
  readonly message: string | null;
}

export interface CompatibilityPoolResult {
  readonly study_compatibility_sha256: string;
  readonly verdicts: readonly CellCompatibilityVerdict[];
  readonly included_cell_ids: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Pooling gate (sections 12.13 and 27.5). Every compared cell must carry
 * the frozen study key and the cell key the StudyRun header declared for
 * it. A cell that fails is excluded from pooled analysis with a
 * diagnostic; exclusion never silently shrinks a denominator because the
 * analysis reports the unresolved slots of every excluded cell.
 */
export function poolCompatibleCells(
  expected: {
    readonly study_compatibility_sha256: string;
    readonly cells: readonly {
      readonly cell_id: string;
      readonly cell_compatibility_sha256: string;
    }[];
  },
  observed: readonly CellCompatibilityRecord[]
): CompatibilityPoolResult {
  const diagnostics: Diagnostic[] = [];
  const verdicts: CellCompatibilityVerdict[] = [];
  const expectedKeys = new Map(
    expected.cells.map((cell) => [cell.cell_id, cell.cell_compatibility_sha256])
  );
  for (const cell of observed) {
    const reject = (code: string, message: string): void => {
      verdicts.push({ cell_id: cell.cell_id, included: false, code, message });
      diagnostics.push(
        diagnostic({ severity: "error", phase: "evaluate", code, message })
      );
    };
    const expectedCellKey = expectedKeys.get(cell.cell_id);
    if (expectedCellKey === undefined) {
      reject(
        CompatibilityCode.CellUnknown,
        `Cell ${JSON.stringify(cell.cell_id)} is not declared by the StudyRun header.`
      );
      continue;
    }
    if (
      !isSha256Hex(cell.study_compatibility_sha256) ||
      !isSha256Hex(cell.cell_compatibility_sha256)
    ) {
      reject(
        CompatibilityCode.DigestMalformed,
        `Cell ${JSON.stringify(cell.cell_id)} records a malformed compatibility digest.`
      );
      continue;
    }
    if (
      cell.study_compatibility_sha256 !== expected.study_compatibility_sha256
    ) {
      reject(
        CompatibilityCode.StudyKeyMismatch,
        `Cell ${JSON.stringify(cell.cell_id)} was produced under a different study compatibility key.`
      );
      continue;
    }
    if (cell.cell_compatibility_sha256 !== expectedCellKey) {
      reject(
        CompatibilityCode.CellKeyMismatch,
        `Cell ${JSON.stringify(cell.cell_id)} drifted from the cell compatibility key the header declared.`
      );
      continue;
    }
    verdicts.push({
      cell_id: cell.cell_id,
      included: true,
      code: null,
      message: null
    });
  }
  const included = verdicts.filter((verdict) => verdict.included);
  if (included.length > 0 && included.length < verdicts.length) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "evaluate",
        code: CompatibilityCode.CellKeyMismatch,
        message: `${verdicts.length - included.length} cell(s) were excluded from pooled analysis.`
      })
    );
  }
  return {
    study_compatibility_sha256: expected.study_compatibility_sha256,
    verdicts,
    included_cell_ids: included.map((verdict) => verdict.cell_id),
    diagnostics
  };
}
