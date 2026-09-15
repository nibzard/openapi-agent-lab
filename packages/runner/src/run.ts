/**
 * Batch execution (specification sections 22.1, 22.4, and 24.1): freeze the
 * batch inputs, run the trial queue with a bounded worker pool, record the
 * assignment ledger, aggregate the cohort evaluation, and finalize the
 * batch manifest and completion pointer.
 */

import { readFile } from "node:fs/promises";

import {
  canonicalJson,
  canonicalJsonSha256,
  formatRfc3339,
  parseJsonStrict,
  prefixedId24,
  sha256Hex,
  toOalError,
  type Json,
  type JsonObject
} from "@oal/core";
import type { ArtifactStore, JsonlSink } from "@oal/evidence";
import type { AgentAdapter } from "@oal/agent-adapter";
import type { LoadedPack } from "@oal/pack";

import {
  classifyCensorClass,
  evidenceIntegrityOf,
  type CensorClass,
  type EvidenceRequirement
} from "./disposition.ts";
import {
  ORDERED_STAGES,
  snapshotOfRecords,
  stageRecordsOf,
  type Clock,
  type LifecycleEvent,
  type LifecycleStage
} from "./lifecycle.ts";
import { contractSettings, type FrozenPlan } from "./preflight.ts";
import { createRawHttpExposure } from "./exposure.ts";
import type { ExposureFactory } from "./setup.ts";
import {
  credentialEnvironmentNames,
  sanitizeParticipantContract
} from "./setup.ts";
import {
  batchAssignmentId,
  runTrial,
  type TrialEvent,
  type TrialOutcome
} from "./trial.ts";
import { packResponseFixtures } from "./types.ts";

/** Stable reason codes of the batch runner. */
export const RunCode = {
  BatchExists: "OAL-RUN-BATCH-EXISTS",
  BatchDefect: "OAL-RUN-BATCH-DEFECT",
  BatchAborted: "OAL-RUN-BATCH-ABORTED",
  InputsFrozen: "OAL-RUN-INPUTS-FROZEN",
  NotStarted: "OAL-RUN-NOT-STARTED",
  /**
   * Taxonomy persistence code (section 32.2): the assignment ledger could
   * not be written, so the evidence is infrastructure-invalid.
   */
  LedgerWriteFailed: "OAL-ARTIFACT-WRITE-FAILED"
} as const;

/** Operator-visible progress of one batch. */
export type BatchEvent =
  | {
      readonly type: "batch.started";
      readonly batchId: string;
      readonly trials: number;
      readonly parallel: number;
    }
  | { readonly type: "trial.started"; readonly runId: string }
  | {
      /** Stage progress relayed from one running trial. */
      readonly type: "trial.stage";
      readonly runId: string;
      readonly stage: LifecycleStage;
    }
  | {
      readonly type: "trial.finished";
      readonly runId: string;
      readonly disposition: TrialOutcome["disposition"];
      readonly reasonCode: string;
      /** Scrubbed spawn error when the driver process never started. */
      readonly spawnError?: string | null | undefined;
    }
  | {
      readonly type: "trial.not_started";
      readonly runId: string;
      readonly reasonCode: string;
    }
  | {
      readonly type: "batch.finished";
      readonly batchId: string;
      readonly completed: number;
      readonly censored: number;
    };

/** Options of {@link runBatch}. */
export interface BatchRunOptions {
  readonly store: ArtifactStore;
  readonly plan: FrozenPlan;
  readonly pack: LoadedPack;
  readonly adapter: AgentAdapter;
  readonly now: Clock;
  /** Injected exposure factory; the loopback gateway is the default. */
  readonly exposure?: ExposureFactory | undefined;
  /** Operator signal that aborts the batch and every running trial. */
  readonly signal?: AbortSignal | undefined;
  readonly operatorSignalName?: string | undefined;
  readonly gitInit?: boolean | undefined;
  readonly terminalTurnKind?: string | undefined;
  readonly onEvent?: ((event: BatchEvent) => void) | undefined;
}

