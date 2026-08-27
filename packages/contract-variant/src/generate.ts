/**
 * Materialization of one counterfactual ContractVariant: parse fresh base
 * bytes, apply the common projection and then the variant transformation,
 * serialize deterministically, recompile through the ordinary compiler, and
 * run every verification of SPEC section 12.12 that applies.
 *
 * All functions are pure. Source bytes, pack registries, and waivers arrive
 * as parameters; nothing reads the clock, the filesystem, or the network.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isJsonObject,
  OalError,
  sha256Hex,
  type Diagnostic,
  type Json
} from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";
import {
  capabilityReportJson,
  compileOpenApi,
  type CompileOptions
} from "@oal/openapi";

import { parsePackDocument } from "@oal/pack";

import { buildContractVariantDiff, operationKeysOfDocument } from "./diff.ts";
import {
  documentationFactsSha256,
  patchTransformSha256,
  surfaceEntryMatches,
  VariantCode,
  type ContractVariant,
  type ContractVariantDiff,
  type ContractVariantManifest,
  type ContractVariantSet,
  type PackAdapterEntry,
  type PackRegistrySnapshot,
  type SurfaceKind
} from "./model.ts";
import { applyJsonPatch, checkPatchAllowlist } from "./patch.ts";

/** Stable diagnostic codes produced by materialization. */
export const GenerateCode = {
  VariantUnknown: "OAL-CV-VARIANT-UNKNOWN",
  SourceUnparseable: "OAL-CV-SOURCE-UNPARSEABLE",
  PatchRejected: "OAL-CV-PATCH-REJECTED",
  EffectiveDigestMismatch: "OAL-CV-EFFECTIVE-DIGEST-MISMATCH",
  BaseBytesChanged: "OAL-CV-BASE-BYTES-CHANGED",
  OperationInventoryMismatch: "OAL-CV-OPERATION-INVENTORY-MISMATCH",
  AdapterUnresolved: "OAL-CV-ADAPTER-UNRESOLVED",
  AdapterDigestMismatch: "OAL-CV-ADAPTER-DIGEST-MISMATCH",
  AdapterCapabilityMismatch: "OAL-CV-ADAPTER-CAPABILITY-MISMATCH",
  SemanticUnresolved: "OAL-CV-SEMANTIC-UNRESOLVED",
  DocumentationUnresolved: "OAL-CV-DOCUMENTATION-UNRESOLVED",
  DriftDetected: "OAL-CV-DRIFT",
  LeakDetected: "OAL-CV-LEAK",
  CompileFailed: "OAL-CV-COMPILE-FAILED",
  UnwaivedDiagnostic: "OAL-CV-UNWAIVED-DIAGNOSTIC",
  SurfaceDrift: "OAL-CV-SURFACE-DRIFT",
  SurfaceMissing: "OAL-CV-SURFACE-MISSING",
  DocumentationNotParallel: "OAL-CV-DOCUMENTATION-NOT-PARALLEL"
} as const;

/**
 * Labels that must not appear in participant contract bytes: the protocol,
 * phase, factor, level, assignment, experiment, mock, and internal maturity
 * vocabulary of SPEC section 12.12 item 6.
 */
export const DEFAULT_LEAK_LABELS: readonly string[] = [
  "protocol",
  "phase",
  "factor",
  "level",
  "assignment",
  "experiment",
  "mock",
  "internal"
];

export interface MaterializeOptions {
  /** Diagnostic codes waived for the lint gate. Default: none. */
  readonly waivedDiagnosticCodes?: readonly string[];
  /** Entrypoint name handed to the compiler. Default: "effective.json". */
  readonly entrypoint?: string;
  /** Options forwarded to the OpenAPI compiler. */
  readonly compileOptions?: CompileOptions;
  /** Labels scanned in addition to the default set. */
  readonly extraLeakLabels?: readonly string[];
  /** Full replacement label set for the leak scan. */
  readonly leakLabels?: readonly string[];
}

/** One label found in participant contract bytes. */
export interface LeakFinding {
  readonly label: string;
  readonly index: number;
  readonly excerpt: string;
}

/** One participant-observable surface of an effective contract. */
export interface ParticipantSurface {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly sha256: string;
}

