/**
 * Gate 7 of specification section 36.1: determinism.
 *
 * Two trials that start from the same seeds must produce the same
 * normalized logical trace, the same state, and the same evaluation
 * document. This file checks three forms of that rule:
 *
 * 1. Byte identity on a pinned port. When the exposure port and the
 *    clock are fixed, every artifact except the wall-clock fields of
 *    {@link VOLATILE_ARTIFACTS} repeats byte for byte.
 * 2. Normalized identity on ephemeral ports. When the port is free to
 *    differ, the normalized digests still match.
 * 3. Order independence. The same trials started in a different order
 *    produce the same artifacts per run id.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createLoopbackExposure,
  runTrial,
  type ExposureFactory
} from "./index.ts";
import {
  ExposureRecorder,
  LOGICAL_ARTIFACTS,
  TRIAL_ARTIFACTS,
  VOLATILE_ARTIFACTS,
  fixedClock,
  normalizedArtifactDigest,
  pinPort,
  prepareTrial,
  smokeAdapter,
  trialRootOf,
  writeSmokePack
} from "./integration-fixtures.ts";

/** Port both pinned runs share. The runs are sequential. */
const PINNED_PORT = 43711;

/** Artifacts that must repeat byte for byte when the port is pinned. */
const BYTE_IDENTICAL_ARTIFACTS: readonly string[] = TRIAL_ARTIFACTS.filter(
  (artifact) => !VOLATILE_ARTIFACTS.includes(artifact)
);

/** Harness type of {@link prepareTrial}. */
type Harness = Awaited<ReturnType<typeof prepareTrial>>;

/** Run trial zero of a harness and return the exposure base URLs. */
async function runFirstTrial(
  harness: Harness,
  exposure: ExposureFactory
): Promise<readonly string[]> {
  const recorder = new ExposureRecorder({ inner: exposure });
  const outcome = await runTrial({
    store: harness.store,
    plan: harness.plan,
    pack: harness.pack,
    adapter: smokeAdapter(),
    index: 0,
    exposure: recorder.factory,
    now: fixedClock()
  });
  expect(outcome.disposition).toBe("completed");
  return recorder.exposures().map((record) => record.baseUrl);
}

/** Scratch directory that holds one pack copy and one store per run. */
async function smokeScratch(label: string): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), label));
  await writeSmokePack(scratch);
  return scratch;
}

