/**
 * `oal study schedule` (specification section 23.15). The command checks
 * the protocol lock, expands cells, and emits the byte-deterministic
 * assignment schedule of one phase, already bound to the requested
 * StudyRun identifier. Without `--out` it is a preview; with `--out` the
 * target must not exist. It starts no server, adapter, or provider call.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  invalidInput,
  isSafeId,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json
} from "@oal/core";
import {
  assignmentScheduleSha256,
  buildAssignmentSchedule,
  describeSchedule,
  serializeAssignmentSchedule,
  type AssignmentSchedule,
  type ScheduleSummary
} from "@oal/scheduler";
import { compileStudy, verifyProtocolLock } from "@oal/study-ir";
import { resolvedCellCount } from "@oal/study";
import type { ContractIR } from "@oal/contract-ir";
import type { LoadedPack } from "@oal/pack";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { tooManyArguments } from "../usage.ts";
import { compileServeSource } from "./serve.ts";
import {
  cellDigestsOf,
  exists,
  loadStudy,
  loadStudyPhase,
  lockMembersOf,
  LOCK_MEMBER,
  phaseIdsOf,
  readLock,
  readMember,
  readSchema,
  resolvePackRef,
  StudyCliCode,
  type LoadedStudy
} from "./study-tree.ts";

/** Stable diagnostic codes of the schedule command. */
export const ScheduleCode = {
  SeedMissing: "OAL-STUDY-SCHEDULE-SEED-MISSING",
  StudyRunMissing: "OAL-STUDY-SCHEDULE-STUDY-RUN-MISSING",
  PhaseMissing: "OAL-STUDY-SCHEDULE-PHASE-MISSING"
} as const;

/** Compile the StudyIR of one loaded study, with its pack contract. */
export async function compileStudyOf(
  study: LoadedStudy,
  contract: ContractIR | undefined
): Promise<ReturnType<typeof compileStudy>> {
  return compileStudy(study.protocol, {
    schema: await readSchema("study-ir.v1.schema.json"),
    members: study.members,
    ...(contract === undefined ? {} : { contract }),
    documentUri: path.join(study.root, "study.yaml")
  });
}

/** The contract of one pack, compiled from its entrypoint. */
export async function contractOfPack(
  pack: LoadedPack,
  cwd: string,
  maxSourceBytes: number
): Promise<ContractIR> {
  const compiled = await compileServeSource(pack.root, cwd, maxSourceBytes);
  return compiled.contract;
}

/**
 * Build the schedule of one phase from a verified study. The lock digest
 * and the phase-plan digest feed every sort key, so both are hashed here
 * from the member bytes the lock already covers.
 */
export async function buildStudySchedule(
  study: LoadedStudy,
  pack: LoadedPack,
  contract: ContractIR | undefined,
  options: {
    readonly phaseId: string;
    readonly studyRunId: string;
    readonly seed: string;
    readonly lockSha256: string;
    readonly effectiveContracts: Readonly<Record<string, string>>;
  }
): Promise<{
  readonly schedule: AssignmentSchedule | null;
  readonly summary: ScheduleSummary | null;
  readonly phasePlanSha256: string;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const compiled = await compileStudyOf(study, contract);
  const cellCount = resolvedCellCount({
    protocol: study.protocol,
    ...(compiled.ir === null ? {} : { ir: compiled.ir })
  });
  const loaded = await loadStudyPhase(study, options.phaseId, cellCount);
  const diagnostics: Diagnostic[] = [
    ...compiled.diagnostics,
    ...loaded.diagnostics
  ];
  if (loaded.plan === null || compiled.ir === null) {
    return { schedule: null, summary: null, phasePlanSha256: "", diagnostics };
  }
  const relative = study.protocol.phases[options.phaseId] ?? "";
  const phasePlanSha256 = sha256Hex(
    study.members.get(relative) ??
      (await readMember(study.root, relative)) ??
      ""
  );
  const cellDigests = await cellDigestsOf(study, pack);
  const built = buildAssignmentSchedule({
    study_run_id: options.studyRunId,
    ir: compiled.ir,
    phasePlan: loaded.plan,
    protocol_lock_sha256: options.lockSha256,
    phase_plan_sha256: phasePlanSha256,
    schedule_seed: options.seed,
    effective_contracts: options.effectiveContracts,
    cell_digests: cellDigests
  });
  diagnostics.push(...built.diagnostics);
  if (built.schedule === null) {
    return { schedule: null, summary: null, phasePlanSha256, diagnostics };
  }
  return {
    schedule: built.schedule,
    summary: describeSchedule(built.schedule, loaded.plan),
    phasePlanSha256,
    diagnostics
  };
}

