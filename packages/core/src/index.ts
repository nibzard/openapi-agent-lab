export const packageName = "@oal/core";

export {
  canonicalJson,
  jsonClone,
  jsonEquals,
  isJsonObject,
  stableJsonStringify
} from "./json.ts";
export type { Json, JsonObject } from "./json.ts";
export {
  canonicalJsonSha256,
  digestEquals,
  isSha256Hex,
  sha256Hex,
  sha256HexBytes,
  SHA256_HEX_PATTERN
} from "./digest.ts";
export {
  assertSafeId,
  isSafeId,
  isToolName,
  operationUid,
  prefixedId24,
  SAFE_ID_PATTERN,
  schemaUid,
  sequenceId,
  TOOL_NAME_PATTERN
} from "./id.ts";
export { DiagnosticCode, diagnostic, errorDiagnostics } from "./diagnostic.ts";
export type {
  Diagnostic,
  DiagnosticLocation,
  DiagnosticPhase,
  DiagnosticSeverity
} from "./diagnostic.ts";
export {
  FAILURE_REGISTRY,
  HTTP_BEHAVIOR_CODES,
  failureClassOf,
  failuresByCategory,
  invalidatesEvidence,
  isHarnessFailure,
  retryPolicyOf
} from "./failure.ts";
export type {
  FailureClass,
  FailureEffect,
  RetryPolicy,
  TaxonomyCategory
} from "./failure.ts";
export {
  EXIT_EVAL_THRESHOLD,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_UNSUPPORTED,
  infrastructure,
  invalidInput,
  OalError,
  toOalError,
  unsupported
} from "./errors.ts";
export type { ExitCode, FailureCategory } from "./errors.ts";
export {
  appendIndex,
  appendPointer,
  escapeToken,
  resolveJsonPointer,
  unescapeToken
} from "./jsonpointer.ts";
export {
  assertSafeRelativePath,
  decodePathSegment,
  isSafeRelativePath,
  isWithin,
  resolveWithinRoot
} from "./safepath.ts";
export {
  formatRfc3339,
  isRfc3339,
  parseRfc3339,
  VIRTUAL_EPOCH_ISO,
  VIRTUAL_EPOCH_MS
} from "./time.ts";
export { parseJsonStrict, StrictJsonError } from "./jsonparse.ts";
export type { StrictJsonOptions } from "./jsonparse.ts";
export { ASSERTABLE_FORMATS, SchemaValidator } from "./schema/validator.ts";
export type {
  SchemaValidatorOptions,
  SchemaViolation
} from "./schema/validator.ts";
export {
  closeSchemaWorker,
  configureSchemaWorker,
  DEFAULT_SCHEMA_WORKER_SETTINGS,
  firstPrintableMatchInWorker,
  patternAcceptsInWorker,
  scanForbiddenTextInWorker,
  schemaWorkerService,
  SchemaWorkerError,
  SchemaWorkerService,
  validateSchemaInstance
} from "./schema/worker-service.ts";
export type {
  SchemaWorkerErrorCode,
  SchemaWorkerSettings
} from "./schema/worker-service.ts";
export type {
  SchemaWorkerReply,
  SchemaWorkerRequest,
  SchemaWorkerResult
} from "./schema/worker-protocol.ts";
export {
  CREDENTIAL_KEY_FRAGMENTS,
  CREDENTIAL_KEY_PATTERN,
  isCredentialKey,
  normalizeCredentialKey
} from "./sensitive.ts";
export * from "./yaml.ts";
