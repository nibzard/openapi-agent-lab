/**
 * Catalog describe (specification section 18.4). `describe_operation`
 * answers one operation from ContractIR alone: identity, parameters by
 * location, request and response media types with schemas, security
 * alternatives, examples, deprecation, the source description, and
 * capability limitations. Detail levels control how much is returned.
 */

import { invalidInput, type Json } from "@oal/core";
import type {
  ContractIR,
  MediaContentIR,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SecuritySchemeIR,
  SupportLevel
} from "@oal/contract-ir";

import {
  boundPlainText,
  normalizePlainText,
  SOURCE_TEXT_BUDGET
} from "./description.ts";

/** Detail levels, from least to most output. */
export const DESCRIBE_DETAIL_LEVELS = [
  "summary",
  "schemas",
  "examples",
  "full"
] as const;

export type DescribeDetail = (typeof DESCRIBE_DETAIL_LEVELS)[number];

export interface DescribeOperationInput {
  /** Canonical key, UID, or unique operationId. */
  operation: string;
  detail?: DescribeDetail | undefined;
}

export interface DescribedParameter {
  name: string;
  location: string;
  required: boolean;
  deprecated: boolean;
  style: string;
  explode: boolean;
  description: string | null;
  schemaRef: string | null;
  /** Inline schema, included from the `schemas` level upward. */
  schema?: Json | undefined;
  mediaType: string | null;
  support: SupportLevel;
  reasonCodes: string[];
  defaultValue?: Json | undefined;
}

export interface DescribedMediaType {
  mediaType: string;
  schemaRef: string | null;
  /** Inline schema, included from the `schemas` level upward. */
  schema?: Json | undefined;
  support: SupportLevel;
  reasonCodes: string[];
}

export interface DescribedResponse {
  selector: string;
  selectorKind: string;
  status: number | null;
  description: string | null;
  mediaTypes: DescribedMediaType[];
  headers: Array<{
    name: string;
    required: boolean;
    deprecated: boolean;
    description: string | null;
    schemaRef: string | null;
    support: SupportLevel;
    reasonCodes: string[];
  }>;
}

export interface DescribedSecurityAlternative {
  schemes: Array<{
    name: string;
    type: SecuritySchemeIR["type"];
    /** Api-key location, or the header a credential travels in. */
    location: string;
    wireName: string | null;
    scopes: string[];
    support: SupportLevel;
  }>;
}

export interface DescribedExample {
  source: string;
  name: string | null;
  summary: string | null;
  value: Json;
}

export interface DescribeOperationResult {
  key: string;
  uid: string;
  operationId: string | null;
  toolName: string;
  method: string;
  pathTemplate: string;
  summary: string | null;
  /** Source description, normalized and bounded, labeled as untrusted. */
  description: string | null;
  descriptionTruncated: boolean;
  tags: string[];
  deprecated: boolean;
  support: SupportLevel;
  detail: DescribeDetail;
  parameters: {
    path: DescribedParameter[];
    query: DescribedParameter[];
    header: DescribedParameter[];
    cookie: DescribedParameter[];
  };
  requestBody: {
    required: boolean;
    description: string | null;
    mediaTypes: DescribedMediaType[];
  } | null;
  responses: DescribedResponse[];
  security: {
    anonymous: boolean;
    alternatives: DescribedSecurityAlternative[];
  } | null;
  /** Parameter and media examples, from the `examples` level upward. */
  examples?: DescribedExample[] | undefined;
  /** Capability limitations derived from support levels in the contract. */
  limitations: string[];
}

function describeError(code: string, message: string, details?: Json): Error {
  return invalidInput(code, message, details);
}

