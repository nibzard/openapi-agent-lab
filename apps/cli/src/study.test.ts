import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  sha256Hex
} from "@oal/core";
import {
  appendAssignmentEvent,
  buildStudyRunHeader,
  createAssignmentLedger,
  serializeAssignmentLedger,
  serializeAssignmentSchedule,
  type AssignmentSchedule
} from "@oal/scheduler";
import { protocolLockSha256 } from "@oal/study-ir";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "./cli.ts";
import { buildStudySchedule } from "./handlers/study-schedule.ts";
import { loadStudy, readLock, resolvePackRef } from "./handlers/study-tree.ts";
import { AnalyzeCode } from "./handlers/study-analyze.ts";
import { InitCode } from "./handlers/study-init.ts";
import { ScheduleCode } from "./handlers/study-schedule.ts";
import { StudyCliCode } from "./handlers/study-tree.ts";
import { StudyRunCode } from "./handlers/study-run.ts";
import { MemoryIo } from "./io.ts";
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
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-study-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Scaffold one study that references the steel pack, then return paths. */
async function scaffoldedStudy(
  cwd: string,
  packRoot: string
): Promise<{ readonly io: MemoryIo; readonly root: string }> {
  const io = new MemoryIo();
  const code = await main(
    [
      "study",
      "init",
      "study",
      "--pack",
      packRoot,
      "--eval",
      "basic-lifecycle",
      "--id",
      "smoke-study",
      "--format",
      "json"
    ],
    io,
    { cwd }
  );
  expect(code).toBe(EXIT_OK);
  return { io, root: path.join(cwd, "study") };
}

async function writeLock(
  cwd: string,
  root: string,
  packRoot: string
): Promise<void> {
  const io = new MemoryIo();
  expect(
    await main(
      ["study", "validate", root, "--pack", packRoot, "--write-lock"],
      io,
      { cwd }
    )
  ).toBe(EXIT_OK);
}

describe("oal study init", () => {
  it("scaffolds a study that records the pack by identity only", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const document = await readFile(path.join(root, "study.yaml"), "utf8");
    const protocol = JSON.parse(document) as {
      evaluation: { pack: { id: string; version: string; sha256: string } };
      factors: { id: string; role: string }[];
      metrics: { primary: { id: string }[] };
      blinding: { mode: string };
    };
    expect(protocol.evaluation.pack.id).toBe("steel-computer");
    expect(protocol.evaluation.pack.version).toBe("0.1.0");
    expect(protocol.evaluation.pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document).not.toContain(steel.root);
    expect(protocol.factors[0]?.role).toBe("nuisance");
    expect(protocol.blinding.mode).toBe("none");
    for (const member of [
      "study.yaml",
      "phases/smoke.yaml",
      "profiles/smoke.yaml",
      "blinding/participant-surface.yaml",
      "analysis/plan.placeholder.md",
      "README.md"
    ]) {
      const text = await readFile(path.join(root, member), "utf8");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("sources the scaffold metric from the first rubric check", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const protocol = JSON.parse(
      await readFile(path.join(root, "study.yaml"), "utf8")
    ) as { metrics: { primary: { id: string }[] } };
    const rubric = await readFile(
      path.join(steel.root, "evals", "basic-lifecycle", "rubric.yaml"),
      "utf8"
    );
    expect(rubric).toContain(`id: ${protocol.metrics.primary[0]?.id ?? ""}`);
  });

  it("refuses a non-empty target", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const target = path.join(cwd, "study");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "keep.txt"), "x");
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "init",
        "study",
        "--pack",
        steel.root,
        "--eval",
        "basic-lifecycle"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(InitCode.TargetNotEmpty);
  });

  it("refuses an eval the pack does not declare", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["study", "init", "study", "--pack", steel.root, "--eval", "missing"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(InitCode.EvalUnknown);
  });

  it("requires a pack", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["study", "init", "study", "--eval", "basic-lifecycle"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(InitCode.PackMissing);
  });
});

