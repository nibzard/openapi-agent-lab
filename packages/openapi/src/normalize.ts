import {
  appendPointer,
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
}

interface WalkContext {
  readonly resolver: ReferenceResolver;
  readonly dialect: OpenApiDialect;
  readonly limits: CompilerLimits;
  readonly rootUri: string;
  readonly diagnostics: Diagnostic[];
  readonly fail: (diagnostic: Diagnostic) => never;
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
  const schema = walk(root.value, root.uri, root.pointer, 0, new Set(), {
    resolver,
    dialect,
    limits,
    rootUri: root.uri,
    diagnostics,
    fail
  });
  return { schema, diagnostics };
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
    const target = splitRef(uri, ref);
    const key = `${target.uri}${target.pointer}`;
    const siblings = { ...value };
    delete siblings.$ref;
    if (stack.has(key)) {
      return {
        ...to31(siblings, uri, pointer, ctx),
        $ref: canonicalRef(uri, ref, ctx.rootUri)
      };
    }
    const resolved = ctx.resolver.resolve(uri, ref);
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
 * Convert OpenAPI 3.0 schema semantics into Draft 2020-12 form. OpenAPI 3.1
 * values pass through unchanged.
 */
function to31(
  schema: JsonObject,
  uri: string,
  pointer: string,
  ctx: WalkContext
): JsonObject {
  if (ctx.dialect !== "3.0") {
    const discriminator = schema.discriminator;
    if (isJsonObject(discriminator)) {
      const out = { ...schema };
      delete out.discriminator;
      out["x-oal-discriminator"] = discriminator;
      return out;
    }
    return schema;
  }
  const out: JsonObject = { ...schema };
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
