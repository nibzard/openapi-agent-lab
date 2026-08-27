/**
 * Parameter deserialization for every supported OpenAPI style and
 * explode combination (specification section 15.1 step 5). Parsing is
 * the inverse of RFC 6570 style serialization restricted to what
 * OpenAPI parameter objects declare.
 */

import type { Json } from "@oal/core";
import type {
  ParameterIR,
  ParameterLocation,
  ParameterStyle
} from "@oal/contract-ir";

/** Style defaults by location (OpenAPI 3.x table). */
export function defaultStyleFor(location: ParameterLocation): ParameterStyle {
  switch (location) {
    case "path":
      return "simple";
    case "query":
      return "form";
    case "header":
      return "simple";
    case "cookie":
      return "form";
  }
}

export function defaultExplodeFor(location: ParameterLocation): boolean {
  // Query and cookie default to explode: true; path and header to false.
  return location === "query" || location === "cookie";
}

export interface ParsedParameter {
  name: string;
  /** Parsed value, or the raw string when only a string was available. */
  value: Json;
  /** Raw wire form after single percent decoding, for diagnostics. */
  raw: string;
}

export type ParseOutcome =
  | { ok: true; value: Json }
  | { ok: false; code: string; message: string };

/**
 * Deserialize one parameter from its wire pieces. Query parameters with
 * repeated names arrive as multiple values; other locations arrive as
 * one decoded string.
 */
export function deserializeParameter(
  parameter: ParameterIR,
  wire: string | string[],
  typeHint: "object" | "array" | null = null
): ParseOutcome {
  const style = parameter.style;
  switch (parameter.location) {
    case "path":
      return parsePath(
        parameter.name,
        style,
        parameter.explode,
        single(wire),
        typeHint
      );
    case "header":
      return parseSimple(single(wire), typeHint);
    case "query":
      return parseQuery(
        parameter.name,
        style,
        parameter.explode,
        many(wire),
        typeHint
      );
    case "cookie":
      return parseFormCookie(style, parameter.explode, single(wire), typeHint);
  }
}

function single(wire: string | string[]): string {
  return Array.isArray(wire) ? (wire[wire.length - 1] as string) : wire;
}

function many(wire: string | string[]): string[] {
  return Array.isArray(wire) ? wire : [wire];
}

function parsePath(
  name: string,
  style: ParameterStyle,
  explode: boolean,
  segment: string,
  typeHint: "object" | "array" | null
): ParseOutcome {
  if (style === "label") {
    if (!segment.startsWith(".")) {
      return {
        ok: false,
        code: "style",
        message: "Label style requires a leading dot."
      };
    }
    return parsePairsSimple(segment.slice(1), ".", explode, typeHint);
  }
  if (style === "matrix") {
    if (!segment.startsWith(";")) {
      return {
        ok: false,
        code: "style",
        message: "Matrix style requires a leading semicolon."
      };
    }
    // Split the whole segment so repeated names keep their prefix
    // intact: ;id=3;id=4 -> ["id=3", "id=4"].
    const parts = segment
      .slice(1)
      .split(";")
      .filter((part) => part.length > 0);
    if (explode) {
      // Exploded matrix repeats the name for arrays: ;name=a;name=b.
      // Objects carry distinct keys: ;k=v;k2=v2 with no name prefix.
      if (parts.every((part) => part.startsWith(`${name}=`))) {
        const values = parts.map((part) => part.slice(name.length + 1));
        return values.length === 1
          ? okValue(parseScalar(values[0] as string))
          : okValue(values.map(parseScalar));
      }
      if (parts.every((part) => part.includes("="))) {
        return okValue(
          objectFromPairs(parts.map((part) => splitFirst(part, "=")))
        );
      }
      return {
        ok: false,
        code: "style",
        message: "Exploded matrix segment is malformed."
      };
    }
    // Non-exploded form carries one serialized value: ;name=3,4.
    const first = parts[0];
    if (first === undefined || !first.startsWith(`${name}=`)) {
      return {
        ok: false,
        code: "style",
        message: "Matrix style requires ;name= prefix."
      };
    }
    return parsePairsSimple(first.slice(name.length + 1), ",", false, typeHint);
  }
  // simple
  return parsePairsSimple(segment, ",", explode, typeHint);
}

function parseSimple(
  segment: string,
  typeHint: "object" | "array" | null
): ParseOutcome {
  return parsePairsSimple(segment, ",", false, typeHint);
}

