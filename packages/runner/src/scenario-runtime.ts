/**
 * The scenario runtime of one trial (specification sections 16.3, 16.5,
 * and 17.1). It freezes the pack's executable behavior inputs, spawns
 * the behavior module in its own child process, verifies operation
 * coverage, initializes the domain state, and exposes the two handles
 * the gateway needs: a ScenarioBackend and a store-backed GatewayState.
 *
 * The child process runs trusted-local (section 16.5): it lives outside
 * the controller process, shares no memory with it, and terminates with
 * the run. The state lives in the trial's sealed SQLite store; the data
 * encryption key never leaves the controller process.
 */

import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  formatRfc3339,
  isJsonObject,
  isRfc3339,
  parseRfc3339,
  sha256Hex,
  toOalError,
  VIRTUAL_EPOCH_MS,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  executeBehaviorRequest,
  DEFAULT_BEHAVIOR_TIMEOUT_MS,
  type BackendDescription,
  type BehaviorRequest,
  type ExecuteOutcome,
  type RegisteredEvent
} from "@oal/behavior-api";
import {
  BehaviorModuleHost,
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "@oal/behavior-runtime";
import {
  createNamespacePrng,
  StateStore,
  VirtualClock
} from "@oal/state-store";
import type {
  GatewayState,
  ScenarioBackend,
  ScenarioCommit,
  ScenarioOutcome,
  ScenarioTransaction
} from "@oal/gateway";
import type { LoadedPack } from "@oal/pack";

import type { Clock } from "./lifecycle.ts";
import type { FrozenPlan } from "./preflight.ts";

/** Stable bootstrap failure codes of the scenario runtime. */
export const ScenarioCode = {
  BackendMissing: "OAL-SCENARIO-BACKEND-MISSING",
  BackendApiUnsupported: "OAL-SCENARIO-BACKEND-API-UNSUPPORTED",
  CoverageMismatch: "OAL-SCENARIO-COVERAGE-MISMATCH",
  StateSchemaInvalid: "OAL-SCENARIO-STATE-SCHEMA-INVALID",
  ClockUnsupported: "OAL-SCENARIO-CLOCK-UNSUPPORTED",
  InitializeFailed: "OAL-SCENARIO-INITIALIZE-FAILED"
} as const;

/** A scenario runtime defect from before or during the run. */
export class ScenarioRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ScenarioRuntimeError";
  }
}

/** Options of {@link openScenarioRuntime}. */
export interface ScenarioRuntimeOptions {
  readonly pack: LoadedPack;
  readonly plan: FrozenPlan;
  readonly runId: string;
  readonly trialSeed: string;
  /** Absolute path of the trial's SQLite state store. */
  readonly databasePath: string;
  /** Injected wall clock; only the run creation stamp reads it. */
  readonly now: Clock;
  /** Per-call behavior timeout in milliseconds; default 10 000. */
  readonly timeoutMs?: number;
}

/** One committed semantic event, in commit order. */
export interface CommittedSemanticEvent {
  readonly eventId: string;
  readonly semanticSequence: number;
  readonly requestSequence: number;
  readonly parentEventId: string;
  readonly name: string;
  readonly eventVersion: number;
  readonly payload: Json;
  readonly logicalTime: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
}

/** The live scenario runtime of one trial. */
export interface ScenarioRuntime {
  /** Gateway handle of the behavior child. */
  readonly backend: ScenarioBackend;
  /** Store-backed state the gateway commits through. */
  readonly state: GatewayState;
  /** SHA-256 of the frozen behavior entrypoint bytes. */
  readonly backendSha256: string;
  /** Isolation level the report must label (section 16.5). */
  readonly isolationLevel: "trusted-local";
  /** The backend description the coverage check accepted. */
  readonly description: BackendDescription;
  /** Stop the child and close the store. Idempotent. */
  close(): Promise<void>;
  /** Final domain state and revision, or null before initialize. */
  finalState(): {
    readonly state: JsonObject;
    readonly revision: number;
  } | null;
  /** Every committed semantic event, in commit order. */
  semanticEvents(): readonly CommittedSemanticEvent[];
  /**
   * Project the final state through the backend. Null when the backend
   * implements no projection.
   */
  projection(): Promise<JsonObject | null>;
}

