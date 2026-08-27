import { isJsonObject, type Json } from "@oal/core";
import type {
  ParameterLocation,
  ParameterStyle,
  SecuritySchemeType,
  SupportLevel
} from "@oal/contract-ir";

/** Ranking used to derive one operation level from its surfaces. */
export const SUPPORT_RANK: Record<SupportLevel, number> = {
  supported: 0,
  approximated: 1,
  requires_scenario: 2,
  unsupported: 3
};

const LEVELS: readonly SupportLevel[] = [
  "supported",
  "approximated",
  "requires_scenario",
  "unsupported"
];

export function worstLevel(a: SupportLevel, b: SupportLevel): SupportLevel {
  return SUPPORT_RANK[a] >= SUPPORT_RANK[b] ? a : b;
}

export function worstOf(levels: readonly SupportLevel[]): SupportLevel {
  let worst: SupportLevel = "supported";
  for (const level of levels) {
    worst = worstLevel(worst, level);
  }
  return worst;
}

export function allLevels(): readonly SupportLevel[] {
  return LEVELS;
}

/** Effective style defaults per location, from the OpenAPI 3.0 data model. */
export const DEFAULT_STYLE: Record<ParameterLocation, ParameterStyle> = {
  path: "simple",
  query: "form",
  header: "simple",
  cookie: "form"
};

/** Effective explode defaults per location. */
export const DEFAULT_EXPLODE: Record<ParameterLocation, boolean> = {
  path: false,
  query: true,
  header: false,
  cookie: true
};

/** Coarse schema shape used by the serialization support matrix. */
export type SchemaShape =
  | "missing"
  | "any"
  | "primitive"
  | "primitive-array"
  | "array"
  | "flat-object"
  | "nested-object";

