/**
 * Direct tool naming (specification sections 13.3 and 18.2).
 *
 * 1. A unique operationId that already matches the tool grammar is used.
 * 2. Otherwise the name derives from the method and the path template.
 * 3. A six-character UID suffix resolves any remaining collision.
 * 4. The complete operation-to-tool map is frozen and digestible.
 * 5. Preflight fails when the adapter constraints cannot be met.
 */

import {
  canonicalJsonSha256,
  isToolName,
  unsupported,
  type JsonObject
} from "@oal/core";
import type { OperationIR } from "@oal/contract-ir";

/** One underscore character plus six UID characters. */
const SUFFIX_ROOM = 7;
const UID_SUFFIX_LENGTH = 6;

/**
 * Adapter naming constraints. The defaults match the shared tool grammar:
 * at most 64 characters from `[A-Za-z0-9_-]`, starting with a letter.
 */
export interface NamingConstraints {
  /** Largest tool name length. */
  maxLength: number;
  /** Allowed characters for a complete name. */
  pattern: RegExp;
  /** Characters reserved for the collision suffix. */
  suffixRoom: number;
}

export const DEFAULT_NAMING_CONSTRAINTS: NamingConstraints = Object.freeze({
  maxLength: 64,
  pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
  suffixRoom: SUFFIX_ROOM
});

/** One operation reduced to the fields naming needs. */
export interface NamingCandidate {
  key: string;
  uid: string;
  operationId: string | null;
  method: string;
  pathTemplate: string;
}

/** Assignment result for one operation. */
export interface ToolNameAssignment {
  toolName: string;
  /** True when the name came from a unique, valid operationId. */
  fromOperationId: boolean;
  /** True when the name derived from the method and the path. */
  generated: boolean;
  /** True when a UID suffix broke a collision. */
  suffixed: boolean;
}

/** Frozen operation-to-tool map for one batch of operations. */
export interface DirectToolMap {
  /** Assignments in ascending canonical-key order. */
  assignments: ReadonlyArray<{ key: string; uid: string } & ToolNameAssignment>;
  /** Tool name to canonical key, for dispatch. */
  toolToOperation: ReadonlyMap<string, string>;
  /** Names that needed a UID suffix, sorted. */
  collisions: string[];
  /** SHA-256 over the canonical JSON of the sorted name map. */
  digest: string;
  constraints: NamingConstraints;
}

/** Reduce contract operations to the fields naming needs. */
export function namingCandidates(
  operations: readonly OperationIR[]
): NamingCandidate[] {
  return operations.map((operation) => ({
    key: operation.key,
    uid: operation.uid,
    operationId: operation.operation_id,
    method: operation.method,
    pathTemplate: operation.path_template
  }));
}

function constraintFailure(message: string, details?: JsonObject): Error {
  return unsupported("OAL-TOOL-NAME-CONSTRAINT", message, details);
}

/**
 * Check one constraint set before any name is derived. A set fails when it
 * leaves no room for a name stem, or when its pattern rejects every usable
 * stem length.
 */
export function assertNamingConstraints(
  constraints: NamingConstraints
): NamingConstraints {
  if (
    !Number.isInteger(constraints.maxLength) ||
    constraints.maxLength < 1 ||
    constraints.maxLength > 4096
  ) {
    throw constraintFailure("The maximum tool name length is not usable.", {
      maxLength: constraints.maxLength
    });
  }
  if (
    !Number.isInteger(constraints.suffixRoom) ||
    constraints.suffixRoom < UID_SUFFIX_LENGTH
  ) {
    throw constraintFailure(
      "The reserved suffix room must leave space for the UID suffix.",
      { suffixRoom: constraints.suffixRoom }
    );
  }
  const stemLength = constraints.maxLength - constraints.suffixRoom;
  if (stemLength < 1) {
    throw constraintFailure(
      "The maximum tool name length leaves no room for a name stem.",
      { maxLength: constraints.maxLength, suffixRoom: constraints.suffixRoom }
    );
  }
  if (!constraints.pattern.test("a".repeat(stemLength))) {
    throw constraintFailure(
      "The naming pattern rejects every name of usable length.",
      { pattern: constraints.pattern.source, stemLength }
    );
  }
  return Object.freeze({ ...constraints });
}