interface BehaviorDeclaration {
  readonly entrypoint: {
    readonly absolutePath: string;
    readonly sha256: string;
  };
  readonly exportName: string;
  readonly stateSchema: Json;
  readonly stateSchemaVersion: number;
  readonly fixtures: readonly Json[];
  readonly clock: {
    readonly kind: "virtual";
    readonly initialMs: number;
    readonly tickMs: number;
  };
}

function packReference(pack: LoadedPack, role: string, pointer: string) {
  return pack.references.find(
    (reference) => reference.role === role && reference.pointer === pointer
  );
}

/**
 * Read the frozen behavior declaration of the scenario pack. Every
 * executable input comes from references the pack loader already
 * hashed, so nothing is read from disk again here: the entrypoint
 * digest is the loader's hash, not a re-read.
 */
function behaviorDeclarationOf(
  pack: LoadedPack,
  scenarioId: string
): BehaviorDeclaration {
  const behavior = isJsonObject(pack.manifest["behavior"])
    ? pack.manifest["behavior"]
    : null;
  const backend =
    behavior !== null && isJsonObject(behavior["backend"])
      ? behavior["backend"]
      : null;
  const entrypoint =
    backend === null
      ? undefined
      : packReference(
          pack,
          "behavior_entrypoint",
          "/behavior/backend/entrypoint"
        );
  if (backend === null || entrypoint === undefined) {
    throw new ScenarioRuntimeError(
      ScenarioCode.BackendMissing,
      "The pack declares no behavior backend entrypoint."
    );
  }
  const stateSchemaReference = packReference(
    pack,
    "state_schema",
    "/behavior/state_schema"
  );
  const stateSchema = stateSchemaReference?.document ?? null;
  if (stateSchema === null) {
    throw new ScenarioRuntimeError(
      ScenarioCode.StateSchemaInvalid,
      "The scenario pack declares no behavior state schema."
    );
  }
  const stateSchemaVersion =
    behavior !== null && typeof behavior["state_schema_version"] === "number"
      ? behavior["state_schema_version"]
      : 1;
  const scenarios = Array.isArray(pack.manifest["scenarios"])
    ? pack.manifest["scenarios"].filter(isJsonObject)
    : [];
  const scenarioIndex = scenarios.findIndex(
    (scenario) => scenario["id"] === scenarioId
  );
  const fixtures: Json[] = [];
  for (const reference of pack.references) {
    if (reference.role !== "state_fixture" || reference.document === null) {
      continue;
    }
    const behaviorLevel = reference.pointer.startsWith("/behavior/fixtures/");
    const scenarioLevel =
      scenarioIndex >= 0 &&
      reference.pointer.startsWith(`/scenarios/${scenarioIndex}/fixtures/`);
    if (behaviorLevel || scenarioLevel) {
      fixtures.push(reference.document);
    }
  }
  const clock = readClock(behavior);
  return {
    entrypoint: {
      absolutePath: entrypoint.absolutePath,
      sha256: entrypoint.sha256
    },
    exportName:
      typeof backend["export"] === "string" ? backend["export"] : "backend",
    stateSchema,
    stateSchemaVersion,
    fixtures,
    clock
  };
}

/** The scenario this pack run selected; scenarios carry only an id. */

/**
 * The declared clock. The pack schema pins {kind, initial, tick_ms};
 * only the virtual clock keeps a run deterministic, so a wall clock
 * refuses the run before it starts. An omitted clock uses the virtual
 * epoch and a one-millisecond tick.
 */
function readClock(behavior: JsonObject | null): BehaviorDeclaration["clock"] {
  const declared =
    behavior !== null && isJsonObject(behavior["clock"])
      ? behavior["clock"]
      : null;
  if (declared === null) {
    return { kind: "virtual", initialMs: VIRTUAL_EPOCH_MS, tickMs: 1 };
  }
  if (declared["kind"] !== "virtual") {
    throw new ScenarioRuntimeError(
      ScenarioCode.ClockUnsupported,
      "Scenario mode serves only the virtual clock; the pack declares a wall clock."
    );
  }
  const initial = declared["initial"];
  const initialMs =
    typeof initial === "string" && isRfc3339(initial)
      ? parseRfc3339(initial)
      : VIRTUAL_EPOCH_MS;
  const tickMs =
    typeof declared["tick_ms"] === "number" ? declared["tick_ms"] : 1;
  return { kind: "virtual", initialMs, tickMs };
}

/**
 * The store-backed gateway state. One store request row opens at
 * stage(), and the same row closes at commit() or rollback(); the
 * serialized pipeline guarantees no second request stages before that
 * close. commit() persists the state transition, the exchange event,
 * and the semantic events in one SQLite transaction (section 16.3), so
 * a store failure leaves no partial trail; the throw maps to the
 * bounded OAL-STATE-COMMIT-FAILED response.
 */