describe("oal study validate", () => {
  it("validates the scaffold and reports the smoke phase", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      ["study", "validate", root, "--pack", steel.root, "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      cells: number;
      phases: { phase: string; valid: boolean; analytical: boolean }[];
      lock: { present: boolean };
    };
    expect(document.cells).toBe(2);
    expect(document.phases).toEqual([
      {
        phase: "smoke",
        member: "phases/smoke.yaml",
        valid: true,
        analytical: false,
        purpose: "smoke",
        primary_assignments: 2,
        cells: 2
      }
    ]);
    expect(document.lock.present).toBe(false);
  });

  it("fails closed on a pack that does not satisfy the PackRef", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const other = path.join(cwd, "other-pack");
    await cp(steel.root, other, { recursive: true });
    const manifest = await readFile(path.join(other, "pack.yaml"), "utf8");
    await writeFile(
      path.join(other, "pack.yaml"),
      manifest.replace("version: 0.1.0", "version: 0.2.0")
    );
    const io = new MemoryIo();
    const code = await main(["study", "validate", root, "--pack", other], io, {
      cwd
    });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(StudyCliCode.PackMismatch);
  });

  it("writes a lock, then reports drift after an edit", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const lockPath = path.join(root, "protocol.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      members: Record<string, string>;
    };
    expect(lock.members["study.yaml"]).toMatch(/^[0-9a-f]{64}$/);

    const checked = new MemoryIo();
    expect(
      await main(
        ["study", "validate", root, "--pack", steel.root, "--check-lock"],
        checked,
        {
          cwd
        }
      )
    ).toBe(EXIT_OK);

    await writeFile(
      path.join(root, "study.yaml"),
      (await readFile(path.join(root, "study.yaml"), "utf8")).replace(
        "Scaffold study.",
        "Edited study."
      )
    );
    const drifted = new MemoryIo();
    const code = await main(
      ["study", "validate", root, "--pack", steel.root, "--check-lock"],
      drifted,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(drifted.stderrText()).toContain(StudyCliCode.LockDrift);
  });

  it("check-lock fails when no lock exists", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      ["study", "validate", root, "--pack", steel.root, "--check-lock"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(StudyCliCode.LockMissing);
  });

  it("materialization reports nothing to materialize", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "validate",
        root,
        "--pack",
        steel.root,
        "--materialize-contracts",
        "variants"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    expect(io.stderrText()).toContain(StudyCliCode.NothingToMaterialize);
  });
});

describe("oal study schedule", () => {
  it("emits a deterministic schedule bound to the study run", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const run = async (): Promise<{ summary: unknown; sha: string }> => {
      const io = new MemoryIo();
      expect(
        await main(
          [
            "study",
            "schedule",
            root,
            "--pack",
            steel.root,
            "--seed",
            "seed-1",
            "--study-run",
            "sr-1",
            "--format",
            "json"
          ],
          io,
          { cwd }
        )
      ).toBe(EXIT_OK);
      const document = JSON.parse(io.stdoutChunks.join("")) as {
        summary: unknown;
        sha256: string;
      };
      return { summary: document.summary, sha: document.sha256 };
    };
    const first = await run();
    const second = await run();
    expect(first.sha).toBe(second.sha);
    expect(first.summary).toEqual({
      primary_count: 2,
      held_replacement_count: 0,
      maximum_agent_launches: 2,
      block_count: 1,
      cell_count: 2,
      analytical: false,
      purpose: "smoke"
    });
  });

  it("requires a protocol lock and a pack", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    const unlocked = new MemoryIo();
    expect(
      await main(
        [
          "study",
          "schedule",
          root,
          "--pack",
          steel.root,
          "--seed",
          "seed-1",
          "--study-run",
          "sr-1"
        ],
        unlocked,
        { cwd }
      )
    ).toBe(EXIT_INVALID);
    expect(unlocked.stderrText()).toContain(StudyCliCode.LockMissing);

    const noPack = new MemoryIo();
    expect(
      await main(
        ["study", "schedule", root, "--seed", "seed-1", "--study-run", "sr-1"],
        noPack,
        { cwd }
      )
    ).toBe(EXIT_INVALID);
    expect(noPack.stderrText()).toContain(StudyCliCode.PackMismatch);

    const noSeed = new MemoryIo();
    expect(
      await main(
        [
          "study",
          "schedule",
          root,
          "--pack",
          steel.root,
          "--study-run",
          "sr-1"
        ],
        noSeed,
        { cwd }
      )
    ).toBe(EXIT_INVALID);
    expect(noSeed.stderrText()).toContain(ScheduleCode.SeedMissing);
  });

  it("writes the candidate document once and refuses a second write", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const first = new MemoryIo();
    expect(
      await main(
        [
          "study",
          "schedule",
          root,
          "--pack",
          steel.root,
          "--seed",
          "seed-1",
          "--study-run",
          "sr-1",
          "--out",
          "assignments.json"
        ],
        first,
        { cwd }
      )
    ).toBe(EXIT_OK);
    const written = JSON.parse(
      await readFile(path.join(cwd, "assignments.json"), "utf8")
    ) as { study_run_id: string; phase_id: string; assignments: unknown[] };
    expect(written.study_run_id).toBe("sr-1");
    expect(written.phase_id).toBe("smoke");
    expect(written.assignments).toHaveLength(2);

    const second = new MemoryIo();
    expect(
      await main(
        [
          "study",
          "schedule",
          root,
          "--pack",
          steel.root,
          "--seed",
          "seed-1",
          "--study-run",
          "sr-1",
          "--out",
          "assignments.json"
        ],
        second,
        { cwd }
      )
    ).toBe(EXIT_INVALID);
    expect(second.stderrText()).toContain(StudyCliCode.TargetExists);
  });
});

