import {
  DiagnosticCode,
  invalidInput,
  isJsonObject,
  OalError,
  type Diagnostic,
  type Json,
  type JsonObject,
  unsupported
} from "@oal/core";

import type { CompilerLimits } from "./limits.ts";

/** Reference resolution policy from specification section 13.1. */
export interface RefPolicy {
  remote_refs: "deny" | "allow";
}

export const DEFAULT_REF_POLICY: RefPolicy = { remote_refs: "deny" };

export interface RefTarget {
  /** Document-relative POSIX path of the target document. */
  uri: string;
  /** JSON Pointer including the leading `#`, or `#` for the document root. */
  pointer: string;
}

export interface ResolvedNode {
  uri: string;
  pointer: string;
  value: Json;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Split a `$ref` value against the document that contains it. Remote,
 * absolute, and root-escaping references are rejected.
 */
export function splitRef(baseUri: string, ref: string): RefTarget {
  if (ref === "#") {
    return { uri: baseUri, pointer: "#" };
  }
  if (ref.startsWith("#/")) {
    return { uri: baseUri, pointer: ref };
  }
  if (SCHEME_PATTERN.test(ref)) {
    throw unsupported(
      DiagnosticCode.RefRemoteDisabled,
      `Remote reference is disabled by policy: ${maskRef(ref)}.`,
      { ref }
    );
  }
  if (ref.startsWith("//")) {
    throw unsupported(
      DiagnosticCode.RefRemoteDisabled,
      `Protocol-relative reference is disabled by policy: ${maskRef(ref)}.`,
      { ref }
    );
  }
  const hashIndex = ref.indexOf("#");
  const filePart = hashIndex < 0 ? ref : ref.slice(0, hashIndex);
  const pointerPart = hashIndex < 0 ? "#" : ref.slice(hashIndex);
  if (filePart === "") {
    return { uri: baseUri, pointer: pointerPart };
  }
  if (
    filePart.startsWith("/") ||
    filePart.includes("\0") ||
    filePart.includes("\\")
  ) {
    throw invalidInput(
      DiagnosticCode.RefOutsideRoot,
      `Reference target is outside the reference root: ${maskRef(ref)}.`,
      { ref }
    );
  }
  return {
    uri: normalizeRelativePath(baseUri, filePart),
    pointer: pointerPart
  };
}

/** Rewrite `../a/b.yaml` relative to a base document into a root-relative path. */
export function normalizeRelativePath(baseUri: string, target: string): string {
  const slash = baseUri.lastIndexOf("/");
  const dir = slash < 0 ? "" : baseUri.slice(0, slash);
  const combined = dir === "" ? target : `${dir}/${target}`;
  const out: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        throw invalidInput(
          DiagnosticCode.RefOutsideRoot,
          `Reference target is outside the reference root: ${maskRef(target)}.`,
          { ref: target }
        );
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw invalidInput(
      DiagnosticCode.RefOutsideRoot,
      `Reference target is outside the reference root: ${maskRef(target)}.`,
      { ref: target }
    );
  }
  return out.join("/");
}

function maskRef(ref: string): string {
  return ref.length > 96 ? `${ref.slice(0, 96)}...` : ref;
}

/**
 * Discover same-pack external reference targets in raw document text. Used
 * by the loader before any compilation happens; the compiler re-resolves
 * every reference authoritatively.
 */
export function discoverExternalRefs(baseUri: string, text: string): string[] {
  const found = new Set<string>();
  // The `$ref` key is quoted in JSON and usually bare in YAML, so the
  // opening quotes are optional.
  const pattern = /"?[$]ref"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(`"${raw}"`);
    } catch {
      continue;
    }
    if (typeof decoded !== "string") {
      continue;
    }
    const ref: string = decoded;
    if (ref === "" || ref.startsWith("#")) {
      continue;
    }
    if (SCHEME_PATTERN.test(ref) || ref.startsWith("//")) {
      continue;
    }
    const filePart = ref.split("#")[0] ?? "";
    if (filePart === "") {
      continue;
    }
    // Targets that reference resolution rejects as out-of-root never load,
    // so discovery must not chase them either; compilation reports them
    // with the pointer of the declaring node.
    if (
      filePart.startsWith("/") ||
      filePart.includes("\\") ||
      filePart.includes("\0")
    ) {
      continue;
    }
    try {
      found.add(normalizeRelativePath(baseUri, filePart));
    } catch {
      // Escaping references are diagnosed during compilation.
    }
  }
  return [...found].sort();
}

/**
 * Reference resolver over a frozen set of same-pack documents. Tracks unique
 * targets and traversal depth, refuses remote references, and detects
 * cycles.
 */
export class ReferenceResolver {
  private readonly targetKeys = new Set<string>();

  private readonly documents: ReadonlyMap<string, Json>;
  private readonly policy: RefPolicy;
  private readonly limits: CompilerLimits;
  private readonly fail: (diagnostic: Diagnostic) => never;

  constructor(
    documents: ReadonlyMap<string, Json>,
    policy: RefPolicy,
    limits: CompilerLimits,
    fail: (diagnostic: Diagnostic) => never
  ) {
    this.documents = documents;
    this.policy = policy;
    this.limits = limits;
    this.fail = fail;
  }

  get uniqueTargetCount(): number {
    return this.targetKeys.size;
  }