class StoreGatewayState implements GatewayState {
  private allocation: { sequence: number; requestId: string } | null = null;
  private stagedEffect: string | null = null;
  private rollbackCount = 0;
  private readonly applied: string[] = [];

  constructor(
    private readonly store: StateStore,
    private readonly commitHook: (
      events: readonly CommittedSemanticEvent[]
    ) => void
  ) {}

  /** The open request allocation, for the backend handle. */
  get request(): { sequence: number; requestId: string } | null {
    return this.allocation;
  }

  stage(effect: string): void {
    if (this.allocation !== null) {
      throw new Error("One state transaction is already staged.");
    }
    this.allocation = this.store.beginRequest({
      ingressObservedAt: this.store.clock.now(),
      operationKey: effect
    });
    this.stagedEffect = effect;
  }

  commit(scenario?: ScenarioTransaction): void {
    const allocation = this.takeAllocation();
    const transition = scenario?.commit;
    const snapshot = this.store.getState();
    const before = snapshot?.revision ?? 0;
    const committed: CommittedSemanticEvent[] = [];
    this.store.transaction(() => {
      if (transition?.nextState !== undefined) {
        if (!isJsonObject(transition.nextState)) {
          // The executor validated this state against the pack schema,
          // but the store persists objects only; refuse the transaction.
          throw new Error("The next state is not a JSON object.");
        }
        this.store.putState({
          state: transition.nextState,
          expectedRevision: snapshot === null ? null : snapshot.revision
        });
      }
      const apiEvent = this.store.appendApiEvent({
        sequence: allocation.sequence,
        eventJson: {
          type: "api.exchange",
          request_id: allocation.requestId,
          operation_key: scenario?.exchange.operationKey ?? this.stagedEffect,
          method: scenario?.exchange.method ?? null,
          status: scenario?.exchange.status ?? null,
          committed: transition !== undefined,
          effects: transition === undefined ? [] : [...transition.effects]
        }
      });
      if (transition !== undefined) {
        for (const event of transition.semanticEvents) {
          const record = this.store.appendSemanticEvent({
            requestSequence: allocation.sequence,
            parentEventId: apiEvent.eventId,
            eventName: event.name,
            schemaVersion: event.eventVersion,
            eventJson: event.payload
          });
          committed.push({
            eventId: record.eventId,
            semanticSequence: record.semanticSequence,
            requestSequence: allocation.sequence,
            parentEventId: apiEvent.eventId,
            name: event.name,
            eventVersion: event.eventVersion,
            payload: event.payload,
            logicalTime: this.store.clock.now(),
            revisionBefore: before,
            revisionAfter: this.store.getState()?.revision ?? before
          });
        }
      }
      this.store.completeRequest(allocation.sequence, {
        terminalStatus: "committed",
        ...(scenario === undefined
          ? {}
          : { responseStatus: scenario.exchange.status }),
        committed: transition !== undefined
      });
    });
    if (transition !== undefined) {
      this.applied.push(...transition.effects);
    }
    this.commitHook(committed);
    this.stagedEffect = null;
  }

  rollback(): void {
    const allocation = this.takeAllocation();
    this.store.completeRequest(allocation.sequence, {
      terminalStatus: "failed",
      committed: false
    });
    this.rollbackCount += 1;
    this.stagedEffect = null;
  }

  private takeAllocation(): { sequence: number; requestId: string } {
    const allocation = this.allocation;
    if (allocation === null) {
      throw new Error("The state committed or rolled back without staging.");
    }
    this.allocation = null;
    return allocation;
  }

  get revision(): number {
    return this.store.getState()?.revision ?? 0;
  }

  get appliedEffects(): readonly string[] {
    return this.applied;
  }

  get pendingEffects(): readonly string[] {
    return this.stagedEffect === null ? [] : [this.stagedEffect];
  }

  get rollbacks(): number {
    return this.rollbackCount;
  }
}

/**
 * Open the scenario runtime of one trial: freeze the declared backend
 * inputs, spawn the child, verify the description, initialize the
 * domain state, and open the sealed store. The caller owns the
 * lifetime and must close() it on every exit route.
 */
