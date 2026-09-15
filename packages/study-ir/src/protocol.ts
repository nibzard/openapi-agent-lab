/**
 * StudyProtocol model and loader (specification sections 12.7 and 12.8).
 *
 * A protocol declares why and how multiple experiment cells are compared. It
 * never reimplements behavior or scoring; it references immutable Pack and
 * Eval material by identity and digest. The loader validates the document
 * against `study-protocol.v1.schema.json`, then applies the semantic rules
 * the schema cannot express: unique identifiers, an allowlisted and
 * type-checked run-profile patch surface, a complete cell inventory, and
 * references that must resolve against caller-supplied registries.
 */

import {
  diagnostic,
  isJsonObject,
  isSafeId,
  isSha256Hex,
  validateSchemaInstance,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { StudyCode } from "./codes.ts";
import type { PhasePlan } from "./phase.ts";

export const STUDY_PROTOCOL_API_VERSION = "agentlab.dev/v1";
export const STUDY_PROTOCOL_KIND = "StudyProtocol";

/** Canonical operation key grammar used across the lab. */
export const OPERATION_KEY_PATTERN = /^path:[A-Z]+ \S+$/;

/** Immutable reference to a pack by identity, semantic version, and digest. */
export interface PackRef {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

export type MetricType = "binary" | "integer" | "continuous";

export type MissingnessPolicy =
  | "observed"
  | "unknown"
  | "not_applicable"
  | "unavailable_due_to_evidence";

export type MetricSource =
  | { readonly kind: "rubric_check"; readonly check_id: string }
  | { readonly kind: "rubric_signal"; readonly signal_id: string }
  | {
      readonly kind:
        | "trace_aggregate"
        | "documentation_aggregate"
        | "semantic_aggregate";
      readonly aggregate: string;
    }
  | { readonly kind: "state_projection"; readonly projection: string }
  | { readonly kind: "participant_report"; readonly field: string }
  | { readonly kind: "derived_expression"; readonly expression: string };

export interface ProtocolMetric {
  readonly id: string;
  readonly type: MetricType;
  readonly missingness?: MissingnessPolicy | undefined;
  readonly source: MetricSource;
}

export type FactorRole = "treatment" | "exposure" | "blocking" | "nuisance";

/**
 * Run-profile patch as authored: dotted treatment field to JSON value. The
 * compiler rewrites it into the canonical nested object form.
 */
export type RunProfilePatch = Readonly<Record<string, Json>>;

export interface FactorLevel {
  readonly id: string;
  readonly contract_variant?: string | undefined;
  readonly run_profile_patch?: RunProfilePatch | undefined;
}

export interface ProtocolFactor {
  readonly id: string;
  readonly role: FactorRole;
  readonly levels: FactorLevel[];
}

export interface ProtocolEvaluation {
  readonly pack: PackRef;
  readonly eval: string;
  readonly scenario: string;
  readonly contract_variant_set?: string | undefined;
}

export interface ProtocolConstants {
  readonly run_profile: string;
  readonly required_parallel?: number | undefined;
  readonly data_plane_scope?: "all" | "task" | undefined;
  readonly response_profile?: string | undefined;
}

export interface ProtocolBlinding {
  readonly mode: "none" | "declared" | "strict";
  readonly participant_surface_policy?: string | undefined;
  readonly require_pairwise_surface_diff_review?: boolean | undefined;
}

export interface ProtocolMetadata {
  readonly id: string;
  readonly version: string;
  readonly title: string;
}

export interface ProtocolMetrics {
  readonly primary: ProtocolMetric[];
  readonly secondary?: ProtocolMetric[] | undefined;
}

/** Typed StudyProtocol. Serialized form validates against its schema. */
export interface StudyProtocol {
  readonly apiVersion: typeof STUDY_PROTOCOL_API_VERSION;
  readonly kind: typeof STUDY_PROTOCOL_KIND;
  readonly metadata: ProtocolMetadata;
  readonly objective: string;
  readonly evaluation: ProtocolEvaluation;
  readonly factors: ProtocolFactor[];
  readonly constants: ProtocolConstants;
  readonly metrics: ProtocolMetrics;
  readonly blinding: ProtocolBlinding;
  readonly phases: Readonly<Record<string, string>>;
  readonly interpretation_limits: string[];
  readonly extensions: JsonObject;
}

/**
 * Registries the loader resolves references against. Every entry is
 * optional; an absent registry skips that check instead of failing.
 */
export interface ProtocolReferences {
  /** Canonical operation keys of the referenced contract (ContractIR). */
  readonly contractOperations?: ReadonlySet<string> | undefined;
  /** Variant IDs declared by the referenced ContractVariantSet. */
  readonly contractVariants?: ReadonlySet<string> | undefined;
  /** Parsed phase plans by protocol phase ID. */
  readonly phasePlans?: ReadonlyMap<string, PhasePlan> | undefined;
}

export interface ProtocolLoadOptions {
  /** Draft 2020-12 `study-protocol.v1` schema. The caller reads it. */
  readonly schema?: Json | undefined;
  /** Document URI recorded in diagnostics. */
  readonly documentUri?: string | undefined;
  /** Reference registries for cross-document resolution. */
  readonly references?: ProtocolReferences | undefined;
}

export interface ProtocolLoadResult {
  /** The typed protocol, or null when any error was reported. */
  readonly protocol: StudyProtocol | null;
  readonly diagnostics: Diagnostic[];
}

/** One resolved cell of the factor design. */
export interface ResolvedCell {
  readonly cell_id: string;
  readonly factor_levels: Readonly<Record<string, string>>;
  /** True when the cell came from an explicit subset declaration. */
  readonly explicit: boolean;
  /** Reason a combination is absent, or null for a present cell. */
  readonly why_absent: string | null;
}

/** A cell declared by an explicit subset instead of the full product. */
export interface DeclaredCell {
  /** Complete factor-to-level map. */
  readonly factor_levels: Readonly<Record<string, string>>;
  /** Explicit cell ID. Required when the derived ID is unsafe. */
  readonly cell_id?: string | undefined;
}

/** Type of a run-profile patch value rule. */
type PatchValueRule =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "string" }
  | { readonly kind: "string_or_null" }
  | { readonly kind: "positive_integer" }
  | { readonly kind: "nonnegative_integer" };

/**
 * Closed allowlist of treatment fields a run-profile patch may bind
 * (specification section 12.8). A patch to any other field is rejected.
 */
export const RUN_PROFILE_PATCH_FIELDS: ReadonlyMap<string, PatchValueRule> =
  new Map<string, PatchValueRule>([
    [
      "exposure.mode",
      { kind: "enum", values: ["raw-http", "direct-tools", "catalog-tools"] }
    ],
    [
      "exposure.contract_visibility",
      { kind: "enum", values: ["none", "file", "discoverable"] }
    ],
    ["exposure.documentation_profile", { kind: "string_or_null" }],
    ["exposure.data_plane_scope", { kind: "enum", values: ["all", "task"] }],
    ["agent.adapter", { kind: "enum", values: ["codex-cli", "generic"] }],
    ["agent.model", { kind: "string_or_null" }],
    [
      "agent.effort",
      { kind: "enum", values: ["low", "medium", "high", "xhigh", "null"] }
    ],
    [
      "agent.sandbox",
      {
        kind: "enum",
        values: ["danger-full-access", "workspace-write", "read-only", "null"]
      }
    ],
    ["execution.timeout_ms", { kind: "positive_integer" }],
    ["execution.parallel", { kind: "positive_integer" }],
    ["limits.max_agent_tool_calls", { kind: "nonnegative_integer" }],
    ["limits.max_api_requests", { kind: "nonnegative_integer" }],
    ["limits.max_artifact_bytes", { kind: "nonnegative_integer" }]
  ]);

/** Nullable enum members encode a JSON null level. */
const NULLABLE_ENUM_SENTINEL = "null";

function patchValueAllows(rule: PatchValueRule, value: Json): boolean {
  switch (rule.kind) {
    case "enum": {
      if (value === null) {
        return rule.values.includes(NULLABLE_ENUM_SENTINEL);
      }
      return typeof value === "string" && rule.values.includes(value);
    }
    case "string": {
      return typeof value === "string" && value.length > 0;
    }
    case "string_or_null": {
      return value === null || (typeof value === "string" && value.length > 0);
    }
    case "positive_integer": {
      return typeof value === "number" && Number.isInteger(value) && value >= 1;
    }
    case "nonnegative_integer": {
      return typeof value === "number" && Number.isInteger(value) && value >= 0;
    }
  }
}

/** Order strings by Unicode code point. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Join dot-separated patch keys into one canonical nested object. */
export function canonicalNestedPatch(
  patch: RunProfilePatch
): JsonObject | null {
  const root: JsonObject = {};
  for (const key of Object.keys(patch)) {
    const segments = key.split(".");
    let node: JsonObject = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined || segment.length === 0) {
        return null;
      }
      const last = index === segments.length - 1;
      if (last) {
        node[segment] = patch[key] as Json;
      } else {
        const existing = node[segment];
        if (existing === undefined) {
          const created: JsonObject = {};
          node[segment] = created;
          node = created;
        } else if (isJsonObject(existing)) {
          node = existing;
        } else {
          return null;
        }
      }
    }
  }
  return root;
}

