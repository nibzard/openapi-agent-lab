/**
 * Public surface of `@oal/openapi`: strict ingestion and compilation of
 * OpenAPI 3.0.x and 3.1.x documents into ContractIR plus a capability report.
 */

export {
  COMPILER_LIMIT_DEFAULTS,
  resolveCompilerLimits,
  type CompilerLimits
} from "./limits.ts";

export {
  parseSafeYaml,
  type SafeYamlError,
  type SafeYamlErrorCode,
  type SafeYamlOptions
} from "./yaml.ts";

export {
  DEFAULT_REF_POLICY,
  discoverExternalRefs,
  normalizeRelativePath,
  ReferenceResolver,
  splitRef,
  type RefPolicy,
  type RefTarget,
  type ResolvedNode
} from "./refs.ts";

export {
  documentSetFromRecord,
  loadDocumentSet,
  type DocumentSet
} from "./loader.ts";

export {
  detectSourceFormat,
  mediaFamily,
  mediaSupport,
  SOURCE_MEDIA_TYPES,
  type MediaFamily,
  type SourceFormat
} from "./media.ts";

export { normalizeSchema, type OpenApiDialect } from "./normalize.ts";

export {
  parsePathTemplate,
  renderTemplate,
  templatesConflict,
  PATH_METHODS
} from "./routes.ts";

export {
  assignToolNames,
  generateToolName,
  type ToolNameAssignment,
  type ToolNameCandidate,
  type ToolNameResult
} from "./tools.ts";

export {
  allLevels,
  DEFAULT_EXPLODE,
  DEFAULT_STYLE,
  parameterSupport,
  responseSelectorSupport,
  schemaShape,
  securitySchemeSupport,
  worstLevel,
  worstOf,
  SUPPORT_RANK,
  type ParameterSupportInput,
  type SchemaShape,
  type SupportOutcome
} from "./support.ts";

export {
  captureExamples,
  jsonByteLength,
  type CapturedExample,
  type ExampleBudget
} from "./examples.ts";

export { SchemaRegistry } from "./schemas.ts";

export {
  isSensitiveExample,
  SENSITIVE_ANNOTATION,
  SENSITIVE_KEY_PATTERN
} from "./sensitive.ts";

export {
  buildCapabilityReport,
  capabilityReportJson,
  CAP_LINK_DESCRIBED,
  DIRECT_TOOL_MAX_OPERATIONS,
  DIRECT_TOOL_MAX_SCHEMA_BYTES,
  preferredToolName,
  strictBlockersOf,
  type CapabilityOptions
} from "./capability.ts";

export {
  compileOpenApi,
  COMPILER_NAME,
  COMPILER_VERSION,
  OpenApiCompiler,
  type CompileInput,
  type CompileOptions,
  type CompileResult
} from "./compile.ts";
