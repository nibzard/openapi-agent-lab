/**
 * Protocol lock creation and verification (specification section 12.10).
 *
 * A lock is an explicit maintainer action, never a validation side effect.
 * It records a digest for the protocol source and every study-owned member,
 * plus the effective contract digest of every referenced variant. The lock
 * never contains its own digest: the lock digest is SHA-256 over the
 * canonical JSON bytes of the lock document itself. Verification recomputes
 * every member digest and reports exactly which member drifted.
 */

import {
  canonicalJson,
  diagnostic,
  digestEquals,
  isJsonObject,
  isSha256Hex,
  sha256Hex,
  validateSchemaInstance,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { StudyCode } from "./codes.ts";
import {
  isSafeProtocolRootPath,
  type PackRef,
  type StudyProtocol
} from "./protocol.ts";
import { declaredMemberPaths, protocolSourceDigest } from "./compile.ts";

export const PROTOCOL_LOCK_SCHEMA_VERSION = 1;

/** Default protocol document path inside the study root. */
export const PROTOCOL_MEMBER_PATH = "study.yaml";

/** Typed protocol lock. Serialized form validates against its schema. */
export interface ProtocolLock {
  readonly schema_version: typeof PROTOCOL_LOCK_SCHEMA_VERSION;
  readonly protocol_id: string;
  readonly protocol_version: string;
  readonly protocol_source_sha256: string;
  /** Protocol-root path to SHA-256 of the member bytes. */
  readonly members: Readonly<Record<string, string>>;
  /** Variant ID to SHA-256 of the effective contract. */
  readonly effective_contracts: Readonly<Record<string, string>>;
  readonly pack: PackRef;
}

/** One member supplied at lock creation or verification time. */
export interface LockMember {
  readonly path: string;
  readonly text: string;
}

/** Effective contract digest of one referenced variant. */
export interface EffectiveContractDigest {
  readonly variant: string;
  readonly sha256: string;
}

export interface ProtocolLockOptions {
  /** Draft 2020-12 `protocol-lock.v1` schema. */
  readonly schema?: Json | undefined;
  /** Path of the protocol document inside the study root. */
  readonly protocolPath?: string | undefined;
  readonly documentUri?: string | undefined;
}

export interface ProtocolLockResult {
  readonly lock: ProtocolLock | null;
  readonly diagnostics: Diagnostic[];
}

/** Kind of drift verification found. */
export type LockDriftKind =
  | "digest"
  | "missing"
  | "unrecorded"
  | "identity"
  | "variant_missing"
  | "variant_unused"
  | "lock_digest";

export interface LockDrift {
  readonly kind: LockDriftKind;
  /** Member path, or null for lock-level drift. */
  readonly path: string | null;
  readonly detail: string;
  readonly recorded: string | null;
  readonly actual: string | null;
}

export interface ProtocolLockVerifyInput {
  /** Current member bytes by protocol-root path. */
  readonly members: readonly LockMember[];
  /** Current protocol. When present, identity is verified too. */
  readonly protocol?: StudyProtocol | undefined;
  /** Digest recorded elsewhere for the lock itself. */
  readonly expectedLockSha256?: string | undefined;
}

export interface ProtocolLockVerifyResult {
  readonly ok: boolean;
  /** Digest over the canonical JSON bytes of the lock. */
  readonly lockSha256: string;
  readonly drift: readonly LockDrift[];
  readonly diagnostics: Diagnostic[];
}

/** Variant IDs selected by factor levels of the protocol. */
export function referencedVariants(protocol: StudyProtocol): Set<string> {
  const used = new Set<string>();
  for (const factor of protocol.factors) {
    for (const level of factor.levels) {
      if (level.contract_variant !== undefined) {
        used.add(level.contract_variant);
      }
    }
  }
  return used;
}

/** Create a protocol lock. Never throws on content. */
export async function createProtocolLock(
  protocol: StudyProtocol,
  members: readonly LockMember[],
  effectiveContracts: readonly EffectiveContractDigest[],
  options: ProtocolLockOptions = {}
): Promise<ProtocolLockResult> {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;
  const protocolPath = options.protocolPath ?? PROTOCOL_MEMBER_PATH;

  const memberDigests = new Map<string, string>();
  for (const member of members) {
    if (!isSafeProtocolRootPath(member.path)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.MemberPathUnsafe,
          message: `Member path ${JSON.stringify(member.path)} is not a safe protocol-root path.`,
          document_uri: uri,
          json_pointer: "#/members"
        })
      );
      continue;
    }
    if (memberDigests.has(member.path)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.MemberDuplicate,
          message: `Member path ${JSON.stringify(member.path)} is supplied more than once.`,
          document_uri: uri,
          json_pointer: "#/members"
        })
      );
      continue;
    }
    memberDigests.set(member.path, digestOf(member.text));
  }

  for (const required of [protocolPath, ...declaredMemberPaths(protocol)]) {
    if (!memberDigests.has(required)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.MemberMissing,
          message: `Lock member ${JSON.stringify(required)} is missing.`,
          document_uri: uri,
          json_pointer: "#/members"
        })
      );
    }
  }

  const referenced = referencedVariants(protocol);
  const effective: Record<string, string> = {};
  for (const entry of effectiveContracts) {
    if (!referenced.has(entry.variant)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.EffectiveContractUnused,
          message: `Effective contract ${JSON.stringify(entry.variant)} is not referenced by any factor level.`,
          document_uri: uri,
          json_pointer: "#/effective_contracts"
        })
      );
      continue;
    }
    if (!isSha256Hex(entry.sha256)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `Effective contract ${JSON.stringify(entry.variant)} has no lowercase SHA-256 digest.`,
          document_uri: uri,
          json_pointer: "#/effective_contracts"
        })
      );
      continue;
    }
    effective[entry.variant] = entry.sha256;
  }
  for (const variant of referenced) {
    if (!(variant in effective)) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.EffectiveContractMissing,
          message: `Referenced variant ${JSON.stringify(variant)} has no effective contract digest.`,
          document_uri: uri,
          json_pointer: "#/effective_contracts"
        })
      );
    }
  }

  const lock: ProtocolLock = {
    schema_version: PROTOCOL_LOCK_SCHEMA_VERSION,
    protocol_id: protocol.metadata.id,
    protocol_version: protocol.metadata.version,
    protocol_source_sha256: protocolSourceDigest(protocol),
    members: Object.fromEntries(memberDigests),
    effective_contracts: effective,
    pack: protocol.evaluation.pack
  };

  if (options.schema !== undefined) {
    // Study documents are untrusted: their schema evaluation runs inside
    // the bounded schema-worker boundary.
    const violations = await validateSchemaInstance(
      options.schema,
      protocolLockJson(lock)
    );
    for (const violation of violations) {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `Protocol lock violates its schema: ${violation.code}: ${violation.message}`,
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
    return { lock: null, diagnostics };
  }
  return { lock, diagnostics };
}