/** Collect canonical operation-key references inside a patch value tree. */
export function collectOperationReferences(value: Json): string[] {
  if (typeof value === "string") {
    return OPERATION_KEY_PATTERN.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectOperationReferences(entry));
  }
  if (isJsonObject(value)) {
    return Object.keys(value).flatMap((key) =>
      collectOperationReferences(value[key] as Json)
    );
  }
  return [];
}

/** The level IDs of one factor in canonical code-point order. */
function sortedLevelIds(factor: ProtocolFactor): string[] {
  return factor.levels.map((level) => level.id).sort(byCodePoint);
}

/** Factor-to-level-ID map keyed by canonical factor order. */
function factorLevelIndex(
  factors: readonly ProtocolFactor[]
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const factor of factors) {
    index.set(factor.id, sortedLevelIds(factor));
  }
  return index;
}

/** Canonical map key: level IDs joined in canonical factor order. */
function mapKey(
  orderedFactorIds: readonly string[],
  factorLevels: Readonly<Record<string, string>>
): string {
  return orderedFactorIds
    .map((factorId) => factorLevels[factorId] ?? "")
    .join("\u0000");
}

/**
 * Enumerate the complete Cartesian product in canonical order: factors by
 * factor ID, levels by level ID, then lexicographic by ordered level map.
 */
export function expandCellProduct(
  factors: readonly ProtocolFactor[]
): Array<Readonly<Record<string, string>>> {
  const ordered = [...factors].sort((a, b) => byCodePoint(a.id, b.id));
  let product: Array<Readonly<Record<string, string>>> = [{}];
  for (const factor of ordered) {
    const levelIds = sortedLevelIds(factor);
    const next: Array<Readonly<Record<string, string>>> = [];
    for (const partial of product) {
      for (const levelId of levelIds) {
        next.push({ ...partial, [factor.id]: levelId });
      }
    }
    product = next;
  }
  return product;
}

