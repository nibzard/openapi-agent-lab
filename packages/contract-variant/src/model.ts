/**
 * Typed models for the three contract-variant artifact schemas, plus loaders
 * that validate against those schemas and enforce the semantic rules the
 * schemas cannot express.
 *
 * Every loader is pure: documents arrive as parameters, either as text or as
 * an already parsed JSON value.
 */

import {
  canonicalJson,
  diagnostic,
  isJsonObject,
  parseJsonStrict,
  SchemaValidator,
  sha256Hex,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { parsePackDocument } from "@oal/pack";
import { PATH_METHODS } from "@oal/openapi";

import {
  allowlistsOverlap,
  checkPatchAllowlist,
  parseJsonPointer,
  type JsonPatchOperation
} from "./patch.ts";

/** Stable diagnostic codes produced by the variant loaders. */
export const VariantCode = {
  SchemaInvalid: "OAL-CV-SCHEMA-INVALID",
  NotAnObject: "OAL-CV-NOT-AN-OBJECT",
  DigestMismatch: "OAL-CV-DIGEST-MISMATCH",
  DuplicateVariantId: "OAL-CV-DUPLICATE-VARIANT-ID",
  DuplicateExampleId: "OAL-CV-DUPLICATE-EXAMPLE-ID",
  PointerInvalid: "OAL-CV-POINTER-INVALID",
  AllowlistViolation: "OAL-CV-PATCH-ALLOWLIST",
  LayerOverlap: "OAL-CV-LAYER-OVERLAP",
  StaticAllowlist: "OAL-CV-STATIC-ALLOWLIST",
  OperationUnknown: "OAL-CV-OPERATION-UNKNOWN",
  OperationKeyInvalid: "OAL-CV-OPERATION-KEY-INVALID",
  SurfaceIdInvalid: "OAL-CV-SURFACE-ID-INVALID",
  SurfaceConflict: "OAL-CV-SURFACE-CONFLICT",
  ExecutableContent: "OAL-CV-EXECUTABLE-CONTENT",
  PathInvalid: "OAL-CV-PATH-INVALID"
} as const;

/**
 * `kind` or `kind:name`. The kind is a bare lowercase word; the name may hold
 * colons and spaces, as operation keys do.
 */
export const SURFACE_ID_PATTERN = /^[a-z][a-z0-9_]*(?::.+)?$/;

/** Surface kinds the materializer derives from one effective contract. */
export const SURFACE_KINDS = [
  "api",
  "operation",
  "tool_name",
  "security_scheme",
  "parameter",
  "request_media_type",
  "response_selector",
  "response_media_type",
  "schema"
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface VariantSetBase {
  readonly source: string;
  readonly sha256: string;
}

export interface CommonProjection {
  readonly patch: readonly JsonPatchOperation[];
  readonly allowlist: readonly string[];
  readonly sha256?: string;
}

export interface PatchTransform {
  readonly kind: "patch";
  readonly patch: readonly JsonPatchOperation[];
  readonly sha256?: string;
}

export interface StaticTransform {
  readonly kind: "static";
  readonly source: string;
  readonly sha256: string;
}

export type VariantTransform = PatchTransform | StaticTransform;

export interface BehaviorAdapterSelection {
  readonly operation: string;
  readonly adapter_id: string;
  readonly adapter_sha256: string;
}

export interface DocumentationExampleRef {
  readonly id: string;
  readonly sha256: string;
}

export interface DocumentationSelection {
  readonly fact_ids: readonly string[];
  readonly placement_classes: readonly string[];
  readonly examples: readonly DocumentationExampleRef[];
  readonly facts_sha256?: string;
}

export interface SemanticSchemaRef {
  readonly id: string;
  readonly sha256: string;
}

export interface SemanticSelection {
  readonly action_ids: readonly string[];
  readonly schemas: readonly SemanticSchemaRef[];
}

export interface ContractVariant {
  readonly id: string;
  readonly transform: VariantTransform;
  readonly allowlist: readonly string[];
  readonly expected_operations: readonly string[];
  readonly effective_sha256: string;
  readonly behavior_adapters: readonly BehaviorAdapterSelection[];
  readonly documentation: DocumentationSelection;
  readonly semantic: SemanticSelection;
}

export interface SurfaceExpectations {
  readonly expected_constant: readonly string[];
  readonly expected_variable: readonly string[];
}

/** Typed form of schemas/contract-variant-set.v1.schema.json. */
export interface ContractVariantSet {
  readonly schema_version: 1;
  readonly kind: "ContractVariantSet";
  readonly id: string;
  readonly base: VariantSetBase;
  readonly common_projection: CommonProjection | null;
  readonly variants: readonly ContractVariant[];
  readonly surfaces: SurfaceExpectations;
  readonly extensions: JsonObject;
}

export interface ManifestEffective {
  readonly openapi_sha256: string;
  readonly semantic_sha256: string;
  readonly execution_sha256: string;
  readonly operation_count: number;
}

/** Typed form of schemas/contract-variant-manifest.v1.schema.json. */
export interface ContractVariantManifest {
  readonly schema_version: 1;
  readonly kind: "ContractVariantManifest";
  readonly variant_id: string;
  readonly set_id: string;
  readonly base_sha256: string;
  readonly common_projection_sha256?: string | null;
  readonly transform_sha256: string;
  readonly effective: ManifestEffective;
  readonly capability_report_sha256: string;
  readonly behavior_adapters: readonly BehaviorAdapterSelection[];
  readonly diff_path: string;
  readonly extensions: JsonObject;
}

export interface DiffDifference {
  readonly pointer: string;
  readonly layer: "common-projection" | "variant" | "unrelated";
  readonly op: "add" | "remove" | "replace";
  readonly before?: Json;
  readonly after?: Json;
  readonly allowlisted: boolean;
}

export interface DiffViolation {
  readonly pointer: string;
  readonly reason: string;
}

export interface DiffOperationInventory {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged_count: number;
}

/** Typed form of schemas/contract-variant-diff.v1.schema.json. */
export interface ContractVariantDiff {
  readonly schema_version: 1;
  readonly variant_id: string;
  readonly base_sha256: string;
  readonly effective_sha256: string;
  readonly differences: readonly DiffDifference[];
  readonly violations: readonly DiffViolation[];
  readonly operation_inventory: DiffOperationInventory;
  readonly verified: boolean;
  readonly extensions: JsonObject;
}

// ---- schema validation -------------------------------------------------

/** The three normative schema documents, keyed by artifact name. */
export interface VariantSchemaDocuments {
  readonly set: JsonObject;
  readonly manifest: JsonObject;
  readonly diff: JsonObject;
}

export type VariantSchemaName = keyof VariantSchemaDocuments;

/** Immutable, filesystem-free set of the three variant schema validators. */
export class VariantSchemaSet {
  private readonly documents: ReadonlyMap<VariantSchemaName, JsonObject>;
  private readonly cache = new Map<VariantSchemaName, SchemaValidator>();

  private constructor(documents: ReadonlyMap<VariantSchemaName, JsonObject>) {
    this.documents = documents;
  }

  static fromDocuments(documents: VariantSchemaDocuments): VariantSchemaSet {
    return new VariantSchemaSet(
      new Map<VariantSchemaName, JsonObject>([
        ["set", documents.set],
        ["manifest", documents.manifest],
        ["diff", documents.diff]
      ])
    );
  }

  document(name: VariantSchemaName): JsonObject {
    return this.documents.get(name) as JsonObject;
  }

  validator(name: VariantSchemaName): SchemaValidator {
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const created = new SchemaValidator(this.document(name));
    this.cache.set(name, created);
    return created;
  }
}

export type LoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function failure(diagnostics: readonly Diagnostic[]): {
  ok: false;
  diagnostics: readonly Diagnostic[];
} {
  return { ok: false, diagnostics };
}

function error(code: string, message: string, pointer: string): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "compile",
    code,
    message,
    json_pointer: pointer
  });
}

