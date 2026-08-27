/**
 * Public surface of `@oal/contract-variant`: declarative counterfactual
 * ContractVariant sets, their allowlisted transformations, and the
 * verification of every materialized effective contract.
 */

export const packageName = "@oal/contract-variant";

export {
  allowlistCovers,
  allowlistsOverlap,
  applyJsonPatch,
  checkPatchAllowlist,
  classifyPointerLayer,
  escapeToken as escapePointerToken,
  formatJsonPointer,
  JSON_POINTER_PATTERN,
  parseJsonPointer,
  PatchCode,
  pointerWithin,
  type DifferenceLayer,
  type JsonPatchOperation,
  type JsonPatchOperationKind,
  type JsonPatchResult,
  type PatchIssue
} from "./patch.ts";

export {
  checkContractVariantSetSemantics,
  documentationFactsSha256,
  EMPTY_PACK_DOCUMENTATION,
  EXECUTABLE_MARKERS,
  loadContractVariantDiff,
  loadContractVariantManifest,
  loadContractVariantSet,
  packRegistrySnapshot,
  packSemanticEntriesFromEventRegistry,
  parseArtifactText,
  parsePackRegistryText,
  scanForExecutableContent,
  surfaceEntryMatches,
  SURFACE_ID_PATTERN,
  SURFACE_KINDS,
  VariantCode,
  VariantSchemaSet,
  type BehaviorAdapterSelection,
  type CommonProjection,
  type ContractVariant,
  type ContractVariantDiff,
  type ContractVariantManifest,
  type ContractVariantSet,
  type DiffDifference,
  type DiffOperationInventory,
  type DiffViolation,
  type DocumentationExampleRef,
  type DocumentationSelection,
  type LoadResult,
  type ManifestEffective,
  type PackAdapterEntry,
  type PackDocumentationRegistry,
  type PackRegistrySnapshot,
  type PackSemanticEntry,
  type PatchTransform,
  type SemanticSchemaRef,
  type SemanticSelection,
  type StaticTransform,
  type SurfaceExpectations,
  type SurfaceKind,
  type VariantSchemaDocuments,
  type VariantSchemaName,
  type VariantSetBase,
  type VariantTransform
} from "./model.ts";

export {
  buildContractVariantDiff,
  diffJson,
  operationKeysOfDocument,
  type BuildDiffInput,
  type StructuralDifference
} from "./diff.ts";

export {
  DEFAULT_LEAK_LABELS,
  GenerateCode,
  materializeContractVariantSet,
  materializeVariant,
  participantSurfacesOf,
  scanForLeakedLabels,
  transformSha256,
  type LeakFinding,
  type MaterializeOptions,
  type MaterializeResult,
  type MaterializeSetResult,
  type MaterializeSuccess,
  type ParticipantSurface
} from "./generate.ts";