export interface MaterializeSuccess {
  readonly variant: ContractVariant;
  readonly effectiveText: string;
  readonly effectiveDocument: Json;
  readonly contract: ContractIR;
  readonly diff: ContractVariantDiff;
  readonly manifest: ContractVariantManifest;
  readonly surfaces: readonly ParticipantSurface[];
}

export type MaterializeResult =
  | { readonly ok: true; readonly value: MaterializeSuccess }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export type MaterializeSetResult =
  | { readonly ok: true; readonly value: readonly MaterializeSuccess[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function failure(diagnostics: readonly Diagnostic[]): {
  ok: false;
  diagnostics: readonly Diagnostic[];
} {
  return { ok: false, diagnostics };
}

function error(
  code: string,
  message: string,
  pointer: string | null = null,
  details: Json = {}
): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "preflight",
    code,
    message,
    ...(pointer === null ? {} : { json_pointer: pointer }),
    details
  });
}

/**
 * Lexically scan participant contract bytes for the labels of section 12.12
 * item 6. Word boundaries and case folding keep the scan lexical: a hit is a
 * finding, never a silent pass.
 */
export function scanForLeakedLabels(
  text: string,
  labels: readonly string[] = DEFAULT_LEAK_LABELS
): readonly LeakFinding[] {
  const findings: LeakFinding[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const pattern = new RegExp(`\\b${escapeRegExp(label)}\\b`, "gi");
    let matches = 0;
    for (const match of text.matchAll(pattern)) {
      if (matches >= 50) {
        break;
      }
      matches += 1;
      const index = match.index;
      const key = `${label}@${index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        label,
        index,
        excerpt: text.slice(Math.max(0, index - 24), index + label.length + 24)
      });
    }
  }
  return findings.sort((left, right) =>
    left.index === right.index
      ? left.label < right.label
        ? -1
        : 1
      : left.index - right.index
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive the participant surfaces of one compiled contract. Every surface id
 * is `kind:name` and every digest is taken over the canonical JSON of the
 * surface value, so two variants can be compared without sharing bytes.
 */
export function participantSurfacesOf(
  contract: ContractIR
): readonly ParticipantSurface[] {
  const surfaces: ParticipantSurface[] = [];
  surfaces.push({
    id: "api:title",
    kind: "api",
    name: "title",
    sha256: sha256Hex(contract.api.title ?? "")
  });
  surfaces.push({
    id: "api:version",
    kind: "api",
    name: "version",
    sha256: sha256Hex(contract.api.version ?? "")
  });
  for (const name of Object.keys(contract.security_schemes).sort()) {
    surfaces.push({
      id: `security_scheme:${name}`,
      kind: "security_scheme",
      name,
      sha256: canonicalJsonSha256(
        contract.security_schemes[name] as unknown as Json
      )
    });
  }
  for (const uid of Object.keys(contract.schemas).sort()) {
    surfaces.push({
      id: `schema:${uid}`,
      kind: "schema",
      name: uid,
      sha256: canonicalJsonSha256(contract.schemas[uid] as unknown as Json)
    });
  }
  const operations: readonly OperationIR[] = [
    ...contract.operations,
    ...contract.webhooks.flatMap((hook) => hook.operations)
  ];
  for (const operation of operations) {
    surfaces.push({
      id: `operation:${operation.key}`,
      kind: "operation",
      name: operation.key,
      sha256: canonicalJsonSha256(operation as unknown as Json)
    });
    surfaces.push({
      id: `tool_name:${operation.tool_name}`,
      kind: "tool_name",
      name: operation.tool_name,
      sha256: sha256Hex(operation.tool_name)
    });
    for (const parameter of operation.parameters) {
      const name = `${operation.key}|${parameter.location}:${parameter.name}`;
      surfaces.push({
        id: `parameter:${name}`,
        kind: "parameter",
        name,
        sha256: canonicalJsonSha256(parameter as unknown as Json)
      });
    }
    for (const media of operation.request_body?.content ?? []) {
      const name = `${operation.key}|${media.media_type}`;
      surfaces.push({
        id: `request_media_type:${name}`,
        kind: "request_media_type",
        name,
        sha256: canonicalJsonSha256(media as unknown as Json)
      });
    }
    for (const response of operation.responses) {
      surfaces.push({
        id: `response_selector:${operation.key}|${response.selector}`,
        kind: "response_selector",
        name: `${operation.key}|${response.selector}`,
        sha256: canonicalJsonSha256(response as unknown as Json)
      });
      for (const media of response.content) {
        const name = `${operation.key}|${response.selector}|${media.media_type}`;
        surfaces.push({
          id: `response_media_type:${name}`,
          kind: "response_media_type",
          name,
          sha256: canonicalJsonSha256(media as unknown as Json)
        });
      }
    }
  }
  return surfaces.sort((left, right) =>
    left.id === right.id ? 0 : left.id < right.id ? -1 : 1
  );
}

/** Digest basis of a variant transform: its patch, or its static source. */
export function transformSha256(variant: ContractVariant): string {
  return variant.transform.kind === "static"
    ? sha256Hex(variant.transform.source)
    : patchTransformSha256(variant.transform.patch);
}

/**
 * Materialize one variant of a set and run every per-variant verification of
 * section 12.12. Cross-variant verification runs in
 * {@link materializeContractVariantSet}.
 */
export function materializeVariant(
  set: ContractVariantSet,
  variantId: string,
  pack: PackRegistrySnapshot,
  options: MaterializeOptions = {}
): MaterializeResult {
  const variant = set.variants.find((entry) => entry.id === variantId);
  if (variant === undefined) {
    return failure([
      error(
        GenerateCode.VariantUnknown,
        `The set '${set.id}' declares no variant '${variantId}'.`,
        "/variants"
      )
    ]);
  }

  // Verification 1: the base bytes are pinned by digest before any work and
  // re-checked after materialization.
  const baseSha256 = sha256Hex(set.base.source);
  if (baseSha256 !== set.base.sha256) {
    return failure([
      error(
        GenerateCode.BaseBytesChanged,
        "The base source bytes do not match the digest the set pins.",
        "/base/sha256"
      )
    ]);
  }

  // Fresh parse of the base bytes for every materialization.
  const baseDocument = parseDocument(set.base.source, "base source");
  if (baseDocument === null) {
    return failure([
      error(
        GenerateCode.SourceUnparseable,
        "The base source bytes are neither JSON nor YAML.",
        "/base/source"
      )
    ]);
  }

  const diagnostics: Diagnostic[] = [];

  // Common projection first.
  let working: Json = baseDocument;
  const commonAllowlist =
    set.common_projection === null ? null : set.common_projection.allowlist;
  if (set.common_projection !== null) {
    const issues = checkPatchAllowlist(
      set.common_projection.patch,
      set.common_projection.allowlist,
      "common projection"
    );
    if (issues.length > 0) {
      diagnostics.push(
        ...issues.map((issue) => patchDiagnostic(issue.message))
      );
    } else {
      const applied = applyJsonPatch(working, set.common_projection.patch);
      if (applied.ok) {
        working = applied.document;
      } else {
        diagnostics.push(
          ...applied.issues.map((issue) => patchDiagnostic(issue.message))
        );
      }
    }
  }

  // Then the variant transformation.
  if (variant.transform.kind === "patch") {
    const issues = checkPatchAllowlist(
      variant.transform.patch,
      variant.allowlist,
      "variant"
    );
    if (issues.length > 0) {
      diagnostics.push(
        ...issues.map((issue) => patchDiagnostic(issue.message))
      );
    } else {
      const applied = applyJsonPatch(working, variant.transform.patch);
      if (applied.ok) {
        working = applied.document;
      } else {
        diagnostics.push(
          ...applied.issues.map((issue) => patchDiagnostic(issue.message))
        );
      }
    }
  } else {
    const staticDocument = parseDocument(
      variant.transform.source,
      "static source"
    );
    if (staticDocument === null) {
      diagnostics.push(
        error(
          GenerateCode.SourceUnparseable,
          `The static source of variant '${variant.id}' is neither JSON nor YAML.`,
          "/transform/source"
        )
      );
    } else {
      working = staticDocument;
    }
  }
  if (diagnostics.length > 0) {
    return failure(diagnostics);
  }

  // Deterministic serialization.
  const effectiveText = canonicalJson(working);

  // Verification 1, second half: the base bytes are unchanged.
  if (sha256Hex(set.base.source) !== baseSha256) {
    return failure([
      error(
        GenerateCode.BaseBytesChanged,
        "Materialization altered the base source bytes.",
        "/base/source"
      )
    ]);
  }

  // The declared effective digest must pin the produced bytes.
  const effectiveSha256 = sha256Hex(effectiveText);
  if (effectiveSha256 !== variant.effective_sha256) {
    diagnostics.push(
      error(
        GenerateCode.EffectiveDigestMismatch,
        `The materialized bytes of variant '${variant.id}' do not match its declared effective digest.`,
        "/effective_sha256",
        { declared: variant.effective_sha256, produced: effectiveSha256 }
      )
    );
  }

  // Verification 2 and 4: every structural difference is allowlisted at the
  // correct layer, so unrelated paths, components, response shapes, and
  // authentication stay identical as declared.
  const diff = buildContractVariantDiff({
    variant,
    baseSha256: set.base.sha256,
    effectiveSha256,
    base: baseDocument,
    effective: working,
    commonAllowlist
  });
  for (const violation of diff.violations) {
    diagnostics.push(
      error(GenerateCode.DriftDetected, violation.reason, violation.pointer)
    );
  }

  // The declared operation inventory must match the effective document.
  const produced = operationKeysOfDocument(working);
  const expected = [...variant.expected_operations].sort();
  if (JSON.stringify(produced) !== JSON.stringify(expected)) {
    diagnostics.push(
      error(
        GenerateCode.OperationInventoryMismatch,
        `The effective operation inventory of variant '${variant.id}' does not match the declared inventory.`,
        "/expected_operations",
        { declared: expected, produced: [...produced] }
      )
    );
  }

  // Recompile through the ordinary compiler.
  const entrypoint = options.entrypoint ?? "effective.json";
  const compile = compileEffective(effectiveText, entrypoint, options);
  if (!compile.ok) {
    diagnostics.push(...compile.diagnostics);
    return failure(diagnostics);
  }
  const { contract, report } = compile.value;

  // Verification 7: zero unwaived diagnostics.
  const waived = new Set(options.waivedDiagnosticCodes ?? []);
  const unwaived = contract.diagnostics.filter(
    (entry) => !waived.has(entry.code)
  );
  if (unwaived.length > 0) {
    diagnostics.push(
      error(
        GenerateCode.UnwaivedDiagnostic,
        `The effective contract of variant '${variant.id}' produced ${unwaived.length} unwaived compiler diagnostics.`,
        null,
        {
          codes: unwaived.map((entry) => entry.code).sort()
        }
      )
    );
  }

  // Verification 6: no study label leaks into participant contract bytes.
  const labels = options.leakLabels ?? [
    ...DEFAULT_LEAK_LABELS,
    ...(options.extraLeakLabels ?? [])
  ];
  const leaks = scanForLeakedLabels(effectiveText, labels);
  for (const leak of leaks) {
    diagnostics.push(
      error(
        GenerateCode.LeakDetected,
        `Participant contract bytes contain the label '${leak.label}': ...${leak.excerpt}...`,
        null,
        { label: leak.label, index: leak.index }
      )
    );
  }

  // Verification 3: every source and effective operation resolves exactly one
  // Pack-owned adapter with the declared capability.
  const capabilityByKey = new Map(
    report.operations.map((entry) => [entry.key, entry.level])
  );
  for (const key of new Set([
    ...produced,
    ...operationKeysOfDocument(baseDocument)
  ])) {
    const selection = variant.behavior_adapters.filter(
      (adapter) => adapter.operation === key
    );
    if (selection.length !== 1) {
      diagnostics.push(
        error(
          GenerateCode.AdapterUnresolved,
          `Operation ${key} of variant '${variant.id}' selects ${selection.length} adapters; exactly one is required.`,
          "/behavior_adapters",
          { operation: key, selections: selection.length }
        )
      );
      continue;
    }
    const chosen = selection[0] as ContractVariant["behavior_adapters"][number];
    const candidates = pack.adapters.filter(
      (adapter) => adapter.adapter_id === chosen.adapter_id
    );
    if (candidates.length !== 1) {
      diagnostics.push(
        error(
          GenerateCode.AdapterUnresolved,
          `Adapter '${chosen.adapter_id}' does not resolve to exactly one entry of pack '${pack.pack_id}'.`,
          "/behavior_adapters",
          { adapter_id: chosen.adapter_id, pack_id: pack.pack_id }
        )
      );
      continue;
    }
    const resolved = candidates[0] as PackAdapterEntry;
    if (resolved.adapter_sha256 !== chosen.adapter_sha256) {
      diagnostics.push(
        error(
          GenerateCode.AdapterDigestMismatch,
          `Adapter '${chosen.adapter_id}' of pack '${pack.pack_id}' has digest ${resolved.adapter_sha256}, but the set declares ${chosen.adapter_sha256}.`,
          "/behavior_adapters",
          { adapter_id: chosen.adapter_id }
        )
      );
      continue;
    }
    if (!resolved.operations.includes(key)) {
      diagnostics.push(
        error(
          GenerateCode.AdapterUnresolved,
          `Adapter '${chosen.adapter_id}' of pack '${pack.pack_id}' does not serve ${key}.`,
          "/behavior_adapters",
          { adapter_id: chosen.adapter_id, operation: key }
        )
      );
      continue;
    }
    const capability = capabilityByKey.get(key);
    if (
      produced.includes(key) &&
      capability !== undefined &&
      capability !== resolved.capability
    ) {
      diagnostics.push(
        error(
          GenerateCode.AdapterCapabilityMismatch,
          `Operation ${key} compiles at capability '${capability}' but adapter '${chosen.adapter_id}' declares '${resolved.capability}'.`,
          "/behavior_adapters",
          { operation: key, adapter_id: chosen.adapter_id }
        )
      );
    }
  }

  // Semantic coverage against the Pack registry.
  const actions = new Set(
    pack.semantic
      .filter((entry) => entry.kind === "action")
      .map((entry) => entry.id)
  );
  for (const actionId of variant.semantic.action_ids) {
    if (!actions.has(actionId)) {
      diagnostics.push(
        error(
          GenerateCode.SemanticUnresolved,
          `Semantic action '${actionId}' does not resolve in pack '${pack.pack_id}'.`,
          "/semantic/action_ids",
          { action_id: actionId }
        )
      );
    }
  }
  const schemaById = new Map(
    pack.semantic
      .filter((entry) => entry.kind === "schema")
      .map((entry) => [entry.id, entry.sha256])
  );
  for (const schema of variant.semantic.schemas) {
    const resolved = schemaById.get(schema.id);
    if (resolved === undefined) {
      diagnostics.push(
        error(
          GenerateCode.SemanticUnresolved,
          `Semantic schema '${schema.id}' does not resolve in pack '${pack.pack_id}'.`,
          "/semantic/schemas",
          { id: schema.id }
        )
      );
      continue;
    }
    if (resolved !== schema.sha256) {
      diagnostics.push(
        error(
          GenerateCode.SemanticUnresolved,
          `Semantic schema '${schema.id}' has digest ${resolved} in pack '${pack.pack_id}', but the set declares ${schema.sha256}.`,
          "/semantic/schemas",
          { id: schema.id }
        )
      );
    }
  }

  // Verification 5, per variant: documentation resolves in the Pack registry.
  const factById = new Map(
    pack.documentation.facts.map((fact) => [fact.id, fact.sha256])
  );
  for (const factId of variant.documentation.fact_ids) {
    if (!factById.has(factId)) {
      diagnostics.push(
        error(
          GenerateCode.DocumentationUnresolved,
          `Documentation fact '${factId}' does not resolve in pack '${pack.pack_id}'.`,
          "/documentation/fact_ids",
          { fact_id: factId }
        )
      );
    }
  }
  for (const placement of variant.documentation.placement_classes) {
    if (!pack.documentation.placement_classes.includes(placement)) {
      diagnostics.push(
        error(
          GenerateCode.DocumentationUnresolved,
          `Placement class '${placement}' does not resolve in pack '${pack.pack_id}'.`,
          "/documentation/placement_classes",
          { placement_class: placement }
        )
      );
    }
  }
  const exampleById = new Map(
    pack.documentation.examples.map((example) => [example.id, example.sha256])
  );
  for (const example of variant.documentation.examples) {
    const resolved = exampleById.get(example.id);
    if (resolved === undefined) {
      diagnostics.push(
        error(
          GenerateCode.DocumentationUnresolved,
          `Documentation example '${example.id}' does not resolve in pack '${pack.pack_id}'.`,
          "/documentation/examples",
          { id: example.id }
        )
      );
      continue;
    }
    if (resolved !== example.sha256) {
      diagnostics.push(
        error(
          GenerateCode.DocumentationUnresolved,
          `Documentation example '${example.id}' has digest ${resolved} in pack '${pack.pack_id}', but the set declares ${example.sha256}.`,
          "/documentation/examples",
          { id: example.id }
        )
      );
    }
  }
  if (
    variant.documentation.facts_sha256 !== undefined &&
    variant.documentation.facts_sha256 !==
      documentationFactsSha256(variant.documentation)
  ) {
    diagnostics.push(
      error(
        VariantCode.DigestMismatch,
        `The declared documentation digest of variant '${variant.id}' does not match its inventory.`,
        "/documentation/facts_sha256"
      )
    );
  }

  if (diagnostics.length > 0) {
    return failure(diagnostics);
  }

  const manifest: ContractVariantManifest = {
    schema_version: 1,
    kind: "ContractVariantManifest",
    variant_id: variant.id,
    set_id: set.id,
    base_sha256: set.base.sha256,
    common_projection_sha256:
      set.common_projection === null
        ? null
        : patchTransformSha256(set.common_projection.patch),
    transform_sha256: transformSha256(variant),
    effective: {
      openapi_sha256: effectiveSha256,
      semantic_sha256: contract.source.semantic_sha256,
      execution_sha256: contract.source.execution_sha256,
      operation_count: contract.operations.length
    },
    capability_report_sha256: sha256Hex(capabilityReportJson(report)),
    behavior_adapters: variant.behavior_adapters,
    diff_path: `variants/${variant.id}/contract-variant-diff.json`,
    extensions: {}
  };

  return {
    ok: true,
    value: {
      variant,
      effectiveText,
      effectiveDocument: working,
      contract,
      diff,
      manifest,
      surfaces: participantSurfacesOf(contract)
    }
  };
}

function patchDiagnostic(message: string): Diagnostic {
  return error(GenerateCode.PatchRejected, message, null);
}

/** Parse OpenAPI source text, accepting the JSON and YAML forms a pack uses. */
function parseDocument(text: string, what: string): Json | null {
  return parsePackDocument(text, what).value;
}

function compileEffective(
  effectiveText: string,
  entrypoint: string,
  options: MaterializeOptions
):
  | {
      readonly ok: true;
      readonly value: {
        readonly contract: ContractIR;
        readonly report: ReturnType<typeof compileOpenApi>["report"];
      };
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } {
  try {
    const compiled = compileOpenApi(
      {
        documents: new Map<string, string>([[entrypoint, effectiveText]]),
        entrypoint
      },
      options.compileOptions ?? {}
    );
    return { ok: true, value: compiled };
  } catch (cause) {
    if (cause instanceof OalError) {
      const carried = isJsonObject(cause.details)
        ? (cause.details.diagnostics as Json)
        : null;
      const codes = Array.isArray(carried)
        ? carried.filter(isDiagnosticLike).map((entry) => entry.code)
        : [];
      return {
        ok: false,
        diagnostics: [
          error(
            GenerateCode.CompileFailed,
            `The effective contract does not compile: ${cause.message}`,
            null,
            { codes: [...codes] }
          )
        ]
      };
    }
    return {
      ok: false,
      diagnostics: [
        error(
          GenerateCode.CompileFailed,
          `The effective contract does not compile: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          null
        )
      ]
    };
  }
}