/** Sanitize one path segment into tool-name characters. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Derive a deterministic name from the method and the path template. */
export function generateToolName(
  method: string,
  pathTemplate: string,
  constraints: NamingConstraints = DEFAULT_NAMING_CONSTRAINTS
): string {
  const parts: string[] = [method.toLowerCase()];
  for (const raw of pathTemplate.split("/")) {
    if (raw === "") {
      continue;
    }
    const isParameter = raw.startsWith("{") && raw.endsWith("}");
    const body = isParameter ? raw.slice(1, -1) : raw;
    const sanitized = sanitizeSegment(body);
    if (sanitized === "") {
      continue;
    }
    parts.push(isParameter ? `by_${sanitized}` : sanitized);
  }
  let joined = parts.join("_").replace(/_{2,}/g, "_").replace(/_+$/, "");
  if (joined.length === 0 || !/[A-Za-z]/.test(joined[0] as string)) {
    joined = joined.length === 0 ? "op" : `op_${joined}`;
  }
  joined = joined.slice(0, constraints.maxLength);
  if (!constraints.pattern.test(joined)) {
    throw constraintFailure("The generated tool name is not valid.", {
      name: joined,
      pattern: constraints.pattern.source
    });
  }
  return joined;
}

function withSuffix(
  base: string,
  uid: string,
  constraints: NamingConstraints
): string {
  const stem = base
    .slice(0, constraints.maxLength - constraints.suffixRoom)
    .replace(/_+$/, "");
  const suffix = uid.replace(/^op_/, "").slice(0, UID_SUFFIX_LENGTH);
  if (suffix.length !== UID_SUFFIX_LENGTH) {
    throw constraintFailure("The operation UID is too short for a suffix.", {
      uid
    });
  }
  const name = `${stem}_${suffix}`;
  if (!constraints.pattern.test(name)) {
    throw constraintFailure("The collision-suffixed tool name is not valid.", {
      name,
      pattern: constraints.pattern.source
    });
  }
  return name;
}

/**
 * Assign one unique tool name to every candidate, in ascending canonical-key
 * order. The returned map is frozen and digestible, so a batch input can
 * record the complete operation-to-tool mapping.
 */
export function buildDirectToolMap(
  candidates: readonly NamingCandidate[],
  constraints: NamingConstraints = DEFAULT_NAMING_CONSTRAINTS
): DirectToolMap {
  const checked = assertNamingConstraints(constraints);

  const idCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.operationId === null) {
      continue;
    }
    idCounts.set(
      candidate.operationId,
      (idCounts.get(candidate.operationId) ?? 0) + 1
    );
  }
  const earnedIds = new Set<string>();
  for (const [id, count] of idCounts) {
    if (count === 1 && isToolName(id)) {
      earnedIds.add(id);
    }
  }

  const ordered = [...candidates].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
  const used = new Set<string>();
  const collisions = new Set<string>();
  const assignments: Array<{ key: string; uid: string } & ToolNameAssignment> =
    [];
  const toolToOperation = new Map<string, string>();

  for (const candidate of ordered) {
    const earned =
      candidate.operationId !== null && earnedIds.has(candidate.operationId);
    let toolName = earned
      ? (candidate.operationId as string)
      : generateToolName(candidate.method, candidate.pathTemplate, checked);
    let suffixed = false;
    if (!earned && used.has(toolName)) {
      collisions.add(toolName);
      toolName = withSuffix(toolName, candidate.uid, checked);
      suffixed = true;
    }
    if (used.has(toolName)) {
      throw constraintFailure(
        "The naming constraints cannot produce a unique tool name.",
        { key: candidate.key, toolName }
      );
    }
    used.add(toolName);
    toolToOperation.set(toolName, candidate.key);
    assignments.push({
      key: candidate.key,
      uid: candidate.uid,
      toolName,
      fromOperationId: earned,
      generated: !earned,
      suffixed
    });
  }

  const frozen = Object.freeze(
    assignments.map((entry) => Object.freeze(entry))
  );
  const nameMap: JsonObject = {};
  for (const entry of frozen) {
    nameMap[entry.key] = entry.toolName;
  }
  return Object.freeze({
    assignments: frozen,
    toolToOperation,
    collisions: [...collisions].sort(),
    digest: canonicalJsonSha256(nameMap),
    constraints: checked
  });
}
