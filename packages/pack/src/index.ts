export const packageName = "@oal/pack";

export { PackCode } from "./codes.ts";
export {
  collectDeclaredReferences,
  loadPack,
  parsePackDocument,
  PACK_MANIFEST_NAMES,
  referenceDigest,
  SEMANTIC_REGISTRY_NAMES,
  type LoadedPack,
  type PackLoadOptions,
  type PackManifestName,
  type PackReference,
  type PackReferenceParse,
  type PackReferenceRole
} from "./manifest.ts";
export {
  buildPackIr,
  contractIndexFromContractIr,
  contractIndexFromDocument,
  packIrCanonicalText,
  resolveOperationScope,
  templateVariables,
  type ContractIndex,
  type OperationCoverage,
  type PackIrOptions,
  type PackIrResult,
  type PackLimits
} from "./packir.ts";
export { validatePackInvariants, type InvariantInput } from "./invariants.ts";
export {
  validatePack,
  type PackValidateOptions,
  type PackValidationResult
} from "./validate.ts";
export {
  PACK_DIRECTORIES,
  safePackId,
  scaffoldPack,
  type ScaffoldOptions,
  type ScaffoldResult
} from "./scaffold.ts";
export {
  defaultSchemaDir,
  PACK_SCHEMA_FILES,
  PackSchemaSet,
  type PackSchemaName
} from "./schemas.ts";
export {
  parsePackYaml,
  PackYamlError,
  type PackYamlErrorCode,
  type PackYamlOptions
} from "./yaml.ts";
