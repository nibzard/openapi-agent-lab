/**
 * Stable diagnostic codes produced by the scheduler. Codes are stable API;
 * wording is not.
 */
export const SchedulerCode = {
  SeedInvalid: "OAL-SCHEDULE-SEED-INVALID",
  OrderingUnsupported: "OAL-SCHEDULE-ORDERING-UNSUPPORTED",
  DesignUnbalanced: "OAL-SCHEDULE-DESIGN-UNBALANCED",
  BlockStructureInvalid: "OAL-SCHEDULE-BLOCK-STRUCTURE-INVALID",
  CellInventoryInvalid: "OAL-SCHEDULE-CELL-INVENTORY-INVALID",
  CellDigestMissing: "OAL-SCHEDULE-CELL-DIGEST-MISSING",
  ContractVariantAmbiguous: "OAL-SCHEDULE-CONTRACT-VARIANT-AMBIGUOUS",
  ContractVariantUnknown: "OAL-SCHEDULE-CONTRACT-VARIANT-UNKNOWN",
  ReplacementCapacityInvalid: "OAL-SCHEDULE-REPLACEMENT-CAPACITY-INVALID",
  PaidCeilingExceeded: "OAL-SCHEDULE-PAID-CEILING-EXCEEDED",
  ControlIdInvalid: "OAL-SCHEDULE-CONTROL-ID-INVALID",
  ControlIdCollision: "OAL-SCHEDULE-CONTROL-ID-COLLISION",
  EventAppendInvalid: "OAL-SCHEDULE-EVENT-APPEND-INVALID",
  EventTransitionInvalid: "OAL-SCHEDULE-EVENT-TRANSITION-INVALID",
  ActivationTargetInvalid: "OAL-SCHEDULE-ACTIVATION-TARGET-INVALID",
  ActivationNotEligible: "OAL-SCHEDULE-ACTIVATION-NOT-ELIGIBLE",
  ActivationCapacityExhausted: "OAL-SCHEDULE-ACTIVATION-CAPACITY-EXHAUSTED",
  ActivationTimingForbidden: "OAL-SCHEDULE-ACTIVATION-TIMING-FORBIDDEN",
  HeaderInvalid: "OAL-SCHEDULE-HEADER-INVALID",
  StudyRunMismatch: "OAL-SCHEDULE-STUDY-RUN-MISMATCH"
} as const;

export type SchedulerDiagnosticCode =
  (typeof SchedulerCode)[keyof typeof SchedulerCode];