/** Terminal summary of one batch. */
export interface BatchOutcome {
  readonly batchId: string;
  readonly count: number;
  readonly parallel: number;
  /** Terminal outcomes, in trial index order. */
  readonly outcomes: readonly TrialOutcome[];
  /** Run identifiers the batch never launched. */
  readonly notStartedRunIds: readonly string[];
  /** Cohort evaluation document, or null when no trial was launched. */
  readonly cohort: JsonObject | null;
  readonly manifestSha256: string;
  /** True when the operator signal stopped the batch early. */
  readonly aborted: boolean;
  /** Stable code of a batch-wide defect, or null. */
  readonly defectCode: string | null;
  readonly defectMessage: string | null;
}

/** The evidence requirement ids every trial of this build verifies. */
export const PRIMARY_REQUIREMENT_IDS: readonly string[] = [
  "api_trace",
  "lifecycle_ledger",
  "participant_surface_verification",
  "session_events",
  "final_state"
];

/**
 * Freeze the batch: write-once `batch.json`, the frozen inputs, the
 * participant surface template, and the evidence requirements.
 */
export async function createBatchSkeleton(
  store: ArtifactStore,
  plan: FrozenPlan,
  pack: LoadedPack,
  now: Clock
): Promise<void> {
  const base = `runs/${plan.batchId}`;
  if (await store.exists(`${base}/batch.json`)) {
    throw new Error(
      `Batch ${plan.batchId} already exists; existing identifiers are refused.`
    );
  }
  await store.initBatch(plan.batchId);

  // The per-text instructions and task digests cover the placeholder
  // preview, the same canonical texts every run.started.json of this
  // batch digests, so the records stay comparable.
  const inputs: Record<string, string> = {
    pack_sha256: plan.pack.packSha256,
    contract_original_sha256: plan.contract.entrypointSha256,
    contract_semantic_sha256: plan.contract.semanticSha256,
    contract_execution_sha256: plan.contract.executionSha256,
    capability_report_sha256: plan.contract.capabilityReportSha256,
    run_profile_sha256: canonicalJsonSha256(plan.profile as unknown as Json),
    prompt_sha256: plan.promptPreview.frozenSha256,
    instructions_sha256: sha256Hex(
      plan.promptPreview.prompts.instructions.text
    ),
    task_sha256: sha256Hex(plan.promptPreview.prompts.task.text),
    rubric_sha256: plan.evaluation.rubricSha256,
    ...(plan.evaluation.resultSchemaSha256 === null
      ? {}
      : { result_schema_sha256: plan.evaluation.resultSchemaSha256 })
  };
  const environmentNames = credentialEnvironmentNames(plan.contract.ir);
  const batch: JsonObject = {
    schema_version: 1,
    kind: "Batch",
    batch_id: plan.batchId,
    created_at: formatRfc3339(now()),
    run_ids: [...plan.trialRunIds],
    execution: {
      count: plan.count,
      parallel: plan.parallel,
      timeout_ms: plan.trialWallTimeMs,
      seed: plan.runSeedIdentifier,
      exposure: {
        mode: plan.exposureMode,
        contract_visibility:
          plan.contractVisibility === "tool-only"
            ? "none"
            : plan.contractVisibility,
        data_plane_scope: plan.dataPlaneScope
      },
      limits: {
        max_agent_tool_calls: plan.profile.limits.max_agent_tool_calls,
        max_api_requests: plan.profile.limits.max_api_requests,
        max_artifact_bytes: plan.profile.limits.max_artifact_bytes
      }
    },
    inputs,
    agent: {
      adapter: plan.adapter.id === "codex-cli" ? "codex-cli" : "generic",
      version: plan.adapter.probe.version,
      model: plan.adapter.model,
      effort: plan.adapter.effort === null ? null : plan.adapter.effort,
      sandbox: plan.adapter.sandbox
    },
    implementation: { runner_version: "0.1.0" },
    environment_names: [...environmentNames],
    extensions: {
      requested_exposure_mode: plan.exposureMode,
      requested_contract_visibility: plan.contractVisibility,
      requested_data_plane_scope: plan.dataPlaneScope,
      adapter_id: plan.adapter.id,
      eval_id: plan.evalId,
      prompt_set_id: plan.promptSetId,
      scenario_id: plan.scenarioId,
      cohort_seed: plan.cohortSeed,
      paid: plan.paid
    } as unknown as JsonObject
  };
  await store.writeOnce(
    `${base}/batch.json`,
    `${canonicalJson(batch as unknown as Json)}\n`
  );

  await writeFrozenInputs(store, plan, pack);
}

