/**
 * StudyIR compiler (specification sections 12.8 and 12.13).
 *
 * Compilation is a pure function of the validated protocol and the member
 * bytes: the same inputs always produce byte-identical canonical IR. The
 * compiler rewrites authored dotted patch keys into canonical nested
 * objects, resolves the cell inventory in canonical order, and freezes a
 * digest for every referenced study-owned member.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  sha256Hex,
  validateSchemaInstance,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { ContractIR } from "@oal/contract-ir";

import { StudyCode } from "./codes.ts";
import {
  canonicalNestedPatch,
  collectOperationReferences,
  protocolJson,
  resolveCellInventory,
  type FactorRole,
  type MissingnessPolicy,
  type MetricSource,
  type MetricType,
  type PackRef,
  type ProtocolMetric,
  type StudyProtocol
} from "./protocol.ts";

export const STUDY_IR_SCHEMA_VERSION = 1;
export const STUDY_IR_KIND = "StudyIR";

/** Level in canonical form: nested patch object, no dotted keys. */
export interface IrFactorLevel {
  readonly id: string;
  readonly contract_variant?: string | undefined;
  readonly run_profile_patch?: JsonObject | undefined;
}

export interface IrFactor {
  readonly id: string;
  readonly role: FactorRole;
  readonly levels: readonly IrFactorLevel[];
}

export interface IrCell {
  readonly cell_id: string;
  readonly factor_levels: Readonly<Record<string, string>>;
  readonly explicit: boolean;
  readonly why_absent: string | null;
}

export interface IrEvaluation {
  readonly pack: PackRef;
  readonly eval: string;
  readonly scenario: string;
  readonly contract_variant_set?: string | undefined;
  readonly contract_variant_set_sha256?: string | undefined;
}

export interface IrConstants {
  readonly run_profile: string;
  readonly run_profile_sha256?: string | undefined;
  readonly required_parallel?: number | undefined;
  readonly data_plane_scope?: "all" | "task" | undefined;
  readonly response_profile?: string | undefined;
}

export interface IrMetrics {
  readonly primary: readonly ProtocolMetric[];
  readonly secondary?: readonly ProtocolMetric[] | undefined;
}

export interface IrBlinding {
  readonly mode: "none" | "declared" | "strict";
  readonly participant_surface_policy?: string | undefined;
  readonly participant_surface_policy_sha256?: string | undefined;
  readonly require_pairwise_surface_diff_review?: boolean | undefined;
}

/** Typed StudyIR. Serialized form validates against `study-ir.v1.schema.json`. */
export interface StudyIR {
  readonly schema_version: typeof STUDY_IR_SCHEMA_VERSION;
  readonly kind: typeof STUDY_IR_KIND;
  readonly protocol: {
    readonly id: string;
    readonly version: string;
    readonly source_sha256: string;
  };
  readonly evaluation: IrEvaluation;
  readonly factors: readonly IrFactor[];
  readonly cells: readonly IrCell[];
  readonly constants: IrConstants;
  readonly metrics: IrMetrics;
  readonly blinding: IrBlinding;
  readonly phases: Readonly<Record<string, string>>;
  readonly extensions: JsonObject;
}

export interface StudyCompileOptions {
  /** Draft 2020-12 `study-ir.v1` schema for the self-check. */
  readonly schema?: Json | undefined;
  /**
   * Study-owned member bytes by protocol-root path. Every member the
   * protocol names must be present so its digest can be frozen.
   */
  readonly members?: ReadonlyMap<string, string> | undefined;
  /** Contract behind the pack. Used to verify operation references. */
  readonly contract?: ContractIR | undefined;
  readonly documentUri?: string | undefined;
}

export interface StudyCompileResult {
  readonly ir: StudyIR | null;
  readonly diagnostics: Diagnostic[];
}

/** Order strings by Unicode code point. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** SHA-256 over member text bytes. */
export function memberDigest(text: string): string {
  return sha256Hex(text);
}

/** Digest of the canonical protocol document bytes. */
export function protocolSourceDigest(protocol: StudyProtocol): string {
  return canonicalJsonSha256(protocolJson(protocol));
}

/** Every protocol-root member path the protocol names. */
export function declaredMemberPaths(protocol: StudyProtocol): string[] {
  const paths = [protocol.constants.run_profile];
  if (protocol.evaluation.contract_variant_set !== undefined) {
    paths.push(protocol.evaluation.contract_variant_set);
  }
  if (protocol.blinding.participant_surface_policy !== undefined) {
    paths.push(protocol.blinding.participant_surface_policy);
  }
  for (const phasePath of Object.values(protocol.phases)) {
    paths.push(phasePath);
  }
  return paths;
}

/** Metric in IR form: identical shape, preserved order. */
function irMetric(metric: ProtocolMetric): ProtocolMetric {
  return {
    id: metric.id,
    type: metric.type,
    ...(metric.missingness === undefined
      ? {}
      : { missingness: metric.missingness }),
    source: metric.source
  };
}

