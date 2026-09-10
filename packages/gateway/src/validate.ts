/**
 * Request validation (specification section 15.3). Validates the
 * complete request before any domain mutation: parameters by effective
 * style and explode, bodies by media type and JSON Schema with
 * request-side readOnly handling.
 */

import type { Json } from "@oal/core";
import { isJsonObject, validateSchemaInstance } from "@oal/core";
import type {
  MediaContentIR,
  OperationIR,
  ParameterIR,
  SchemaIR
} from "@oal/contract-ir";
import type { RequestViolation } from "./problem.ts";
import { deserializeParameter } from "./params.ts";

/** Prefix that binds a document-relative reference to one document. */
const BOUND_REF_PREFIX = "oal-schema:";

/** Schema lookup over the compiled contract's schema registry. */
export type SchemaLookup = (ref: string) => Json | undefined;

/**
 * Build the schema lookup for one compiled contract. Media types,
 * parameters, and the generator address schemas by UID; the compiler
 * preserves recursive references as document pointers such as
 * `#/components/schemas/Node`, which no single registered subtree can
 * resolve on its own. The lookup therefore rewrites those pointers into
 * `BOUND_REF_PREFIX` references and serves every form through one index
 * over the registry, so request validation, response validation, and
 * generation share the same resolution (sections 15.3, 15.4, and 15.6).
 */
export function createContractSchemaLookup(
  schemas: Record<string, SchemaIR>
): SchemaLookup {
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

  const lookup: SchemaLookup = (ref: string): Json | undefined => {
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
  // Every reference key the closure can resolve, so the worker
  // boundary materializes the same table this closure serves:
  // registry UIDs, declared `$ref` values as written, exact
  // document-keyed forms with their bound sentinels, and a pointer
  // exactly one document declares (resolvable under any document
  // name through the unique-pointer fallback).
  const declaredRefs = new Set<string>();
  const collectRefs = (schema: Json): void => {
    if (Array.isArray(schema)) {
      schema.forEach(collectRefs);
      return;
    }
    if (!isJsonObject(schema)) {
      return;
    }
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string") {
        declaredRefs.add(value);
      } else {
        collectRefs(value);
      }
    }
  };
  for (const entry of Object.values(schemas)) {
    collectRefs(entry.schema);
  }
  const pointerCounts = new Map<string, number>();
  for (const key of byPointer.keys()) {
    const pointer = key.slice(key.indexOf("#"));
    pointerCounts.set(pointer, (pointerCounts.get(pointer) ?? 0) + 1);
  }
  const universe = [
    ...Object.keys(schemas),
    ...declaredRefs,
    ...[...byPointer.keys()].flatMap((key) => [
      key,
      `${BOUND_REF_PREFIX}${key}`
    ]),
    ...[...pointerCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([pointer]) => pointer)
  ];
  refUniverses.set(lookup, universe);
  return lookup;
}

/** Reference keys one lookup can ever resolve, by lookup identity. */
const refUniverses = new WeakMap<SchemaLookup, readonly string[]>();

/** Materialized reference tables, by lookup identity. */
const materializedRefTables = new WeakMap<SchemaLookup, Record<string, Json>>();

/**
 * Materialize the reference table of one lookup for the schema worker
 * boundary. The table is built once per lookup (base or stripped
 * variant) and shared by every later call, so normal requests do not
 * resend the contract registry.
 */
