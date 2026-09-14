import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore, type JsonlSink } from "@oal/evidence";
import {
  SchemaValidator,
  failureClassOf,
  sha256Hex,
  type Json
} from "@oal/core";
import {
  SessionEventRecorder,
  type AgentAdapter,
  type AgentEventSink,
  type AgentRunResult,
  type PreparedAgent
} from "@oal/agent-adapter";
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
  buildCohortEvaluation,
  createBatchSkeleton,
  runBatch,
  type BatchEvent
} from "./run.ts";
import type { TrialOutcome } from "./trial.ts";
import { stageRecordsOf, type LifecycleEvent } from "./lifecycle.ts";
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

/** An adapter whose run always rejects, for the launch-then-fail route. */
function explodingRunAdapter(): AgentAdapter {
  const base = batchAdapter();
  return {
    id: base.id,
    probe: () => base.probe(),
    prepare: (context) => base.prepare(context),
    run: () => Promise.reject(new Error("adapter exploded during run"))
  };
}

/** Spawn error text a missing executable produces on this platform. */
const SPAWN_ERROR_TEXT = "spawn /nonexistent/codex ENOENT";

/** An adapter whose driver never starts, for the AGENT_SPAWN_FAILED route. */
function spawnFailedAdapter(): AgentAdapter {
  const base = batchAdapter();
  return {
    id: base.id,
    probe: () => base.probe(),
    prepare: (context) => base.prepare(context),
    run: (prepared, sink): Promise<AgentRunResult> => {
      const recorder = new SessionEventRecorder({
        runId: prepared.runId,
        adapter: prepared.adapter,
        sink
      });
      recorder.started({ model: null });
      const spawnError = recorder.exited({
        exitCode: null,
        signal: null,
        graceful: false,
        spawnError: SPAWN_ERROR_TEXT
      });
      return Promise.resolve({
        status: "failed",
        exitCode: null,
        signal: null,
        durationMs: 3,
        errorCode: "AGENT_SPAWN_FAILED",
        ...(spawnError === null ? {} : { spawnError })
      });
    }
  };
}

/**
 * An adapter that records the stage facts through turn completion, then
 * rejects. The batch must recover those facts from the trial ledger even
 * though the throw route leaves the stage queue unflushed.
 */
function explodingAfterStagesAdapter(): AgentAdapter {
  const base = batchAdapter();
  return {
    id: base.id,
    probe: () => base.probe(),
    prepare: (context) => base.prepare(context),
    run: (prepared: PreparedAgent, sink: AgentEventSink): Promise<never> => {
      const recorder = new SessionEventRecorder({
        runId: prepared.runId,
        adapter: prepared.adapter,
        sink
      });
      recorder.started({ model: "mock-model-1" });
      recorder.adapterEvent("http.request", { path: "/v1/sessions" });
      return Promise.reject(new Error("adapter exploded after control"));
    }
  };
}

/**
 * A store whose lifecycle appends each land `turns` immediate-queue turns
 * after the trial submits them. This is the shape of a slow disk or
 * thread-pool contention across parallel lanes: queued writes reach the
 * ledger several event-loop turns after the batch starts recovering. Only
 * the lifecycle stream is delayed; every other sink keeps normal timing.
 */
function slowLifecycleStore(
  store: ArtifactStore,
  turns: number
): ArtifactStore {
  const inFlight = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let remaining = turns;
      const tick = (): void => {
        if (remaining === 0) {
          resolve();
          return;
        }
        remaining -= 1;
        setImmediate(tick);
      };
      setImmediate(tick);
    });
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== "openSink") {
        if (typeof value !== "function") {
          return value;
        }
        return value.bind(target) as unknown;
      }
      return async (relativePath: string): Promise<JsonlSink> => {
        const sink = await target.openSink(relativePath);
        if (!relativePath.endsWith("/lifecycle.jsonl")) {
          return sink;
        }
        return {
          append: async (line: string): Promise<void> => {
            await inFlight();
            await sink.append(line);
          },
          appendJson: async (payload: Json): Promise<void> => {
            await inFlight();
            await sink.appendJson(payload);
          }
        } as unknown as JsonlSink;
      };
    }
  });
}

