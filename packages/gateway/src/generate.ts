/**
 * Deterministic schema-driven value generation (specification section
 * 15.6). Given a JSON Schema and a namespaced seed, produce one stable
 * valid value or fail: the generator never emits an invalid response
 * merely to keep a server running.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  isJsonObject,
  type Json
} from "@oal/core";
import { stripProperties } from "./validate.ts";

export interface GenerationOptions {
  /**
   * Namespaced seed, derived per operation and field path so unrelated
   * operations never perturb one another.
   */
  seed: string;
  /** Maximum generation depth for recursive schemas. Default 24. */
  maxDepth?: number;
  /** Bound for unbounded arrays. Default 2. */
  arrayBound?: number;
  /** Bound for unbounded strings. Default 12. */
  stringBound?: number;
  /** Schema registry resolver for referenced schemas. */
  lookup?: (ref: string) => Json | undefined;
}

export class GenerationUnsupportedError extends Error {
  readonly code = "OAL-GENERATION-UNSUPPORTED";

  constructor(reason: string) {
    super(`Deterministic generation unsupported: ${reason}`);
    this.name = "GenerationUnsupportedError";
  }
}

/**
 * Generate a value for a schema. Response side by default: writeOnly
 * properties are removed before generation.
 */
export function generateValue(schema: Json, options: GenerationOptions): Json {
  const effective = stripProperties(schema, "writeOnly");
  return generateNode(effective, options, options.seed, 0);
}

function generateNode(
  schema: Json,
  options: GenerationOptions,
  path: string,
  depth: number
): Json {
  const maxDepth = options.maxDepth ?? 24;
  if (depth > maxDepth) {
    throw new GenerationUnsupportedError(
      "schema recursion exceeds depth bound"
    );
  }
  if (schema === true) {
    return seededToken(options.seed, path, "boolean", 0);
  }
  if (schema === false) {
    throw new GenerationUnsupportedError("schema is false");
  }
  if (!isJsonObject(schema)) {
    throw new GenerationUnsupportedError("schema is not an object or boolean");
  }

  const reference = schema.$ref;
  if (typeof reference === "string" && options.lookup !== undefined) {
    const resolved = options.lookup(reference);
    if (resolved !== undefined) {
      // Response-side generation strips writeOnly at every level,
      // including referenced schemas the top-level pass cannot see.
      return generateNode(
        stripProperties(resolved, "writeOnly"),
        options,
        path,
        depth + 1
      );
    }
  }

  const merged = mergeAllOf(schema, options, path, depth);

  // Response-value precedence (section 15.5): a schema example outranks
  // const, then default, then the first enum member. The 3.0 compiler
  // folds a singular `example` into `examples`, so both forms appear.
  const examples = merged.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0] as Json;
  }
  const example = merged.example;
  if (example !== undefined) {
    return example;
  }
  if (merged.const !== undefined) {
    return merged.const;
  }
  const defaultValue = merged.default;
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  if (Array.isArray(merged.enum) && merged.enum.length > 0) {
    // First value in ascending canonical-JSON byte order.
    const sorted = [...(merged.enum as Json[])].sort((a, b) =>
      canonicalJson(a) < canonicalJson(b) ? -1 : 1
    );
    return sorted[0] as Json;
  }

  const variant = pickVariant(merged, options, path, depth);
  if (variant !== null) {
    return variant;
  }

  const type = effectiveType(merged);
  switch (type) {
    case "object":
      return generateObject(
        variantSchema(merged, "object"),
        options,
        path,
        depth
      );
    case "array":
      return generateArray(
        variantSchema(merged, "array"),
        options,
        path,
        depth
      );
    case "string":
      return generateString(merged, options, path);
    case "integer":
      return generateNumber(variantSchema(merged, "integer"));
    case "number":
      return generateNumber(variantSchema(merged, "number"));
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      throw new GenerationUnsupportedError("schema declares no usable type");
  }
}

function variantSchema(schema: Json, type: string): Json {
  if (isJsonObject(schema) && schema.type === undefined) {
    return { type, ...schema };
  }
  return schema;
}