function typeList(schema: Json): string[] {
  if (isJsonObject(schema)) {
    const type = schema.type;
    if (typeof type === "string") {
      return [type];
    }
    if (Array.isArray(type)) {
      return type.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

/** Classify a normalized schema for serialization support purposes. */
export function schemaShape(schema: Json | undefined): SchemaShape {
  if (schema === undefined) {
    return "missing";
  }
  if (!isJsonObject(schema)) {
    return "any";
  }
  const types = typeList(schema);
  if (types.includes("array")) {
    const items = schema.items;
    if (isJsonObject(items)) {
      const itemTypes = typeList(items);
      const simple =
        itemTypes.length === 0 ||
        itemTypes.every(
          (name) =>
            name === "string" ||
            name === "number" ||
            name === "boolean" ||
            name === "integer"
        );
      if (simple) {
        return "primitive-array";
      }
    }
    return "array";
  }
  const hasProperties =
    isJsonObject(schema.properties) &&
    Object.keys(schema.properties).length > 0;
  if (types.includes("object") || hasProperties) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const value of Object.values(properties)) {
      if (!isJsonObject(value)) {
        continue;
      }
      const childTypes = typeList(value);
      const childIsComplex =
        childTypes.includes("object") ||
        childTypes.includes("array") ||
        isJsonObject(value.properties) ||
        isJsonObject(value.items);
      if (childIsComplex) {
        return "nested-object";
      }
    }
    return "flat-object";
  }
  if (types.length === 0) {
    return "any";
  }
  return "primitive";
}

export interface ParameterSupportInput {
  readonly location: ParameterLocation;
  readonly style: ParameterStyle;
  readonly shape: SchemaShape;
  /** Media types declared through parameter `content`. */
  readonly contentMediaTypes: readonly string[];
}

export interface SupportOutcome {
  readonly level: SupportLevel;
  readonly reasonCodes: string[];
}

/** Serialization support per the version 0.1 parameter matrix. */
export function parameterSupport(input: ParameterSupportInput): SupportOutcome {
  if (input.contentMediaTypes.length > 0) {
    if (input.contentMediaTypes.length > 1) {
      return {
        level: "unsupported",
        reasonCodes: ["parameter:content:multiple"]
      };
    }
    const media = input.contentMediaTypes[0] ?? "";
    return media.toLowerCase() === "application/json"
      ? { level: "supported", reasonCodes: ["parameter:content"] }
      : { level: "unsupported", reasonCodes: [`parameter:content:${media}`] };
  }
  const style = input.style;
  const shape = input.shape;
  if (shape === "nested-object") {
    return {
      level: "unsupported",
      reasonCodes: [`schema:nested-object`, `style:${style}`]
    };
  }
  switch (input.location) {
    case "path":
      return pathStyleSupport(style, shape);
    case "query":
      return queryStyleSupport(style, shape);
    case "header":
      return style === "simple"
        ? { level: "supported", reasonCodes: [] }
        : {
            level: "unsupported",
            reasonCodes: [`style:${style}`, "location:header"]
          };
    case "cookie":
      return style === "form"
        ? { level: "supported", reasonCodes: [] }
        : {
            level: "unsupported",
            reasonCodes: [`style:${style}`, "location:cookie"]
          };
    default:
      return { level: "unsupported", reasonCodes: ["location:unknown"] };
  }
}

function pathStyleSupport(
  style: ParameterStyle,
  shape: SchemaShape
): SupportOutcome {
  const supported: readonly ParameterStyle[] = ["simple", "label", "matrix"];
  if (!supported.includes(style)) {
    return {
      level: "unsupported",
      reasonCodes: [`style:${style}`, "location:path"]
    };
  }
  if (shape === "array") {
    return {
      level: "unsupported",
      reasonCodes: [`schema:nested-array`, `style:${style}`]
    };
  }
  return { level: "supported", reasonCodes: [] };
}

function queryStyleSupport(
  style: ParameterStyle,
  shape: SchemaShape
): SupportOutcome {
  switch (style) {
    case "form":
      if (shape === "array") {
        return {
          level: "unsupported",
          reasonCodes: ["schema:nested-array", "style:form"]
        };
      }
      return { level: "supported", reasonCodes: [] };
    case "spaceDelimited":
    case "pipeDelimited":
      if (shape === "primitive-array") {
        return { level: "supported", reasonCodes: [] };
      }
      return { level: "unsupported", reasonCodes: [`style:${style}`] };
    case "deepObject":
      if (shape === "flat-object") {
        return { level: "supported", reasonCodes: [] };
      }
      return { level: "unsupported", reasonCodes: ["style:deepObject"] };
    case "simple":
    case "label":
    case "matrix":
      return {
        level: "unsupported",
        reasonCodes: [`style:${style}`, "location:query"]
      };
  }
}

/** Security scheme support per the version 0.1 authentication emulation. */
export function securitySchemeSupport(
  type: SecuritySchemeType,
  scheme: string | null
): SupportOutcome {
  switch (type) {
    case "apiKey":
      return { level: "supported", reasonCodes: [] };
    case "http":
      if (scheme === null) {
        return { level: "unsupported", reasonCodes: ["security:http"] };
      }
      if (scheme === "basic" || scheme === "bearer") {
        return { level: "supported", reasonCodes: [] };
      }
      return {
        level: "unsupported",
        reasonCodes: [`security:http-${scheme}`]
      };
    case "oauth2":
      return { level: "approximated", reasonCodes: ["security:oauth2"] };
    case "openIdConnect":
      return {
        level: "approximated",
        reasonCodes: ["security:open-id-connect"]
      };
    case "mutualTLS":
      return { level: "unsupported", reasonCodes: ["security:mutualTLS"] };
    default:
      return { level: "unsupported", reasonCodes: ["security:unknown"] };
  }
}

/** A response selector is deterministic when it names a concrete success. */
export function responseSelectorSupport(
  selector: string,
  kind: "exact" | "range" | "default"
): SupportOutcome {
  if (kind === "exact" && selector.startsWith("2")) {
    return { level: "supported", reasonCodes: [] };
  }
  if (kind === "exact" && selector.startsWith("1")) {
    return {
      level: "unsupported",
      reasonCodes: ["response:informational"]
    };
  }
  if (kind === "range" || kind === "default") {
    return { level: "supported", reasonCodes: [] };
  }
  return { level: "supported", reasonCodes: [] };
}
