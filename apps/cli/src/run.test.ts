import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  diagnostic,
  EXIT_EVAL_THRESHOLD,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED
} from "@oal/core";
import type { BatchOutcome, TrialOutcome } from "@oal/runner";

import { main } from "./cli.ts";
import { MemoryIo } from "./io.ts";
import {
  defaultBatchId,
  exitCodeOfBatch,
  exitCodeOfFindings,
  parseDurationMs,
  selectAdapter,
  RunCliCode
} from "./handlers/run.ts";
import { loadSteelPack } from "../../../packages/testkit/src/index.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-run-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

async function exists(target: string): Promise<boolean> {
  const stats = await stat(target).catch(() => null);
  return stats !== null;
}

/** One terminal trial outcome with every field a mapping test needs. */
function trial(
  disposition: TrialOutcome["disposition"],
  overrides: Partial<TrialOutcome> = {}
): TrialOutcome {
  return {
    runId: "run_x",
    batchId: "b-test",
    index: 0,
    disposition,
    reasonCode: "OAL-RUN-DISPOSITION-COMPLETED",
    censorClass: "none",
    censorReasonCode: "",
    evidenceIntegrity: "intact",
    controlStarted: true,
    spawned: true,
    turnCompleted: true,
    reportStatus: "valid",
    reportSha256: null,
    evaluation: {
      status: "passed",
      score: 1,
      passedWeight: 1,
      totalWeight: 1,
      valid: true
    },
    usageObserved: true,
    apiRequests: 1,
    agentToolCalls: 1,
    exit: { code: 0, signal: null },
    startedAtMs: 0,
    finishedAtMs: 1,
    ...overrides
  };
}

function batch(
  outcomes: readonly TrialOutcome[],
  overrides: Partial<BatchOutcome> = {}
): BatchOutcome {
  return {
    batchId: "b-test",
    count: outcomes.length,
    parallel: 1,
    outcomes,
    notStartedRunIds: [],
    cohort: null,
    manifestSha256: "",
    aborted: false,
    defectCode: null,
    defectMessage: null,
    ...overrides
  };
}

describe("parseDurationMs", () => {
  it("parses every documented unit", () => {
    expect(parseDurationMs("500")).toBe(500);
    expect(parseDurationMs("2ms")).toBe(2);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("10m")).toBe(600_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });

  it("rejects malformed durations", () => {
    expect(parseDurationMs("soon")).toBe(null);
    expect(parseDurationMs("10x")).toBe(null);
    expect(parseDurationMs("-5s")).toBe(null);
    expect(parseDurationMs("")).toBe(null);
  });
});

describe("defaultBatchId", () => {
  it("derives a sortable identifier from one instant", () => {
    const at = new Date(Date.UTC(2026, 7, 27, 1, 2, 3, 4));
    expect(defaultBatchId(at)).toBe("batch-20260827-010203-004");
  });
});

describe("selectAdapter", () => {
  it("defaults to the in-process mock adapter", () => {
    const selection = selectAdapter(undefined);
    expect("error" in selection).toBe(false);
    if (!("error" in selection)) {
      expect(selection.paid).toBe(false);
      expect(selection.adapter.id).toBe("mock-agent");
    }
  });

  it("maps codex-cli to a paid adapter", () => {
    const selection = selectAdapter("codex-cli");
    expect("error" in selection).toBe(false);
    if (!("error" in selection)) {
      expect(selection.paid).toBe(true);
    }
  });

  it("refuses an unknown selector with a diagnostic", () => {
    const selection = selectAdapter("bogus-agent");
    expect("error" in selection).toBe(true);
    if ("error" in selection) {
      expect(selection.error.code).toBe(RunCliCode.AgentUnsupported);
    }
  });
});

describe("exitCodeOfFindings", () => {
  it("maps an unsupported exposure to 4", () => {
    expect(
      exitCodeOfFindings([
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: "OAL-RUN-PREFLIGHT-EXPOSURE-INCOMPATIBLE",
          message: "No MCP."
        })
      ])
    ).toBe(EXIT_UNSUPPORTED);
  });

  it("maps any other error to 2", () => {
    expect(
      exitCodeOfFindings([
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: "OAL-RUN-EVAL-UNKNOWN",
          message: "No such eval."
        })
      ])
    ).toBe(EXIT_INVALID);
  });

  it("ignores warnings", () => {
    expect(
      exitCodeOfFindings([
        diagnostic({
          severity: "warning",
          phase: "preflight",
          code: "OAL-RUN-PREFLIGHT-EXPOSURE-INCOMPATIBLE",
          message: "Falls back."
        })
      ])
    ).toBe(EXIT_INVALID);
  });
});

