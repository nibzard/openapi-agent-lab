export const packageName = "@oal/environment";

export {
  EnvironmentCode,
  EnvironmentError,
  ensureStateDirectory,
  openEnvironment,
  openRestoredEnvironment,
  readCheckpoint,
  RUNTIME_NAME,
  type CheckpointWritten,
  type CommittedSemanticEvent,
  type Environment,
  type EnvironmentCapabilities,
  type EnvironmentContractInputs,
  type EnvironmentLimits,
  type EnvironmentManifest,
  type EnvironmentOptions,
  type EnvironmentRecords,
  type RestoreEnvironmentOptions
} from "./environment.ts";

export {
  idempotencyPoliciesOf,
  WorldIdempotency,
  type IdempotencyPolicyRecord
} from "./idempotency.ts";

export {
  CHECKPOINT_MANIFEST_NAME,
  readCheckpointDirectory,
  writeCheckpointDirectory,
  type CheckpointManifest,
  type ReadCheckpoint
} from "./checkpoint-dir.ts";

export {
  controlAddress,
  controlDiagnostic,
  controlEnvelope,
  CONTROL_CODES,
  CONTROL_QUEUE_LIMIT,
  runControl,
  startWorldControl,
  worldControlUnsupported,
  type ControlOutcome,
  type ControlRoute,
  type WorldControlHandlers,
  type WorldControlOptions,
  type WorldControlServer
} from "./control.ts";