/** SHA-256 over the UTF-8 bytes of one member. */
function digestOf(text: string): string {
  return sha256Hex(text);
}

/** Read a JSON object whose member values must all be strings. */
function stringRecord(value: JsonObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

/** JSON view of the lock. The lock never contains its own digest. */
export function protocolLockJson(lock: ProtocolLock): Json {
  return {
    schema_version: lock.schema_version,
    protocol_id: lock.protocol_id,
    protocol_version: lock.protocol_version,
    protocol_source_sha256: lock.protocol_source_sha256,
    members: { ...lock.members },
    effective_contracts: { ...lock.effective_contracts },
    pack: { ...lock.pack }
  };
}

/** Canonical JSON bytes of the lock. */
export function serializeProtocolLock(lock: ProtocolLock): string {
  return canonicalJson(protocolLockJson(lock));
}

/**
 * The lock digest: SHA-256 over the canonical JSON bytes of the lock. The
 * lock itself never carries this value.
 */
export function protocolLockSha256(lock: ProtocolLock): string {
  return digestOf(serializeProtocolLock(lock));
}

/**
 * Verify a lock against current member bytes. Reports exactly which member
 * drifted; an empty drift list with no errors means the lock still holds.
 */
export async function verifyProtocolLock(
  lock: ProtocolLock,
  current: ProtocolLockVerifyInput,
  options: ProtocolLockOptions = {}
): Promise<ProtocolLockVerifyResult> {
  const diagnostics: Diagnostic[] = [];
  const drift: LockDrift[] = [];
  const uri = options.documentUri ?? null;

  if (options.schema !== undefined) {
    const violations = await validateSchemaInstance(
      options.schema,
      protocolLockJson(lock)
    );
    for (const violation of violations) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `Protocol lock violates its schema: ${violation.code}: ${violation.message}`,
          document_uri: uri,
          json_pointer:
            violation.pointer.length === 0
              ? "#/"
              : `#/${violation.pointer.slice(1)}`
        })
      );
    }
  }

  const currentDigests = new Map<string, string>();
  for (const member of current.members) {
    currentDigests.set(member.path, digestOf(member.text));
  }

  for (const [path, recorded] of Object.entries(lock.members)) {
    const actual = currentDigests.get(path);
    if (actual === undefined) {
      drift.push({
        kind: "missing",
        path,
        detail: "Locked member is absent from the supplied bytes.",
        recorded,
        actual: null
      });
      continue;
    }
    if (!digestEquals(recorded, actual)) {
      drift.push({
        kind: "digest",
        path,
        detail: "Locked member bytes changed.",
        recorded,
        actual
      });
    }
  }
  for (const path of currentDigests.keys()) {
    if (!(path in lock.members)) {
      drift.push({
        kind: "unrecorded",
        path,
        detail: "Supplied member is not covered by the lock.",
        recorded: null,
        actual: currentDigests.get(path) ?? null
      });
    }
  }

  const protocol = current.protocol;
  if (protocol !== undefined) {
    if (lock.protocol_id !== protocol.metadata.id) {
      drift.push({
        kind: "identity",
        path: null,
        detail: "Protocol ID drifted from the lock.",
        recorded: lock.protocol_id,
        actual: protocol.metadata.id
      });
    }
    if (lock.protocol_version !== protocol.metadata.version) {
      drift.push({
        kind: "identity",
        path: null,
        detail: "Protocol version drifted from the lock.",
        recorded: lock.protocol_version,
        actual: protocol.metadata.version
      });
    }
    const sourceDigest = protocolSourceDigest(protocol);
    if (!digestEquals(lock.protocol_source_sha256, sourceDigest)) {
      drift.push({
        kind: "identity",
        path: null,
        detail: "Protocol source digest drifted from the lock.",
        recorded: lock.protocol_source_sha256,
        actual: sourceDigest
      });
    }
    if (
      lock.pack.id !== protocol.evaluation.pack.id ||
      lock.pack.version !== protocol.evaluation.pack.version ||
      !digestEquals(lock.pack.sha256, protocol.evaluation.pack.sha256)
    ) {
      drift.push({
        kind: "identity",
        path: null,
        detail: "Pack reference drifted from the lock.",
        recorded: canonicalJson({ ...lock.pack }),
        actual: canonicalJson({ ...protocol.evaluation.pack })
      });
    }
    const referenced = referencedVariants(protocol);
    for (const variant of referenced) {
      if (!(variant in lock.effective_contracts)) {
        drift.push({
          kind: "variant_missing",
          path: null,
          detail: `Referenced variant ${JSON.stringify(variant)} has no locked effective contract digest.`,
          recorded: null,
          actual: null
        });
      }
    }
    for (const variant of Object.keys(lock.effective_contracts)) {
      if (!referenced.has(variant)) {
        drift.push({
          kind: "variant_unused",
          path: null,
          detail: `Locked variant ${JSON.stringify(variant)} is no longer referenced.`,
          recorded: lock.effective_contracts[variant] ?? null,
          actual: null
        });
      }
    }
  }

  const lockDigest = protocolLockSha256(lock);
  if (
    current.expectedLockSha256 !== undefined &&
    !digestEquals(lockDigest, current.expectedLockSha256)
  ) {
    drift.push({
      kind: "lock_digest",
      path: null,
      detail: "Recorded lock digest does not match the lock bytes.",
      recorded: current.expectedLockSha256,
      actual: lockDigest
    });
  }

  for (const entry of drift) {
    const at = entry.path === null ? "" : ` at ${JSON.stringify(entry.path)}`;
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.LockDrift,
        message: `Protocol lock drift (${entry.kind})${at}: ${entry.detail}`,
        document_uri: uri,
        json_pointer: entry.path === null ? null : `#/members/${entry.path}`
      })
    );
  }

  const ok =
    drift.length === 0 &&
    !diagnostics.some((entry) => entry.severity === "error");
  return { ok, lockSha256: lockDigest, drift, diagnostics };
}