/** Compile a validated protocol into canonical StudyIR. */
export async function compileStudy(
  protocol: StudyProtocol,
  options: StudyCompileOptions = {}
): Promise<StudyCompileResult> {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;
  const members = options.members ?? new Map<string, string>();

  const frozen = freezeMembers(protocol, members, uri, report);
  if (options.contract !== undefined) {
    checkContractOperations(protocol, options.contract, report);
  }

  const factors: IrFactor[] = compileFactors(protocol);
  const inventory = resolveCellInventory(
    protocol.factors,
    undefined,
    undefined,
    uri
  );
  for (const entry of inventory.diagnostics) {
    report(entry);
  }

  const ir: StudyIR = {
    schema_version: STUDY_IR_SCHEMA_VERSION,
    kind: STUDY_IR_KIND,
    protocol: {
      id: protocol.metadata.id,
      version: protocol.metadata.version,
      source_sha256: protocolSourceDigest(protocol)
    },
    evaluation: {
      pack: protocol.evaluation.pack,
      eval: protocol.evaluation.eval,
      scenario: protocol.evaluation.scenario,
      ...(protocol.evaluation.contract_variant_set === undefined
        ? {}
        : { contract_variant_set: protocol.evaluation.contract_variant_set }),
      ...(frozen.contractVariantSet === undefined
        ? {}
        : {
            contract_variant_set_sha256: frozen.contractVariantSet
          })
    },
    factors,
    cells: inventory.cells,
    constants: {
      run_profile: protocol.constants.run_profile,
      ...(frozen.runProfile === undefined
        ? {}
        : { run_profile_sha256: frozen.runProfile }),
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
      primary: protocol.metrics.primary.map(irMetric),
      ...(protocol.metrics.secondary === undefined
        ? {}
        : {
            secondary: protocol.metrics.secondary.map(irMetric)
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
      ...(frozen.participantSurfacePolicy === undefined
        ? {}
        : {
            participant_surface_policy_sha256: frozen.participantSurfacePolicy
          }),
      ...(protocol.blinding.require_pairwise_surface_diff_review === undefined
        ? {}
        : {
            require_pairwise_surface_diff_review:
              protocol.blinding.require_pairwise_surface_diff_review
          })
    },
    phases: { ...protocol.phases },
    extensions: protocol.extensions
  };

  if (options.schema !== undefined) {
    // Study documents are untrusted: their schema evaluation runs inside
    // the bounded schema-worker boundary.
    const violations = await validateSchemaInstance(
      options.schema,
      studyIrJson(ir)
    );
    for (const violation of violations) {
      report(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: StudyCode.SchemaInvalid,
          message: `Compiled StudyIR violates its schema: ${violation.code}: ${violation.message}`,
          document_uri: uri,
          json_pointer:
            violation.pointer.length === 0
              ? "#/"
              : `#/${violation.pointer.slice(1)}`
        })
      );
    }
  }

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { ir: null, diagnostics };
  }
  return { ir, diagnostics };
}

interface FrozenMemberDigests {
  readonly runProfile?: string | undefined;
  readonly participantSurfacePolicy?: string | undefined;
  readonly contractVariantSet?: string | undefined;
}

function freezeMembers(
  protocol: StudyProtocol,
  members: ReadonlyMap<string, string>,
  uri: string | null,
  report: (entry: Diagnostic) => void
): FrozenMemberDigests {
  const result: {
    runProfile?: string;
    participantSurfacePolicy?: string;
    contractVariantSet?: string;
  } = {};
  /** Members whose digest the IR schema can store, with its pointer. */
  const digested = new Map<
    string,
    {
      role: "run" | "policy" | "variantSet";
      pointer: string;
    }
  >();
  digested.set(protocol.constants.run_profile, {
    role: "run",
    pointer: "#/constants/run_profile"
  });
  if (protocol.evaluation.contract_variant_set !== undefined) {
    digested.set(protocol.evaluation.contract_variant_set, {
      role: "variantSet",
      pointer: "#/evaluation/contract_variant_set"
    });
  }
  if (protocol.blinding.participant_surface_policy !== undefined) {
    digested.set(protocol.blinding.participant_surface_policy, {
      role: "policy",
      pointer: "#/blinding/participant_surface_policy"
    });
  }
  for (const path of declaredMemberPaths(protocol)) {
    const text = members.get(path);
    if (text === undefined) {
      const known = digested.get(path);
      report(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: StudyCode.MemberMissing,
          message: `Member ${JSON.stringify(path)} is named by the protocol but no bytes were supplied.`,
          document_uri: uri,
          json_pointer: known === undefined ? "#/phases" : known.pointer
        })
      );
      continue;
    }
    const entry = digested.get(path);
    if (entry === undefined) {
      continue;
    }
    const digest = memberDigest(text);
    if (entry.role === "run") {
      result.runProfile = digest;
    } else if (entry.role === "policy") {
      result.participantSurfacePolicy = digest;
    } else {
      result.contractVariantSet = digest;
    }
  }
  return result;
}