describe("runner integration: determinism of identical seeded runs", () => {
  it(
    "repeats every artifact byte for byte on a pinned port",
    { timeout: 60000 },
    async () => {
      const scratchA = await smokeScratch("oal-it-det-pin-a-");
      const scratchB = await smokeScratch("oal-it-det-pin-b-");
      const first = await prepareTrial({
        label: "oal-it-det-pin-a-",
        packDir: path.join(scratchA, "smoke-ping"),
        evalId: "smoke",
        batchId: "it-determinism-pinned",
        adapter: smokeAdapter()
      });
      const second = await prepareTrial({
        label: "oal-it-det-pin-b-",
        packDir: path.join(scratchB, "smoke-ping"),
        evalId: "smoke",
        batchId: "it-determinism-pinned",
        adapter: smokeAdapter()
      });
      try {
        // Same batch id and same pack bytes freeze the same seeds.
        expect(second.plan.runSeed).toBe(first.plan.runSeed);
        expect(second.plan.trialSeeds).toEqual(first.plan.trialSeeds);
        expect(second.plan.trialRunIds).toEqual(first.plan.trialRunIds);

        const urlsFirst = await runFirstTrial(first, pinPort(PINNED_PORT));
        const urlsSecond = await runFirstTrial(second, pinPort(PINNED_PORT));
        expect(urlsFirst).toEqual([`http://127.0.0.1:${PINNED_PORT}`]);
        expect(urlsSecond).toEqual([`http://127.0.0.1:${PINNED_PORT}`]);

        const rootA = trialRootOf(
          first.plan.batchId,
          first.plan.trialRunIds[0] ?? ""
        );
        const rootB = trialRootOf(
          second.plan.batchId,
          second.plan.trialRunIds[0] ?? ""
        );
        expect(rootA).toBe(rootB);

        // Byte identity for everything the clock and the port control.
        for (const artifact of BYTE_IDENTICAL_ARTIFACTS) {
          const textA = await first.store.read(`${rootA}/${artifact}`);
          const textB = await second.store.read(`${rootB}/${artifact}`);
          expect(textB, artifact).toBe(textA);
        }

        // Normalized identity for the wall-clock artifacts.
        for (const artifact of VOLATILE_ARTIFACTS) {
          const digestA = await normalizedArtifactDigest(
            first.store,
            `${rootA}/${artifact}`,
            urlsFirst
          );
          const digestB = await normalizedArtifactDigest(
            second.store,
            `${rootB}/${artifact}`,
            urlsSecond
          );
          expect(digestB, artifact).toBe(digestA);
        }
      } finally {
        await first.clean();
        await second.clean();
      }
    }
  );

  it(
    "repeats the normalized logical artifacts when the port is ephemeral",
    { timeout: 60000 },
    async () => {
      const scratchA = await smokeScratch("oal-it-det-eph-a-");
      const scratchB = await smokeScratch("oal-it-det-eph-b-");
      const first = await prepareTrial({
        label: "oal-it-det-eph-a-",
        packDir: path.join(scratchA, "smoke-ping"),
        evalId: "smoke",
        batchId: "it-determinism-ephemeral",
        adapter: smokeAdapter()
      });
      const second = await prepareTrial({
        label: "oal-it-det-eph-b-",
        packDir: path.join(scratchB, "smoke-ping"),
        evalId: "smoke",
        batchId: "it-determinism-ephemeral",
        adapter: smokeAdapter()
      });
      try {
        const urlsFirst = await runFirstTrial(first, createLoopbackExposure);
        const urlsSecond = await runFirstTrial(second, createLoopbackExposure);
        expect(urlsFirst.length).toBe(1);
        expect(urlsSecond.length).toBe(1);

        const rootA = trialRootOf(
          first.plan.batchId,
          first.plan.trialRunIds[0] ?? ""
        );
        const rootB = trialRootOf(
          second.plan.batchId,
          second.plan.trialRunIds[0] ?? ""
        );

        // The logical artifacts ignore the port entirely.
        for (const artifact of LOGICAL_ARTIFACTS) {
          const digestA = await normalizedArtifactDigest(
            first.store,
            `${rootA}/${artifact}`,
            urlsFirst
          );
          const digestB = await normalizedArtifactDigest(
            second.store,
            `${rootB}/${artifact}`,
            urlsSecond
          );
          expect(digestB, artifact).toBe(digestA);
        }

        // The raw logical trace differs only in the port fields.
        const mask = (text: string): string =>
          text.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:PORT");
        const traceA = mask(await first.store.read(`${rootA}/trace.jsonl`));
        const traceB = mask(await second.store.read(`${rootB}/trace.jsonl`));
        expect(traceB).toBe(traceA);
      } finally {
        await first.clean();
        await second.clean();
      }
    }
  );

  it(
    "keeps per-run artifacts when the start order is shuffled",
    { timeout: 60000 },
    async () => {
      const scratchA = await smokeScratch("oal-it-det-ord-a-");
      const scratchB = await smokeScratch("oal-it-det-ord-b-");
      const batchId = "it-determinism-order";
      const first = await prepareTrial({
        label: "oal-it-det-ord-a-",
        packDir: path.join(scratchA, "smoke-ping"),
        evalId: "smoke",
        batchId,
        adapter: smokeAdapter(),
        count: 2,
        limitOverrides: { maxBatchTrials: 2 }
      });
      const second = await prepareTrial({
        label: "oal-it-det-ord-b-",
        packDir: path.join(scratchB, "smoke-ping"),
        evalId: "smoke",
        batchId,
        adapter: smokeAdapter(),
        count: 2,
        limitOverrides: { maxBatchTrials: 2 }
      });
      try {
        expect(first.plan.trialRunIds.length).toBe(2);
        const runIds = first.plan.trialRunIds;
        expect(second.plan.trialSeeds).toEqual(first.plan.trialSeeds);

        // Store A starts the second trial first; store B runs in order.
        const order: readonly (readonly [
          Awaited<ReturnType<typeof prepareTrial>>,
          readonly number[]
        ])[] = [
          [first, [1, 0]],
          [second, [0, 1]]
        ];
        const baseUrls = new Map<string, readonly string[]>();
        for (const [harness, indices] of order) {
          for (const index of indices) {
            const recorder = new ExposureRecorder();
            const outcome = await runTrial({
              store: harness.store,
              plan: harness.plan,
              pack: harness.pack,
              adapter: smokeAdapter(),
              index,
              exposure: recorder.factory,
              now: fixedClock()
            });
            expect(outcome.disposition).toBe("completed");
            baseUrls.set(
              outcome.runId,
              recorder.exposures().map((record) => record.baseUrl)
            );
          }
        }

        for (const runId of runIds) {
          const root = trialRootOf(batchId, runId);
          for (const artifact of LOGICAL_ARTIFACTS) {
            const digestA = await normalizedArtifactDigest(
              first.store,
              `${root}/${artifact}`,
              baseUrls.get(runId) ?? []
            );
            const digestB = await normalizedArtifactDigest(
              second.store,
              `${root}/${artifact}`,
              baseUrls.get(runId) ?? []
            );
            expect(digestB, `${runId}/${artifact}`).toBe(digestA);
          }
        }
      } finally {
        await first.clean();
        await second.clean();
      }
    }
  );
});
