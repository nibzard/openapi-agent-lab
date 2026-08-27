/**
 * RFC 6902 JSON Patch application with strict JSON-Pointer validation and the
 * per-layer pointer allowlist that a ContractVariantSet declares.
 *
 * Every function here is pure: documents and patches arrive as parameters and
 * no operation mutates its input.
 */

import { jsonClone, jsonEquals, type Json, type JsonObject } from "@oal/core";

/** Operation names defined by RFC 6902 section 4. */
export type JsonPatchOperationKind =
  | "add"
  | "remove"
  | "replace"
  | "move"
  | "copy"
  | "test";

export interface JsonPatchOperation {
  readonly op: JsonPatchOperationKind;
  readonly path: string;
  readonly from?: string;
  readonly value?: Json;
}

/**
 * RFC 6901 syntax restricted exactly as the variant schemas restrict it: the
 * empty pointer, or a slash-prefixed path whose tokens escape `~` and `/` as
 * `~0` and `~1`.
 */
export const JSON_POINTER_PATTERN = /^(\/([^/~]|~[01])*)*$/;

/** Layers a structural difference can be attributed to. */
export type DifferenceLayer = "common-projection" | "variant" | "unrelated";

/** Stable diagnostic codes for patch validation and application. */
export const PatchCode = {
  PointerInvalid: "OAL-CV-PATCH-POINTER-INVALID",
  PointerMissing: "OAL-CV-PATCH-POINTER-MISSING",
  ParentMissing: "OAL-CV-PATCH-PARENT-MISSING",
  ParentNotContainer: "OAL-CV-PATCH-PARENT-NOT-CONTAINER",
  IndexInvalid: "OAL-CV-PATCH-INDEX-INVALID",
  IndexOutOfRange: "OAL-CV-PATCH-INDEX-OUT-OF-RANGE",
  ValueMissing: "OAL-CV-PATCH-VALUE-MISSING",
  FromMissing: "OAL-CV-PATCH-FROM-MISSING",
  FromPrefixOfPath: "OAL-CV-PATCH-FROM-PREFIX",
  TestFailed: "OAL-CV-PATCH-TEST-FAILED",
  RootRemove: "OAL-CV-PATCH-ROOT-REMOVE",
  OpUnknown: "OAL-CV-PATCH-OP-UNKNOWN",
  AllowlistViolation: "OAL-CV-PATCH-ALLOWLIST"
} as const;

/** One rejected patch operation or pointer. */
export interface PatchIssue {
  readonly code: string;
  readonly message: string;
  readonly pointer: string;
  /** Index of the offending operation inside the patch, when known. */
  readonly index?: number;
}

export type JsonPatchResult =
  | { readonly ok: true; readonly document: Json }
  | { readonly ok: false; readonly issues: readonly PatchIssue[] };

function issue(
  code: string,
  message: string,
  pointer: string,
  index?: number
): PatchIssue {
  return { code, message, pointer, ...(index === undefined ? {} : { index }) };
}

/** Decode one RFC 6901 escape sequence pair. */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Escape one token for embedding in a JSON Pointer. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Split a JSON Pointer into its tokens. Returns `null` when the pointer is not
 * valid RFC 6901 as restricted above.
 */
export function parseJsonPointer(pointer: string): readonly string[] | null {
  if (!JSON_POINTER_PATTERN.test(pointer)) {
    return null;
  }
  if (pointer === "") {
    return [];
  }
  return pointer.slice(1).split("/").map(unescapeToken);
}

/** Render tokens back into pointer form. */
export function formatJsonPointer(tokens: readonly string[]): string {
  if (tokens.length === 0) {
    return "";
  }
  return `/${tokens.map(escapeToken).join("/")}`;
}

/** True when `pointer` addresses the root or anything below `prefix`. */
export function pointerWithin(pointer: string, prefix: string): boolean {
  if (prefix === "") {
    return true;
  }
  if (pointer === prefix) {
    return true;
  }
  return pointer.startsWith(`${prefix}/`);
}