describe("oal study run", () => {
  async function scheduledStudy(
    cwd: string,
    steelRoot: string
  ): Promise<{ readonly root: string; readonly schedule: string }> {
    const { root } = await scaffoldedStudy(cwd, steelRoot);
    await writeLock(cwd, root, steelRoot);
    const schedule = path.join(cwd, "assignments.json");
    const io = new MemoryIo();
    expect(
      await main(
        [
          "study",
          "schedule",
          root,
          "--pack",
          steelRoot,
          "--seed",
          "seed-1",
          "--study-run",
          "sr-1",
          "--out",
          schedule
        ],
        io,
        { cwd }
      )
    ).toBe(EXIT_OK);
    return { root, schedule };
  }

  it("dry-run validates and prints the launch plan", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root, schedule } = await scheduledStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "run",
        root,
        "--phase",
        "smoke",
        "--pack",
        steel.root,
        "--schedule",
        schedule,
        "--study-run",
        "sr-1",
        "--agent",
        "mock-agent",
        "--dry-run",
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      dry_run: boolean;
      cells: number;
      paid_call_maximum: number;
      persisted: boolean;
      bindings: { run_id: string; run_seed: string }[];
    };
    expect(document.dry_run).toBe(true);
    expect(document.cells).toBe(2);
    expect(document.paid_call_maximum).toBe(2);
    expect(document.persisted).toBe(false);
    expect(document.bindings).toHaveLength(2);
    expect(document.bindings[0]?.run_id).toMatch(/^run_[a-f0-9]+$/);
    expect(document.bindings[0]?.run_seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to launch: no scheduler-faithful executor exists", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root, schedule } = await scheduledStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "run",
        root,
        "--phase",
        "smoke",
        "--pack",
        steel.root,
        "--schedule",
        schedule,
        "--study-run",
        "sr-1",
        "--agent",
        "mock-agent",
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(StudyCliCode.NoExecutor);
    expect(io.stdoutChunks).toHaveLength(0);
  });

  it("refuses a schedule bound to another study run", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root, schedule } = await scheduledStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "run",
        root,
        "--phase",
        "smoke",
        "--pack",
        steel.root,
        "--schedule",
        schedule,
        "--study-run",
        "sr-2",
        "--agent",
        "mock-agent",
        "--dry-run"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(StudyCliCode.ScheduleMismatch);
  });

  it("refuses a schedule that no longer matches the locked protocol", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root, schedule } = await scheduledStudy(cwd, steel.root);
    const document = JSON.parse(await readFile(schedule, "utf8")) as {
      assignments: { slot: number }[];
    };
    const tampered = {
      ...document,
      assignments: document.assignments.map((entry, index) => ({
        ...entry,
        slot: index === 0 ? entry.slot + 5 : entry.slot
      }))
    };
    await writeFile(schedule, JSON.stringify(tampered));
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "run",
        root,
        "--phase",
        "smoke",
        "--pack",
        steel.root,
        "--schedule",
        schedule,
        "--study-run",
        "sr-1",
        "--agent",
        "mock-agent",
        "--dry-run"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(StudyCliCode.ScheduleMismatch);
  });

  it("refuses a run that misses a runtime-lock field", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root, schedule } = await scheduledStudy(cwd, steel.root);
    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "run",
        root,
        "--phase",
        "smoke",
        "--pack",
        steel.root,
        "--schedule",
        schedule,
        "--study-run",
        "sr-1",
        "--dry-run"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(StudyRunCode.RuntimeLockUnmet);
  });
});

