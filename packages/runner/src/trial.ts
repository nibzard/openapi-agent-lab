/**
 * One trial end to end (specification sections 22.2 through 22.4):
 * setup, exposure, adapter run with bounded capture, participant report,
 * deterministic evaluation, terminal disposition, and the trial artifact
 * manifest followed by the write-once `run.completed.json`.
 *
 * Every recorded timestamp comes from the injected clock. The only real
 * timer is the wall-time guard, and even that guard reads the injected
 * clock for the fact it persists.
 */

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
import type {
  ArtifactStore,
  DocumentationExchange,
  EvidenceIntegrityFlag,
  JsonlSink,
  LifecycleEvidenceSource,
  LifecycleStage,
  TerminalDisposition,
  TraceEvent
} from "@oal/evidence";
import type {
  AgentAdapter,
  AgentRunContext,
  AgentRunResult,
  AgentSessionEvent,
  AgentStartedPayload,
  AgentStreamPayload
} from "@oal/agent-adapter";
import { evaluateRubric, toEvaluation, type Evaluation } from "@oal/evaluator";
import type { LoadedPack } from "@oal/pack";

import {
  classifyCensorClass,
  classifyDisposition,
  DispositionCode,
  evidenceIntegrityOf
} from "./disposition.ts";
import type {
  CensorClass,
  EvidenceRequirement,
  FailureFact,
  OperatorSignalFact
} from "./disposition.ts";
import type { TrialLifecycle, Clock } from "./lifecycle.ts";
import { packDocumentOf, type FrozenPlan } from "./preflight.ts";
import {
  collectParticipantReport,
  ReportCode,
  type ReportOutcome
} from "./participant-report.ts";
import {
  SetupCode,
  setupTrial,
  TrialSetupError,
  type ExposureFactory,
  type TrialSetup
} from "./setup.ts";
import { verifyWorkspaceFiles } from "./workspace.ts";

/** Stable reason codes of the trial runner. */
export const TrialCode = {
  SetupFailed: SetupCode.SetupFailed,
  TraceCorrupt: "OAL-RUN-TRIAL-TRACE-CORRUPT",
  EvaluationSkipped: "OAL-RUN-TRIAL-EVALUATION-SKIPPED",
  EvaluationFailed: "OAL-RUN-TRIAL-EVALUATION-FAILED",
  WorkspaceFailed: "OAL-RUN-TRIAL-WORKSPACE-FAILED",
  ExposurePersistFailed: "OAL-EXPOSURE-EXCHANGE-PERSIST-FAILED",
  NotStarted: "OAL-RUN-NOT-STARTED"
} as const;

/** Session event kind the adapter documents as its terminal turn. */
export const DEFAULT_TERMINAL_TURN_KIND = "turn.completed";

/** Session event kind adapters use for a participant API request. */
export const API_REQUEST_EVENT_KIND = "http.request";

/** Operator-visible progress of one trial. */
export type TrialEvent =
  | { readonly type: "trial.started"; readonly runId: string }
  | {
      readonly type: "trial.stage";
      readonly runId: string;
      readonly stage: LifecycleStage;
    }
  | {
      readonly type: "trial.finished";
      readonly runId: string;
      readonly disposition: TerminalDisposition;
      readonly reasonCode: string;
    };

/** Options of {@link runTrial}. */
export interface TrialRunOptions {
  readonly store: ArtifactStore;
  readonly plan: FrozenPlan;
  readonly pack: LoadedPack;
  readonly adapter: AgentAdapter;
  /** Zero-based trial index inside the frozen batch. */
  readonly index: number;
  /** Injected exposure factory; the loopback gateway is the default. */
  readonly exposure: ExposureFactory;
  readonly now: Clock;
  /** Operator signal that aborts the trial and the batch. */
  readonly signal?: AbortSignal | undefined;
  /** Signal name recorded with the operator signal fact. */
  readonly operatorSignalName?: string | undefined;
  readonly retryOf?: string | null | undefined;
  readonly gitInit?: boolean | undefined;
  /**
   * Session event kind this adapter documents as its successful terminal
   * turn. Default {@link DEFAULT_TERMINAL_TURN_KIND}.
   */
  readonly terminalTurnKind?: string | undefined;
  /** Progress sink for operator-visible output. */
  readonly onEvent?: ((event: TrialEvent) => void) | undefined;
}

