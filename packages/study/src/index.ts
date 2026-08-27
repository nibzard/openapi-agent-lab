export const packageName = "@oal/study";

export {
  preflightAnalyticalRun,
  resolvedCellCount,
  ReviewCode,
  reviewStudyDesign
} from "./validate.ts";
export type {
  AnalyticalRunDecision,
  AnalyticalRunInput,
  StudyFinding,
  StudyReviewInput
} from "./validate.ts";

export {
  COMPATIBILITY_ALGORITHM,
  COMPATIBILITY_SCHEMA_VERSION,
  CompatibilityCode,
  cellCompatibility,
  cellCompatibilityDocument,
  poolCompatibleCells,
  studyCompatibility,
  studyCompatibilityDocument
} from "./compatibility.ts";
export type {
  CellCompatibilityAdditions,
  CellCompatibilityInput,
  CellCompatibilityRecord,
  CellCompatibilityVerdict,
  CompatibilityFactorBinding,
  CompatibilityFactorLevel,
  CompatibilityFactorManifest,
  CompatibilityFactorRole,
  CompatibilityKeyResult,
  CompatibilityPoolResult,
  ContractVariantInventory,
  StudyCompatibilityInput
} from "./compatibility.ts";

export {
  AbortReason,
  deriveStudyCompleted,
  executeStudyRun,
  planStudyRun,
  RunCode,
  studyBlockCompletion,
  studyCompletedJson
} from "./run.ts";
export type {
  ActivationNotice,
  StudyCompletedDerivationInput,
  StudyCompletedResult,
  StudyRunCompleted,
  StudyRunExecution,
  StudyRunExecutionOptions,
  StudyRunPlan,
  StudyRunPlanInput,
  StudyRunPlanResult,
  StudyRunPreflight,
  TrialExecutor,
  TrialLaunch,
  TrialOutcome
} from "./run.ts";

export {
  ANALYSIS_KIND,
  ANALYSIS_SCHEMA_VERSION,
  AnalysisCode,
  analyzeStudyRun,
  DEFAULT_CONFIDENCE_LEVEL,
  serializeStudyAnalysis,
  studyAnalysisContentSha256,
  studyAnalysisJson,
  studyAnalysisSha256
} from "./analyze.ts";
export type {
  AnalysisLineage,
  CellEvidence,
  SlotOutcome,
  StudyAnalysis,
  StudyAnalysisInput,
  StudyAnalysisResult,
  VerificationEntry
} from "./analyze.ts";
