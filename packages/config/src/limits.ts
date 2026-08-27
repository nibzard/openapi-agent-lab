/**
 * Resource limits: defaults and hard ceilings from specification
 * section 31.1. Every default is configurable downward; local unsafe
 * increases are explicit and frozen and never exceed the ceiling.
 */

export interface LimitTable {
  maxSourceOpenapiBytes: number;
  maxBundledDocumentBytes: number;
  maxParsedNodes: number;
  maxUniqueReferenceTargets: number;
  maxTraversalDepth: number;
  maxOperations: number;
  maxOneExampleBytes: number;
  maxRetainedExamplesBytes: number;
  maxPromptBytes: number;
  maxStudyProtocolBytes: number;
  maxStudyFactors: number;
  maxLevelsPerFactor: number;
  maxResolvedCells: number;
  maxContractVariantsPerStudy: number;
  maxFrozenAssignmentsPerStudyRun: number;
  maxParticipantSurfaceEntriesPerCell: number;
  maxDocumentationCandidatesPerProfile: number;
  maxRequestTargetBytes: number;
  maxRequestHeaderBytes: number;
  maxRequestBodyBytes: number;
  maxGeneratedResponseBodyBytes: number;
  maxMultipartParts: number;
  maxSseEventsPerResponse: number;
  maxSseDurationMs: number;
  maxConcurrentConnectionsPerRun: number;
  maxRequestsPerRun: number;
  maxBurstRequestsPerSecond: number;
  maxDomainObjects: number;
  maxPersistedStateBytes: number;
  maxEventLogBytes: number;
  maxArtifactsPerRunBytes: number;
  trialWallTimeMs: number;
  gracefulTerminationMs: number;
  maxBatchTrials: number;
  maxParallelTrials: number;
  maxExtensionMemoryBytes: number;
  maxExtensionCores: number;
  maxExtensionProcesses: number;
}

export const LIMIT_DEFAULTS: LimitTable = {
  maxSourceOpenapiBytes: 10 * 1024 * 1024,
  maxBundledDocumentBytes: 25 * 1024 * 1024,
  maxParsedNodes: 100_000,
  maxUniqueReferenceTargets: 2_000,
  maxTraversalDepth: 64,
  maxOperations: 5_000,
  maxOneExampleBytes: 1024 * 1024,
  maxRetainedExamplesBytes: 10 * 1024 * 1024,
  maxPromptBytes: 2 * 1024 * 1024,
  maxStudyProtocolBytes: 2 * 1024 * 1024,
  maxStudyFactors: 16,
  maxLevelsPerFactor: 32,
  maxResolvedCells: 256,
  maxContractVariantsPerStudy: 32,
  maxFrozenAssignmentsPerStudyRun: 1_000,
  maxParticipantSurfaceEntriesPerCell: 10_000,
  maxDocumentationCandidatesPerProfile: 16,
  maxRequestTargetBytes: 16 * 1024,
  maxRequestHeaderBytes: 32 * 1024,
  maxRequestBodyBytes: 5 * 1024 * 1024,
  maxGeneratedResponseBodyBytes: 10 * 1024 * 1024,
  maxMultipartParts: 100,
  maxSseEventsPerResponse: 100,
  maxSseDurationMs: 30_000,
  maxConcurrentConnectionsPerRun: 32,
  maxRequestsPerRun: 10_000,
  maxBurstRequestsPerSecond: 100,
  maxDomainObjects: 10_000,
  maxPersistedStateBytes: 100 * 1024 * 1024,
  maxEventLogBytes: 100 * 1024 * 1024,
  maxArtifactsPerRunBytes: 1024 * 1024 * 1024,
  trialWallTimeMs: 30 * 60_000,
  gracefulTerminationMs: 5_000,
  maxBatchTrials: 1,
  maxParallelTrials: 1,
  maxExtensionMemoryBytes: 512 * 1024 * 1024,
  maxExtensionCores: 1,
  maxExtensionProcesses: 64
};

export const LIMIT_CEILINGS: LimitTable = {
  maxSourceOpenapiBytes: 25 * 1024 * 1024,
  maxBundledDocumentBytes: 50 * 1024 * 1024,
  maxParsedNodes: 250_000,
  maxUniqueReferenceTargets: 5_000,
  maxTraversalDepth: 128,
  maxOperations: 10_000,
  maxOneExampleBytes: 5 * 1024 * 1024,
  maxRetainedExamplesBytes: 25 * 1024 * 1024,
  maxPromptBytes: 5 * 1024 * 1024,
  maxStudyProtocolBytes: 5 * 1024 * 1024,
  maxStudyFactors: 64,
  maxLevelsPerFactor: 128,
  maxResolvedCells: 1_000,
  maxContractVariantsPerStudy: 128,
  maxFrozenAssignmentsPerStudyRun: 10_000,
  maxParticipantSurfaceEntriesPerCell: 50_000,
  maxDocumentationCandidatesPerProfile: 64,
  maxRequestTargetBytes: 32 * 1024,
  maxRequestHeaderBytes: 64 * 1024,
  maxRequestBodyBytes: 25 * 1024 * 1024,
  maxGeneratedResponseBodyBytes: 25 * 1024 * 1024,
  maxMultipartParts: 1_000,
  maxSseEventsPerResponse: 1_000,
  maxSseDurationMs: 5 * 60_000,
  maxConcurrentConnectionsPerRun: 128,
  maxRequestsPerRun: 100_000,
  maxBurstRequestsPerSecond: 1_000,
  maxDomainObjects: 100_000,
  maxPersistedStateBytes: 500 * 1024 * 1024,
  maxEventLogBytes: 500 * 1024 * 1024,
  maxArtifactsPerRunBytes: 5 * 1024 * 1024 * 1024,
  trialWallTimeMs: 60 * 60_000,
  gracefulTerminationMs: 10_000,
  maxBatchTrials: 100,
  maxParallelTrials: 10,
  maxExtensionMemoryBytes: 1024 * 1024 * 1024,
  maxExtensionCores: 2,
  maxExtensionProcesses: 128
};

/** Apply operator overrides, refusing any value above the hard ceiling. */
export function resolveLimits(
  overrides: Partial<Record<keyof LimitTable, number>>
): LimitTable {
  const resolved: LimitTable = { ...LIMIT_DEFAULTS };
  for (const key of Object.keys(overrides) as Array<keyof LimitTable>) {
    const value = overrides[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Limit ${key} must be a positive finite number.`);
    }
    const ceiling = LIMIT_CEILINGS[key];
    if (value > ceiling) {
      throw new Error(
        `Limit ${key} value ${value} exceeds the hard ceiling ${ceiling}.`
      );
    }
    resolved[key] = value;
  }
  return resolved;
}
