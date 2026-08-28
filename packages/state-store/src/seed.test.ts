import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { canonicalJson, canonicalJsonSha256, isSha256Hex } from "@oal/core";

import {
  deriveManualRunSeed,
  deriveNamespaceSeed,
  deriveRequestSeed,
  deriveRunSeed,
  deriveTrialSeed,
  runSeedDocument,
  runSeedId
} from "./seed.ts";
import type { AssignmentKind, RunSeedInput } from "./seed.ts";

/** Reference digests reused by the derivation vectors below. */
const D = {
  contractExecution: sha("contract-exec"),
  participantSurface: sha("participant-surface"),
  pack: sha("pack"),
  scenario: sha("scenario"),
  behavior: sha("behavior"),
  eval: sha("eval"),
  case: sha("case"),
  backend: sha("backend")
};

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Section 17.5 example inputs with every optional digest present. */
const fullInput = {
  contractExecutionSha256: D.contractExecution,
  participantSurfaceTemplateSha256: D.participantSurface,
  packSha256: D.pack,
  scenario: { id: "baseline", sha256: D.scenario },
  behaviorSha256: D.behavior,
  eval: { id: "checkpoint-recovery", sha256: D.eval },
  case: { id: "default", sha256: D.case },
  cohortSeed: "steel-baseline-2026-08-27",
  assignment: { kind: "ordinary_repetition", index: 0 } as {
    kind: AssignmentKind;
    index: number;
  }
};

describe("run-seed derivation", () => {
  it("hashes the canonical section 17.5 document", () => {
    const document = runSeedDocument(fullInput);
    expect(canonicalJson(document)).toBe(
      canonicalJson({
        schema_version: 1,
        contract_execution_sha256: D.contractExecution,
        participant_surface_template_sha256: D.participantSurface,
        pack_sha256: D.pack,
        scenario: { id: "baseline", sha256: D.scenario },
        behavior_sha256: D.behavior,
        eval: { id: "checkpoint-recovery", sha256: D.eval },
        case: { id: "default", sha256: D.case },
        cohort_seed: "steel-baseline-2026-08-27",
        assignment: { kind: "ordinary_repetition", index: 0 }
      })
    );
    expect(Object.keys(document).sort()).toEqual([
      "assignment",
      "behavior_sha256",
      "case",
      "cohort_seed",
      "contract_execution_sha256",
      "eval",
      "pack_sha256",
      "participant_surface_template_sha256",
      "scenario",
      "schema_version"
    ]);
  });

  it("matches the frozen reference vector", () => {
    // sha256 of the canonical document above, computed independently.
    expect(deriveRunSeed(fullInput)).toBe(
      "e864b39062a1c3fe6d94ec6df87181261e5fa12eb2c4542fe5139286eebdc432"
    );
    expect(isSha256Hex(deriveRunSeed(fullInput))).toBe(true);
  });

  it("is deterministic across calls and object key order", () => {
    const first = deriveRunSeed(fullInput);
    const reordered = deriveRunSeed({
      assignment: fullInput.assignment,
      cohortSeed: fullInput.cohortSeed,
      eval: fullInput.eval,
      case: fullInput.case,
      behaviorSha256: fullInput.behaviorSha256,
      scenario: fullInput.scenario,
      packSha256: fullInput.packSha256,
      participantSurfaceTemplateSha256:
        fullInput.participantSurfaceTemplateSha256,
      contractExecutionSha256: fullInput.contractExecutionSha256
    });
    expect(reordered).toBe(first);
  });

  it("domain-separates assignment kinds and indices", () => {
    const ordinary0 = deriveRunSeed(fullInput);
    const ordinary1 = deriveRunSeed({
      ...fullInput,
      assignment: { kind: "ordinary_repetition", index: 1 }
    });
    const primary0 = deriveRunSeed({
      ...fullInput,
      assignment: { kind: "primary", index: 0 }
    });
    const held0 = deriveRunSeed({
      ...fullInput,
      assignment: { kind: "held_replacement", index: 0 }
    });
    expect(ordinary0).not.toBe(ordinary1);
    expect(primary0).not.toBe(ordinary0);
    expect(primary0).not.toBe(held0);
    expect(primary0).toBe(
      "3ef51abaccbb7ad8bfd458e734fe4ecec0680ab2f75ba4871de08e0c264a1eee"
    );
    expect(held0).toBe(
      "6ad3f4bb232e99febaf9cd3c344657462822ccaf3339b99895b98cb64976b29a"
    );
    expect(ordinary1).toBe(
      "c750950f7f70648bef4671cae222e39a8d49e70861342280ec6d353af7794332"
    );
  });

  it("omits absent optional digests instead of guessing", () => {
    const document = runSeedDocument({
      contractExecutionSha256: D.contractExecution,
      participantSurfaceTemplateSha256: D.participantSurface,
      packSha256: null,
      scenario: null,
      behaviorSha256: D.behavior,
      eval: null,
      case: null,
      cohortSeed: "cohort",
      assignment: { kind: "primary", index: 3 }
    });
    expect(canonicalJson(document)).toBe(
      canonicalJson({
        schema_version: 1,
        contract_execution_sha256: D.contractExecution,
        participant_surface_template_sha256: D.participantSurface,
        behavior_sha256: D.behavior,
        cohort_seed: "cohort",
        assignment: { kind: "primary", index: 3 },
        pack_sha256: null,
        scenario: null,
        eval: null,
        case: null
      })
    );
  });

  it("rejects malformed inputs", () => {
    expect(() =>
      deriveRunSeed({ ...fullInput, behaviorSha256: "not-a-digest" })
    ).toThrowError(/SHA-256/);
    const unknownKind: RunSeedInput = {
      ...fullInput,
      assignment: { kind: "unknown" as AssignmentKind, index: 0 }
    };
    expect(() => deriveRunSeed(unknownKind)).toThrowError(/Assignment kind/);
    expect(() =>
      deriveRunSeed({
        ...fullInput,
        assignment: { kind: "primary", index: -1 }
      })
    ).toThrowError(/nonnegative/);
  });
});

