import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";
import { sha256Hex } from "@oal/core";
import type { AgentAdapter } from "@oal/agent-adapter";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { findRepoRoot, loadSteelPack } from "@oal/testkit";
import type { LoadedPack } from "@oal/pack";

import {
  assertPreflightClean,
  runPreflight,
  type FrozenPlan
} from "./preflight.ts";
import { createLoopbackExposure } from "./exposure.ts";
import { runTrial } from "./trial.ts";
import {
  stageRecordsOf,
  ORDERED_STAGES,
  type LifecycleEvent,
  type LifecycleStage
} from "./lifecycle.ts";
import type {
  ExposureFactory,
  ExposureHandle,
  ExposureRequest
} from "./setup.ts";

const SCHEMA_DIR = path.join(findRepoRoot(), "schemas");
const CLOCK = (): number => 1_700_000_000_000;

const FINAL_TEXT = JSON.stringify({
  session_created: true,
  session_released: true,
  final_status: "released",
  notes: "mock participant report"
});

/** A socket-free treatment: one fixed handle per trial. */
function fakeExposureLog(exchangeFailureCount = 0): {
  factory: ExposureFactory;
  requests: ExposureRequest[];
} {
  const requests: ExposureRequest[] = [];
  const handle: ExposureHandle = {
    baseUrl: "http://127.0.0.1:9",
    credentialNames: [],
    documentationUrl: null,
    mcpUrl: null,
    serverRecord: { kind: "FakeExposure", base_url: "http://127.0.0.1:9" },
    exchangeFailureCount,
    close: () => Promise.resolve()
  };
  return {
    requests,
    factory: (request) => {
      requests.push(request);
      return Promise.resolve(handle);
    }
  };
}

/** The scripted participant: spawn, one API request line, one turn end. */
function scriptedAdapter(): MockAgentAdapter {
  return new MockAgentAdapter({
    model: "mock-model-1",
    events: [
      { channel: "adapter", kind: "http.request", text: "POST /v1/sessions" },
      { channel: "stdout", kind: "turn.completed", text: "done" }
    ],
    files: [{ path: "notes.md", content: "participant note\n" }],
    finalText: FINAL_TEXT,
    usage: { input_tokens: 12, output_tokens: 6, tool_calls: 2 }
  });
}

/** A socket-free treatment that counts how often it was closed. */
class CountedExposure implements ExposureHandle {
  public closeCount = 0;
  readonly baseUrl = "http://127.0.0.1:9";
  readonly credentialNames: readonly string[] = [];
  readonly documentationUrl = null;
  readonly mcpUrl = null;
  readonly serverRecord = { kind: "CountedExposure" };
  readonly factory: ExposureFactory = () => Promise.resolve(this);

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

/** An adapter whose run always rejects, so the trial itself throws. */
function explodingRunAdapter(base: MockAgentAdapter): AgentAdapter {
  return {
    id: base.id,
    probe: () => base.probe(),
    prepare: (context) => base.prepare(context),
    run: () => Promise.reject(new Error("adapter exploded during run"))
  };
}

interface Fixture {
  plan: FrozenPlan;
  pack: LoadedPack;
  store: ArtifactStore;
  clean: () => Promise<void>;
}

async function fixture(
  label: string,
  adapter: MockAgentAdapter,
  batchId: string
): Promise<Fixture> {
  const packForTest = await loadSteelPack();
  const dir = await mkdtemp(path.join(tmpdir(), label));
  const store = new ArtifactStore(path.join(dir, ".oal"));
  const plan = assertPreflightClean(
    await runPreflight({
      packDir: packForTest.root,
      evalId: "basic-lifecycle",
      batchId,
      store,
      adapter,
      paid: false,
      schemaDir: SCHEMA_DIR
    })
  );
  return {
    plan,
    pack: packForTest.loaded,
    store,
    clean: async () => rm(dir, { recursive: true, force: true })
  };
}

async function readLedger(
  store: ArtifactStore,
  relativeRoot: string
): Promise<string[]> {
  const text = await store.read(`${relativeRoot}/lifecycle.jsonl`);
  const events = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LifecycleEvent);
  return stageRecordsOf(events).map((record) => record.stage);
}

