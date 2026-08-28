import {
  appendPointer,
  canonicalJson,
  DiagnosticCode,
  isJsonObject,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import type { CompilerLimits } from "./limits.ts";
import { splitRef, type ReferenceResolver, type ResolvedNode } from "./refs.ts";

/** Major OpenAPI dialect that drives schema normalization. */
export type OpenApiDialect = "3.0" | "3.1";

export interface NormalizedSchema {
  /** Draft 2020-12-equivalent schema with references preserved as a graph. */
  schema: Json;
  /** Non-fatal diagnostics recorded while normalizing. */
  diagnostics: Diagnostic[];
  /**
   * Targets of every reference that was preserved instead of inlined. A
   * preserved reference closes a cycle, so each target is itself a
   * recursive schema that consumers must be able to resolve through the
   * contract's schema registry.
   */
  preservedRefTargets: PreservedRefTarget[];
}

/** Document position of one schema that a preserved reference points at. */
export interface PreservedRefTarget {
  /** Document that declares the referenced schema. */
  uri: string;
  /** Pointer of the referenced schema inside that document. */
  pointer: string;
}

interface WalkContext {
  readonly resolver: ReferenceResolver;
  readonly dialect: OpenApiDialect;
  readonly limits: CompilerLimits;
  readonly rootUri: string;
  readonly diagnostics: Diagnostic[];
  readonly fail: (diagnostic: Diagnostic) => never;
  /** Record one preserved reference target, deduplicated in walk order. */
  readonly preserve: (target: PreservedRefTarget) => void;
}

/**
 * Normalize one schema subtree into validation-equivalent Draft 2020-12
 * form. References are followed and merged with sibling keys. References
 * that would recurse forever are preserved, so recursive schemas stay a
 * graph instead of an inlined tree.
 */
export function normalizeSchema(
  root: ResolvedNode,
  resolver: ReferenceResolver,
  dialect: OpenApiDialect,
  limits: CompilerLimits,
  fail: (diagnostic: Diagnostic) => never
): NormalizedSchema {
  const diagnostics: Diagnostic[] = [];
  const preserved: PreservedRefTarget[] = [];
  const preservedKeys = new Set<string>();
  const schema = walk(root.value, root.uri, root.pointer, 0, new Set(), {
    resolver,
    dialect,
    limits,
    rootUri: root.uri,
    diagnostics,
    fail,
    preserve: (target) => {
      const key = `${target.uri}${target.pointer}`;
      if (!preservedKeys.has(key)) {
        preservedKeys.add(key);
        preserved.push(target);
      }
    }
  });
  return { schema, diagnostics, preservedRefTargets: preserved };
}

function walk(
  value: Json,
  uri: string,
  pointer: string,
  depth: number,
  stack: ReadonlySet<string>,
  ctx: WalkContext
): Json {
  if (depth > ctx.limits.maxTraversalDepth) {
    return ctx.fail({
      severity: "error",
      phase: "compile",
      code: DiagnosticCode.RefLimit,
      message: "Reference traversal depth limit exceeded.",
      document_uri: uri,
      json_pointer: pointer,
      operation_key: null,
      retryable: false,
      related: [],
      details: { max_traversal_depth: ctx.limits.maxTraversalDepth }
    });
  }
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(
        walk(
          value[i] as Json,
          uri,
          appendPointer(pointer, String(i)),
          depth,
          stack,
          ctx
        )
      );
    }
    return out;
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const ref = value.$ref;
  if (typeof ref === "string") {
    const siblings = { ...value };
    delete siblings.$ref;
    const resolved = ctx.resolver.resolve(uri, ref, pointer);
    const key = `${resolved.uri}${resolved.pointer}`;
    if (stack.has(key)) {
      ctx.preserve({ uri: resolved.uri, pointer: resolved.pointer });
      return {
        ...to31(siblings, uri, pointer, ctx),
        $ref: canonicalRef(uri, ref, ctx.rootUri)
      };
    }
    const nextStack = new Set(stack);
    nextStack.add(key);
    const mergedTarget = walk(
      resolved.value,
      resolved.uri,
      resolved.pointer,
      depth + 1,
      nextStack,
      ctx
    );
    if (!isJsonObject(mergedTarget)) {
      return mergedTarget;
    }
    return { ...mergedTarget, ...to31(siblings, uri, pointer, ctx) };
  }
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = walk(
      item,
      uri,
      appendPointer(pointer, key),
      depth + 1,
      stack,
      ctx
    );
  }
  return to31(out, uri, pointer, ctx);
}