function isDiagnosticLike(value: Json): value is Json & { code: string } {
  return isJsonObject(value) && typeof value.code === "string";
}

/**
 * Materialize every variant of a set and run the cross-variant verifications:
 * participant surfaces stay constant or vary exactly as declared, and the
 * documentation inventory stays parallel across variants.
 */
export function materializeContractVariantSet(
  set: ContractVariantSet,
  pack: PackRegistrySnapshot,
  options: MaterializeOptions = {}
): MaterializeSetResult {
  const materialized: MaterializeSuccess[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const variant of set.variants) {
    const result = materializeVariant(set, variant.id, pack, options);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      continue;
    }
    materialized.push(result.value);
  }
  if (diagnostics.length > 0) {
    return failure(diagnostics);
  }

  // Verification 5: documentation facts and placement classes are parallel.
  const reference = set.variants[0];
  if (reference !== undefined) {
    for (const variant of set.variants.slice(1)) {
      if (
        JSON.stringify([...variant.documentation.fact_ids].sort()) !==
        JSON.stringify([...reference.documentation.fact_ids].sort())
      ) {
        diagnostics.push(
          error(
            GenerateCode.DocumentationNotParallel,
            `Variant '${variant.id}' declares different documentation fact ids than variant '${reference.id}'.`,
            "/documentation/fact_ids",
            { variant_id: variant.id, reference_id: reference.id }
          )
        );
      }
      if (
        JSON.stringify([...variant.documentation.placement_classes].sort()) !==
        JSON.stringify([...reference.documentation.placement_classes].sort())
      ) {
        diagnostics.push(
          error(
            GenerateCode.DocumentationNotParallel,
            `Variant '${variant.id}' declares different placement classes than variant '${reference.id}'.`,
            "/documentation/placement_classes",
            { variant_id: variant.id, reference_id: reference.id }
          )
        );
      }
      const exampleIds = (entry: ContractVariant): readonly string[] =>
        entry.documentation.examples.map((example) => example.id).sort();
      if (
        JSON.stringify(exampleIds(variant)) !==
        JSON.stringify(exampleIds(reference))
      ) {
        diagnostics.push(
          error(
            GenerateCode.DocumentationNotParallel,
            `Variant '${variant.id}' declares different documentation example ids than variant '${reference.id}'.`,
            "/documentation/examples",
            { variant_id: variant.id, reference_id: reference.id }
          )
        );
      }
    }
  }

  // Verification 4 across variants: constant surfaces stay identical and only
  // declared surfaces vary.
  const digestsById = new Map<string, Map<string, string>>();
  for (const entry of materialized) {
    for (const surface of entry.surfaces) {
      const perVariant =
        digestsById.get(surface.id) ?? new Map<string, string>();
      perVariant.set(entry.variant.id, surface.sha256);
      digestsById.set(surface.id, perVariant);
    }
  }
  for (const [surfaceId, perVariant] of digestsById) {
    // A parallel surface exists in every variant with one digest.
    const parallel =
      perVariant.size === materialized.length &&
      new Set(perVariant.values()).size === 1;
    const declaredConstant = set.surfaces.expected_constant.some((entry) =>
      surfaceEntryMatches(entry, surfaceId)
    );
    const declaredVariable = set.surfaces.expected_variable.some((entry) =>
      surfaceEntryMatches(entry, surfaceId)
    );
    if (declaredConstant && !parallel) {
      diagnostics.push(
        error(
          GenerateCode.SurfaceDrift,
          `Surface '${surfaceId}' is declared constant but is absent from a variant or differs across variants.`,
          "/surfaces/expected_constant",
          { surface: surfaceId }
        )
      );
      continue;
    }
    if (!parallel && !declaredVariable) {
      diagnostics.push(
        error(
          GenerateCode.SurfaceDrift,
          `Surface '${surfaceId}' is not parallel across variants and is not declared in expected_variable.`,
          "/surfaces/expected_variable",
          { surface: surfaceId }
        )
      );
    }
  }
  for (const entry of [
    ...set.surfaces.expected_constant,
    ...set.surfaces.expected_variable
  ]) {
    const covered = [...digestsById.keys()].some((surfaceId) =>
      surfaceEntryMatches(entry, surfaceId)
    );
    if (!covered) {
      diagnostics.push(
        error(
          GenerateCode.SurfaceMissing,
          `The declared surface '${entry}' is absent from every materialized variant.`,
          "/surfaces",
          { surface: entry }
        )
      );
    }
  }

  if (diagnostics.length > 0) {
    return failure(diagnostics);
  }
  return { ok: true, value: materialized };
}
