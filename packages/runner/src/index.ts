export const packageName = "@oal/runner";

export {
  BlindingCode,
  mustacheVariables,
  renderTemplate,
  resolveContext,
  untrustedBlock,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  TemplateError,
  TemplateCode,
  type BlindProblem,
  type ContractVisibilityValue,
  type ExposureModeValue,
  type RenderedTemplate,
  type RenderTemplateInput,
  type TemplateContext,
  type TemplateContextSpec,
  type TemplateEngine,
  type TemplateLeaf,
  type TemplateValue
} from "./template.ts";
export {
  materializePrompts,
  PromptCode,
  type MaterializedPrompts,
  type MaterializePromptsOptions,
  type PromptRole,
  type PurposeDisclosure,
  type RenderedPrompt,
  type WorkspaceFileOrigin,
  type WorkspaceFilePlan
} from "./prompts.ts";
export {
  DEFAULT_CONTRACT_FILENAME,
  materializeWorkspace,
  verifyWorkspaceFiles,
  WorkspaceCode,
  type MaterializedWorkspace,
  type MaterializeWorkspaceOptions
} from "./workspace.ts";
export {
  compileSurfaceManifest,
  CONTRACT_TRANSFORMATION,
  verifySurface,
  SurfaceCode,
  type CompileSurfaceOptions,
  type CompiledSurface,
  type ContractRouteDescriptor,
  type CredentialShapeDescriptor,
  type EnvironmentNameDescriptor,
  type MessageKindDescriptor,
  type ResponseCatalogDescriptor,
  type SurfaceChannel,
  type SurfaceProblem,
  type SurfaceProvenanceClass,
  type ToolDescriptor
} from "./surface.ts";
export {
  buildCueAudit,
  CueCode,
  cueIsolationAdvisory,
  parseSurfacePolicy,
  policyJson,
  PRIVATE_SURFACE_FRAGMENTS,
  privateArtifactProblems,
  surfaceEntriesOf,
  surfaceEntryJson,
  surfacePolicySha256,
  treatmentOwnedMatch,
  type CueAudit,
  type CueAuditDifference,
  type CueAuditFinding,
  type CueAuditInput,
  type CueAuditPairwise,
  type CueAuditScanned,
  type CuePrivacyProblem,
  type ForbiddenLiteralRule,
  type ParticipantSurfacePolicy,
  type RenderedSurfaceText,
  type SurfaceEntryView,
  type SurfacePolicyException,
  type SurfacePolicyNeutralProfiles,
  type SurfacePolicyPairwiseAllowlist,
  type SurfacePolicyRequiredReviews,
  type SurfacePolicyTreatmentOwned
} from "./cue.ts";
export {
  applyProvenancePolicy,
  checkParticipantSurfaces,
  classifySurfaceEntry,
  compareCellSurfaces,
  SurfaceCheckCode,
  SURFACE_CHECK_FAILURE_CODES,
  verifyPostRunSurface,
  type CellSurface,
  type PreservedCue,
  type ProvenanceOutcome,
  type ReviewEvidence,
  type SurfaceCheckOutcome,
  type SurfaceClassificationInput,
  type SurfaceDigestDrift,
  type SurfacePairDifference,
  type SurfacePairOutcome
} from "./surface-check.ts";
export {
  collectParticipantReport,
  ReportCode,
  type AdapterFinalSource,
  type CollectReportOptions,
  type ReportFailure,
  type ReportOutcome,
  type ReportProblem,
  type ReportSuccess,
  type ResultSource,
  type ResultSourceKind,
  type WorkspaceFileSource
} from "./participant-report.ts";
export {
  LifecycleCode,
  OPERATOR_SIGNAL_STAGE,
  ORDERED_STAGES,
  TrialLifecycle,
  controlStarted,
  evidenceFinalized,
  hasStage,
  stageRecordsOf,
  snapshotOfRecords,
  type Clock,
  type LifecycleSnapshot,
  type StageFact
} from "./lifecycle.ts";
export {
  CensorCode,
  DispositionCode,
  TERMINAL_DISPOSITIONS,
  classifyCensorClass,
  classifyDisposition,
  evidenceIntegrityOf,
  harnessAborted,
  retryLineage,
  type CensorClass,
  type CensorInput,
  type CensorOutcome,
  type DispositionInput,
  type DispositionOutcome,
  type EvidenceRequirement,
  type FailureFact,
  type OperatorSignalFact,
  type RequirementStatus,
  type RetryLineage
} from "./disposition.ts";
export {
  CONTRACT_VISIBILITIES,
  DATA_PLANE_SCOPES,
  EXPOSURE_MODES,
  PreflightCode,
  adapterKindOf,
  assertPreflightClean,
  batchTrialRunId,
  contractSettings,
  declaredBaseUrlEnvironment,
  declaredEnvironmentNames,
  packFreezeDigest,
  packReferenceOf,
  runPreflight,
  schemaVisibility,
  type ContractSettings,
  type ContractVisibility,
  type DataPlaneScope,
  type ExposureMode,
  type FrozenPlan,
  type PaidCallPlan,
  type PreflightOptions,
  type PreflightResult
} from "./preflight.ts";
export {
  SetupCode,
  TrialSetupError,
  credentialEnvironmentName,
  credentialEnvironmentNames,
  sanitizeParticipantContract,
  setupTrial,
  type ControlLayout,
  type ExposureFactory,
  type ExposureHandle,
  type ExposureRequest,
  type SetupTrialOptions,
  type TraceWriter,
  type TrialSetup
} from "./setup.ts";
export {
  DEFAULT_EXPOSURE_HOST,
  createLoopbackExposure,
  createRawHttpExposure,
  type RawHttpExposureOptions
} from "./exposure.ts";
export { packResponseFixtures } from "./types.ts";
export {
  API_REQUEST_EVENT_KIND,
  DEFAULT_TERMINAL_TURN_KIND,
  TrialCode,
  batchAssignmentId,
  runTrial,
  type TrialEvent,
  type TrialOutcome,
  type TrialRunOptions
} from "./trial.ts";
export {
  PRIMARY_REQUIREMENT_IDS,
  RunCode,
  buildCohortEvaluation,
  censorOf,
  createBatchSkeleton,
  runBatch,
  type BatchEvent,
  type BatchOutcome,
  type BatchRunOptions
} from "./run.ts";