/** True when any allowlist entry covers `pointer`. */
export function allowlistCovers(
  pointer: string,
  allowlist: readonly string[]
): boolean {
  return allowlist.some((entry) => pointerWithin(pointer, entry));
}

/**
 * Attribute one pointer to its layer: the common projection when that
 * allowlist covers it, the variant when that allowlist covers it, and
 * `unrelated` otherwise.
 */
export function classifyPointerLayer(
  pointer: string,
  commonAllowlist: readonly string[] | null,
  variantAllowlist: readonly string[]
): DifferenceLayer {
  if (commonAllowlist !== null && allowlistCovers(pointer, commonAllowlist)) {
    return "common-projection";
  }
  if (allowlistCovers(pointer, variantAllowlist)) {
    return "variant";
  }
  return "unrelated";
}

/**
 * Check that every operation pointer, including the `from` pointer of `move`
 * and `copy`, falls inside one layer's allowlist. Reading through an
 * undeclared pointer is rejected too, so no patch can smuggle content from an
 * undeclared location into a declared one.
 */
export function checkPatchAllowlist(
  patch: readonly JsonPatchOperation[],
  allowlist: readonly string[],
  layer: string
): readonly PatchIssue[] {
  const issues: PatchIssue[] = [];
  patch.forEach((operation, index) => {
    const pointers: readonly string[] =
      operation.op === "move" || operation.op === "copy"
        ? [operation.path, operation.from ?? operation.path]
        : [operation.path];
    for (const pointer of pointers) {
      if (parseJsonPointer(pointer) === null) {
        issues.push(
          issue(
            PatchCode.PointerInvalid,
            `The ${layer} patch pointer is not valid RFC 6901.`,
            pointer,
            index
          )
        );
        continue;
      }
      if (!allowlistCovers(pointer, allowlist)) {
        issues.push(
          issue(
            PatchCode.AllowlistViolation,
            `The ${layer} patch touches ${pointer}, which the ${layer} allowlist does not declare.`,
            pointer,
            index
          )
        );
      }
    }
  });
  return issues;
}

/**
 * True when two allowlists are disjoint in pointer space: no entry of one
 * covers, or is covered by, an entry of the other. Layer attribution stays
 * unambiguous only while this holds.
 */
export function allowlistsOverlap(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.some((l) =>
    right.some((r) => pointerWithin(l, r) || pointerWithin(r, l))
  );
}

function isIssue(value: unknown): value is PatchIssue {
  return (
    typeof value === "object" && value !== null && Object.hasOwn(value, "code")
  );
}

type Container = JsonObject | Json[];

interface Location {
  readonly container: Container;
  readonly token: string;
}

function isContainer(value: Json | undefined): value is Container {
  return Array.isArray(value) || (typeof value === "object" && value !== null);
}

/** Strict RFC 6901 array index. Leading zeros are rejected. */
function arrayIndex(token: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    return null;
  }
  return Number(token);
}

/**
 * Walk to the parent container of the final token. Intermediate tokens must
 * exist and must address objects or arrays; scalars and nulls end the walk
 * with a diagnostic.
 */
function locateParent(
  root: Json,
  tokens: readonly string[],
  pointer: string
): Location | PatchIssue {
  if (tokens.length === 0) {
    return issue(
      PatchCode.RootRemove,
      "The whole document has no parent container.",
      pointer
    );
  }
  let current: Json = root;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (Array.isArray(current)) {
      const index = arrayIndex(token);
      if (index === null || index >= current.length) {
        return issue(
          PatchCode.PointerMissing,
          `The pointer addresses an array element that does not exist.`,
          pointer
        );
      }
      current = current[index] as Json;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const next: Json | undefined = current[token];
      if (next === undefined) {
        return issue(
          PatchCode.PointerMissing,
          `The pointer addresses an object member that does not exist.`,
          pointer
        );
      }
      current = next;
      continue;
    }
    return issue(
      PatchCode.ParentNotContainer,
      "The pointer traverses through a scalar or null value.",
      pointer
    );
  }
  const parent: Json | undefined = current;
  if (!isContainer(parent)) {
    return issue(
      PatchCode.ParentNotContainer,
      "The parent of the target is not an object or an array.",
      pointer
    );
  }
  return { container: parent, token: tokens[tokens.length - 1] as string };
}

