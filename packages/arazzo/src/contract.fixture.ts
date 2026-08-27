/**
 * Hand-built ContractIR fixture for Arazzo compiler and alignment tests. The
 * compiler lives in `@oal/openapi`, which this package does not depend on, so
 * the fixture is assembled directly from the ContractIR types.
 */

import type {
  ContractIR,
  MediaContentIR,
  OperationIR,
  ParameterIR,
  ParameterLocation,
  RequestBodyIR,
  ResponseIR,
  RouteSegment,
  SchemaIR,
  SecuritySchemeIR
} from "@oal/contract-ir";
import {
  canonicalJson,
  operationUid,
  schemaUid,
  type JsonObject
} from "@oal/core";

const DOCUMENT = "fixture://steel-contract.json";

const COMPUTER_CREATE: JsonObject = {
  type: "object",
  required: ["template"],
  properties: {
    template: { type: "string" },
    label: { type: "string" }
  }
};

const COMPUTER: JsonObject = {
  type: "object",
  required: ["id", "template", "state"],
  properties: {
    id: { type: "string" },
    template: { type: "string" },
    state: { type: "string", enum: ["running", "paused", "restoring"] }
  }
};

const UPLOAD_RESULT: JsonObject = {
  type: "object",
  required: ["file_id", "sha256"],
  properties: {
    file_id: { type: "string" },
    sha256: { type: "string" }
  }
};

const CHECKPOINT_RESULT: JsonObject = {
  type: "object",
  required: ["checkpoint_id", "sha256"],
  properties: {
    checkpoint_id: { type: "string" },
    sha256: { type: "string" }
  }
};

const RESTORE_RESULT: JsonObject = {
  type: "object",
  required: ["computer_id", "checkpoint_id", "sha256"],
  properties: {
    computer_id: { type: "string" },
    checkpoint_id: { type: "string" },
    sha256: { type: "string" }
  }
};

const DOWNLOAD_RESULT: JsonObject = {
  type: "object",
  required: ["sha256", "content"],
  properties: {
    sha256: { type: "string" },
    content: { type: "string", contentEncoding: "base64" }
  }
};

const PAUSE_RESULT: JsonObject = {
  type: "object",
  required: ["id", "state"],
  properties: {
    id: { type: "string" },
    state: { type: "string" }
  }
};

const STRING_SCHEMA: JsonObject = { type: "string" };
const EMPTY_OBJECT: JsonObject = {
  type: "object",
  properties: {}
};

