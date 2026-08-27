import type { Diagnostic, Json, JsonObject } from "@oal/core";

/**
 * Immutable normalized contract representation. Every downstream subsystem
 * consumes ContractIR; none reinterprets source OpenAPI. Serialized form
 * validates against schemas/contract-ir.v1.schema.json.
 */

export const CONTRACT_IR_SCHEMA_VERSION = 1 as const;
export const CONTRACT_IR_SCHEMA_URI =
  "https://agentlab.dev/schemas/contract-ir.v1.json";

/** Route segment after template split: literal or parameter. */
export interface RouteSegment {
  kind: "literal" | "parameter";
  /** Literal text or the parameter name without braces. */
  value: string;
}

/** Normalized JSON Schema with source provenance. */
export interface SchemaIR {
  uid: string;
  /** Draft 2020-12-equivalent schema after OpenAPI 3.0 normalization. */
  schema: Json;
  /** Original JSON Pointer of the schema in its source document. */
  source_pointer: string;
  document_uri: string;
}

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export type ParameterStyle =
  | "simple"
  | "label"
  | "matrix"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

export interface ParameterExampleIR {
  name: string | null;
  value: Json;
}

export interface ParameterContentIR {
  media_type: string;
  schema_ref: string;
  examples: ParameterExampleIR[];
}

export interface ParameterIR {
  name: string;
  location: ParameterLocation;
  style: ParameterStyle;
  explode: boolean;
  allow_reserved: boolean;
  required: boolean;
  deprecated: boolean;
  description: string | null;
  /** Schema reference when the parameter uses `schema`. */
  schema_ref: string | null;
  /** Media-type content when the parameter uses `content`. */
  content: ParameterContentIR | null;
  examples: ParameterExampleIR[];
  default_value: Json | undefined;
  /** Serialization support outcome for this parameter. */
  support: SupportLevel;
  support_reason_codes: string[];
  source_pointer: string;
}

export interface RequestBodyIR {
  required: boolean;
  description: string | null;
  content: MediaContentIR[];
  source_pointer: string;
}

export interface MediaExampleIR {
  name: string | null;
  value: Json;
  summary: string | null;
}

export interface MediaContentIR {
  media_type: string;
  schema_ref: string | null;
  examples: MediaExampleIR[];
  support: SupportLevel;
  support_reason_codes: string[];
}

export type ResponseSelectorKind = "exact" | "range" | "default";

export interface ResponseHeaderIR {
  name: string;
  required: boolean;
  deprecated: boolean;
  description: string | null;
  schema_ref: string | null;
  content: ParameterContentIR | null;
  examples: ParameterExampleIR[];
  support: SupportLevel;
  support_reason_codes: string[];
}

export interface ResponseIR {
  /** "200", "2XX", or "default". */
  selector: string;
  selector_kind: ResponseSelectorKind;
  /** Concrete status for exact selectors; null otherwise. */
  status: number | null;
  description: string | null;
  headers: ResponseHeaderIR[];
  content: MediaContentIR[];
  source_pointer: string;
}

export interface SecurityRequirementIR {
  schemes: Array<{ name: string; scopes: string[] }>;
}

export interface OperationSecurityIR {
  anonymous: boolean;
  alternatives: SecurityRequirementIR[];
}

export interface CallbackIR {
  name: string;
  /** method + path template -> request body description, preserved as data. */
  expressions: Array<{
    method: string;
    path_template: string;
    request_body: RequestBodyIR | null;
    responses: ResponseIR[];
  }>;
  source_pointer: string;
}

export type SupportLevel =
  | "supported"
  | "approximated"
  | "requires_scenario"
  | "unsupported";

export interface OperationSupportIR {
  level: SupportLevel;
  diagnostic_codes: string[];
}

export interface ServerIR {
  url: string;
  description: string | null;
  variables: Record<
    string,
    { enum: string[]; default: string; description: string | null }
  >;
}

export interface OperationIR {
  /** Canonical key: `path:<METHOD> <path-template>`. */
  key: string;
  uid: string;
  surface: "path" | "webhook";
  method: string;
  path_template: string;
  route_segments: RouteSegment[];
  operation_id: string | null;
  tool_name: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  deprecated: boolean;
  servers: ServerIR[];
  parameters: ParameterIR[];
  request_body: RequestBodyIR | null;
  responses: ResponseIR[];
  security: OperationSecurityIR | null;
  callbacks: CallbackIR[];
  extensions: JsonObject;
  source_pointer: string;
  support: OperationSupportIR;
}

export type SecuritySchemeType =
  | "apiKey"
  | "http"
  | "oauth2"
  | "openIdConnect"
  | "mutualTLS";

export interface OAuthFlowIR {
  authorization_url: string | null;
  token_url: string | null;
  refresh_url: string | null;
  scopes: Record<string, string>;
}

export interface SecuritySchemeIR {
  name: string;
  type: SecuritySchemeType;
  description: string | null;
  /** apiKey location. */
  location: ParameterLocation | null;
  /** apiKey wire name (header name, query key, or cookie name). */
  wire_name: string | null;
  /** http scheme, for example basic or bearer. */
  scheme: string | null;
  bearer_format: string | null;
  flows: Record<string, OAuthFlowIR> | null;
  open_id_connect_url: string | null;
  support: SupportLevel;
  support_reason_codes: string[];
  source_pointer: string;
}

export interface WebhookIR {
  name: string;
  description: string | null;
  operations: OperationIR[];
  source_pointer: string;
}

export interface ContractSourceIR {
  entrypoint: string;
  media_type: string;
  openapi_version: string;
  sha256: string;
  semantic_sha256: string;
  execution_sha256: string;
  documents: Array<{ uri: string; sha256: string }>;
}

export interface ContractApiIR {
  title: string | null;
  version: string | null;
  description: string | null;
  servers: ServerIR[];
}

export interface ContractIR {
  $schema: typeof CONTRACT_IR_SCHEMA_URI;
  schema_version: typeof CONTRACT_IR_SCHEMA_VERSION;
  kind: "ContractIR";
  compiler: { name: string; version: string };
  source: ContractSourceIR;
  api: ContractApiIR;
  security_schemes: Record<string, SecuritySchemeIR>;
  /** Normalized schema registry keyed by schema UID. */
  schemas: Record<string, SchemaIR>;
  operations: OperationIR[];
  webhooks: WebhookIR[];
  diagnostics: Diagnostic[];
  extensions: JsonObject;
}

export function operationKey(method: string, pathTemplate: string): string {
  return `path:${method.toUpperCase()} ${pathTemplate}`;
}
