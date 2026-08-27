/**
 * Request validation (specification section 15.3). Validates the
 * complete request before any domain mutation: parameters by effective
 * style and explode, bodies by media type and JSON Schema with
 * request-side readOnly handling.
 */

import type { Json } from "@oal/core";
import { isJsonObject } from "@oal/core";
import { SchemaValidator } from "@oal/core";
import type {
  MediaContentIR,
  OperationIR,
  ParameterIR
} from "@oal/contract-ir";
import type { RequestViolation } from "./problem.ts";
import { deserializeParameter } from "./params.ts";

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
 */
export function validateParameters(
  operation: OperationIR,
  request: ParsedRequest,
  schemaLookup: (ref: string) => Json | undefined
): ValidationResult {
  const parameters: Record<string, Json> = {};
  const violations: RequestViolation[] = [];
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
      const validator = new SchemaValidator(schema);
      const found = validator.errors(parsed.value);
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
      return request.query[parameter.name];
    case "header": {
      const header = request.headers[parameter.name.toLowerCase()];
      return header;
    }
    case "cookie":
      return request.cookies[parameter.name];
  }
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
 */
export function validateBody(
  operation: OperationIR,
  request: ParsedRequest,
  schemaLookup: (ref: string) => Json | undefined
): BodyValidationResult {
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
    if (schema !== undefined && isJsonObject(request.body)) {
      const requestSchema = stripProperties(schema, "readOnly");
      const validator = new SchemaValidator(requestSchema);
      for (const violation of validator.errors(request.body)) {
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
 * Remove properties marked with the given OpenAPI flag from an object
 * schema so request and response sides validate their own half. The
 * input schema is never mutated.
 */
export function stripProperties(
  schema: Json,
  flag: "readOnly" | "writeOnly"
): Json {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const clone: Record<string, Json> = { ...schema };
  const properties = clone["properties"];
  const required = clone["required"];
  if (isJsonObject(properties)) {
    const filtered: Record<string, Json> = {};
    const keptRequired: Json[] = [];
    for (const [name, property] of Object.entries(properties)) {
      if (isJsonObject(property) && property[flag] === true) {
        continue;
      }
      filtered[name] = property;
      keptRequired.push(name);
    }
    clone["properties"] = filtered;
    if (Array.isArray(required)) {
      const allowed = new Set(keptRequired);
      clone["required"] = required.filter((name) => {
        return typeof name === "string" && allowed.has(name);
      });
    }
  }
  // Recurse into nested object schemas.
  for (const [key, value] of Object.entries(clone)) {
    if (
      isJsonObject(value) &&
      (key === "items" || key === "additionalProperties")
    ) {
      clone[key] = stripProperties(value, flag);
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
