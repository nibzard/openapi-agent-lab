/**
 * Stable diagnostic codes produced by the pack loader, the PackIR builder, and
 * the invariant checks. Codes are stable API; wording is not.
 */
export const PackCode = {
  ManifestMissing: "OAL-PACK-MANIFEST-MISSING",
  ManifestAmbiguous: "OAL-PACK-MANIFEST-AMBIGUOUS",
  PathUnsafe: "OAL-PACK-PATH-UNSAFE",
  AssetMissing: "OAL-PACK-ASSET-MISSING",
  AssetNotFile: "OAL-PACK-ASSET-NOT-FILE",
  AssetTooLarge: "OAL-PACK-ASSET-TOO-LARGE",
  DuplicateId: "OAL-PACK-DUPLICATE-ID",
  PromptSetUnknown: "OAL-PACK-PROMPT-SET-UNKNOWN",
  ScenarioUnknown: "OAL-PACK-SCENARIO-UNKNOWN",
  OperationUnknown: "OAL-PACK-OPERATION-UNKNOWN",
  FixtureSelectorUnknown: "OAL-PACK-FIXTURE-SELECTOR-UNKNOWN",
  FixtureDefaultDuplicate: "OAL-PACK-FIXTURE-DEFAULT-DUPLICATE",
  ScopeEmpty: "OAL-PACK-SCOPE-EMPTY",
  TargetDuplicate: "OAL-PACK-TARGET-DUPLICATE",
  ContractInvalid: "OAL-PACK-CONTRACT-INVALID",
  ContractNotCompiled: "OAL-PACK-CONTRACT-NOT-COMPILED",
  BehaviorNotBundled: "OAL-PACK-BEHAVIOR-NOT-BUNDLED",
  SchemaDraft: "OAL-PACK-SCHEMA-DRAFT",
  RegistryPackMismatch: "OAL-PACK-REGISTRY-PACK-MISMATCH",
  RegistryDigestMismatch: "OAL-PACK-REGISTRY-DIGEST-MISMATCH",
  CompletenessConflict: "OAL-PACK-COMPLETENESS-CONFLICT",
  IsolationAdvisory: "OAL-PACK-ISOLATION-ADVISORY",
  DigestUnstable: "OAL-PACK-DIGEST-UNSTABLE",
  TargetNotEmpty: "OAL-PACK-TARGET-NOT-EMPTY",
  OpenApiMissing: "OAL-PACK-OPENAPI-MISSING",
  IdUnsafe: "OAL-PACK-ID-UNSAFE"
} as const;