describe("runTrial", () => {
  it("runs one trial end to end with a fake exposure", async () => {
    const adapter = scriptedAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-1-",
      adapter,
      "b-trial-1"
    );
    const exposure = fakeExposureLog();
    try {
      const events: string[] = [];
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK,
        onEvent: (event) => events.push(event.type)
      });

      // Terminal classification.
      expect(outcome.disposition).toBe("completed");
      expect(outcome.reasonCode).toBe("OAL-RUN-DISPOSITION-COMPLETED");
      expect(outcome.controlStarted).toBe(true);
      expect(outcome.spawned).toBe(true);
      expect(outcome.turnCompleted).toBe(true);
      expect(outcome.reportStatus).toBe("valid");
      expect(outcome.exit).toEqual({ code: 0, signal: null });
      expect(outcome.censorClass).toBe("none");
      expect(outcome.evidenceIntegrity).toBe("intact");
      expect(outcome.agentToolCalls).toBe(2);
      expect(events).toEqual(["trial.started", "trial.finished"]);

      // Artifacts on disk.
      const root = `runs/${plan.batchId}/trials/${outcome.runId}`;
      for (const artifact of [
        "run.started.json",
        "run.completed.json",
        "artifact-manifest.json",
        "lifecycle.jsonl",
        "evaluation.json",
        "state.final.json",
        "state.summary.json",
        "resource-usage.json",
        "participant-final.txt",
        "participant-surface-verification.json",
        "session/events.redacted.jsonl"
      ]) {
        expect(await store.exists(`${root}/${artifact}`)).toBe(true);
      }

      // The lifecycle ledger holds every stage in specification order.
      const stages = await readLedger(store, root);
      const expected = [
        "scheduled",
        "workspace_prepared",
        "server_ready",
        "participant_spawned",
        "model_started",
        "participant_control_started",
        "api_started",
        "turn_completed",
        "report_present",
        "report_valid",
        "finalization_started",
        "evidence_finalized"
      ];
      expect(stages).toEqual(expected);
      for (const stage of stages) {
        expect(ORDERED_STAGES.includes(stage as LifecycleStage)).toBe(true);
      }

      // The terminal record pins the manifest digest of what shipped.
      const completed = JSON.parse(
        await store.read(`${root}/run.completed.json`)
      ) as Record<string, unknown>;
      const manifestText = await store.read(`${root}/artifact-manifest.json`);
      expect(completed.artifact_manifest_sha256).toBe(sha256Hex(manifestText));
      expect(completed.participant_report).toMatchObject({ status: "valid" });

      // The report carries no secret values.
      const reportText = await store.read(`${root}/participant-final.txt`);
      expect(reportText).toBe(FINAL_TEXT);

      // The exposure saw the frozen trial seed and shared trace writer.
      expect(exposure.requests.length).toBe(1);
      expect(exposure.requests[0]?.trialSeed).toBe(plan.trialSeeds[0]);
    } finally {
      await clean();
    }
  });

  it("keeps run.started.json deterministic across identical trials", async () => {
    const adapter = scriptedAdapter();
    const first = await fixture("oal-trial-2-", scriptedAdapter(), "b-det");
    const second = await fixture("oal-trial-3-", scriptedAdapter(), "b-det");
    try {
      const exposure = fakeExposureLog();
      const options = {
        plan: first.plan,
        pack: first.pack,
        adapter,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK
      } as const;
      const one = await runTrial({ ...options, store: first.store });
      const two = await runTrial({ ...options, store: second.store });
      const relative = `runs/${first.plan.batchId}/trials/${one.runId}`;
      expect(await first.store.read(`${relative}/run.started.json`)).toBe(
        await second.store.read(`${relative}/run.started.json`)
      );
      expect(two.runId).toBe(one.runId);
    } finally {
      await first.clean();
      await second.clean();
    }
  });

  it("classifies an adapter failure after control as agent_failed", async () => {
    const adapter = new MockAgentAdapter({
      model: "mock-model-1",
      events: [
        { channel: "adapter", kind: "http.request", text: "POST /v1/sessions" }
      ],
      status: "failed",
      exitCode: 3
    });
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-4-",
      adapter,
      "b-agent-failed"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: fakeExposureLog().factory,
        now: CLOCK
      });
      expect(outcome.disposition).toBe("agent_failed");
      expect(outcome.reasonCode).toBe("OAL-AGENT-EXIT-NONZERO");
      expect(outcome.controlStarted).toBe(true);
      expect(outcome.turnCompleted).toBe(false);
      expect(outcome.censorClass).toBe("none");
      expect(outcome.evidenceIntegrity).toBe("intact");
      const root = `runs/${plan.batchId}/trials/${outcome.runId}`;
      const stages = await readLedger(store, root);
      expect(stages).not.toContain("turn_completed");
      expect(stages).toContain("finalization_started");
      const completed = JSON.parse(
        await store.read(`${root}/run.completed.json`)
      ) as Record<string, unknown>;
      expect(completed.disposition).toBe("agent_failed");
      expect(completed.agent).toMatchObject({ exit_code: 3 });
    } finally {
      await clean();
    }
  });

  it("classifies a reported timeout as timed_out", async () => {
    const adapter = new MockAgentAdapter({
      model: "mock-model-1",
      status: "timed_out"
    });
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-5-",
      adapter,
      "b-timeout"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: fakeExposureLog().factory,
        now: CLOCK
      });
      expect(outcome.disposition).toBe("timed_out");
      expect(outcome.turnCompleted).toBe(false);
    } finally {
      await clean();
    }
  });

  it("closes the exposure when the adapter throws", async () => {
    // The disposal path must cover every exit route: a throwing run
    // releases the treatment exactly once before the error propagates.
    const adapter = explodingRunAdapter(scriptedAdapter());
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-8-",
      scriptedAdapter(),
      "b-adapter-throw"
    );
    const exposure = new CountedExposure();
    try {
      const failure = runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK
      });
      await expect(failure).rejects.toThrowError(/adapter exploded/u);
      expect(exposure.closeCount).toBe(1);
      // The evidence written before the throw survives.
      const runId = plan.trialRunIds[0];
      if (runId === undefined) {
        throw new Error("frozen batch holds no run id");
      }
      const root = `runs/${plan.batchId}/trials/${runId}`;
      expect(await store.exists(`${root}/run.started.json`)).toBe(true);
      expect(await store.exists(`${root}/lifecycle.jsonl`)).toBe(true);
    } finally {
      await clean();
    }
  });

  it("closes the exposure exactly once on the completion route", async () => {
    const adapter = scriptedAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-9-",
      adapter,
      "b-adapter-clean"
    );
    const exposure = new CountedExposure();
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK
      });
      expect(outcome.disposition).toBe("completed");
      expect(exposure.closeCount).toBe(1);
    } finally {
      await clean();
    }
  });

  it("records invalid_setup when the exposure cannot start", async () => {
    const adapter = scriptedAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-6-",
      adapter,
      "b-invalid-setup"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: () => Promise.reject(new Error("no treatment")),
        now: CLOCK
      });
      expect(outcome.disposition).toBe("invalid_setup");
      expect(outcome.reasonCode).toBe("OAL-RUN-SETUP-EXPOSURE-FAILED");
      expect(outcome.censorClass).toBe("pre_control_nonparticipant");
      expect(outcome.evidenceIntegrity).toBe("missing");
      const root = `runs/${plan.batchId}/trials/${outcome.runId}`;
      const stages = await readLedger(store, root);
      expect(stages).not.toContain("participant_spawned");
      const completed = JSON.parse(
        await store.read(`${root}/run.completed.json`)
      ) as Record<string, unknown>;
      const missing = completed.missing_artifacts as unknown[];
      expect(missing.length).toBeGreaterThan(0);
    } finally {
      await clean();
    }
  });

  it("serves a loopback gateway and traces the exchange", async () => {
    const adapter = new MockAgentAdapter({
      model: "mock-model-1",
      requests: [{ path: "/v1/sessions", method: "POST" }],
      events: [{ channel: "stdout", kind: "turn.completed", text: "done" }],
      finalText: FINAL_TEXT
    });
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-7-",
      adapter,
      "b-loopback"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: createLoopbackExposure,
        now: CLOCK
      });
      expect(outcome.disposition).toBe("completed");
      expect(outcome.apiRequests).toBe(1);
      const root = `runs/${plan.batchId}/trials/${outcome.runId}`;
      const stages = await readLedger(store, root);
      expect(stages).toContain("api_started");
      expect(stages.indexOf("api_started")).toBeGreaterThan(
        stages.indexOf("participant_control_started")
      );
      const traceText = await store.read(`${root}/trace.jsonl`);
      const exchange = JSON.parse(
        traceText.split("\n").filter((line) => line.length > 0)[0] ?? "{}"
      ) as Record<string, unknown>;
      expect(exchange.type).toBe("api.exchange");
      expect(exchange.operation).toMatchObject({
        operation_id: "create_session",
        matched: true
      });
      const request = exchange.request as Record<string, unknown>;
      expect(request.credential_present).toBe(false);
    } finally {
      await clean();
    }
  });

  it("marks exposure persistence failures as invalid infrastructure evidence", async () => {
    const adapter = scriptedAdapter();
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-persist-",
      adapter,
      "b-persist-failure"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: fakeExposureLog(1).factory,
        now: CLOCK
      });
      expect(outcome.disposition).toBe("infrastructure_failed_post_control");
      expect(outcome.evidenceIntegrity).toBe("corrupt");
      expect(outcome.censorClass).toBe("instrumentation_censor");
    } finally {
      await clean();
    }
  });

  it("detects a participant symlink after execution without dereferencing it", async () => {
    const base = scriptedAdapter();
    const adapter: AgentAdapter = {
      id: base.id,
      probe: () => base.probe(),
      prepare: (context) => base.prepare(context),
      run: async (prepared, sink, signal) => {
        await symlink(
          "/etc/hosts",
          path.join(prepared.workingDirectory, "outside-link")
        );
        return await base.run(prepared, sink, signal);
      }
    };
    const { plan, pack, store, clean } = await fixture(
      "oal-trial-symlink-",
      base,
      "b-symlink"
    );
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index: 0,
        exposure: fakeExposureLog().factory,
        now: CLOCK
      });
      expect(outcome.evidenceIntegrity).toBe("corrupt");
      const root = `runs/${plan.batchId}/trials/${outcome.runId}`;
      const manifest = JSON.parse(
        await store.read(`${root}/artifact-manifest.json`)
      ) as { entries: Array<Record<string, unknown>> };
      expect(
        manifest.entries.find(
          (entry) => entry["path"] === "workspace/outside-link"
        )?.["entry_type"]
      ).toBe("symlink");
    } finally {
      await clean();
    }
  });
});
