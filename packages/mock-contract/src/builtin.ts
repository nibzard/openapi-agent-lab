/**
 * The built-in deterministic mock adapter. It delegates response
 * selection and generation to the gateway engine so the gateway and the
 * adapter boundary can never disagree (specification section 37.1).
 */

import type { SchemaIR } from "@oal/contract-ir";
import { isJsonObject, type Json } from "@oal/core";
import { type ContractFixture, selectResponse } from "@oal/gateway";
import type {
  MockAdapter,
  MockAdapterCapabilities,
  MockRespondInput,
  MockResponse
} from "./types.ts";

export const BUILTIN_MOCK_ADAPTER_ID = "builtin";

export class BuiltinMockAdapter implements MockAdapter {
  readonly id = BUILTIN_MOCK_ADAPTER_ID;
  readonly version = "0.1.0";

  constructor(private readonly fixtures: ContractFixture[] = []) {}

  capabilities(): MockAdapterCapabilities {
    return {
      examples: true,
      schemaGeneration: true,
      contentNegotiation: true,
      responseHeaders: true
    };
  }

  respond(input: MockRespondInput): MockResponse | null {
    const operation = input.contract.operations.find(
      (entry) => entry.key === input.request.operationKey
    );
    if (operation === undefined) {
      return null;
    }
    // The Accept header joins selection so the value comes from the
    // media type that is served, exactly as the gateway pipeline does.
    // A fixture keeps the media type it declared: it is part of the
    // fixture's identity, and the bytes are never relabeled.
    const selected = selectResponse(
      operation.key,
      operation.responses,
      this.fixtures.filter((fixture) => fixture.operation === operation.key),
      {
        seed: `${input.seed}:${operation.uid}`,
        lookup: contractSchemaLookup(input.contract.schemas)
      },
      input.request.accept
    );
    if (selected === null) {
      return null;
    }
    return {
      status: selected.status,
      mediaType: selected.mediaType,
      headers: { ...selected.headers },
      body: selected.body,
      provenance: selected.provenance,
      approximation: selected.approximation
    };
  }
}

/** Convenience constructor matching the adapter interface exactly. */
export function builtinMockAdapter(
  fixtures?: ContractFixture[]
): BuiltinMockAdapter {
  return new BuiltinMockAdapter(fixtures);
}

// ---- contract schema lookup -----------------------------------------

/** Prefix that binds a document-relative reference to one document. */
const BOUND_REF_PREFIX = "oal-schema:";

/**
 * Build the schema lookup for one compiled contract. This mirrors the
 * gateway pipeline's own lookup (specification sections 15.3, 15.4, and
 * 15.6): the registry serves UID keys directly, and the recursive
 * references the compiler preserves as document pointers, such as
 * `#/components/schemas/Node`, resolve through a pointer index that
 * rewrites `#`-relative references into bound sentinels. The gateway
 * keeps its construction private to its package surface, so the adapter
 * carries an equivalent implementation here to stay inside the package
 * boundary while resolving nested references exactly as the gateway
 * does.
 */
function contractSchemaLookup(
  schemas: Record<string, SchemaIR>
): (ref: string) => Json | undefined {
  // Key form `<document-uri><source-pointer>` matches the compiler's
  // cross-file reference form exactly. Two registry keys may name one
  // document pointer; the smallest registry key wins so the index never
  // depends on registry iteration order.
  const ownerOf = new Map<string, string>();
  for (const [registryKey, entry] of Object.entries(schemas)) {
    if (entry.source_pointer.length === 0) {
      continue;
    }
    const key = `${entry.document_uri}${entry.source_pointer}`;
    const incumbent = ownerOf.get(key);
    if (incumbent === undefined || registryKey < incumbent) {
      ownerOf.set(key, registryKey);
    }
  }
  const byPointer = new Map<string, Json>();
  for (const [pointerKey, registryKey] of ownerOf) {
    byPointer.set(pointerKey, (schemas[registryKey] as SchemaIR).schema);
  }
  const bound = new Map<string, Json>();

  const bind = (schema: Json, documentUri: string): Json =>
    bindRefs(schema, documentUri, new Map());

  return (ref: string): Json | undefined => {
    const cached = bound.get(ref);
    if (cached !== undefined) {
      return cached;
    }
    const entry = schemas[ref];
    if (entry !== undefined) {
      const value = bind(entry.schema, entry.document_uri);
      bound.set(ref, value);
      return value;
    }
    const target = targetOf(ref, byPointer);
    if (target === undefined) {
      return undefined;
    }
    const value = bind(target.schema, target.documentUri);
    bound.set(ref, value);
    return value;
  };
}

/** Replace `#`-relative references with document-bound sentinels. */
function bindRefs(
  schema: Json,
  documentUri: string,
  cache: Map<object, Json>
): Json {
  if (Array.isArray(schema)) {
    const out: Json[] = [];
    cache.set(schema, out);
    for (const item of schema) {
      out.push(bindRefs(item, documentUri, cache));
    }
    return out;
  }
  if (!isJsonObject(schema)) {
    return schema;
  }
  const hit = cache.get(schema);
  if (hit !== undefined) {
    return hit;
  }
  const out: Record<string, Json> = {};
  // Register before recursion so recursive subtrees reuse one object.
  cache.set(schema, out);
  for (const [key, value] of Object.entries(schema)) {
    out[key] =
      key === "$ref" && typeof value === "string" && value.startsWith("#")
        ? `${BOUND_REF_PREFIX}${documentUri}${value}`
        : bindRefs(value, documentUri, cache);
  }
  return out;
}

/** A registered schema plus the document that declares it. */
interface RefTarget {
  schema: Json;
  documentUri: string;
}

/**
 * Resolve one non-UID reference to a registered schema: a bound
 * sentinel, a cross-file `<document>#<pointer>` form, or a bare pointer
 * when exactly one document in the registry declares it.
 */
function targetOf(
  ref: string,
  byPointer: ReadonlyMap<string, Json>
): RefTarget | undefined {
  if (ref.startsWith(BOUND_REF_PREFIX)) {
    return keyedTarget(ref.slice(BOUND_REF_PREFIX.length), byPointer);
  }
  if (ref.startsWith("#")) {
    return solePointerTarget(ref, byPointer);
  }
  if (ref.includes("#")) {
    return keyedTarget(ref, byPointer);
  }
  return undefined;
}

/**
 * Resolve a document-keyed reference. Content-addressed registration
 * keeps one pointer per schema, so a reference to a document whose
 * identical copy another document already registered finds no exact
 * key. The pointer alone then identifies the schema when exactly one
 * document declares it, which is sound because only identical content
 * merges under one UID.
 */
function keyedTarget(
  key: string,
  byPointer: ReadonlyMap<string, Json>
): RefTarget | undefined {
  const exact = byPointer.get(key);
  if (exact !== undefined) {
    return { schema: exact, documentUri: key.slice(0, key.indexOf("#")) };
  }
  return solePointerTarget(key.slice(key.indexOf("#")), byPointer);
}

/**
 * Resolve a bare pointer to the one document that declares it. Zero or
 * several declaring documents leave the reference unresolved.
 */
function solePointerTarget(
  pointer: string,
  byPointer: ReadonlyMap<string, Json>
): RefTarget | undefined {
  let matches = 0;
  let found: RefTarget | undefined;
  for (const [key, schema] of byPointer) {
    if (key.endsWith(pointer)) {
      matches += 1;
      found = {
        schema,
        documentUri: key.slice(0, key.length - pointer.length)
      };
    }
  }
  return matches === 1 ? found : undefined;
}
