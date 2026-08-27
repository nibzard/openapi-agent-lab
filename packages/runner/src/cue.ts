/**
 * Strict cue policy engine (specification section 9.6). A study declares a
 * ParticipantSurfacePolicy with case-insensitive forbidden literals and
 * patterns, exceptions pinned to one surface entry and factor level,
 * treatment-owned names, neutral profiles, and pairwise allowlists. Scanning
 * runs over rendered participant bytes, never over source templates alone.
 * The output is the private cue audit; the audit, the policy, and factor
 * metadata never reach a participant.
 */

import {
  canonicalJsonSha256,
  diagnostic,
  invalidInput,
  isJsonObject,
  isSha256Hex,
  sha256Hex,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { ProtocolBlinding } from "@oal/study-ir";

import type { SurfaceChannel, SurfaceProvenanceClass } from "./surface.ts";

/** Stable error and diagnostic codes of the cue module. */
export const CueCode = {
  PolicyInvalid: "OAL-RUN-CUE-POLICY-INVALID",
  PatternInvalid: "OAL-RUN-CUE-PATTERN-INVALID",
  ManifestInvalid: "OAL-RUN-CUE-MANIFEST-INVALID",
  CellIdUnsafe: "OAL-RUN-CUE-CELL-ID-UNSAFE",
  CellIdMismatch: "OAL-RUN-CUE-CELL-ID-MISMATCH",
  EntryUnknown: "OAL-RUN-CUE-ENTRY-UNKNOWN",
  PrivateArtifactVisible: "OAL-RUN-CUE-PRIVATE-ARTIFACT-VISIBLE",
  IsolationAdvisory: "OAL-RUN-CUE-ISOLATION-ADVISORY"
} as const;

/** One forbidden literal rule of the policy. */
export interface ForbiddenLiteralRule {
  readonly literal: string;
  readonly case_insensitive: boolean;
}

/**
 * One allowed exception. The exception excuses one forbidden literal in one
 * surface entry, and only when the cell holds the named factor level.
 */
export interface SurfacePolicyException {
  readonly surface_entry: string;
  /** Factor level the exception is pinned to, or null for any level. */
  readonly factor_level: string | null;
  readonly literal: string;
  readonly reason: string | null;
}

/** Names a factor owns and may vary between cells. */
export interface SurfacePolicyTreatmentOwned {
  readonly paths: readonly string[];
  readonly routes: readonly string[];
  readonly fields: readonly string[];
  readonly catalogs: readonly string[];
}

/** Neutral profiles every cell must use outside treatment-owned names. */
export interface SurfacePolicyNeutralProfiles {
  readonly response_profile: string;
  readonly credential_profile: string;
  readonly server_profile: string;
}

/** Expected surface differences one cell pair declares. */
export interface SurfacePolicyPairwiseAllowlist {
  readonly cell_a: string;
  readonly cell_b: string;
  readonly allowed_differences: readonly string[];
}

/** Human review artifacts the policy requires. */
export interface SurfacePolicyRequiredReviews {
  readonly equivalence: boolean;
  readonly blinding: boolean;
}

/** Typed ParticipantSurfacePolicy. Validates against its version 1 schema. */
export interface ParticipantSurfacePolicy {
  readonly schema_version: 1;
  readonly kind: "ParticipantSurfacePolicy";
  readonly id: string;
  readonly version: string;
  readonly forbidden_literals: readonly ForbiddenLiteralRule[];
  readonly forbidden_patterns: readonly string[];
  readonly allowed_exceptions: readonly SurfacePolicyException[];
  readonly treatment_owned: SurfacePolicyTreatmentOwned;
  readonly neutral_profiles: SurfacePolicyNeutralProfiles;
  readonly pairwise_surface_diff_allowlist: readonly SurfacePolicyPairwiseAllowlist[];
  readonly required_reviews: SurfacePolicyRequiredReviews;
  readonly extensions: Readonly<Record<string, Json>>;
}

/** One scanned surface entry of the cue audit. */
export interface CueAuditScanned {
  readonly surface_entry: string;
  readonly bytes_sha256: string;
}

/** One lexical finding of the cue audit. */
export interface CueAuditFinding {
  readonly kind: "literal" | "pattern";
  readonly match: string;
  readonly surface_entry: string;
  readonly allowed_exception: boolean;
}

/** One surface difference of the pairwise part of the cue audit. */
export interface CueAuditDifference {
  readonly surface_entry: string;
  readonly kind: "bytes" | "name" | "route" | "catalog";
  readonly allowed: boolean;
}

/** One cell-pair comparison recorded in the cue audit. */
export interface CueAuditPairwise {
  readonly cell_a: string;
  readonly cell_b: string;
  readonly differences: readonly CueAuditDifference[];
}

/** Rendered participant bytes of one surface entry. */
export interface RenderedSurfaceText {
  /** Manifest entry identifier the rendered bytes belong to. */
  readonly surfaceEntry: string;
  readonly text: string;
}

/** One manifest entry in typed form. */
export interface SurfaceEntryView {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly channel: SurfaceChannel;
  readonly mediaType: string | null;
  readonly bytes: number | null;
  readonly catalogSha256: string | null;
  readonly maxBytes: number;
  readonly transformation: string | null;
  readonly provenanceClass: SurfaceProvenanceClass;
}

/** One private artifact that reached the participant surface. */
export interface CuePrivacyProblem {
  readonly code: string;
  readonly entryId: string;
  readonly target: string;
  readonly fragment: string;
  readonly message: string;
}

/** Result of the cue audit builder. */
export interface CueAudit {
  /** Cell the audit belongs to. */
  readonly cellId: string;
  /** Document that conforms to cue-audit.v1.schema.json. */
  readonly document: JsonObject;
  /** Digest of the canonical audit document. */
  readonly sha256: string;
  readonly findings: readonly CueAuditFinding[];
  readonly result: "pass" | "fail";
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const CHANNELS: ReadonlySet<string> = new Set<string>([
  "file",
  "http-route",
  "environment",
  "credential",
  "tool",
  "message",
  "workspace"
]);

const PROVENANCE_CLASSES: ReadonlySet<string> = new Set<string>([
  "contractual",
  "task_essential",
  "treatment",
  "framework_incidental"
]);

/**
 * Fragments that name study-private artifacts. A participant surface
 * manifest entry whose source or target holds one of these fragments
 * delivers the cue audit, the policy, or factor metadata to the participant.
 */
export const PRIVATE_SURFACE_FRAGMENTS: readonly string[] = [
  "cue-audit",
  "cue_audit",
  "participant-surface-policy",
  "surface-policy",
  "factor-level",
  "factor_level",
  "assignment-schedule",
  "protocol-lock",
  "phase-plan",
  "blinding-review",
  "equivalence-review",
  "study-ir"
];

function policyError(message: string, details?: Json): Error {
  return invalidInput(CueCode.PolicyInvalid, message, details);
}

/**
 * Validate and freeze one policy document. The literal of every allowed
 * exception must name a declared forbidden literal, so an exception can
 * never widen the policy silently. Pattern strings must compile.
 */
export function parseSurfacePolicy(
  document: JsonObject
): ParticipantSurfacePolicy {
  if (document["schema_version"] !== 1) {
    throw policyError("Policy schema_version must be 1.");
  }
  if (document["kind"] !== "ParticipantSurfacePolicy") {
    throw policyError("Policy kind must be ParticipantSurfacePolicy.");
  }
  const id = literalSafeIdField(document, "id");
  const version = stringField(document, "version");
  if (!SEMVER.test(version)) {
    throw policyError(`Policy version is not semver: ${version}.`);
  }

  const literals: ForbiddenLiteralRule[] = [];
  const literalList = arrayField(document, "forbidden_literals");
  for (const item of literalList) {
    if (!isJsonObject(item)) {
      throw policyError("Every forbidden literal must be an object.");
    }
    const literal = literalOf(item);
    const flag = item["case_insensitive"];
    if (typeof flag !== "boolean") {
      throw policyError(
        `Forbidden literal ${literal} must set case_insensitive to a boolean.`
      );
    }
    literals.push(Object.freeze({ literal, case_insensitive: flag }));
  }

  const patterns: string[] = [];
  for (const item of arrayField(document, "forbidden_patterns")) {
    if (typeof item !== "string" || item.length === 0) {
      throw policyError("Every forbidden pattern must be a non-empty string.");
    }
    try {
      new RegExp(item, "g");
    } catch {
      throw invalidInput(
        CueCode.PatternInvalid,
        `Forbidden pattern does not compile: ${item}.`,
        { pattern: item }
      );
    }
    patterns.push(item);
  }

  const declaredLiterals = new Set<string>(
    literals.map((rule) => rule.literal)
  );
  const exceptions: SurfacePolicyException[] = [];
  for (const item of arrayField(document, "allowed_exceptions")) {
    if (!isJsonObject(item)) {
      throw policyError("Every allowed exception must be an object.");
    }
    const surfaceEntry = literalSafeIdField(item, "surface_entry");
    const factorLevelRaw = item["factor_level"];
    let factorLevel: string | null = null;
    if (factorLevelRaw !== undefined && factorLevelRaw !== null) {
      factorLevel = literalSafeIdField(item, "factor_level");
    }
    const literal = literalOf(item);
    if (!declaredLiterals.has(literal)) {
      throw policyError(
        `Allowed exception literal is not a forbidden literal: ${literal}.`,
        { surface_entry: surfaceEntry, literal }
      );
    }
    const reasonRaw = item["reason"];
    const reason =
      reasonRaw === undefined || reasonRaw === null
        ? null
        : nonEmptyString(reasonRaw, "reason");
    exceptions.push(
      Object.freeze({
        surface_entry: surfaceEntry,
        factor_level: factorLevel,
        literal,
        reason
      })
    );
  }

  const treatmentRaw = objectField(document, "treatment_owned");
  const treatmentOwned: SurfacePolicyTreatmentOwned = Object.freeze({
    paths: stringArray(treatmentRaw, "paths"),
    routes: stringArray(treatmentRaw, "routes"),
    fields: stringArray(treatmentRaw, "fields"),
    catalogs: stringArray(treatmentRaw, "catalogs")
  });

  const neutralRaw = objectField(document, "neutral_profiles");
  const neutralProfiles: SurfacePolicyNeutralProfiles = Object.freeze({
    response_profile: literalSafeIdField(neutralRaw, "response_profile"),
    credential_profile: literalSafeIdField(neutralRaw, "credential_profile"),
    server_profile: literalSafeIdField(neutralRaw, "server_profile")
  });

  const pairwise: SurfacePolicyPairwiseAllowlist[] = [];
  for (const item of arrayField(document, "pairwise_surface_diff_allowlist")) {
    if (!isJsonObject(item)) {
      throw policyError("Every pairwise allowlist entry must be an object.");
    }
    const cellA = literalSafeIdField(item, "cell_a");
    const cellB = literalSafeIdField(item, "cell_b");
    if (cellA === cellB) {
      throw policyError(
        `Pairwise allowlist must name two different cells: ${cellA}.`
      );
    }
    pairwise.push(
      Object.freeze({
        cell_a: cellA,
        cell_b: cellB,
        allowed_differences: stringArray(item, "allowed_differences")
      })
    );
  }

  const reviewsRaw = objectField(document, "required_reviews");
  const requiredReviews: SurfacePolicyRequiredReviews = Object.freeze({
    equivalence: booleanField(reviewsRaw, "equivalence"),
    blinding: booleanField(reviewsRaw, "blinding")
  });

  const extensions = document["extensions"];
  if (!isJsonObject(extensions)) {
    throw policyError("Policy extensions must be an object.");
  }

  return Object.freeze({
    schema_version: 1,
    kind: "ParticipantSurfacePolicy",
    id,
    version,
    forbidden_literals: Object.freeze(literals),
    forbidden_patterns: Object.freeze(patterns),
    allowed_exceptions: Object.freeze(exceptions),
    treatment_owned: treatmentOwned,
    neutral_profiles: neutralProfiles,
    pairwise_surface_diff_allowlist: Object.freeze(pairwise),
    required_reviews: requiredReviews,
    extensions
  });
}

/** Serialize one typed policy back to its schema document form. */
export function policyJson(policy: ParticipantSurfacePolicy): JsonObject {
  return {
    schema_version: 1,
    kind: "ParticipantSurfacePolicy",
    id: policy.id,
    version: policy.version,
    forbidden_literals: policy.forbidden_literals.map((rule) => ({
      literal: rule.literal,
      case_insensitive: rule.case_insensitive
    })),
    forbidden_patterns: [...policy.forbidden_patterns],
    allowed_exceptions: policy.allowed_exceptions.map((exception) => ({
      surface_entry: exception.surface_entry,
      ...(exception.factor_level === null
        ? {}
        : { factor_level: exception.factor_level }),
      literal: exception.literal,
      ...(exception.reason === null ? {} : { reason: exception.reason })
    })),
    treatment_owned: {
      paths: [...policy.treatment_owned.paths],
      routes: [...policy.treatment_owned.routes],
      fields: [...policy.treatment_owned.fields],
      catalogs: [...policy.treatment_owned.catalogs]
    },
    neutral_profiles: { ...policy.neutral_profiles },
    pairwise_surface_diff_allowlist: policy.pairwise_surface_diff_allowlist.map(
      (entry) => ({
        cell_a: entry.cell_a,
        cell_b: entry.cell_b,
        allowed_differences: [...entry.allowed_differences]
      })
    ),
    required_reviews: { ...policy.required_reviews },
    extensions: { ...policy.extensions }
  };
}

/** Canonical digest of one policy document. */
export function surfacePolicySha256(policy: ParticipantSurfacePolicy): string {
  return canonicalJsonSha256(policyJson(policy));
}

/**
 * Read and validate the entries of one surface manifest. The manifest must
 * be a participant-surface-manifest.v1 document with well-formed entries.
 */
export function surfaceEntriesOf(
  manifest: JsonObject
): readonly SurfaceEntryView[] {
  const kind = manifest["kind"];
  if (kind !== "ParticipantSurfaceManifest") {
    throw invalidInput(
      CueCode.ManifestInvalid,
      "Document is not a ParticipantSurfaceManifest.",
      { kind: typeof kind === "string" ? kind : null }
    );
  }
  const listed = manifest["entries"];
  if (!Array.isArray(listed)) {
    throw invalidInput(
      CueCode.ManifestInvalid,
      "Surface manifest entries must be an array."
    );
  }
  const views: SurfaceEntryView[] = [];
  const ids = new Set<string>();
  for (const item of listed) {
    if (!isJsonObject(item)) {
      throw invalidInput(
        CueCode.ManifestInvalid,
        "Every surface entry must be an object."
      );
    }
    const id = literalSafeIdField(item, "id");
    if (ids.has(id)) {
      throw invalidInput(
        CueCode.ManifestInvalid,
        `Two surface entries share the identifier ${id}.`,
        { id }
      );
    }
    ids.add(id);
    const channel = stringField(item, "channel");
    if (!CHANNELS.has(channel)) {
      throw invalidInput(
        CueCode.ManifestInvalid,
        `Surface entry ${id} holds an unknown channel: ${channel}.`,
        { id, channel }
      );
    }
    const provenance = stringField(item, "provenance_class");
    if (!PROVENANCE_CLASSES.has(provenance)) {
      throw invalidInput(
        CueCode.ManifestInvalid,
        `Surface entry ${id} holds an unknown provenance class: ${provenance}.`,
        { id, provenance_class: provenance }
      );
    }
    const maxBytes = item["max_bytes"];
    if (
      typeof maxBytes !== "number" ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw invalidInput(
        CueCode.ManifestInvalid,
        `Surface entry ${id} holds an invalid max_bytes.`,
        { id }
      );
    }
    views.push(
      Object.freeze({
        id,
        source: stringField(item, "source"),
        target: stringField(item, "target"),
        channel: channel as SurfaceChannel,
        mediaType: optionalString(item, "media_type"),
        bytes: optionalNumber(item, "bytes"),
        catalogSha256: optionalDigest(item, "catalog_sha256"),
        maxBytes,
        transformation: optionalString(item, "transformation"),
        provenanceClass: provenance as SurfaceProvenanceClass
      })
    );
  }
  return Object.freeze(views);
}

/** Serialize one entry view back to its manifest form. */
export function surfaceEntryJson(entry: SurfaceEntryView): JsonObject {
  return {
    id: entry.id,
    source: entry.source,
    target: entry.target,
    channel: entry.channel,
    media_type: entry.mediaType,
    bytes: entry.bytes,
    catalog_sha256: entry.catalogSha256,
    max_bytes: entry.maxBytes,
    transformation: entry.transformation,
    provenance_class: entry.provenanceClass
  };
}

/**
 * Whether a treatment-owned list owns one surface name. Paths match a target
 * exactly or as a directory prefix. Routes also match a method-prefixed
 * target such as `GET /widgets`.
 */
export function treatmentOwnedMatch(
  owned: SurfacePolicyTreatmentOwned,
  target: string
): "paths" | "routes" | "fields" | "catalogs" | null {
  const lists: readonly (readonly [
    "paths" | "routes" | "fields" | "catalogs",
    readonly string[]
  ])[] = [
    ["paths", owned.paths],
    ["routes", owned.routes],
    ["fields", owned.fields],
    ["catalogs", owned.catalogs]
  ];
  for (const [key, names] of lists) {
    for (const name of names) {
      if (name.endsWith("/") && target.startsWith(name)) {
        return key;
      }
      if (target === name) {
        return key;
      }
      if (key === "routes" && target.endsWith(` ${name}`)) {
        return key;
      }
    }
  }
  return null;
}

/** Input of {@link buildCueAudit}. */
export interface CueAuditInput {
  readonly cellId: string;
  readonly policy: ParticipantSurfacePolicy;
  /** Rendered, not template, manifest of the cell. */
  readonly manifest: JsonObject;
  readonly rendered: readonly RenderedSurfaceText[];
  /** Factor-to-level map of the cell; used to pin exceptions. */
  readonly cellLevels?: Readonly<Record<string, string>> | undefined;
  /** Pairwise results of the analytical preflight comparison. */
  readonly pairwise?: readonly CueAuditPairwise[] | undefined;
  readonly extensions?: JsonObject | undefined;
}

/**
 * Scan one rendered participant surface and build the private cue audit.
 * Every manifest entry is scanned over its source and target names, and
 * entries with rendered bytes are scanned over those bytes. Repeated
 * occurrences of one matched text collapse into one finding. The audit
 * fails when any finding is not an allowed exception or any pairwise
 * difference is not allowed.
 */
export function buildCueAudit(input: CueAuditInput): CueAudit {
  if (!SAFE_ID.test(input.cellId)) {
    throw invalidInput(
      CueCode.CellIdUnsafe,
      `Cell identifier is not a safe id: ${input.cellId}.`,
      { cell_id: input.cellId }
    );
  }
  const manifestCellId = input.manifest["cell_id"];
  if (manifestCellId !== input.cellId) {
    throw invalidInput(
      CueCode.CellIdMismatch,
      `Manifest cell_id does not match the audited cell ${input.cellId}.`,
      { expected: input.cellId }
    );
  }
  const entries = surfaceEntriesOf(input.manifest);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const texts = new Map<string, string[]>();
  for (const item of input.rendered) {
    if (!byId.has(item.surfaceEntry)) {
      throw invalidInput(
        CueCode.EntryUnknown,
        `Rendered bytes name an unknown surface entry: ${item.surfaceEntry}.`,
        { surface_entry: item.surfaceEntry }
      );
    }
    const existing = texts.get(item.surfaceEntry);
    if (existing === undefined) {
      texts.set(item.surfaceEntry, [item.text]);
    } else {
      existing.push(item.text);
    }
  }

  const scanned: CueAuditScanned[] = [];
  const findings: CueAuditFinding[] = [];
  for (const entry of entries) {
    const entryTexts = texts.get(entry.id) ?? [];
    const material = [entry.source, entry.target, ...entryTexts];
    scanned.push(
      Object.freeze({
        surface_entry: entry.id,
        bytes_sha256: sha256Hex(material.join("\n"))
      })
    );
    for (const text of material) {
      scanText(text, entry.id, input, findings);
    }
  }

  const pairwise = input.pairwise ?? [];
  const result: "pass" | "fail" =
    findings.some((finding) => !finding.allowed_exception) ||
    pairwise.some((pair) =>
      pair.differences.some((difference) => !difference.allowed)
    )
      ? "fail"
      : "pass";

  const document: JsonObject = Object.freeze({
    schema_version: 1,
    kind: "CueAudit",
    cell_id: input.cellId,
    policy_sha256: surfacePolicySha256(input.policy),
    scanned: scanned.map((item) => ({
      surface_entry: item.surface_entry,
      bytes_sha256: item.bytes_sha256
    })) as Json,
    findings: findings.map((finding) => ({
      kind: finding.kind,
      match: finding.match,
      surface_entry: finding.surface_entry,
      allowed_exception: finding.allowed_exception
    })) as Json,
    pairwise: pairwise.map((pair) => ({
      cell_a: pair.cell_a,
      cell_b: pair.cell_b,
      differences: pair.differences.map((difference) => ({
        surface_entry: difference.surface_entry,
        kind: difference.kind,
        allowed: difference.allowed
      }))
    })) as Json,
    result,
    extensions: input.extensions ?? {}
  });
  return Object.freeze({
    cellId: input.cellId,
    document,
    sha256: canonicalJsonSha256(document),
    findings: Object.freeze(findings),
    result
  });
}

function scanText(
  text: string,
  entryId: string,
  input: CueAuditInput,
  findings: CueAuditFinding[]
): void {
  for (const rule of input.policy.forbidden_literals) {
    const matched = rule.case_insensitive
      ? distinctRegexpMatches(
          text,
          new RegExp(escapeRegExp(rule.literal), "gi")
        )
      : distinctPlainMatches(text, rule.literal);
    for (const match of matched) {
      findings.push({
        kind: "literal",
        match,
        surface_entry: entryId,
        allowed_exception: exceptionApplies(input, entryId, rule.literal)
      });
    }
  }
  for (const pattern of input.policy.forbidden_patterns) {
    for (const match of distinctRegexpMatches(text, new RegExp(pattern, "g"))) {
      findings.push({
        kind: "pattern",
        match,
        surface_entry: entryId,
        allowed_exception: false
      });
    }
  }
}

/**
 * Whether one exception excuses this literal in this entry. The exception
 * must name the entry and the declared literal, and the cell must hold the
 * pinned factor level when the exception names one.
 */
function exceptionApplies(
  input: CueAuditInput,
  entryId: string,
  literal: string
): boolean {
  for (const exception of input.policy.allowed_exceptions) {
    if (exception.surface_entry !== entryId || exception.literal !== literal) {
      continue;
    }
    if (exception.factor_level === null) {
      return true;
    }
    if (input.cellLevels === undefined) {
      return false;
    }
    for (const level of Object.values(input.cellLevels)) {
      if (level === exception.factor_level) {
        return true;
      }
    }
  }
  return false;
}

function distinctPlainMatches(text: string, literal: string): string[] {
  const matches: string[] = [];
  let index = text.indexOf(literal);
  while (index !== -1) {
    const matched = text.slice(index, index + literal.length);
    if (!matches.includes(matched)) {
      matches.push(matched);
    }
    index = text.indexOf(literal, index + literal.length);
  }
  return matches;
}

function distinctRegexpMatches(text: string, regexp: RegExp): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(regexp)) {
    const matched = match[0];
    if (matched.length > 0 && !matches.includes(matched)) {
      matches.push(matched);
    }
  }
  return matches;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Private artifacts that must never appear on a participant surface. The
 * cue audit, the surface policy, and factor metadata are study-private; an
 * entry that delivers one of them to a participant is a cue leak.
 */
export function privateArtifactProblems(
  manifest: JsonObject
): readonly CuePrivacyProblem[] {
  const problems: CuePrivacyProblem[] = [];
  for (const entry of surfaceEntriesOf(manifest)) {
    const haystack = `${entry.source}\n${entry.target}`.toLowerCase();
    for (const fragment of PRIVATE_SURFACE_FRAGMENTS) {
      if (haystack.includes(fragment)) {
        problems.push(
          Object.freeze({
            code: CueCode.PrivateArtifactVisible,
            entryId: entry.id,
            target: entry.target,
            fragment,
            message:
              `Surface entry ${entry.id} delivers a study-private artifact ` +
              `to a participant: ${entry.target}.`
          })
        );
        break;
      }
    }
  }
  return Object.freeze(problems);
}

/**
 * Report a strict cue policy that runs under advisory isolation (section
 * 9.6, closing rule). A same-user participant process can bypass it, so
 * the run must be reported as such.
 */
export function cueIsolationAdvisory(input: {
  readonly blindingMode: ProtocolBlinding["mode"];
  readonly isolation: "advisory" | "os";
}): Diagnostic | null {
  if (input.blindingMode !== "strict" || input.isolation !== "advisory") {
    return null;
  }
  return diagnostic({
    severity: "warning",
    phase: "preflight",
    code: CueCode.IsolationAdvisory,
    message:
      "A strict cue policy under advisory isolation stays easy for a " +
      "same-user participant process to bypass."
  });
}

function literalSafeIdField(document: JsonObject, name: string): string {
  const value = document[name];
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw policyError(`Field ${name} must be a safe identifier.`);
  }
  return value;
}