/** Default cell ID: level IDs joined by `__` in canonical factor order. */
export function deriveCellId(
  factors: readonly ProtocolFactor[],
  factorLevels: Readonly<Record<string, string>>
): string {
  const ordered = [...factors]
    .sort((a, b) => byCodePoint(a.id, b.id))
    .map((factor) => factorLevels[factor.id] ?? "");
  return ordered.join("__");
}

export interface CellInventoryResult {
  /** Resolved cells in canonical order, or empty when resolution failed. */
  readonly cells: ResolvedCell[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Resolve the cell inventory of a factor design. Without declared cells the
 * inventory must be the complete Cartesian product. Declared cells name a
 * subset: when `absentReasons` is supplied, every absent combination must
 * state a reason there; when it is omitted, the declared list claims to be
 * the complete inventory and any count mismatch fails.
 */
export function resolveCellInventory(
  factors: readonly ProtocolFactor[],
  declared?: readonly DeclaredCell[],
  absentReasons?: ReadonlyMap<string, string>,
  documentUri: string | null = null
): CellInventoryResult {
  const diagnostics: Diagnostic[] = [];
  const error = (
    code: string,
    message: string,
    pointer: string
  ): Diagnostic[] => {
    const entry = diagnostic({
      severity: "error",
      phase: "preflight",
      code,
      message,
      document_uri: documentUri,
      json_pointer: pointer
    });
    diagnostics.push(entry);
    return diagnostics;
  };
  if (factors.length === 0) {
    error(
      StudyCode.StructureInvalid,
      "A protocol needs at least one factor.",
      "/factors"
    );
    return { cells: [], diagnostics };
  }
  const orderedFactorIds = factors.map((factor) => factor.id).sort(byCodePoint);
  const levels = factorLevelIndex(factors);
  for (const factor of factors) {
    for (const level of factor.levels) {
      if (level.id.includes("__")) {
        error(
          StudyCode.CellIdUnsafe,
          `Level ID ${JSON.stringify(level.id)} contains "__" and would make the derived cell ID ambiguous.`,
          `/factors/${factors.indexOf(factor)}/levels/${factor.levels.indexOf(level)}/id`
        );
      }
    }
  }
  const product = expandCellProduct(factors);
  const productKeys = new Set(
    product.map((entry) => mapKey(orderedFactorIds, entry))
  );
  const factorSet = new Set(orderedFactorIds);

  if (declared === undefined) {
    const cells: ResolvedCell[] = [];
    const seen = new Set<string>();
    for (const entry of product) {
      const cellId = deriveCellId(factors, entry);
      if (!isSafeId(cellId)) {
        error(
          StudyCode.CellIdUnsafe,
          `Derived cell ID ${JSON.stringify(cellId)} is not a safe identifier; declare explicit unique cell IDs.`,
          "/factors"
        );
        continue;
      }
      if (seen.has(cellId)) {
        error(
          StudyCode.CellDuplicate,
          `Derived cell ID ${JSON.stringify(cellId)} collides; declare explicit unique cell IDs.`,
          "/factors"
        );
        continue;
      }
      seen.add(cellId);
      cells.push({
        cell_id: cellId,
        factor_levels: { ...entry },
        explicit: false,
        why_absent: null
      });
    }
    return { cells, diagnostics };
  }

  const cells: ResolvedCell[] = [];
  const seenKeys = new Set<string>();
  const seenCellIds = new Set<string>();
  for (let index = 0; index < declared.length; index += 1) {
    const cell = declared[index];
    if (cell === undefined) {
      continue;
    }
    const pointer = `/cells/${index}`;
    const keys = Object.keys(cell.factor_levels).sort(byCodePoint);
    for (const key of keys) {
      if (!factorSet.has(key)) {
        error(
          StudyCode.CellFactorUnknown,
          `Cell declares unknown factor ${JSON.stringify(key)}.`,
          `${pointer}/factor_levels`
        );
      }
    }
    for (const factorId of orderedFactorIds) {
      if (!(factorId in cell.factor_levels)) {
        error(
          StudyCode.CellFactorUnknown,
          `Cell omits factor ${JSON.stringify(factorId)}.`,
          `${pointer}/factor_levels`
        );
      }
    }
    for (const key of keys) {
      const value = cell.factor_levels[key];
      const allowed = levels.get(key);
      if (
        allowed !== undefined &&
        value !== undefined &&
        !allowed.includes(value)
      ) {
        error(
          StudyCode.CellLevelUnknown,
          `Factor ${JSON.stringify(key)} has no level ${JSON.stringify(value)}.`,
          `${pointer}/factor_levels`
        );
      }
    }
    const key = mapKey(orderedFactorIds, cell.factor_levels);
    if (seenKeys.has(key)) {
      error(
        StudyCode.CellDuplicate,
        "Cell lists the same factor-to-level map more than once.",
        pointer
      );
      continue;
    }
    seenKeys.add(key);
    if (!productKeys.has(key)) {
      continue;
    }
    const cellId = cell.cell_id ?? deriveCellId(factors, cell.factor_levels);
    if (!isSafeId(cellId)) {
      error(
        StudyCode.CellIdUnsafe,
        `Cell ID ${JSON.stringify(cellId)} is not a safe identifier.`,
        `${pointer}/cell_id`
      );
      continue;
    }
    if (seenCellIds.has(cellId)) {
      error(
        StudyCode.CellDuplicate,
        `Cell ID ${JSON.stringify(cellId)} is used more than once.`,
        `${pointer}/cell_id`
      );
      continue;
    }
    seenCellIds.add(cellId);
    cells.push({
      cell_id: cellId,
      factor_levels: { ...cell.factor_levels },
      explicit: true,
      why_absent: null
    });
  }

  if (absentReasons === undefined) {
    if (cells.length !== product.length) {
      error(
        StudyCode.CellInventoryIncomplete,
        `A complete factorial design must resolve ${product.length} cells; ${cells.length} were listed.`,
        "/cells"
      );
    }
  } else {
    for (const entry of product) {
      const key = mapKey(orderedFactorIds, entry);
      if (seenKeys.has(key)) {
        continue;
      }
      const cellId = deriveCellId(factors, entry);
      const reason = absentReasons.get(cellId);
      if (reason === undefined) {
        error(
          StudyCode.CellAbsentUnexplained,
          `Combination ${JSON.stringify(cellId)} is absent without a stated reason.`,
          "/cells"
        );
        continue;
      }
      cells.push({
        cell_id: cellId,
        factor_levels: { ...entry },
        explicit: false,
        why_absent: reason
      });
    }
  }

  cells.sort((a, b) => byCodePoint(a.cell_id, b.cell_id));
  return { cells, diagnostics };
}

/** Read one object field. A missing field reads as undefined. */
function fieldOf(value: JsonObject, key: string): Json | undefined {
  return value[key];
}

function readString(
  value: Json | undefined,
  pointer: string,
  what: string,
  report: (entry: Diagnostic) => void
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: `${what} must be a non-empty string.`,
        json_pointer: pointer
      })
    );
    return null;
  }
  return value;
}