/**
 * Convert OpenAPI 3.0 schema semantics into Draft 2020-12 form. OpenAPI
 * 3.1 values pass through unchanged apart from the tuple-form rewrite,
 * which both dialects share.
 */
function to31(
  schema: JsonObject,
  uri: string,
  pointer: string,
  ctx: WalkContext
): JsonObject {
  const source = canonicalEnumOrder(schema);
  const out: JsonObject = { ...source };
  normalizeArrayItems(out, ctx);
  if (ctx.dialect !== "3.0") {
    const discriminator = out.discriminator;
    if (isJsonObject(discriminator)) {
      delete out.discriminator;
      out["x-oal-discriminator"] = discriminator;
    }
    return out;
  }
  const nullable = out.nullable;
  delete out.nullable;
  if (nullable === true && typeof out.type === "string") {
    out.type = [out.type, "null"];
  }
  if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
    out.exclusiveMinimum = out.minimum;
    delete out.minimum;
  } else if (out.exclusiveMinimum !== true) {
    delete out.exclusiveMinimum;
  }
  if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
    out.exclusiveMaximum = out.maximum;
    delete out.maximum;
  } else if (out.exclusiveMaximum !== true) {
    delete out.exclusiveMaximum;
  }
  if (out.example !== undefined) {
    if (out.examples === undefined) {
      out.examples = [out.example];
    } else {
      ctx.diagnostics.push(
        lossy(
          uri,
          pointer,
          "The 3.0 `example` value was dropped because `examples` is present."
        )
      );
    }
    delete out.example;
  }
  const discriminator = out.discriminator;
  if (isJsonObject(discriminator)) {
    out["x-oal-discriminator"] = discriminator;
    delete out.discriminator;
  }
  return out;
}

/**
 * Rewrite the draft-07 tuple keywords into Draft 2020-12 form. OpenAPI
 * 3.0 declares per-position schemas as an `items` array and the rest
 * schema as `additionalItems`; Draft 2020-12 spells them `prefixItems`
 * and `items`. A 3.1 document that declares the same tuple form is not
 * valid Draft 2020-12, but the compiler accepts it leniently so the
 * per-item constraints keep enforcing. Under draft-07 rules
 * `additionalItems` next to a single-schema `items` has no effect at
 * all, so it is dropped instead of carried into the result as a dead
 * draft-07 keyword.
 */
function normalizeArrayItems(out: JsonObject, ctx: WalkContext): void {
  const items = out.items;
  const additionalItems = out.additionalItems;
  if (Array.isArray(items)) {
    out.prefixItems = items;
    delete out.items;
    if (additionalItems !== undefined) {
      out.items = additionalItems;
    }
    delete out.additionalItems;
    return;
  }
  if (ctx.dialect === "3.0" && additionalItems !== undefined) {
    delete out.additionalItems;
  }
}

/**
 * Canonicalize the one schema keyword whose member order carries no
 * validation meaning: `enum` selects a set of allowed values, so members
 * are sorted by canonical form. This keeps schema identity digests stable
 * when equivalent documents declare the members in a different order
 * (acceptance criterion AC-097). Every ordering-sensitive keyword, such as
 * `required`, `allOf`, or `examples`, keeps its declared order.
 */
function canonicalEnumOrder(schema: JsonObject): JsonObject {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues) || enumValues.length < 2) {
    return schema;
  }
  const sorted = [...enumValues].sort((a, b) => compareByCanonicalForm(a, b));
  let changed = false;
  for (let index = 0; index < enumValues.length; index += 1) {
    if (sorted[index] !== enumValues[index]) {
      changed = true;
      break;
    }
  }
  return changed ? { ...schema, enum: sorted } : schema;
}

function compareByCanonicalForm(a: Json, b: Json): number {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function lossy(uri: string, pointer: string, message: string): Diagnostic {
  return {
    severity: "warning",
    phase: "compile",
    code: DiagnosticCode.CapSchemaApproximated,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details: { lossy: true }
  };
}

/**
 * Rewrite a preserved reference for ContractIR. References that resolve
 * inside the schema's own document keep their pointer form; cross-file
 * references carry the document path so they stay unambiguous after
 * bundling.
 */
function canonicalRef(fromUri: string, ref: string, rootUri: string): string {
  if (ref.startsWith("#") && fromUri === rootUri) {
    return ref;
  }
  const target = splitRef(fromUri, ref);
  if (target.uri === rootUri) {
    return target.pointer;
  }
  return `${target.uri}${target.pointer}`;
}