/** Copy every frozen input the batch layout of section 24.1 names. */
async function writeFrozenInputs(
  store: ArtifactStore,
  plan: FrozenPlan,
  pack: LoadedPack
): Promise<void> {
  const base = `runs/${plan.batchId}/inputs`;
  const byRole = (role: string): string | null => {
    const found = pack.references.find((reference) => reference.role === role);
    return found === undefined ? null : found.absolutePath;
  };
  const copy = async (target: string, source: string | null): Promise<void> => {
    if (source === null) {
      return;
    }
    const bytes = await readFile(source, "utf8");
    await store.writeOnce(`${base}/${target}`, bytes);
  };

  await copy("pack.frozen.yaml", `${pack.root}/${pack.manifestName}`);
  await copy("contract.original", byRole("contract_entrypoint"));
  await store.writeOnce(
    `${base}/contract.ir.json`,
    `${canonicalJson(plan.contract.ir as unknown as Json)}\n`
  );
  await store.writeOnce(
    `${base}/capability-report.json`,
    `${canonicalJson(plan.contract.capabilityReport as unknown as Json)}\n`
  );
  await store.writeOnce(
    `${base}/run-profile.frozen.yaml`,
    `${canonicalJson(plan.profile as unknown as Json)}\n`
  );
  await store.writeOnce(
    `${base}/rubric.frozen.yaml`,
    `${canonicalJson(plan.evaluation.evalDoc as unknown as Json)}\n`
  );
  if (plan.evaluation.resultSchema !== null) {
    await store.writeOnce(
      `${base}/result-schema.frozen.json`,
      `${canonicalJson(plan.evaluation.resultSchema)}\n`
    );
  }
  await store.writeOnce(
    `${base}/participant-surface-template.json`,
    `${canonicalJson(plan.surface.template)}\n`
  );
  await store.writeOnce(
    `${base}/instructions.frozen.md`,
    plan.promptPreview.prompts.instructions.text
  );
  await store.writeOnce(
    `${base}/task.frozen.md`,
    plan.promptPreview.prompts.task.text
  );
  await store.writeOnce(
    `${base}/prompt.frozen.txt`,
    plan.promptPreview.prompts.launch.text
  );
  await store.writeOnce(
    `${base}/evidence-requirements.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "EvidenceRequirements",
      eval_id: plan.evalId,
      requirements: [
        {
          metric_id: "primary_task_outcome",
          primary: true,
          streams: [
            "api",
            "lifecycle",
            "participant_surface",
            "state",
            "result_status"
          ],
          missingness: "unavailable_due_to_evidence"
        }
      ],
      extensions: {
        requirement_ids: [...PRIMARY_REQUIREMENT_IDS]
      } as unknown as JsonObject
    } as unknown as Json)}\n`
  );
}

/** One append-only assignment ledger record. */
interface AssignmentEvent {
  readonly kind: "launched" | "terminal" | "not_started";
  readonly runId: string | null;
  readonly disposition: TrialOutcome["disposition"] | null;
  readonly censorClass: CensorClass | null;
  readonly evidenceIntegrity: TrialOutcome["evidenceIntegrity"] | null;
  readonly reasonCode: string | null;
}