/** Ledger records of one batch, parsed back from disk. */
async function ledgerRecords(
  store: ArtifactStore,
  batchId: string
): Promise<Record<string, unknown>[]> {
  const text = await store.read(`runs/${batchId}/assignment-events.jsonl`);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
      // Every mock trial reaches its terminal turn, so section 27.3 counts
      // all three in the agreement denominator.
      expect(denominators.report_agreement_count).toBe(3);
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

  it("relays the spawn error on the trial.finished event", async () => {
    const { plan, pack, store, clean } = await fixture(
      "oal-run-spawn-",
      "b-spawn-failed",
      1,
      1
    );
    try {
      const events: BatchEvent[] = [];
      const outcome = await runBatch({
        store,
        plan,
        pack,
        adapter: spawnFailedAdapter(),
        now: CLOCK,
        exposure: FAKE_EXPOSURE,
        onEvent: (event) => events.push(event)
      });
      const finished = events.find(
        (
          event
        ): event is Extract<BatchEvent, { readonly type: "trial.finished" }> =>
          event.type === "trial.finished"
      );
      expect(finished?.spawnError).toBe(SPAWN_ERROR_TEXT);
      expect(outcome.outcomes[0]?.disposition).toBe(
        "infrastructure_failed_pre_control"
      );
      expect(outcome.outcomes[0]?.spawnError).toBe(SPAWN_ERROR_TEXT);
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

  it("agrees with run.started.json on the per-text prompt digests", async () => {
    // batch.json and run.started.json are compared against each other for
    // tamper evidence, so both records must digest one canonical text: the
    // placeholder-rendered preview the batch froze. The naturalistic
    // instructions interpolate the base URL, so a digest over the live
    // render would differ from the batch by construction.
    const { plan, pack, adapter, store, clean } = await fixture(
      "oal-run-9-",
      "b-digests",
      2,
      1
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
      const batch = JSON.parse(
        await store.read("runs/b-digests/batch.json")
      ) as {
        inputs: Record<string, string>;
      };
      const startedSchema = JSON.parse(
        await readFile(
          path.join(SCHEMA_DIR, "run-started.v1.schema.json"),
          "utf8"
        )
      ) as Json;
      for (const trial of outcome.outcomes) {
        const started = JSON.parse(
          await store.read(
            `runs/b-digests/trials/${trial.runId}/run.started.json`
          )
        ) as { inputs: Record<string, string> };
        // The live digest fields must stay inside the published schema.
        expect(new SchemaValidator(startedSchema).errors(started)).toEqual([]);
        expect(started.inputs["instructions_sha256"]).toBe(
          batch.inputs["instructions_sha256"]
        );
        expect(started.inputs["task_sha256"]).toBe(batch.inputs["task_sha256"]);
        // The live render stays pinned under its own name and differs for
        // the instructions, because the pack interpolates the live base URL.
        expect(started.inputs["instructions_live_sha256"]).not.toBe(
          batch.inputs["instructions_sha256"]
        );
        expect(started.inputs["task_live_sha256"]).toBe(
          batch.inputs["task_sha256"]
        );
      }
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
      // The first trial was launched, so it is reported harness aborted
      // with its evidence kept; only the unlaunched second trial is not
      // started.
      expect(outcome.outcomes.length).toBe(1);
      expect(outcome.outcomes[0]?.disposition).toBe("harness_aborted");
      expect(outcome.notStartedRunIds).toEqual([plan.trialRunIds[1]]);
      const dispositions = (outcome.cohort as Record<string, unknown>)[
        "dispositions"
      ] as Record<string, number>;
      expect(dispositions).toEqual({ harness_aborted: 1, not_started: 1 });
      const completed = JSON.parse(
        await store.read("runs/b-defect/batch.completed.json")
      ) as Record<string, unknown>;
      expect(completed.defect_code).toBe(RunCode.BatchDefect);
      expect(completed.launched_trials).toBe(1);
      expect(completed.not_started_trials).toBe(1);
      const records = await ledgerRecords(store, "b-defect");
      expect(records.map((record) => record.kind)).toEqual([
        "launched",
        "terminal",
        "not_started"
      ]);
      expect(records[1]).toMatchObject({
        kind: "terminal",
        disposition: "harness_aborted"
      });
    } finally {
      await clean();
    }
  });

  it("records a launched trial whose run throws as harness_aborted", async () => {
    const adapter = explodingRunAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-run-7-",
      "b-exploded",
      2,
      1
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
      expect(outcome.defectCode).toBe(RunCode.BatchDefect);
      // Trial one launched and then failed: it keeps an accurate
      // terminal disposition and its evidence tree survives.
      expect(outcome.outcomes.length).toBe(1);
      const aborted = outcome.outcomes[0];
      expect(aborted?.runId).toBe(plan.trialRunIds[0]);
      expect(aborted?.disposition).toBe("harness_aborted");
      expect(aborted?.reasonCode).toBe(RunCode.BatchDefect);
      expect(aborted?.spawned).toBe(false);
      expect(aborted?.controlStarted).toBe(false);
      expect(aborted?.censorClass).toBe("pre_control_nonparticipant");
      expect(aborted?.evidenceIntegrity).toBe("missing");
      // The never-launched second trial is the only not-started run.
      expect(outcome.notStartedRunIds).toEqual([plan.trialRunIds[1]]);
      const root = `runs/b-exploded/trials/${aborted?.runId}`;
      expect(await store.exists(`${root}/run.started.json`)).toBe(true);
      expect(await store.exists(`${root}/lifecycle.jsonl`)).toBe(true);
      const records = await ledgerRecords(store, "b-exploded");
      expect(records.map((record) => record.kind)).toEqual([
        "launched",
        "terminal",
        "not_started"
      ]);
      expect(records[1]).toMatchObject({
        kind: "terminal",
        disposition: "harness_aborted",
        reason_code: RunCode.BatchDefect
      });
    } finally {
      await clean();
    }
  });

  it("recovers recorded stages of a launched trial whose run throws", async () => {
    // The adapter records participant_spawned, model_started,
    // participant_control_started, and api_started into the stage queue,
    // then throws. The queue appends asynchronously and the throw route
    // never flushes it, so the recovered disposition must let those
    // appends land before it reads the persisted ledger (section 32.4).
    const adapter = explodingAfterStagesAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-run-10-",
      "b-stages",
      2,
      1
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
      expect(outcome.defectCode).toBe(RunCode.BatchDefect);
      const aborted = outcome.outcomes[0];
      expect(aborted?.disposition).toBe("harness_aborted");
      expect(aborted?.spawned).toBe(true);
      expect(aborted?.controlStarted).toBe(true);
      // Control started, so the harness abort is an administrative censor,
      // never a pre-control nonparticipant claim.
      expect(aborted?.censorClass).toBe("administrative_censor");
      const ledger = await store.read(
        `runs/b-stages/trials/${aborted?.runId}/lifecycle.jsonl`
      );
      const stages = stageRecordsOf(
        ledger
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as LifecycleEvent)
      ).map((record) => record.stage);
      expect(stages).toContain("participant_spawned");
      expect(stages).toContain("participant_control_started");
    } finally {
      await clean();
    }
  });

  it("recovers stage appends that land several macrotask turns later", async () => {
    // The same throw route as the test above, but every lifecycle append
    // reaches the file only after eight immediate-queue turns. Two reads
    // taken one event-loop turn apart can match while writes are still in
    // flight, so settling must straddle a macrotask boundary: the
    // recovered outcome has to agree with the ledger that finally
    // persists (section 32.4).
    const adapter = explodingAfterStagesAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-run-12-",
      "b-slow-appends",
      2,
      1
    );
    try {
      const outcome = await runBatch({
        store: slowLifecycleStore(store, 8),
        plan,
        pack,
        adapter,
        now: CLOCK,
        exposure: FAKE_EXPOSURE
      });
      const aborted = outcome.outcomes[0];
      expect(aborted?.disposition).toBe("harness_aborted");
      expect(aborted?.spawned).toBe(true);
      expect(aborted?.controlStarted).toBe(true);
      // Control started, so the censor class follows the persisted
      // stages, never the stale pre-control claim.
      expect(aborted?.censorClass).toBe("administrative_censor");
      const ledger = await store.read(
        `runs/b-slow-appends/trials/${aborted?.runId}/lifecycle.jsonl`
      );
      const stages = stageRecordsOf(
        ledger
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as LifecycleEvent)
      ).map((record) => record.stage);
      expect(stages).toContain("participant_spawned");
      expect(stages).toContain("participant_control_started");
    } finally {
      await clean();
    }
  });

  it("fails the run when the assignment ledger cannot be written", async () => {
    const { plan, pack, adapter, store, clean } = await fixture(
      "oal-run-8-",
      "b-ledger",
      1,
      1
    );
    try {
      // A directory where the ledger file must land makes every append
      // fail at the filesystem after the batch skeleton exists.
      await mkdir(store.resolve("runs/b-ledger/assignment-events.jsonl"), {
        recursive: true
      });
      const outcome = await runBatch({
        store,
        plan,
        pack,
        adapter,
        now: CLOCK,
        exposure: FAKE_EXPOSURE
      });
      const defectCode = outcome.defectCode;
      expect(defectCode).toBe(RunCode.LedgerWriteFailed);
      expect(defectCode && failureClassOf(defectCode)?.category).toBe(
        "persistence"
      );
      expect(outcome.defectMessage).toContain("EISDIR");
      const completed = JSON.parse(
        await store.read("runs/b-ledger/batch.completed.json")
      ) as Record<string, unknown>;
      expect(completed.defect_code).toBe(RunCode.LedgerWriteFailed);
      // The trial itself still ran and still counts as launched.
      expect(completed.launched_trials).toBe(1);
      expect(outcome.outcomes[0]?.disposition).toBe("completed");
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

describe("buildCohortEvaluation", () => {
  it("counts report agreement over trials reaching turn_completed", async () => {
    // Section 27.3 defines report_agreement_count as trials reaching
    // turn_completed. A valid report without a completed turn never
    // counts, and a completed turn with a malformed report still does.
    const { plan, clean } = await fixture("oal-run-11-", "b-agreement", 1, 1);
    try {
      const cohort = buildCohortEvaluation(
        plan,
        [
          outcomeOf({ runId: "run-a", turnCompleted: false, report: "valid" }),
          outcomeOf({ runId: "run-b", turnCompleted: false, report: "valid" }),
          outcomeOf({
            runId: "run-c",
            turnCompleted: true,
            report: "malformed"
          })
        ],
        [],
        CLOCK
      );
      const denominators = cohort["denominators"] as Record<string, number>;
      expect(denominators["report_agreement_count"]).toBe(1);
      const reports = cohort["participant_report_status"] as Record<
        string,
        number
      >;
      expect(reports["valid"]).toBe(2);
      expect(reports["malformed"]).toBe(1);
    } finally {
      await clean();
    }
  });
});

/** One minimal terminal outcome for cohort aggregation tests. */
function outcomeOf(input: {
  runId: string;
  turnCompleted: boolean;
  report: "valid" | "malformed";
}): TrialOutcome {
  return {
    runId: input.runId,
    batchId: "b-agreement",
    index: 0,
    disposition: "completed",
    reasonCode: "OAL-RUN-DISPOSITION-COMPLETED",
    censorClass: "none",
    censorReasonCode: "OAL-RUN-CENSOR-NONE",
    evidenceIntegrity: "intact",
    controlStarted: true,
    spawned: true,
    turnCompleted: input.turnCompleted,
    reportStatus: input.report,
    reportSha256: null,
    evaluation: null,
    usageObserved: true,
    apiRequests: 1,
    agentToolCalls: 0,
    exit: { code: 0, signal: null },
    startedAtMs: 0,
    finishedAtMs: 0
  };
}
