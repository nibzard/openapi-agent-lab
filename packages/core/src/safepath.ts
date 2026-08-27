import { realpath } from "node:fs/promises";
import path from "node:path";

import { invalidInput } from "./errors.ts";
import { DiagnosticCode } from "./diagnostic.ts";

const NUL = "\0";

/**
 * Assert a pack-or-study-relative POSIX path: no absolute path, no parent
 * traversal, no NUL bytes, no backslash segments, no drive letters, and a
 * bounded length. Empty segments other than a trailing slash are rejected.
 */
export function assertSafeRelativePath(input: string, what: string): string {
  if (input.length === 0 || input.length > 1024) {
    throw invalidInput(
      DiagnosticCode.ConfigInvalid,
      `${what} has an invalid length.`,
      { path: input }
    );
  }
  if (input.includes(NUL)) {
    throw invalidInput(
      DiagnosticCode.ConfigInvalid,
      `${what} contains a NUL byte.`
    );
  }
  if (input.includes("\\")) {
    throw invalidInput(
      DiagnosticCode.ConfigInvalid,
      `${what} must use POSIX separators.`,
      { path: input }
    );
  }
  if (path.isAbsolute(input) || input.startsWith("/")) {
    throw invalidInput(
      DiagnosticCode.RefOutsideRoot,
      `${what} must be relative.`,
      { path: input }
    );
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw invalidInput(
      DiagnosticCode.ConfigInvalid,
      `${what} must not use a drive letter.`,
      { path: input }
    );
  }
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalidInput(
        DiagnosticCode.RefOutsideRoot,
        `${what} must not contain empty, dot, or parent segments.`,
        { path: input }
      );
    }
  }
  return input;
}

export function isSafeRelativePath(input: string): boolean {
  try {
    assertSafeRelativePath(input, "path");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `relative` inside `root` and prove through `realpath` that the
 * target stays inside the canonical root. Symlink escape is rejected.
 */
export async function resolveWithinRoot(
  root: string,
  relative: string,
  what: string
): Promise<string> {
  assertSafeRelativePath(relative, what);
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, relative);
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(candidate);
  } catch {
    throw invalidInput(
      DiagnosticCode.RefNotFound,
      `${what} does not exist inside the root.`,
      { path: relative }
    );
  }
  if (
    resolvedTarget !== canonicalRoot &&
    !isWithin(canonicalRoot, resolvedTarget)
  ) {
    throw invalidInput(
      DiagnosticCode.RefOutsideRoot,
      `${what} resolves outside the root.`,
      { path: relative }
    );
  }
  return resolvedTarget;
}

/** Lexical containment check on resolved absolute paths. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Percent-decode a path segment exactly once after syntax validation.
 * Invalid percent encoding returns `null`; callers map that to a bounded
 * client error before any behavior runs.
 */
export function decodePathSegment(segment: string): string | null {
  // After stripping valid percent triplets, the remainder must be RFC 3986
  // pchar characters only: unreserved, sub-delims, ":", "@".
  if (
    !/^[A-Za-z0-9\-._~!$&'()*+,;=:@]*$/.test(
      segment.replace(/%[0-9A-Fa-f]{2}/g, "")
    )
  ) {
    return null;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