/** Serialize and append one assignment event, keeping the sequence. */
class AssignmentLedger {
  private sequence = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(
    private readonly sink: JsonlSink,
    private readonly batchId: string
  ) {}

  append(event: AssignmentEvent, now: Clock): void {
    this.sequence += 1;
    const record: JsonObject = {
      schema_version: 1,
      sequence: this.sequence,
      event_id: prefixedId24("asg", `${this.batchId}:${this.sequence}`),
      recorded_at: formatRfc3339(now()),
      study_run_id: this.batchId,
      batch_id: this.batchId,
      assignment_id: batchAssignmentId(this.batchId),
      kind: event.kind,
      run_id: null,
      ...(event.disposition === null ? {} : { disposition: event.disposition }),
      ...(event.censorClass === null
        ? {}
        : { censor_class: event.censorClass }),
      ...(event.evidenceIntegrity === null
        ? {}
        : { evidence_integrity: event.evidenceIntegrity }),
      ...(event.reasonCode === null ? {} : { reason_code: event.reasonCode }),
      extensions: { run_id: event.runId } as unknown as JsonObject
    };
    this.chain = this.chain.then(async () => {
      await this.sink.appendJson(record);
    });
    // Keep the chain alive for later appends, but remember the first
    // write failure: flush surfaces it instead of dropping the events.
    this.chain = this.chain.catch((error: unknown) => {
      if (this.failure === null) {
        this.failure = error;
      }
      return undefined;
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failure !== null) {
      throw toOalError(this.failure);
    }
  }
}

/**
 * The default exposure treatment of one batch. The response fixtures
 * the loaded pack declares reach the gateway on every branch, and
 * `discoverable` visibility serves the sanitized contract through the
 * conventional documentation candidates, so the facade hands out the
 * same bytes the `file` treatment would copy into the workspace. Both
 * behavior modes share this factory: scenario trials receive their
 * backend and store state through the per-trial exposure request.
 */
function defaultExposure(plan: FrozenPlan, pack: LoadedPack): ExposureFactory {
  if (plan.exposureMode !== "raw-http") {
    throw new Error(
      `The default runner exposure cannot execute ${plan.behaviorMode}/${plan.exposureMode}.`
    );
  }
  const fixtures = packResponseFixtures(pack);
  if (plan.contractVisibility !== "discoverable") {
    return createRawHttpExposure({ fixtures });
  }
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  )?.document;
  if (entry === undefined || entry === null) {
    return createRawHttpExposure({ fixtures });
  }
  const settings = contractSettings(pack);
  return createRawHttpExposure({
    visibility: "discoverable",
    fixtures,
    documentation: {
      sanitizedContract: (baseUrl: string) =>
        sanitizeParticipantContract(entry, settings, baseUrl, {
          entrypoint: plan.contract.entrypoint,
          documents: plan.contract.documents
        }).text,
      candidates: { openapi: true }
    }
  });
}

/**
 * Run every trial of one frozen batch. The batch always finalizes: an
 * operator signal records `not_started` for unlaunched trials, and a
 * batch-wide defect fails fast the same way before the error surfaces.
 */
