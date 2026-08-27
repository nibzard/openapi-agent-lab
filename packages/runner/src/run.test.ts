import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";
import { sha256Hex } from "@oal/core";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { findRepoRoot, loadSteelPack } from "@oal/testkit";
import type { LoadedPack } from "@oal/pack";

import {
  assertPreflightClean,
  runPreflight,
  type FrozenPlan
} from "./preflight.ts";
import {
  PRIMARY_REQUIREMENT_IDS,
  RunCode,
  createBatchSkeleton,
  runBatch,
  type BatchEvent
} from "./run.ts";
import type { ExposureFactory, ExposureHandle } from "./setup.ts";

const SCHEMA_DIR = path.join(findRepoRoot(), "schemas");
const CLOCK = (): number => 1_700_000_000_000;

const FINAL_TEXT = JSON.stringify({
  session_created: true,
  session_released: true,
  final_status: "released",
  notes: "mock participant report"
});

const FAKE_EXPOSURE: ExposureFactory = (request) => {
  const handle: ExposureHandle = {
    baseUrl: "http://127.0.0.1:9",
    credentialNames: [],
    documentationUrl: null,
    mcpUrl: null,
    serverRecord: { kind: "FakeExposure", run_id: request.runId },
    close: () => Promise.resolve()
  };
  return Promise.resolve(handle);
};

function batchAdapter(): MockAgentAdapter {
  return new MockAgentAdapter({
    model: "mock-model-1",
    events: [
      { channel: "adapter", kind: "http.request", text: "POST /v1/sessions" },
      { channel: "stdout", kind: "turn.completed", text: "done" }
    ],
    finalText: FINAL_TEXT,
    usage: { input_tokens: 10, output_tokens: 4, tool_calls: 1 }
  });
}

interface Fixture {
  plan: FrozenPlan;
  pack: LoadedPack;
  adapter: MockAgentAdapter;
  store: ArtifactStore;
  clean: () => Promise<void>;
}