function parsePairsSimple(
  text: string,
  delimiter: string,
  explode: boolean,
  typeHint: "object" | "array" | null
): ParseOutcome {
  const parts = text.length === 0 ? [] : text.split(delimiter);
  if (explode && parts.every((part) => part.includes("="))) {
    return okValue(objectFromPairs(parts.map((part) => splitFirst(part, "="))));
  }
  if (
    !explode &&
    typeHint === "object" &&
    parts.length % 2 === 0 &&
    parts.length > 0
  ) {
    // Non-exploded objects serialize positionally: k1,v1,k2,v2.
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < parts.length; i += 2) {
      pairs.push([parts[i] as string, parts[i + 1] as string]);
    }
    return okValue(objectFromPairs(pairs));
  }
  if (typeHint === "array" && parts.length > 0) {
    return okValue(parts.map(parseScalar));
  }
  if (parts.length === 1) {
    return okValue(parseScalar(parts[0] as string));
  }
  return okValue(parts.map(parseScalar));
}

function parseQuery(
  name: string,
  style: ParameterStyle,
  explode: boolean,
  values: string[],
  typeHint: "object" | "array" | null
): ParseOutcome {
  switch (style) {
    case "form": {
      if (explode) {
        if (values.length === 1) {
          const only = values[0] as string;
          if (only.includes("=") && !only.includes(",")) {
            // A single exploded object flattened as k=v pairs joined by
            // commas cannot be distinguished from a plain value; treat a
            // comma-free k=v string as a primitive.
            return okValue(parseScalar(only));
          }
          return okValue(parseScalar(only));
        }
        return okValue(values.map(parseScalar));
      }
      const only = values[0] as string;
      if (only.includes(",")) {
        const items = only.split(",");
        if (typeHint !== "array" && items.every((item) => item.includes("="))) {
          return okValue(
            objectFromPairs(items.map((item) => splitFirst(item, "=")))
          );
        }
        return okValue(items.map(parseScalar));
      }
      if (typeHint !== "array" && only.includes("=") && !only.startsWith("=")) {
        return okValue(objectFromPairs([splitFirst(only, "=")]));
      }
      return okValue(parseScalar(only));
    }
    case "spaceDelimited": {
      const joined = values.join("%20");
      const only = values.length === 1 ? (values[0] as string) : joined;
      return okValue(splitList(only, " ", typeHint));
    }
    case "pipeDelimited":
      return okValue(splitList(values.join("|"), "|", typeHint));
    case "deepObject": {
      // Values arrive as name[prop]=value entries already split by the
      // query parser; rebuild the object.
      const object: Record<string, Json> = {};
      for (const entry of values) {
        const match = /^([^=[\]]+)\[([^=[\]]+)\]=(.*)$/s.exec(entry);
        if (match === null) {
          return {
            ok: false,
            code: "style",
            message: "Deep object entry is malformed."
          };
        }
        if (match[1] !== name) {
          return {
            ok: false,
            code: "style",
            message: "Deep object entry names a different parameter."
          };
        }
        object[match[2] as string] = parseScalar(match[3] as string);
      }
      return okValue(object);
    }
    default:
      return {
        ok: false,
        code: "style",
        message: `Style ${style} is not valid in query.`
      };
  }
}

function parseFormCookie(
  style: ParameterStyle,
  explode: boolean,
  value: string,
  typeHint: "object" | "array" | null
): ParseOutcome {
  if (style !== "form") {
    return {
      ok: false,
      code: "style",
      message: `Style ${style} is not valid in cookie.`
    };
  }
  if (explode) {
    return okValue(parseScalar(value));
  }
  if (value.includes(",")) {
    const items = value.split(",");
    if (typeHint !== "array" && items.every((item) => item.includes("="))) {
      return okValue(
        objectFromPairs(items.map((item) => splitFirst(item, "=")))
      );
    }
    return okValue(items.map(parseScalar));
  }
  if (typeHint !== "array" && value.includes("=") && !value.startsWith("=")) {
    return okValue(objectFromPairs([splitFirst(value, "=")]));
  }
  return okValue(parseScalar(value));
}

function splitList(
  text: string,
  delimiter: string,
  typeHint: "object" | "array" | null
): Json {
  if (text === "") {
    return [];
  }
  const parts = text.split(delimiter);
  if (typeHint === "array") {
    return parts.map(parseScalar);
  }
  return parts.length === 1 ? parseScalar(text) : parts.map(parseScalar);
}

function objectFromPairs(pairs: Array<[string, string]>): Json {
  const object: Record<string, Json> = {};
  for (const [key, value] of pairs) {
    object[key] = parseScalar(value);
  }
  return object;
}

function splitFirst(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  if (index === -1) {
    return [text, ""];
  }
  return [text.slice(0, index), text.slice(index + separator.length)];
}

/**
 * Parse a scalar the way OpenAPI tooling commonly does: numbers when
 * the text is numeric, the literals true and false, and otherwise the
 * string itself. Schema validation downstream rejects wrong types.
 */
export function parseScalar(text: string): Json {
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (text === "null") {
    return null;
  }
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return text;
}

function okValue(value: Json): ParseOutcome {
  return { ok: true, value };
}