export async function runBatch(
  options: BatchRunOptions
): Promise<BatchOutcome> {
  const { store, plan, pack, adapter, now } = options;
  await createBatchSkeleton(store, plan, pack, now);
  const ledger = new AssignmentLedger(
    await store.openSink(`runs/${plan.batchId}/assignment-events.jsonl`),
    plan.batchId
  );
  const exposure = options.exposure ?? defaultExposure(plan, pack);
  const outcomes: Array<TrialOutcome | null> = Array.from(
    { length: plan.count },
    (): TrialOutcome | null => null
  );
  // Trial indices whose launch the ledger already recorded. A launch that
  // then fails must never be reported as not started.
  const launchedIndices = new Set<number>();
  let nextIndex = 0;
  // A holder, not two captured `let` bindings, so the narrowing the batch
  // applies after the workers join stays sound.
  const defect: { code: string | null; message: string | null } = {
    code: null,
    message: null
  };

  options.onEvent?.({
    type: "batch.started",
    batchId: plan.batchId,
    trials: plan.count,
    parallel: plan.parallel
  });

  const launchTrial = async (index: number): Promise<void> => {
    const runId = plan.trialRunIds[index];
    if (runId === undefined) {
      return;
    }
    ledger.append(
      {
        kind: "launched",
        runId,
        disposition: null,
        censorClass: null,
        evidenceIntegrity: null,
        reasonCode: null
      },
      now
    );
    launchedIndices.add(index);
    try {
      const outcome = await runTrial({
        store,
        plan,
        pack,
        adapter,
        index,
        exposure,
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.operatorSignalName === undefined
          ? {}
          : { operatorSignalName: options.operatorSignalName }),
        ...(options.gitInit === undefined ? {} : { gitInit: options.gitInit }),
        ...(options.terminalTurnKind === undefined
          ? {}
          : { terminalTurnKind: options.terminalTurnKind }),
        ...(options.onEvent === undefined
          ? {}
          : {
              onEvent: (event: TrialEvent): void => {
                // The batch emits its own start and finish records, so the
                // relay forwards only the stage events it does not repeat.
                if (event.type === "trial.stage") {
                  options.onEvent?.(event);
                }
              }
            })
      });
      outcomes[index] = outcome;
      ledger.append(
        {
          kind: "terminal",
          runId,
          disposition: outcome.disposition,
          censorClass: outcome.censorClass,
          evidenceIntegrity: outcome.evidenceIntegrity,
          reasonCode: outcome.reasonCode
        },
        now
      );
      options.onEvent?.({
        type: "trial.finished",
        runId,
        disposition: outcome.disposition,
        reasonCode: outcome.reasonCode,
        ...(outcome.spawnError == null
          ? {}
          : { spawnError: outcome.spawnError })
      });
    } catch (cause) {
      // A confirmed batch-wide defect: stop launching, mark the rest
      // not started, then surface the error after finalization.
      defect.code = RunCode.BatchDefect;
      defect.message = cause instanceof Error ? cause.message : String(cause);
      outcomes[index] = null;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (
        defect.code !== null ||
        options.signal?.aborted === true ||
        nextIndex >= plan.count
      ) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      await launchTrial(index);
    }
  };
  const lanes = Array.from(
    { length: Math.max(1, Math.min(plan.parallel, plan.count)) },
    () => worker()
  );
  await Promise.all(lanes);

  const notStartedRunIds: string[] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index] !== null) {
      continue;
    }
    const runId = plan.trialRunIds[index];
    if (runId === undefined) {
      continue;
    }
    if (!launchedIndices.has(index)) {
      notStartedRunIds.push(runId);
      continue;
    }
    // A trial that launched and then failed keeps an accurate terminal
    // record, derived from its persisted lifecycle facts (section 32.4):
    // harness aborted, never a not_started claim that contradicts the
    // launched event the ledger already holds. Its evidence stays.
    const aborted = await abortedTrialOutcome(
      store,
      plan,
      index,
      runId,
      defect.code === null ? RunCode.BatchAborted : defect.code,
      now
    );
    outcomes[index] = aborted;
    ledger.append(
      {
        kind: "terminal",
        runId,
        disposition: aborted.disposition,
        censorClass: aborted.censorClass,
        evidenceIntegrity: aborted.evidenceIntegrity,
        reasonCode: aborted.reasonCode
      },
      now
    );
    options.onEvent?.({
      type: "trial.finished",
      runId,
      disposition: aborted.disposition,
      reasonCode: aborted.reasonCode
    });
  }
  const launched = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter((entry) => entry.outcome !== null);
  for (const notStartedRunId of notStartedRunIds) {
    ledger.append(
      {
        kind: "not_started",
        runId: notStartedRunId,
        disposition: "not_started",
        censorClass: "pre_control_nonparticipant",
        evidenceIntegrity: "missing",
        reasonCode: defect.code !== null ? defect.code : RunCode.BatchAborted
      },
      now
    );
    options.onEvent?.({
      type: "trial.not_started",
      runId: notStartedRunId,
      reasonCode: defect.code !== null ? defect.code : RunCode.BatchAborted
    });
  }
  try {
    await ledger.flush();
  } catch (cause) {
    // Section 32.2 persistence: a ledger the batch cannot write is
    // infrastructure-invalid evidence, so the run fails with the taxonomy
    // code instead of silently dropping the assignment events.
    defect.code = RunCode.LedgerWriteFailed;
    defect.message = cause instanceof Error ? cause.message : String(cause);
  }

  const terminal = launched.map((entry) => entry.outcome as TrialOutcome);
  const cohort =
    terminal.length === 0
      ? null
      : buildCohortEvaluation(plan, terminal, notStartedRunIds, now);
  if (cohort !== null) {
    await store.atomicWrite(
      `runs/${plan.batchId}/cohort-evaluation.json`,
      `${canonicalJson(cohort as unknown as Json)}\n`
    );
  }

  await store.writeManifest({
    scopeDir: `runs/${plan.batchId}`,
    level: "batch",
    id: plan.batchId,
    batchId: plan.batchId,
    createdAt: formatRfc3339(now())
  });
  const manifestText = await store.read(
    `runs/${plan.batchId}/artifact-manifest.json`
  );
  const manifestSha256 = sha256Hex(manifestText);
  await store.writeOnce(
    `runs/${plan.batchId}/batch.completed.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "BatchCompleted",
      batch_id: plan.batchId,
      finished_at: formatRfc3339(now()),
      manifest_path: `runs/${plan.batchId}/artifact-manifest.json`,
      manifest_sha256: manifestSha256,
      launched_trials: terminal.length,
      not_started_trials: notStartedRunIds.length,
      ...(cohort === null
        ? {}
        : { cohort_sha256: canonicalJsonSha256(cohort as unknown as Json) }),
      ...(defect.code === null ? {} : { defect_code: defect.code }),
      extensions: {}
    } as unknown as Json)}\n`
  );

  const censored = terminal.filter(
    (outcome) => outcome.censorClass !== "none"
  ).length;
  options.onEvent?.({
    type: "batch.finished",
    batchId: plan.batchId,
    completed: terminal.length,
    censored
  });

  return {
    batchId: plan.batchId,
    count: plan.count,
    parallel: plan.parallel,
    outcomes: terminal,
    notStartedRunIds,
    cohort,
    manifestSha256,
    aborted: options.signal?.aborted === true && notStartedRunIds.length > 0,
    defectCode: defect.code,
    defectMessage: defect.message
  };
}