/** Terminal summary of one trial, for aggregation by the batch runner. */
export interface TrialOutcome {
  readonly runId: string;
  readonly batchId: string;
  readonly index: number;
  readonly disposition: TerminalDisposition;
  readonly reasonCode: string;
  readonly censorClass: CensorClass;
  readonly censorReasonCode: string;
  readonly evidenceIntegrity: EvidenceIntegrityFlag;
  readonly controlStarted: boolean;
  readonly spawned: boolean;
  readonly turnCompleted: boolean;
  readonly reportStatus:
    | "absent"
    | "malformed"
    | "schema_invalid"
    | "valid"
    | "unavailable_due_to_infrastructure";
  readonly reportSha256: string | null;
  readonly evaluation: {
    readonly status: string;
    readonly score: number | null;
    readonly passedWeight: number;
    readonly totalWeight: number;
    readonly valid: boolean;
  } | null;
  readonly usageObserved: boolean;
  readonly apiRequests: number;
  readonly agentToolCalls: number | null;
  readonly exit: {
    readonly code: number | null;
    readonly signal: string | null;
  } | null;
  /**
   * Spawn error text the adapter already scrubbed for the exited event,
   * or absent when the driver process started.
   */
  readonly spawnError?: string | null | undefined;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/** Fact store the session sink maintains while the adapter runs. */
interface SessionFacts {
  spawned: boolean;
  modelStarted: boolean;
  apiStarted: boolean;
  turnCompleted: boolean;
}

/**
 * Serialized stage recorder. Session events arrive synchronously while the
 * ledger appends asynchronously, so every fact joins one ordered chain and
 * each stage is offered at most once.
 */
class StageQueue {
  private readonly offered = new Set<LifecycleStage>();
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(
    private readonly lifecycle: TrialLifecycle,
    private readonly now: Clock
  ) {}

  /** Whether one stage was already offered or recorded. */
  holds(stage: LifecycleStage): boolean {
    return (
      this.offered.has(stage) || this.lifecycle.snapshot().stages.has(stage)
    );
  }

  /** Queue one stage fact; duplicates are ignored. */
  offer(
    stage: LifecycleStage,
    source: LifecycleEvidenceSource,
    details: Record<string, string | number | boolean>
  ): void {
    if (this.holds(stage)) {
      return;
    }
    this.offered.add(stage);
    this.chain = this.chain.then(async () => {
      if (this.failure !== null) {
        return;
      }
      if (this.lifecycle.snapshot().stages.has(stage)) {
        return;
      }
      await this.lifecycle.record(stage, source, details, this.now);
    });
    this.chain = this.chain.catch((error: unknown) => {
      this.failure = error;
      return undefined;
    });
  }

  /** Wait for every queued fact, then surface the first failure. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.failure !== null) {
      throw toOalError(this.failure);
    }
  }
}

/** Serialized JSONL writer for the redacted session stream. */
class SessionWriter {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(private readonly sink: JsonlSink) {}