export async function openScenarioRuntime(
  options: ScenarioRuntimeOptions
): Promise<ScenarioRuntime> {
  const { pack, plan, runId, trialSeed } = options;
  const declaration = behaviorDeclarationOf(pack, plan.scenarioId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS;
  const blobRoot = join(pack.root, ".oal", "blobs");

  const host = new BehaviorModuleHost({
    entry: declaration.entrypoint.absolutePath,
    context: {
      contract: plan.contract.ir,
      packRoot: pack.root,
      config: {}
    },
    runSeed: trialSeed,
    timeoutMs,
    cwd: pack.root
  });
  await host.start();

  let description: BackendDescription;
  let initialState: JsonObject;
  const store = StateStore.open({
    path: options.databasePath,
    runId,
    clock: new VirtualClock({
      initialMs: declaration.clock.initialMs,
      tickMs: declaration.clock.tickMs
    })
  });
  try {
    description = await host.describe();
    // The declared type pins the wire field to this build's version;
    // the child could still answer with anything, so widen before the
    // check instead of trusting the type (section 16.5).
    const backendApiVersion: number = description.backendApiVersion;
    if (backendApiVersion !== 1) {
      throw new ScenarioRuntimeError(
        ScenarioCode.BackendApiUnsupported,
        `The behavior backend speaks API version ${String(
          backendApiVersion
        )}; this runner serves version 1.`
      );
    }
    if (description.stateSchemaVersion !== declaration.stateSchemaVersion) {
      throw new ScenarioRuntimeError(
        ScenarioCode.StateSchemaInvalid,
        `The backend serves state schema version ${String(
          description.stateSchemaVersion
        )}, but the pack pins ${String(declaration.stateSchemaVersion)}.`
      );
    }
    checkOperationCoverage(description, plan);

    store.initializeRun({
      batchId: plan.batchId,
      contractSemanticSha256: plan.contract.semanticSha256,
      contractExecutionSha256: plan.contract.executionSha256,
      // The freeze digest covers the manifest plus every referenced
      // asset, so it identifies the whole source inventory (section 6).
      sourceInventorySha256: plan.pack.packSha256,
      packSha256: plan.pack.packSha256,
      scenarioSha256: sha256Hex(plan.scenarioId),
      backendSha256: declaration.entrypoint.sha256,
      implementationSha256: plan.contract.executionSha256,
      seed: trialSeed,
      stateSchemaVersion: declaration.stateSchemaVersion,
      createdAt: formatRfc3339(options.now())
    });

    const initialized = await host.initialize({
      runId,
      fixtures: [...declaration.fixtures],
      // The child rebuilds these from the same run seed and clock
      // snapshot, so the wire form is the authority (section 16.5).
      clock: clockAdapter(store.clock),
      ids: idsAdapter(),
      random: randomAdapter(
        createNamespacePrng(trialSeed, `initialize:${runId}`)
      ),
      blobs: fileBlobStore(blobRoot)
    });
    if (!isJsonObject(initialized.state)) {
      throw new ScenarioRuntimeError(
        ScenarioCode.InitializeFailed,
        "The behavior backend initialized with a non-object state."
      );
    }
    initialState = initialized.state;
    store.putState({ state: initialState, expectedRevision: null });
  } catch (cause) {
    store.close();
    await host.close().catch(() => undefined);
    if (cause instanceof ScenarioRuntimeError) {
      throw cause;
    }
    throw new ScenarioRuntimeError(
      ScenarioCode.InitializeFailed,
      `The scenario runtime failed to bootstrap: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }

  const eventRegistry = new Map<string, RegisteredEvent>();
  for (const event of description.semanticEvents ?? []) {
    eventRegistry.set(event.name, {
      eventVersion: event.eventVersion,
      payloadSchema: event.payloadSchema
    });
  }

  const allEvents: CommittedSemanticEvent[] = [];
  const gatewayState = new StoreGatewayState(store, (events) => {
    allEvents.push(...events);
  });

  const backend: ScenarioBackend = {
    name: packBehaviorName(pack),
    handle: async (
      request: BehaviorRequest,
      gatewayRequestId: string
    ): Promise<ScenarioOutcome> => {
      const allocation = gatewayState.request;
      const requestId = allocation?.requestId ?? gatewayRequestId;
      const snapshot = store.getState();
      const outcome = await executeBehaviorRequest({
        backend: host,
        request,
        runId,
        requestId,
        state: snapshot?.state ?? initialState,
        // The host forwards only the clock snapshot; the child rebuilds
        // these services from the same seed and request id, so both
        // sides derive identical streams (section 16.5).
        clock: clockAdapter(store.clock),
        ids: idsAdapter(),
        random: randomAdapter(
          createNamespacePrng(trialSeed, `request:${requestId}`)
        ),
        blobs: fileBlobStore(blobRoot),
        stateSchema: declaration.stateSchema,
        maxStateBytes: store.limits.maxPersistedStateBytes,
        eventRegistry,
        timeoutMs
      });
      return scenarioOutcomeOf(outcome);
    }
  };

  let closed = false;
  return {
    backend,
    state: gatewayState,
    backendSha256: declaration.entrypoint.sha256,
    isolationLevel: host.isolationLevel,
    description,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await host.close().catch(() => undefined);
      store.close();
    },
    finalState: () => {
      const snapshot = store.getState();
      return snapshot === null
        ? null
        : { state: snapshot.state, revision: snapshot.revision };
    },
    semanticEvents: () => [...allEvents],
    projection: async (): Promise<JsonObject | null> => {
      const snapshot = store.getState();
      if (snapshot === null) {
        return null;
      }
      try {
        const projected = await host.project(snapshot.state, null);
        return isJsonObject(projected) ? projected : null;
      } catch {
        // A backend without project, or one whose projection failed,
        // leaves the final state itself as the exported projection.
        return null;
      }
    }
  };
}

/** The backend name provenance and store records use. */
function packBehaviorName(pack: LoadedPack): string {
  const metadata = isJsonObject(pack.manifest["metadata"])
    ? pack.manifest["metadata"]
    : null;
  const name = metadata?.["name"];
  return typeof name === "string" && name !== "" ? name : "scenario";
}

/**
 * The pack declares exact completeness, so every contract operation
 * must be implemented and every implemented operation declared
 * (section 16.1). One mismatch refuses the run before an exposure
 * starts.
 */
function checkOperationCoverage(
  description: BackendDescription,
  plan: FrozenPlan
): void {
  const implemented = new Set(
    description.operations
      .filter((operation) => operation.support === "implemented")
      .map((operation) => operation.key)
  );
  const declared = new Set(plan.contract.ir.operations.map((op) => op.key));
  const missing = [...declared].filter((key) => !implemented.has(key));
  const extra = [...implemented].filter((key) => !declared.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`unimplemented: ${missing.sort().join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`not in the contract: ${extra.sort().join(", ")}`);
    }
    throw new ScenarioRuntimeError(
      ScenarioCode.CoverageMismatch,
      `The behavior backend does not cover the contract exactly (${parts.join("; ")}).`
    );
  }
}

/**
 * Map one executor outcome onto the gateway scenario outcome kinds. A
 * domain HTTP error is a served response without a transition; the
 * message of an internal failure stays in the controller and never
 * crosses the wire (section 15.2).
 */
function scenarioOutcomeOf(outcome: ExecuteOutcome): ScenarioOutcome {
  if (outcome.ok) {
    const { result } = outcome;
    const commit: ScenarioCommit | undefined =
      result.nextState === undefined &&
      (result.semanticEvents ?? []).length === 0 &&
      (result.effects ?? []).length === 0
        ? undefined
        : {
            ...(result.nextState === undefined
              ? {}
              : { nextState: result.nextState }),
            semanticEvents: [...(result.semanticEvents ?? [])],
            effects: [...(result.effects ?? [])]
          };
    return {
      kind: "served",
      response: {
        status: result.response.status,
        ...(result.response.headers === undefined
          ? {}
          : { headers: [...result.response.headers] }),
        ...(result.response.mediaType === undefined
          ? {}
          : { mediaType: result.response.mediaType }),
        ...(result.response.body === undefined
          ? {}
          : { body: result.response.body })
      },
      ...(commit === undefined ? {} : { commit })
    };
  }
  if (outcome.kind === "http_error") {
    return {
      kind: "served",
      response: {
        status: outcome.error.status,
        ...(outcome.error.behaviorBody === undefined
          ? {}
          : { body: outcome.error.behaviorBody })
      }
    };
  }
  if (outcome.kind === "timeout") {
    return {
      kind: "timeout",
      timeoutMs: outcome.timeoutMs,
      message: outcome.message
    };
  }
  return { kind: "internal", message: outcome.message };
}

/** Parent directory of the trial state database, created on demand. */
export async function ensureStateDirectory(
  databasePath: string
): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true }).catch(
    (cause: unknown) => {
      throw toOalError(cause);
    }
  );
}