/**
 * Terminal outcome of a trial that launched and then failed before its
 * own terminal record landed. Stage facts come from the persisted
 * lifecycle ledger; a missing or unreadable ledger leaves every fact
 * unset, so derivation never guesses control that no evidence shows.
 */
async function abortedTrialOutcome(
  store: ArtifactStore,
  plan: FrozenPlan,
  index: number,
  runId: string,
  reasonCode: string,
  now: Clock
): Promise<TrialOutcome> {
  const relativeRoot = `runs/${plan.batchId}/trials/${runId}`;
  const stages = await recoveredStages(store, relativeRoot);
  const requirements: EvidenceRequirement[] = PRIMARY_REQUIREMENT_IDS.map(
    (id) => ({ id, status: "missing" })
  );
  const censor = classifyCensorClass({
    disposition: "harness_aborted",
    controlStarted: stages.has("participant_control_started"),
    requirements
  });
  return {
    runId,
    batchId: plan.batchId,
    index,
    disposition: "harness_aborted",
    reasonCode,
    censorClass: censor.censorClass,
    censorReasonCode: censor.reasonCode,
    evidenceIntegrity: evidenceIntegrityOf(requirements),
    controlStarted: stages.has("participant_control_started"),
    spawned: stages.has("participant_spawned"),
    turnCompleted: stages.has("turn_completed"),
    reportStatus: "unavailable_due_to_infrastructure",
    reportSha256: null,
    evaluation: null,
    usageObserved: false,
    apiRequests: 0,
    agentToolCalls: null,
    exit: null,
    startedAtMs: 0,
    finishedAtMs: now()
  };
}