async function fixture(
  label: string,
  batchId: string,
  count: number,
  parallel: number
): Promise<Fixture> {
  const packForTest = await loadSteelPack();
  const dir = await mkdtemp(path.join(tmpdir(), label));
  const store = new ArtifactStore(path.join(dir, ".oal"));
  const adapter = batchAdapter();
  const plan = assertPreflightClean(
    await runPreflight({
      packDir: packForTest.root,
      evalId: "basic-lifecycle",
      batchId,
      store,
      adapter,
      paid: false,
      count,
      parallel,
      limitOverrides: { maxBatchTrials: 100, maxParallelTrials: 10 },
      schemaDir: SCHEMA_DIR
    })
  );
  return {
    plan,
    pack: packForTest.loaded,
    adapter,
    store,
    clean: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe("runBatch", () => {
  it("runs a serial batch of three trials to completion", async () => {
    const { plan, pack, adapter, store, clean } = await fixture(
      "oal-run-1-",
      "b-batch-1",
      3,
      1
    );
    try {
      const events: BatchEvent[] = [];
      const outcome = await runBatch({
        store,
        plan,
        pack,
        adapter,
        now: CLOCK,
        exposure: FAKE_EXPOSURE,
        onEvent: (event) => events.push(event)
      });

      expect(outcome.batchId).toBe("b-batch-1");
      expect(outcome.outcomes.length).toBe(3);
      expect(outcome.notStartedRunIds).toEqual([]);
      expect(outcome.defectCode).toBe(null);
      for (const trial of outcome.outcomes) {
        expect(trial.disposition).toBe("completed");
        expect(trial.censorClass).toBe("none");
      }
      expect(outcome.cohort).not.toBe(null);
      const cohort = outcome.cohort as Record<string, unknown>;
      const denominators = cohort.denominators as Record<string, number>;
      expect(denominators.primary_assignment_count).toBe(3);
      expect(denominators.launched_trial_count).toBe(3);
      expect(denominators.participant_control_started_count).toBe(3);
      expect(cohort.dispositions).toEqual({ completed: 3 });

      // Batch layout of section 24.1.
      const base = "runs/b-batch-1";
      expect(await store.exists(`${base}/batch.json`)).toBe(true);
      expect(await store.exists(`${base}/assignment-events.jsonl`)).toBe(true);
      expect(await store.exists(`${base}/cohort-evaluation.json`)).toBe(true);
      expect(await store.exists(`${base}/artifact-manifest.json`)).toBe(true);
      expect(await store.exists(`${base}/batch.completed.json`)).toBe(true);
      for (const input of [
        "pack.frozen.yaml",
        "contract.original",
        "contract.ir.json",
        "capability-report.json",
        "run-profile.frozen.yaml",
        "rubric.frozen.yaml",
        "result-schema.frozen.json",
        "participant-surface-template.json",
        "instructions.frozen.md",
        "task.frozen.md",
        "prompt.frozen.txt",
        "evidence-requirements.json"
      ]) {
        expect(await store.exists(`${base}/inputs/${input}`)).toBe(true);
      }

      // The assignment ledger holds one launch and one terminal per trial.
      const ledgerText = await store.read(`${base}/assignment-events.jsonl`);
      const records = ledgerText
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.length).toBe(6);
      expect(records.filter((r) => r.kind === "launched").length).toBe(3);
      expect(records.filter((r) => r.kind === "terminal").length).toBe(3);
      expect(records.every((r) => r.study_run_id === "b-batch-1")).toBe(true);

      // The completion pointer pins the batch manifest.
      const completed = JSON.parse(
        await store.read(`${base}/batch.completed.json`)
      ) as Record<string, unknown>;
      const manifestText = await store.read(`${base}/artifact-manifest.json`);
      expect(completed.manifest_sha256).toBe(sha256Hex(manifestText));
      expect(completed.launched_trials).toBe(3);

      // Operator-visible progress stayed in order.
      expect(events[0]?.type).toBe("batch.started");
      expect(events[events.length - 1]?.type).toBe("batch.finished");
      expect(events.filter((e) => e.type === "trial.finished").length).toBe(3);
    } finally {
      await clean();
    }
  });

  it("runs a parallel batch without cross-trial interference", async () => {
    const { plan, pack, adapter, store, clean } = await fixture(
      "oal-run-2-",
      "b-batch-2",
      4,
      2
    );
    try {
      const outcome = await runBatch({
        store,
        plan,
        pack,
        adapter,
        now: CLOCK,
        exposure: FAKE_EXPOSURE
      });
      expect(outcome.outcomes.length).toBe(4);
      expect(outcome.outcomes.map((trial) => trial.runId)).toEqual([
        ...plan.trialRunIds
      ]);
      for (const trial of outcome.outcomes) {
        const relative = `runs/b-batch-2/trials/${trial.runId}`;
        expect(await store.exists(`${relative}/run.completed.json`)).toBe(true);
      }
    } finally {
      await clean();
    }
  });

  it("freezes byte-identical batch inputs for identical plans", async () => {
    const first = await fixture("oal-run-3-", "b-det", 1, 1);
    const second = await fixture("oal-run-4-", "b-det", 1, 1);
    try {
      await createBatchSkeleton(first.store, first.plan, first.pack, CLOCK);
      await createBatchSkeleton(second.store, second.plan, second.pack, CLOCK);
      const relative = "runs/b-det";
      expect(await first.store.read(`${relative}/batch.json`)).toBe(
        await second.store.read(`${relative}/batch.json`)
      );
      for (const input of [
        "contract.ir.json",
        "capability-report.json",
        "participant-surface-template.json",
        "evidence-requirements.json"
      ]) {
        expect(await first.store.read(`${relative}/inputs/${input}`)).toBe(
          await second.store.read(`${relative}/inputs/${input}`)
        );
      }
    } finally {
      await first.clean();
      await second.clean();
    }
  });

  it("refuses to freeze a batch identifier twice", async () => {
    const { plan, pack, store, clean } = await fixture(
      "oal-run-5-",
      "b-exists",
      1,
      1
    );
    try {
      await createBatchSkeleton(store, plan, pack, CLOCK);
      await expect(
        createBatchSkeleton(store, plan, pack, CLOCK)
      ).rejects.toThrowError(/already exists/u);
    } finally {
      await clean();
    }
  });

  it("records a batch defect and finalizes the batch anyway", async () => {
    const { plan, pack, adapter, store, clean } = await fixture(
      "oal-run-6-",
      "b-defect",
      2,
      1
    );
    try {
      // A run tree that already holds a start record makes setup throw a
      // plain error, which the batch reads as a defect, not a trial outcome.
      const firstRun = plan.trialRunIds[0];
      if (firstRun === undefined) {
        throw new Error("frozen batch holds no run id");
      }
      await store.writeOnce(
        `runs/b-defect/trials/${firstRun}/run.started.json`,
        "{}\n"
      );
      const outcome = await runBatch({
        store,
        plan,
        pack,
        adapter,
        now: CLOCK,
        exposure: FAKE_EXPOSURE
      });
      expect(outcome.defectCode).toBe(RunCode.BatchDefect);
      expect(outcome.outcomes.length).toBe(0);
      expect(outcome.cohort).toBe(null);
      const completed = JSON.parse(
        await store.read("runs/b-defect/batch.completed.json")
      ) as Record<string, unknown>;
      expect(completed.defect_code).toBe(RunCode.BatchDefect);
      expect(completed.not_started_trials).toBe(2);
      const ledgerText = await store.read(
        "runs/b-defect/assignment-events.jsonl"
      );
      const records = ledgerText
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.filter((r) => r.kind === "not_started").length).toBe(2);
    } finally {
      await clean();
    }
  });
});

describe("PRIMARY_REQUIREMENT_IDS", () => {
  it("names the five streams the primary metric depends on", () => {
    expect(PRIMARY_REQUIREMENT_IDS).toEqual([
      "api_trace",
      "lifecycle_ledger",
      "participant_surface_verification",
      "session_events",
      "final_state"
    ]);
  });
});