function readSafeId(
  value: Json | undefined,
  pointer: string,
  what: string,
  report: (entry: Diagnostic) => void
): string | null {
  const text = readString(value, pointer, what, report);
  if (text === null) {
    return null;
  }
  if (!isSafeId(text)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: `${what} is not a safe identifier: ${JSON.stringify(text)}.`,
        json_pointer: pointer
      })
    );
    return null;
  }
  return text;
}

/** Load and validate one StudyProtocol document. Never throws on content. */
export async function loadProtocol(
  document: Json,
  options: ProtocolLoadOptions = {}
): Promise<ProtocolLoadResult> {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;

  if (options.schema !== undefined) {
    // Study documents are untrusted: their schema evaluation runs inside
    // the bounded schema-worker boundary.
    const violations = await validateSchemaInstance(options.schema, document);
    for (const violation of violations) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `${violation.code}: ${violation.message}`,
          document_uri: uri,
          json_pointer:
            violation.pointer.length === 0
              ? "#/"
              : `#/${violation.pointer.slice(1)}`
        })
      );
    }
  }

  if (!isJsonObject(document)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A StudyProtocol must be an object.",
        document_uri: uri,
        json_pointer: "#/"
      })
    );
    return { protocol: null, diagnostics };
  }

  const metadataValue = fieldOf(document, "metadata");
  const evaluationValue = fieldOf(document, "evaluation");
  const constantsValue = fieldOf(document, "constants");
  const metricsValue = fieldOf(document, "metrics");
  const blindingValue = fieldOf(document, "blinding");
  const phasesValue = fieldOf(document, "phases");
  if (
    !isJsonObject(metadataValue) ||
    !isJsonObject(evaluationValue) ||
    !isJsonObject(constantsValue) ||
    !isJsonObject(metricsValue) ||
    !isJsonObject(blindingValue) ||
    !isJsonObject(phasesValue)
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message:
          "metadata, evaluation, constants, metrics, blinding, and phases must be objects.",
        document_uri: uri,
        json_pointer: "#/"
      })
    );
    return { protocol: null, diagnostics };
  }

  const metadata = readMetadata(metadataValue, report);
  const evaluation = readEvaluation(evaluationValue, report);
  const objective = readString(
    fieldOf(document, "objective"),
    "#/objective",
    "objective",
    report
  );
  const constants = readConstants(constantsValue, report);
  const metrics = readMetrics(metricsValue, report);
  const blinding = readBlinding(blindingValue, report);
  const phases = readPhases(phasesValue, report);
  const interpretation = readInterpretationLimits(
    fieldOf(document, "interpretation_limits"),
    report
  );
  const extensions = fieldOf(document, "extensions");
  if (
    metadata === null ||
    evaluation === null ||
    objective === null ||
    constants === null ||
    metrics === null ||
    blinding === null ||
    phases === null ||
    interpretation === null
  ) {
    return { protocol: null, diagnostics };
  }

  const factors = readFactors(document, report);
  if (factors === null) {
    return { protocol: null, diagnostics };
  }

  checkUniqueFactorIds(factors, report);
  const referencedVariants = checkContractVariantReferences(
    factors,
    options.references,
    report
  );
  checkPatchSurface(factors, options.references, report);
  checkUniqueMetricIds(metrics, report);
  const inventory = resolveCellInventory(factors, undefined, undefined, uri);
  for (const entry of inventory.diagnostics) {
    report(entry);
  }
  checkPhaseReferences(phases, options.references, report);
  checkMemberPaths(constants, evaluation, blinding, phases, report);

  const protocol: StudyProtocol = {
    apiVersion: STUDY_PROTOCOL_API_VERSION,
    kind: STUDY_PROTOCOL_KIND,
    metadata,
    objective,
    evaluation,
    factors,
    constants,
    metrics,
    blinding,
    phases,
    interpretation_limits: interpretation,
    extensions: isJsonObject(extensions) ? extensions : {}
  };
  if (
    referencedVariants.size > 0 &&
    evaluation.contract_variant_set === undefined
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.ContractVariantUnknown,
        message:
          "A factor selects a contract variant, but evaluation.contract_variant_set is absent.",
        document_uri: uri,
        json_pointer: "#/evaluation/contract_variant_set"
      })
    );
    return { protocol: null, diagnostics };
  }
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { protocol: null, diagnostics };
  }
  return { protocol, diagnostics };
}