function readAt(
  root: Json,
  tokens: readonly string[],
  pointer: string
): Json | PatchIssue {
  if (tokens.length === 0) {
    return root;
  }
  const located = locateParent(root, tokens, pointer);
  if (isIssue(located)) {
    return located;
  }
  const { container, token } = located;
  if (Array.isArray(container)) {
    const index = arrayIndex(token);
    if (index === null || index >= container.length) {
      return issue(
        PatchCode.PointerMissing,
        "The pointer addresses an array element that does not exist.",
        pointer
      );
    }
    return container[index] as Json;
  }
  const value: Json | undefined = container[token];
  if (value === undefined) {
    return issue(
      PatchCode.PointerMissing,
      "The pointer addresses an object member that does not exist.",
      pointer
    );
  }
  return value;
}

function removeAt(
  root: Json,
  tokens: readonly string[],
  pointer: string
): Json | PatchIssue {
  if (tokens.length === 0) {
    return issue(
      PatchCode.RootRemove,
      "The whole document cannot be removed.",
      pointer
    );
  }
  const located = locateParent(root, tokens, pointer);
  if (isIssue(located)) {
    return located;
  }
  const { container, token } = located;
  if (Array.isArray(container)) {
    const index = arrayIndex(token);
    if (index === null || index >= container.length) {
      return issue(
        PatchCode.PointerMissing,
        "The pointer addresses an array element that does not exist.",
        pointer
      );
    }
    container.splice(index, 1);
    return root;
  }
  if (!Object.hasOwn(container, token)) {
    return issue(
      PatchCode.PointerMissing,
      "The pointer addresses an object member that does not exist.",
      pointer
    );
  }
  // Reflect form: the token is data, so the delete operator is not allowed.
  Reflect.deleteProperty(container, token);
  return root;
}

function addAt(
  root: Json,
  tokens: readonly string[],
  value: Json,
  pointer: string
): Json | PatchIssue {
  if (tokens.length === 0) {
    return value;
  }
  const located = locateParent(root, tokens, pointer);
  if (isIssue(located)) {
    return located;
  }
  const { container, token } = located;
  if (Array.isArray(container)) {
    if (token === "-") {
      container.push(value);
      return root;
    }
    const index = arrayIndex(token);
    if (index === null) {
      return issue(
        PatchCode.IndexInvalid,
        `The array token '${token}' is not a valid index or '-'.`,
        pointer
      );
    }
    if (index > container.length) {
      return issue(
        PatchCode.IndexOutOfRange,
        `The array index ${index} is greater than the array length ${container.length}.`,
        pointer
      );
    }
    container.splice(index, 0, value);
    return root;
  }
  container[token] = value;
  return root;
}

function writeAt(
  root: Json,
  tokens: readonly string[],
  value: Json,
  pointer: string
): Json | PatchIssue {
  if (tokens.length === 0) {
    return value;
  }
  const located = locateParent(root, tokens, pointer);
  if (isIssue(located)) {
    return located;
  }
  const { container, token } = located;
  if (Array.isArray(container)) {
    const index = arrayIndex(token);
    if (index === null) {
      return issue(
        PatchCode.IndexInvalid,
        `The array token '${token}' is not a valid index.`,
        pointer
      );
    }
    if (index >= container.length) {
      return issue(
        PatchCode.IndexOutOfRange,
        `The array index ${index} is outside the array length ${container.length}.`,
        pointer
      );
    }
    container[index] = value;
    return root;
  }
  if (!Object.hasOwn(container, token)) {
    return issue(
      PatchCode.PointerMissing,
      "Replace addresses an object member that does not exist.",
      pointer
    );
  }
  container[token] = value;
  return root;
}

