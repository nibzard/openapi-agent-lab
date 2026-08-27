/**
 * JSON value model and canonical JSON serialization.
 *
 * Canonical JSON is the documented digest basis for every semantic digest in
 * the lab: recursively lexicographically sorted object keys, unchanged array
 * order, normalized number representation, UTF-8, no insignificant whitespace.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareKeys(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function canonicalize(value: Json, out: string[]): void {
  switch (typeof value) {
    case "boolean":
    case "string": {
      out.push(JSON.stringify(value));
      return;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("Canonical JSON forbids NaN or Infinity values.");
      }
      out.push(JSON.stringify(value));
      return;
    }
    case "object": {
      if (value === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) {
            out.push(",");
          }
          canonicalize(value[i] as Json, out);
        }
        out.push("]");
        return;
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort(compareKeys);
      out.push("{");
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i] as string;
        if (i > 0) {
          out.push(",");
        }
        out.push(JSON.stringify(key), ":");
        canonicalize(value[key] as Json, out);
      }
      out.push("}");
      return;
    }
    default: {
      throw new Error("Value is not representable as canonical JSON.");
    }
  }
}

/** Serialize a JSON value to the canonical digest form. */
export function canonicalJson(value: Json): string {
  const parts: string[] = [];
  canonicalize(value, parts);
  return parts.join("");
}

/**
 * Serialize a JSON value for persisted artifacts: two-space indentation for
 * human-readable files that are not digest inputs. Ends with exactly one
 * newline at the file-writing layer.
 */
export function stableJsonStringify(value: Json): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

/**
 * Recursively sort object keys so serialized artifacts are byte-stable
 * regardless of how the value was assembled.
 */
function sortKeysDeep(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    // Runtime objects can hold undefined even when typed as Json.
    const source = value as Record<string, unknown>;
    const entries = Object.entries(source)
      .filter((entry): entry is [string, Json] => entry[1] !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
    const sorted: Record<string, Json> = {};
    for (const [key, item] of entries) {
      sorted[key] = sortKeysDeep(item);
    }
    return sorted;
  }
  return value;
}

/** Deep-structural equality over JSON values. */
export function jsonEquals(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Bounded deep clone of a JSON value. */
export function jsonClone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
