/**
 * Gate 6 of specification section 36.1: full fake-agent trials through the
 * real loopback exposure, plus the restart and replay basics of gate 12.
 *
 * Every trial in this file drives `createLoopbackExposure`: the scripted
 * participant makes real HTTP calls to a listener on 127.0.0.1, and the
 * gateway writes the `api.exchange` events into the trial trace.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex, type Json } from "@oal/core";
import { ArtifactStore } from "@oal/evidence";
import { compileOpenApi } from "@oal/openapi";

import {
  assertPreflightClean,
  createLoopbackExposure,
  runPreflight,
  runTrial,
  type FrozenPlan,
  type TrialOutcome
} from "./index.ts";
import {
  FIXED_NOW_MS,
  fixedClock,
  prepareTrial,
  readJsonObject,
  readStageList,
  readTraceEvents,
  schemaDirectory,
  silentAdapter,
  smokeAdapter,
  steelAdapter,
  steelPackRoot,
  trialRootOf,
  writePermissiveSteelPack,
  writeSmokePack
} from "./integration-fixtures.ts";

/** Artifacts a completed trial must leave behind, in evidence order. */
const EXPECTED_ARTIFACTS: readonly string[] = [
  "run.started.json",
  "lifecycle.jsonl",
  "trace.jsonl",
  "evaluation.json",
  "state.final.json",
  "state.summary.json",
  "resource-usage.json",
  "participant-final.txt",
  "participant-surface-verification.json",
  "session/events.redacted.jsonl",
  "artifact-manifest.json",
  "run.completed.json"
];

