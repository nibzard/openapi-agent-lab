import path from "node:path";

import {
  EXIT_EVAL_THRESHOLD,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  diagnostic,
  invalidInput,
  isSafeId,
  stableJsonStringify,
  type Diagnostic,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";
import { CodexCliAdapter } from "@oal/agent-codex";
import type { AgentAdapter } from "@oal/agent-adapter";
import { ArtifactStore } from "@oal/evidence";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { defaultSchemaDir, loadPack } from "@oal/pack";
import {
  CONTRACT_VISIBILITIES,
  EXPOSURE_MODES,
  PreflightCode,
  RunCode,
  runBatch,
  runPreflight,
  type BatchOutcome,
  type DataPlaneScope,
  type FrozenPlan,
  type PreflightOptions
} from "@oal/runner";

import type { CommandArgs, CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

/** Stable diagnostic codes of the run command family. */
export const RunCliCode = {
  EvalMissing: "OAL-RUN-EVAL-MISSING",
  AgentUnsupported: "OAL-RUN-AGENT-UNSUPPORTED",
  ProfileUnsupported: "OAL-RUN-PROFILE-UNSUPPORTED",
  BatchIdUnsafe: "OAL-RUN-BATCH-ID-UNSAFE",
  PaidUnconfirmed: "OAL-RUN-PAID-UNCONFIRMED"
} as const;

/** Agent selectors this build can construct without a configuration file. */
export const AGENT_SELECTORS: readonly string[] = ["mock-agent", "codex-cli"];

/** Data-plane scopes `--data-plane-scope` accepts. */
export const DATA_PLANE_SCOPE_VALUES: readonly string[] = ["all", "eval"];

/** Duration units `--timeout` accepts; a bare number means milliseconds. */
const DURATION_PATTERN = /^([0-9]+)(ms|s|m|h)?$/;

const UNIT_FACTORS: Readonly<Record<string, number>> = {
  "": 1,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000
};

/** Parse one `--timeout` duration into milliseconds, or return null. */
export function parseDurationMs(raw: string): number | null {
  const match = DURATION_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const factor = UNIT_FACTORS[match[2] ?? ""];
  if (!Number.isFinite(amount) || factor === undefined) {
    return null;
  }
  return amount * factor;
}

/** Derive a fresh batch identifier from one wall-clock instant. */
export function defaultBatchId(at: Date): string {
  const pad = (value: number, width = 2): string =>
    value.toString().padStart(width, "0");
  return [
    "batch",
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`,
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`,
    pad(at.getUTCMilliseconds(), 3)
  ].join("-");
}

/** The adapter one `--agent` selector maps to, and whether it costs money. */
export function selectAdapter(
  selector: string | undefined
): { adapter: AgentAdapter; paid: boolean } | { error: Diagnostic } {
  const name = selector ?? "mock-agent";
  if (name === "mock-agent") {
    return { adapter: new MockAgentAdapter(), paid: false };
  }
  if (name === "codex-cli") {
    // The adapter owns the declared launcher credential: CODEX_API_KEY.
    // Codex 0.154 ignores OPENAI_API_KEY for non-interactive auth. The
    // runner copies only the declared names from the host, and the
    // participant tool environment never sees them.
    return { adapter: new CodexCliAdapter(), paid: true };
  }
  return {
    error: diagnostic({
      severity: "error",
      phase: "preflight",
      code: RunCliCode.AgentUnsupported,
      message:
        `Agent selector "${name}" is not supported in this build. ` +
        `Supported selectors: ${AGENT_SELECTORS.join(", ")}.`,
      details: { requested: name, supported: [...AGENT_SELECTORS] }
    })
  };
}

/** Preflight findings that describe an unsupported request, not bad input. */
const UNSUPPORTED_FINDINGS: readonly string[] = [
  PreflightCode.ExposureIncompatible,
  PreflightCode.VisibilityUnsupported
];

/** Exit status of a failed preflight: unsupported is 4, everything else 2. */
export function exitCodeOfFindings(findings: readonly Diagnostic[]): ExitCode {
  const errors = findings.filter((entry) => entry.severity === "error");
  const unsupported = errors.some((entry) =>
    UNSUPPORTED_FINDINGS.includes(entry.code)
  );
  return unsupported ? EXIT_UNSUPPORTED : EXIT_INVALID;
}

/**
 * Exit status of one finished batch (specification section 23.18). An
 * interruption is decided before this function runs, so the order is
 * infrastructure, invalid setup, evaluation threshold, success.
 */
export function exitCodeOfBatch(
  outcome: BatchOutcome,
  noFailOnEval: boolean
): ExitCode {
  if (outcome.defectCode !== null) {
    return EXIT_INFRASTRUCTURE;
  }
  const dispositions = new Set(
    outcome.outcomes.map((trial) => trial.disposition)
  );
  const operational: readonly string[] = [
    "provider_failed_pre_control",
    "provider_failed_post_control",
    "infrastructure_failed_pre_control",
    "infrastructure_failed_post_control",
    "operator_interrupted",
    "budget_exhausted",
    "timed_out",
    "harness_aborted"
  ];
  if (
    outcome.notStartedRunIds.length > 0 ||
    [...dispositions].some((entry) => operational.includes(entry))
  ) {
    return EXIT_INFRASTRUCTURE;
  }
  if (dispositions.has("invalid_setup")) {
    return EXIT_INVALID;
  }
  const thresholdFailed = outcome.outcomes.some(
    (trial) =>
      trial.evaluation !== null &&
      trial.evaluation.valid &&
      trial.evaluation.status === "failed"
  );
  if (thresholdFailed) {
    return noFailOnEval ? EXIT_OK : EXIT_EVAL_THRESHOLD;
  }
  return EXIT_OK;
}

function requireSinglePositional(args: CommandArgs, name: string): string {
  const value = args.positionals[0];
  if (value === undefined) {
    throw missingArgument(args.command.name, name);
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  return value;
}

function optionalEnumeration<T extends string>(
  flags: CommandArgs["flags"],
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = flags.string(name);
  if (value === undefined) {
    return undefined;
  }
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw invalidOptionValue(`--${name}`, value, `one of: ${allowed.join(", ")}`);
}

/** Fields of one `trial.finished` event the terminal progress line prints. */
export interface TrialFinishedLine {
  readonly runId: string;
  readonly disposition: string;
  readonly reasonCode: string;
  readonly spawnError?: string | null | undefined;
}

/**
 * One terminal progress line for a finished trial. The spawn error rides
 * along when the driver never started, so the operator can tell ENOENT
 * from EACCES without opening the artifacts.
 */
export function trialFinishedLine(event: TrialFinishedLine): string {
  const spawnError = event.spawnError ?? null;
  return (
    `trial ${event.runId}: ${event.disposition} (${event.reasonCode})` +
    (spawnError === null ? "" : ` spawn_error=${spawnError}`)
  );
}

/** `oal run <pack> --eval <id>` (specification section 23.8). */
export const runCommand: CommandHandler = async (args, io) => {
  const packArgument = requireSinglePositional(args, "pack");
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const evalId = args.flags.string("eval");
  if (evalId === undefined) {
    throw invalidInput(
      RunCliCode.EvalMissing,
      'Command "run" requires an --eval identifier.',
      { command: args.command.name }
    );
  }
  if (args.flags.string("profile") !== undefined) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: RunCliCode.ProfileUnsupported,
        message:
          "Run profile documents are not loaded in this build; pass the " +
          "settings as flags instead."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  const selection = selectAdapter(args.flags.string("agent"));
  if ("error" in selection) {
    emitDiagnostics(io, args.context, [selection.error]);
    return EXIT_UNSUPPORTED;
  }

  const batchFlag = args.flags.string("batch");
  const batchId = batchFlag ?? defaultBatchId(new Date());
  if (!isSafeId(batchId)) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: RunCliCode.BatchIdUnsafe,
        message: `Batch identifier is not a safe id: ${batchId}.`
      })
    ]);
    return EXIT_INVALID;
  }

  const timeoutRaw = args.flags.string("timeout");
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const parsed = parseDurationMs(timeoutRaw);
    if (parsed === null) {
      throw invalidOptionValue(
        "--timeout",
        timeoutRaw,
        "a number with an ms, s, m, or h unit, for example 10m"
      );
    }
    // Zero parses, but a trial that may run for no time is invalid
    // setup. Reject it here, so the operator sees the reason at parse
    // time instead of a downstream preflight code.
    if (parsed === 0) {
      throw invalidOptionValue(
        "--timeout",
        timeoutRaw,
        "a duration greater than zero, for example 10m"
      );
    }
    timeoutMs = parsed;
  }

  const exposureMode = optionalEnumeration(
    args.flags,
    "exposure",
    EXPOSURE_MODES
  );
  const contractVisibility = optionalEnumeration(
    args.flags,
    "contract-visibility",
    CONTRACT_VISIBILITIES
  );
  const scopeRaw = optionalEnumeration(
    args.flags,
    "data-plane-scope",
    DATA_PLANE_SCOPE_VALUES
  );
  // Specification section 23.8 spells the eval scope "eval"; the frozen
  // profile records that treatment as "task".
  const dataPlaneScope: DataPlaneScope | undefined =
    scopeRaw === undefined ? undefined : scopeRaw === "all" ? "all" : "task";

  const count = args.flags.integer("count", { minimum: 1, maximum: 100 });
  const parallel = args.flags.integer("parallel", { minimum: 1, maximum: 10 });
  const store = new ArtifactStore(path.resolve(args.context.cwd, ".oal"));
  const packDir = path.resolve(args.context.cwd, packArgument);
  // One load feeds preflight and the batch freeze, so both see the same
  // bytes. A missing pack directory throws a typed invalid-input error.
  const loadedPack = await loadPack(packDir);
  const preflightOptions: PreflightOptions = {
    packDir,
    loadedPack,
    evalId,
    batchId,
    store,
    adapter: selection.adapter,
    paid: selection.paid,
    schemaDir: defaultSchemaDir(),
    ...(exposureMode === undefined ? {} : { exposureMode }),
    ...(contractVisibility === undefined ? {} : { contractVisibility }),
    ...(dataPlaneScope === undefined ? {} : { dataPlaneScope }),
    ...(args.flags.string("scenario") === undefined
      ? {}
      : { scenarioId: args.flags.string("scenario") }),
    ...(args.flags.string("model") === undefined
      ? {}
      : { model: args.flags.string("model") }),
    ...(args.flags.string("effort") === undefined
      ? {}
      : { effort: args.flags.string("effort") }),
    ...(args.flags.string("sandbox") === undefined
      ? {}
      : { sandbox: args.flags.string("sandbox") }),
    ...(args.flags.string("cohort-seed") === undefined
      ? {}
      : { cohortSeed: args.flags.string("cohort-seed") }),
    ...(count === undefined ? {} : { count }),
    ...(parallel === undefined ? {} : { parallel }),
    ...(timeoutMs === undefined ? {} : { trialWallTimeMs: timeoutMs }),
    ...((count ?? 1) > 1 || (parallel ?? 1) > 1
      ? {
          limitOverrides: {
            maxBatchTrials: 100,
            maxParallelTrials: 10
          }
        }
      : {}),
    ...(selection.paid
      ? { confirmPaid: (): boolean => args.flags.has("yes") }
      : {})
  };

  const preflight = await runPreflight(preflightOptions);
  emitDiagnostics(io, args.context, preflight.findings);
  if (!preflight.ok || preflight.plan === null) {
    if (exitCodeOfFindings(preflight.findings) === EXIT_INVALID) {
      const unconfirmed = preflight.findings.some(
        (entry) => entry.code === PreflightCode.NotConfirmed
      );
      if (unconfirmed) {
        io.stderr(
          `${RunCliCode.PaidUnconfirmed}: rerun with --yes to confirm the ` +
            "paid-call plan."
        );
      }
    }
    return exitCodeOfFindings(preflight.findings);
  }
  const plan = preflight.plan;

  if (args.flags.has("dry-run")) {
    if (args.context.format === "json") {
      io.stdout(
        stableJsonStringify(
          dryRunSummary(plan, batchFlag === undefined) as Json
        )
      );
    } else {
      for (const line of summaryLines(plan, batchFlag === undefined)) {
        io.stderr(line);
      }
      io.stderr("dry run: no batch written, no agent started");
    }
    return EXIT_OK;
  }

  if (args.context.format === "terminal") {
    io.stderr(`batch: ${plan.batchId}`);
    io.stderr(`trials: ${plan.count} parallel=${plan.parallel}`);
  }
  const outcome = await runBatch({
    store,
    plan,
    pack: loadedPack,
    adapter: selection.adapter,
    now: (): number => Date.now(),
    signal: args.context.abortSignal,
    onEvent: (event) => {
      if (args.context.format !== "terminal") {
        return;
      }
      if (event.type === "trial.finished") {
        io.stderr(trialFinishedLine(event));
      }
      if (event.type === "trial.not_started") {
        io.stderr(`trial ${event.runId}: not started (${event.reasonCode})`);
      }
    }
  });
  const code = exitCodeOfBatch(outcome, args.flags.has("no-fail-on-eval"));
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(batchSummary(outcome, code) as Json));
  } else {
    io.stdout(`batch: ${outcome.batchId}`);
    io.stdout(`batch dir: ${store.resolve(`runs/${outcome.batchId}`)}`);
    io.stdout(`manifest sha256: ${outcome.manifestSha256}`);
    for (const trial of outcome.outcomes) {
      io.stdout(
        `run ${trial.runId}: ${trial.disposition} ` +
          `(${trial.reasonCode}) censor=${trial.censorClass}`
      );
    }
    for (const runId of outcome.notStartedRunIds) {
      io.stdout(`run ${runId}: not_started (${RunCode.NotStarted})`);
    }
    if (outcome.defectCode !== null) {
      io.stdout(`defect: ${outcome.defectCode}`);
    }
    if (code === EXIT_EVAL_THRESHOLD) {
      io.stdout(
        "evaluation threshold failed; rerun with --no-fail-on-eval to map 5 to 0"
      );
    }
  }
  return code;
};

