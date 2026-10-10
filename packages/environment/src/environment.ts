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
  OalError,
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
  type RegisteredEvent,
  type ServicePositions
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
  DeterministicPrng,
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
import {
  controlDiagnostic,
  controlEnvelope,
  runControl,
  startWorldControl,
  type ControlEffect,
  type ControlOutcome,
  type WorldControlServer
} from "./control.ts";
import {
  readCheckpointDirectory,
  writeCheckpointDirectory,
  type ReadCheckpoint
} from "./checkpoint-dir.ts";

/** Stable failure codes of the environment owner. */
export const EnvironmentCode = {
  BackendMissing: "OAL-SCENARIO-BACKEND-MISSING",
  BackendApiUnsupported: "OAL-SCENARIO-BACKEND-API-UNSUPPORTED",
  CoverageMismatch: "OAL-SCENARIO-COVERAGE-MISMATCH",
  StateSchemaInvalid: "OAL-SCENARIO-STATE-SCHEMA-INVALID",
  ClockUnsupported: "OAL-SCENARIO-CLOCK-UNSUPPORTED",
  InitializeFailed: "OAL-SCENARIO-INITIALIZE-FAILED",
  ClosureInvalid: "OAL-SCENARIO-BEHAVIOR-CLOSURE-INVALID",
  ControlUnavailable: "OAL-ENVIRONMENT-CONTROL-UNAVAILABLE",
  CheckpointIncomplete: "OAL-CHECKPOINT-INCOMPLETE",
  CheckpointIntegrity: "OAL-CHECKPOINT-INTEGRITY",
  CheckpointIncompatible: "OAL-CHECKPOINT-INCOMPATIBLE"
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
  /** Executor bound on serialized next-state bytes. */
  readonly maxStateBytes?: number;
  /**
   * Store bound on persisted state bytes. A value below the executor
   * bound leaves a window where only the database commit fails.
   */
  readonly maxPersistedStateBytes?: number;
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

/** One checkpoint the environment wrote. */
export interface CheckpointWritten {
  readonly directory: string;
  readonly checkpointId: string;
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
  /** The frozen contract inputs this environment serves. */
  readonly contract: EnvironmentContractInputs;
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
   * The manifest as an `environment.v1` JSON document. The projection
   * of committed records, never an independent source of truth, and
   * free of private paths and credentials.
   */
  manifestDocument(): JsonObject;
  /**
   * Operator world inspection: the manifest projection plus the
   * committed counters, free of private paths and credentials.
   */
  inspect(): JsonObject;
  /**
   * Write one checkpoint directory at `out` from the committed
   * position: the sealed payload, the key, the blobs, the frozen
   * tree, and the compiled contract (section 48.4).
   */
  checkpoint(out: string): Promise<CheckpointWritten>;
  /**
   * Reset the world: the next generation, the declared baseline
   * state, clock, counters, and idempotency store, with evidence and
   * control results preserved (section 48.4).
   */
  reset(): Promise<{
    readonly generation: number;
    readonly virtualTime: string;
  }>;
  /**
   * Advance virtual time by `byMs` without changing the domain
   * revision; the clock only moves forward and rejects overflow.
   */
  advanceTime(byMs: number): Promise<{ readonly virtualTime: string }>;
  /**
   * Start the private operator socket for this world. The socket
   * serves protocol v1 over the returned Unix domain socket; its
   * credential never enters participant inputs or evidence exports.
   */
  openControl(options: {
    readonly operatorDirectory: string;
    readonly queueLimit?: number;
  }): Promise<WorldControlServer>;
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
  /**
   * Services advanced by the staged transaction. Published into the
   * committed positions only at commit; a rollback drops them, so a
   * failed exchange leaves identifiers and draws exactly where they
   * were (section 48.2).
   */
  private stagedServices: ServicePositions | null = null;

  private readonly store: StateStore;
  private readonly commitHook: (
    events: readonly CommittedSemanticEvent[]
  ) => void;
  private readonly services: {
    positions: ServicePositions;
  };

  constructor(
    store: StateStore,
    commitHook: (events: readonly CommittedSemanticEvent[]) => void,
    services: { positions: ServicePositions }
  ) {
    this.store = store;
    this.commitHook = commitHook;
    this.services = services;
  }

  /** The committed service positions of the world. */
  get servicePositions(): ServicePositions {
    return {
      ids: { ...this.services.positions.ids },
      random: { ...this.services.positions.random }
    };
  }

  /** Stage the advanced positions of one exchange's services. */
  stageServices(positions: ServicePositions): void {
    this.stagedServices = positions;
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
    if (this.stagedServices !== null) {
      this.services.positions = this.stagedServices;
      this.stagedServices = null;
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
    this.stagedServices = null;
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

/** Runtime identity every environment manifest and checkpoint records. */
export const RUNTIME_NAME = "@oal/environment";

/** The declared pack id of a loaded pack, or the empty string. */
function packIdOf(pack: LoadedPack): string {
  const metadata = isJsonObject(pack.manifest["metadata"])
    ? pack.manifest["metadata"]
    : null;
  return typeof metadata?.["id"] === "string" ? metadata["id"] : "";
}

/** Latest virtual instant the RFC 3339 form carries: year 9999. */
const MAX_VIRTUAL_MS = 253402300799999;

/** The mutable holder the world services reset through. */
interface MutableWorldServices {
  positions: {
    ids: Record<string, number>;
    random: { algorithm: "splitmix64-v1"; state: string };
  };
}

/** Everything a reset or advance effect needs from one live world. */
interface WorldEffects {
  readonly store: StateStore;
  readonly host: BehaviorModuleHost;
  readonly worldId: string;
  readonly seed: string;
  readonly fixtures: readonly Json[];
  readonly services: MutableWorldServices;
  readonly blobRoot: string;
}

/**
 * Reset one world (section 48.4): the next generation, the declared
 * baseline state from a fresh initialize, the baseline clock and
 * counters, and an empty idempotency store. Evidence rows and control
 * results survive; credentials stay valid.
 */
async function resetWorldEffect(
  world: WorldEffects
): Promise<{ generation: number; virtualTime: string }> {
  const generation = world.store.bumpGeneration();
  const initialized = await world.host.initialize({
    runId: world.worldId,
    fixtures: [...world.fixtures],
    clock: clockAdapter(world.store.clock),
    ids: idsAdapter(),
    random: randomAdapter(
      createNamespacePrng(world.seed, `initialize:${world.worldId}`)
    ),
    blobs: fileBlobStore(world.blobRoot)
  });
  if (!isJsonObject(initialized.state)) {
    throw new EnvironmentError(
      EnvironmentCode.InitializeFailed,
      "The behavior backend reset to a non-object state."
    );
  }
  const baseline = initialized.state;
  return world.store.transaction(() => {
    // The declared baseline: clock, counters, streams, replay store.
    world.store.clock.resetTo(VIRTUAL_EPOCH_MS);
    world.store.clearIdempotency();
    world.services.positions.ids = {};
    world.services.positions.random = {
      algorithm: "splitmix64-v1",
      state: createNamespacePrng(world.seed, "world:services").exportState()
    };
    const snapshot = world.store.getState();
    world.store.putState({
      state: baseline,
      expectedRevision: snapshot?.revision ?? null
    });
    return { generation, virtualTime: world.store.clock.now() };
  });
}

/**
 * Advance virtual time (section 48.4): a nonnegative safe integer
 * moves the clock forward only, leaves the domain revision alone, and
 * refuses the overflow beyond the timestamp form.
 */
function advanceWorldEffect(
  world: WorldEffects,
  byMs: number
): { virtualTime: string } {
  const target = world.store.clock.nowMs() + byMs;
  if (!Number.isSafeInteger(target) || target > MAX_VIRTUAL_MS) {
    throw new EnvironmentError(
      EnvironmentCode.ClockUnsupported,
      `Advancing by ${byMs.toString(10)} milliseconds overflows the virtual clock.`
    );
  }
  return { virtualTime: world.store.clock.set(target) };
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
    }),
    ...(options.limits?.maxPersistedStateBytes === undefined
      ? {}
      : {
          limits: {
            maxPersistedStateBytes: options.limits.maxPersistedStateBytes
          }
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
    // The world identity rides the same transactional store so a
    // checkpoint can export its lineage (section 48.4).
    store.initializeWorld({
      worldId,
      generation: store.readWorld()?.generation ?? 1,
      originCheckpointId: null,
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
  // The world's deterministic services: one random stream and one ID
  // counter set, seeded from the world seed. Every exchange draws from
  // a staged copy; only a committed exchange publishes the advanced
  // positions, so a rollback restores them exactly (section 48.2).
  const worldServices: MutableWorldServices = {
    positions: {
      ids: {},
      random: {
        algorithm: "splitmix64-v1",
        state: createNamespacePrng(seed, "world:services").exportState()
      }
    }
  };
  const gatewayState = new StoreGatewayState(
    store,
    (events) => {
      allEvents.push(...events);
    },
    worldServices
  );

  const backend: ScenarioBackend = {
    name: packBehaviorName(pack),
    handle: async (
      request: BehaviorRequest,
      gatewayRequestId: string
    ): Promise<ScenarioOutcome> => {
      const allocation = gatewayState.request;
      const requestId = allocation?.requestId ?? gatewayRequestId;
      const snapshot = store.getState();
      const services = gatewayState.servicePositions;
      const outcome = await executeBehaviorRequest({
        backend: host,
        request,
        runId: worldId,
        requestId,
        state: snapshot?.state ?? initialState,
        clock: clockAdapter(store.clock),
        // The adapters below are controller-side stand-ins: the child
        // rebuilds its own staged copies from the committed positions
        // on the wire and reports the advanced copy on the result
        // (section 16.5, 48.2).
        ids: idsAdapter(services.ids),
        random: randomAdapter(
          DeterministicPrng.fromState(services.random.state)
        ),
        blobs: fileBlobStore(blobRoot),
        stateSchema: declaration.stateSchema,
        maxStateBytes:
          options.limits?.maxStateBytes ?? store.limits.maxPersistedStateBytes,
        eventRegistry,
        timeoutMs,
        services
      });
      if (outcome.ok) {
        gatewayState.stageServices(outcome.result.services ?? services);
      }
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
      generation: store.readWorld()?.generation ?? 1,
      parentCheckpointId: null,
      pack: {
        id: typeof metadata?.["id"] === "string" ? metadata["id"] : "",
        version:
          typeof metadata?.["version"] === "string" ? metadata["version"] : "",
        packSha256: options.records.packSha256
      },
      scenarioId: options.scenarioId,
      behaviorSha256: declaration.entrypoint.sha256,
      runtimeName: RUNTIME_NAME,
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
        checkpoint: "available",
        reset: "available",
        advanceTime: "available",
        fork: "available",
        scheduledWork: "unsupported"
      }
    };
  };

  const worldEffects: WorldEffects = {
    store,
    host,
    worldId,
    seed,
    fixtures: [...declaration.fixtures],
    services: worldServices,
    blobRoot
  };
  const writeCheckpoint = async (out: string): Promise<CheckpointWritten> => {
    const checkpointId = `chk_${(store.countControls() + 1)
      .toString(10)
      .padStart(8, "0")}`;
    const positions = gatewayState.servicePositions;
    const clockSnapshot = store.clock.snapshot();
    const document = store.exportCheckpoint({
      checkpointId,
      frozen: {
        pack_id: packIdOf(pack),
        pack_sha256: options.records.packSha256,
        scenario_id: options.scenarioId,
        seed,
        behavior_sha256: declaration.entrypoint.sha256,
        behavior_closure_identity: closure.identity,
        runtime_name: RUNTIME_NAME,
        contract_semantic_sha256: contract.semanticSha256,
        contract_execution_sha256: contract.executionSha256
      },
      services: {
        clock: {
          now_ms: clockSnapshot.nowMs,
          tick_ms: clockSnapshot.tickMs
        },
        ids: { positions: { ...positions.ids } },
        random: [
          {
            namespace: "world:services",
            algorithm: positions.random.algorithm,
            state: positions.random.state
          }
        ],
        faults: {
          counters: {},
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: createNamespacePrng(seed, "faults").exportState()
          }
        }
      }
    });
    const written = await writeCheckpointDirectory({
      directory: out,
      document,
      contractIr: contract.ir as unknown as Json,
      blobSourceRoot: blobRoot,
      frozenSourceRoot: join(pack.root, ".oal", "frozen", closure.identity),
      frozenEntryPath: closure.entryPath,
      createdAt: formatRfc3339(options.now())
    });
    return { directory: out, checkpointId: written.checkpoint_id };
  };

  let closed = false;
  return {
    contract,
    backend,
    state: gatewayState,
    backendSha256: declaration.entrypoint.sha256,
    isolationLevel: host.isolationLevel,
    description,
    manifest,
    manifestDocument: (): JsonObject => manifestDocumentOf(manifest()),
    inspect: (): JsonObject => ({
      ...manifestDocumentOf(manifest()),
      request_count: store.countRequests(),
      control_count: store.countControls()
    }),
    checkpoint: writeCheckpoint,
    reset: () => resetWorldEffect(worldEffects),
    advanceTime: (byMs: number): Promise<{ virtualTime: string }> =>
      Promise.resolve().then(() => advanceWorldEffect(worldEffects, byMs)),
    openControl: (socketOptions) =>
      startWorldControl({
        operatorDirectory: socketOptions.operatorDirectory,
        ...(socketOptions.queueLimit === undefined
          ? {}
          : { queueLimit: socketOptions.queueLimit }),
        handlers: {
          world: (): ControlOutcome => ({
            httpStatus: 200,
            envelope: {
              schema_version: 1,
              status: "ok",
              result: {
                ...manifestDocumentOf(manifest()),
                request_count: store.countRequests(),
                control_count: store.countControls()
              },
              diagnostics: [],
              artifacts: []
            }
          }),
          checkpoint: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/checkpoints",
              payload,
              effect: async (): Promise<ControlOutcome> => {
                const out = payload["out"];
                if (typeof out !== "string" || out.length === 0) {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-CONTROL-BODY",
                        "checkpoints requires out as a new local output path."
                      )
                    ])
                  };
                }
                try {
                  const written = await writeCheckpoint(out);
                  return {
                    httpStatus: 200,
                    envelope: controlEnvelope("ok", {
                      directory: written.directory,
                      checkpoint_id: written.checkpointId
                    })
                  };
                } catch (error) {
                  return {
                    httpStatus: error instanceof OalError ? 409 : 500,
                    envelope: controlEnvelope("failed", null, [
                      controlDiagnostic(
                        "OAL-WORLD-CONTROL-FAILED",
                        error instanceof Error ? error.message : String(error)
                      )
                    ])
                  };
                }
              }
            }),
          reset: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/reset",
              payload,
              effect: async (): Promise<ControlOutcome> => {
                const result = await resetWorldEffect(worldEffects);
                return {
                  httpStatus: 200,
                  envelope: controlEnvelope("ok", {
                    generation: result.generation,
                    virtual_time: result.virtualTime
                  })
                };
              }
            }),
          advanceTime: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/advance-time",
              payload,
              effect: (): ControlOutcome => {
                const byMs = payload["by_ms"];
                if (typeof byMs !== "number") {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-CONTROL-BODY",
                        "advance-time requires by_ms as a nonnegative safe integer."
                      )
                    ])
                  };
                }
                try {
                  const result = advanceWorldEffect(worldEffects, byMs);
                  return {
                    httpStatus: 200,
                    envelope: controlEnvelope("ok", {
                      virtual_time: result.virtualTime
                    })
                  };
                } catch (error) {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-TIME-OVERFLOW",
                        error instanceof Error ? error.message : String(error)
                      )
                    ])
                  };
                }
              }
            })
        }
      }),
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

