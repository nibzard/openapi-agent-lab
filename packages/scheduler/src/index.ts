export const packageName = "@oal/scheduler";

export { SchedulerCode } from "./codes.ts";
export type { SchedulerDiagnosticCode } from "./codes.ts";

export {
  allocateControlIds,
  assignmentDomainObject,
  childBatchDomainObject,
  controlIdFromDigest,
  controlIdDocument,
  CONTROL_ID_MAX_HEX,
  CONTROL_ID_MIN_HEX,
  CONTROL_ID_PATTERN,
  CONTROL_ID_SCHEMA_VERSION,
  isControlId,
  requireFullDigest,
  resolveControlIdLengths,
  runDomainObject
} from "./ids.ts";
export type {
  AllocatedControlId,
  AssignmentControlDomain,
  ChildBatchControlDomain,
  ControlIdAllocation,
  ControlIdPrefix,
  ControlIdSeed
} from "./ids.ts";

export {
  assignmentScheduleJson,
  assignmentScheduleSha256,
  ASSIGNMENT_SCHEDULE_KIND,
  ASSIGNMENT_SCHEDULE_SCHEMA_VERSION,
  blocksAreComplete,
  buildAssignmentSchedule,
  describeSchedule,
  factorLevelDigests,
  factorLevelDocument,
  heldSlotsPerCell,
  heldSortKey,
  heldSortKeyDocument,
  MAX_SCHEDULE_SEED_LENGTH,
  primaryBlockCount,
  primarySortKey,
  primarySortKeyDocument,
  SCHEDULE_SORT_ALGORITHM,
  scheduleCells,
  serializeAssignmentSchedule
} from "./schedule.ts";
export type {
  AssignmentKind,
  AssignmentRecord,
  AssignmentSchedule,
  AssignmentScheduleInput,
  AssignmentScheduleResult,
  AssignmentStatus,
  CellProtocolDigests,
  ScheduleSummary
} from "./schedule.ts";

export {
  assignmentRunBindings,
  assignmentRunSeed,
  heldReserveRunSeed,
  primaryRunSeed
} from "./seeds.ts";
export type {
  AssignmentRunBinding,
  CohortSeedBase,
  ScheduleAssignmentKind
} from "./seeds.ts";

export {
  activateHeldSlot,
  appendAssignmentEvent,
  assignmentEventId,
  assignmentEventJson,
  assignmentStates,
  ASSIGNMENT_EVENT_SCHEMA_VERSION,
  blockCompletion,
  createAssignmentLedger,
  heldUnusedAssignments,
  primaryScheduleSettled,
  replacementPolicyOf,
  serializeAssignmentEvent,
  serializeAssignmentLedger
} from "./events.ts";
export type {
  ActivationRequest,
  ActivationResult,
  AppendResult,
  AssignmentEvent,
  AssignmentEventDraft,
  AssignmentEventKind,
  AssignmentLedger,
  AssignmentState,
  BlockCompletion,
  EvidenceIntegrityValue,
  ReplacementPolicy,
  ScheduleView,
  ScheduledAssignmentView
} from "./events.ts";

export {
  buildStudyRunHeader,
  CHILD_BATCH_ROOT,
  serializeStudyRun,
  STUDY_RUN_SCHEMA_VERSION,
  studyRunJson,
  studyRunSha256
} from "./studyrun.ts";
export type {
  StudyRunCellInput,
  StudyRunChildBatch,
  StudyRunHeader,
  StudyRunHeaderInput,
  StudyRunHeaderResult,
  StudyRunPhaseKind
} from "./studyrun.ts";