/**
 * Apply one RFC 6902 patch to `document` and return the resulting document.
 * The input document is never mutated. Application is all-or-nothing: the
 * first rejected operation stops the patch and reports every issue found so
 * far, and no partially patched document escapes.
 */
export function applyJsonPatch(
  document: Json,
  patch: readonly JsonPatchOperation[]
): JsonPatchResult {
  let work: Json = jsonClone(document);
  for (let i = 0; i < patch.length; i += 1) {
    const stepped = applyOperation(work, patch[i] as JsonPatchOperation);
    if (!stepped.ok) {
      return {
        ok: false,
        issues: stepped.issues.map((entry) => ({ ...entry, index: i }))
      };
    }
    work = stepped.document;
  }
  return { ok: true, document: work };
}

function applyOperation(
  document: Json,
  operation: JsonPatchOperation
): JsonPatchResult {
  const tokens = parseJsonPointer(operation.path);
  if (tokens === null) {
    return {
      ok: false,
      issues: [
        issue(
          PatchCode.PointerInvalid,
          `The '${operation.op}' path is not valid RFC 6901.`,
          operation.path
        )
      ]
    };
  }
  switch (operation.op) {
    case "add": {
      if (operation.value === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.ValueMissing,
              "An 'add' operation requires a 'value' member.",
              operation.path
            )
          ]
        };
      }
      const result = addAt(document, tokens, operation.value, operation.path);
      return asResult(result);
    }
    case "replace": {
      if (operation.value === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.ValueMissing,
              "A 'replace' operation requires a 'value' member.",
              operation.path
            )
          ]
        };
      }
      const result = writeAt(document, tokens, operation.value, operation.path);
      return asResult(result);
    }
    case "remove": {
      const result = removeAt(document, tokens, operation.path);
      return asResult(result);
    }
    case "test": {
      if (operation.value === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.ValueMissing,
              "A 'test' operation requires a 'value' member.",
              operation.path
            )
          ]
        };
      }
      const current = readAt(document, tokens, operation.path);
      if (isIssue(current)) {
        return { ok: false, issues: [current] };
      }
      if (!jsonEquals(current, operation.value)) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.TestFailed,
              "The 'test' operation failed: the value at the path differs.",
              operation.path
            )
          ]
        };
      }
      return { ok: true, document };
    }
    case "copy":
    case "move": {
      if (operation.from === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.FromMissing,
              `A '${operation.op}' operation requires a 'from' member.`,
              operation.path
            )
          ]
        };
      }
      const fromTokens = parseJsonPointer(operation.from);
      if (fromTokens === null) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.PointerInvalid,
              `The 'from' pointer of '${operation.op}' is not valid RFC 6901.`,
              operation.from
            )
          ]
        };
      }
      if (
        operation.op === "move" &&
        operation.from !== operation.path &&
        pointerWithin(operation.path, operation.from)
      ) {
        return {
          ok: false,
          issues: [
            issue(
              PatchCode.FromPrefixOfPath,
              "The 'from' pointer is a prefix of the destination path.",
              operation.path
            )
          ]
        };
      }
      const source = readAt(document, fromTokens, operation.from);
      if (isIssue(source)) {
        return { ok: false, issues: [source] };
      }
      const value = jsonClone(source);
      if (operation.op === "copy") {
        const result = addAt(document, tokens, value, operation.path);
        return asResult(result);
      }
      const removed = removeAt(document, fromTokens, operation.from);
      if (isIssue(removed)) {
        return { ok: false, issues: [removed] };
      }
      const result = addAt(removed, tokens, value, operation.path);
      return asResult(result);
    }
    default: {
      const exhaustive: never = operation.op;
      return {
        ok: false,
        issues: [
          issue(
            PatchCode.OpUnknown,
            `Unknown patch operation '${String(exhaustive)}'.`,
            operation.path
          )
        ]
      };
    }
  }
}

function asResult(result: Json | PatchIssue): JsonPatchResult {
  if (isIssue(result)) {
    return { ok: false, issues: [result] };
  }
  return { ok: true, document: result };
}
