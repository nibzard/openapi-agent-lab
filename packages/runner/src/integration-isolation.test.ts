/**
 * Gate 8 of specification section 36.1: isolation.
 *
 * One batch runs four trials with a parallel bound of two through the real
 * loopback exposure. The trials must share nothing a participant could
 * observe: no shared server port, no reused credential, no shared
 * workspace or control tree, and no evidence that names another run.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { mintRunCredentials, type RunCredentials } from "@oal/gateway";

import { runBatch } from "./index.ts";
import {
  ExposureRecorder,
  fixedClock,
  parseJsonl,
  prepareTrial,
  readJsonObject,
  steelAdapter,
  steelPackRoot,
  trialRootOf
} from "./integration-fixtures.ts";

/** Trials of the isolation batch. */
const COUNT = 4;

/** Parallel bound of the isolation batch. */
const PARALLEL = 2;

/** Every secret value one trial mints. */
function tokensOf(credentials: RunCredentials): readonly string[] {
  return [
    ...Object.values(credentials.apiKeys),
    credentials.basic.username,
    credentials.basic.password,
    credentials.bearer
  ].filter((token) => token.length > 0);
}

/** Read one JSON field that must hold a string. */
function stringField(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("The field is not a string.");
  }
  return value;
}

/** Every file below one directory, relative to that directory. */
async function filesBelow(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(
        ...(await filesBelow(join(root, entry.name), `${prefix}${entry.name}/`))
      );
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

describe("runner integration: isolation of parallel trials", () => {
  it(
    "shares no port, credential, workspace, or evidence between trials",
    { timeout: 120000 },
    async () => {
      const adapter = steelAdapter("basic-lifecycle");
      const harness = await prepareTrial({
        label: "oal-it-iso-",
        packDir: steelPackRoot(),
        evalId: "basic-lifecycle",
        batchId: "it-isolation",
        adapter,
        count: COUNT,
        parallel: PARALLEL,
        limitOverrides: {
          maxBatchTrials: COUNT,
          maxParallelTrials: PARALLEL
        }
      });
      const recorder = new ExposureRecorder();
      try {
        const batch = await runBatch({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          now: fixedClock(),
          exposure: recorder.factory
        });

        // Every trial finished clean.
        expect(batch.count).toBe(COUNT);
        expect(batch.parallel).toBe(PARALLEL);
        expect(batch.aborted).toBe(false);
        expect(batch.defectCode).toBeNull();
        expect(batch.notStartedRunIds).toEqual([]);
        expect(batch.outcomes.length).toBe(COUNT);
        for (const outcome of batch.outcomes) {
          expect(outcome.disposition).toBe("completed");
          expect(outcome.evidenceIntegrity).toBe("intact");
          expect(outcome.apiRequests).toBe(4);
        }
        const runIds = harness.plan.trialRunIds;
        expect(batch.outcomes.map((outcome) => outcome.runId)).toEqual([
          ...runIds
        ]);

        // The batch finalized its own evidence, and the completion
        // pointer verifies every leaf under the batch scope.
        const batchRoot = `runs/${harness.plan.batchId}`;
        for (const artifact of [
          "batch.json",
          "assignment-events.jsonl",
          "cohort-evaluation.json",
          "artifact-manifest.json",
          "batch.completed.json"
        ]) {
          expect(await harness.store.exists(`${batchRoot}/${artifact}`)).toBe(
            true
          );
        }
        const verification = await harness.store.verify(
          `${batchRoot}/batch.completed.json`
        );
        expect(verification.problems).toEqual([]);
        expect(verification.ok).toBe(true);

        // Ports: one distinct loopback port per trial.
        const ports = recorder.ports();
        expect(ports.length).toBe(COUNT);
        expect(new Set(ports).size).toBe(COUNT);
        for (const port of ports) {
          expect(port).toBeGreaterThan(0);
        }

        // Concurrency: trials overlapped, and never exceeded the bound.
        expect(recorder.peakConcurrency()).toBe(PARALLEL);

        // Credentials: every trial seed mints its own token set.
        expect(new Set(harness.plan.trialSeeds).size).toBe(COUNT);
        const tokenSets = harness.plan.trialSeeds.map((seed) =>
          tokensOf(mintRunCredentials(harness.plan.contract.ir, seed))
        );
        for (const set of tokenSets) {
          expect(set.length).toBeGreaterThan(0);
        }
        const seen = new Set<string>();
        for (const set of tokenSets) {
          for (const token of set) {
            expect(seen.has(token)).toBe(false);
            seen.add(token);
          }
        }

        // Evidence: no minted secret appears anywhere under the batch.
        const evidenceRoot = harness.store.resolve(batchRoot);
        const evidenceFiles = await filesBelow(evidenceRoot);
        expect(evidenceFiles.length).toBeGreaterThan(COUNT);
        for (const relative of evidenceFiles) {
          const text = await readFile(join(evidenceRoot, relative), "utf8");
          for (const token of seen) {
            expect(text.includes(token)).toBe(false);
          }
        }

        // Per trial: separate server record, control tree, and streams.
        const recorded = new Map(
          recorder.exposures().map((record) => [record.runId, record.baseUrl])
        );
        const baseUrls = new Set<string>();
        const controlUrls = new Set<string>();
        for (const runId of runIds) {
          const root = trialRootOf(harness.plan.batchId, runId);

          const server = await readJsonObject(
            harness.store,
            `${root}/server.json`
          );
          expect(server["run_id"]).toBe(runId);
          expect(recorded.get(runId)).toBe(server["base_url"]);
          baseUrls.add(stringField(server["base_url"]));

          // The private control tree holds this run's credentials only,
          // and they point at this run's exposure.
          const credentials = await readJsonObject(
            harness.store,
            `control/${harness.plan.batchId}/${runId}/credentials.json`
          );
          expect(credentials["run_id"]).toBe(runId);
          expect(credentials["base_url"]).toBe(server["base_url"]);
          controlUrls.add(stringField(credentials["base_url"]));

          // The logical streams name exactly this run.
          const trace = parseJsonl(
            await harness.store.read(`${root}/trace.jsonl`)
          );
          expect(trace.length).toBe(4);
          for (const event of trace) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
              expect(event).toHaveProperty("batch_id", harness.plan.batchId);
            }
          }
          const session = parseJsonl(
            await harness.store.read(`${root}/session/events.redacted.jsonl`)
          );
          expect(session.length).toBeGreaterThan(0);
          for (const event of session) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
            }
          }
          const ledger = parseJsonl(
            await harness.store.read(`${root}/lifecycle.jsonl`)
          );
          for (const event of ledger) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
            }
          }

          // State stays per run.
          const state = await readJsonObject(
            harness.store,
            `${root}/state.final.json`
          );
          expect(state["run_id"]).toBe(runId);
          expect(state["state"]).toEqual({});
        }
        expect(baseUrls.size).toBe(COUNT);
        expect(controlUrls.size).toBe(COUNT);
      } finally {
        await harness.clean();
      }
    }
  );
});