function readMetadata(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolMetadata | null {
  const id = readSafeId(
    fieldOf(value, "id"),
    "#/metadata/id",
    "protocol id",
    report
  );
  const version = readString(
    fieldOf(value, "version"),
    "#/metadata/version",
    "protocol version",
    report
  );
  const title = readString(
    fieldOf(value, "title"),
    "#/metadata/title",
    "protocol title",
    report
  );
  if (id === null || version === null || title === null) {
    return null;
  }
  return { id, version, title };
}

function readEvaluation(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolEvaluation | null {
  const packValue = fieldOf(value, "pack");
  if (!isJsonObject(packValue)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "evaluation.pack must be an object.",
        json_pointer: "#/evaluation/pack"
      })
    );
    return null;
  }
  const packId = readSafeId(
    fieldOf(packValue, "id"),
    "#/evaluation/pack/id",
    "pack id",
    report
  );
  const packVersion = readString(
    fieldOf(packValue, "version"),
    "#/evaluation/pack/version",
    "pack version",
    report
  );
  const packDigest = fieldOf(packValue, "sha256");
  if (typeof packDigest !== "string" || !isSha256Hex(packDigest)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "evaluation.pack.sha256 must be a lowercase SHA-256 digest.",
        json_pointer: "#/evaluation/pack/sha256"
      })
    );
  }
  const evalId = readSafeId(
    fieldOf(value, "eval"),
    "#/evaluation/eval",
    "eval id",
    report
  );
  const scenario = readSafeId(
    fieldOf(value, "scenario"),
    "#/evaluation/scenario",
    "scenario id",
    report
  );
  const variantSet = fieldOf(value, "contract_variant_set");
  if (
    variantSet !== undefined &&
    (typeof variantSet !== "string" || variantSet.length === 0)
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "evaluation.contract_variant_set must be a non-empty string.",
        json_pointer: "#/evaluation/contract_variant_set"
      })
    );
    return null;
  }
  if (
    packId === null ||
    packVersion === null ||
    typeof packDigest !== "string" ||
    evalId === null ||
    scenario === null
  ) {
    return null;
  }
  return {
    pack: { id: packId, version: packVersion, sha256: packDigest },
    eval: evalId,
    scenario,
    ...(variantSet === undefined ? {} : { contract_variant_set: variantSet })
  };
}

function readConstants(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolConstants | null {
  const runProfile = readString(
    fieldOf(value, "run_profile"),
    "#/constants/run_profile",
    "constants.run_profile",
    report
  );
  const requiredParallel = fieldOf(value, "required_parallel");
  if (
    requiredParallel !== undefined &&
    (typeof requiredParallel !== "number" ||
      !Number.isInteger(requiredParallel) ||
      requiredParallel < 1)
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "constants.required_parallel must be a positive integer.",
        json_pointer: "#/constants/required_parallel"
      })
    );
  }
  const dataPlaneScope = fieldOf(value, "data_plane_scope");
  if (
    dataPlaneScope !== undefined &&
    dataPlaneScope !== "all" &&
    dataPlaneScope !== "task"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "constants.data_plane_scope must be all or task.",
        json_pointer: "#/constants/data_plane_scope"
      })
    );
  }
  const responseProfile = fieldOf(value, "response_profile");
  if (
    responseProfile !== undefined &&
    (typeof responseProfile !== "string" || responseProfile.length === 0)
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "constants.response_profile must be a non-empty string.",
        json_pointer: "#/constants/response_profile"
      })
    );
  }
  if (runProfile === null) {
    return null;
  }
  return {
    run_profile: runProfile,
    ...(typeof requiredParallel === "number"
      ? { required_parallel: requiredParallel }
      : {}),
    ...(dataPlaneScope === "all" || dataPlaneScope === "task"
      ? { data_plane_scope: dataPlaneScope }
      : {}),
    ...(typeof responseProfile === "string"
      ? { response_profile: responseProfile }
      : {})
  };
}

function readMetricSource(
  value: Json | undefined,
  pointer: string,
  report: (entry: Diagnostic) => void
): MetricSource | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A metric source must be an object.",
        json_pointer: pointer
      })
    );
    return null;
  }
  const kind = fieldOf(value, "kind");
  const text = (key: string): string | null =>
    readString(
      fieldOf(value, key),
      `${pointer}/${key}`,
      `metric source ${key}`,
      report
    );
  switch (kind) {
    case "rubric_check": {
      const checkId = text("check_id");
      return checkId === null
        ? null
        : { kind: "rubric_check", check_id: checkId };
    }
    case "rubric_signal": {
      const signalId = text("signal_id");
      return signalId === null
        ? null
        : { kind: "rubric_signal", signal_id: signalId };
    }
    case "trace_aggregate":
    case "documentation_aggregate":
    case "semantic_aggregate": {
      const aggregate = text("aggregate");
      return aggregate === null ? null : { kind, aggregate };
    }
    case "state_projection": {
      const projection = text("projection");
      return projection === null
        ? null
        : { kind: "state_projection", projection };
    }
    case "participant_report": {
      const field = text("field");
      return field === null ? null : { kind: "participant_report", field };
    }
    case "derived_expression": {
      const expression = text("expression");
      return expression === null
        ? null
        : { kind: "derived_expression", expression };
    }
    default: {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `Unknown metric source kind ${JSON.stringify(kind)}.`,
          json_pointer: `${pointer}/kind`
        })
      );
      return null;
    }
  }
}