/** Parse a persisted lock document. Never throws on content. */
export async function protocolLockFromJson(
  document: Json,
  options: ProtocolLockOptions = {}
): Promise<ProtocolLockResult> {
  const diagnostics: Diagnostic[] = [];
  if (options.schema !== undefined) {
    const violations = await validateSchemaInstance(options.schema, document);
    for (const violation of violations) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.SchemaInvalid,
          message: `${violation.code}: ${violation.message}`,
          document_uri: options.documentUri ?? null,
          json_pointer:
            violation.pointer.length === 0
              ? "#/"
              : `#/${violation.pointer.slice(1)}`
        })
      );
    }
  }
  if (
    !isJsonObject(document) ||
    !isJsonObject(document["members"]) ||
    !isJsonObject(document["effective_contracts"]) ||
    !isJsonObject(document["pack"])
  ) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message:
          "A protocol lock must contain object members, effective_contracts, and pack.",
        document_uri: options.documentUri ?? null,
        json_pointer: "#/"
      })
    );
    return { lock: null, diagnostics };
  }
  const pack = document["pack"];
  const lockFields: Record<string, string | null> = {
    protocol_id: readString(document, "protocol_id"),
    protocol_version: readString(document, "protocol_version"),
    protocol_source_sha256: readString(document, "protocol_source_sha256"),
    "pack.id": isJsonObject(pack) ? readString(pack, "id") : null,
    "pack.version": isJsonObject(pack) ? readString(pack, "version") : null,
    "pack.sha256": isJsonObject(pack) ? readString(pack, "sha256") : null
  };
  for (const [field, value] of Object.entries(lockFields)) {
    if (value === null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `Protocol lock field ${field} must be a string.`,
          document_uri: options.documentUri ?? null,
          json_pointer: `#/${field.replace(".", "/")}`
        })
      );
    }
  }
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { lock: null, diagnostics };
  }
  const lock: ProtocolLock = {
    schema_version: PROTOCOL_LOCK_SCHEMA_VERSION,
    protocol_id: lockFields["protocol_id"] ?? "",
    protocol_version: lockFields["protocol_version"] ?? "",
    protocol_source_sha256: lockFields["protocol_source_sha256"] ?? "",
    members: stringRecord(document["members"]),
    effective_contracts: stringRecord(document["effective_contracts"]),
    pack: {
      id: lockFields["pack.id"] ?? "",
      version: lockFields["pack.version"] ?? "",
      sha256: lockFields["pack.sha256"] ?? ""
    }
  };
  return { lock, diagnostics };
}

/** Read one string field of a lock document, or null when absent. */
function readString(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
