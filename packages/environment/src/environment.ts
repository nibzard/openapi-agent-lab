/**
 * The shared owner of one stateful API environment (specification
 * section 48.2). It freezes the pack's executable behavior inputs,
 * spawns the behavior module in its own child process, verifies
 * operation coverage, initializes the domain state, and exposes the
 * gateway handles plus the environment lifecycle surface.
 *
 * Both `oal run` and standalone `oal serve` consume this owner, so the
 * validation, transaction, behavior timeout, state projection, and
 * shutdown paths cannot drift between them. The owner knows nothing
 * about trials, participants, agents, or scoring: callers pass frozen
 * pack inputs and explicit identities, never a trial plan.
 *
 * The child process runs trusted-local (section 16.5): it lives
 * outside the controller process, shares no memory with it, and
 * terminates with the environment. The state lives in the sealed
 * SQLite store; the data encryption key never leaves the controller.
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
import type { ContractIR } from "@oal/contract-ir";
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
import {
  BehaviorClosureError,
  computeBehaviorClosure,
  freezeBehaviorClosure,
  type BehaviorClosure,
  type LoadedPack
} from "@oal/pack";

/** Stable failure codes of the environment owner. */
export const EnvironmentCode = {
  BackendMissing: "OAL-SCENARIO-BACKEND-MISSING",
  BackendApiUnsupported: "OAL-SCENARIO-BACKEND-API-UNSUPPORTED",
  CoverageMismatch: "OAL-SCENARIO-COVERAGE-MISMATCH",
  StateSchemaInvalid: "OAL-SCENARIO-STATE-SCHEMA-INVALID",
  ClockUnsupported: "OAL-SCENARIO-CLOCK-UNSUPPORTED",
  InitializeFailed: "OAL-SCENARIO-INITIALIZE-FAILED",
  ClosureInvalid: "OAL-SCENARIO-BEHAVIOR-CLOSURE-INVALID",
  ControlUnavailable: "OAL-ENVIRONMENT-CONTROL-UNAVAILABLE"
} as const;

/** An environment defect from before or during the run. */
export class EnvironmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "EnvironmentError";
  }
}

/** The frozen compiled contract the environment serves. */
export interface EnvironmentContractInputs {
  /** Compiled contract IR; the pack source never re-enters here. */
  readonly ir: ContractIR;
  readonly semanticSha256: string;
  readonly executionSha256: string;
}

/** Store identity records the sealed state database pins at startup. */
export interface EnvironmentRecords {
  readonly batchId: string;
  readonly packSha256: string;
  readonly implementationSha256: string;
}

/** Execution limits of the environment. */
export interface EnvironmentLimits {
  /** Per-call behavior timeout in milliseconds. Default 10 000. */
  readonly behaviorTimeoutMs?: number;
}