/** Treatment variables and ceilings `--dry-run` reports. */
function dryRunSummary(plan: FrozenPlan, derivedBatchId: boolean): JsonObject {
  return {
    schema_version: 1,
    kind: "RunDryRun",
    dry_run: true,
    batch_id: plan.batchId,
    batch_id_derived: derivedBatchId,
    pack: plan.pack.root,
    pack_sha256: plan.pack.packSha256,
    eval_id: plan.evalId,
    scenario_id: plan.scenarioId,
    prompt_set_id: plan.promptSetId,
    treatment: {
      exposure_mode: plan.exposureMode,
      contract_visibility: plan.contractVisibility,
      data_plane_scope: plan.dataPlaneScope,
      behavior_mode: plan.behaviorMode
    },
    plan: {
      count: plan.count,
      parallel: plan.parallel,
      trial_wall_time_ms: plan.trialWallTimeMs,
      cohort_seed: plan.cohortSeed,
      run_seed_id: plan.runSeedIdentifier,
      trial_run_ids: [...plan.trialRunIds]
    },
    adapter: {
      id: plan.adapter.id,
      probe_status: plan.adapter.probe.status,
      version: plan.adapter.probe.version,
      model: plan.adapter.model,
      paid: plan.paid
    },
    paid_call_plan: {
      paid: plan.paidCallPlan.paid,
      trials: plan.paidCallPlan.trials,
      max_agent_launches: plan.paidCallPlan.maxAgentLaunches,
      trial_wall_time_ms: plan.paidCallPlan.trialWallTimeMs,
      max_api_requests_per_trial: plan.paidCallPlan.maxApiRequestsPerTrial,
      max_agent_tool_calls_per_trial:
        plan.paidCallPlan.maxAgentToolCallsPerTrial,
      max_artifact_bytes_per_trial: plan.paidCallPlan.maxArtifactsBytesPerTrial
    },
    inputs: {
      contract_entrypoint: plan.contract.entrypoint,
      contract_semantic_sha256: plan.contract.semanticSha256,
      capability_report_sha256: plan.contract.capabilityReportSha256,
      rubric_sha256: plan.evaluation.rubricSha256,
      result_schema_sha256: plan.evaluation.resultSchemaSha256,
      prompt_preview_files: plan.promptPreview.files.length
    }
  };
}