/** Stage facts recovered from one trial's persisted lifecycle ledger. */
async function recoveredStages(
  store: ArtifactStore,
  relativeRoot: string
): Promise<ReadonlySet<string>> {
  const text = await settledLifecycleText(store, relativeRoot);
  if (text === null) {
    return new Set<string>();
  }
  try {
    const events: LifecycleEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      events.push(parseJsonStrict(line) as unknown as LifecycleEvent);
    }
    return snapshotOfRecords(stageRecordsOf(events)).stages;
  } catch {
    return new Set<string>();
  }
}

/**
 * Read one trial's lifecycle ledger after its queued appends land. The
 * throw route of a trial ends before its own stage-queue flush, and the
 * store exposes no drain for the writes still in flight, so a slow disk
 * can leave each append several event-loop turns away when the batch
 * derives the recovered disposition. One macrotask round trip of quiet
 * is not enough, because it can fall inside a gap between two appends
 * that are still in flight: the text counts as settled only after it
 * stays equal across two consecutive round trips, each one immediate
 * queue plus one timer turn. A trial that already threw stops growing,
 * and the turn bound below ends a ledger that never goes quiet.
 */
async function settledLifecycleText(
  store: ArtifactStore,
  relativeRoot: string
): Promise<string | null> {
  const read = (): Promise<string | null> =>
    store.read(`${relativeRoot}/lifecycle.jsonl`).catch(() => null);
  // The bound covers every write-once stage plus the confirming reads,
  // so the loop terminates even if the ledger never settles.
  const bound = ORDERED_STAGES.length + 2;
  // Consecutive round trips of unchanged text that mark the ledger quiet.
  const quietRounds = 2;
  let previous = await read();
  let confirmed = 0;
  for (let turn = 0; turn < bound; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Quiescence spans a full macrotask round trip, not only the
    // immediate queue: appends that are turns in flight land during the
    // timer wait, so equal reads compare across genuine quiet.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const current = await read();
    confirmed = current === previous ? confirmed + 1 : 0;
    previous = current;
    if (confirmed >= quietRounds) {
      return current;
    }
  }
  return previous;
}

