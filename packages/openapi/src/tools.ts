import { isToolName } from "@oal/core";

/**
 * Deterministic tool naming from specification sections 13.3 and 18.2.
 *
 * 1. A unique operationId that already matches the tool grammar is used.
 * 2. Otherwise the compiler derives a name from the method and the path.
 * 3. A six-character UID suffix resolves any remaining collision.
 */

/** Truncation reserves seven characters for `_` plus six UID characters. */
const SUFFIX_ROOM = 7;
const MAX_TOOL_NAME = 64;

export interface ToolNameCandidate {
  readonly key: string;
  readonly uid: string;
  readonly operationId: string | null;
}

export interface ToolNameAssignment {
  readonly tool_name: string;
  /** True when the name was derived from the method and path. */
  readonly generated: boolean;
  /** True when a UID suffix was needed to break a collision. */
  readonly suffixed: boolean;
}

export interface ToolNameResult {
  readonly assignments: Map<string, ToolNameAssignment>;
  /** Names that collided and needed a suffix, sorted. */
  readonly collisions: string[];
}

/** Sanitize one path segment into tool-name characters. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Derive a deterministic name from the HTTP method and the path template. */
export function generateToolName(method: string, pathTemplate: string): string {
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
  const joined = parts
    .join("_")
    .replace(/_{2,}/g, "_")
    .replace(/_+$/, "")
    .slice(0, MAX_TOOL_NAME);
  if (joined.length === 0) {
    return "op";
  }
  if (/[A-Za-z]/.test(joined[0] as string)) {
    return joined;
  }
  return `op_${joined}`.slice(0, MAX_TOOL_NAME);
}

function withSuffix(base: string, uid: string): string {
  const stem = base.slice(0, MAX_TOOL_NAME - SUFFIX_ROOM).replace(/_+$/, "");
  const suffix = uid.replace(/^op_/, "").slice(0, 6);
  return `${stem}_${suffix}`;
}

/**
 * Assign a unique tool name to every operation. Unique grammar-valid
 * operationIds win; every other operation gets a generated name; any
 * remaining collision is broken by a UID suffix.
 */
export function assignToolNames(
  candidates: readonly ToolNameCandidate[]
): ToolNameResult {
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
  const reserved = new Set<string>();
  for (const [id, count] of idCounts) {
    if (count === 1 && isToolName(id)) {
      reserved.add(id);
    }
  }

  const ordered = [...candidates].sort((a, b) => (a.key < b.key ? -1 : 1));
  const used = new Set<string>();
  const collisions = new Set<string>();
  const assignments = new Map<string, ToolNameAssignment>();
  for (const candidate of ordered) {
    const id = candidate.operationId;
    const earnsId =
      id !== null &&
      idCounts.get(id) === 1 &&
      isToolName(id) &&
      reserved.has(id);
    let base = earnsId ? id : derivedName(candidate);
    let generated = !earnsId;
    let suffixed = false;
    if (reserved.has(base) && !earnsId) {
      base = withSuffix(base, candidate.uid);
      generated = true;
      suffixed = true;
    }
    while (used.has(base)) {
      collisions.add(base);
      base = withSuffix(base, candidate.uid);
      generated = true;
      suffixed = true;
    }
    used.add(base);
    assignments.set(candidate.key, { tool_name: base, generated, suffixed });
  }
  return { assignments, collisions: [...collisions].sort() };
}

function derivedName(candidate: ToolNameCandidate): string {
  const space = candidate.key.indexOf(" ");
  if (space < 0) {
    return generateToolName("get", "/");
  }
  const method = candidate.key.slice(0, space).replace(/^.*:/, "");
  return generateToolName(method, candidate.key.slice(space + 1));
}
