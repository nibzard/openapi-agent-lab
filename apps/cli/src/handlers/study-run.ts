/**
 * `oal study run` (specification section 23.16). The command validates a
 * candidate schedule against the locked protocol, expands the cells,
 * derives the run bindings, prints the exact paid-call maximum, and
 * probes the adapter. Launching is refused in this build: the batch
 * runner allocates trial run IDs and cohort seeds itself and writes its
 * own assignment ledger, so the scheduler bindings cannot be imposed
 * from the CLI. `--dry-run` completes every check, prints the launch
 * plan, and persists nothing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  invalidInput,
  isJsonObject,
  isSafeId,
  SchemaValidator,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json
} from "@oal/core";
import {
  assignmentRunBindings,
  assignmentScheduleSha256,
  type AssignmentSchedule,
  type CohortSeedBase
} from "@oal/scheduler";
import { verifyProtocolLock } from "@oal/study-ir";
import { resolvedCellCount } from "@oal/study";
import { parsePackDocument } from "@oal/pack";
import type { LoadedPack } from "@oal/pack";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { tooManyArguments } from "../usage.ts";
import { selectAdapter } from "./run.ts";
import { buildStudySchedule, contractOfPack } from "./study-schedule.ts";
import {
  cellDigestsOf,
  loadStudy,
  loadStudyPhase,
  lockMembersOf,
  LOCK_MEMBER,
  packIdentityOf,
  readLock,
  readMember,
  readSchema,
  resolvePackRef,
  scenarioEntryOf,
  StudyCliCode,
  type LoadedStudy
} from "./study-tree.ts";

/** Stable diagnostic codes of the run command. */
export const StudyRunCode = {
  ScheduleMissing: "OAL-STUDY-RUN-SCHEDULE-MISSING",
  RuntimeLockUnmet: "OAL-STUDY-RUN-RUNTIME-LOCK-UNMET",
  ValueDisagrees: "OAL-STUDY-RUN-VALUE-DISAGREES"
} as const;

/** The flag each runtime-lock field maps onto. */
const RUNTIME_LOCK_FLAGS: Readonly<Record<string, string>> = {
  "agent.adapter": "agent",
  "agent.model": "model",
  "agent.effort": "effort",
  "agent.sandbox": "sandbox"
};

/** Parse and validate one assignments document. */
export async function loadScheduleFile(target: string): Promise<{
  readonly schedule: AssignmentSchedule | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const text = await readFile(target, "utf8").catch(() => null);
  if (text === null) {
    return {
      schedule: null,
      diagnostics: [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyRunCode.ScheduleMissing,
          message: `Schedule document not found: ${target}.`
        })
      ]
    };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      schedule: null,
      diagnostics: [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyRunCode.ScheduleMissing,
          message: `Schedule document is not valid JSON (${target}): ${reason}`
        })
      ]
    };
  }
  const schema = await readSchema("assignment-schedule.v1.schema.json");
  const violations = new SchemaValidator(schema).errors(parsed);
  if (violations.length > 0 || !isJsonObject(parsed)) {
    return {
      schedule: null,
      diagnostics: [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyRunCode.ScheduleMissing,
          message:
            `Schedule document fails assignment-schedule.v1 (${target}): ` +
            violations
              .slice(0, 3)
              .map((entry) => `${entry.code}: ${entry.message}`)
              .join("; ")
        })
      ]
    };
  }
  return {
    schedule: parsed as unknown as AssignmentSchedule,
    diagnostics: []
  };
}

/**
 * The cohort seed base of one study phase, hashed from the pack and
 * member bytes the protocol freezes. Every field is a real digest of
 * bytes this function read.
 */
export async function cohortSeedBaseOf(
  study: LoadedStudy,
  pack: LoadedPack,
  contractText: string
): Promise<CohortSeedBase> {
  const digests = await cellDigestsOf(study, pack);
  const first = [...digests.values()][0];
  const identity = await packIdentityOf(pack.root);
  const scenarioEntry = scenarioEntryOf(
    pack,
    study.protocol.evaluation.scenario
  );
  const behavior = pack.manifest["behavior"];
  return {
    contractExecutionSha256: sha256Hex(contractText),
    participantSurfaceTemplateSha256:
      first?.participant_surface_policy_sha256 ?? sha256Hex(""),
    packSha256: identity.sha256,
    scenario:
      scenarioEntry === null
        ? null
        : {
            id: study.protocol.evaluation.scenario,
            sha256: sha256Hex(canonicalJson(scenarioEntry as Json))
          },
    behaviorSha256: sha256Hex(canonicalJson((behavior ?? {}) as Json)),
    eval: {
      id: study.protocol.evaluation.eval,
      sha256: first?.eval_sha256 ?? sha256Hex("")
    },
    caseRef: null
  };
}

