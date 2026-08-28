import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { findRepoRoot, loadSteelPack } from "@oal/testkit";

import {
  PreflightCode,
  assertPreflightClean,
  batchTrialRunId,
  runPreflight
} from "./preflight.ts";

const SCHEMA_DIR = path.join(findRepoRoot(), "schemas");

async function newStore(): Promise<{
  store: ArtifactStore;
  clean: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-preflight-"));
  return {
    store: new ArtifactStore(path.join(dir, ".oal")),
    clean: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe("runPreflight", () => {
  it("freezes a clean plan for the steel pack", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-preflight-1",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(true);
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
      const plan = assertPreflightClean(result);
      expect(plan.batchId).toBe("b-preflight-1");
      expect(plan.count).toBe(1);
      expect(plan.parallel).toBe(1);
      expect(plan.trialRunIds.length).toBe(1);
      expect(plan.trialRunIds[0]).toBe(batchTrialRunId("b-preflight-1", 0));
      expect(plan.trialSeeds.length).toBe(1);
      expect(plan.contract.ir.operations.length).toBeGreaterThan(0);
      expect(plan.evaluation.evalDoc.id).toBe("basic-lifecycle");
      expect(plan.evaluation.resultSchema).not.toBe(null);
      expect(plan.promptPreview.files.length).toBeGreaterThan(0);
      expect(plan.paidCallPlan.trials).toBe(1);
      expect(plan.paidCallPlan.paid).toBe(false);
      expect(plan.adapter.probe.status).toBe("available");
      expect(plan.limits.maxRequestsPerRun).toBeGreaterThan(0);
    } finally {
      await clean();
    }
  });

  it("derives the same frozen plan twice for identical inputs", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const options = {
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-preflight-2",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        schemaDir: SCHEMA_DIR
      } as const;
      const first = assertPreflightClean(await runPreflight(options));
      const second = assertPreflightClean(await runPreflight(options));
      expect(second.runSeed).toBe(first.runSeed);
      expect(second.trialSeeds).toEqual(first.trialSeeds);
      expect(second.pack.packSha256).toBe(first.pack.packSha256);
      expect(second.surface.templateSha256).toBe(first.surface.templateSha256);
    } finally {
      await clean();
    }
  });

  it("refuses an existing batch identifier", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      await store.writeOnce("runs/b-exists/batch.json", "{}\n");
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-exists",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.BatchExists
      );
    } finally {
      await clean();
    }
  });

  it("refuses an unknown eval", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "does-not-exist",
        batchId: "b-unknown-eval",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.EvalUnknown
      );
      expect(result.plan).toBe(null);
    } finally {
      await clean();
    }
  });

  it("accepts discoverable visibility under the raw HTTP facade", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-discoverable",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        exposureMode: "raw-http",
        contractVisibility: "discoverable",
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(true);
      expect(result.plan?.contractVisibility).toBe("discoverable");
    } finally {
      await clean();
    }
  });

  it("refuses discoverable visibility when the exposure mode serves no facade", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-discoverable-tools",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        exposureMode: "catalog-tools",
        contractVisibility: "discoverable",
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.VisibilityUnsupported
      );
    } finally {
      await clean();
    }
  });

  it("refuses a paid run without a confirmation callback", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-paid",
        store,
        adapter: new MockAgentAdapter(),
        paid: true,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.ConfirmationRequired
      );
    } finally {
      await clean();
    }
  });

  it("refuses a paid run the operator rejects", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-paid-no",
        store,
        adapter: new MockAgentAdapter(),
        paid: true,
        confirmPaid: () => false,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.NotConfirmed
      );
    } finally {
      await clean();
    }
  });

  it("accepts a paid run once the operator confirms the plan", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      let seen = 0;
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-paid-yes",
        store,
        adapter: new MockAgentAdapter(),
        paid: true,
        confirmPaid: (plan) => {
          seen += 1;
          return plan.paid && plan.trials === 1;
        },
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(true);
      expect(seen).toBe(1);
    } finally {
      await clean();
    }
  });

  it("refuses a trial count above the batch ceiling", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-too-many",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        count: 100000,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.LimitExceeded
      );
    } finally {
      await clean();
    }
  });

  it("refuses a zero trial wall time before any launch", async () => {
    // A zero timeout would fire the launch guard immediately and abort
    // every trial, so preflight must reject it as a configuration defect.
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-zero-timeout",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        trialWallTimeMs: 0,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.plan).toBe(null);
      const finding = result.findings.find(
        (f) => f.code === PreflightCode.PlanInvalid
      );
      expect(finding?.details).toEqual({ trial_wall_time_ms: 0 });
    } finally {
      await clean();
    }
  });

  it("refuses a negative trial wall time", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-negative-timeout",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        trialWallTimeMs: -1000,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.PlanInvalid
      );
    } finally {
      await clean();
    }
  });

  it("accepts an explicit positive trial wall time", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-positive-timeout",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        trialWallTimeMs: 60_000,
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(true);
      expect(result.plan?.trialWallTimeMs).toBe(60_000);
    } finally {
      await clean();
    }
  });

  it("falls back to raw-http when the adapter serves no MCP", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-fallback",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        schemaDir: SCHEMA_DIR
      });
      const warnings = result.findings
        .filter((f) => f.severity === "warning")
        .map((f) => f.code);
      expect(warnings).toContain(PreflightCode.ExposureIncompatible);
      const plan = assertPreflightClean(result);
      expect(plan.profile.exposure.mode).toBe("raw-http");
    } finally {
      await clean();
    }
  });

  it("refuses an explicitly requested mode the adapter cannot serve", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      const result = await runPreflight({
        packDir: pack.root,
        evalId: "basic-lifecycle",
        batchId: "b-explicit-tools",
        store,
        adapter: new MockAgentAdapter(),
        paid: false,
        exposureMode: "direct-tools",
        schemaDir: SCHEMA_DIR
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        PreflightCode.ExposureIncompatible
      );
    } finally {
      await clean();
    }
  });

  it("refuses an unsafe batch identifier by throwing", async () => {
    const pack = await loadSteelPack();
    const { store, clean } = await newStore();
    try {
      await expect(
        runPreflight({
          packDir: pack.root,
          evalId: "basic-lifecycle",
          batchId: "../escape",
          store,
          adapter: new MockAgentAdapter(),
          paid: false,
          schemaDir: SCHEMA_DIR
        })
      ).rejects.toThrowError(/not safe/u);
    } finally {
      await clean();
    }
  });
});
