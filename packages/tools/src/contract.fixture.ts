/**
 * Hand-built ContractIR fixture for tool-exposure tests. The compiler lives
 * in `@oal/openapi`, which this package does not depend on, so the fixture
 * is assembled directly from the ContractIR types.
 */

import {
  canonicalJson,
  operationUid,
  schemaUid,
  type Json,
  type JsonObject
} from "@oal/core";
import type {
  ContractIR,
  MediaContentIR,
  OperationIR,
  ParameterIR,
  ParameterLocation,
  ResponseIR,
  RouteSegment,
  SchemaIR,
  SecuritySchemeIR,
  SupportLevel
} from "@oal/contract-ir";

const DOCUMENT = "fixture://computers.json";

const COMPUTER: JsonObject = {
  type: "object",
  required: ["id", "label"],
  properties: {
    id: { type: "integer" },
    label: { type: "string" },
    status: { type: "string", enum: ["ready", "failed"] }
  }
};

const COMPUTER_CREATE: JsonObject = {
  type: "object",
  required: ["label"],
  properties: {
    label: { type: "string" },
    rack_id: { type: "integer", nullable: true }
  }
};

const COMPUTER_LIST: JsonObject = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: { $ref: "#/components/schemas/Computer" }
    },
    total: { type: "integer" }
  }
};

const COMPUTER_REF: JsonObject = { $ref: "#/components/schemas/Computer" };
const STRING_SCHEMA: JsonObject = { type: "string" };

const HEALTH: JsonObject = {
  type: "object",
  properties: { status: { type: "string" } }
};

function register(
  schemas: Record<string, SchemaIR>,
  schema: Json,
  pointer: string
): string {
  const uid = schemaUid(canonicalJson(schema));
  schemas[uid] = {
    uid,
    schema,
    source_pointer: pointer,
    document_uri: DOCUMENT
  };
  return uid;
}

function segments(template: string): RouteSegment[] {
  return template
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? { kind: "parameter", value: segment.slice(1, -1) }
        : { kind: "literal", value: segment }
    );
}

function media(
  mediaType: string,
  schemaRef: string,
  examples: MediaContentIR["examples"] = []
): MediaContentIR {
  return {
    media_type: mediaType,
    schema_ref: schemaRef,
    examples,
    support: "supported",
    support_reason_codes: []
  };
}

function parameter(
  name: string,
  location: ParameterLocation,
  stringSchemaRef: string,
  overrides: Partial<ParameterIR> = {}
): ParameterIR {
  return {
    name,
    location,
    style: location === "query" ? "form" : "simple",
    explode: location === "query",
    allow_reserved: false,
    required: location === "path",
    deprecated: false,
    description: null,
    schema_ref: stringSchemaRef,
    content: null,
    examples: [],
    default_value: undefined,
    support: "supported",
    support_reason_codes: [],
    source_pointer: `#/parameters/${location}/${name}`,
    ...overrides
  };
}

function response(
  selector: string,
  description: string,
  content: MediaContentIR[]
): ResponseIR {
  const status = Number.parseInt(selector, 10);
  return {
    selector,
    selector_kind: Number.isNaN(status) ? "default" : "exact",
    status: Number.isNaN(status) ? null : status,
    description,
    headers: [],
    content,
    source_pointer: `#/responses/${selector}`
  };
}

function operation(input: {
  template: string;
  method: string;
  operationId: string | null;
  toolName: string;
  summary: string | null;
  description?: string | null;
  tags?: string[];
  deprecated?: boolean;
  parameters?: ParameterIR[];
  requestBody?: OperationIR["request_body"];
  responses?: ResponseIR[];
  security?: OperationIR["security"];
  support?: { level: SupportLevel; diagnostic_codes: string[] };
}): OperationIR {
  const key = `path:${input.method} ${input.template}`;
  return {
    key,
    uid: operationUid(key),
    surface: "path",
    method: input.method,
    path_template: input.template,
    route_segments: segments(input.template),
    operation_id: input.operationId,
    tool_name: input.toolName,
    summary: input.summary,
    description: input.description ?? null,
    tags: input.tags ?? [],
    deprecated: input.deprecated ?? false,
    servers: [
      { url: "https://api.example.test", description: null, variables: {} }
    ],
    parameters: input.parameters ?? [],
    request_body: input.requestBody ?? null,
    responses: input.responses ?? [],
    security: input.security ?? null,
    callbacks: [],
    extensions: {},
    source_pointer: `#/paths/${input.template}/${input.method.toLowerCase()}`,
    support: input.support ?? { level: "supported", diagnostic_codes: [] }
  };
}