/** Narrow an untyped detail value, as the catalog bridge needs to. */
export function isDescribeDetail(value: unknown): value is DescribeDetail {
  return (
    typeof value === "string" &&
    (DESCRIBE_DETAIL_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Resolve one operation by canonical key, UID, or unique operationId. A
 * duplicated operationId does not resolve: the error names the ambiguity.
 */
export function resolveOperation(
  contract: ContractIR,
  reference: string
): OperationIR {
  const byKey = contract.operations.find(
    (operation) => operation.key === reference
  );
  if (byKey !== undefined) {
    return byKey;
  }
  const byUid = contract.operations.find(
    (operation) => operation.uid === reference
  );
  if (byUid !== undefined) {
    return byUid;
  }
  const byId = contract.operations.filter(
    (operation) => operation.operation_id === reference
  );
  if (byId.length === 1) {
    return byId[0] as OperationIR;
  }
  if (byId.length > 1) {
    throw describeError(
      "operation_ambiguous",
      "The operationId is not unique. Use the canonical key or the UID.",
      {
        operationId: reference,
        keys: byId.map((operation) => operation.key).sort()
      }
    );
  }
  throw describeError("operation_not_found", "No operation matches.", {
    operation: reference
  });
}

function schemaFor(
  contract: ContractIR,
  schemaRef: string | null,
  include: boolean
): { schema?: Json | undefined } {
  if (!include || schemaRef === null) {
    return {};
  }
  const registered = contract.schemas[schemaRef];
  return registered === undefined ? {} : { schema: registered.schema };
}

function describedMediaType(
  contract: ContractIR,
  media: MediaContentIR,
  includeSchema: boolean
): DescribedMediaType {
  return {
    mediaType: media.media_type,
    schemaRef: media.schema_ref,
    ...schemaFor(contract, media.schema_ref, includeSchema),
    support: media.support,
    reasonCodes: [...media.support_reason_codes]
  };
}

function describedParameter(
  contract: ContractIR,
  parameter: ParameterIR,
  includeSchema: boolean
): DescribedParameter {
  const description =
    parameter.description === null
      ? null
      : normalizePlainText(parameter.description);
  return {
    name: parameter.name,
    location: parameter.location,
    required: parameter.required,
    deprecated: parameter.deprecated,
    style: parameter.style,
    explode: parameter.explode,
    description,
    schemaRef: parameter.schema_ref,
    ...schemaFor(contract, parameter.schema_ref, includeSchema),
    mediaType: parameter.content === null ? null : parameter.content.media_type,
    ...(parameter.default_value === undefined
      ? {}
      : { defaultValue: parameter.default_value }),
    support: parameter.support,
    reasonCodes: [...parameter.support_reason_codes]
  };
}

function describedResponse(
  contract: ContractIR,
  response: ResponseIR,
  includeSchema: boolean
): DescribedResponse {
  return {
    selector: response.selector,
    selectorKind: response.selector_kind,
    status: response.status,
    description: response.description,
    mediaTypes: response.content.map((media) =>
      describedMediaType(contract, media, includeSchema)
    ),
    headers: response.headers.map((header) => ({
      name: header.name,
      required: header.required,
      deprecated: header.deprecated,
      description: header.description,
      schemaRef: header.schema_ref,
      support: header.support,
      reasonCodes: [...header.support_reason_codes]
    }))
  };
}

function describedSecurity(
  contract: ContractIR,
  operation: OperationIR
): DescribeOperationResult["security"] {
  if (operation.security === null) {
    return null;
  }
  return {
    anonymous: operation.security.anonymous,
    alternatives: operation.security.alternatives.map((alternative) => ({
      schemes: alternative.schemes.map((requirement) => {
        const scheme: SecuritySchemeIR | undefined =
          contract.security_schemes[requirement.name];
        const type = scheme?.type ?? "apiKey";
        const location =
          scheme === undefined
            ? "unknown"
            : scheme.type === "apiKey"
              ? (scheme.location ?? "header")
              : "header";
        return {
          name: requirement.name,
          type,
          location,
          wireName: scheme?.wire_name ?? null,
          scopes: [...requirement.scopes],
          support: scheme?.support ?? "unsupported"
        };
      })
    }))
  };
}

function collectExamples(operation: OperationIR): DescribedExample[] {
  const out: DescribedExample[] = [];
  for (const parameter of operation.parameters) {
    for (const example of parameter.examples) {
      out.push({
        source: `parameter:${parameter.location}:${parameter.name}`,
        name: example.name,
        summary: null,
        value: example.value
      });
    }
  }
  const requestMedia =
    operation.request_body === null ? [] : operation.request_body.content;
  for (const media of requestMedia) {
    for (const example of media.examples) {
      out.push({
        source: `request:${media.media_type}`,
        name: example.name,
        summary: example.summary,
        value: example.value
      });
    }
  }
  for (const response of operation.responses) {
    for (const media of response.content) {
      for (const example of media.examples) {
        out.push({
          source: `response:${response.selector}:${media.media_type}`,
          name: example.name,
          summary: example.summary,
          value: example.value
        });
      }
    }
  }
  return out;
}

/** Capability limitations, derived only from support levels in the contract. */
function collectLimitations(operation: OperationIR): string[] {
  const out: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.support !== "supported") {
      out.push(
        `Parameter '${parameter.name}' (${parameter.location}) is ` +
          `${parameter.support}: ${parameter.support_reason_codes.join(", ")}.`
      );
    }
  }
  const requestMedia =
    operation.request_body === null ? [] : operation.request_body.content;
  for (const media of requestMedia) {
    if (media.support !== "supported") {
      out.push(
        `Request media type '${media.media_type}' is ${media.support}` +
          `: ${media.support_reason_codes.join(", ")}.`
      );
    }
  }
  for (const response of operation.responses) {
    for (const media of response.content) {
      if (media.support !== "supported") {
        out.push(
          `Response media type '${media.media_type}' for ${response.selector}` +
            ` is ${media.support}: ${media.support_reason_codes.join(", ")}.`
        );
      }
    }
    for (const header of response.headers) {
      if (header.support !== "supported") {
        out.push(
          `Response header '${header.name}' is ${header.support}` +
            `: ${header.support_reason_codes.join(", ")}.`
        );
      }
    }
  }
  for (const code of operation.support.diagnostic_codes) {
    out.push(`Operation diagnostic: ${code}.`);
  }
  if (operation.support.level !== "supported") {
    out.push(
      `The operation is ${operation.support.level} by the capability report.`
    );
  }
  return out;
}

/**
 * Describe one operation at one detail level. The `summary` level returns
 * identity, parameters, media-type names, security, deprecation, and
 * limitations. The `schemas` level adds inline schemas. The `examples`
 * level adds examples. The `full` level returns everything.
 */
export function describeOperation(
  contract: ContractIR,
  input: DescribeOperationInput
): DescribeOperationResult {
  const detail = input.detail ?? "summary";
  if (!isDescribeDetail(detail)) {
    throw describeError(
      "OAL-DESCRIBE-DETAIL-INVALID",
      "Detail must be summary, schemas, examples, or full.",
      { detail }
    );
  }
  const operation = resolveOperation(contract, input.operation);
  const includeSchemas = detail === "schemas" || detail === "full";
  const includeExamples = detail === "examples" || detail === "full";

  const merged = [operation.summary ?? "", operation.description ?? ""]
    .filter((part) => part.length > 0)
    .map(normalizePlainText)
    .join(" ")
    .trim();
  const bounded = boundPlainText(merged, SOURCE_TEXT_BUDGET);

  const result: DescribeOperationResult = {
    key: operation.key,
    uid: operation.uid,
    operationId: operation.operation_id,
    toolName: operation.tool_name,
    method: operation.method,
    pathTemplate: operation.path_template,
    summary: operation.summary,
    description: bounded.text.length === 0 ? null : bounded.text,
    descriptionTruncated: bounded.truncated,
    tags: [...operation.tags],
    deprecated: operation.deprecated,
    support: operation.support.level,
    detail,
    parameters: {
      path: operation.parameters
        .filter((parameter) => parameter.location === "path")
        .map((parameter) =>
          describedParameter(contract, parameter, includeSchemas)
        ),
      query: operation.parameters
        .filter((parameter) => parameter.location === "query")
        .map((parameter) =>
          describedParameter(contract, parameter, includeSchemas)
        ),
      header: operation.parameters
        .filter((parameter) => parameter.location === "header")
        .map((parameter) =>
          describedParameter(contract, parameter, includeSchemas)
        ),
      cookie: operation.parameters
        .filter((parameter) => parameter.location === "cookie")
        .map((parameter) =>
          describedParameter(contract, parameter, includeSchemas)
        )
    },
    requestBody:
      operation.request_body === null
        ? null
        : {
            required: operation.request_body.required,
            description: operation.request_body.description,
            mediaTypes: operation.request_body.content.map((media) =>
              describedMediaType(contract, media, includeSchemas)
            )
          },
    responses: operation.responses.map((response) =>
      describedResponse(contract, response, includeSchemas)
    ),
    security: describedSecurity(contract, operation),
    limitations: collectLimitations(operation),
    ...(includeExamples ? { examples: collectExamples(operation) } : {})
  };
  return result;
}
