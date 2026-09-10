/**
 * Framework response defaults from specification section 15.2. Stable
 * codes are API; the table maps every gateway failure condition to its
 * status and code.
 */

export interface FrameworkError {
  status: number;
  code: string;
  title: string;
}

export const FRAMEWORK_ERRORS = {
  requestMalformed: {
    status: 400,
    code: "request_malformed",
    title: "The request could not be parsed."
  },
  authenticationFailed: {
    status: 401,
    code: "authentication_failed",
    title: "Authentication is missing or invalid."
  },
  authorizationFailed: {
    status: 403,
    code: "authorization_failed",
    title: "The authenticated principal is not authorized."
  },
  routeNotFound: {
    status: 404,
    code: "route_not_found",
    title: "The request target is not a known route."
  },
  methodNotAllowed: {
    status: 405,
    code: "method_not_allowed",
    title: "The method is not allowed on this route."
  },
  requestTargetTooLarge: {
    status: 414,
    code: "request_target_too_large",
    title: "The request target exceeds the size limit."
  },
  requestBodyTooLarge: {
    status: 413,
    code: "request_body_too_large",
    title: "The request body exceeds the size limit."
  },
  multipartPartsTooMany: {
    status: 413,
    code: "multipart_parts_too_many",
    title: "The multipart body exceeds the parts limit."
  },
  mediaTypeUnsupported: {
    status: 415,
    code: "media_type_unsupported",
    title: "The request media type is not supported."
  },
  requestSchemaInvalid: {
    status: 422,
    code: "request_schema_invalid",
    title: "The request does not match its schema."
  },
  requestQuotaExceeded: {
    status: 429,
    code: "request_quota_exceeded",
    title: "The request quota is exceeded."
  },
  mockBehaviorUnavailable: {
    status: 501,
    code: "mock_behavior_unavailable",
    title: "The scenario operation is unavailable."
  },
  behaviorTimeout: {
    status: 504,
    code: "behavior_timeout",
    title: "The backend timed out."
  },
  schemaWorkerTimeout: {
    status: 504,
    code: "OAL-SCHEMA-WORKER-TIMEOUT",
    title: "Schema evaluation exceeded its deadline."
  },
  schemaWorkerFailed: {
    status: 500,
    code: "OAL-SCHEMA-WORKER-FAILED",
    title: "Schema evaluation failed inside its execution boundary."
  },
  mockResponseInvalid: {
    status: 500,
    code: "mock_response_invalid",
    title: "The backend result violates the contract."
  },
  contractVersionUnsupported: {
    status: 500,
    code: "contract_schema_version_unsupported",
    title: "The contract schema version is not supported."
  },
  internalError: {
    status: 500,
    code: "internal_error",
    title: "An unexpected internal failure occurred."
  },
  responseMediaTypeUnacceptable: {
    status: 406,
    code: "response_media_type_unacceptable",
    title: "No response media type is acceptable."
  }
} as const satisfies Record<string, FrameworkError>;

export type FrameworkErrorKey = keyof typeof FRAMEWORK_ERRORS;

/**
 * RFC 9457 problem document with the two framework extensions: stable
 * code and request_id. Nothing else about the failure leaks: no stack,
 * host path, SQL, or module detail.
 */
export function problemDocument(
  error: FrameworkError,
  requestId: string,
  detail?: string,
  violations?: readonly RequestViolation[]
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    type: `https://agentlab.dev/problems/${error.code}`,
    title: error.title,
    status: error.status,
    code: error.code,
    request_id: requestId
  };
  if (detail !== undefined && detail.length > 0) {
    document.detail = detail;
  }
  if (violations !== undefined && violations.length > 0) {
    document.violations = violations;
  }
  return document;
}

/** Stable request-validation violation record from section 15.3. */
export interface RequestViolation {
  location: "path" | "query" | "header" | "cookie" | "body";
  pointer: string;
  code: string;
  message: string;
}