/** Options of {@link openEnvironment}; trial plans never cross this. */
export interface EnvironmentOptions {
  readonly pack: LoadedPack;
  readonly contract: EnvironmentContractInputs;
  readonly scenarioId: string;
  /** World seed; every deterministic service derives from it. */
  readonly seed: string;
  /** World identity; the store's run id and evidence lineage use it. */
  readonly worldId: string;
  /** Absolute path of the world's SQLite state store. */
  readonly databasePath: string;
  readonly records: EnvironmentRecords;
  readonly limits?: EnvironmentLimits;
  /** Injected observation clock in epoch milliseconds. */
  readonly now: () => number;
  /** Evidence directory of this world; reserved for lifecycle export. */
  readonly evidenceDirectory?: string;
  /** Private control directory of this world; reserved for controls. */
  readonly privateDirectory?: string;
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

/** Capability statuses the environment manifest reports. */
export interface EnvironmentCapabilities {
  readonly checkpoint: "unavailable" | "available";
  readonly reset: "unavailable" | "available";
  readonly advanceTime: "unavailable" | "available";
  readonly fork: "unavailable" | "available";
  readonly scheduledWork: "unsupported";
}

/**
 * The `environment.v1` manifest projection. It is a view of committed
 * records, not an independent source of truth; its schema lands with
 * the transaction-scoped services change.
 */
export interface EnvironmentManifest {
  readonly kind: "EnvironmentManifest";
  readonly worldId: string;
  readonly generation: number;
  readonly parentCheckpointId: string | null;
  readonly pack: {
    readonly id: string;
    readonly version: string;
    readonly packSha256: string;
  };
  readonly scenarioId: string;
  readonly behaviorSha256: string;
  readonly runtimeName: string;
  /** Identity of the frozen behavior dependency closure (section 48.8). */
  readonly behaviorClosure: {
    readonly identity: string;
    readonly entryPath: string;
    readonly fileCount: number;
  };
  readonly seed: string;
  readonly revision: number;
  readonly virtualTime: string;
  readonly isolationLevel: "trusted-local";
  readonly capabilities: EnvironmentCapabilities;
}

/** The live environment of one world. */
export interface Environment {
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
  /** Projection of committed world records; see {@link EnvironmentManifest}. */
  manifest(): EnvironmentManifest;
  /**
   * Operator world inspection. Controls arrive with the world
   * lifecycle milestone; until then every control refuses.
   */
  inspect(): never;
  /** Operator checkpoint control; unavailable in this milestone phase. */
  checkpoint(): never;
  /** Operator reset control; unavailable in this milestone phase. */
  reset(): never;
  /** Operator time control; unavailable in this milestone phase. */
  advanceTime(): never;
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
    throw new EnvironmentError(
      EnvironmentCode.BackendMissing,
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
    throw new EnvironmentError(
      EnvironmentCode.StateSchemaInvalid,
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
    throw new EnvironmentError(
      EnvironmentCode.ClockUnsupported,
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

  private readonly store: StateStore;
  private readonly commitHook: (
    events: readonly CommittedSemanticEvent[]
  ) => void;

  constructor(
    store: StateStore,
    commitHook: (events: readonly CommittedSemanticEvent[]) => void
  ) {
    this.store = store;
    this.commitHook = commitHook;
  }

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

function unavailable(name: string): never {
  throw new EnvironmentError(
    EnvironmentCode.ControlUnavailable,
    `The ${name} control is unavailable in this build; it arrives with the world lifecycle milestone.`
  );
}

/**
 * Open one environment: freeze the declared backend inputs, spawn the
 * child, verify the description, initialize the domain state, and open
 * the sealed store. The caller owns the lifetime and must close() it
 * on every exit route.
 */
export async function openEnvironment(
  options: EnvironmentOptions
): Promise<Environment> {
  const { pack, contract, worldId, seed } = options;
  const declaration = behaviorDeclarationOf(pack, options.scenarioId);
  const timeoutMs =
    options.limits?.behaviorTimeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS;
  const blobRoot = join(pack.root, ".oal", "blobs");

  // Freeze the complete behavior dependency closure before the child
  // starts (section 48.8). The child executes the frozen copies, so
  // edits to the pack sources after this point cannot change what a
  // running world serves, and the closure identity names the exact
  // graph in the environment manifest.
  let closure: BehaviorClosure;
  let frozenEntry: string;
  try {
    closure = await computeBehaviorClosure(declaration.entrypoint, pack.root);
    frozenEntry = (
      await freezeBehaviorClosure(
        closure,
        pack.root,
        join(pack.root, ".oal", "frozen", closure.identity)
      )
    ).entryPath;
  } catch (cause) {
    if (cause instanceof BehaviorClosureError) {
      throw new EnvironmentError(
        EnvironmentCode.ClosureInvalid,
        cause.message,
        { cause }
      );
    }
    throw cause;
  }

  const host = new BehaviorModuleHost({
    entry: frozenEntry,
    context: {
      contract: contract.ir,
      packRoot: pack.root,
      config: {}
    },
    runSeed: seed,
    timeoutMs,
    cwd: pack.root
  });
  await host.start();

  let description: BackendDescription;
  let initialState: JsonObject;
  const store = StateStore.open({
    path: options.databasePath,
    runId: worldId,
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
      throw new EnvironmentError(
        EnvironmentCode.BackendApiUnsupported,
        `The behavior backend speaks API version ${String(
          backendApiVersion
        )}; this environment serves version 1.`
      );
    }
    if (description.stateSchemaVersion !== declaration.stateSchemaVersion) {
      throw new EnvironmentError(
        EnvironmentCode.StateSchemaInvalid,
        `The backend serves state schema version ${String(
          description.stateSchemaVersion
        )}, but the pack pins ${String(declaration.stateSchemaVersion)}.`
      );
    }
    checkOperationCoverage(description, contract);

    store.initializeRun({
      batchId: options.records.batchId,
      contractSemanticSha256: contract.semanticSha256,
      contractExecutionSha256: contract.executionSha256,
      // The freeze digest covers the manifest plus every referenced
      // asset, so it identifies the whole source inventory (section 6).
      sourceInventorySha256: options.records.packSha256,
      packSha256: options.records.packSha256,
      scenarioSha256: sha256Hex(options.scenarioId),
      backendSha256: declaration.entrypoint.sha256,
      implementationSha256: options.records.implementationSha256,
      seed,
      stateSchemaVersion: declaration.stateSchemaVersion,
      createdAt: formatRfc3339(options.now())
    });

    const initialized = await host.initialize({
      runId: worldId,
      fixtures: [...declaration.fixtures],
      // The child rebuilds these from the same seed and clock
      // snapshot, so the wire form is the authority (section 16.5).
      clock: clockAdapter(store.clock),
      ids: idsAdapter(),
      random: randomAdapter(createNamespacePrng(seed, `initialize:${worldId}`)),
      blobs: fileBlobStore(blobRoot)
    });
    if (!isJsonObject(initialized.state)) {
      throw new EnvironmentError(
        EnvironmentCode.InitializeFailed,
        "The behavior backend initialized with a non-object state."
      );
    }
    initialState = initialized.state;
    store.putState({ state: initialState, expectedRevision: null });
  } catch (cause) {
    store.close();
    await host.close().catch(() => undefined);
    if (cause instanceof EnvironmentError) {
      throw cause;
    }
    throw new EnvironmentError(
      EnvironmentCode.InitializeFailed,
      `The environment failed to bootstrap: ${
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
        runId: worldId,
        requestId,
        state: snapshot?.state ?? initialState,
        // The host forwards only the clock snapshot; the child rebuilds
        // these services from the same seed and request id, so both
        // sides derive identical streams (section 16.5).
        clock: clockAdapter(store.clock),
        ids: idsAdapter(),
        random: randomAdapter(
          createNamespacePrng(seed, `request:${requestId}`)
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

  const manifest = (): EnvironmentManifest => {
    const snapshot = store.getState();
    const metadata = isJsonObject(pack.manifest["metadata"])
      ? pack.manifest["metadata"]
      : null;
    return {
      kind: "EnvironmentManifest",
      worldId,
      generation: 1,
      parentCheckpointId: null,
      pack: {
        id: typeof metadata?.["id"] === "string" ? metadata["id"] : "",
        version:
          typeof metadata?.["version"] === "string" ? metadata["version"] : "",
        packSha256: options.records.packSha256
      },
      scenarioId: options.scenarioId,
      behaviorSha256: declaration.entrypoint.sha256,
      runtimeName: "@oal/environment",
      behaviorClosure: {
        identity: closure.identity,
        entryPath: closure.entryPath,
        fileCount: closure.files.length
      },
      seed,
      revision: snapshot?.revision ?? 0,
      virtualTime: store.clock.now(),
      isolationLevel: host.isolationLevel,
      capabilities: {
        checkpoint: "unavailable",
        reset: "unavailable",
        advanceTime: "unavailable",
        fork: "unavailable",
        scheduledWork: "unsupported"
      }
    };
  };

  let closed = false;
  return {
    backend,
    state: gatewayState,
    backendSha256: declaration.entrypoint.sha256,
    isolationLevel: host.isolationLevel,
    description,
    manifest,
    inspect: () => unavailable("world inspect"),
    checkpoint: () => unavailable("checkpoint"),
    reset: () => unavailable("reset"),
    advanceTime: () => unavailable("advance-time"),
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
 * (section 16.1). One mismatch refuses the environment before an
 * exposure starts.
 */
function checkOperationCoverage(
  description: BackendDescription,
  contract: EnvironmentContractInputs
): void {
  const implemented = new Set(
    description.operations
      .filter((operation) => operation.support === "implemented")
      .map((operation) => operation.key)
  );
  const declared = new Set(contract.ir.operations.map((op) => op.key));
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
    throw new EnvironmentError(
      EnvironmentCode.CoverageMismatch,
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

/** Parent directory of the world state database, created on demand. */
export async function ensureStateDirectory(
  databasePath: string
): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true }).catch(
    (cause: unknown) => {
      throw toOalError(cause);
    }
  );
}