/** Build the batch cohort evaluation of section 27.3. */
export function buildCohortEvaluation(
  plan: FrozenPlan,
  outcomes: readonly TrialOutcome[],
  notStartedRunIds: readonly string[],
  now: Clock
): JsonObject {
  const dispositions: Record<string, number> = {};
  for (const outcome of outcomes) {
    dispositions[outcome.disposition] =
      (dispositions[outcome.disposition] ?? 0) + 1;
  }
  if (notStartedRunIds.length > 0) {
    dispositions["not_started"] =
      (dispositions["not_started"] ?? 0) + notStartedRunIds.length;
  }
  const integrity = { intact: 0, corrupt: 0, missing: 0 };
  const censors = {
    none: 0,
    pre_control_nonparticipant: 0,
    administrative_censor: 0,
    instrumentation_censor: 0
  };
  const reports = {
    absent: 0,
    malformed: 0,
    schema_invalid: 0,
    valid: 0,
    unavailable_due_to_infrastructure: 0
  };
  const taskOutcomes = {
    passed: 0,
    failed: 0,
    partial: 0,
    indeterminate: 0,
    not_evaluated: 0
  };
  for (const outcome of outcomes) {
    integrity[outcome.evidenceIntegrity] += 1;
    censors[outcome.censorClass] += 1;
    reports[outcome.reportStatus] += 1;
    if (outcome.evaluation === null) {
      taskOutcomes.not_evaluated += 1;
    } else if (outcome.evaluation.status === "passed") {
      taskOutcomes.passed += 1;
    } else if (outcome.evaluation.status === "failed") {
      taskOutcomes.failed += 1;
    } else {
      taskOutcomes.indeterminate += 1;
    }
  }
  taskOutcomes.not_evaluated += notStartedRunIds.length;

  const perRun = outcomes.map((outcome) => ({
    run_id: outcome.runId,
    status:
      outcome.evaluation === null
        ? "skipped"
        : outcome.evaluation.status === "passed"
          ? "passed"
          : outcome.evaluation.status === "failed"
            ? "failed"
            : outcome.evaluation.status === "error"
              ? "error"
              : "skipped",
    score: outcome.evaluation?.score ?? null,
    disposition: outcome.disposition,
    evidence_integrity: outcome.evidenceIntegrity
  }));

  const controlStarted = outcomes.filter(
    (outcome) => outcome.controlStarted
  ).length;
  const apiBehavior = outcomes.filter(
    (outcome) =>
      outcome.controlStarted && outcome.evidenceIntegrity === "intact"
  ).length;
  const taskEvaluation = outcomes.filter(
    (outcome) => outcome.evaluation !== null
  ).length;
  const usageObserved = outcomes.filter(
    (outcome) => outcome.usageObserved
  ).length;
  // Section 27.3 defines the agreement denominator as trials reaching
  // turn_completed, so a valid report without a completed turn never
  // counts and a completed turn with a malformed report still does.
  const reportAgreement = outcomes.filter(
    (outcome) => outcome.turnCompleted
  ).length;
  const warnings: string[] = [];
  if (outcomes.some((outcome) => outcome.evidenceIntegrity !== "intact")) {
    warnings.push("At least one trial ended with non-intact evidence.");
  }
  if (notStartedRunIds.length > 0) {
    warnings.push(
      `${notStartedRunIds.length} assigned trial or trials never started.`
    );
  }

  return {
    schema_version: 1,
    kind: "CohortEvaluation",
    batch_id: plan.batchId,
    created_at: formatRfc3339(now()),
    denominators: {
      primary_assignment_count: plan.count,
      activated_replacement_count: 0,
      operational_assignment_count: plan.count,
      launched_trial_count: outcomes.length,
      not_started_count: notStartedRunIds.length,
      participant_control_started_count: controlStarted,
      primary_agent_outcome_count: controlStarted,
      api_behavior_count: apiBehavior,
      task_evaluation_count: taskEvaluation,
      report_agreement_count: reportAgreement,
      usage_observed_count: usageObserved,
      valid_evaluation_count: taskEvaluation,
      held_unused_count: 0
    },
    dispositions,
    evidence_integrity: integrity,
    censor_classes: censors,
    task_outcomes: taskOutcomes,
    participant_report_status: reports,
    checks: [],
    signals: [],
    per_run: perRun,
    warnings,
    extensions: {
      eval_id: plan.evalId,
      adapter_id: plan.adapter.id,
      primary_requirement_ids: [...PRIMARY_REQUIREMENT_IDS]
    } as unknown as JsonObject
  };
}

/**
 * Derive the censor facts of one trial outcome, for operators that need
 * the same derivation outside finalization.
 */
export function censorOf(outcome: TrialOutcome): {
  readonly censorClass: CensorClass;
  readonly failedRequirements: readonly string[];
} {
  const requirements: EvidenceRequirement[] = PRIMARY_REQUIREMENT_IDS.map(
    (id) => ({
      id,
      status:
        outcome.evidenceIntegrity === "intact"
          ? "ok"
          : outcome.evidenceIntegrity === "corrupt"
            ? "corrupt"
            : "missing"
    })
  );
  const censor = classifyCensorClass({
    disposition: outcome.disposition,
    controlStarted: outcome.controlStarted,
    requirements
  });
  return {
    censorClass: censor.censorClass,
    failedRequirements: censor.failedRequirements
  };
}