describe("oal study analyze", () => {
  it("refuses a directory that is not a study run", async () => {
    const cwd = await newWorkspace();
    const target = path.join(cwd, "not-a-run");
    await mkdir(target, { recursive: true });
    const io = new MemoryIo();
    const code = await main(["study", "analyze", target], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(AnalyzeCode.NotStudyRun);
  });

  it("refuses multi-StudyRun aggregation", async () => {
    const cwd = await newWorkspace();
    const target = path.join(cwd, "not-a-run");
    await mkdir(target, { recursive: true });
    const io = new MemoryIo();
    const code = await main(
      ["study", "analyze", target, "--include-study-run", "other"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(AnalyzeCode.AggregationUnsupported);
  });

  /**
   * Assemble one StudyRun directory from engine outputs: the schedule the
   * CLI builds, child batches the runner records, a header and ledger the
   * scheduler assembles, and the frozen inputs the specification names.
   */
  async function assembleStudyRun(
    cwd: string,
    root: string,
    steelRoot: string
  ): Promise<{
    readonly runRoot: string;
    readonly schedule: AssignmentSchedule;
  }> {
    const runRoot = path.join(cwd, "study-run");
    await mkdir(path.join(runRoot, "inputs"), { recursive: true });
    const study = await loadStudy(root);
    const pack = await resolvePackRef(study, steelRoot);
    const locked = await readLock(root);
    const lockSha = locked.lock === null ? "" : protocolLockSha256(locked.lock);
    const built = await buildStudySchedule(study, pack, undefined, {
      phaseId: "smoke",
      studyRunId: "sr-1",
      seed: "seed-1",
      lockSha256: lockSha,
      effectiveContracts: {}
    });
    const schedule = built.schedule;
    if (schedule === null) {
      throw new Error(
        `schedule build failed: ${JSON.stringify(built.diagnostics)}`
      );
    }

    let ledger = createAssignmentLedger("sr-1");
    for (const [index, assignment] of schedule.assignments.entries()) {
      const recorded = new MemoryIo();
      expect(
        await main(
          [
            "run",
            steelRoot,
            "--eval",
            "basic-lifecycle",
            "--batch",
            assignment.child_batch_id,
            "--no-fail-on-eval"
          ],
          recorded,
          { cwd: runRoot }
        )
      ).toBe(EXIT_OK);
      const moved = path.join(runRoot, "batches", assignment.child_batch_id);
      await mkdir(path.dirname(moved), { recursive: true });
      await cp(
        path.join(runRoot, ".oal", "runs", assignment.child_batch_id),
        moved,
        { recursive: true }
      );
      const runId = `run_${(index + 1).toString(16).padStart(24, "0")}`;
      for (const draft of [
        { kind: "planned" as const, run_id: undefined },
        { kind: "launched" as const, run_id: runId },
        {
          kind: "terminal" as const,
          run_id: runId,
          disposition: "completed" as const,
          evidence_integrity: "intact" as const
        }
      ]) {
        const appended = appendAssignmentEvent(ledger, schedule, {
          study_run_id: "sr-1",
          recorded_at: "2026-08-27T12:00:00.000Z",
          assignment_id: assignment.assignment_id,
          batch_id: assignment.child_batch_id,
          kind: draft.kind,
          launch_order: draft.kind === "launched" ? index : undefined,
          run_id: draft.run_id,
          ...(draft.kind === "terminal"
            ? { disposition: draft.disposition }
            : {}),
          ...(draft.kind === "terminal"
            ? { evidence_integrity: draft.evidence_integrity }
            : {})
        });
        expect(appended.event).not.toBeNull();
        ledger = appended.ledger;
      }
    }

    const phaseText = await readFile(
      path.join(root, "phases", "smoke.yaml"),
      "utf8"
    );
    const header = buildStudyRunHeader({
      study_run_id: "sr-1",
      created_at: "2026-08-27T12:00:00.000Z",
      protocol: {
        id: study.protocol.metadata.id,
        version: study.protocol.metadata.version,
        protocol_lock_sha256: lockSha
      },
      phase: {
        id: "smoke",
        kind: "smoke",
        analytical: false,
        phase_plan_sha256: built.phasePlanSha256,
        phase_lock_sha256: sha256Hex("fixture phase lock")
      },
      schedule,
      study_compatibility_sha256: sha256Hex("fixture study key"),
      implementation_sha256: sha256Hex("fixture implementation"),
      analysis_plan_sha256: sha256Hex("fixture analysis plan"),
      cells: schedule.assignments.map((assignment) => ({
        cell_id: assignment.cell_id,
        factor_levels: { ...assignment.factor_levels },
        cell_compatibility_sha256: sha256Hex(
          `fixture cell ${assignment.cell_id}`
        )
      }))
    });
    expect(header.header).not.toBeNull();
    if (header.header === null) {
      throw new Error("header assembly failed");
    }
    await writeFile(
      path.join(runRoot, "study-run.json"),
      `${JSON.stringify(header.header)}\n`
    );
    await writeFile(
      path.join(runRoot, "assignment-events.jsonl"),
      serializeAssignmentLedger(ledger)
    );
    await cp(
      path.join(root, "study.yaml"),
      path.join(runRoot, "inputs", "study-protocol.frozen.yaml")
    );
    await writeFile(
      path.join(runRoot, "inputs", "phase-plan.frozen.yaml"),
      phaseText
    );
    await cp(
      path.join(root, "protocol.lock.json"),
      path.join(runRoot, "inputs", "protocol.lock.json")
    );
    await writeFile(
      path.join(runRoot, "inputs", "assignments.json"),
      serializeAssignmentSchedule(schedule)
    );
    await writeFile(
      path.join(runRoot, "inputs", "evidence-requirements.json"),
      `${JSON.stringify({ schema_version: 1 })}\n`
    );
    await writeFile(
      path.join(runRoot, "inputs", "compatibility.json"),
      `${JSON.stringify({
        study_compatibility_sha256: sha256Hex("fixture study key"),
        cells: schedule.assignments.map((assignment) => ({
          cell_id: assignment.cell_id,
          cell_compatibility_sha256: sha256Hex(
            `fixture cell ${assignment.cell_id}`
          )
        }))
      })}\n`
    );
    return { runRoot, schedule };
  }

  it("analyzes a study run assembled from engine outputs", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot } = await assembleStudyRun(cwd, root, steel.root);

    const io = new MemoryIo();
    const code = await main(["study", "analyze", runRoot], io, { cwd });
    expect(code).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("study run: sr-1");
    expect(text).toContain("phase: smoke analytical=false");
    expect(io.stderrText()).toContain(StudyCliCode.AnalysisIncomplete);
    const analysis = JSON.parse(
      await readFile(path.join(runRoot, "study-analysis.json"), "utf8")
    ) as {
      study_run_id: string;
      lineage: { kind: string };
      populations: {
        id: string;
        numerator: number;
        denominator: number;
        unresolved_slots: number;
      }[];
      estimates: unknown[];
    };
    expect(analysis.study_run_id).toBe("sr-1");
    expect(analysis.lineage.kind).toBe("preregistered");
    expect(analysis.populations).toEqual([
      {
        id: "lifecycle_flow",
        numerator: 0,
        denominator: 2,
        unresolved_slots: 2
      }
    ]);
    // No estimate exists because the batch runner allocates its own
    // assignment identifiers, so no scheduled slot can be matched.
    expect(analysis.estimates).toEqual([]);
  });

  it("reports a hash mismatch when the frozen phase plan changes", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot } = await assembleStudyRun(cwd, root, steel.root);
    await writeFile(
      path.join(runRoot, "inputs", "phase-plan.frozen.yaml"),
      (
        await readFile(
          path.join(runRoot, "inputs", "phase-plan.frozen.yaml"),
          "utf8"
        )
      ).replace('"binary_interval": "wilson"', '"binary_interval": "wald"')
    );

    const io = new MemoryIo();
    const code = await main(["study", "analyze", runRoot], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(AnalyzeCode.HashMismatch);
  });

  it("refuses --analysis-plan without reading any file", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot } = await assembleStudyRun(cwd, root, steel.root);

    const io = new MemoryIo();
    const code = await main(
      ["study", "analyze", runRoot, "--analysis-plan", "plan.json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(AnalyzeCode.AnalysisPlanUnsupported);
    // No analysis document was written for a refused request.
    expect(
      await readFile(path.join(runRoot, "study-analysis.json"), "utf8").catch(
        () => "missing"
      )
    ).toBe("missing");
  });

  it("refuses to overwrite the recorded analysis document", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot } = await assembleStudyRun(cwd, root, steel.root);
    const first = new MemoryIo();
    expect(await main(["study", "analyze", runRoot], first, { cwd })).toBe(
      EXIT_OK
    );
    const original = await readFile(
      path.join(runRoot, "study-analysis.json"),
      "utf8"
    );

    const second = new MemoryIo();
    const code = await main(["study", "analyze", runRoot], second, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(second.stderrText()).toContain(AnalyzeCode.ArtifactExists);
    // The recorded result keeps its bytes: nothing overwrote it.
    expect(
      await readFile(path.join(runRoot, "study-analysis.json"), "utf8")
    ).toBe(original);
  });

  it("writes a derived correction beside the untouched original", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot } = await assembleStudyRun(cwd, root, steel.root);
    const first = new MemoryIo();
    expect(await main(["study", "analyze", runRoot], first, { cwd })).toBe(
      EXIT_OK
    );
    const original = await readFile(
      path.join(runRoot, "study-analysis.json"),
      "utf8"
    );

    const io = new MemoryIo();
    const code = await main(
      [
        "study",
        "analyze",
        runRoot,
        "--derived-from",
        path.join(runRoot, "study-analysis.json")
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    expect(
      await readFile(path.join(runRoot, "study-analysis.json"), "utf8")
    ).toBe(original);
    const derivedDir = path.join(runRoot, "derived");
    const names = await readdir(derivedDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^study-analysis-[0-9a-f]{12}\.json$/);
    const derived = JSON.parse(
      await readFile(path.join(derivedDir, names[0] ?? ""), "utf8")
    ) as {
      analysis_id: string;
      lineage: {
        kind: string;
        parent_analysis_id: string;
        reason: string;
      };
    };
    expect(derived.analysis_id).toBe("sr-1-analysis-derived");
    expect(derived.lineage).toEqual({
      kind: "derived",
      parent_analysis_id: "sr-1-analysis",
      reason: "corrected built-in analysis"
    });

    // A byte-identical derived request never duplicates itself.
    const repeat = new MemoryIo();
    const repeatCode = await main(
      [
        "study",
        "analyze",
        runRoot,
        "--derived-from",
        path.join(runRoot, "study-analysis.json")
      ],
      repeat,
      { cwd }
    );
    expect(repeatCode).toBe(EXIT_INVALID);
    expect(repeat.stderrText()).toContain(AnalyzeCode.ArtifactExists);
    expect(await readdir(derivedDir)).toEqual(names);
  });

  it("refuses drifted child-batch evidence before any estimate", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { root } = await scaffoldedStudy(cwd, steel.root);
    await writeLock(cwd, root, steel.root);
    const { runRoot, schedule } = await assembleStudyRun(cwd, root, steel.root);
    // Tamper one manifest-listed file inside a child batch after freezing.
    const batchDir = path.join(
      runRoot,
      "batches",
      schedule.assignments[0]?.child_batch_id ?? ""
    );
    const manifest = JSON.parse(
      await readFile(path.join(batchDir, "artifact-manifest.json"), "utf8")
    ) as { entries: { path: string; entry_type?: string }[] };
    const entry = manifest.entries.find(
      (candidate) => candidate.entry_type === "file"
    );
    if (entry === undefined) {
      throw new Error("Fixture batch manifest holds no file entry.");
    }
    const evidencePath = path.join(batchDir, entry.path);
    await writeFile(
      evidencePath,
      `${await readFile(evidencePath, "utf8")}tampered\n`
    );

    const io = new MemoryIo();
    const code = await main(["study", "analyze", runRoot], io, { cwd });
    expect(code).toBe(EXIT_INFRASTRUCTURE);
    expect(io.stderrText()).toContain(AnalyzeCode.EvidenceDrift);
    expect(
      await readFile(path.join(runRoot, "study-analysis.json"), "utf8").catch(
        () => "missing"
      )
    ).toBe("missing");
  });
});