/** Operator-readable lines of one dry-run plan. */
function summaryLines(plan: FrozenPlan, derivedBatchId: boolean): string[] {
  return [
    `pack: ${plan.pack.root}`,
    `pack sha256: ${plan.pack.packSha256}`,
    `eval: ${plan.evalId} scenario=${plan.scenarioId}`,
    `batch: ${plan.batchId}${derivedBatchId ? " (derived)" : ""}`,
    `exposure mode: ${plan.exposureMode}`,
    `contract visibility: ${plan.contractVisibility}`,
    `data plane scope: ${plan.dataPlaneScope}`,
    `trials: ${plan.count} parallel=${plan.parallel}`,
    `trial timeout ms: ${plan.trialWallTimeMs}`,
    `cohort seed: ${plan.cohortSeed}`,
    `run seed id: ${plan.runSeedIdentifier}`,
    `agent: ${plan.adapter.id} probe=${plan.adapter.probe.status}` +
      ` paid=${plan.paid}`,
    `max agent launches: ${plan.paidCallPlan.maxAgentLaunches}`,
    `max api requests per trial: ${plan.paidCallPlan.maxApiRequestsPerTrial}`,
    `max tool calls per trial: ${plan.paidCallPlan.maxAgentToolCallsPerTrial}`
  ];
}

/** Machine-readable record of one finished batch. */
function batchSummary(outcome: BatchOutcome, code: ExitCode): JsonObject {
  const counts = new Map<string, number>();
  for (const trial of outcome.outcomes) {
    counts.set(trial.disposition, (counts.get(trial.disposition) ?? 0) + 1);
  }
  return {
    schema_version: 1,
    kind: "RunCompletedCli",
    batch_id: outcome.batchId,
    count: outcome.count,
    parallel: outcome.parallel,
    launched: outcome.outcomes.length,
    not_started: [...outcome.notStartedRunIds],
    manifest_sha256: outcome.manifestSha256,
    dispositions: Object.fromEntries(counts),
    runs: outcome.outcomes.map((trial) => ({
      run_id: trial.runId,
      disposition: trial.disposition,
      reason_code: trial.reasonCode,
      censor_class: trial.censorClass,
      evidence_integrity: trial.evidenceIntegrity,
      report_status: trial.reportStatus,
      score: trial.evaluation?.score ?? null,
      evaluation_status: trial.evaluation?.status ?? null
    })),
    aborted: outcome.aborted,
    defect_code: outcome.defectCode,
    exit_code: code
  };
}