/** Stage order a clean scripted participant produces. */
const EXPECTED_STAGES: readonly string[] = [
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

/**
 * Assert the terminal facts of one finished trial: completed disposition,
 * finalized and intact evidence, and a manifest that matches its pointer.
 */
async function assertFinalizedEvidence(
  store: ArtifactStore,
  plan: FrozenPlan,
  outcome: TrialOutcome
): Promise<void> {
  expect(outcome.disposition).toBe("completed");
  expect(outcome.reasonCode).toBe("OAL-RUN-DISPOSITION-COMPLETED");
  expect(outcome.censorClass).toBe("none");
  expect(outcome.evidenceIntegrity).toBe("intact");
  expect(outcome.reportStatus).toBe("valid");
  expect(outcome.exit).toEqual({ code: 0, signal: null });
  expect(outcome.startedAtMs).toBe(FIXED_NOW_MS);
  expect(outcome.finishedAtMs).toBe(FIXED_NOW_MS);

  const root = trialRootOf(plan.batchId, outcome.runId);
  for (const artifact of EXPECTED_ARTIFACTS) {
    expect(await store.exists(`${root}/${artifact}`)).toBe(true);
  }

  const stages = await readStageList(store, root);
  expect(stages).toEqual([...EXPECTED_STAGES]);

  const completed = await readJsonObject(store, `${root}/run.completed.json`);
  const manifestText = await store.read(`${root}/artifact-manifest.json`);
  expect(completed["artifact_manifest_sha256"]).toBe(sha256Hex(manifestText));
  expect(completed["disposition"]).toBe("completed");
  expect(completed["evidence_integrity"]).toBe("intact");
  expect(completed["censor_class"]).toBe("none");
  expect(completed["failed_requirement_ids"]).toEqual([]);
}

/**
 * Assert every recorded exchange names a declared contract operation and
 * belongs to exactly one trial.
 */
async function assertTraceMatchesContract(
  store: ArtifactStore,
  plan: FrozenPlan,
  runId: string
): Promise<void> {
  const trace = await readTraceEvents(store, trialRootOf(plan.batchId, runId));
  expect(trace.length).toBeGreaterThan(0);

  const declared = new Map(
    plan.contract.ir.operations.map((operation) => [operation.key, operation])
  );

  trace.forEach((event, index) => {
    expect(event.type).toBe("api.exchange");
    expect(event.sequence).toBe(index + 1);
    expect(event.event_id.length).toBeGreaterThan(0);
    expect(event.batch_id).toBe(plan.batchId);
    expect(event.run_id).toBe(runId);
    expect(event.eval_id).toBe(plan.evalId);
    expect(event.actor).toBe("participant");

    expect(event.operation.matched).toBe(true);
    expect(event.operation.support).toBe("supported");
    expect(event.operation.key).not.toBeNull();
    const operation = declared.get(event.operation.key ?? "");
    expect(operation).toBeDefined();
    if (operation === undefined) {
      return;
    }
    expect(event.operation.operation_id).toBe(operation.operation_id);
    expect(event.operation.method).toBe(operation.method);
    expect(event.operation.path_template).toBe(operation.path_template);

    expect(event.request).not.toBeNull();
    expect(event.request?.method).toBe(operation.method);
    expect(event.response?.status).toBeGreaterThanOrEqual(200);
    expect(event.response?.status).toBeLessThan(600);
    // Replay support: the exchange keeps a full request and response.
    expect(event.replay.classification).toBe("full");
  });
}

describe("runner integration: fake-agent trials through the loopback exposure", () => {
  it(
    "runs the steel basic-lifecycle eval end to end",
    { timeout: 30000 },
    async () => {
      const adapter = steelAdapter("basic-lifecycle");
      const harness = await prepareTrial({
        label: "oal-it-steel-bl-",
        packDir: steelPackRoot(),
        evalId: "basic-lifecycle",
        batchId: "it-steel-basic-lifecycle",
        adapter
      });
      try {
        const outcome = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });

        await assertFinalizedEvidence(harness.store, harness.plan, outcome);
        await assertTraceMatchesContract(
          harness.store,
          harness.plan,
          outcome.runId
        );

        // The scripted participant made four real HTTP calls.
        expect(outcome.apiRequests).toBe(4);

        // Golden evaluation. The gateway cannot generate the Steel
        // session documents (packs/steel-computer/PARITY.md), so the
        // flow checks fail. The report schema reference resolves, and
        // the scripted report matches it.
        const evaluation = await readJsonObject(
          harness.store,
          `${trialRootOf(harness.plan.batchId, outcome.runId)}/evaluation.json`
        );
        expect(evaluation["rubric_id"]).toBe("steel-basic-lifecycle");
        expect(evaluation["rubric_sha256"]).toBe(
          "993896d94572a1860738f155774bf6fb8e9b7c0e6cf690068a2d88ec36906e74"
        );
        expect(evaluation["status"]).toBe("failed");
        expect(evaluation["passed_weight"]).toBe(2);
        expect(evaluation["total_weight"]).toBe(9);
        expect(evaluation["score"]).toBe(2 / 9);
        expect(evaluation["run_id"]).toBe(outcome.runId);
        expect(evaluation["evaluated_at"]).toBe("2023-11-14T22:13:20.000Z");
        expect(outcome.evaluation).toEqual({
          status: "failed",
          score: 2 / 9,
          passedWeight: 2,
          totalWeight: 9,
          valid: true
        });
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "runs the steel checkpoint-recovery eval end to end",
    { timeout: 30000 },
    async () => {
      const adapter = steelAdapter("checkpoint-recovery");
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-steel-cr-"));
      const packDir = await writePermissiveSteelPack(scratch);
      const harness = await prepareTrial({
        label: "oal-it-steel-cr-",
        packDir,
        evalId: "checkpoint-recovery",
        batchId: "it-steel-checkpoint-recovery",
        adapter
      });
      try {
        const outcome = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });

        await assertFinalizedEvidence(harness.store, harness.plan, outcome);
        await assertTraceMatchesContract(
          harness.store,
          harness.plan,
          outcome.runId
        );

        // Nine scripted calls: three uploads, three downloads, one create,
        // one release, one final read.
        expect(outcome.apiRequests).toBe(9);

        const evaluation = await readJsonObject(
          harness.store,
          `${trialRootOf(harness.plan.batchId, outcome.runId)}/evaluation.json`
        );
        expect(evaluation["rubric_id"]).toBe("steel-checkpoint-recovery");
        expect(evaluation["rubric_sha256"]).toBe(
          "00b9237d010083bb5f25efb496b4dd36099c7414475944311f55fafecdc9e28f"
        );
        expect(evaluation["status"]).toBe("failed");
        expect(evaluation["passed_weight"]).toBe(3);
        expect(evaluation["total_weight"]).toBe(12);
        expect(evaluation["score"]).toBe(3 / 12);
        const signals = evaluation["signals"];
        expect(signals).toEqual({
          first_call_is_create: true,
          first_call_matched: true
        });
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "accepts the shipped checkpoint-recovery eval at preflight",
    { timeout: 30000 },
    async () => {
      // The shipped cases validate against the shipped case schema, so
      // preflight freezes a plan without errors for the real pack.
      const adapter = steelAdapter("checkpoint-recovery");
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-steel-px-"));
      const store = new ArtifactStore(path.join(scratch, ".oal"));
      try {
        const result = await runPreflight({
          packDir: steelPackRoot(),
          evalId: "checkpoint-recovery",
          batchId: "it-steel-preflight-real",
          store,
          adapter,
          paid: false,
          schemaDir: schemaDirectory()
        });
        expect(result.ok).toBe(true);
        const plan = assertPreflightClean(result);
        expect(plan.evaluation.evalDoc.cases?.source).toContain(
          "checkpoint-recovery"
        );
        expect(plan.evaluation.resultSchema).not.toBe(null);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  );

  it(
    "passes a fully supported synthetic eval end to end",
    { timeout: 30000 },
    async () => {
      // One operation the contract mode fully serves: the rubric passes,
      // the report validates, and the evaluation turns green.
      const adapter = smokeAdapter();
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-smoke-"));
      const packDir = await writeSmokePack(scratch);
      const harness = await prepareTrial({
        label: "oal-it-smoke-",
        packDir,
        evalId: "smoke",
        batchId: "it-smoke-pass",
        adapter
      });
      try {
        const outcome = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });

        await assertFinalizedEvidence(harness.store, harness.plan, outcome);
        await assertTraceMatchesContract(
          harness.store,
          harness.plan,
          outcome.runId
        );
        expect(outcome.apiRequests).toBe(1);

        const root = trialRootOf(harness.plan.batchId, outcome.runId);
        const evaluation = await readJsonObject(
          harness.store,
          `${root}/evaluation.json`
        );
        expect(evaluation["status"]).toBe("passed");
        expect(evaluation["passed_weight"]).toBe(4);
        expect(evaluation["total_weight"]).toBe(4);
        expect(evaluation["score"]).toBe(1);
        expect(evaluation["infrastructure_errors"]).toEqual([]);
        expect(outcome.evaluation).toEqual({
          status: "passed",
          score: 1,
          passedWeight: 4,
          totalWeight: 4,
          valid: true
        });

        // The one exchange succeeded, so the script's status expectation
        // held against the real gateway.
        const trace = await readTraceEvents(harness.store, root);
        expect(trace[0]?.response?.status).toBe(200);
        expect(trace[0]?.response?.body.kind).toBe("json");
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "refuses to resume a run id that already started",
    { timeout: 30000 },
    async () => {
      // Gate 12: a trial never resumes. The second start of the same run
      // id must fail loudly instead of appending to existing evidence.
      const adapter = smokeAdapter();
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-restart-"));
      const packDir = await writeSmokePack(scratch);
      const harness = await prepareTrial({
        label: "oal-it-restart-",
        packDir,
        evalId: "smoke",
        batchId: "it-restart-refusal",
        adapter
      });
      try {
        const first = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });
        expect(first.disposition).toBe("completed");

        await expect(
          runTrial({
            store: harness.store,
            plan: harness.plan,
            pack: harness.pack,
            adapter,
            index: 0,
            exposure: createLoopbackExposure,
            now: fixedClock()
          })
        ).rejects.toThrow(/already started; a trial never resumes/);
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "re-executes a trial into a fresh store with the same evidence",
    { timeout: 30000 },
    async () => {
      // Gate 12 replay basics: the same plan against a fresh store
      // reproduces the same logical trace and evaluation.
      const adapter = smokeAdapter();
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-replay-"));
      const packDir = await writeSmokePack(scratch);
      const dispositions: string[] = [];
      const traces: string[] = [];
      const evaluations: string[] = [];
      for (const label of ["a", "b"]) {
        const harness = await prepareTrial({
          label: `oal-it-replay-${label}-`,
          packDir,
          evalId: "smoke",
          batchId: "it-replay-fresh-store",
          adapter: smokeAdapter()
        });
        try {
          const outcome = await runTrial({
            store: harness.store,
            plan: harness.plan,
            pack: harness.pack,
            adapter,
            index: 0,
            exposure: createLoopbackExposure,
            now: fixedClock()
          });
          const root = trialRootOf(harness.plan.batchId, outcome.runId);
          dispositions.push(`${outcome.disposition}:${outcome.reportStatus}`);
          traces.push(await harness.store.read(`${root}/trace.jsonl`));
          evaluations.push(await harness.store.read(`${root}/evaluation.json`));
        } finally {
          await harness.clean();
        }
      }
      expect(dispositions[0]).toBe("completed:valid");
      expect(dispositions[1]).toBe("completed:valid");
      // The logical trace repeats exactly; only the port inside the host
      // header can differ, so compare the normalized form.
      expect(normalizePort(traces[0] ?? "")).toBe(
        normalizePort(traces[1] ?? "")
      );
      expect(evaluations[0]).toBe(evaluations[1]);
    }
  );

  it(
    "completes a trial whose participant makes no api request",
    { timeout: 30000 },
    async () => {
      // A silent participant is a captured task outcome, never an
      // infrastructure one: the turn completes, the report validates, and
      // the frozen evidence set stays complete and immutable.
      const adapter = silentAdapter();
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-silent-"));
      const packDir = await writeSmokePack(scratch);
      const harness = await prepareTrial({
        label: "oal-it-silent-",
        packDir,
        evalId: "smoke",
        batchId: "it-silent-participant",
        adapter
      });
      try {
        const outcome = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });

        expect(outcome.disposition).toBe("completed");
        expect(outcome.reasonCode).toBe("OAL-RUN-DISPOSITION-COMPLETED");
        expect(outcome.censorClass).toBe("none");
        expect(outcome.evidenceIntegrity).toBe("intact");
        expect(outcome.reportStatus).toBe("valid");
        expect(outcome.apiRequests).toBe(0);
        expect(outcome.exit).toEqual({ code: 0, signal: null });

        const root = trialRootOf(harness.plan.batchId, outcome.runId);
        for (const artifact of EXPECTED_ARTIFACTS) {
          expect(await harness.store.exists(`${root}/${artifact}`)).toBe(true);
        }

        // No request means no api_started stage; every other stage of a
        // clean run still happens.
        const stages = await readStageList(harness.store, root);
        expect(stages).toEqual(
          EXPECTED_STAGES.filter((stage) => stage !== "api_started")
        );

        // The trace exists, and stays empty.
        expect(await harness.store.read(`${root}/trace.jsonl`)).toBe("");

        // The honest evaluation: the report checks pass, the call check
        // fails, and nothing turns into an infrastructure error.
        const evaluation = await readJsonObject(
          harness.store,
          `${root}/evaluation.json`
        );
        expect(evaluation["status"]).toBe("failed");
        expect(evaluation["passed_weight"]).toBe(2);
        expect(evaluation["total_weight"]).toBe(4);
        expect(evaluation["infrastructure_errors"]).toEqual([]);
        expect(outcome.evaluation).toEqual({
          status: "failed",
          score: 0.5,
          passedWeight: 2,
          totalWeight: 4,
          valid: true
        });

        // The ledger is write-once: replaying a terminal or initial record
        // never rewrites history.
        await expect(
          harness.store.writeOnce(`${root}/run.completed.json`, "{}\n")
        ).rejects.toThrowError(/already exists/u);
        await expect(
          harness.store.writeOnce(`${root}/run.started.json`, "{}\n")
        ).rejects.toThrowError(/already exists/u);
        const completed = await readJsonObject(
          harness.store,
          `${root}/run.completed.json`
        );
        expect(completed["disposition"]).toBe("completed");
        expect(completed["evidence_integrity"]).toBe("intact");
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "copies a two-file contract into the workspace fully bundled",
    { timeout: 30000 },
    async () => {
      // The pack contract spans two files joined by a relative reference.
      // The participant copy in the workspace must resolve every reference
      // on its own and declare the same operations as the scoped compile.
      const scratch = await mkdtemp(path.join(tmpdir(), "oal-it-twofile-"));
      const packDir = await writeSmokePack(scratch);
      await writeFile(
        path.join(packDir, "contract/openapi.json"),
        `${JSON.stringify(
          {
            openapi: "3.1.0",
            info: { title: "Smoke Ping", version: "1.0.0" },
            servers: [{ url: "http://127.0.0.1:0" }],
            paths: {
              "/v1/ping": {
                get: {
                  operationId: "ping",
                  summary: "Answer with one constant status value.",
                  responses: {
                    200: {
                      description: "Constant status document.",
                      content: {
                        "application/json": {
                          schema: {
                            $ref: "components.json#/components/schemas/PingStatus"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeFile(
        path.join(packDir, "contract/components.json"),
        `${JSON.stringify(
          {
            components: {
              schemas: {
                PingStatus: {
                  type: "object",
                  additionalProperties: false,
                  required: ["status"],
                  properties: { status: { type: "string", enum: ["ok"] } }
                }
              }
            }
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      const adapter = smokeAdapter();
      const harness = await prepareTrial({
        label: "oal-it-twofile-",
        packDir,
        evalId: "smoke",
        batchId: "it-two-file-contract",
        adapter
      });
      try {
        // The frozen plan carries both documents of the contract set.
        expect(
          harness.plan.contract.documents["contract/components.json"]
        ).toBeDefined();
        expect(
          harness.plan.contract.documents["contract/openapi.json"]
        ).toBeDefined();

        const outcome = await runTrial({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          index: 0,
          exposure: createLoopbackExposure,
          now: fixedClock()
        });
        expect(outcome.disposition).toBe("completed");
        expect(outcome.reportStatus).toBe("valid");
        expect(outcome.apiRequests).toBe(1);

        const root = trialRootOf(harness.plan.batchId, outcome.runId);
        const copyText = await harness.store.read(
          `${root}/workspace/openapi.json`
        );
        const copy = JSON.parse(copyText) as Json;

        // Every reference in the copy is internal and resolves, and the
        // sibling document never lands in the workspace.
        const refs = collectRefs(copy);
        expect(refs).toEqual(["#/components/schemas/PingStatus"]);
        expect(refPointerExists(copy, refs[0] ?? "")).toBe(true);
        expect(
          await harness.store.exists(`${root}/workspace/components.json`)
        ).toBe(false);
        const schemas = (
          copy as { components?: { schemas?: Record<string, unknown> } }
        ).components?.schemas;
        expect(Object.keys(schemas ?? {})).toEqual(["PingStatus"]);

        // The copy compiles alone, with the operation set of the scoped
        // contract IR the trial itself ran.
        const alone = compileOpenApi({
          documents: { "openapi.json": copyText },
          entrypoint: "openapi.json"
        });
        expect(alone.contract.operations.map((item) => item.key)).toEqual(
          harness.plan.contract.ir.operations.map((item) => item.key)
        );
        expect(
          alone.contract.operations.map((item) => item.operation_id)
        ).toEqual(["ping"]);

        // The one exchange the participant made still matched and served.
        const trace = await readTraceEvents(harness.store, root);
        expect(trace.length).toBe(1);
        expect(trace[0]?.response?.status).toBe(200);
      } finally {
        await harness.clean();
      }
    }
  );
});

/** Replace the loopback port in trace text. */
function normalizePort(text: string): string {
  return text.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:PORT");
}

/** Every `$ref` value in the document, in traversal order. */
function collectRefs(value: Json, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (value === null || typeof value !== "object") {
    return refs;
  }
  const ref = (value as Record<string, Json>)["$ref"];
  if (typeof ref === "string") {
    refs.push(ref);
  }
  for (const item of Object.values(value)) {
    collectRefs(item, refs);
  }
  return refs;
}

/** True when one internal reference resolves inside the document. */
function refPointerExists(document: Json, ref: string): boolean {
  let current: Json = document;
  for (const token of ref.slice(2).split("/")) {
    if (Array.isArray(current)) {
      const next = current[Number(token)];
      if (next === undefined) {
        return false;
      }
      current = next;
      continue;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    const next = (current as Record<string, Json | undefined>)[token];
    if (next === undefined) {
      return false;
    }
    current = next;
  }
  return true;
}