function register(
  schemas: Record<string, SchemaIR>,
  schema: JsonObject,
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

function media(mediaType: string, schemaRef: string): MediaContentIR {
  return {
    media_type: mediaType,
    schema_ref: schemaRef,
    examples: [],
    support: "supported",
    support_reason_codes: []
  };
}

function parameter(
  name: string,
  location: ParameterLocation,
  ref: string
): ParameterIR {
  return {
    name,
    location,
    style: location === "path" ? "simple" : "form",
    explode: false,
    allow_reserved: false,
    required: location === "path",
    deprecated: false,
    description: null,
    schema_ref: ref,
    content: null,
    examples: [],
    default_value: undefined,
    support: "supported",
    support_reason_codes: [],
    source_pointer: `#/paths/-/parameters/${name}`
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

function body(
  required: boolean,
  content: MediaContentIR[],
  pointer: string
): RequestBodyIR {
  return {
    required,
    description: null,
    content,
    source_pointer: pointer
  };
}

function operation(input: {
  template: string;
  method: string;
  operationId: string | null;
  toolName: string;
  summary: string;
  parameters?: ParameterIR[];
  requestBody?: RequestBodyIR;
  responses: ResponseIR[];
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
    description: null,
    tags: [],
    deprecated: false,
    servers: [
      { url: "https://api.steel.test", description: null, variables: {} }
    ],
    parameters: input.parameters ?? [],
    request_body: input.requestBody ?? null,
    responses: input.responses,
    security: {
      anonymous: false,
      alternatives: [{ schemes: [{ name: "ApiKeyAuth", scopes: [] }] }]
    },
    callbacks: [],
    extensions: {},
    source_pointer: `#/paths/${input.template}/${input.method.toLowerCase()}`,
    support: { level: "supported", diagnostic_codes: [] }
  };
}

/**
 * The Steel Computer contract used by every Arazzo test. It declares the
 * recovery flow operations that `fixtures/steel-workflow.json` references.
 */
export function steelContract(): ContractIR {
  const schemas: Record<string, SchemaIR> = {};
  const computerCreate = register(
    schemas,
    COMPUTER_CREATE,
    "/components/schemas/ComputerCreate"
  );
  const computer = register(schemas, COMPUTER, "/components/schemas/Computer");
  const upload = register(
    schemas,
    UPLOAD_RESULT,
    "/components/schemas/UploadResult"
  );
  const checkpoint = register(
    schemas,
    CHECKPOINT_RESULT,
    "/components/schemas/CheckpointResult"
  );
  const restore = register(
    schemas,
    RESTORE_RESULT,
    "/components/schemas/RestoreResult"
  );
  const download = register(
    schemas,
    DOWNLOAD_RESULT,
    "/components/schemas/DownloadResult"
  );
  const pause = register(
    schemas,
    PAUSE_RESULT,
    "/components/schemas/PauseResult"
  );
  const stringSchema = register(
    schemas,
    STRING_SCHEMA,
    "/components/schemas/String"
  );
  const empty = register(schemas, EMPTY_OBJECT, "/components/schemas/Empty");

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

  const computerId = parameter("computer_id", "path", stringSchema);

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
      title: "Steel Computer API",
      version: "1.0.0",
      description: null,
      servers: [
        { url: "https://api.steel.test", description: null, variables: {} }
      ]
    },
    security_schemes: { ApiKeyAuth: apiKey },
    schemas,
    operations: [
      operation({
        template: "/v1/computers",
        method: "POST",
        operationId: "createComputer",
        toolName: "createComputer",
        summary: "Create one computer",
        requestBody: body(
          true,
          [media("application/json", computerCreate)],
          "#/paths/~1v1~1computers/post/requestBody"
        ),
        responses: [
          response("201", "Created", [media("application/json", computer)])
        ]
      }),
      operation({
        template: "/v1/computers/{computer_id}/files",
        method: "POST",
        operationId: "uploadFile",
        toolName: "uploadFile",
        summary: "Upload one file",
        parameters: [computerId],
        requestBody: body(
          true,
          [media("application/octet-stream", stringSchema)],
          "#/paths/~1v1~1computers~1{computer_id}~1files/post/requestBody"
        ),
        responses: [
          response("201", "Uploaded", [media("application/json", upload)])
        ]
      }),
      operation({
        template: "/v1/computers/{computer_id}/checkpoints",
        method: "POST",
        operationId: "createCheckpoint",
        toolName: "createCheckpoint",
        summary: "Checkpoint one computer",
        parameters: [computerId],
        requestBody: body(
          true,
          [media("application/json", empty)],
          "#/paths/~1v1~1computers~1{computer_id}~1checkpoints/post/requestBody"
        ),
        responses: [
          response("201", "Checkpointed", [
            media("application/json", checkpoint)
          ])
        ]
      }),
      operation({
        template:
          "/v1/computers/{computer_id}/checkpoints/{checkpoint_id}/restore",
        method: "POST",
        operationId: "restoreComputer",
        toolName: "restoreComputer",
        summary: "Restore one checkpoint",
        parameters: [
          computerId,
          parameter("checkpoint_id", "path", stringSchema)
        ],
        requestBody: body(
          true,
          [media("application/json", empty)],
          "#/paths/~1v1~1computers~1{computer_id}~1checkpoints~1{checkpoint_id}~1restore/post/requestBody"
        ),
        responses: [
          response("200", "Restored", [media("application/json", restore)])
        ]
      }),
      operation({
        template: "/v1/computers/{computer_id}/files/{file_id}",
        method: "GET",
        operationId: "downloadFile",
        toolName: "downloadFile",
        summary: "Download one file",
        parameters: [computerId, parameter("file_id", "path", stringSchema)],
        responses: [
          response("200", "One file", [media("application/json", download)])
        ]
      }),
      operation({
        template: "/v1/computers/{computer_id}/pause",
        method: "POST",
        operationId: "pauseComputer",
        toolName: "pauseComputer",
        summary: "Pause one computer",
        parameters: [computerId],
        responses: [
          response("200", "Paused", [media("application/json", pause)])
        ]
      })
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}
