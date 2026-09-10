import { describe, expect, it } from "vitest";

import {
  LIMIT_CEILINGS,
  LIMIT_DEFAULTS,
  PROFILE_LIMIT_DEFAULTS,
  makeRunProfile,
  resolveLimits,
  type LimitTable
} from "./index.ts";

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** Specification section 31.1: resource, default, hard ceiling. */
const TABLE: Array<[keyof LimitTable, number, number]> = [
  ["maxSourceOpenapiBytes", 10 * MIB, 25 * MIB],
  ["maxBundledDocumentBytes", 25 * MIB, 50 * MIB],
  ["maxParsedNodes", 100_000, 250_000],
  ["maxUniqueReferenceTargets", 2_000, 5_000],
  ["maxTraversalDepth", 64, 128],
  ["maxOperations", 5_000, 10_000],
  ["maxOneExampleBytes", 1 * MIB, 5 * MIB],
  ["maxRetainedExamplesBytes", 10 * MIB, 25 * MIB],
  ["maxPromptBytes", 2 * MIB, 5 * MIB],
  ["maxStudyProtocolBytes", 2 * MIB, 5 * MIB],
  ["maxStudyFactors", 16, 64],
  ["maxLevelsPerFactor", 32, 128],
  ["maxResolvedCells", 256, 1_000],
  ["maxContractVariantsPerStudy", 32, 128],
  ["maxFrozenAssignmentsPerStudyRun", 1_000, 10_000],
  ["maxParticipantSurfaceEntriesPerCell", 10_000, 50_000],
  ["maxDocumentationCandidatesPerProfile", 16, 64],
  ["maxRequestTargetBytes", 16 * KIB, 32 * KIB],
  ["maxRequestHeaderBytes", 32 * KIB, 64 * KIB],
  ["maxRequestBodyBytes", 5 * MIB, 25 * MIB],
  ["maxGeneratedResponseBodyBytes", 10 * MIB, 25 * MIB],
  ["maxMultipartParts", 100, 1_000],
  ["maxSseEventsPerResponse", 100, 1_000],
  ["maxSseDurationMs", 30_000, 5 * 60_000],
  ["maxConcurrentConnectionsPerRun", 32, 128],
  ["maxRequestsPerRun", 10_000, 100_000],
  ["maxBurstRequestsPerSecond", 100, 1_000],
  ["maxDomainObjects", 10_000, 100_000],
  ["maxPersistedStateBytes", 100 * MIB, 500 * MIB],
  ["maxEventLogBytes", 100 * MIB, 500 * MIB],
  ["maxArtifactsPerRunBytes", 1 * GIB, 5 * GIB],
  ["trialWallTimeMs", 30 * 60_000, 60 * 60_000],
  ["gracefulTerminationMs", 5_000, 10_000],
  ["maxBatchTrials", 1, 100],
  ["maxParallelTrials", 1, 10],
  ["maxExtensionMemoryBytes", 512 * MIB, 1 * GIB],
  ["maxExtensionCores", 1, 2],
  ["maxExtensionProcesses", 64, 128],
  ["schemaWorkerDeadlineMs", 1_000, 30_000],
  ["schemaWorkerCount", 2, 8],
  ["schemaWorkerMaxPending", 128, 1_024],
  ["schemaWorkerMaxMessageBytes", 8 * MIB, 32 * MIB],
  ["schemaWorkerMemoryBytes", 256 * MIB, 1 * GIB]
];

const AGENT = {
  adapter: "codex-cli" as const,
  model: null,
  effort: null,
  sandbox: null
};

describe("section 31.1 limit table", () => {
  it("pins every default and every hard ceiling", () => {
    for (const [key, defaultValue, ceiling] of TABLE) {
      expect(LIMIT_DEFAULTS[key]).toBe(defaultValue);
      expect(LIMIT_CEILINGS[key]).toBe(ceiling);
    }
  });

  it("covers exactly the fields of the limit table", () => {
    const keys = new Set(TABLE.map(([key]) => key));
    expect(keys).toEqual(new Set(Object.keys(LIMIT_DEFAULTS)));
    expect(Object.keys(LIMIT_DEFAULTS).sort()).toEqual(
      Object.keys(LIMIT_CEILINGS).sort()
    );
  });

  it("keeps every default at or below its ceiling", () => {
    for (const [key] of TABLE) {
      expect(LIMIT_DEFAULTS[key]).toBeLessThanOrEqual(LIMIT_CEILINGS[key]);
    }
  });
});

describe("resolveLimits", () => {
  it("returns the defaults when no override is given", () => {
    expect(resolveLimits({})).toEqual(LIMIT_DEFAULTS);
  });

  it("applies a downward override and keeps the other defaults", () => {
    const resolved = resolveLimits({
      maxRequestsPerRun: 5,
      maxEventLogBytes: 2048
    });
    expect(resolved.maxRequestsPerRun).toBe(5);
    expect(resolved.maxEventLogBytes).toBe(2048);
    expect(resolved.maxMultipartParts).toBe(LIMIT_DEFAULTS.maxMultipartParts);
    expect(resolved.trialWallTimeMs).toBe(LIMIT_DEFAULTS.trialWallTimeMs);
  });

  it("accepts an override that equals its ceiling", () => {
    expect(resolveLimits({ maxParallelTrials: 10 }).maxParallelTrials).toBe(
      LIMIT_CEILINGS.maxParallelTrials
    );
  });

  it("refuses an override above its hard ceiling", () => {
    expect(() => resolveLimits({ maxRequestsPerRun: 100_001 })).toThrow(
      /maxRequestsPerRun.*exceeds the hard ceiling 100000/
    );
    expect(() => resolveLimits({ maxArtifactsPerRunBytes: 6 * GIB })).toThrow(
      /maxArtifactsPerRunBytes/
    );
  });

  it("refuses a non-positive or non-finite override", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLimits({ maxBatchTrials: value })).toThrow(
        /positive finite number/
      );
    }
  });
});

describe("profile limit ceilings", () => {
  it("pins the profile limit defaults", () => {
    expect(PROFILE_LIMIT_DEFAULTS).toEqual({
      max_agent_tool_calls: 500,
      max_api_requests: 10_000,
      max_artifact_bytes: 1_073_741_824
    });
  });

  it("keeps profile limits aligned with the section 31.1 table", () => {
    expect(PROFILE_LIMIT_DEFAULTS.max_api_requests).toBe(
      LIMIT_DEFAULTS.maxRequestsPerRun
    );
    expect(PROFILE_LIMIT_DEFAULTS.max_artifact_bytes).toBe(
      LIMIT_DEFAULTS.maxArtifactsPerRunBytes
    );
  });

  it("fills execution bounds and limits from defaults", () => {
    const profile = makeRunProfile({ id: "cell-a" }, AGENT);
    expect(profile.execution).toEqual({
      count: 1,
      parallel: 1,
      timeout_ms: LIMIT_DEFAULTS.trialWallTimeMs,
      cohort_seed: "",
      confirm_paid_calls: true
    });
    expect(profile.limits).toEqual(PROFILE_LIMIT_DEFAULTS);
  });

  it("accepts explicit downward execution and limit overrides", () => {
    const profile = makeRunProfile({ id: "cell-b" }, AGENT, {
      count: 2,
      max_api_requests: 100
    });
    expect(profile.execution.count).toBe(2);
    expect(profile.limits.max_api_requests).toBe(100);
    expect(profile.limits.max_agent_tool_calls).toBe(500);
  });
});