describe("exitCodeOfBatch", () => {
  it("returns 0 for a clean completed batch", () => {
    expect(exitCodeOfBatch(batch([trial("completed")]), false)).toBe(EXIT_OK);
  });

  it("maps infrastructure dispositions and defects to 3", () => {
    for (const disposition of ["timed_out", "harness_aborted"] as const) {
      expect(exitCodeOfBatch(batch([trial(disposition)]), false)).toBe(
        EXIT_INFRASTRUCTURE
      );
    }
    expect(
      exitCodeOfBatch(
        batch([trial("completed")], { defectCode: "OAL-X" }),
        false
      )
    ).toBe(EXIT_INFRASTRUCTURE);
    expect(
      exitCodeOfBatch(batch([], { notStartedRunIds: ["run_missing"] }), false)
    ).toBe(EXIT_INFRASTRUCTURE);
  });

  it("maps invalid setup to 2", () => {
    expect(exitCodeOfBatch(batch([trial("invalid_setup")]), false)).toBe(
      EXIT_INVALID
    );
  });

  it("maps a failed evaluation to 5 unless the operator opted out", () => {
    const failed = trial("completed", {
      evaluation: {
        status: "failed",
        score: 0,
        passedWeight: 0,
        totalWeight: 1,
        valid: true
      }
    });
    expect(exitCodeOfBatch(batch([failed]), false)).toBe(EXIT_EVAL_THRESHOLD);
    expect(exitCodeOfBatch(batch([failed]), true)).toBe(EXIT_OK);
  });

  it("ignores an evaluation that never ran", () => {
    const absent = trial("agent_incomplete", { evaluation: null });
    expect(exitCodeOfBatch(batch([absent]), false)).toBe(EXIT_OK);
  });

  it("ignores an evaluation that errored for missing evidence", () => {
    const errored = trial("agent_incomplete", {
      evaluation: {
        status: "error",
        score: 0,
        passedWeight: 0,
        totalWeight: 1,
        valid: true
      }
    });
    expect(exitCodeOfBatch(batch([errored]), false)).toBe(EXIT_OK);
  });
});

describe("oal run", () => {
  it("refuses to run without --eval", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["run", "packs/steel-computer"], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks.join("\n")).toContain(RunCliCode.EvalMissing);
  });

  it("refuses a malformed --timeout", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        "packs/steel-computer",
        "--eval",
        "basic-lifecycle",
        "--timeout",
        "soon"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks.join("\n")).toContain(
      "OAL-CLI-INVALID-OPTION-VALUE"
    );
  });

  it("refuses an unknown agent selector", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        "packs/steel-computer",
        "--eval",
        "basic-lifecycle",
        "--agent",
        "bogus"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrChunks.join("\n")).toContain(RunCliCode.AgentUnsupported);
  });

  it("refuses --profile in this build", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        "packs/steel-computer",
        "--eval",
        "basic-lifecycle",
        "--profile",
        "p.yaml"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrChunks.join("\n")).toContain(RunCliCode.ProfileUnsupported);
  });

  it("maps --data-plane-scope eval to the task treatment", async () => {
    const pack = await loadSteelPack();
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        pack.root,
        "--eval",
        "basic-lifecycle",
        "--batch",
        "cli-scope",
        "--data-plane-scope",
        "eval",
        "--format",
        "json",
        "--dry-run"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const plan = JSON.parse(io.stdoutChunks.join("\n")) as Record<
      string,
      unknown
    >;
    expect(plan.treatment).toMatchObject({ data_plane_scope: "task" });
  });

  it("prints a dry-run plan and writes nothing", async () => {
    const pack = await loadSteelPack();
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        pack.root,
        "--eval",
        "basic-lifecycle",
        "--batch",
        "cli-dry",
        "--format",
        "json",
        "--dry-run"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const plan = JSON.parse(io.stdoutChunks.join("\n")) as Record<
      string,
      unknown
    >;
    expect(plan.kind).toBe("RunDryRun");
    expect(plan.dry_run).toBe(true);
    expect(plan.batch_id).toBe("cli-dry");
    const planned = plan.plan as Record<string, unknown>;
    expect(planned.count).toBe(1);
    expect(await exists(path.join(cwd, ".oal", "runs"))).toBe(false);
  });

  it("runs one trial end to end with the default mock agent", async () => {
    const pack = await loadSteelPack();
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        pack.root,
        "--eval",
        "basic-lifecycle",
        "--batch",
        "cli-live",
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    // The unscripted mock produces no turn completion and no report, so
    // the disposition is honest and the rubric fails the missing report
    // check. The verdict is valid, so section 23.18 maps the batch to
    // the evaluation threshold exit.
    expect(code).toBe(EXIT_EVAL_THRESHOLD);
    const summary = JSON.parse(io.stdoutChunks.join("\n")) as Record<
      string,
      unknown
    >;
    expect(summary.kind).toBe("RunCompletedCli");
    expect(summary.batch_id).toBe("cli-live");
    expect(summary.exit_code).toBe(EXIT_EVAL_THRESHOLD);
    expect(summary.launched).toBe(1);
    expect(summary.dispositions).toMatchObject({ agent_incomplete: 1 });
    const runs = summary.runs as readonly Record<string, unknown>[];
    expect(runs[0]?.disposition).toBe("agent_incomplete");
    expect(runs[0]?.evaluation_status).toBe("failed");
    const batchDir = path.join(cwd, ".oal", "runs", "cli-live");
    for (const artifact of [
      "batch.json",
      "assignment-events.jsonl",
      "cohort-evaluation.json",
      "batch.completed.json"
    ]) {
      expect(await exists(path.join(batchDir, artifact))).toBe(true);
    }
  });

  it("prints a terminal summary with per-run dispositions", async () => {
    const pack = await loadSteelPack();
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        pack.root,
        "--eval",
        "basic-lifecycle",
        "--batch",
        "cli-term",
        "--no-fail-on-eval"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("batch: cli-term");
    expect(text).toContain("manifest sha256: ");
    expect(text).toContain("agent_incomplete");
    expect(text).toContain(path.join(cwd, ".oal", "runs", "cli-term"));
  });
});