export function materializeSchemaRefs(
  lookup: SchemaLookup
): Record<string, Json> {
  const cached = materializedRefTables.get(lookup);
  if (cached !== undefined) {
    return cached;
  }
  const refs: Record<string, Json> = {};
  for (const ref of refUniverses.get(lookup) ?? []) {
    const target = lookup(ref);
    if (target !== undefined) {
      refs[ref] = target;
    }
  }
  materializedRefTables.set(lookup, refs);
  return refs;
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

export interface ParsedRequest {
  pathParameters: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: Json | undefined;
  contentType: string | null;
}

export interface ValidationResult {
  /** Deserialized parameter values keyed by parameter name. */
  parameters: Record<string, Json>;
  violations: RequestViolation[];
}

/**
 * Validate every declared parameter of an operation. Parameters that
 * fail deserialization or schema checks produce stable violations.
 * Schema evaluation runs inside the bounded worker boundary.
 */
export async function validateParameters(
  operation: OperationIR,
  request: ParsedRequest,
  schemaLookup: (ref: string) => Json | undefined
): Promise<ValidationResult> {
  const parameters: Record<string, Json> = {};
  const violations: RequestViolation[] = [];
  const refs = materializeSchemaRefs(schemaLookup);
  for (const parameter of operation.parameters) {
    const outcome = collectWire(parameter, request);
    if (outcome === undefined) {
      if (parameter.required) {
        violations.push({
          location: parameter.location,
          pointer: parameter.name,
          code: "required",
          message: `Required parameter ${parameter.name} is missing.`
        });
      }
      continue;
    }
    const parsed = deserializeParameter(
      parameter,
      outcome,
      typeHint(parameter, schemaLookup)
    );
    if (!parsed.ok) {
      violations.push({
        location: parameter.location,
        pointer: parameter.name,
        code: parsed.code,
        message: parsed.message
      });
      continue;
    }
    const schema = resolveParameterSchema(parameter, schemaLookup);
    if (schema !== undefined) {
      const found = await validateSchemaInstance(schema, parsed.value, {
        refs
      });
      for (const violation of found) {
        violations.push({
          location: parameter.location,
          pointer: `${parameter.name}${violation.pointer}`,
          code: violation.code,
          message: violation.message
        });
      }
    }
    parameters[parameter.name] = parsed.value;
  }
  return { parameters, violations };
}

/** Schema-derived disambiguation for object-versus-array parsing. */
function typeHint(
  parameter: ParameterIR,
  schemaLookup: (ref: string) => Json | undefined
): "object" | "array" | null {
  const schema = resolveParameterSchema(parameter, schemaLookup);
  if (schema === undefined || !isJsonObject(schema)) {
    return null;
  }
  const type = schema["type"];
  if (type === "object") {
    return "object";
  }
  if (type === "array") {
    return "array";
  }
  return null;
}

function collectWire(
  parameter: ParameterIR,
  request: ParsedRequest
): string | string[] | undefined {
  switch (parameter.location) {
    case "path":
      return request.pathParameters[parameter.name];
    case "query":
      // deepObject parameters arrive as name[prop]=value entries, so the
      // parser sees distinct keys rather than one value per name.
      if (parameter.style === "deepObject") {
        return deepObjectWire(parameter.name, request.query);
      }
      return request.query[parameter.name];
    case "header": {
      const header = request.headers[parameter.name.toLowerCase()];
      return header;
    }
    case "cookie":
      return request.cookies[parameter.name];
  }
}

/** Gather every `name[prop]=value` entry of a deepObject parameter. */
function deepObjectWire(
  name: string,
  query: Record<string, string | string[]>
): string[] | undefined {
  const prefix = `${name}[`;
  const entries: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      entries.push(`${key}=${item}`);
    }
  }
  return entries.length === 0 ? undefined : entries;
}

function resolveParameterSchema(
  parameter: ParameterIR,
  schemaLookup: (ref: string) => Json | undefined
): Json | undefined {
  if (parameter.schema_ref !== null) {
    return schemaLookup(parameter.schema_ref);
  }
  if (parameter.content !== null) {
    return schemaLookup(parameter.content.schema_ref);
  }
  return undefined;
}

export interface BodyValidationResult {
  /** Matched media content entry, when the body is present. */
  content: MediaContentIR | null;
  violations: RequestViolation[];
}

/**
 * Validate the request body: required presence, declared media types,
 * and JSON Schema with readOnly properties stripped from validation.
 * Schema evaluation runs inside the bounded worker boundary.
 */