/** Strictly parse artifact text. */
export function parseArtifactText(text: string): LoadResult<Json> {
  try {
    return { ok: true, value: parseJsonStrict(text, { maxNodes: 200_000 }) };
  } catch (cause) {
    return failure([
      error(
        VariantCode.SchemaInvalid,
        `The artifact is not valid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "#"
      )
    ]);
  }
}

function schemaDiagnostics(
  schemas: VariantSchemaSet,
  name: VariantSchemaName,
  value: Json,
  pointer: string
): readonly Diagnostic[] {
  const violations = schemas.validator(name).errors(value);
  if (violations.length === 0) {
    return [];
  }
  const schemaId = schemas.document(name).$id;
  const label = typeof schemaId === "string" ? schemaId : name;
  return [
    error(
      VariantCode.SchemaInvalid,
      `The ${name} document violates ${label}: ${violations
        .map((violation) => `${violation.code} at ${violation.pointer}`)
        .join("; ")}`,
      pointer
    )
  ];
}

// ---- pack registry snapshot -------------------------------------------

/** One immutable Pack-owned behavior adapter. */
export interface PackAdapterEntry {
  readonly adapter_id: string;
  readonly adapter_sha256: string;
  /** Capability the adapter declares for the operations it serves. */
  readonly capability: string;
  readonly operations: readonly string[];
}

/** One immutable Pack-owned semantic action or schema. */
export interface PackSemanticEntry {
  readonly id: string;
  readonly sha256: string;
  readonly kind: "action" | "schema";
}

/** Pack-owned participant-neutral documentation inventory. */
export interface PackDocumentationRegistry {
  readonly facts: readonly DocumentationExampleRef[];
  readonly placement_classes: readonly string[];
  readonly examples: readonly DocumentationExampleRef[];
}

/** The frozen Pack registry a variant set selects over. */
export interface PackRegistrySnapshot {
  readonly pack_id: string;
  readonly pack_version: string;
  readonly pack_sha256: string;
  readonly adapters: readonly PackAdapterEntry[];
  readonly semantic: readonly PackSemanticEntry[];
  readonly documentation: PackDocumentationRegistry;
}

export const EMPTY_PACK_DOCUMENTATION: PackDocumentationRegistry = {
  facts: [],
  placement_classes: [],
  examples: []
};

/**
 * Semantic entries derived from a pack's `events/registry.json` document. The
 * registry is the only Pack-owned semantic inventory with a stable schema, so
 * action IDs are event names and schema digests are payload schema digests.
 */
export function packSemanticEntriesFromEventRegistry(
  registry: JsonObject | null
): readonly PackSemanticEntry[] {
  if (registry === null) {
    return [];
  }
  const events = Array.isArray(registry.events) ? registry.events : [];
  const out: PackSemanticEntry[] = [];
  for (const event of events) {
    if (!isJsonObject(event)) {
      continue;
    }
    const name = typeof event.name === "string" ? event.name : null;
    const sha =
      typeof event.payload_schema_sha256 === "string"
        ? event.payload_schema_sha256
        : null;
    if (name === null || sha === null) {
      continue;
    }
    out.push({ id: name, sha256: sha, kind: "action" });
    out.push({ id: name, sha256: sha, kind: "schema" });
  }
  return out;
}

/**
 * Parse pack registry text with the pack document parser, which accepts the
 * JSON and YAML forms a pack may use.
 */
export function parsePackRegistryText(
  text: string,
  source: string
): LoadResult<JsonObject | null> {
  const parsed = parsePackDocument(text, source);
  if (parsed.diagnostic !== null) {
    return failure([
      error(
        VariantCode.SchemaInvalid,
        `${source} is not a readable pack document: ${parsed.diagnostic.message}`,
        "#"
      )
    ]);
  }
  return { ok: true, value: isJsonObject(parsed.value) ? parsed.value : null };
}

function adapterFromJson(value: Json): PackAdapterEntry | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = typeof value.adapter_id === "string" ? value.adapter_id : null;
  const sha =
    typeof value.adapter_sha256 === "string" ? value.adapter_sha256 : null;
  const capability =
    typeof value.capability === "string" ? value.capability : null;
  const operations = Array.isArray(value.operations)
    ? value.operations.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : null;
  if (
    id === null ||
    sha === null ||
    capability === null ||
    operations === null
  ) {
    return null;
  }
  return {
    adapter_id: id,
    adapter_sha256: sha,
    capability,
    operations
  };
}

function refFromJson(value: Json): DocumentationExampleRef | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : null;
  const sha = typeof value.sha256 === "string" ? value.sha256 : null;
  if (id === null || sha === null) {
    return null;
  }
  return { id, sha256: sha };
}

function refsFromJson(
  value: Json | undefined
): readonly DocumentationExampleRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(refFromJson)
    .filter((entry): entry is DocumentationExampleRef => entry !== null);
}

/**
 * Assemble a Pack registry snapshot. Adapters and documentation arrive as
 * Pack-published control-plane data because pack manifest version 1 has no
 * field for a per-operation adapter table.
 */
export function packRegistrySnapshot(input: {
  readonly packId: string;
  readonly packVersion: string;
  readonly packSha256: string;
  readonly semanticEventRegistry?: JsonObject | null;
  readonly adapters?: readonly Json[];
  readonly documentation?: JsonObject | null;
}): PackRegistrySnapshot {
  const adapters = (input.adapters ?? [])
    .map(adapterFromJson)
    .filter((entry): entry is PackAdapterEntry => entry !== null);
  const documentation = input.documentation ?? null;
  const placement = documentation?.placement_classes;
  return {
    pack_id: input.packId,
    pack_version: input.packVersion,
    pack_sha256: input.packSha256,
    adapters,
    semantic: packSemanticEntriesFromEventRegistry(
      input.semanticEventRegistry ?? null
    ),
    documentation: {
      facts: refsFromJson(documentation?.facts),
      placement_classes: Array.isArray(placement)
        ? placement.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [],
      examples: refsFromJson(documentation?.examples)
    }
  };
}

// ---- executable content -----------------------------------------------

interface Marker {
  readonly pattern: RegExp;
  readonly label: string;
}

/** Markers that indicate executable or dynamically loaded content. */
export const EXECUTABLE_MARKERS: readonly Marker[] = [
  { pattern: /^\s*#!\//, label: "shebang" },
  { pattern: /\brequire\s*\(/, label: "CommonJS require call" },
  { pattern: /\beval\s*\(/, label: "eval call" },
  { pattern: /\bnew\s+Function\s*\(/, label: "dynamic Function constructor" },
  { pattern: /\bimportScripts\s*\(/, label: "importScripts call" },
  { pattern: /\bWebAssembly\b/, label: "WebAssembly reference" },
  { pattern: /\bchild_process\b/, label: "child_process reference" },
  { pattern: /\bnode:[a-z_]/, label: "Node built-in module path" },
  { pattern: /\bmodule\.exports\b/, label: "module export" },
  { pattern: /^javascript:/i, label: "javascript URI scheme" },
  { pattern: /data:text\/javascript/i, label: "inline script data URI" },
  {
    pattern: /(?:^|[/\s"'`])[\w.-]+\.(?:js|mjs|cjs|wasm|wat)\b/,
    label: "module or WASM file path"
  }
];

/**
 * Scan every key and string value of a control-plane document for executable
 * content. SPEC section 12.12 forbids JavaScript, WASM, commands, inline
 * handler source, dynamic module paths, and evaluator code in a set.
 */
export function scanForExecutableContent(
  value: Json,
  pointer: string
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  walkStrings(value, pointer, (text, at) => {
    for (const marker of EXECUTABLE_MARKERS) {
      if (marker.pattern.test(text)) {
        diagnostics.push(
          error(
            VariantCode.ExecutableContent,
            `The set contains executable content (${marker.label}), which SPEC section 12.12 forbids.`,
            at
          )
        );
        return;
      }
    }
  });
  return diagnostics;
}

function walkStrings(
  value: Json,
  pointer: string,
  visit: (text: string, pointer: string) => void
): void {
  if (typeof value === "string") {
    visit(value, pointer);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkStrings(entry, `${pointer}/${index}`, visit);
    });
    return;
  }
  if (isJsonObject(value)) {
    for (const key of Object.keys(value).sort()) {
      visit(key, `${pointer}/${escape(key)}`);
      walkStrings(value[key] as Json, `${pointer}/${escape(key)}`, visit);
    }
  }
}