function stringField(document: JsonObject, name: string): string {
  return nonEmptyString(document[name], name);
}

function nonEmptyString(value: Json | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw policyError(`Field ${name} must be a non-empty string.`);
  }
  return value;
}

function booleanField(document: JsonObject, name: string): boolean {
  const value = document[name];
  if (typeof value !== "boolean") {
    throw policyError(`Field ${name} must be a boolean.`);
  }
  return value;
}

function arrayField(document: JsonObject, name: string): readonly Json[] {
  const value = document[name];
  if (!Array.isArray(value)) {
    throw policyError(`Field ${name} must be an array.`);
  }
  return value;
}

function objectField(document: JsonObject, name: string): JsonObject {
  const value = document[name];
  if (!isJsonObject(value)) {
    throw policyError(`Field ${name} must be an object.`);
  }
  return value;
}

function stringArray(document: JsonObject, name: string): readonly string[] {
  const values: string[] = [];
  for (const item of arrayField(document, name)) {
    if (typeof item !== "string" || item.length === 0) {
      throw policyError(`Field ${name} must hold non-empty strings.`);
    }
    values.push(item);
  }
  return Object.freeze(values);
}

function literalOf(item: JsonObject): string {
  return nonEmptyString(item["literal"], "literal");
}

/** Entry identifier for error messages; "unknown" when not a string. */
function entryLabel(item: JsonObject): string {
  const id = item["id"];
  return typeof id === "string" ? id : "unknown";
}

function optionalString(item: JsonObject, name: string): string | null {
  const value = item[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalidInput(
      CueCode.ManifestInvalid,
      `Surface entry ${entryLabel(item)} field ${name} must be a string.`
    );
  }
  return value;
}

function optionalNumber(item: JsonObject, name: string): number | null {
  const value = item[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidInput(
      CueCode.ManifestInvalid,
      `Surface entry ${entryLabel(item)} field ${name} must be a size.`
    );
  }
  return value;
}

function optionalDigest(item: JsonObject, name: string): string | null {
  const value = item[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !isSha256Hex(value)) {
    throw invalidInput(
      CueCode.ManifestInvalid,
      `Surface entry ${entryLabel(item)} field ${name} must be a sha256.`
    );
  }
  return value;
}