export async function validateBody(
  operation: OperationIR,
  request: ParsedRequest,
  schemaLookup: (ref: string) => Json | undefined
): Promise<BodyValidationResult> {
  const violations: RequestViolation[] = [];
  const body = operation.request_body;
  if (body === null) {
    if (request.body !== undefined) {
      violations.push({
        location: "body",
        pointer: "",
        code: "body_forbidden",
        message: "The operation declares no request body."
      });
    }
    return { content: null, violations };
  }
  if (request.body === undefined) {
    if (body.required) {
      violations.push({
        location: "body",
        pointer: "",
        code: "required",
        message: "A request body is required."
      });
    }
    return { content: null, violations };
  }
  const contentType =
    (request.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType.length === 0) {
    violations.push({
      location: "body",
      pointer: "",
      code: "media_type_missing",
      message: "A Content-Type is required with a request body."
    });
    return { content: null, violations };
  }
  const content = pickContent(body.content, contentType);
  if (content === null) {
    violations.push({
      location: "body",
      pointer: "",
      code: "media_type_unsupported",
      message: `Content-Type ${contentType} is not declared.`
    });
    return { content: null, violations };
  }
  if (content.schema_ref !== null) {
    const schema = schemaLookup(content.schema_ref);
    if (
      schema !== undefined &&
      validatesBodyValue(contentType, schema, request.body)
    ) {
      const resolver = strippingSchemaLookup(schemaLookup, "readOnly");
      const found = await validateSchemaInstance(
        strippedSchema(schema, "readOnly"),
        request.body,
        { refs: materializeSchemaRefs(resolver) }
      );
      for (const violation of found) {
        violations.push({
          location: "body",
          pointer: violation.pointer,
          code: violation.code,
          message: violation.message
        });
      }
    }
  }
  return { content, violations };
}

/** Pick the declared media content for a concrete Content-Type. */
export function pickContent(
  content: readonly MediaContentIR[],
  contentType: string
): MediaContentIR | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? contentType;
  for (const entry of content) {
    if (entry.media_type.toLowerCase() === base) {
      return entry;
    }
  }
  // Parameters such as charset are ignored on exact-type match only.
  return null;
}

/**
 * Decide whether a parsed body value falls under schema validation.
 * Every parsed JSON value is checked for JSON media types: arrays,
 * scalars, and null must not bypass the declared schema. URL-encoded
 * forms and multipart bodies also parse into structured values
 * (objects and arrays), so the declared schema governs them whatever
 * the media type is. The remaining content types arrive as decoded
 * text, so only a string schema applies and the behavior stays
 * deterministic otherwise.
 */
function validatesBodyValue(
  contentType: string,
  schema: Json,
  body: Json
): boolean {
  if (typeof body !== "string") {
    return true;
  }
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "application/json" || base.endsWith("+json")) {
    return true;
  }
  return isStringSchema(schema);
}

function isStringSchema(schema: Json): boolean {
  if (!isJsonObject(schema)) {
    return false;
  }
  const type = schema["type"];
  return type === "string" || (Array.isArray(type) && type.includes("string"));
}

/**
 * Remove properties marked with the given OpenAPI flag from an object
 * schema so request and response sides validate their own half. The
 * removal recurses into nested object properties, item schemas, and
 * combinator branches, so a flagged required property one level down no
 * longer rejects a conforming value. A `$ref` keeps its reference form:
 * `strippingSchemaLookup` supplies stripped targets while validation
 * resolves them. The input schema is never mutated.
 */
export function stripProperties(
  schema: Json,
  flag: "readOnly" | "writeOnly"
): Json {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const clone: Record<string, Json> = { ...schema };
  const flagged = new Set<string>();
  const properties = clone["properties"];
  if (isJsonObject(properties)) {
    const filtered: Record<string, Json> = {};
    for (const [name, property] of Object.entries(properties)) {
      if (isJsonObject(property) && property[flag] === true) {
        flagged.add(name);
        continue;
      }
      filtered[name] = stripProperties(property, flag);
    }
    clone["properties"] = filtered;
  }
  // Only flagged properties leave `required`; a name with no declared
  // property stays required as it was.
  const required = clone["required"];
  if (Array.isArray(required)) {
    clone["required"] = required.filter(
      (name) => typeof name === "string" && !flagged.has(name)
    );
  }
  // Recurse into nested object schemas and combinator branches.
  for (const [key, value] of Object.entries(clone)) {
    if (key === "properties") {
      continue;
    }
    if (
      (key === "items" || key === "additionalProperties") &&
      isJsonObject(value)
    ) {
      clone[key] = stripProperties(value, flag);
      continue;
    }
    if (
      (key === "allOf" || key === "anyOf" || key === "oneOf") &&
      Array.isArray(value)
    ) {
      clone[key] = value.map((branch) => stripProperties(branch, flag));
    }
  }
  const prefixItems = clone["prefixItems"];
  if (Array.isArray(prefixItems)) {
    clone["prefixItems"] = prefixItems.map((item) =>
      stripProperties(item, flag)
    );
  }
  return clone;
}

