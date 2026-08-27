export const packageName = "@oal/arazzo";

export { ArazzoCode } from "./codes.ts";
export type { ArazzoCodeValue } from "./codes.ts";
export {
  ArazzoExpressionError,
  collectRuntimeSources,
  DEFAULT_EXPRESSION_LIMITS,
  evaluateCriterion,
  evaluateOperand,
  evaluateRuntimeSource,
  isTemplateText,
  parseCriterion,
  parseRuntimeExpression,
  parseTemplate
} from "./expressions.ts";
export type {
  ArazzoExpressionErrorCode,
  ArazzoExpressionLimits,
  CompareOperator,
  CriterionEvaluation,
  CriterionNode,
  OperandNode,
  RuntimeContext,
  RuntimeSource,
  TemplatePart
} from "./expressions.ts";
export {
  DEFAULT_MAX_ASSIGNMENTS,
  DEFAULT_MAX_CANDIDATES,
  alignWorkflow
} from "./align.ts";
export type {
  AlignmentEvent,
  AlignmentReason,
  AlignOptions,
  CriterionOutcome,
  StepAlignment,
  StepOutcome,
  WorkflowAlignment
} from "./align.ts";
export {
  ARRAZZO_COMPILER_NAME,
  ARRAZZO_COMPILER_VERSION,
  WORKFLOW_IR_SCHEMA_VERSION,
  compileArazzo
} from "./compile.ts";
export type {
  ArazzoCompileOptions,
  BoundValue,
  CompiledCriterion,
  CompiledOutput,
  CompiledParameter,
  CompiledRequestBody,
  CompiledStep,
  CompiledWorkflow,
  MappedLocation,
  WorkflowIR
} from "./compile.ts";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  SUPPORTED_ARAZZO_PATTERN,
  isSupportedArazzoVersion,
  parseArazzo
} from "./parse.ts";
export type {
  ArazzoDocument,
  ArazzoParseOptions,
  ArazzoParseResult,
  CriterionDoc,
  ParameterDoc,
  RequestBodyDoc,
  SourceDescriptionDoc,
  StepDoc,
  WorkflowDoc
} from "./parse.ts";
