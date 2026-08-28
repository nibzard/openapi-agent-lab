/**
 * Default-exposure fixture wiring (review finding R01). A batch that
 * injects no exposure must still hand the loaded pack's response
 * fixtures to the gateway, so a scripted participant reads the recorded
 * Steel session list instead of a generated value.
 */

import { describe, expect, it } from "vitest";

import { MockAgentAdapter } from "@oal/mock-adapter";

import {
  prepareTrial,
  readTraceEvents,
  steelPackRoot,
  trialRootOf
} from "./integration-fixtures.ts";
import { runBatch } from "./run.ts";
import { packResponseFixtures } from "./types.ts";

/** One fixed instant, so every artifact the batch writes is stable. */
const NOW = (): number => 1_700_000_000_000;

/** The report the basic-lifecycle result schema accepts. */
const REPORT = JSON.stringify({
  session_created: true,
  session_released: true,
  final_status: "released"
});

describe("runBatch default exposure", () => {
  it(
    "serves the pack response fixtures through the default exposure",
    { timeout: 30_000 },
    async () => {
      const adapter = new MockAgentAdapter({
        model: "mock-model-1",
        requests: [{ path: "/v1/sessions", method: "GET" }],
        events: [{ channel: "stdout", kind: "turn.completed", text: "done" }],
        finalText: REPORT
      });
      const harness = await prepareTrial({
        label: "oal-run-fixtures-",
        packDir: steelPackRoot(),
        evalId: "basic-lifecycle",
        batchId: "it-run-default-fixtures",
        adapter
      });
      try {
        const declared = packResponseFixtures(harness.pack);
        expect(declared.map((fixture) => fixture.id)).toContain(
          "sessions-list-empty"
        );

        const outcome = await runBatch({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          now: NOW
        });
        expect(outcome.defectCode).toBe(null);
        expect(outcome.outcomes).toHaveLength(1);
        const trial = outcome.outcomes[0];
        if (trial === undefined) {
          throw new Error("The batch must launch its only trial.");
        }
        expect(trial.apiRequests).toBe(1);

        const events = await readTraceEvents(
          harness.store,
          trialRootOf(harness.plan.batchId, trial.runId)
        );
        expect(events).toHaveLength(1);
        const exchange = events[0] as unknown as {
          readonly backend: { readonly response_provenance: string };
          readonly response: {
            readonly body: { readonly value: unknown };
          };
        };
        expect(exchange.backend.response_provenance).toBe("fixture");
        expect(exchange.response.body.value).toEqual({
          sessions: [],
          nextCursor: "",
          totalCount: 0
        });
      } finally {
        await harness.clean();
      }
    }
  );
});
