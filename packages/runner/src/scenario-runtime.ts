/**
 * The trial adapter over the shared environment owner (specification
 * sections 16.3, 16.5, and 48.2). Environment ownership — behavior
 * startup, the state store, validation, projection, and shutdown —
 * lives in `@oal/environment`, which both the runner and standalone
 * serving consume. This adapter translates the trial plan into the
 * environment's frozen inputs and keeps the historical
 * {@link ScenarioRuntime} shape the trial loop expects.
 */

import type { BackendDescription } from "@oal/behavior-api";
import type { JsonObject } from "@oal/core";
import type { GatewayState, ScenarioBackend } from "@oal/gateway";
import type { LoadedPack } from "@oal/pack";
import {
  EnvironmentError,
  openEnvironment,
  type CommittedSemanticEvent,
  type Environment
} from "@oal/environment";

// The trial loop keeps importing these through its historical module.
export { ensureStateDirectory } from "@oal/environment";
export type { CommittedSemanticEvent } from "@oal/environment";

import type { Clock } from "./lifecycle.ts";
import type { FrozenPlan } from "./preflight.ts";

/**
 * Stable bootstrap failure codes of the scenario runtime. The codes
 * keep their historical names; the environment owner raises them.
 */
export const ScenarioCode = {
  BackendMissing: "OAL-SCENARIO-BACKEND-MISSING",
  BackendApiUnsupported: "OAL-SCENARIO-BACKEND-API-UNSUPPORTED",
  CoverageMismatch: "OAL-SCENARIO-COVERAGE-MISMATCH",
  StateSchemaInvalid: "OAL-SCENARIO-STATE-SCHEMA-INVALID",
  ClockUnsupported: "OAL-SCENARIO-CLOCK-UNSUPPORTED",
  InitializeFailed: "OAL-SCENARIO-INITIALIZE-FAILED"
} as const;

/**
 * A scenario runtime defect from before or during the run. The class
 * is the environment owner's error; the alias keeps the trial loop's
 * historical name.
 */
export const ScenarioRuntimeError = EnvironmentError;

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

/**
 * Open the scenario runtime of one trial through the shared
 * environment owner. The caller owns the lifetime and must close() it
 * on every exit route.
 */
export async function openScenarioRuntime(
  options: ScenarioRuntimeOptions
): Promise<ScenarioRuntime> {
  const { plan } = options;
  const environment: Environment = await openEnvironment({
    pack: options.pack,
    contract: {
      ir: plan.contract.ir,
      semanticSha256: plan.contract.semanticSha256,
      executionSha256: plan.contract.executionSha256
    },
    scenarioId: plan.scenarioId,
    seed: options.trialSeed,
    worldId: options.runId,
    databasePath: options.databasePath,
    records: {
      batchId: plan.batchId,
      packSha256: plan.pack.packSha256,
      implementationSha256: plan.contract.executionSha256
    },
    now: options.now,
    ...(options.timeoutMs === undefined
      ? {}
      : { limits: { behaviorTimeoutMs: options.timeoutMs } })
  });
  return {
    backend: environment.backend,
    state: environment.state,
    backendSha256: environment.backendSha256,
    isolationLevel: environment.isolationLevel,
    description: environment.description,
    close: () => environment.close(),
    finalState: () => environment.finalState(),
    semanticEvents: () => environment.semanticEvents(),
    projection: () => environment.projection()
  };
}