/** Resolve allOf/oneOf/anyOf/discriminator into a single variant. */
function pickVariant(
  schema: Record<string, Json>,
  options: GenerationOptions,
  path: string,
  depth: number
): Json | null {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = [...asArray(schema.oneOf), ...asArray(schema.anyOf)];
    if (branches.length === 0) {
      return null;
    }
    const discriminated = discriminatorPick(schema, branches);
    if (discriminated !== null) {
      return generateNode(discriminated, options, path, depth + 1);
    }
    // Choose among otherwise valid branches by ascending canonical
    // schema digest, never by parser or source iteration order.
    const ranked = [...branches]
      .map((branch) => ({ branch, digest: canonicalJsonSha256(branch) }))
      .sort((a, b) => (a.digest < b.digest ? -1 : 1));
    const winner = ranked[0]?.branch;
    if (winner === undefined) {
      return null;
    }
    return generateNode(winner, options, path, depth + 1);
  }
  return null;
}

function discriminatorPick(
  schema: Record<string, Json>,
  branches: readonly Json[]
): Json | null {
  const discriminator = schema.discriminator;
  if (
    !isJsonObject(discriminator) ||
    typeof discriminator.propertyName !== "string"
  ) {
    return null;
  }
  const mapping = isJsonObject(discriminator.mapping)
    ? discriminator.mapping
    : null;
  if (mapping === null) {
    // Without a mapping, branch order is unspecified; fall back to digest.
    return null;
  }
  const entries = Object.entries(mapping)
    .filter(([, value]) => typeof value === "string")
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const first = entries[0];
  if (first === undefined) {
    return null;
  }
  const target = first[1] as string;
  // Local $defs mapping wins; otherwise the literal branch value.
  for (const branch of branches) {
    if (isJsonObject(branch) && branch.$ref === target) {
      return branch;
    }
  }
  return branches.find((branch) => branch === target) ?? null;
}