function checkContractOperations(
  protocol: StudyProtocol,
  contract: ContractIR,
  report: (entry: Diagnostic) => void
): void {
  const known = new Set(contract.operations.map((op) => op.key));
  for (const factor of protocol.factors) {
    for (const level of factor.levels) {
      const patch = level.run_profile_patch;
      if (patch === undefined) {
        continue;
      }
      for (const key of Object.keys(patch)) {
        for (const operationKey of collectOperationReferences(
          patch[key] as Json
        )) {
          if (!known.has(operationKey)) {
            report(
              diagnostic({
                severity: "error",
                phase: "compile",
                code: StudyCode.OperationUnknown,
                message: `Referenced contract operation ${JSON.stringify(operationKey)} does not exist in the contract.`,
                json_pointer: "#/factors"
              })
            );
          }
        }
      }
    }
  }
}

function compileFactors(protocol: StudyProtocol): IrFactor[] {
  const ordered = [...protocol.factors].sort((a, b) => byCodePoint(a.id, b.id));
  return ordered.map((factor) => ({
    id: factor.id,
    role: factor.role,
    levels: [...factor.levels]
      .sort((a, b) => byCodePoint(a.id, b.id))
      .map((level) => {
        const patch =
          level.run_profile_patch === undefined
            ? undefined
            : canonicalNestedPatch(level.run_profile_patch);
        return {
          id: level.id,
          ...(level.contract_variant === undefined
            ? {}
            : { contract_variant: level.contract_variant }),
          ...(patch === null || patch === undefined
            ? {}
            : { run_profile_patch: patch })
        };
      })
  }));
}

/** Serialize the IR to canonical JSON bytes. */
export function serializeStudyIr(ir: StudyIR): string {
  return canonicalJson(studyIrJson(ir));
}

/** SHA-256 over the canonical IR bytes. */
export function studyIrSha256(ir: StudyIR): string {
  return sha256Hex(serializeStudyIr(ir));
}

/** JSON view of the IR for validation and serialization. */
export function studyIrJson(ir: StudyIR): Json {
  return {
    schema_version: ir.schema_version,
    kind: ir.kind,
    protocol: { ...ir.protocol },
    evaluation: {
      pack: { ...ir.evaluation.pack },
      eval: ir.evaluation.eval,
      scenario: ir.evaluation.scenario,
      ...(ir.evaluation.contract_variant_set === undefined
        ? {}
        : { contract_variant_set: ir.evaluation.contract_variant_set }),
      ...(ir.evaluation.contract_variant_set_sha256 === undefined
        ? {}
        : {
            contract_variant_set_sha256:
              ir.evaluation.contract_variant_set_sha256
          })
    },
    factors: ir.factors.map((factor) => ({
      id: factor.id,
      role: factor.role,
      levels: factor.levels.map((level) => ({
        id: level.id,
        ...(level.contract_variant === undefined
          ? {}
          : { contract_variant: level.contract_variant }),
        ...(level.run_profile_patch === undefined
          ? {}
          : { run_profile_patch: level.run_profile_patch })
      }))
    })),
    cells: ir.cells.map((cell) => ({
      cell_id: cell.cell_id,
      factor_levels: { ...cell.factor_levels },
      explicit: cell.explicit,
      why_absent: cell.why_absent
    })),
    constants: {
      run_profile: ir.constants.run_profile,
      ...(ir.constants.run_profile_sha256 === undefined
        ? {}
        : { run_profile_sha256: ir.constants.run_profile_sha256 }),
      ...(ir.constants.required_parallel === undefined
        ? {}
        : { required_parallel: ir.constants.required_parallel }),
      ...(ir.constants.data_plane_scope === undefined
        ? {}
        : { data_plane_scope: ir.constants.data_plane_scope }),
      ...(ir.constants.response_profile === undefined
        ? {}
        : { response_profile: ir.constants.response_profile })
    },
    metrics: {
      primary: ir.metrics.primary.map((metric) => metricJson(metric)),
      ...(ir.metrics.secondary === undefined
        ? {}
        : {
            secondary: ir.metrics.secondary.map((metric) => metricJson(metric))
          })
    },
    blinding: {
      mode: ir.blinding.mode,
      ...(ir.blinding.participant_surface_policy === undefined
        ? {}
        : {
            participant_surface_policy: ir.blinding.participant_surface_policy
          }),
      ...(ir.blinding.participant_surface_policy_sha256 === undefined
        ? {}
        : {
            participant_surface_policy_sha256:
              ir.blinding.participant_surface_policy_sha256
          }),
      ...(ir.blinding.require_pairwise_surface_diff_review === undefined
        ? {}
        : {
            require_pairwise_surface_diff_review:
              ir.blinding.require_pairwise_surface_diff_review
          })
    },
    phases: { ...ir.phases },
    extensions: ir.extensions as Json
  };
}

function metricJson(metric: {
  id: string;
  type: MetricType;
  missingness?: MissingnessPolicy | undefined;
  source: MetricSource;
}): Json {
  return {
    id: metric.id,
    type: metric.type,
    ...(metric.missingness === undefined
      ? {}
      : { missingness: metric.missingness }),
    source: { ...metric.source }
  };
}