/** The shared computer contract used by every tool-exposure test. */
export function computerContract(): ContractIR {
  const schemas: Record<string, SchemaIR> = {};
  const computer = register(schemas, COMPUTER, "/components/schemas/Computer");
  const computerCreate = register(
    schemas,
    COMPUTER_CREATE,
    "/components/schemas/ComputerCreate"
  );
  const computerList = register(
    schemas,
    COMPUTER_LIST,
    "/components/schemas/ComputerList"
  );
  const computerRef = register(
    schemas,
    COMPUTER_REF,
    "/components/schemas/ComputerRef"
  );
  const health = register(schemas, HEALTH, "/components/schemas/Health");
  const stringSchema = register(
    schemas,
    STRING_SCHEMA,
    "/components/schemas/String"
  );

  const apiKey: SecuritySchemeIR = {
    name: "ApiKeyAuth",
    type: "apiKey",
    description: null,
    location: "header",
    wire_name: "X-API-Key",
    scheme: null,
    bearer_format: null,
    flows: null,
    open_id_connect_url: null,
    support: "supported",
    support_reason_codes: [],
    source_pointer: "#/components/securitySchemes/ApiKeyAuth"
  };
  const bearer: SecuritySchemeIR = {
    name: "BearerAuth",
    type: "http",
    description: null,
    location: null,
    wire_name: null,
    scheme: "bearer",
    bearer_format: "JWT",
    flows: null,
    open_id_connect_url: null,
    support: "supported",
    support_reason_codes: [],
    source_pointer: "#/components/securitySchemes/BearerAuth"
  };

  const operations: OperationIR[] = [
    operation({
      template: "/v1/computers",
      method: "POST",
      operationId: "createComputer",
      toolName: "createComputer",
      summary: "Create a computer",
      description: "Create a new computer record.",
      tags: ["Computers"],
      requestBody: {
        required: true,
        description: "The computer to create.",
        content: [
          media("application/json", computerCreate, [
            {
              name: "minimal",
              value: { label: "rack-1-node-4" },
              summary: "One labelled computer"
            }
          ])
        ],
        source_pointer: "#/paths/~1v1~1computers/post/requestBody"
      },
      responses: [
        response("201", "Created", [media("application/json", computerRef)])
      ],
      security: {
        anonymous: false,
        alternatives: [{ schemes: [{ name: "ApiKeyAuth", scopes: [] }] }]
      }
    }),
    operation({
      template: "/v1/computers",
      method: "GET",
      operationId: "listComputers",
      toolName: "listComputers",
      summary: "List computers",
      description: "List computers with paging.",
      tags: ["Computers"],
      parameters: [
        parameter("limit", "query", stringSchema),
        parameter("page", "query", stringSchema)
      ],
      responses: [
        response("200", "A page of computers", [
          media("application/json", computerList)
        ])
      ],
      security: {
        anonymous: false,
        alternatives: [{ schemes: [{ name: "ApiKeyAuth", scopes: [] }] }]
      }
    }),
    operation({
      template: "/v1/computers/{computer_id}",
      method: "GET",
      operationId: null,
      toolName: "get_v1_computers_by_computer_id",
      summary: "Read one computer",
      parameters: [parameter("computer_id", "path", stringSchema)],
      responses: [
        response("200", "One computer", [media("application/json", computer)])
      ],
      security: {
        anonymous: false,
        alternatives: [{ schemes: [{ name: "ApiKeyAuth", scopes: [] }] }]
      }
    }),
    operation({
      template: "/v1/computers/{computer_id}",
      method: "DELETE",
      operationId: "deleteComputer",
      toolName: "deleteComputer",
      summary: "Delete a computer",
      tags: ["Computers"],
      deprecated: true,
      parameters: [parameter("computer_id", "path", stringSchema)],
      responses: [response("204", "Deleted", [])],
      security: {
        anonymous: false,
        alternatives: [{ schemes: [{ name: "ApiKeyAuth", scopes: [] }] }]
      }
    }),
    operation({
      template: "/v1/computers/{computer_id}",
      method: "PUT",
      operationId: "replaceComputer",
      toolName: "replaceComputer",
      summary: "Replace a computer",
      tags: ["Computers"],
      parameters: [parameter("computer_id", "path", stringSchema)],
      responses: [
        response("200", "Replaced", [media("application/json", computer)])
      ],
      security: {
        anonymous: false,
        alternatives: [{ schemes: [{ name: "BearerAuth", scopes: [] }] }]
      }
    }),
    operation({
      template: "/health",
      method: "GET",
      operationId: null,
      toolName: "get_health",
      summary: "Report service health",
      parameters: [
        parameter("trace", "query", stringSchema, {
          style: "deepObject",
          support: "unsupported",
          support_reason_codes: ["parameter:style-deep-object"]
        })
      ],
      responses: [
        response("200", "The service is healthy", [
          media("application/json", health)
        ])
      ],
      support: {
        level: "unsupported",
        diagnostic_codes: ["OAL-CAP-PARAMETER-UNSUPPORTED"]
      },
      security: { anonymous: true, alternatives: [] }
    })
  ];

  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "fixture", version: "1" },
    source: {
      entrypoint: DOCUMENT,
      media_type: "application/json",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: [{ uri: DOCUMENT, sha256: "" }]
    },
    api: {
      title: "Computer API",
      version: "1.0.0",
      description: null,
      servers: [
        { url: "https://api.example.test", description: null, variables: {} }
      ]
    },
    security_schemes: { ApiKeyAuth: apiKey, BearerAuth: bearer },
    schemas,
    operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}