describe("manual serve seed", () => {
  it("hashes the separate manual tuple", () => {
    expect(
      deriveManualRunSeed({
        runId: "codex-baseline-01-run-01",
        contractExecutionSha256: D.contractExecution,
        packSha256: D.pack,
        scenarioSha256: D.scenario,
        backendSha256: D.backend
      })
    ).toBe("b2f31163ce1cff040e02bba5e3ec52a8f008230608f90855be36e5d51212326a");
    expect(
      deriveManualRunSeed({
        runId: "codex-baseline-01-run-01",
        contractExecutionSha256: D.contractExecution,
        packSha256: null,
        scenarioSha256: null,
        backendSha256: D.backend
      })
    ).not.toBe(
      "b2f31163ce1cff040e02bba5e3ec52a8f008230608f90855be36e5d51212326a"
    );
  });

  it("is the single canonical manual tuple of section 17.5", () => {
    // The document is spelled out independently, so any other
    // implementation (the `oal serve` default) must hash exactly this
    // object; a joined-string derivation cannot match it.
    expect(
      deriveManualRunSeed({
        runId: "manual-20231114-221320",
        contractExecutionSha256: D.contractExecution,
        packSha256: D.pack,
        scenarioSha256: D.scenario,
        backendSha256: D.backend
      })
    ).toBe(
      canonicalJsonSha256({
        schema_version: 1,
        kind: "manual_serve",
        run_id: "manual-20231114-221320",
        contract_execution_sha256: D.contractExecution,
        pack_sha256: D.pack,
        scenario_sha256: D.scenario,
        backend_sha256: D.backend
      })
    );
  });

  it("domain-separates every tuple field", () => {
    const base = {
      runId: "manual-run",
      contractExecutionSha256: D.contractExecution,
      packSha256: D.pack,
      scenarioSha256: D.scenario,
      backendSha256: D.backend
    };
    const reference = deriveManualRunSeed(base);
    expect(deriveManualRunSeed({ ...base, runId: "manual-run-2" })).not.toBe(
      reference
    );
    expect(
      deriveManualRunSeed({
        ...base,
        contractExecutionSha256: D.behavior
      })
    ).not.toBe(reference);
    expect(deriveManualRunSeed({ ...base, packSha256: null })).not.toBe(
      reference
    );
    expect(deriveManualRunSeed({ ...base, scenarioSha256: null })).not.toBe(
      reference
    );
    expect(
      deriveManualRunSeed({ ...base, backendSha256: D.scenario })
    ).not.toBe(reference);
    expect(deriveManualRunSeed(base)).toBe(reference);
  });
});

describe("derived seed chains", () => {
  const runSeed = deriveRunSeed(fullInput);

  it("derives trial seeds that diverge per trial", () => {
    const trial0 = deriveTrialSeed(runSeed, { index: 0 });
    const trial1 = deriveTrialSeed(runSeed, { index: 1 });
    expect(trial0).toBe(
      "b478751c6eded8fdadea9cd0a3136d5f5720405ec6a52adc4fae42196812857a"
    );
    expect(trial1).toBe(
      "c1003b627ddecaf4a062e0f3060e97043a5d39f282f5378592c6b9d7372fd961"
    );
    expect(deriveTrialSeed(runSeed, { index: 0, id: "trial-a" })).not.toBe(
      trial0
    );
    expect(() => deriveTrialSeed(runSeed, { index: -2 })).toThrowError(
      /nonnegative/
    );
  });

  it("derives independent PRNG namespace seeds", () => {
    expect(deriveNamespaceSeed(runSeed, "ids")).toBe(
      "5de8c5313a718345c16b78d8831df2ec371a3c9704cfbfd6188b57e0dd140985"
    );
    expect(deriveNamespaceSeed(runSeed, "uuids")).toBe(
      "b4f77b30beb1b57aaf1bedcc56143fc6c35f1aebfb8aed85b00ae22ea8d2c0d4"
    );
    expect(() => deriveNamespaceSeed(runSeed, "")).toThrowError(/namespace/);
    expect(() => deriveNamespaceSeed("short", "ids")).toThrowError(/SHA-256/);
  });

  it("derives per-request seeds from the governing seed", () => {
    const trialSeed = deriveTrialSeed(runSeed, { index: 0 });
    expect(deriveRequestSeed(trialSeed, 1)).toBe(
      "786502ddc90a78aa449a5d52d3f27df395962eea26e9ddd9456bcd4e713ddb81"
    );
    expect(deriveRequestSeed(trialSeed, 1)).not.toBe(
      deriveRequestSeed(trialSeed, 2)
    );
    expect(() => deriveRequestSeed(trialSeed, 0)).toThrowError(/positive/);
  });

  it("shortens a run seed into a run identifier", () => {
    expect(runSeedId(runSeed)).toBe(`run_${runSeed.slice(0, 24)}`);
  });
});