  append(event: AgentSessionEvent): void {
    this.chain = this.chain.then(async () => {
      if (this.failure === null) {
        await this.sink.appendJson(event as unknown as Json);
      }
    });
    this.chain = this.chain.catch((error: unknown) => {
      this.failure = error;
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

function usageNumbersOf(
  result: AgentRunResult
): Readonly<Record<string, number>> {
  if (result.usage === undefined) {
    return {};
  }
  const numbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(result.usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers[key] = value;
    }
  }
  return numbers;
}

function failureFactOf(result: AgentRunResult): FailureFact | null {
  if (result.status === "provider_failed") {
    return { kind: "provider", code: DispositionCode.ProviderFailed };
  }
  if (result.errorCode === "AGENT_PROVIDER_FAILED") {
    return { kind: "provider", code: DispositionCode.ProviderFailed };
  }
  if (
    result.errorCode === "AGENT_SPAWN_FAILED" ||
    result.errorCode === "AGENT_STARTUP_FAILED"
  ) {
    return {
      kind: "infrastructure",
      code: DispositionCode.InfrastructureFailed
    };
  }
  return null;
}

function reportStatusOf(report: ReportOutcome): TrialOutcome["reportStatus"] {
  if (report.status === "ok") {
    return "valid";
  }
  switch (report.problem.code) {
    case ReportCode.Missing:
    case ReportCode.SourceUnknown:
      return "absent";
    case ReportCode.SchemaInvalid:
      return "schema_invalid";
    default:
      return "malformed";
  }
}

function secretsOf(setup: TrialSetup): readonly string[] {
  const values = [
    setup.credentials.bearer,
    setup.credentials.basic.username,
    setup.credentials.basic.password,
    ...Object.values(setup.credentials.apiKeys)
  ];
  return values.filter(
    (value) => typeof value === "string" && value.length > 0
  );
}

/**
 * Run one trial from setup to the terminal record. The function resolves
 * with a terminal outcome for every trial-local condition, including setup
 * defects, timeouts, and adapter failure. It throws only for a programmer
 * error or an unusable store.
 */
export async function runTrial(
  options: TrialRunOptions
): Promise<TrialOutcome> {
  const { store, plan, pack, adapter, index, now } = options;
  const runId = plan.trialRunIds[index];
  if (runId === undefined) {
    throw new Error(`Trial index ${index} is outside the frozen batch.`);
  }
  const relativeRoot = `runs/${plan.batchId}/trials/${runId}`;
  const startedAtMs = now();
  options.onEvent?.({ type: "trial.started", runId });

  let setup: TrialSetup;
  try {
    setup = await setupTrial({
      store,
      plan,
      pack,
      index,
      exposure: options.exposure,
      now,
      ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
      ...(options.gitInit === undefined ? {} : { gitInit: options.gitInit })
    });
  } catch (cause) {
    if (cause instanceof TrialSetupError) {
      const outcome = await finalizeSetupFailure(store, plan, index, cause);
      options.onEvent?.({
        type: "trial.finished",
        runId,
        disposition: outcome.disposition,
        reasonCode: outcome.reasonCode
      });
      return outcome;
    }
    throw cause;
  }

  const terminalTurnKind =
    options.terminalTurnKind ?? DEFAULT_TERMINAL_TURN_KIND;
  const stages = new StageQueue(setup.lifecycle, now);
  let session: SessionWriter;
  try {
    session = new SessionWriter(
      await store.openSink(`${relativeRoot}/session/events.redacted.jsonl`)
    );
  } catch (cause) {
    await setup.exposure.close().catch(() => undefined);
    throw cause;
  }
  const facts: SessionFacts = {
    spawned: false,
    modelStarted: false,
    apiStarted: false,
    turnCompleted: false
  };

  // Signal facts live on a holder because two callbacks assign them; the
  // narrowing after the run must still see the widened types.
  const signals: {
    operator: OperatorSignalFact | null;
    timeoutFiredAtMs: number | null;
  } = { operator: null, timeoutFiredAtMs: null };
  const controller = new AbortController();
  const signalName = options.operatorSignalName ?? "SIGINT";
  const onOperatorAbort = (): void => {
    signals.operator = { signal: signalName, receivedAtMs: now() };
    stages.offer("operator_signal_received", "operator", {
      signal: signalName
    });
    controller.abort();
  };
  options.signal?.addEventListener("abort", onOperatorAbort, { once: true });
  const guard = setTimeout(() => {
    signals.timeoutFiredAtMs = now();
    controller.abort();
  }, plan.trialWallTimeMs);

  let result: AgentRunResult;
  try {
    const context = buildRunContext(options, setup);
    const prepared = await adapter.prepare(context);
    result = await adapter.run(
      prepared,
      buildEventSink(session, stages, facts, terminalTurnKind),
      controller.signal
    );
    await adapter.cleanup?.(prepared).catch(() => undefined);
  } finally {
    clearTimeout(guard);
    options.signal?.removeEventListener("abort", onOperatorAbort);
    // Finalization step 1 and 5, on every exit route: adapter throw,
    // launch failure, timeout, cancellation, or completion. Closing here
    // keeps the port from leaking when the run above throws.
    await setup.exposure.close().catch(() => undefined);
  }

  if (result.status === "timed_out" && signals.timeoutFiredAtMs === null) {
    signals.timeoutFiredAtMs = now();
  }

  await stages.flush();
  await session.flush();

  // Finalization step 7: capture and validate the participant output.
  const report = await collectParticipantReport(
    reportSourceOf(options.plan, setup, result),
    {
      reportDir: setup.layout.root,
      resultSchema: plan.evaluation.resultSchema,
      secrets: secretsOf(setup)
    }
  );
  const reportText = report.status === "ok" ? report.text : (report.text ?? "");
  const allowedWorkspaceOutputs =
    plan.evaluation.evalDoc.result.source === "workspace_file" &&
    typeof plan.evaluation.evalDoc.result.filename === "string"
      ? [plan.evaluation.evalDoc.result.filename]
      : [];
  let workspaceProblem: { code: string; message: string } | null = null;
  try {
    await verifyWorkspaceFiles(
      setup.layout.workspaceDir,
      setup.workspace.files,
      allowedWorkspaceOutputs,
      true
    );
  } catch (cause) {
    const problem = toOalError(cause);
    workspaceProblem = { code: problem.code, message: problem.message };
  }
  await store.atomicWrite(
    `${relativeRoot}/participant-surface-verification.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "ParticipantSurfaceVerification",
      run_id: runId,
      manifest_sha256: setup.surface.manifestSha256,
      template_sha256: plan.surface.templateSha256,
      ok: workspaceProblem === null,
      problems:
        workspaceProblem === null
          ? []
          : [
              {
                code: workspaceProblem.code,
                path: "workspace",
                message: workspaceProblem.message
              }
            ]
    } as unknown as Json)}\n`
  );
  if (reportText.length > 0) {
    stages.offer("report_present", "runner", {
      source: report.status === "ok" ? report.source : report.problem.code
    });
  }
  if (report.status === "ok") {
    stages.offer("report_valid", "runner", { source: report.source });
  }

  stages.offer("finalization_started", "runner", {
    disposition_pending: true
  });
  await stages.flush();

  const trace = await readTraceEvents(store, relativeRoot);
  const documentationEvents = await readDocumentationEvents(
    store,
    relativeRoot
  );
  const usage = usageNumbersOf(result);
  const apiRequests = trace.events.length;

  // Final state and usage payloads precede the evaluation.
  const finalState: JsonObject = {};
  await store.atomicWrite(
    `${relativeRoot}/state.final.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "StateFinal",
      run_id: runId,
      revision: 0,
      state: finalState
    } as Json)}\n`
  );
  await store.atomicWrite(
    `${relativeRoot}/state.summary.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "StateSummary",
      run_id: runId,
      state_schema_version: 1,
      revision: 0,
      state_sha256: canonicalJsonSha256(finalState as Json),
      projections: { empty_state: true },
      counts: { api_requests: apiRequests },
      redacted: true,
      extensions: {}
    } as Json)}\n`
  );
  if (reportText.length > 0) {
    await store.atomicWrite(
      `${relativeRoot}/participant-final.txt`,
      reportText
    );
  }
  await store.atomicWrite(
    `${relativeRoot}/resource-usage.json`,
    `${canonicalJson(resourceUsageOf(runId, plan, result, usage, apiRequests))}\n`
  );

  // Finalization step 11: deterministic evaluation when evidence permits.
  let evaluation: Evaluation | null = null;
  let evaluationSkipCode: string | null = null;
  if (trace.corrupt) {
    evaluationSkipCode = TrialCode.TraceCorrupt;
  } else {
    try {
      const evaluated = evaluateRubric({
        rubric: plan.evaluation.rubric,
        runId,
        run: runMetadataOf(options.plan, setup, adapter.id),
        events: trace.events,
        state: finalState as Json,
        report: report.status === "ok" ? report.value : null,
        resolveSchema: (reference: string): Json | undefined =>
          packDocumentOf(pack, reference),
        evaluatedAt: formatRfc3339(now())
      });
      evaluation = toEvaluation(evaluated);
    } catch {
      evaluationSkipCode = TrialCode.EvaluationFailed;
    }
  }
  if (evaluation !== null) {
    await store.atomicWrite(
      `${relativeRoot}/evaluation.json`,
      `${canonicalJson(evaluation as unknown as Json)}\n`
    );
  }

  // Finalization step 10: disposition, integrity, and censor class.
  const snapshot = setup.lifecycle.snapshot();
  const exposureFailed = (setup.exposure.exchangeFailureCount ?? 0) > 0;
  const failure: FailureFact | null = exposureFailed
    ? { kind: "infrastructure", code: TrialCode.ExposurePersistFailed }
    : failureFactOf(result);
  const classified = classifyDisposition({
    snapshot: { stages: snapshot.stages },
    operatorSignal: signals.operator,
    timeoutFiredAtMs: signals.timeoutFiredAtMs,
    budgetExhaustedAtMs: null,
    invalidSetupCode: null,
    failure,
    exit: { code: result.exitCode, signal: result.signal },
    notStarted: false,
    unfinalizedLedger: false
  });
  await setup.lifecycle.record(
    "evidence_finalized",
    "runner",
    { disposition: classified.disposition },
    now
  );

  // The ledger requirement reads the finalized ledger, so it must run after
  // the terminal stage fact lands.
  const requirements = await evidenceRequirementsOf(
    store,
    relativeRoot,
    setup,
    trace.corrupt || exposureFailed
  );
  const censor = classifyCensorClass({
    disposition: classified.disposition,
    controlStarted: snapshot.stages.has("participant_control_started"),
    requirements
  });

  // Finalization steps 12 and 13: manifest, then the terminal record.
  await store.writeManifest({
    scopeDir: relativeRoot,
    level: "trial",
    id: runId,
    runId,
    batchId: plan.batchId,
    createdAt: formatRfc3339(now())
  });
  const manifestText = await store.read(
    `${relativeRoot}/artifact-manifest.json`
  );
  const completed: JsonObject = {
    schema_version: 1,
    kind: "RunCompleted",
    run_id: runId,
    batch_id: plan.batchId,
    finished_at: formatRfc3339(now()),
    disposition: classified.disposition,
    disposition_reason: classified.reasonCode,
    evidence_integrity: evidenceIntegrityOf(requirements),
    censor_class: censor.censorClass,
    censor_reasons: [censor.reasonCode],
    failed_requirement_ids: [...censor.failedRequirements],
    artifact_manifest_sha256: sha256Hex(manifestText),
    manifest_path: `${relativeRoot}/artifact-manifest.json`,
    manifest_sha256: sha256Hex(manifestText),
    missing_artifacts: missingArtifactsOf(requirements) as unknown as Json,
    counts: {
      api_requests: apiRequests,
      documentation_requests: documentationEvents.length,
      semantic_events: 0,
      agent_tool_calls:
        typeof usage["tool_calls"] === "number" ? usage["tool_calls"] : null
    },
    ...(evaluation === null
      ? {}
      : {
          evaluation: {
            status: evaluation.status,
            score: evaluation.score,
            evaluation_sha256: canonicalJsonSha256(
              evaluation as unknown as Json
            )
          }
        }),
    participant_report: {
      status: reportStatusOf(report),
      report_sha256: report.status === "ok" ? report.textSha256 : null
    },
    agent: {
      exit_code: result.exitCode,
      signal: result.signal,
      graceful: result.status === "completed"
    },
    extensions: {
      adapter_id: adapter.id,
      adapter_status: result.status,
      ...(result.errorCode === undefined
        ? {}
        : { adapter_error_code: result.errorCode }),
      ...(result.spawnError == null ? {} : { spawn_error: result.spawnError }),
      ...(evaluationSkipCode === null
        ? {}
        : { evaluation_skip_code: evaluationSkipCode }),
      started_at: formatRfc3339(startedAtMs),
      surface_problems: setup.surfaceProblems.length,
      timeout_fired: signals.timeoutFiredAtMs !== null,
      operator_signal: signals.operator !== null
    } as unknown as JsonObject
  };
  await store.writeOnce(
    `${relativeRoot}/run.completed.json`,
    `${canonicalJson(completed as unknown as Json)}\n`
  );

  const finishedAtMs = now();
  options.onEvent?.({
    type: "trial.finished",
    runId,
    disposition: classified.disposition,
    reasonCode: classified.reasonCode
  });
  return {
    runId,
    batchId: plan.batchId,
    index,
    disposition: classified.disposition,
    reasonCode: classified.reasonCode,
    censorClass: censor.censorClass,
    censorReasonCode: censor.reasonCode,
    evidenceIntegrity: evidenceIntegrityOf(requirements),
    controlStarted: snapshot.stages.has("participant_control_started"),
    spawned: snapshot.stages.has("participant_spawned"),
    turnCompleted: snapshot.stages.has("turn_completed"),
    reportStatus: reportStatusOf(report),
    reportSha256: report.status === "ok" ? report.textSha256 : null,
    evaluation:
      evaluation === null
        ? null
        : {
            status: evaluation.status,
            score: evaluation.score,
            passedWeight: evaluation.passed_weight,
            totalWeight: evaluation.total_weight,
            valid: evaluation.infrastructure_errors.length === 0
          },
    usageObserved: Object.keys(usage).length > 0,
    apiRequests,
    agentToolCalls:
      typeof usage["tool_calls"] === "number" ? usage["tool_calls"] : null,
    exit: { code: result.exitCode, signal: result.signal },
    ...(result.spawnError == null ? {} : { spawnError: result.spawnError }),
    startedAtMs,
    finishedAtMs
  };
}

/** Terminal record for a trial whose setup failed before any spawn. */
async function finalizeSetupFailure(
  store: ArtifactStore,
  plan: FrozenPlan,
  index: number,
  cause: TrialSetupError
): Promise<TrialOutcome> {
  const runId = plan.trialRunIds[index];
  if (runId === undefined) {
    throw new Error(`Trial index ${index} is outside the frozen batch.`);
  }
  const relativeRoot = `runs/${plan.batchId}/trials/${runId}`;
  const requirements: EvidenceRequirement[] = [
    { id: "lifecycle_ledger", status: "ok" },
    { id: "api_trace", status: "missing" },
    { id: "participant_surface_verification", status: "missing" },
    { id: "session_events", status: "missing" },
    { id: "final_state", status: "missing" }
  ];
  const censor = classifyCensorClass({
    disposition: "invalid_setup",
    controlStarted: false,
    requirements
  });
  const manifest = await store.writeManifest({
    scopeDir: relativeRoot,
    level: "trial",
    id: runId,
    runId,
    batchId: plan.batchId,
    createdAt: formatRfc3339(0)
  });
  const manifestText = await store.read(
    `${relativeRoot}/artifact-manifest.json`
  );
  await store.writeOnce(
    `${relativeRoot}/run.completed.json`,
    `${canonicalJson({
      schema_version: 1,
      kind: "RunCompleted",
      run_id: runId,
      batch_id: plan.batchId,
      finished_at: formatRfc3339(0),
      disposition: "invalid_setup",
      disposition_reason: cause.code,
      evidence_integrity: "missing",
      censor_class: censor.censorClass,
      censor_reasons: [censor.reasonCode],
      failed_requirement_ids: [...censor.failedRequirements],
      artifact_manifest_sha256: sha256Hex(manifestText),
      manifest_path: `${relativeRoot}/artifact-manifest.json`,
      manifest_sha256: sha256Hex(manifestText),
      missing_artifacts: missingArtifactsOf(requirements),
      counts: {
        api_requests: 0,
        documentation_requests: 0,
        semantic_events: 0,
        agent_tool_calls: null
      },
      participant_report: { status: "absent", report_sha256: null },
      extensions: {
        setup_error: cause.message,
        manifest_entries: manifest.entries.length
      } as unknown as JsonObject
    } as unknown as Json)}\n`
  );
  return {
    runId,
    batchId: plan.batchId,
    index,
    disposition: "invalid_setup",
    reasonCode: cause.code,
    censorClass: censor.censorClass,
    censorReasonCode: censor.reasonCode,
    evidenceIntegrity: "missing",
    controlStarted: false,
    spawned: false,
    turnCompleted: false,
    reportStatus: "unavailable_due_to_infrastructure",
    reportSha256: null,
    evaluation: null,
    usageObserved: false,
    apiRequests: 0,
    agentToolCalls: null,
    exit: null,
    startedAtMs: 0,
    finishedAtMs: 0
  };
}

function buildEventSink(
  session: SessionWriter,
  stages: StageQueue,
  facts: SessionFacts,
  terminalTurnKind: string
): {
  emit(event: AgentSessionEvent): void;
} {
  return {
    emit(event: AgentSessionEvent): void {
      session.append(event);
      observeSessionEvent(event, stages, facts, terminalTurnKind);
    }
  };
}

/**
 * Derive the section 22.3 stage facts from one normalized session event.
 * Ambiguous evidence never classifies in the participant's favor.
 */
function observeSessionEvent(
  event: AgentSessionEvent,
  stages: StageQueue,
  facts: SessionFacts,
  terminalTurnKind: string
): void {
  if (event.type === "agent.started") {
    facts.spawned = true;
    stages.offer("participant_spawned", "adapter", {
      event_id: event.event_id
    });
    const started = event.payload as AgentStartedPayload;
    if (started.model !== null) {
      facts.modelStarted = true;
      if (!stages.holds("participant_control_started")) {
        stages.offer("model_started", "adapter", { model: started.model });
      }
    }
  }
  if (event.type === "agent.session_event") {
    const stream = event.payload as AgentStreamPayload;
    const kind = stream.kind ?? null;
    if (kind === terminalTurnKind) {
      facts.turnCompleted = true;
      stages.offer("turn_completed", "adapter", { kind });
    }
    if (kind === API_REQUEST_EVENT_KIND) {
      facts.apiStarted = true;
    }
    if (stream.channel === "adapter" && kind !== null) {
      facts.modelStarted = true;
    }
  }
  if (facts.spawned && (facts.modelStarted || facts.apiStarted)) {
    if (!stages.holds("participant_control_started")) {
      stages.offer("participant_control_started", "adapter", {
        evidence: facts.modelStarted ? "model_start" : "api_request"
      });
    }
    if (facts.apiStarted) {
      stages.offer("api_started", "gateway", { evidence: "http_request" });
    }
  }
}

function buildRunContext(
  options: TrialRunOptions,
  setup: TrialSetup
): AgentRunContext {
  const { plan } = options;
  const instructions = setup.prompts.prompts.instructions.text;
  return {
    runId: setup.runId,
    workspaceDir: setup.layout.workspaceDir,
    syntheticHomeDir: setup.control.homeDir,
    temporaryDir: setup.control.temporaryDir,
    prompts: {
      ...(instructions === "" ? {} : { instructions }),
      task: setup.prompts.prompts.task.text,
      launch: setup.prompts.prompts.launch.text
    },
    exposure: {
      mode: plan.exposureMode,
      baseUrl: setup.exposure.baseUrl,
      credentialNames: [...setup.exposure.credentialNames],
      ...(setup.exposure.documentationUrl === null
        ? {}
        : { documentationUrl: setup.exposure.documentationUrl })
    },
    launcherEnvironment: { ...setup.launcherEnvironment },
    toolEnvironment: { ...setup.toolEnvironment },
    toolExecutionPolicy: {
      inheritEnvironment: "none",
      allowedEnvironmentNames: Object.keys(setup.toolEnvironment),
      network: "mock-only",
      filesystem: "workspace-only"
    },
    ...(plan.adapter.model === null ? {} : { model: plan.adapter.model }),
    ...(plan.adapter.effort === null ? {} : { effort: plan.adapter.effort }),
    ...(plan.adapter.sandbox === null ? {} : { sandbox: plan.adapter.sandbox }),
    timeoutMs: plan.trialWallTimeMs
  };
}

function reportSourceOf(
  plan: FrozenPlan,
  setup: TrialSetup,
  result: AgentRunResult
):
  | { readonly source: "adapter_final"; readonly text: string }
  | {
      readonly source: "workspace_file";
      readonly workspaceDir: string;
      readonly filename: string;
      readonly exitedAtMs: number | null;
    } {
  const declared = plan.evaluation.evalDoc.result;
  if (declared.source === "workspace_file") {
    return {
      source: "workspace_file",
      workspaceDir: setup.layout.workspaceDir,
      filename: declared.filename ?? "",
      exitedAtMs: null
    };
  }
  return { source: "adapter_final", text: result.finalText ?? "" };
}

function resourceUsageOf(
  runId: string,
  plan: FrozenPlan,
  result: AgentRunResult,
  usage: Readonly<Record<string, number>>,
  apiRequests: number
): JsonObject {
  const number = (key: string): number | null =>
    typeof usage[key] === "number" ? usage[key] : null;
  return {
    schema_version: 1,
    kind: "ResourceUsage",
    run_id: runId,
    usage_observed: Object.keys(usage).length > 0,
    duration_ms:
      typeof result.durationMs === "number" ? result.durationMs : null,
    input_tokens: number("input_tokens"),
    output_tokens: number("output_tokens"),
    reasoning_tokens: number("reasoning_tokens"),
    cached_input_tokens: number("cached_input_tokens"),
    total_tokens: number("total_tokens"),
    tool_calls: number("tool_calls"),
    api_requests:
      number("api_requests") === null ? apiRequests : number("api_requests"),
    provider_cost: number("provider_cost"),
    currency: null,
    adapter_reported: {
      available: plan.adapter.probe.capabilities.usageReporting,
      version: plan.adapter.probe.version,
      fields: Object.keys(usage).sort()
    },
    extensions: {}
  };
}

function runMetadataOf(
  plan: FrozenPlan,
  setup: TrialSetup,
  adapterId: string
): JsonObject {
  return {
    run_id: setup.runId,
    batch_id: plan.batchId,
    eval_id: plan.evalId,
    repetition_index: setup.index,
    trial_seed_id: setup.trialSeed.slice(0, 12),
    started_at: setup.runStarted["started_at"] ?? null,
    adapter: adapterId,
    exposure_mode: plan.exposureMode,
    contract_visibility: plan.contractVisibility,
    data_plane_scope: plan.dataPlaneScope
  };
}

interface TraceRead {
  readonly events: readonly TraceEvent[];
  readonly corrupt: boolean;
}

/** Read `trace.jsonl` back as normalized API exchanges. */
async function readTraceEvents(
  store: ArtifactStore,
  relativeRoot: string
): Promise<TraceRead> {
  const text = await store
    .read(`${relativeRoot}/trace.jsonl`)
    .catch(() => null);
  if (text === null) {
    return { events: [], corrupt: false };
  }
  const events: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = parseJsonStrict(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === "api.exchange"
      ) {
        // A trace written under another schema version belongs to a
        // different build; reading it as evidence would silently mix
        // incompatible records (section 42.2, AC-012).
        const record = parsed as { schema_version?: unknown };
        if (record.schema_version !== 1) {
          return { events, corrupt: true };
        }
        events.push(parsed as unknown as TraceEvent);
      }
    } catch {
      return { events, corrupt: true };
    }
  }
  return { events, corrupt: false };
}

/** Read the documentation stream without adding its events to API metrics. */
async function readDocumentationEvents(
  store: ArtifactStore,
  relativeRoot: string
): Promise<readonly DocumentationExchange[]> {
  const text = await store
    .read(`${relativeRoot}/documentation.jsonl`)
    .catch(() => "");
  const events: DocumentationExchange[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = parseJsonStrict(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === "documentation.exchange" &&
        (parsed as { schema_version?: unknown }).schema_version === 1
      ) {
        events.push(parsed as DocumentationExchange);
      }
    } catch {
      // Documentation corruption does not turn the content into an API event.
    }
  }
  return events;
}

/**
 * The frozen evidence requirements the primary metric depends on. The
 * participant report is deliberately absent: missing or malformed
 * participant output is a captured task outcome, never a censor.
 */
async function evidenceRequirementsOf(
  store: ArtifactStore,
  relativeRoot: string,
  setup: TrialSetup,
  traceCorrupt: boolean
): Promise<readonly EvidenceRequirement[]> {
  const traceStatus: EvidenceRequirement["status"] = traceCorrupt
    ? "corrupt"
    : "ok";
  const surface = await readJsonFile(
    store,
    `${relativeRoot}/participant-surface-verification.json`
  );
  const surfaceStatus: EvidenceRequirement["status"] =
    surface === null ? "missing" : surface["ok"] === true ? "ok" : "corrupt";
  const sessionEvents = await store
    .read(`${relativeRoot}/session/events.redacted.jsonl`)
    .then(() => true)
    .catch(() => false);
  return [
    { id: "api_trace", status: traceStatus },
    {
      id: "lifecycle_ledger",
      status: setup.lifecycle.snapshot().stages.has("evidence_finalized")
        ? "ok"
        : "corrupt"
    },
    { id: "participant_surface_verification", status: surfaceStatus },
    { id: "session_events", status: sessionEvents ? "ok" : "missing" },
    { id: "final_state", status: "ok" }
  ];
}

async function readJsonFile(
  store: ArtifactStore,
  relativePath: string
): Promise<JsonObject | null> {
  const text = await store.read(relativePath).catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    const parsed = parseJsonStrict(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function missingArtifactsOf(
  requirements: readonly EvidenceRequirement[]
): readonly { path: string; reason: string }[] {
  const paths: Readonly<Record<string, string>> = {
    api_trace: "trace.jsonl",
    lifecycle_ledger: "lifecycle.jsonl",
    participant_surface_verification: "participant-surface-verification.json",
    session_events: "session/events.redacted.jsonl",
    final_state: "state.final.json"
  };
  return requirements
    .filter((requirement) => requirement.status !== "ok")
    .map((requirement) => ({
      path: paths[requirement.id] ?? requirement.id,
      reason: `evidence requirement ${requirement.id} is ${requirement.status}`
    }));
}

/**
 * Derive the stable assignment identifier of one batch run. Batch runs own
 * no study assignment, so the batch identifier seeds the control id.
 */
export function batchAssignmentId(batchId: string): string {
  return prefixedId24("bat_", `assignment:${batchId}`);
}
