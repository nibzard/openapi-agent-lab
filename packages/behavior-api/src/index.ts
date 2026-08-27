export const packageName = "@oal/behavior-api";

export type {
  BackendDescription,
  BackendFactoryContext,
  BackendModule,
  BehaviorBackend,
  BehaviorRequest,
  BehaviorResult,
  BlobStore,
  Body,
  ContractOperation,
  DeterministicClock,
  DeterministicIds,
  DeterministicRandom,
  HandleContext,
  Json,
  InitializeContext,
  InitializeResult,
  MultipartPart
} from "./types.ts";
export { BehaviorHttpError } from "./error.ts";
export type { BehaviorHttpErrorInit } from "./error.ts";
export { BehaviorTimeoutError, DEFAULT_BEHAVIOR_TIMEOUT_MS } from "./error.ts";
export {
  executeBehaviorRequest,
  type ExecuteOptions,
  type ExecuteOutcome,
  type RegisteredEvent
} from "./execute.ts";
export {
  checkBehaviorCompleteness,
  diffBehaviorCompleteness,
  type CompletenessDiff,
  type OperationSupport
} from "./completeness.ts";
export {
  FaultCounters,
  matchFault,
  validateFaultRules,
  type FaultAction,
  type FaultEvaluation,
  type FaultMatch,
  type FaultMatchInput,
  type FaultPhase,
  type FaultPredicate,
  type FaultRule
} from "./faults.ts";