function readMetric(
  value: Json,
  pointer: string,
  report: (entry: Diagnostic) => void
): ProtocolMetric | null {
  if (!isJsonObject(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A metric must be an object.",
        json_pointer: pointer
      })
    );
    return null;
  }
  const id = readSafeId(
    fieldOf(value, "id"),
    `${pointer}/id`,
    "metric id",
    report
  );
  const type = fieldOf(value, "type");
  if (type !== "binary" && type !== "integer" && type !== "continuous") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A metric type must be binary, integer, or continuous.",
        json_pointer: `${pointer}/type`
      })
    );
  }
  const missingness = fieldOf(value, "missingness");
  if (
    missingness !== undefined &&
    missingness !== "observed" &&
    missingness !== "unknown" &&
    missingness !== "not_applicable" &&
    missingness !== "unavailable_due_to_evidence"
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A metric missingness policy is not a known member.",
        json_pointer: `${pointer}/missingness`
      })
    );
  }
  const source = readMetricSource(
    fieldOf(value, "source"),
    `${pointer}/source`,
    report
  );
  if (id === null || source === null || typeof type !== "string") {
    return null;
  }
  return {
    id,
    type: type as MetricType,
    ...(typeof missingness === "string"
      ? { missingness: missingness as MissingnessPolicy }
      : {}),
    source
  };
}

function readMetrics(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolMetrics | null {
  const primaryValue = fieldOf(value, "primary");
  if (!Array.isArray(primaryValue)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "metrics.primary must be an array.",
        json_pointer: "#/metrics/primary"
      })
    );
    return null;
  }
  const primary: ProtocolMetric[] = [];
  for (let index = 0; index < primaryValue.length; index += 1) {
    const metric = readMetric(
      primaryValue[index] as Json,
      `#/metrics/primary/${index}`,
      report
    );
    if (metric !== null) {
      primary.push(metric);
    }
  }
  if (primary.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A protocol needs at least one primary metric.",
        json_pointer: "#/metrics/primary"
      })
    );
    return null;
  }
  const secondaryValue = fieldOf(value, "secondary");
  if (secondaryValue !== undefined && !Array.isArray(secondaryValue)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "metrics.secondary must be an array.",
        json_pointer: "#/metrics/secondary"
      })
    );
    return null;
  }
  const secondary: ProtocolMetric[] = [];
  if (secondaryValue !== undefined) {
    for (let index = 0; index < secondaryValue.length; index += 1) {
      const metric = readMetric(
        (secondaryValue as Json[])[index] as Json,
        `#/metrics/secondary/${index}`,
        report
      );
      if (metric !== null) {
        secondary.push(metric);
      }
    }
  }
  return {
    primary,
    ...(secondary.length === 0 ? {} : { secondary })
  };
}

function readBlinding(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolBlinding | null {
  const mode = fieldOf(value, "mode");
  if (mode !== "none" && mode !== "declared" && mode !== "strict") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "blinding.mode must be none, declared, or strict.",
        json_pointer: "#/blinding/mode"
      })
    );
    return null;
  }
  const policy = fieldOf(value, "participant_surface_policy");
  if (
    policy !== undefined &&
    (typeof policy !== "string" || policy.length === 0)
  ) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message:
          "blinding.participant_surface_policy must be a non-empty string.",
        json_pointer: "#/blinding/participant_surface_policy"
      })
    );
    return null;
  }
  const pairwise = fieldOf(value, "require_pairwise_surface_diff_review");
  if (pairwise !== undefined && typeof pairwise !== "boolean") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message:
          "blinding.require_pairwise_surface_diff_review must be a boolean.",
        json_pointer: "#/blinding/require_pairwise_surface_diff_review"
      })
    );
    return null;
  }
  return {
    mode,
    ...(typeof policy === "string"
      ? { participant_surface_policy: policy }
      : {}),
    ...(typeof pairwise === "boolean"
      ? { require_pairwise_surface_diff_review: pairwise }
      : {})
  };
}

function readPhases(
  value: JsonObject,
  report: (entry: Diagnostic) => void
): Readonly<Record<string, string>> | null {
  const phases: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (!isSafeId(key)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `Phase key ${JSON.stringify(key)} is not a safe identifier.`,
          json_pointer: "#/phases"
        })
      );
      continue;
    }
    const path = fieldOf(value, key);
    if (typeof path !== "string" || path.length === 0) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `Phase ${JSON.stringify(key)} must name a non-empty path.`,
          json_pointer: `#/phases/${key}`
        })
      );
      continue;
    }
    phases[key] = path;
  }
  if (Object.keys(phases).length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A protocol needs at least one phase.",
        json_pointer: "#/phases"
      })
    );
    return null;
  }
  return phases;
}

function readInterpretationLimits(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): string[] | null {
  if (!Array.isArray(value)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "interpretation_limits must be an array.",
        json_pointer: "#/interpretation_limits"
      })
    );
    return null;
  }
  const limits: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.length === 0) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: "An interpretation limit must be a non-empty string.",
          json_pointer: `#/interpretation_limits/${index}`
        })
      );
      continue;
    }
    limits.push(entry);
  }
  if (limits.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A protocol needs at least one interpretation limit.",
        json_pointer: "#/interpretation_limits"
      })
    );
    return null;
  }
  return limits;
}

