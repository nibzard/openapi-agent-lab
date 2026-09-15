/**
 * Evaluator integration against the shipped Steel Computer pack.
 *
 * The suite loads all three real rubrics without `@oal/testkit`, evaluates
 * a passing and a failing trace for each, and checks determinism of the
 * evaluation document. The rubric digests pin the rebuilt loading path to
 * the bytes the pack loader produces.
 *
 * Note on the Arazzo compiler: `@oal/arazzo` is not a dependency of
 * `@oal/evaluator`, so no arazzo integration suite exists in this
 * package.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalJsonSha256,
  type Json,
  type JsonObject
} from "@oal/core";
import type { TraceEvent } from "@oal/evidence";

import { evaluateRubric, toEvaluation } from "./evaluate.ts";
import type { EvaluationResult } from "./evaluate.ts";
import type { Rubric } from "./rubric.ts";
import {
  OBSERVED_AT,
  SESSION_ID,
  STEEL_EVAL_IDS,
  STEEL_REPORTS,
  createSession,
  downloadFile,
  jsonBody,
  readSession,
  readSteelJson,
  releaseSession,
  steelRubric,
  uploadFile,
  type SteelEvalId
} from "./integration-fixtures.ts";

/** Digest of one clean seed file. */
const CLEAN_SHA =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

/** Digest of the overwritten file. It differs from the seed digest. */
const CHANGED_SHA =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

/** Run metadata every evaluation in this suite sees. */
const RUN: JsonObject = {
  run_id: "eval-integration-run-01",
  batch_id: "eval-integration",
  eval_id: "steel"
};

/** Total weight of one Steel rubric. */
function totalWeightOf(rubric: Rubric): number {
  return rubric.checks.reduce((sum, check) => sum + check.weight, 0);
}

/** Evaluate one trace against one Steel rubric. */
async function evaluate(
  rubric: Rubric,
  evalId: SteelEvalId,
  events: readonly TraceEvent[]
): Promise<EvaluationResult> {
  return evaluateRubric({
    rubric,
    runId: "eval-integration-run-01",
    run: RUN,
    events: [...events],
    state: {},
    report: STEEL_REPORTS[evalId],
    resolveSchema: (reference: string): Json | undefined => {
      try {
        return readSteelJson(reference);
      } catch {
        return undefined;
      }
    }
  });
}

/** The passing trace of one Steel eval. */
function passingTrace(evalId: SteelEvalId): readonly TraceEvent[] {
  if (evalId === "basic-lifecycle") {
    return [
      createSession(1),
      readSession(2, "live"),
      releaseSession(3),
      readSession(4, "released")
    ];
  }
  if (evalId === "documentation-discovery") {
    return [createSession(1)];
  }
  return [
    createSession(1),
    uploadFile(2, "brief.txt"),
    downloadFile(3, "brief.txt", CLEAN_SHA),
    uploadFile(4, "draft.txt"),
    downloadFile(5, "draft.txt", CHANGED_SHA),
    uploadFile(6, "brief.txt"),
    downloadFile(7, "brief.txt", CLEAN_SHA),
    releaseSession(8),
    readSession(9, "released")
  ];
}

/** One exchange that hit no declared route. */
function unmatchedProbe(sequence: number): TraceEvent {
  const base = createSession(sequence, 404);
  return {
    ...base,
    operation: {
      matched: false,
      key: null,
      uid: null,
      operation_id: null,
      method: "POST",
      path_template: null,
      support: null
    },
    response: {
      completed_at: OBSERVED_AT,
      status: 404,
      headers: [],
      content_type: "application/json",
      body: jsonBody({ error: "not_found" })
    }
  };
}

/** The eval ids in an order that differs from the shipped order. */
function shuffledEvalIds(): readonly SteelEvalId[] {
  return ["documentation-discovery", "checkpoint-recovery", "basic-lifecycle"];
}

