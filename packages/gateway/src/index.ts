/**
 * Public gateway surface. The runner starts the per-trial server through
 * these entry points; consumers never import gateway modules directly.
 */

export const packageName = "@oal/gateway";

export {
  handleGatewayRequest,
  type GatewayOptions,
  type GatewayResponse,
  type RawRequest
} from "./server.ts";

export {
  evaluateSecurity,
  grantedScopes,
  mintRunCredentials,
  type AuthOutcome,
  type PresentedCredentials,
  type Principal,
  type RunCredentials
} from "./auth.ts";

export {
  FRAMEWORK_ERRORS,
  problemDocument,
  type FrameworkError,
  type FrameworkErrorKey,
  type RequestViolation
} from "./problem.ts";

export {
  chooseSuccessResponse,
  findResponseForStatus,
  pickMediaType,
  provenanceKey,
  selectExampleValue,
  selectResponse,
  type ContractFixture,
  type SelectedResponse
} from "./select.ts";

export {
  generateValue,
  GenerationUnsupportedError,
  type GenerationOptions
} from "./generate.ts";

export {
  patternAccepts,
  synthesizePattern,
  type PatternBounds
} from "./pattern.ts";

export {
  validateResponse,
  type ResponseValidationResult,
  type ResponseViolation
} from "./response.ts";

export { createGatewayState, type GatewayState } from "./state.ts";

export {
  parseMultipart,
  type MultipartPart,
  type MultipartResult
} from "./multipart.ts";

export {
  captureBodyEvidence,
  MemoryBlobStore,
  traceHeaders,
  traceQueryParameters,
  type BlobStore,
  type BodyEvidence,
  type TraceHeader,
  type TraceQueryParameter
} from "./trace.ts";

export {
  startGatewayListener,
  type GatewayListener,
  type GatewayTraceEvent,
  type ListenerOptions
} from "./listener.ts";

export {
  defaultExplodeFor,
  defaultStyleFor,
  deserializeParameter,
  parseScalar,
  type ParsedParameter,
  type ParseOutcome
} from "./params.ts";

export { matchRoute, type RouteMatch, type RouteResult } from "./router.ts";

export {
  matchRequestMedia,
  negotiateResponseMedia,
  parseAccept,
  type AcceptPreference
} from "./negotiate.ts";

export {
  createContractSchemaLookup,
  pickContent,
  stripProperties,
  validateBody,
  validateParameters,
  type BodyValidationResult,
  type ParsedRequest,
  type SchemaLookup,
  type ValidationResult
} from "./validate.ts";
