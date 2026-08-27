/**
 * Domain-separated control identifiers (specification section 12.11).
 *
 * An assignment, child-batch, or run ID is a prefix (`asg_`, `bat_`, `run_`)
 * plus the first 24 lowercase hexadecimal characters of SHA-256 over a
 * canonical domain object. The generator never concatenates variable-length
 * strings with delimiters. It checks the full digest behind every shortened
 * ID and extends every colliding ID deterministically to 32 characters.
 */

import {
  canonicalJsonSha256,
  invalidInput,
  isSha256Hex,
  DiagnosticCode,
  type JsonObject
} from "@oal/core";

import { SchedulerCode } from "./codes.ts";

/** Schema version of every hashed control-ID document. */
export const CONTROL_ID_SCHEMA_VERSION = 1;

/** Hexadecimal characters every control ID starts with. */
export const CONTROL_ID_MIN_HEX = 24;

/** Hexadecimal characters a colliding control ID extends to. */
export const CONTROL_ID_MAX_HEX = 32;

/** Grammar of a generated control ID. */
export const CONTROL_ID_PATTERN = /^(asg|bat|run)_[a-f0-9]{24,32}$/;

export type ControlIdPrefix = "asg" | "bat" | "run";

export function isControlId(value: string): boolean {
  return CONTROL_ID_PATTERN.test(value);
}

/** Canonical document hashed for one control ID. */
export function controlIdDocument(
  prefix: ControlIdPrefix,
  domain: JsonObject
): JsonObject {
  return {
    schema_version: CONTROL_ID_SCHEMA_VERSION,
    id_prefix: prefix,
    ...domain
  };
}

/**
 * One ID to allocate. `key` is the caller-side name of the ID; `domain` is
 * the canonical object the ID is derived from.
 */
export interface ControlIdSeed {
  readonly key: string;
  readonly prefix: ControlIdPrefix;
  readonly domain: JsonObject;
}

/** One allocated ID with the full digest kept for collision checks. */
export interface AllocatedControlId {
  readonly key: string;
  readonly prefix: ControlIdPrefix;
  readonly id: string;
  readonly sha256: string;
  /** Number of hexadecimal characters used after the prefix. */
  readonly hexLength: number;
}

export interface ControlIdAllocation {
  readonly byKey: ReadonlyMap<string, AllocatedControlId>;
  readonly list: readonly AllocatedControlId[];
  /** Keys whose ID was extended because of a 24-character prefix clash. */
  readonly extended: readonly string[];
}

/** Full-digest check behind every shortened ID. */
export function requireFullDigest(digest: string): string {
  if (!isSha256Hex(digest)) {
    throw invalidInput(
      DiagnosticCode.HashMismatch,
      `A control ID digest must be a lowercase 64-character SHA-256 value, got ${JSON.stringify(digest)}.`
    );
  }
  return digest;
}

/**
 * Hexadecimal length of every ID in one allocation group. Two distinct full
 * digests that share their first 24 characters force every member of that
 * clash group to 32 characters, so all colliding IDs change together.
 */
export function resolveControlIdLengths(digests: readonly string[]): number[] {
  const clashGroups = new Map<string, Set<string>>();
  for (const digest of digests) {
    requireFullDigest(digest);
    const short = digest.slice(0, CONTROL_ID_MIN_HEX);
    const members = clashGroups.get(short) ?? new Set<string>();
    members.add(digest);
    clashGroups.set(short, members);
  }
  return digests.map((digest) => {
    const members = clashGroups.get(digest.slice(0, CONTROL_ID_MIN_HEX));
    return members !== undefined && members.size > 1
      ? CONTROL_ID_MAX_HEX
      : CONTROL_ID_MIN_HEX;
  });
}

/** Render one control ID from its full digest and hexadecimal length. */
export function controlIdFromDigest(
  prefix: ControlIdPrefix,
  digest: string,
  hexLength: number = CONTROL_ID_MIN_HEX
): string {
  requireFullDigest(digest);
  if (hexLength !== CONTROL_ID_MIN_HEX && hexLength !== CONTROL_ID_MAX_HEX) {
    throw invalidInput(
      DiagnosticCode.ConfigInvalid,
      `A control ID uses ${String(CONTROL_ID_MIN_HEX)} or ${String(
        CONTROL_ID_MAX_HEX
      )} hexadecimal characters, got ${String(hexLength)}.`
    );
  }
  const id = `${prefix}_${digest.slice(0, hexLength)}`;
  if (!isControlId(id)) {
    throw invalidInput(
      SchedulerCode.ControlIdInvalid,
      `Rendered control ID ${JSON.stringify(id)} is not a valid control ID.`
    );
  }
  return id;
}

/** Digest function of one allocation. Injectable for tests only. */
export type ControlIdDigestFn = (
  prefix: ControlIdPrefix,
  domain: JsonObject
) => string;

export interface ControlIdOptions {
  /**
   * Digest source of the IDs. Production code always uses the default
   * SHA-256 over the canonical domain document.
   */
  readonly digestOf?: ControlIdDigestFn | undefined;
}

