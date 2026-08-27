/**
 * Behavior request execution (specification section 16.3). The executor
 * enforces the transactional semantics around one backend call: state
 * validation before commit, semantic-event registry checks, and
 * rollback on any failure. Requests are handled serially per run in
 * ingress order by the caller.
 */

import { SchemaValidator, type Json } from "@oal/core";
import {
  BehaviorHttpError,
  BehaviorTimeoutError,
  DEFAULT_BEHAVIOR_TIMEOUT_MS
} from "./error.ts";
import type {
  BehaviorBackend,
  BehaviorRequest,
  BehaviorResult,
  DeterministicClock,
  DeterministicIds,
  DeterministicRandom,
  BlobStore
} from "./types.ts";

export interface RegisteredEvent {
  eventVersion: number;
  payloadSchema: Json;
}

export interface ExecuteOptions {
  backend: BehaviorBackend;
  request: BehaviorRequest;
  runId: string;
  requestId: string;
  state: Json;
  clock: DeterministicClock;
  ids: DeterministicIds;
  random: DeterministicRandom;
  blobs: BlobStore;
  /** Pack Draft 2020-12 state schema; omitted disables the check. */
  stateSchema?: Json;
  /** Maximum serialized state size in bytes. */
  maxStateBytes: number;
  /** Bounded per-call timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Semantic-event registry from the backend description. */
  eventRegistry: ReadonlyMap<string, RegisteredEvent>;
}

export type ExecuteOutcome =
  | {
      ok: true;
      result: BehaviorResult;
      /** State after the transaction: nextState when valid, else input. */
      state: Json;
      committed: boolean;
    }
  | { ok: false; kind: "http_error"; error: BehaviorHttpError }
  | {
      ok: false;
      kind: "timeout";
      code: "behavior_timeout";
      /** The bound that fired, in milliseconds. */
      timeoutMs: number;
      message: string;
    }
  | {
      ok: false;
      kind: "internal";
      code: "behavior_internal_error";
      message: string;
    };

/**
 * Run one behavior request under version 1 semantics. The backend
 * receives immutable state; only a valid nextState commits. Any
 * failure, including a timeout, rolls everything back to the input
 * state.
 */
export async function executeBehaviorRequest(
  options: ExecuteOptions
): Promise<ExecuteOutcome> {
  const { backend, request, state } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      ok: false,
      kind: "internal",
      code: "behavior_internal_error",
      message: `timeoutMs must be a positive finite number, got ${timeoutMs}.`
    };
  }
  let result: BehaviorResult;
  try {
    result = await withTimeout(
      backend.handle(request, {
        runId: options.runId,
        requestId: options.requestId,
        state,
        clock: options.clock,
        ids: options.ids,
        random: options.random,
        blobs: options.blobs
      }),
      timeoutMs
    );
  } catch (error) {
    if (error instanceof BehaviorHttpError) {
      // A declared HTTP error returns its contract-shaped body and
      // rolls state back.
      return { ok: false, kind: "http_error", error };
    }
    if (error instanceof BehaviorTimeoutError) {
      // A timed-out backend call is a transport failure with its own
      // stable code; state rolls back like any other failure.
      return {
        ok: false,
        kind: "timeout",
        code: "behavior_timeout",
        timeoutMs: error.timeoutMs,
        message: error.message
      };
    }
    return {
      ok: false,
      kind: "internal",
      code: "behavior_internal_error",
      message: error instanceof Error ? error.message : "unknown failure"
    };
  }

  if (result.nextState !== undefined) {
    const stateCheck = checkState(result.nextState, options);
    if (stateCheck !== null) {
      return {
        ok: false,
        kind: "internal",
        code: "behavior_internal_error",
        message: stateCheck
      };
    }
  }
  const eventCheck = checkSemanticEvents(result, options.eventRegistry);
  if (eventCheck !== null) {
    return {
      ok: false,
      kind: "internal",
      code: "behavior_internal_error",
      message: eventCheck
    };
  }

  return {
    ok: true,
    result,
    state: result.nextState ?? state,
    committed: result.nextState !== undefined
  };
}

/**
 * Reject with `BehaviorTimeoutError` when the call outlives its bound.
 * The racing timer is always cleared, and the losing promise keeps a
 * handler attached, so a late result or rejection is never unhandled.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BehaviorTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function checkState(state: Json, options: ExecuteOptions): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return "nextState is not JSON-serializable";
  }
  if (Buffer.byteLength(serialized, "utf8") > options.maxStateBytes) {
    return `nextState exceeds the ${options.maxStateBytes} byte state limit`;
  }
  if (options.stateSchema !== undefined) {
    const validator = new SchemaValidator(options.stateSchema);
    const errors = validator.errors(state);
    if (errors.length > 0) {
      return `nextState violates the pack state schema at ${errors[0]?.pointer ?? "/"}: ${errors[0]?.message ?? "invalid"}`;
    }
  }
  return null;
}

function checkSemanticEvents(
  result: BehaviorResult,
  registry: ReadonlyMap<string, RegisteredEvent>
): string | null {
  const events = result.semanticEvents ?? [];
  for (const event of events) {
    const registered = registry.get(event.name);
    if (registered === undefined) {
      return `semantic event ${event.name} is not registered by the backend`;
    }
    if (registered.eventVersion !== event.eventVersion) {
      return `semantic event ${event.name} declares version ${event.eventVersion}, registry pins ${registered.eventVersion}`;
    }
    const validator = new SchemaValidator(registered.payloadSchema);
    const errors = validator.errors(event.payload);
    if (errors.length > 0) {
      return `semantic event ${event.name} payload violates its schema at ${errors[0]?.pointer ?? "/"}`;
    }
  }
  return null;
}
