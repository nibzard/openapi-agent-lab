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

export { generateValue, type GenerationOptions } from "./generate.ts";

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
  pickContent,
  stripProperties,
  validateBody,
  validateParameters,
  type BodyValidationResult,
  type ParsedRequest,
  type ValidationResult
} from "./validate.ts";