describe("evaluator integration: steel computer rubrics", () => {
  it("loads every shipped rubric with the repository schema", async () => {
    for (const evalId of STEEL_EVAL_IDS) {
      const rubric = await steelRubric(evalId);
      expect(rubric.id).toBe(`steel-${evalId}`);
      expect(rubric.scoring.method).toBe("weighted_binary");
      expect(rubric.checks.length).toBeGreaterThan(0);
      expect(rubric.signals.length).toBeGreaterThan(0);
      expect(totalWeightOf(rubric)).toBeGreaterThan(0);
    }
  });

  it("loads the rubrics to the digests the runner freezes", async () => {
    // The digests equal the rubric_sha256 of a real loopback trial, so
    // this suite and the runner agree on the same rubric bytes.
    const expected: Readonly<Record<SteelEvalId, string>> = {
      "checkpoint-recovery":
        "00b9237d010083bb5f25efb496b4dd36099c7414475944311f55fafecdc9e28f",
      "basic-lifecycle":
        "993896d94572a1860738f155774bf6fb8e9b7c0e6cf690068a2d88ec36906e74",
      "documentation-discovery":
        "01af41d4a579a268384e11fa979bfe8b1814b525dad727deb4c2ab08b1624db8"
    };
    for (const evalId of STEEL_EVAL_IDS) {
      const rubric = await steelRubric(evalId);
      expect(canonicalJsonSha256(rubric as unknown as Json)).toBe(
        expected[evalId]
      );
    }
  });

  it("passes every rubric on its passing trace", async () => {
    const totals: Readonly<Record<SteelEvalId, number>> = {
      "checkpoint-recovery": 12,
      "basic-lifecycle": 9,
      "documentation-discovery": 10
    };
    for (const evalId of STEEL_EVAL_IDS) {
      const rubric = await steelRubric(evalId);
      const result = await evaluate(rubric, evalId, passingTrace(evalId));

      expect(result.rubricId).toBe(`steel-${evalId}`);
      expect(result.status).toBe("passed");
      expect(result.score).toBe(1);
      expect(result.passedWeight).toBe(totals[evalId]);
      expect(result.totalWeight).toBe(totals[evalId]);
      expect(result.infrastructureErrors).toEqual([]);
      expect(
        result.checks.map((check) => `${check.id}:${check.status}`)
      ).toEqual(rubric.checks.map((check) => `${check.id}:passed`));

      // The report schema resolves against the pack. In the runner the
      // participant-file copy shadows the schema copy, so the same check
      // errors there; see the trial integration suite.
      const report = result.checks.find(
        (check) => check.id === "result_report"
      );
      expect(report?.status).toBe("passed");

      expect(result.signals).toEqual({
        first_call_is_create: true,
        first_call_matched: true
      });

      // The sequence rubrics evaluated their postcondition and it held.
      const flow = result.checks.find((check) => check.kind === "sequence");
      if (flow !== undefined) {
        expect(flow.postconditions[0]?.status).toBe("passed");
      }
    }
  });

  it("fails the checkpoint-recovery rubric when the recovery step is missing", async () => {
    const rubric = await steelRubric("checkpoint-recovery");
    // The participant never restores the seed bytes: the restore upload
    // and the recovered read are gone, so the flow stops after the
    // changed read.
    const events = [
      createSession(1),
      uploadFile(2, "brief.txt"),
      downloadFile(3, "brief.txt", CLEAN_SHA),
      uploadFile(4, "draft.txt"),
      downloadFile(5, "draft.txt", CHANGED_SHA),
      releaseSession(6),
      readSession(7, "released")
    ];
    const result = await evaluate(rubric, "checkpoint-recovery", events);

    expect(result.status).toBe("failed");
    expect(result.score).toBe(4 / 12);
    expect(result.passedWeight).toBe(4);
    expect(result.totalWeight).toBe(12);
    const flow = result.checks.find((check) => check.id === "recovery_flow");
    expect(flow?.status).toBe("failed");
    expect(flow?.failedPointers).toEqual(["steps/restore_seed"]);
    for (const id of [
      "result_report",
      "single_create",
      "saved_state_reported_unsupported",
      "no_unmatched_requests"
    ]) {
      const check = result.checks.find((entry) => entry.id === id);
      expect(check?.status).toBe("passed");
    }
  });

  it("fails the basic-lifecycle rubric when the live read is missing", async () => {
    const rubric = await steelRubric("basic-lifecycle");
    // The participant never observes the live session.
    const events = [
      createSession(1),
      releaseSession(2),
      readSession(3, "released")
    ];
    const result = await evaluate(rubric, "basic-lifecycle", events);

    expect(result.status).toBe("failed");
    expect(result.score).toBe(3 / 9);
    expect(result.passedWeight).toBe(3);
    expect(result.totalWeight).toBe(9);
    const flow = result.checks.find((check) => check.id === "lifecycle_flow");
    expect(flow?.status).toBe("failed");
    expect(flow?.failedPointers).toEqual(["steps/live_status"]);
    // The matcher stops at the first missing step, so the postcondition
    // never runs.
    expect(flow?.postconditions).toEqual([]);
  });

  it("fails the documentation-discovery rubric on a second create", async () => {
    const rubric = await steelRubric("documentation-discovery");
    // Two session creations break the exactly-one rule.
    const events = [createSession(1), createSession(2)];
    const result = await evaluate(rubric, "documentation-discovery", events);

    expect(result.status).toBe("failed");
    expect(result.score).toBe(6 / 10);
    expect(result.passedWeight).toBe(6);
    expect(result.totalWeight).toBe(10);
    const single = result.checks.find(
      (check) => check.id === "single_create_session"
    );
    expect(single?.status).toBe("failed");
    expect(single?.message).toContain("2 of 2");
    expect(result.signals).toEqual({
      first_call_is_create: true,
      first_call_matched: true
    });
  });

  it("produces byte-identical evaluation documents for identical inputs", async () => {
    for (const evalId of shuffledEvalIds()) {
      const rubric = await steelRubric(evalId);
      const first = await evaluate(rubric, evalId, passingTrace(evalId));
      const second = await evaluate(rubric, evalId, passingTrace(evalId));
      expect(canonicalJson(toEvaluation(second) as unknown as Json)).toBe(
        canonicalJson(toEvaluation(first) as unknown as Json)
      );
      expect(second.rubricSha256).toBe(first.rubricSha256);
    }
  });

  it("marks unmatched requests and captures the session identifier", async () => {
    // One undeclared route fails the universal check, while the ordered
    // flow still matches: the probe sits after the released read.
    const rubric = await steelRubric("checkpoint-recovery");
    const events = [
      createSession(1),
      uploadFile(2, "brief.txt"),
      downloadFile(3, "brief.txt", CLEAN_SHA),
      uploadFile(4, "draft.txt"),
      downloadFile(5, "draft.txt", CHANGED_SHA),
      uploadFile(6, "brief.txt"),
      downloadFile(7, "brief.txt", CLEAN_SHA),
      releaseSession(8),
      readSession(9, "released"),
      unmatchedProbe(10)
    ];
    const result = await evaluate(rubric, "checkpoint-recovery", events);
    expect(result.status).toBe("failed");
    expect(result.passedWeight).toBe(11);
    expect(result.totalWeight).toBe(12);

    const universal = result.checks.find(
      (check) => check.id === "no_unmatched_requests"
    );
    expect(universal?.status).toBe("failed");
    // The evidence list names the nine matched requests; the unmatched
    // probe stays out of it.
    expect(universal?.eventIds.length).toBe(9);
    expect(universal?.eventIds).not.toContain("req_00000010");

    const flow = result.checks.find((check) => check.id === "recovery_flow");
    expect(flow?.status).toBe("passed");
    expect(flow?.captures["session_id"]).toBe(SESSION_ID);
  });
});
