export const packageName = "@oal/study-ir";

export { StudyCode } from "./codes.ts";
export type { StudyDiagnosticCode } from "./codes.ts";

export {
  canonicalNestedPatch,
  collectOperationReferences,
  deriveCellId,
  expandCellProduct,
  isSafeProtocolRootPath,
  loadProtocol,
  OPERATION_KEY_PATTERN,
  protocolJson,
  resolveCellInventory,
  RUN_PROFILE_PATCH_FIELDS,
  STUDY_PROTOCOL_API_VERSION,
  STUDY_PROTOCOL_KIND
} from "./protocol.ts";
export type {
  DeclaredCell,
  FactorLevel,
  FactorRole,
  MissingnessPolicy,
  MetricSource,
  MetricType,
  PackRef,
  ProtocolBlinding,
  ProtocolConstants,
  ProtocolEvaluation,
  ProtocolFactor,
  ProtocolLoadOptions,
  ProtocolLoadResult,
  ProtocolMetadata,
  ProtocolMetric,
  ProtocolMetrics,
  ProtocolReferences,
  ResolvedCell,
  RunProfilePatch,
  StudyProtocol
} from "./protocol.ts";

export {
  factorRoles,
  loadPhasePlan,
  PHASE_PLAN_API_VERSION,
  PHASE_PLAN_KIND
} from "./phase.ts";
export type {
  ActivationRule,
  AnalysisMethods,
  CensorClass,
  ComparisonFamily,
  ContrastDirection,
  Disposition,
  EvidenceIntegrity,
  PhaseAnalysis,
  PhaseContrast,
  PhaseDesign,
  PhaseEligibility,
  PhasePaidCalls,
  PhasePlan,
  PhasePlanLoadOptions,
  PhasePlanLoadResult,
  PhasePurpose,
  PhaseReplacements,
  PhaseRuntimeLock,
  PhaseStopping,
  PrimaryEstimand,
  EstimandMeasure
} from "./phase.ts";

export { loadBlindingReview, loadEquivalenceReview } from "./review.ts";
export type {
  BlindingReview,
  BlindingReviewLoadResult,
  BlindingReviewSurface,
  EquivalenceReview,
  EquivalenceReviewLoadResult,
  EquivalenceReviewedArtifact,
  FindingSeverity,
  ReviewFinding,
  ReviewLoadOptions,
  ReviewReviewer
} from "./review.ts";

export {
  compileStudy,
  declaredMemberPaths,
  memberDigest,
  protocolSourceDigest,
  serializeStudyIr,
  studyIrJson,
  studyIrSha256,
  STUDY_IR_KIND,
  STUDY_IR_SCHEMA_VERSION
} from "./compile.ts";
export type {
  IrBlinding,
  IrConstants,
  IrEvaluation,
  IrFactor,
  IrFactorLevel,
  IrMetrics,
  StudyCompileOptions,
  StudyCompileResult,
  StudyIR
} from "./compile.ts";

export {
  createProtocolLock,
  PROTOCOL_LOCK_SCHEMA_VERSION,
  PROTOCOL_MEMBER_PATH,
  protocolLockFromJson,
  protocolLockJson,
  protocolLockSha256,
  referencedVariants,
  serializeProtocolLock,
  verifyProtocolLock
} from "./lock.ts";
export type {
  EffectiveContractDigest,
  LockDrift,
  LockDriftKind,
  LockMember,
  ProtocolLock,
  ProtocolLockOptions,
  ProtocolLockResult,
  ProtocolLockVerifyInput,
  ProtocolLockVerifyResult
} from "./lock.ts";