/** `oal study schedule <study-dir> [options]`. */
export const studyScheduleCommand: CommandHandler = async (args, io) => {
  const directory = args.positionals[0];
  if (directory === undefined) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      'Command "study schedule" requires a study directory.'
    );
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const seed = args.flags.string("seed");
  if (seed === undefined) {
    throw invalidInput(
      ScheduleCode.SeedMissing,
      'Command "study schedule" requires --seed with the scheduling seed.'
    );
  }
  const studyRunId = args.flags.string("study-run");
  if (studyRunId === undefined) {
    throw invalidInput(
      ScheduleCode.StudyRunMissing,
      'Command "study schedule" requires --study-run with a StudyRun ID.'
    );
  }
  if (!isSafeId(studyRunId)) {
    throw invalidInput(
      ScheduleCode.StudyRunMissing,
      `StudyRun identifier is not a safe id: ${studyRunId}.`
    );
  }

  const study = await loadStudy(path.resolve(args.context.cwd, directory));
  const diagnostics: Diagnostic[] = [...study.diagnostics];
  const packFlag = args.flags.string("pack");
  if (packFlag === undefined) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCliCode.PackMismatch,
        message:
          "This build has no content-addressed pack catalog, so the " +
          "identity-only PackRef resolves only through --pack."
      })
    );
    emitDiagnostics(io, args.context, diagnostics);
    return EXIT_INVALID;
  }
  const pack = await resolvePackRef(study, packFlag);

  const lockState = await readLock(study.root);
  diagnostics.push(...lockState.diagnostics);
  if (lockState.lock === null) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCliCode.LockMissing,
        message:
          `Study ${study.root} holds no ${LOCK_MEMBER}. Run "study ` +
          'validate --write-lock" first; a schedule binds the lock digest.'
      })
    );
    emitDiagnostics(io, args.context, diagnostics);
    return EXIT_INVALID;
  }
  const verified = await verifyProtocolLock(lockState.lock, {
    members: lockMembersOf(study),
    protocol: study.protocol
  });
  diagnostics.push(...verified.diagnostics);
  for (const drift of verified.drift) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCliCode.LockDrift,
        message: `Protocol lock drift (${drift.kind}): ${drift.detail}`
      })
    );
  }

  const phaseFlag = args.flags.string("phase");
  const phaseId =
    phaseFlag === undefined ? (phaseIdsOf(study)[0] ?? "") : phaseFlag;
  if (phaseId === "") {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: ScheduleCode.PhaseMissing,
        message: `Protocol of ${study.root} declares no phase.`
      })
    );
  }

  let schedule: AssignmentSchedule | null = null;
  let summary: ScheduleSummary | null = null;
  let digest = "";
  if (verified.ok && phaseId !== "") {
    const contract = await contractOfPack(
      pack,
      args.context.cwd,
      args.context.maxSourceBytes
    );
    const built = await buildStudySchedule(study, pack, contract, {
      phaseId,
      studyRunId,
      seed,
      lockSha256: verified.lockSha256,
      effectiveContracts: { ...lockState.lock.effective_contracts }
    });
    diagnostics.push(...built.diagnostics);
    schedule = built.schedule;
    summary = built.summary;
    if (schedule !== null) {
      digest = assignmentScheduleSha256(schedule);
    }
  }

  const outFlag = args.context.outPath;
  let written: string | null = null;
  if (outFlag !== null && schedule !== null && verified.ok) {
    const target = outFlag;
    if (await exists(target)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.TargetExists,
          message: `Schedule target already exists: ${target}.`
        })
      );
    } else {
      await writeFile(target, serializeAssignmentSchedule(schedule));
      written = target;
    }
  }

  const errors = diagnostics.filter((entry) => entry.severity === "error");
  emitDiagnostics(io, args.context, diagnostics);

  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        kind: "StudyScheduleCli",
        root: study.root,
        phase: phaseId,
        study_run: studyRunId,
        seed,
        summary:
          summary === null
            ? null
            : {
                primary_count: summary.primary_count,
                held_replacement_count: summary.held_replacement_count,
                maximum_agent_launches: summary.maximum_agent_launches,
                block_count: summary.block_count,
                cell_count: summary.cell_count,
                analytical: summary.analytical,
                purpose: summary.purpose
              },
        assignments:
          schedule === null
            ? []
            : schedule.assignments.map(
                (entry): Json => ({
                  assignment_id: entry.assignment_id,
                  kind: entry.kind,
                  cell_id: entry.cell_id,
                  child_batch_id: entry.child_batch_id,
                  slot: entry.slot,
                  block_id: entry.block_id,
                  factor_levels: { ...entry.factor_levels }
                })
              ),
        ...(digest === "" ? {} : { sha256: digest }),
        ...(written === null ? {} : { out: written })
      } as Json)
    );
  } else if (summary !== null && schedule !== null) {
    io.stdout(`study: ${study.root}`);
    io.stdout(`phase: ${phaseId} purpose=${summary.purpose}`);
    io.stdout(`study run: ${studyRunId}`);
    io.stdout(`cells: ${summary.cell_count}`);
    io.stdout(`primary assignments: ${summary.primary_count}`);
    io.stdout(`held replacements: ${summary.held_replacement_count}`);
    io.stdout(`maximum agent launches: ${summary.maximum_agent_launches}`);
    io.stdout(`blocks: ${summary.block_count}`);
    io.stdout(`analytical: ${summary.analytical}`);
    if (digest !== "") {
      io.stdout(`schedule sha256: ${digest}`);
    }
    if (written !== null) {
      io.stdout(`written: ${written}`);
    }
    for (const assignment of schedule.assignments) {
      io.stdout(
        `assignment: ${assignment.assignment_id} ${assignment.kind} ` +
          `cell=${assignment.cell_id} batch=${assignment.child_batch_id}`
      );
    }
  }
  return errors.length > 0 ? EXIT_INVALID : EXIT_OK;
};
