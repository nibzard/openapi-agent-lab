import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";

import {
  LifecycleCode,
  OPERATOR_SIGNAL_STAGE,
  ORDERED_STAGES,
  TrialLifecycle,
  controlStarted,
  evidenceFinalized,
  hasStage,
  snapshotOfRecords,
  stageRecordsOf,
  type LifecycleEvent,
  type LifecycleSnapshot
} from "./lifecycle.ts";

async function newStore(): Promise<{
  store: ArtifactStore;
  clean: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-lifecycle-"));
  return {
    store: new ArtifactStore(path.join(dir, ".oal")),
    clean: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

const clock = (): number => 1_700_000_000_000;

describe("TrialLifecycle", () => {
  it("records the run identity and stages in order", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink, {
        batchId: "b1",
        runId: "run-1"
      });
      await lifecycle.created("run-1", null, clock);
      await lifecycle.record("scheduled", "runner", { index: 0 }, clock);
      await lifecycle.record("workspace_prepared", "filesystem", {}, clock);
      await lifecycle.record("server_ready", "gateway", {}, clock);
      const snapshot = lifecycle.snapshot();
      expect(hasStage(snapshot, "scheduled")).toBe(true);
      expect(hasStage(snapshot, "server_ready")).toBe(true);
      expect(controlStarted(snapshot)).toBe(false);
      expect(evidenceFinalized(snapshot)).toBe(false);
      expect(snapshot.facts.length).toBe(3);

      const text = await store.read("runs/b1/trials/run-1/lifecycle.jsonl");
      const lines = text.split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBe(4);
      expect(lines[0]).toContain('"run.created"');
      expect(lines[0]).toContain('"run_id":"run-1"');
    } finally {
      await clean();
    }
  });

  it("refuses a repeated stage", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink);
      await lifecycle.created("run-1", "run-0", clock);
      await lifecycle.record("scheduled", "runner", {}, clock);
      await expect(
        lifecycle.record("scheduled", "runner", {}, clock)
      ).rejects.toMatchObject({
        code: LifecycleCode.StageDuplicate
      });
    } finally {
      await clean();
    }
  });

  it("refuses a backward transition", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink);
      await lifecycle.created("run-1", null, clock);
      await lifecycle.record("server_ready", "gateway", {}, clock);
      await expect(
        lifecycle.record("workspace_prepared", "filesystem", {}, clock)
      ).rejects.toMatchObject({
        code: LifecycleCode.StageOutOfOrder
      });
    } finally {
      await clean();
    }
  });

  it("refuses an unknown stage", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink);
      await lifecycle.created("run-1", null, clock);
      await expect(
        lifecycle.record("exploded" as "scheduled", "runner", {}, clock)
      ).rejects.toMatchObject({ code: LifecycleCode.StageUnknown });
    } finally {
      await clean();
    }
  });

  it("keeps the operator signal outside the stage order", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink);
      await lifecycle.created("run-1", null, clock);
      await lifecycle.record("scheduled", "runner", {}, clock);
      await lifecycle.record(
        OPERATOR_SIGNAL_STAGE,
        "operator",
        {
          signal: "SIGINT"
        },
        clock
      );
      await lifecycle.record("finalization_started", "runner", {}, clock);
      await lifecycle.record(
        OPERATOR_SIGNAL_STAGE,
        "operator",
        { signal: "SIGTERM" },
        clock
      );
      const snapshot = lifecycle.snapshot();
      expect(snapshot.stages.has(OPERATOR_SIGNAL_STAGE)).toBe(true);
      expect(hasStage(snapshot, "finalization_started")).toBe(true);
      expect(ORDERED_STAGES.includes(OPERATOR_SIGNAL_STAGE)).toBe(false);
    } finally {
      await clean();
    }
  });

  it("rebuilds a snapshot from records and rejects a corrupt ledger", async () => {
    const { store, clean } = await newStore();
    try {
      const sink = await store.openSink("runs/b1/trials/run-1/lifecycle.jsonl");
      const lifecycle = TrialLifecycle.open(sink, {
        batchId: "b1",
        runId: "run-1"
      });
      await lifecycle.created("run-1", null, clock);
      await lifecycle.record("scheduled", "runner", {}, clock);
      await lifecycle.record("participant_spawned", "adapter", {}, clock);
      await lifecycle.record(
        "participant_control_started",
        "adapter",
        {},
        clock
      );
      await lifecycle.record("evidence_finalized", "runner", {}, clock);

      const text = await readFile(sinkPath(store), "utf8");
      const records = text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LifecycleEvent);
      const recovered: LifecycleSnapshot = snapshotOfRecords(
        stageRecordsOf(records)
      );
      expect(controlStarted(recovered)).toBe(true);
      expect(evidenceFinalized(recovered)).toBe(true);

      const duplicate = records[1];
      const duplicated =
        duplicate === undefined ? records : [...records, duplicate, duplicate];
      expect(() => snapshotOfRecords(stageRecordsOf(duplicated))).toThrowError(
        /do not increase/u
      );
    } finally {
      await clean();
    }
  });
});

function sinkPath(store: ArtifactStore): string {
  return store.resolve("runs/b1/trials/run-1/lifecycle.jsonl");
}