/**
 * Stripped schema variants by source schema identity. `stripProperties`
 * clones the whole schema, so without this cache every request would
 * hand the worker boundary a fresh bundle and defeat its compiled-
 * validator cache.
 */
const strippedVariants = new WeakMap<
  object,
  { readOnly?: Json; writeOnly?: Json }
>();

/**
 * One memoized stripped variant of a schema. The variant is reused by
 * every request that resolves the same schema object, so the worker
 * bundle identity stays stable.
 */
export function strippedSchema(
  schema: Json,
  flag: "readOnly" | "writeOnly"
): Json {
  if (!isJsonObject(schema)) {
    return schema;
  }
  let variants = strippedVariants.get(schema);
  if (variants === undefined) {
    variants = {};
    strippedVariants.set(schema, variants);
  }
  const cached = variants[flag];
  if (cached !== undefined) {
    return cached;
  }
  const stripped = stripProperties(schema, flag);
  variants[flag] = stripped;
  return stripped;
}

/**
 * Stripped-variant wrappers per base lookup. `stripProperties` clones
 * whole referenced subtrees, so one wrapper per flag over one base
 * lookup is built once and reused by every caller that shares the base
 * lookup. The caches stay separate per flag, so readOnly and writeOnly
 * variants never mix, and the cached variants are read-only to
 * validation.
 */
const strippingWrappers = new WeakMap<
  SchemaLookup,
  { readOnly?: SchemaLookup; writeOnly?: SchemaLookup }
>();

/**
 * Wrap a contract schema lookup so every reference target loses its
 * flagged properties before validation resolves it. `stripProperties`
 * cannot see through a `$ref`, so a required readOnly or writeOnly
 * property one reference away would still reject a conforming value.
 * The wrapper memoizes per reference: a recursive schema strips once,
 * shares one stripped subtree, and never follows a reference while
 * stripping, so cyclic references terminate. The wrapper inherits the
 * base lookup's reference universe, so the worker boundary resolves
 * the same references the wrapper does.
 */
export function strippingSchemaLookup(
  schemaLookup: SchemaLookup,
  flag: "readOnly" | "writeOnly"
): SchemaLookup {
  let wrappers = strippingWrappers.get(schemaLookup);
  if (wrappers === undefined) {
    wrappers = {};
    strippingWrappers.set(schemaLookup, wrappers);
  }
  const wrapper = wrappers[flag];
  if (wrapper !== undefined) {
    return wrapper;
  }
  const stripped = new Map<string, Json>();
  const built: SchemaLookup = (ref: string): Json | undefined => {
    const cached = stripped.get(ref);
    if (cached !== undefined) {
      return cached;
    }
    const target = schemaLookup(ref);
    if (target === undefined) {
      return undefined;
    }
    const value = strippedSchema(target, flag);
    stripped.set(ref, value);
    return value;
  };
  refUniverses.set(built, refUniverses.get(schemaLookup) ?? []);
  wrappers[flag] = built;
  return built;
}

/**
 * Build a schema lookup over one plain reference table. The table is
 * also declared as the lookup's reference universe, so the worker
 * boundary resolves the same references the closure does.
 */
export function createTableSchemaLookup(
  refs: Record<string, Json>
): SchemaLookup {
  const lookup: SchemaLookup = (ref: string): Json | undefined => refs[ref];
  refUniverses.set(lookup, Object.keys(refs));
  return lookup;
}