function escape(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ---- coercion ----------------------------------------------------------

function asText(value: Json | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStrings(value: Json | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asOperations(value: Json | undefined): readonly JsonPatchOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map((entry) => ({
    op: asText(entry.op, "") as JsonPatchOperation["op"],
    path: asText(entry.path, ""),
    ...(entry.from === undefined ? {} : { from: asText(entry.from, "") }),
    ...(entry.value === undefined ? {} : { value: entry.value })
  }));
}

function asRefs(value: Json | undefined): readonly DocumentationExampleRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map((entry) => ({
    id: asText(entry.id, ""),
    sha256: asText(entry.sha256, "")
  }));
}

function coerceSet(value: JsonObject): ContractVariantSet {
  const common = isJsonObject(value.common_projection)
    ? value.common_projection
    : null;
  const variants = Array.isArray(value.variants) ? value.variants : [];
  return {
    schema_version: 1,
    kind: "ContractVariantSet",
    id: asText(value.id, ""),
    base: {
      source: asText(
        isJsonObject(value.base) ? value.base.source : undefined,
        ""
      ),
      sha256: asText(
        isJsonObject(value.base) ? value.base.sha256 : undefined,
        ""
      )
    },
    common_projection:
      common === null
        ? null
        : {
            patch: asOperations(common.patch),
            allowlist: asStrings(common.allowlist),
            ...(common.sha256 === undefined
              ? {}
              : { sha256: asText(common.sha256, "") })
          },
    variants: variants.filter(isJsonObject).map((entry): ContractVariant => {
      const transform = isJsonObject(entry.transform) ? entry.transform : {};
      const isStatic = asText(transform.kind, "") === "static";
      return {
        id: asText(entry.id, ""),
        transform: isStatic
          ? {
              kind: "static",
              source: asText(transform.source, ""),
              sha256: asText(transform.sha256, "")
            }
          : {
              kind: "patch",
              patch: asOperations(transform.patch),
              ...(transform.sha256 === undefined
                ? {}
                : { sha256: asText(transform.sha256, "") })
            },
        allowlist: asStrings(entry.allowlist),
        expected_operations: asStrings(entry.expected_operations),
        effective_sha256: asText(entry.effective_sha256, ""),
        behavior_adapters: (Array.isArray(entry.behavior_adapters)
          ? entry.behavior_adapters
          : []
        )
          .filter(isJsonObject)
          .map((adapter) => ({
            operation: asText(adapter.operation, ""),
            adapter_id: asText(adapter.adapter_id, ""),
            adapter_sha256: asText(adapter.adapter_sha256, "")
          })),
        documentation: {
          fact_ids: asStrings(
            isJsonObject(entry.documentation)
              ? entry.documentation.fact_ids
              : undefined
          ),
          placement_classes: asStrings(
            isJsonObject(entry.documentation)
              ? entry.documentation.placement_classes
              : undefined
          ),
          examples: asRefs(
            isJsonObject(entry.documentation)
              ? entry.documentation.examples
              : undefined
          ),
          ...(isJsonObject(entry.documentation) &&
          entry.documentation.facts_sha256 !== undefined
            ? {
                facts_sha256: asText(entry.documentation.facts_sha256, "")
              }
            : {})
        },
        semantic: {
          action_ids: asStrings(
            isJsonObject(entry.semantic) ? entry.semantic.action_ids : undefined
          ),
          schemas: asRefs(
            isJsonObject(entry.semantic) ? entry.semantic.schemas : undefined
          )
        }
      };
    }),
    surfaces: {
      expected_constant: asStrings(
        isJsonObject(value.surfaces)
          ? value.surfaces.expected_constant
          : undefined
      ),
      expected_variable: asStrings(
        isJsonObject(value.surfaces)
          ? value.surfaces.expected_variable
          : undefined
      )
    },
    extensions: isJsonObject(value.extensions) ? value.extensions : {}
  };
}

/** Digest basis of a patch transform. */
export function patchTransformSha256(
  patch: readonly JsonPatchOperation[]
): string {
  return sha256Hex(canonicalJson(patch as unknown as Json));
}

function coerceManifest(value: JsonObject): ContractVariantManifest {
  const effective = isJsonObject(value.effective) ? value.effective : {};
  return {
    schema_version: 1,
    kind: "ContractVariantManifest",
    variant_id: asText(value.variant_id, ""),
    set_id: asText(value.set_id, ""),
    base_sha256: asText(value.base_sha256, ""),
    ...(value.common_projection_sha256 === undefined
      ? {}
      : {
          common_projection_sha256:
            value.common_projection_sha256 === null
              ? null
              : asText(value.common_projection_sha256, "")
        }),
    transform_sha256: asText(value.transform_sha256, ""),
    effective: {
      openapi_sha256: asText(effective.openapi_sha256, ""),
      semantic_sha256: asText(effective.semantic_sha256, ""),
      execution_sha256: asText(effective.execution_sha256, ""),
      operation_count:
        typeof effective.operation_count === "number"
          ? effective.operation_count
          : 0
    },
    capability_report_sha256: asText(value.capability_report_sha256, ""),
    behavior_adapters: (Array.isArray(value.behavior_adapters)
      ? value.behavior_adapters
      : []
    )
      .filter(isJsonObject)
      .map((adapter) => ({
        operation: asText(adapter.operation, ""),
        adapter_id: asText(adapter.adapter_id, ""),
        adapter_sha256: asText(adapter.adapter_sha256, "")
      })),
    diff_path: asText(value.diff_path, ""),
    extensions: isJsonObject(value.extensions) ? value.extensions : {}
  };
}

function coerceDiff(value: JsonObject): ContractVariantDiff {
  const inventory = isJsonObject(value.operation_inventory)
    ? value.operation_inventory
    : {};
  return {
    schema_version: 1,
    variant_id: asText(value.variant_id, ""),
    base_sha256: asText(value.base_sha256, ""),
    effective_sha256: asText(value.effective_sha256, ""),
    differences: (Array.isArray(value.differences) ? value.differences : [])
      .filter(isJsonObject)
      .map((entry) => ({
        pointer: asText(entry.pointer, ""),
        layer: asText(entry.layer, "unrelated") as DiffDifference["layer"],
        op: asText(entry.op, "replace") as DiffDifference["op"],
        ...(entry.before === undefined ? {} : { before: entry.before }),
        ...(entry.after === undefined ? {} : { after: entry.after }),
        allowlisted: entry.allowlisted === true
      })),
    violations: (Array.isArray(value.violations) ? value.violations : [])
      .filter(isJsonObject)
      .map((entry) => ({
        pointer: asText(entry.pointer, ""),
        reason: asText(entry.reason, "")
      })),
    operation_inventory: {
      added: asStrings(inventory.added),
      removed: asStrings(inventory.removed),
      unchanged_count:
        typeof inventory.unchanged_count === "number"
          ? inventory.unchanged_count
          : 0
    },
    verified: value.verified === true,
    extensions: isJsonObject(value.extensions) ? value.extensions : {}
  };
}

// ---- loaders -----------------------------------------------------------

function toObject(value: Json): LoadResult<JsonObject> {
  if (isJsonObject(value)) {
    return { ok: true, value };
  }
  return failure([
    error(VariantCode.NotAnObject, "The artifact must be a JSON object.", "#")
  ]);
}

function parseInput(value: Json | string): LoadResult<Json> {
  return typeof value === "string"
    ? parseArtifactText(value)
    : { ok: true, value };
}

/**
 * Load and validate one ContractVariantSet: schema validation first, then the
 * semantic checks the schema cannot express.
 */
export function loadContractVariantSet(
  value: Json | string,
  schemas: VariantSchemaSet
): LoadResult<ContractVariantSet> {
  const parsed = parseInput(value);
  if (!parsed.ok) {
    return failure(parsed.diagnostics);
  }
  const object = toObject(parsed.value);
  if (!object.ok) {
    return failure(object.diagnostics);
  }
  const invalid = schemaDiagnostics(schemas, "set", parsed.value, "#");
  if (invalid.length > 0) {
    return failure(invalid);
  }
  const set = coerceSet(object.value);
  const semantic = checkContractVariantSetSemantics(set);
  if (semantic.length > 0) {
    return failure(semantic);
  }
  return { ok: true, value: set };
}

/** Load and validate one ContractVariantManifest. */
export function loadContractVariantManifest(
  value: Json | string,
  schemas: VariantSchemaSet
): LoadResult<ContractVariantManifest> {
  const parsed = parseInput(value);
  if (!parsed.ok) {
    return failure(parsed.diagnostics);
  }
  const object = toObject(parsed.value);
  if (!object.ok) {
    return failure(object.diagnostics);
  }
  const invalid = schemaDiagnostics(schemas, "manifest", parsed.value, "#");
  if (invalid.length > 0) {
    return failure(invalid);
  }
  const manifest = coerceManifest(object.value);
  const semantic = checkManifestSemantics(manifest);
  if (semantic.length > 0) {
    return failure(semantic);
  }
  return { ok: true, value: manifest };
}

/** Load and validate one ContractVariantDiff. */
export function loadContractVariantDiff(
  value: Json | string,
  schemas: VariantSchemaSet
): LoadResult<ContractVariantDiff> {
  const parsed = parseInput(value);
  if (!parsed.ok) {
    return failure(parsed.diagnostics);
  }
  const object = toObject(parsed.value);
  if (!object.ok) {
    return failure(object.diagnostics);
  }
  const invalid = schemaDiagnostics(schemas, "diff", parsed.value, "#");
  if (invalid.length > 0) {
    return failure(invalid);
  }
  const diff = coerceDiff(object.value);
  const semantic = checkDiffSemantics(diff);
  if (semantic.length > 0) {
    return failure(semantic);
  }
  return { ok: true, value: diff };
}

// ---- semantic checks ---------------------------------------------------

function checkManifestSemantics(
  manifest: ContractVariantManifest
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (manifest.diff_path.includes("..") || manifest.diff_path.startsWith("/")) {
    diagnostics.push(
      error(
        VariantCode.PathInvalid,
        "diff_path must be a relative path inside the artifact root.",
        "/diff_path"
      )
    );
  }
  return diagnostics;
}

function checkDiffSemantics(diff: ContractVariantDiff): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const difference of diff.differences) {
    if (parseJsonPointer(difference.pointer) === null) {
      diagnostics.push(
        error(
          VariantCode.PointerInvalid,
          "A difference pointer is not valid RFC 6901.",
          difference.pointer
        )
      );
    }
    if (difference.layer === "unrelated" && difference.allowlisted) {
      diagnostics.push(
        error(
          VariantCode.SurfaceConflict,
          "An unrelated difference cannot be marked allowlisted.",
          difference.pointer
        )
      );
    }
  }
  if (diff.verified && diff.violations.length > 0) {
    diagnostics.push(
      error(
        VariantCode.SurfaceConflict,
        "A verified diff cannot carry violations.",
        "/verified"
      )
    );
  }
  return diagnostics;
}