/**
 * Allocate every control ID of one schedule in a single pass so that a
 * shortened clash is detected across the whole set. Duplicate keys, and two
 * entries of the same prefix with the same full digest, are rejected: no
 * deterministic extension can separate them.
 */
export function allocateControlIds(
  seeds: readonly ControlIdSeed[],
  options: ControlIdOptions = {}
): ControlIdAllocation {
  const digestOf =
    options.digestOf ??
    ((prefix: ControlIdPrefix, domain: JsonObject): string =>
      canonicalJsonSha256(controlIdDocument(prefix, domain)));
  const digests: string[] = [];
  const byKeySeen = new Set<string>();
  const byPrefixDigest = new Map<string, Set<string>>();

  for (const seed of seeds) {
    if (seed.key.length === 0) {
      throw invalidInput(
        DiagnosticCode.ConfigInvalid,
        "A control ID seed needs a non-empty key."
      );
    }
    if (byKeySeen.has(seed.key)) {
      throw invalidInput(
        SchedulerCode.ControlIdInvalid,
        `Control ID key ${JSON.stringify(seed.key)} is allocated more than once.`
      );
    }
    byKeySeen.add(seed.key);
    const digest = requireFullDigest(digestOf(seed.prefix, seed.domain));
    digests.push(digest);
    const prefixKey = `${seed.prefix}:${digest}`;
    const members = byPrefixDigest.get(prefixKey) ?? new Set<string>();
    members.add(seed.key);
    byPrefixDigest.set(prefixKey, members);
  }

  for (const [prefixKey, members] of byPrefixDigest) {
    if (members.size > 1) {
      throw invalidInput(
        SchedulerCode.ControlIdCollision,
        `Two control IDs of prefix ${JSON.stringify(
          prefixKey.split(":")[0]
        )} hash to the same domain object: ${[...members].join(", ")}.`
      );
    }
  }

  // A clash can only shorten IDs of the same prefix, so each prefix resolves
  // its own group. `asg_` and `run_` never compete for the same characters.
  const lengths: number[] = [];
  for (const prefix of ["asg", "bat", "run"] as const) {
    const indexes: number[] = [];
    seeds.forEach((seed, index) => {
      if (seed.prefix === prefix) {
        indexes.push(index);
      }
    });
    if (indexes.length === 0) {
      continue;
    }
    const groupLengths = resolveControlIdLengths(
      indexes.map((index) => digests[index] as string)
    );
    indexes.forEach((index, position) => {
      lengths[index] = groupLengths[position] as number;
    });
  }
  const list: AllocatedControlId[] = [];
  const byKey = new Map<string, AllocatedControlId>();
  const extended: string[] = [];
  const seenIds = new Set<string>();
  seeds.forEach((seed, index) => {
    const digest = digests[index] as string;
    const hexLength = lengths[index] as number;
    const id = controlIdFromDigest(seed.prefix, digest, hexLength);
    if (seenIds.has(id)) {
      throw invalidInput(
        SchedulerCode.ControlIdCollision,
        `Control ID ${JSON.stringify(
          id
        )} was allocated twice; the 32-character extension did not separate the colliding digests.`
      );
    }
    seenIds.add(id);
    if (hexLength > CONTROL_ID_MIN_HEX) {
      extended.push(seed.key);
    }
    const allocated: AllocatedControlId = {
      key: seed.key,
      prefix: seed.prefix,
      id,
      sha256: digest,
      hexLength
    };
    list.push(allocated);
    byKey.set(seed.key, allocated);
  });

  return { byKey, list, extended };
}

/** Assignment identity inside one StudyRun. */
export interface AssignmentControlDomain {
  readonly study_run_id: string;
  readonly phase_id: string;
  readonly cell_id: string;
  readonly assignment_kind: "primary" | "held_replacement";
  readonly block_id: number | null;
  readonly repetition_index: number | null;
  readonly reserve_index: number | null;
}

/** Canonical domain object of one assignment. */
export function assignmentDomainObject(
  domain: AssignmentControlDomain
): JsonObject {
  return {
    study_run_id: domain.study_run_id,
    phase_id: domain.phase_id,
    cell_id: domain.cell_id,
    assignment_kind: domain.assignment_kind,
    block_id: domain.block_id,
    repetition_index: domain.repetition_index,
    reserve_index: domain.reserve_index
  };
}

/**
 * Canonical domain object of the run of one assignment. The tuple equals the
 * assignment tuple, so only the `id_prefix` separates `asg_` from `run_`.
 */
export function runDomainObject(domain: AssignmentControlDomain): JsonObject {
  return assignmentDomainObject(domain);
}

/** Identity of one child batch: one cell of one StudyRun phase. */
export interface ChildBatchControlDomain {
  readonly study_run_id: string;
  readonly phase_id: string;
  readonly cell_id: string;
}

/** Canonical domain object of one child batch. */
export function childBatchDomainObject(
  domain: ChildBatchControlDomain
): JsonObject {
  return {
    study_run_id: domain.study_run_id,
    phase_id: domain.phase_id,
    cell_id: domain.cell_id
  };
}