/** The contract entrypoint text of one pack. */
async function contractTextOf(pack: LoadedPack): Promise<string> {
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  if (entry === undefined) {
    return "";
  }
  return await readFile(entry.absolutePath, "utf8");
}

/** `oal study run <study-dir> [options]`. */
export const studyRunCommand: CommandHandler = async (args, io) => {
  const directory = args.positionals[0];
  if (directory === undefined) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      'Command "study run" requires a study directory.'
    );
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const phaseId = args.flags.string("phase");
  if (phaseId === undefined) {
    throw invalidInput(
      StudyRunCode.RuntimeLockUnmet,
      'Command "study run" requires --phase with the phase to run.'
    );
  }
  const scheduleFlag = args.flags.string("schedule");
  if (scheduleFlag === undefined) {
    throw invalidInput(
      StudyRunCode.ScheduleMissing,
      'Command "study run" requires --schedule with the candidate ' +
        "assignments document."
    );
  }
  const studyRunId = args.flags.string("study-run");
  if (studyRunId === undefined || !isSafeId(studyRunId)) {
    throw invalidInput(
      StudyRunCode.ScheduleMissing,
      'Command "study run" requires --study-run with a safe StudyRun ID.'
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
          `Study ${study.root} holds no ${LOCK_MEMBER}; a phase cannot ` +
          "run without a verified protocol lock."
      })
    );
  }
  const verified =
    lockState.lock === null
      ? null
      : verifyProtocolLock(lockState.lock, {
          members: lockMembersOf(study),
          protocol: study.protocol
        });
  if (verified !== null) {
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
  }

  const cellCount = resolvedCellCount({ protocol: study.protocol });
  const loadedPhase = await loadStudyPhase(study, phaseId, cellCount);
  diagnostics.push(...loadedPhase.diagnostics);
  const phasePlan = loadedPhase.plan;

  const schedulePath = path.resolve(args.context.cwd, scheduleFlag);
  const loadedSchedule = await loadScheduleFile(schedulePath);
  diagnostics.push(...loadedSchedule.diagnostics);
  const candidate = loadedSchedule.schedule;
  if (candidate !== null) {
    if (candidate.study_run_id !== studyRunId) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.ScheduleMismatch,
          message:
            `Schedule ${schedulePath} is bound to StudyRun ` +
            `${candidate.study_run_id}, not ${studyRunId}.`
        })
      );
    }
    if (candidate.phase_id !== phaseId) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.ScheduleMismatch,
          message:
            `Schedule ${schedulePath} covers phase ${candidate.phase_id}, ` +
            `not ${phaseId}.`
        })
      );
    }
  }

  let rebuiltDigest: string | null = null;
  let candidateDigest: string | null = null;
  let bindings: readonly {
    readonly assignment_id: string;
    readonly run_id: string;
    readonly run_seed: string;
    readonly child_batch_id: string;
  }[] = [];
  if (
    phasePlan !== null &&
    candidate !== null &&
    verified !== null &&
    verified.ok
  ) {
    const contract = await contractOfPack(
      pack,
      args.context.cwd,
      args.context.maxSourceBytes
    );
    const rebuilt = await buildStudySchedule(study, pack, contract, {
      phaseId,
      studyRunId,
      seed: candidate.schedule_seed,
      lockSha256: verified.lockSha256,
      effectiveContracts: { ...lockState.lock?.effective_contracts }
    });
    diagnostics.push(...rebuilt.diagnostics);
    candidateDigest = assignmentScheduleSha256(candidate);
    if (rebuilt.schedule !== null) {
      rebuiltDigest = assignmentScheduleSha256(rebuilt.schedule);
      if (rebuiltDigest !== candidateDigest) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCliCode.ScheduleMismatch,
            message:
              `Schedule ${schedulePath} does not match the locked ` +
              `protocol: rebuilt digest ${rebuiltDigest}, candidate ` +
              `${candidateDigest}.`
          })
        );
      } else {
        const base = await cohortSeedBaseOf(
          study,
          pack,
          await contractTextOf(pack)
        );
        bindings = assignmentRunBindings(rebuilt.schedule, base);
      }
    }
  }

  if (phasePlan !== null) {
    for (const field of phasePlan.runtime_lock.required_fields) {
      const flag = RUNTIME_LOCK_FLAGS[field];
      if (flag !== undefined && args.flags.string(flag) === undefined) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyRunCode.RuntimeLockUnmet,
            message:
              `Phase plan ${phaseId} requires ${field}, so --${flag} must ` +
              "carry that value."
          })
        );
      }
    }
    const profileRelative = study.protocol.constants.run_profile;
    const profileText = await readMember(study.root, profileRelative);
    if (profileText !== null) {
      const declared = declaredRuntimeValues(profileText);
      for (const [field, value] of Object.entries(declared)) {
        const flag = RUNTIME_LOCK_FLAGS[field];
        const given = flag === undefined ? undefined : args.flags.string(flag);
        if (given !== undefined && given !== value) {
          diagnostics.push(
            diagnostic({
              severity: "error",
              phase: "preflight",
              code: StudyRunCode.ValueDisagrees,
              message:
                `--${flag} value "${given}" disagrees with the locked run ` +
                `profile, which declares ${field} "${value}".`
            })
          );
        }
      }
    }
  }

  const selection = selectAdapter(args.flags.string("agent"));
  if ("error" in selection) {
    diagnostics.push(selection.error);
  }

  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    emitDiagnostics(io, args.context, diagnostics);
    return EXIT_INVALID;
  }
  emitDiagnostics(io, args.context, diagnostics);

  const paidMaximum = phasePlan?.paid_calls.maximum_with_replacements ?? 0;
  const cellsJson: Json[] = (candidate?.assignments ?? []).map(
    (entry): Json => ({
      assignment_id: entry.assignment_id,
      kind: entry.kind,
      cell_id: entry.cell_id,
      child_batch_id: entry.child_batch_id,
      factor_levels: { ...entry.factor_levels }
    })
  );

  if (args.flags.has("dry-run")) {
    if (args.context.format === "json") {
      io.stdout(
        stableJsonStringify({
          kind: "StudyRunCli",
          dry_run: true,
          root: study.root,
          phase: phaseId,
          study_run: studyRunId,
          schedule: schedulePath,
          ...(candidateDigest === null
            ? {}
            : { schedule_sha256: candidateDigest }),
          analytical: phasePlan?.analytical ?? null,
          cells: cellCount,
          assignments: cellsJson,
          bindings: bindings.map((entry): Json => ({ ...entry })),
          paid_call_maximum: paidMaximum,
          persisted: false
        } as Json)
      );
    } else {
      io.stdout(`study: ${study.root}`);
      io.stdout(`phase: ${phaseId} analytical=${phasePlan?.analytical}`);
      io.stdout(`study run: ${studyRunId}`);
      io.stdout(`schedule: ${schedulePath}`);
      if (candidateDigest !== null) {
        io.stdout(`schedule sha256: ${candidateDigest}`);
      }
      io.stdout(`cells: ${cellCount}`);
      io.stdout(`paid-call maximum: ${paidMaximum}`);
      for (const binding of bindings) {
        io.stdout(
          `binding: ${binding.assignment_id} run=${binding.run_id} ` +
            `batch=${binding.child_batch_id} seed=${binding.run_seed}`
        );
      }
      io.stdout("dry run: no StudyRun persisted, no agent started");
    }
    return EXIT_OK;
  }

  emitDiagnostics(io, args.context, [
    diagnostic({
      severity: "error",
      phase: "run",
      code: StudyCliCode.NoExecutor,
      message:
        "This build cannot launch a scheduled study phase. The batch " +
        "runner allocates trial run IDs and cohort seeds itself and " +
        "writes its own assignment ledger, so the scheduler bindings " +
        "printed by --dry-run cannot be imposed from the CLI. Bridging " +
        "them needs a runner-side TrialExecutor, which no workspace " +
        "package exports. Every validation above still ran; nothing was " +
        "started and no paid call was made. Use --dry-run for the " +
        "validated launch plan."
    })
  ]);
  return EXIT_UNSUPPORTED;
};

/** The runtime values one run-profile member pins, by dotted field. */
function declaredRuntimeValues(profileText: string): Record<string, string> {
  const parsed = parsePackDocument(profileText, "profiles/run.yaml");
  const document = parsed.value;
  if (document === null || !isJsonObject(document)) {
    return {};
  }
  const agent = isJsonObject(document["agent"]) ? document["agent"] : null;
  const values: Record<string, string> = {};
  if (agent === null) {
    return values;
  }
  for (const key of ["adapter", "model", "effort", "sandbox"]) {
    const value = agent[key];
    if (typeof value !== "string") {
      continue;
    }
    if (key === "adapter" && value === "generic") {
      // The run-profile schema pins no concrete adapter: "generic" marks an
      // adapter-neutral profile, so every selector agrees with it.
      continue;
    }
    values[`agent.${key}`] = value;
  }
  return values;
}