/**
 * Semantic checks a JSON Schema cannot express: digest agreement, unique
 * identifiers, pointer validity, layer disjointness, operation coverage
 * shapes, surface entry shape, and the absence of executable content.
 */
export function checkContractVariantSetSemantics(
  set: ContractVariantSet
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Immutable base bytes pinned by digest.
  if (sha256Hex(set.base.source) !== set.base.sha256) {
    diagnostics.push(
      error(
        VariantCode.DigestMismatch,
        "The base source digest does not match the base source bytes.",
        "/base/sha256"
      )
    );
  }

  // Unique variant identifiers.
  const seen = new Set<string>();
  set.variants.forEach((variant, index) => {
    if (seen.has(variant.id)) {
      diagnostics.push(
        error(
          VariantCode.DuplicateVariantId,
          `Variant id '${variant.id}' is declared more than once.`,
          `/variants/${index}/id`
        )
      );
    }
    seen.add(variant.id);
  });

  // Common projection: pointer validity, allowlist coverage, digest.
  const commonAllowlist =
    set.common_projection === null ? null : set.common_projection.allowlist;
  if (set.common_projection !== null) {
    diagnostics.push(
      ...checkAllowlist(set.common_projection.allowlist, "/common_projection"),
      ...remap(
        checkPatchAllowlist(
          set.common_projection.patch,
          set.common_projection.allowlist,
          "common projection"
        ),
        "/common_projection/patch"
      )
    );
    if (
      set.common_projection.sha256 !== undefined &&
      set.common_projection.sha256 !==
        patchTransformSha256(set.common_projection.patch)
    ) {
      diagnostics.push(
        error(
          VariantCode.DigestMismatch,
          "The declared common projection digest does not match its patch.",
          "/common_projection/sha256"
        )
      );
    }
  }

  set.variants.forEach((variant, index) => {
    const at = `/variants/${index}`;
    diagnostics.push(...checkAllowlist(variant.allowlist, `${at}/allowlist`));

    // Layer disjointness keeps attribution unambiguous.
    if (
      commonAllowlist !== null &&
      allowlistsOverlap(commonAllowlist, variant.allowlist)
    ) {
      diagnostics.push(
        error(
          VariantCode.LayerOverlap,
          `The allowlist of variant '${variant.id}' overlaps the common projection allowlist, so layer attribution would be ambiguous.`,
          `${at}/allowlist`
        )
      );
    }

    if (variant.transform.kind === "patch") {
      diagnostics.push(
        ...remap(
          checkPatchAllowlist(
            variant.transform.patch,
            variant.allowlist,
            "variant"
          ),
          `${at}/transform/patch`
        )
      );
      if (
        variant.transform.sha256 !== undefined &&
        variant.transform.sha256 !==
          patchTransformSha256(variant.transform.patch)
      ) {
        diagnostics.push(
          error(
            VariantCode.DigestMismatch,
            `The declared transform digest of variant '${variant.id}' does not match its patch.`,
            `${at}/transform/sha256`
          )
        );
      }
    } else {
      const digest = sha256Hex(variant.transform.source);
      if (digest !== variant.transform.sha256) {
        diagnostics.push(
          error(
            VariantCode.DigestMismatch,
            `The declared static source digest of variant '${variant.id}' does not match its bytes.`,
            `${at}/transform/sha256`
          )
        );
      }
      if (variant.effective_sha256 !== digest) {
        diagnostics.push(
          error(
            VariantCode.DigestMismatch,
            `The declared effective digest of the static variant '${variant.id}' must equal its static source digest.`,
            `${at}/effective_sha256`
          )
        );
      }
      if (!variant.allowlist.includes("")) {
        diagnostics.push(
          error(
            VariantCode.StaticAllowlist,
            `A static variant declares its whole effective document, so the allowlist of '${variant.id}' must contain the root pointer "".`,
            `${at}/allowlist`
          )
        );
      }
    }

    // The declared inventory must name operations the compiler can produce.
    variant.expected_operations.forEach((key, keyIndex) => {
      const method = (
        key.slice("path:".length).split(" ", 1)[0] ?? ""
      ).toLowerCase();
      if (!PATH_METHODS.includes(method)) {
        diagnostics.push(
          error(
            VariantCode.OperationKeyInvalid,
            `The operation key '${key}' of variant '${variant.id}' does not name a supported method.`,
            `${at}/expected_operations/${keyIndex}`
          )
        );
      }
    });

    // Adapter selections must serve declared operations.
    const expected = new Set(variant.expected_operations);
    variant.behavior_adapters.forEach((adapter, adapterIndex) => {
      if (!expected.has(adapter.operation)) {
        diagnostics.push(
          error(
            VariantCode.OperationUnknown,
            `Variant '${variant.id}' selects an adapter for ${adapter.operation}, which the expected operation inventory does not declare.`,
            `${at}/behavior_adapters/${adapterIndex}/operation`
          )
        );
      }
    });

    // Documentation examples must be unique inside one variant.
    const exampleIds = new Set<string>();
    variant.documentation.examples.forEach((example, exampleIndex) => {
      if (exampleIds.has(example.id)) {
        diagnostics.push(
          error(
            VariantCode.DuplicateExampleId,
            `Variant '${variant.id}' declares example '${example.id}' more than once.`,
            `${at}/documentation/examples/${exampleIndex}/id`
          )
        );
      }
      exampleIds.add(example.id);
    });
    if (
      variant.documentation.facts_sha256 !== undefined &&
      variant.documentation.facts_sha256 !==
        documentationFactsSha256(variant.documentation)
    ) {
      diagnostics.push(
        error(
          VariantCode.DigestMismatch,
          `The declared documentation digest of variant '${variant.id}' does not match its fact and placement inventory.`,
          `${at}/documentation/facts_sha256`
        )
      );
    }
  });

  // Surface expectations.
  for (const entry of set.surfaces.expected_constant) {
    if (!SURFACE_ID_PATTERN.test(entry)) {
      diagnostics.push(
        error(
          VariantCode.SurfaceIdInvalid,
          `The expected_constant entry '${entry}' is not a surface id of the form kind or kind:name.`,
          "/surfaces/expected_constant"
        )
      );
    }
  }
  for (const entry of set.surfaces.expected_variable) {
    if (!SURFACE_ID_PATTERN.test(entry)) {
      diagnostics.push(
        error(
          VariantCode.SurfaceIdInvalid,
          `The expected_variable entry '${entry}' is not a surface id of the form kind or kind:name.`,
          "/surfaces/expected_variable"
        )
      );
    }
  }
  if (
    set.surfaces.expected_constant.some((constant) =>
      set.surfaces.expected_variable.some((variable) =>
        surfaceEntryMatches(variable, constant)
      )
    )
  ) {
    diagnostics.push(
      error(
        VariantCode.SurfaceConflict,
        "A surface cannot be both expected constant and expected variable.",
        "/surfaces"
      )
    );
  }

  // No executable content anywhere in the control-plane document.
  diagnostics.push(...scanForExecutableContent(set as unknown as Json, "#"));

  return diagnostics;
}

