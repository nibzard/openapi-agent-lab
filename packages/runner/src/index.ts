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