/** The `environment.v1` wire form of one manifest projection. */
function manifestDocumentOf(manifest: EnvironmentManifest): JsonObject {
  return {
    schema_version: 1,
    kind: manifest.kind,
    world_id: manifest.worldId,
    generation: manifest.generation,
    parent_checkpoint_id: manifest.parentCheckpointId,
    pack: {
      id: manifest.pack.id,
      version: manifest.pack.version,
      pack_sha256: manifest.pack.packSha256
    },
    scenario_id: manifest.scenarioId,
    behavior_sha256: manifest.behaviorSha256,
    runtime_name: manifest.runtimeName,
    behavior_closure: {
      identity: manifest.behaviorClosure.identity,
      entry_path: manifest.behaviorClosure.entryPath,
      file_count: manifest.behaviorClosure.fileCount
    },
    seed: manifest.seed,
    revision: manifest.revision,
    virtual_time: manifest.virtualTime,
    isolation_level: manifest.isolationLevel,
    capabilities: {
      checkpoint: manifest.capabilities.checkpoint,
      reset: manifest.capabilities.reset,
      advance_time: manifest.capabilities.advanceTime,
      fork: manifest.capabilities.fork,
      scheduled_work: manifest.capabilities.scheduledWork
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
    // A modeled error carries its body's media type so the gateway's
    // negotiation sees the domain answer, not a framework refusal:
    // a deleted clip reads 404, not 406.
    const body = outcome.error.behaviorBody;
    return {
      kind: "served",
      response: {
        status: outcome.error.status,
        ...(body === undefined
          ? {}
          : {
              body,
              mediaType:
                body.kind === "text" ? "text/plain" : "application/json"
            })
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

/** Options of {@link openRestoredEnvironment}; a fork never takes a trial plan. */
export interface RestoreEnvironmentOptions {
  /** The validated checkpoint this world continues. */
  readonly checkpoint: ReadCheckpoint;
  /** New world identity; the checkpoint lineage records the parent. */
  readonly worldId: string;
  /** Absolute path of the new world's SQLite state store. */
  readonly databasePath: string;
  /** Batch identity the new run records. */
  readonly batchId: string;
  readonly limits?: EnvironmentLimits;
  /** Injected observation clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Open one environment restored from a checkpoint: the new world
 * imports the checkpoint's state, replay entries, and blobs under a
 * fresh key, continues the domain identifiers and every stream from
 * the checkpoint position, and executes the checkpoint's frozen
 * behavior tree, so the original checkout is no longer needed
 * (section 48.4). The fork is a new world: new identity, new
 * generation count, new evidence namespace, and no parent events.
 */
export async function openRestoredEnvironment(
  options: RestoreEnvironmentOptions
): Promise<Environment> {
  const { checkpoint, worldId } = options;
  const document = checkpoint.document;
  if (document.frozen.runtime_name !== RUNTIME_NAME) {
    throw new EnvironmentError(
      EnvironmentCode.CheckpointIncompatible,
      `The checkpoint was written by ${JSON.stringify(document.frozen.runtime_name)}; this build restores ${RUNTIME_NAME} only.`
    );
  }
  const timeoutMs =
    options.limits?.behaviorTimeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS;
  const contract: EnvironmentContractInputs = {
    ir: checkpoint.contractIr as unknown as ContractIR,
    semanticSha256: document.frozen.contract_semantic_sha256,
    executionSha256: document.frozen.contract_execution_sha256
  };
  const seed = document.frozen.seed;
  const host = new BehaviorModuleHost({
    entry: checkpoint.frozenEntry,
    context: {
      contract: contract.ir,
      packRoot: checkpoint.frozenRoot,
      config: {}
    },
    runSeed: seed,
    timeoutMs,
    cwd: checkpoint.frozenRoot
  });
  await host.start();

  const store = StateStore.open({
    path: options.databasePath,
    runId: worldId,
    // The clock continues from the checkpoint position: the fork's
    // logical time does not restart (section 48.4).
    clock: new VirtualClock({
      initialMs: document.clock.now_ms,
      tickMs: document.clock.tick_ms
    })
  });
  let description: BackendDescription;
  try {
    store.importCheckpoint(JSON.parse(JSON.stringify(document)) as Json, {
      worldId,
      generation: 1
    });
    store.initializeRun({
      batchId: options.batchId,
      contractSemanticSha256: contract.semanticSha256,
      contractExecutionSha256: contract.executionSha256,
      sourceInventorySha256: document.frozen.pack_sha256,
      packSha256: document.frozen.pack_sha256,
      scenarioSha256: sha256Hex(document.frozen.scenario_id),
      backendSha256: document.frozen.behavior_sha256,
      implementationSha256: contract.executionSha256,
      seed,
      stateSchemaVersion: document.state.state_schema_version,
      createdAt: formatRfc3339(options.now())
    });

    description = await host.describe();
    const backendApiVersion: number = description.backendApiVersion;
    if (backendApiVersion !== 1) {
      throw new EnvironmentError(
        EnvironmentCode.BackendApiUnsupported,
        `The behavior backend speaks API version ${String(backendApiVersion)}; this environment serves version 1.`
      );
    }
    if (
      description.stateSchemaVersion !== document.state.state_schema_version
    ) {
      throw new EnvironmentError(
        EnvironmentCode.StateSchemaInvalid,
        `The frozen backend serves state schema version ${String(description.stateSchemaVersion)}, but the checkpoint pins ${String(document.state.state_schema_version)}.`
      );
    }
    checkOperationCoverage(description, contract);

    // The child initializes from the same seed namespace so its
    // module invariants match the source's startup; the restored
    // state stays authoritative and the returned initial state is
    // discarded.
    await host.initialize({
      runId: worldId,
      fixtures: [],
      clock: clockAdapter(store.clock),
      ids: idsAdapter({ ...document.ids.positions }),
      random: randomAdapter(createNamespacePrng(seed, `initialize:${worldId}`)),
      blobs: fileBlobStore(checkpoint.blobRoot)
    });
  } catch (cause) {
    store.close();
    await host.close().catch(() => undefined);
    if (cause instanceof EnvironmentError) {
      throw cause;
    }
    throw new EnvironmentError(
      EnvironmentCode.InitializeFailed,
      `The restored environment failed to bootstrap: ${
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

  // A fork's evidence starts empty: the parent's events do not
  // duplicate, and an origin record names the checkpoint lineage.
  const allEvents: CommittedSemanticEvent[] = [];
  const servicesStream =
    document.random.streams.find(
      (stream) => stream.namespace === "world:services"
    ) ?? document.random.streams[0];
  if (servicesStream === undefined) {
    throw new EnvironmentError(
      EnvironmentCode.CheckpointIncomplete,
      "The checkpoint carries no world services stream."
    );
  }
  const worldServices: MutableWorldServices = {
    positions: {
      ids: { ...document.ids.positions },
      random: {
        algorithm: "splitmix64-v1",
        state: servicesStream.state
      }
    }
  };
  const gatewayState = new StoreGatewayState(
    store,
    (events) => {
      allEvents.push(...events);
    },
    worldServices
  );

  const restoredState = document.state.state;
  const backend: ScenarioBackend = {
    name: document.frozen.pack_id || "restored-world",
    handle: async (
      request: BehaviorRequest,
      gatewayRequestId: string
    ): Promise<ScenarioOutcome> => {
      const allocation = gatewayState.request;
      const requestId = allocation?.requestId ?? gatewayRequestId;
      const snapshot = store.getState();
      const services = gatewayState.servicePositions;
      const outcome = await executeBehaviorRequest({
        backend: host,
        request,
        runId: worldId,
        requestId,
        state: snapshot?.state ?? restoredState,
        clock: clockAdapter(store.clock),
        ids: idsAdapter(services.ids),
        random: randomAdapter(
          DeterministicPrng.fromState(services.random.state)
        ),
        blobs: fileBlobStore(checkpoint.blobRoot),
        stateSchema: null,
        maxStateBytes:
          options.limits?.maxStateBytes ?? store.limits.maxPersistedStateBytes,
        eventRegistry,
        timeoutMs,
        services
      });
      if (outcome.ok) {
        gatewayState.stageServices(outcome.result.services ?? services);
      }
      return scenarioOutcomeOf(outcome);
    }
  };

  const manifest = (): EnvironmentManifest => {
    const snapshot = store.getState();
    return {
      kind: "EnvironmentManifest",
      worldId,
      generation: store.readWorld()?.generation ?? 1,
      parentCheckpointId: document.checkpoint_id,
      pack: {
        id: document.frozen.pack_id,
        version: "",
        packSha256: document.frozen.pack_sha256
      },
      scenarioId: document.frozen.scenario_id,
      behaviorSha256: document.frozen.behavior_sha256,
      runtimeName: RUNTIME_NAME,
      behaviorClosure: {
        identity: document.frozen.behavior_closure_identity,
        entryPath: checkpoint.manifest.frozen_entry_path,
        fileCount: checkpoint.manifest.frozen_file_count
      },
      seed,
      revision: snapshot?.revision ?? 0,
      virtualTime: store.clock.now(),
      isolationLevel: host.isolationLevel,
      capabilities: {
        checkpoint: "available",
        reset: "available",
        advanceTime: "available",
        fork: "available",
        scheduledWork: "unsupported"
      }
    };
  };

  const restoredEffects: WorldEffects = {
    store,
    host,
    worldId,
    seed,
    fixtures: [],
    services: worldServices,
    blobRoot: checkpoint.blobRoot
  };
  const writeRestoredCheckpoint = async (
    out: string
  ): Promise<CheckpointWritten> => {
    const checkpointId = `chk_${(store.countControls() + 1)
      .toString(10)
      .padStart(8, "0")}`;
    const positions = gatewayState.servicePositions;
    const clockSnapshot = store.clock.snapshot();
    const exported = store.exportCheckpoint({
      checkpointId,
      frozen: { ...document.frozen },
      services: {
        clock: {
          now_ms: clockSnapshot.nowMs,
          tick_ms: clockSnapshot.tickMs
        },
        ids: { positions: { ...positions.ids } },
        random: [
          {
            namespace: "world:services",
            algorithm: positions.random.algorithm,
            state: positions.random.state
          }
        ],
        faults: {
          counters: { ...document.faults.counters },
          random: { ...document.faults.random }
        }
      }
    });
    const written = await writeCheckpointDirectory({
      directory: out,
      document: exported,
      contractIr: contract.ir as unknown as Json,
      blobSourceRoot: checkpoint.blobRoot,
      frozenSourceRoot: checkpoint.frozenRoot,
      frozenEntryPath: checkpoint.manifest.frozen_entry_path,
      createdAt: formatRfc3339(options.now())
    });
    return { directory: out, checkpointId: written.checkpoint_id };
  };

  let closed = false;
  return {
    contract,
    backend,
    state: gatewayState,
    backendSha256: document.frozen.behavior_sha256,
    isolationLevel: host.isolationLevel,
    description,
    manifest,
    manifestDocument: (): JsonObject => manifestDocumentOf(manifest()),
    inspect: (): JsonObject => ({
      ...manifestDocumentOf(manifest()),
      request_count: store.countRequests(),
      control_count: store.countControls()
    }),
    checkpoint: writeRestoredCheckpoint,
    reset: () => resetWorldEffect(restoredEffects),
    advanceTime: (byMs: number): Promise<{ virtualTime: string }> =>
      Promise.resolve().then(() => advanceWorldEffect(restoredEffects, byMs)),
    openControl: (socketOptions) =>
      startWorldControl({
        operatorDirectory: socketOptions.operatorDirectory,
        ...(socketOptions.queueLimit === undefined
          ? {}
          : { queueLimit: socketOptions.queueLimit }),
        handlers: {
          world: (): ControlOutcome => ({
            httpStatus: 200,
            envelope: {
              schema_version: 1,
              status: "ok",
              result: {
                ...manifestDocumentOf(manifest()),
                request_count: store.countRequests(),
                control_count: store.countControls()
              },
              diagnostics: [],
              artifacts: []
            }
          }),
          checkpoint: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/checkpoints",
              payload,
              effect: async (): Promise<ControlOutcome> => {
                const out = payload["out"];
                if (typeof out !== "string" || out.length === 0) {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-CONTROL-BODY",
                        "checkpoints requires out as a new local output path."
                      )
                    ])
                  };
                }
                const written = await writeRestoredCheckpoint(out);
                return {
                  httpStatus: 200,
                  envelope: controlEnvelope("ok", {
                    directory: written.directory,
                    checkpoint_id: written.checkpointId
                  })
                };
              }
            }),
          reset: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/reset",
              payload,
              effect: async (): Promise<ControlOutcome> => {
                const result = await resetWorldEffect(restoredEffects);
                return {
                  httpStatus: 200,
                  envelope: controlEnvelope("ok", {
                    generation: result.generation,
                    virtual_time: result.virtualTime
                  })
                };
              }
            }),
          advanceTime: (payload): ControlEffect =>
            runControl(store, {
              route: "/v1/advance-time",
              payload,
              effect: (): ControlOutcome => {
                const byMs = payload["by_ms"];
                if (typeof byMs !== "number") {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-CONTROL-BODY",
                        "advance-time requires by_ms as a nonnegative safe integer."
                      )
                    ])
                  };
                }
                try {
                  const result = advanceWorldEffect(restoredEffects, byMs);
                  return {
                    httpStatus: 200,
                    envelope: controlEnvelope("ok", {
                      virtual_time: result.virtualTime
                    })
                  };
                } catch (error) {
                  return {
                    httpStatus: 400,
                    envelope: controlEnvelope("invalid", null, [
                      controlDiagnostic(
                        "OAL-WORLD-TIME-OVERFLOW",
                        error instanceof Error ? error.message : String(error)
                      )
                    ])
                  };
                }
              }
            })
        }
      }),
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
    projection: (): Promise<JsonObject | null> => Promise.resolve(null)
  };
}

/**
 * Read and validate one checkpoint directory for a restore. Every
 * failure throws before any listener or world opens (section 48.4).
 */
export async function readCheckpoint(
  directory: string
): Promise<ReadCheckpoint> {
  return readCheckpointDirectory(directory);
}
