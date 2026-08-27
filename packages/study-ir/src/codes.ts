/**
 * Stable diagnostic codes produced by the study loader, the compiler, and
 * the lock. Codes are stable API; wording is not.
 */
export const StudyCode = {
  SchemaInvalid: "OAL-STUDY-SCHEMA-INVALID",
  StructureInvalid: "OAL-STUDY-STRUCTURE-INVALID",
  DuplicateId: "OAL-STUDY-DUPLICATE-ID",
  PatchFieldUnknown: "OAL-STUDY-PATCH-FIELD-UNKNOWN",
  PatchValueInvalid: "OAL-STUDY-PATCH-VALUE-INVALID",
  PatchKeyConflict: "OAL-STUDY-PATCH-KEY-CONFLICT",
  PatchFieldBoundTwice: "OAL-STUDY-PATCH-FIELD-BOUND-TWICE",
  OperationUnknown: "OAL-STUDY-OPERATION-UNKNOWN",
  ContractVariantUnknown: "OAL-STUDY-CONTRACT-VARIANT-UNKNOWN",
  CellFactorUnknown: "OAL-STUDY-CELL-FACTOR-UNKNOWN",
  CellLevelUnknown: "OAL-STUDY-CELL-LEVEL-UNKNOWN",
  CellDuplicate: "OAL-STUDY-CELL-DUPLICATE",
  CellIdUnsafe: "OAL-STUDY-CELL-ID-UNSAFE",
  CellAbsentUnexplained: "OAL-STUDY-CELL-ABSENT-UNEXPLAINED",
  CellInventoryIncomplete: "OAL-STUDY-CELL-INVENTORY-INCOMPLETE",
  PhasePathUnsafe: "OAL-STUDY-PHASE-PATH-UNSAFE",
  PhasePlanMissing: "OAL-STUDY-PHASE-PLAN-MISSING",
  PhasePlanIdMismatch: "OAL-STUDY-PHASE-PLAN-ID-MISMATCH",
  PhasePlanOrphan: "OAL-STUDY-PHASE-PLAN-ORPHAN",
  PhaseCellsDropped: "OAL-STUDY-PHASE-CELLS-DROPPED",
  MetricUnknown: "OAL-STUDY-METRIC-UNKNOWN",
  MetricSourceUnknown: "OAL-STUDY-METRIC-SOURCE-UNKNOWN",
  ContrastFactorUnknown: "OAL-STUDY-CONTRAST-FACTOR-UNKNOWN",
  ContrastLevelUnknown: "OAL-STUDY-CONTRAST-LEVEL-UNKNOWN",
  ContrastNonvarying: "OAL-STUDY-CONTRAST-NONVARYING",
  ContrastUnknown: "OAL-STUDY-CONTRAST-UNKNOWN",
  StratumUnknown: "OAL-STUDY-STRATUM-UNKNOWN",
  MeasureIncompatible: "OAL-STUDY-MEASURE-INCOMPATIBLE",
  FactorUnknown: "OAL-STUDY-FACTOR-UNKNOWN",
  DesignUnbalanced: "OAL-STUDY-DESIGN-UNBALANCED",
  PaidCallsInconsistent: "OAL-STUDY-PAID-CALLS-INCONSISTENT",
  ConfirmatoryIncomplete: "OAL-STUDY-CONFIRMATORY-INCOMPLETE",
  MemberPathUnsafe: "OAL-STUDY-MEMBER-PATH-UNSAFE",
  MemberDuplicate: "OAL-STUDY-MEMBER-DUPLICATE",
  MemberMissing: "OAL-STUDY-MEMBER-MISSING",
  EffectiveContractMissing: "OAL-STUDY-EFFECTIVE-CONTRACT-MISSING",
  EffectiveContractUnused: "OAL-STUDY-EFFECTIVE-CONTRACT-UNUSED",
  LockDrift: "OAL-STUDY-LOCK-DRIFT",
  LockIdentityDrift: "OAL-STUDY-LOCK-IDENTITY-DRIFT"
} as const;

export type StudyDiagnosticCode = (typeof StudyCode)[keyof typeof StudyCode];
