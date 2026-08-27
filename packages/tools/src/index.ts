export const packageName = "@oal/tools";

export {
  applyResultTruncation,
  decodeBinaryBody,
  DEFAULT_ENVELOPE_LIMITS,
  emptyParameters,
  encodeBinaryBody,
  ENVELOPE_PARAMETER_GROUPS,
  ENVELOPE_SCHEMA_VERSION,
  isBinaryBody,
  protectedParameterNames,
  PROTECTED_AUTH_PARAMETER,
  rejectProtectedParameters,
  REQUEST_ID_PATTERN,
  TRUNCATION_POLICY,
  validateInvocationEnvelope,
  validateInvocationResult
} from "./envelope.ts";
export type {
  BinaryBody,
  EnvelopeLimits,
  EnvelopeParameterGroup,
  HeaderValues,
  InvocationEnvelope,
  InvocationParameters,
  InvocationResult,
  TruncationPolicy,
  TruncationRecord
} from "./envelope.ts";

export {
  assertNamingConstraints,
  buildDirectToolMap,
  DEFAULT_NAMING_CONSTRAINTS,
  generateToolName,
  namingCandidates
} from "./naming.ts";
export type {
  DirectToolMap,
  NamingCandidate,
  NamingConstraints,
  ToolNameAssignment
} from "./naming.ts";

export {
  boundPlainText,
  buildToolDescription,
  normalizePlainText,
  SERIALIZATION_GUIDANCE,
  SOURCE_TEXT_BUDGET,
  TOOL_DESCRIPTION_LIMIT,
  UNTRUSTED_LABEL
} from "./description.ts";
export type { ToolDescriptionSource } from "./description.ts";

export {
  compareCodePoints,
  OperationSearchIndex,
  queryTokens,
  SEARCH_ALGORITHM_VERSION,
  SEARCH_FIELD_WEIGHTS,
  SEARCH_LIMITS,
  SEARCH_SCORE_FACTORS,
  SEARCH_TOKENIZER_VERSION,
  searchAlgorithm,
  searchOperations,
  STOP_WORD_LIST_FILE,
  STOP_WORD_LIST_VERSION,
  stopWords,
  tokenize
} from "./search.ts";
export type {
  SearchAlgorithmDescriptor,
  SearchFieldName,
  SearchOperationRecord,
  SearchOperationsInput,
  SearchOperationsResult
} from "./search.ts";

export {
  DESCRIBE_DETAIL_LEVELS,
  describeOperation,
  isDescribeDetail,
  resolveOperation
} from "./describe.ts";
export type {
  DescribeDetail,
  DescribeOperationInput,
  DescribeOperationResult,
  DescribedExample,
  DescribedMediaType,
  DescribedParameter,
  DescribedResponse,
  DescribedSecurityAlternative
} from "./describe.ts";

export {
  CatalogInvokeBridge,
  MCP_TRANSPORT_KINDS,
  toEnvelope
} from "./invoke.ts";
export type {
  CatalogInvokeInput,
  CatalogInvokeOptions,
  CatalogInvokeReport,
  InvocationContext,
  InvocationTarget,
  McpTransportKind,
  ToolTransportKind
} from "./invoke.ts";