function readFactors(
  document: JsonObject,
  report: (entry: Diagnostic) => void
): ProtocolFactor[] | null {
  const value = fieldOf(document, "factors");
  if (!Array.isArray(value) || value.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "factors must be a non-empty array.",
        json_pointer: "#/factors"
      })
    );
    return null;
  }
  const factors: ProtocolFactor[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const pointer = `#/factors/${index}`;
    if (!isJsonObject(raw)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: "A factor must be an object.",
          json_pointer: pointer
        })
      );
      continue;
    }
    const id = readSafeId(
      fieldOf(raw, "id"),
      `${pointer}/id`,
      "factor id",
      report
    );
    const role = fieldOf(raw, "role");
    if (
      role !== "treatment" &&
      role !== "exposure" &&
      role !== "blocking" &&
      role !== "nuisance"
    ) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `Factor role ${JSON.stringify(role)} is not a version 1 role.`,
          json_pointer: `${pointer}/role`
        })
      );
    }
    const levelsValue = fieldOf(raw, "levels");
    if (!Array.isArray(levelsValue) || levelsValue.length === 0) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: "A factor needs at least one level.",
          json_pointer: `${pointer}/levels`
        })
      );
      continue;
    }
    const levels: FactorLevel[] = [];
    for (let levelIndex = 0; levelIndex < levelsValue.length; levelIndex += 1) {
      const rawLevel = levelsValue[levelIndex];
      const levelPointer = `${pointer}/levels/${levelIndex}`;
      if (!isJsonObject(rawLevel)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.StructureInvalid,
            message: "A factor level must be an object.",
            json_pointer: levelPointer
          })
        );
        continue;
      }
      const levelId = readSafeId(
        fieldOf(rawLevel, "id"),
        `${levelPointer}/id`,
        "level id",
        report
      );
      const variant = fieldOf(rawLevel, "contract_variant");
      if (
        variant !== undefined &&
        (typeof variant !== "string" || !isSafeId(variant))
      ) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.StructureInvalid,
            message: "contract_variant must be a safe identifier.",
            json_pointer: `${levelPointer}/contract_variant`
          })
        );
      }
      const patch = fieldOf(rawLevel, "run_profile_patch");
      if (
        patch !== undefined &&
        (!isJsonObject(patch) || Object.keys(patch).length === 0)
      ) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.StructureInvalid,
            message: "run_profile_patch must be a non-empty object.",
            json_pointer: `${levelPointer}/run_profile_patch`
          })
        );
      }
      if (levelId === null) {
        continue;
      }
      levels.push({
        id: levelId,
        ...(typeof variant === "string" ? { contract_variant: variant } : {}),
        ...(isJsonObject(patch)
          ? { run_profile_patch: patch as RunProfilePatch }
          : {})
      });
    }
    if (id === null || levels.length === 0) {
      continue;
    }
    factors.push({
      id,
      role: (role ?? "treatment") as FactorRole,
      levels
    });
  }
  if (factors.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A protocol needs at least one resolvable factor.",
        json_pointer: "#/factors"
      })
    );
    return null;
  }
  return factors;
}

function checkUniqueFactorIds(
  factors: readonly ProtocolFactor[],
  report: (entry: Diagnostic) => void
): void {
  const seen = new Set<string>();
  for (const factor of factors) {
    if (seen.has(factor.id)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.DuplicateId,
          message: `Factor ID ${JSON.stringify(factor.id)} is declared more than once.`,
          json_pointer: "#/factors"
        })
      );
    }
    seen.add(factor.id);
    const levels = new Set<string>();
    for (const level of factor.levels) {
      if (levels.has(level.id)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.DuplicateId,
            message: `Level ID ${JSON.stringify(level.id)} of factor ${JSON.stringify(factor.id)} is declared more than once.`,
            json_pointer: "#/factors"
          })
        );
      }
      levels.add(level.id);
    }
  }
}

function checkContractVariantReferences(
  factors: readonly ProtocolFactor[],
  references: ProtocolReferences | undefined,
  report: (entry: Diagnostic) => void
): Set<string> {
  const used = new Set<string>();
  for (const factor of factors) {
    for (const level of factor.levels) {
      if (level.contract_variant === undefined) {
        continue;
      }
      used.add(level.contract_variant);
      const known = references?.contractVariants;
      if (known !== undefined && !known.has(level.contract_variant)) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.ContractVariantUnknown,
            message: `Contract variant ${JSON.stringify(level.contract_variant)} is not declared by the referenced ContractVariantSet.`,
            json_pointer: "#/factors"
          })
        );
      }
    }
  }
  return used;
}

function checkPatchSurface(
  factors: readonly ProtocolFactor[],
  references: ProtocolReferences | undefined,
  report: (entry: Diagnostic) => void
): void {
  const boundFields = new Map<string, string>();
  const operations = references?.contractOperations;
  for (const factor of factors) {
    for (const level of factor.levels) {
      const patch = level.run_profile_patch;
      if (patch === undefined) {
        continue;
      }
      for (const key of Object.keys(patch)) {
        const rule = RUN_PROFILE_PATCH_FIELDS.get(key);
        if (rule === undefined) {
          report(
            diagnostic({
              severity: "error",
              phase: "preflight",
              code: StudyCode.PatchFieldUnknown,
              message: `Patch field ${JSON.stringify(key)} is outside the run-profile allowlist.`,
              json_pointer: "#/factors"
            })
          );
          continue;
        }
        const value = patch[key] as Json;
        if (!patchValueAllows(rule, value)) {
          report(
            diagnostic({
              severity: "error",
              phase: "preflight",
              code: StudyCode.PatchValueInvalid,
              message: `Patch field ${JSON.stringify(key)} does not accept the given value.`,
              json_pointer: "#/factors"
            })
          );
        }
        const owner = boundFields.get(key);
        if (owner !== undefined && owner !== factor.id) {
          report(
            diagnostic({
              severity: "error",
              phase: "preflight",
              code: StudyCode.PatchFieldBoundTwice,
              message: `Patch field ${JSON.stringify(key)} is bound by factors ${JSON.stringify(owner)} and ${JSON.stringify(factor.id)}; declare one interaction binding instead.`,
              json_pointer: "#/factors"
            })
          );
        } else if (owner === undefined) {
          boundFields.set(key, factor.id);
        }
        if (operations !== undefined) {
          for (const operationKey of collectOperationReferences(value)) {
            if (!operations.has(operationKey)) {
              report(
                diagnostic({
                  severity: "error",
                  phase: "preflight",
                  code: StudyCode.OperationUnknown,
                  message: `Referenced contract operation ${JSON.stringify(operationKey)} does not exist in the contract.`,
                  json_pointer: "#/factors"
                })
              );
            }
          }
        }
      }
      if (canonicalNestedPatch(patch) === null) {
        report(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCode.PatchKeyConflict,
            message: `Patch keys of level ${JSON.stringify(level.id)} nest ambiguously.`,
            json_pointer: "#/factors"
          })
        );
      }
    }
  }
}

