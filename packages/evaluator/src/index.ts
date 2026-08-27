export const packageName = "@oal/evaluator";

export {
  DEFAULT_EXPRESSION_LIMITS,
  ExpressionError,
  compileExpression,
  evaluateExpression,
  evaluatePredicate,
  jsonTypeName,
  parseExpression
} from "./expression.ts";
export type {
  BinaryOperator,
  CompiledExpression,
  ExpressionErrorCode,
  ExpressionLimits,
  ExpressionNode
} from "./expression.ts";
export { RUBRIC_SCHEMA_VERSION, loadRubric } from "./rubric.ts";
export type {
  EvidenceClass,
  MatchQuantifier,
  OnMissing,
  Rubric,
  RubricCheck,
  RubricLoadOptions,
  RubricLoadResult,
  RubricPostcondition,
  RubricScoring,
  RubricSignal,
  RubricStep,
  SequenceMatch
} from "./rubric.ts";
export {
  EvalDocCode,
  loadEval,
  loadEvalCase,
  loadEvalCases,
  templateVariablesOf
} from "./eval-doc.ts";
export type {
  Eval,
  EvalCase,
  EvalCaseOptions,
  EvalCaseResult,
  EvalCases,
  EvalCasesResult,
  EvalLoadOptions,
  EvalLoadResult,
  EvalParticipantFile,
  EvalResult,
  EvalTask,
  OperationScope,
  OperationSelector,
  TemplateEngine
} from "./eval-doc.ts";
export {
  DEFAULT_EVALUATOR_LIMITS,
  REPORT_ARTIFACT_REF,
  evaluateRubric,
  toEvaluation
} from "./evaluate.ts";
export type {
  ArtifactMetadata,
  CheckResult,
  EvaluateOptions,
  EvaluationMetadata,
  EvaluationResult,
  EvaluatorLimits,
  PostconditionOutcome,
  StepOutcome
} from "./evaluate.ts";
export {
  EVALUATION_SCHEMA_VERSION,
  EVALUATOR_NAME,
  EVALUATOR_VERSION,
  EvaluatorErrorCode,
  infrastructureError
} from "./evaluation.ts";
export type {
  Evaluation,
  EvaluationCheckRecord,
  EvaluationStatus,
  EvaluatorErrorCodeValue,
  InfrastructureErrorRecord
} from "./evaluation.ts";