  /** Follow a `$ref` chain starting at one node, without deep traversal. */
  deref(uri: string, pointer: string, value: Json): ResolvedNode {
    const stack: string[] = [];
    let currentUri = uri;
    let currentPointer = pointer;
    let current = value;
    let depth = 0;
    for (;;) {
      if (!isJsonObject(current)) {
        return { uri: currentUri, pointer: currentPointer, value: current };
      }
      const ref = current.$ref;
      if (typeof ref !== "string") {
        return { uri: currentUri, pointer: currentPointer, value: current };
      }
      if (this.policy.remote_refs === "deny" && SCHEME_PATTERN.test(ref)) {
        this.fail(remoteDisabled(ref, currentUri, currentPointer));
      }
      const target = this.splitLocated(ref, currentUri, currentPointer);
      const key = `${target.uri}${target.pointer}`;
      if (stack.includes(key)) {
        this.fail(
          cycle(ref, currentUri, currentPointer, [...stack, key].sort())
        );
      }
      stack.push(key);
      this.remember(key, currentUri, currentPointer);
      depth += 1;
      if (depth > this.limits.maxTraversalDepth) {
        this.fail(depthLimit(currentUri, currentPointer));
      }
      const document = this.documents.get(target.uri);
      if (document === undefined) {
        this.fail(missing(ref, target, currentUri, currentPointer));
      }
      const resolved = resolvePointer(document, target.pointer);
      if (resolved === undefined) {
        this.fail(missing(ref, target, currentUri, currentPointer));
      }
      currentUri = target.uri;
      currentPointer = target.pointer;
      current = resolved;
    }
  }

  /**
   * Resolve a reference explicitly and return the target node. `pointer`
   * locates the declaring node, so rejections name it instead of the
   * document root.
   */
  resolve(uri: string, ref: string, pointer = "#"): ResolvedNode {
    if (this.policy.remote_refs === "deny" && SCHEME_PATTERN.test(ref)) {
      this.fail(remoteDisabled(ref, uri, pointer));
    }
    const target = this.splitLocated(ref, uri, pointer);
    const key = `${target.uri}${target.pointer}`;
    this.remember(key, uri, pointer);
    const document = this.documents.get(target.uri);
    if (document === undefined) {
      this.fail(missing(ref, target, uri, pointer));
    }
    const resolved = resolvePointer(document, target.pointer);
    if (resolved === undefined) {
      this.fail(missing(ref, target, uri, pointer));
    }
    return { uri: target.uri, pointer: target.pointer, value: resolved };
  }

  /**
   * Split one `$ref` value, converting rejections that `splitRef` raises as
   * a bare error into a diagnostic that carries the declaring node pointer.
   */
  private splitLocated(ref: string, uri: string, pointer: string): RefTarget {
    try {
      return splitRef(uri, ref);
    } catch (error) {
      if (!(error instanceof OalError)) {
        throw error;
      }
      this.fail(refValueRejected(error, uri, pointer));
    }
  }

  /**
   * Rewrite a preserved reference so it stays meaningful inside ContractIR:
   * same-document pointers are kept verbatim, cross-file pointers become
   * `<document-path>#<pointer>`.
   */
  canonicalRef(fromUri: string, ref: string): string {
    if (ref.startsWith("#")) {
      return ref;
    }
    const target = splitRef(fromUri, ref);
    return `${target.uri}${target.pointer}`;
  }

  private remember(key: string, uri: string, pointer: string): void {
    if (this.targetKeys.has(key)) {
      return;
    }
    if (this.targetKeys.size >= this.limits.maxUniqueReferenceTargets) {
      this.fail(limit(uri, pointer, this.limits.maxUniqueReferenceTargets));
    }
    this.targetKeys.add(key);
  }
}

function resolvePointer(document: Json, pointer: string): Json | undefined {
  if (pointer === "#" || pointer === "") {
    return document;
  }
  const withoutFragment = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  const tokens = withoutFragment
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: Json | undefined = document;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (isJsonObject(current)) {
      current = (current as JsonObject)[token];
      continue;
    }
    return undefined;
  }
  return current;
}

function remoteDisabled(ref: string, uri: string, pointer: string) {
  return diagnosticOf(
    DiagnosticCode.RefRemoteDisabled,
    `Remote reference is disabled by policy: ${maskRef(ref)}.`,
    uri,
    pointer,
    { ref }
  );
}

/**
 * Diagnostic for a `$ref` value that `splitRef` rejects, such as a target
 * outside the reference root. The pointer names the node that declares the
 * reference, per acceptance criterion AC-006.
 */
function refValueRejected(error: OalError, uri: string, pointer: string) {
  return diagnosticOf(error.code, error.message, uri, pointer, error.details);
}

function cycle(ref: string, uri: string, pointer: string, chain: string[]) {
  return diagnosticOf(
    DiagnosticCode.RefCycleUnsupported,
    `Reference cycle detected at ${maskRef(ref)}.`,
    uri,
    pointer,
    { ref, chain }
  );
}

function missing(ref: string, target: RefTarget, uri: string, pointer: string) {
  return diagnosticOf(
    DiagnosticCode.RefNotFound,
    `Reference target does not exist: ${maskRef(ref)}.`,
    uri,
    pointer,
    { ref, target_uri: target.uri, target_pointer: target.pointer }
  );
}

function depthLimit(uri: string, pointer: string) {
  return diagnosticOf(
    DiagnosticCode.RefLimit,
    "Reference traversal depth limit exceeded.",
    uri,
    pointer,
    {}
  );
}

function limit(uri: string, pointer: string, max: number) {
  return diagnosticOf(
    DiagnosticCode.RefLimit,
    `Unique reference target limit of ${max} exceeded.`,
    uri,
    pointer,
    { max_unique_reference_targets: max }
  );
}

function diagnosticOf(
  code: string,
  message: string,
  uri: string,
  pointer: string,
  details: Json
): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details
  };
}