function checkUniqueMetricIds(
  metrics: ProtocolMetrics,
  report: (entry: Diagnostic) => void
): void {
  const seen = new Set<string>();
  const all = [...metrics.primary, ...(metrics.secondary ?? [])];
  for (const metric of all) {
    if (seen.has(metric.id)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.DuplicateId,
          message: `Metric ID ${JSON.stringify(metric.id)} is declared more than once.`,
          json_pointer: "#/metrics"
        })
      );
    }
    seen.add(metric.id);
  }
}

function checkPhaseReferences(
  phases: Readonly<Record<string, string>>,
  references: ProtocolReferences | undefined,
  report: (entry: Diagnostic) => void
): void {
  const plans = references?.phasePlans;
  if (plans === undefined) {
    return;
  }
  for (const key of Object.keys(phases)) {
    const plan = plans.get(key);
    if (plan === undefined) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.PhasePlanMissing,
          message: `Phase ${JSON.stringify(key)} has no parsed PhasePlan.`,
          json_pointer: `#/phases/${key}`
        })
      );
      continue;
    }
    if (plan.metadata.id !== key) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.PhasePlanIdMismatch,
          message: `PhasePlan ID ${JSON.stringify(plan.metadata.id)} does not match protocol phase key ${JSON.stringify(key)}.`,
          json_pointer: `#/phases/${key}`
        })
      );
    }
  }
  for (const key of plans.keys()) {
    if (!(key in phases)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.PhasePlanOrphan,
          message: `PhasePlan ${JSON.stringify(key)} is not declared by the protocol.`,
          json_pointer: "#/phases"
        })
      );
    }
  }
}

/** Safe protocol-root paths the lock must cover. */
function checkMemberPaths(
  constants: ProtocolConstants,
  evaluation: ProtocolEvaluation,
  blinding: ProtocolBlinding,
  phases: Readonly<Record<string, string>>,
  report: (entry: Diagnostic) => void
): void {
  const paths = [
    constants.run_profile,
    evaluation.contract_variant_set,
    blinding.participant_surface_policy,
    ...Object.values(phases)
  ];
  for (const path of paths) {
    if (path === undefined) {
      continue;
    }
    if (!isSafeProtocolRootPath(path)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.PhasePathUnsafe,
          message: `Protocol member path ${JSON.stringify(path)} is not a safe protocol-root path.`,
          json_pointer: "#/phases"
        })
      );
    }
  }
}

/** Protocol-root path rule from `protocol-lock.v1.schema.json`. */
export function isSafeProtocolRootPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || path.includes("../") || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".."
  );
}

/** Rebuild the canonical protocol document from the typed model. */
export function protocolJson(protocol: StudyProtocol): Json {
  return {
    apiVersion: protocol.apiVersion,
    kind: protocol.kind,
    metadata: { ...protocol.metadata },
    objective: protocol.objective,
    evaluation: {
      pack: { ...protocol.evaluation.pack },
      eval: protocol.evaluation.eval,
      scenario: protocol.evaluation.scenario,
      ...(protocol.evaluation.contract_variant_set === undefined
        ? {}
        : { contract_variant_set: protocol.evaluation.contract_variant_set })
    },
    factors: protocol.factors.map((factor) => ({
      id: factor.id,
      role: factor.role,
      levels: factor.levels.map((level) => ({
        id: level.id,
        ...(level.contract_variant === undefined
          ? {}
          : { contract_variant: level.contract_variant }),
        ...(level.run_profile_patch === undefined
          ? {}
          : { run_profile_patch: { ...level.run_profile_patch } })
      }))
    })),
    constants: {
      run_profile: protocol.constants.run_profile,
      ...(protocol.constants.required_parallel === undefined
        ? {}
        : { required_parallel: protocol.constants.required_parallel }),
      ...(protocol.constants.data_plane_scope === undefined
        ? {}
        : { data_plane_scope: protocol.constants.data_plane_scope }),
      ...(protocol.constants.response_profile === undefined
        ? {}
        : { response_profile: protocol.constants.response_profile })
    },
    metrics: {
      primary: protocol.metrics.primary.map((metric) => metricJson(metric)),
      ...(protocol.metrics.secondary === undefined
        ? {}
        : {
            secondary: protocol.metrics.secondary.map((metric) =>
              metricJson(metric)
            )
          })
    },
    blinding: {
      mode: protocol.blinding.mode,
      ...(protocol.blinding.participant_surface_policy === undefined
        ? {}
        : {
            participant_surface_policy:
              protocol.blinding.participant_surface_policy
          }),
      ...(protocol.blinding.require_pairwise_surface_diff_review === undefined
        ? {}
        : {
            require_pairwise_surface_diff_review:
              protocol.blinding.require_pairwise_surface_diff_review
          })
    },
    phases: { ...protocol.phases },
    interpretation_limits: [...protocol.interpretation_limits],
    extensions: protocol.extensions
  };
}

function metricJson(metric: ProtocolMetric): Json {
  return {
    id: metric.id,
    type: metric.type,
    ...(metric.missingness === undefined
      ? {}
      : { missingness: metric.missingness }),
    source: { ...metric.source }
  };
}