function mergeAllOf(
  schema: Record<string, Json>,
  options: GenerationOptions,
  path: string,
  depth: number
): Record<string, Json> {
  const allOf = schema.allOf;
  if (!Array.isArray(allOf) || allOf.length === 0) {
    return schema;
  }
  const merged: Record<string, Json> = { ...schema };
  delete merged.allOf;
  const properties: Record<string, Json> = {};
  const required = new Set<string>();
  for (const branch of allOf) {
    if (!isJsonObject(branch)) {
      continue;
    }
    const resolved = mergeAllOf(branch, options, path, depth + 1);
    for (const [key, value] of Object.entries(resolved)) {
      if (key === "properties" && isJsonObject(value)) {
        Object.assign(properties, value);
      } else if (key === "required" && Array.isArray(value)) {
        for (const name of value) {
          if (typeof name === "string") {
            required.add(name);
          }
        }
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  if (Object.keys(properties).length > 0) {
    merged.properties = properties;
  }
  if (required.size > 0) {
    merged.required = [...required].sort();
  }
  return merged;
}

function generateObject(
  schema: Json,
  options: GenerationOptions,
  path: string,
  depth: number
): Json {
  if (!isJsonObject(schema)) {
    return {};
  }
  const result: Record<string, Json> = {};
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string"
        )
      : []
  );
  const minProperties =
    typeof schema.minProperties === "number" ? schema.minProperties : 0;
  // Stable property order: lexicographic by name.
  const names = [...Object.keys(properties)].sort();
  const maxDepth = options.maxDepth ?? 24;
  for (const name of names) {
    if (required.size === 0 || required.has(name)) {
      // Optional properties stop just above the depth bound so a
      // recursive schema still produces a finite valid value; required
      // properties keep recursing and fail closed at the bound. One
      // extra level covers a reference hop inside the property schema.
      if (!required.has(name) && depth + 2 > maxDepth) {
        continue;
      }
      result[name] = generateNode(
        properties[name] as Json,
        options,
        `${path}/${name}`,
        depth + 1
      );
    }
  }
  if (Object.keys(result).length < minProperties) {
    const template = additionalTemplate(schema);
    let index = 0;
    while (Object.keys(result).length < minProperties) {
      const key = `property_${index}`;
      if (!(key in result)) {
        result[key] =
          template === null
            ? seededToken(options.seed, path, "string", index)
            : generateNode(template, options, `${path}/${key}`, depth + 1);
      }
      index += 1;
      if (index > 100) {
        break;
      }
    }
  }
  if (
    Object.keys(properties).length === 0 &&
    isJsonObject(schema.additionalProperties) &&
    Object.keys(result).length === 0
  ) {
    // A schema of only additionalProperties is a map. One synthetic
    // entry exercises the value schema; an empty object would also
    // validate but shows the participant nothing.
    const key = seededToken(options.seed, path, "map-key", 0);
    result[key] = generateNode(
      schema.additionalProperties,
      options,
      `${path}/${key}`,
      depth + 1
    );
  }
  if (schema.propertyNames !== undefined && Object.keys(result).length > 0) {
    // propertyNames constrains keys; generation already uses safe names.
    return result;
  }
  return result;
}

function additionalTemplate(schema: Record<string, Json>): Json | null {
  const additional = schema.additionalProperties;
  if (isJsonObject(additional)) {
    return additional;
  }
  if (additional === true || additional === undefined) {
    return { type: "string" };
  }
  return null;
}

function generateArray(
  schema: Json,
  options: GenerationOptions,
  path: string,
  depth: number
): Json {
  if (!isJsonObject(schema)) {
    return [];
  }
  const bound = options.arrayBound ?? 2;
  const declaredMinItems =
    typeof schema.minItems === "number" ? schema.minItems : null;
  if (declaredMinItems === null && depth + 2 > (options.maxDepth ?? 24)) {
    // An array with no declared minimum may be empty; cutting the items
    // just above the depth bound (one level for the item schema, one
    // for a reference hop) lets recursive schemas terminate (15.6).
    return [];
  }
  const minItems = declaredMinItems ?? 1;
  const maxItems =
    typeof schema.maxItems === "number" ? schema.maxItems : bound;
  const items = schema.items;
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : [];
  let count: number;
  if (prefixItems.length > 0) {
    // A tuple fills every prefix position, so the count floor is the
    // prefix length, not 1. A declared minItems raises the floor past
    // the prefix, and the rest schema supplies the extra items. With
    // no count the bounds admit, fail closed instead of emitting a
    // body that violates the schema.
    const floor = Math.max(minItems, prefixItems.length);
    if (items === false && floor > prefixItems.length) {
      throw new GenerationUnsupportedError(
        `minItems ${floor} exceeds the ${prefixItems.length} prefix items with no rest schema`
      );
    }
    if (maxItems < floor) {
      throw new GenerationUnsupportedError(
        `the count bound ${maxItems} is below the ${floor} items the tuple requires`
      );
    }
    count = floor;
  } else {
    count = Math.max(0, Math.min(Math.max(minItems, 1), maxItems));
  }
  const values: Json[] = [];
  for (let i = 0; i < count; i += 1) {
    const template =
      (i < prefixItems.length ? prefixItems[i] : undefined) ?? items ?? true;
    values.push(
      generateNode(template as Json, options, `${path}/${i}`, depth + 1)
    );
  }
  if (schema.uniqueItems === true) {
    return dedupeByCanonical(values);
  }
  return values;
}

function dedupeByCanonical(values: readonly Json[]): Json[] {
  const seen = new Set<string>();
  const result: Json[] = [];
  for (const value of values) {
    const key = canonicalJson(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function generateString(
  schema: Record<string, Json>,
  options: GenerationOptions,
  path: string
): Json {
  const format = typeof schema.format === "string" ? schema.format : null;
  const pattern = typeof schema.pattern === "string" ? schema.pattern : null;
  const declaredMin =
    typeof schema.minLength === "number" ? schema.minLength : null;
  const declaredMax =
    typeof schema.maxLength === "number" ? schema.maxLength : null;
  if (pattern !== null) {
    // A declared format is tried first: its fixed synthetic shape is
    // the realistic value, and the pattern only narrows it. The
    // candidate is accepted when it satisfies the pattern, using the
    // same compilation the validator performs on the same schema.
    const candidate = formatValue(format, options.seed, path);
    if (candidate !== null && patternAccepts(pattern, candidate)) {
      if (declaredMin !== null && candidate.length < declaredMin) {
        throw new GenerationUnsupportedError(
          `minLength ${declaredMin} conflicts with pattern ${pattern}`
        );
      }
      if (declaredMax !== null && candidate.length > declaredMax) {
        throw new GenerationUnsupportedError(
          `maxLength ${declaredMax} conflicts with pattern ${pattern}`
        );
      }
      return candidate;
    }
    const produced = producePattern(pattern);
    if (produced === null) {
      throw new GenerationUnsupportedError(
        `pattern ${pattern} is not safely producible`
      );
    }
    if (declaredMin !== null && produced.length < declaredMin) {
      return produced.padEnd(declaredMin, produced.slice(-1));
    }
    if (declaredMax !== null && produced.length > declaredMax) {
      throw new GenerationUnsupportedError(
        `maxLength ${declaredMax} conflicts with pattern ${pattern}`
      );
    }
    return produced;
  }
  const base = formatValue(format, options.seed, path);
  if (base === null) {
    throw new GenerationUnsupportedError(
      `format ${format} has no synthetic producer`
    );
  }
  if (format !== null && format !== "") {
    // Formats produce fixed synthetic shapes; only declared bounds
    // apply, never the default bound for unbounded plain strings.
    if (declaredMin !== null && base.length < declaredMin) {
      throw new GenerationUnsupportedError(
        `minLength ${declaredMin} conflicts with format ${format}`
      );
    }
    if (declaredMax !== null && base.length > declaredMax) {
      throw new GenerationUnsupportedError(
        `maxLength ${declaredMax} conflicts with format ${format}`
      );
    }
    return base;
  }
  const bound = options.stringBound ?? 12;
  const value = base.length > bound ? base.slice(0, bound) : base;
  const minLength = declaredMin ?? 0;
  if (value.length < minLength) {
    return value.padEnd(minLength, "x");
  }
  return value;
}

function formatValue(
  format: string | null,
  seed: string,
  path: string
): string | null {
  const token = seededToken(seed, path, "string", 0);
  switch (format) {
    case null:
    case "":
      return token;
    case "date":
      // Virtual epoch date.
      return "2000-01-01";
    case "date-time":
      return "2000-01-01T00:00:00.000Z";
    case "time":
      return "00:00:00Z";
    case "duration":
      return "PT0S";
    case "uri":
    case "uri-reference":
      return `https://example.invalid/${token}`;
    case "email":
      return `${token}@example.invalid`;
    case "hostname":
      return "example.invalid";
    case "ipv4":
      return "192.0.2.1";
    case "ipv6":
      return "2001:db8::1";
    case "uuid":
      return "00000000-0000-4000-8000-000000000001";
    case "byte":
      // "data" encoded in base64.
      return "ZGF0YQ==";
    case "int32":
    case "int64":
    case "float":
    case "double":
      return null;
    default:
      // Unknown formats are annotations; fall back to a plain token.
      return token;
  }
}

/**
 * Test one candidate against a vendor pattern. The schema validator
 * compiles the same expression against the same schema, so this adds
 * no new trust boundary; an untestable pattern accepts nothing.
 */
function patternAccepts(pattern: string, candidate: string): boolean {
  try {
    return new RegExp(pattern).test(candidate);
  } catch {
    return false;
  }
}

/** Produce a string for a bounded set of safely supported patterns. */
function producePattern(pattern: string): string | null {
  const anchored = pattern.startsWith("^") ? pattern : `^${pattern}`;
  const closed = anchored.endsWith("$") ? anchored : `${anchored}$`;
  if (closed === "^[A-Za-z0-9_-]+$") {
    return "generated_value";
  }
  if (closed === "^[a-z]+$") {
    return "generated";
  }
  if (closed === "^[A-Za-z]+$") {
    return "generated";
  }
  if (closed === "^[0-9]+$") {
    return "2000";
  }
  if (closed === "^[A-Z]{2}-[0-9]{3}$") {
    return "XX-000";
  }
  if (closed === "^[a-z][a-z0-9-]*$") {
    return "generated";
  }
  return null;
}

function generateNumber(schema: Json): Json {
  if (!isJsonObject(schema)) {
    return 0;
  }
  const isInteger = schema.type === "integer";
  const minimum = typeof schema.minimum === "number" ? schema.minimum : null;
  const maximum = typeof schema.maximum === "number" ? schema.maximum : null;
  // Draft 2020-12 carries exclusive bounds as numbers, which is the
  // compiler's normalized form; the OpenAPI 3.0 boolean form combines
  // with the inclusive bound it qualifies.
  const exclusiveMinimum =
    typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : schema.exclusiveMinimum === true && minimum !== null
        ? minimum
        : null;
  const exclusiveMaximum =
    typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum
      : schema.exclusiveMaximum === true && maximum !== null
        ? maximum
        : null;
  const multipleOf =
    typeof schema.multipleOf === "number" ? schema.multipleOf : null;
  const lower = minimum ?? exclusiveMinimum;
  const upper = maximum ?? exclusiveMaximum;
  const belowLower = (candidate: number): boolean =>
    (minimum !== null && candidate < minimum) ||
    (exclusiveMinimum !== null && candidate <= exclusiveMinimum);
  const aboveUpper = (candidate: number): boolean =>
    (maximum !== null && candidate > maximum) ||
    (exclusiveMaximum !== null && candidate >= exclusiveMaximum);

  let value: number;
  if (lower !== null && upper !== null) {
    value = lower === upper ? lower : (lower + upper) / 2;
  } else if (lower !== null) {
    value = minimum !== null ? minimum : lower + 1;
  } else if (upper !== null) {
    value = Math.min(maximum !== null ? maximum : upper - 1, 0);
  } else {
    value = 1;
  }
  if (multipleOf !== null && multipleOf > 0) {
    value = Math.round(value / multipleOf) * multipleOf;
    if (belowLower(value)) {
      value += multipleOf;
    }
    if (aboveUpper(value)) {
      value -= multipleOf;
    }
  } else {
    if (belowLower(value)) {
      value += 1;
    }
    if (aboveUpper(value)) {
      value -= 1;
    }
  }
  if (isInteger) {
    value = Math.round(value);
  }
  if (belowLower(value) || aboveUpper(value)) {
    throw new GenerationUnsupportedError(
      "numeric bounds admit no representable value"
    );
  }
  return value;
}

/**
 * Keywords that carry no constraint the generator must satisfy. A
 * schema made only of these admits any value, exactly like `true`;
 * string-affine keywords (format, pattern, length bounds) are admitted
 * because a string is always a valid instance for them.
 */
const ANNOTATION_ONLY_KEYS: ReadonlySet<string> = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "definitions",
  "deprecated",
  "description",
  "discriminator",
  "externalDocs",
  "format",
  "maxLength",
  "minLength",
  "nullable",
  "pattern",
  "readOnly",
  "title",
  "writeOnly",
  "xml"
]);

function effectiveType(schema: Record<string, Json>): string | null {
  const type = schema.type;
  if (typeof type === "string") {
    if (schema.nullable === true && !type.includes("null")) {
      return type;
    }
    return type;
  }
  if (Array.isArray(type)) {
    const preferred = [
      "string",
      "integer",
      "number",
      "boolean",
      "object",
      "array",
      "null"
    ];
    for (const candidate of preferred) {
      if (type.includes(candidate)) {
        return candidate;
      }
    }
  }
  const hasProperties =
    isJsonObject(schema.properties) ||
    Array.isArray(schema.required) ||
    // A declared additionalProperties makes the schema a map, which is
    // an object even without a type word.
    schema.additionalProperties !== undefined;
  const hasItems =
    schema.items !== undefined || schema.prefixItems !== undefined;
  if (hasProperties) {
    return "object";
  }
  if (hasItems) {
    return "array";
  }
  if (Object.keys(schema).every((key) => ANNOTATION_ONLY_KEYS.has(key))) {
    return "string";
  }
  return null;
}

/** Short deterministic token derived from the seed and value path. */
function seededToken(
  seed: string,
  path: string,
  kind: string,
  index: number
): string {
  const digest = canonicalJsonSha256({ seed, path, kind, index });
  return `gen_${digest.slice(0, 8)}`;
}

function asArray(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}