function checkAllowlist(
  allowlist: readonly string[],
  pointer: string
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  allowlist.forEach((entry, index) => {
    if (parseJsonPointer(entry) === null) {
      diagnostics.push(
        error(
          VariantCode.PointerInvalid,
          `The allowlist entry '${entry}' is not a valid RFC 6901 pointer.`,
          `${pointer}/${index}`
        )
      );
    }
  });
  return diagnostics;
}

function remap(
  issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly index?: number;
  }[],
  prefix: string
): readonly Diagnostic[] {
  return issues.map((entry) =>
    error(entry.code, entry.message, `${prefix}/${entry.index ?? 0}`)
  );
}

/** Digest over the participant-neutral fact and placement inventory. */
export function documentationFactsSha256(
  documentation: DocumentationSelection
): string {
  return sha256Hex(
    canonicalJson({
      fact_ids: [...documentation.fact_ids].sort(),
      placement_classes: [...documentation.placement_classes].sort()
    })
  );
}

/** True when a surface expectation entry covers one concrete surface id. */
export function surfaceEntryMatches(entry: string, surfaceId: string): boolean {
  if (!entry.includes(":")) {
    return surfaceId.startsWith(`${entry}:`) || surfaceId === entry;
  }
  return entry === surfaceId;
}
