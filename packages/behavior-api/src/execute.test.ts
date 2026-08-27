import { afterEach, describe, expect, it, vi } from "vitest";

import type { Json } from "@oal/core";
import type { OperationIR } from "@oal/contract-ir";
import {
  BehaviorHttpError,
  BehaviorTimeoutError,
  DEFAULT_BEHAVIOR_TIMEOUT_MS
} from "./error.ts";
import {
  executeBehaviorRequest,
  type ExecuteOptions,
  type ExecuteOutcome,
  type RegisteredEvent
} from "./execute.ts";
import type {
  BehaviorBackend,
  BehaviorRequest,
  BehaviorResult,
  HandleContext
} from "./types.ts";

function operation(): OperationIR {
  return {
    key: "path:POST /things",
    uid: "op_test1",
    surface: "path",
    method: "POST",
    path_template: "/things",
    route_segments: [{ kind: "literal", value: "things" }],
    operation_id: null,
    tool_name: "create_thing",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    request_body: null,
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function request(): BehaviorRequest {
  return {
    operation: operation(),
    principal: null,
    parameters: { path: {}, query: {}, header: {}, cookie: {} },
    body: { kind: "none" },
    selectedRequestMediaType: null,
    acceptedResponseMediaTypes: []
  };
}

/** Backend stub that records the context and returns a queued result. */
function backend(
  respond: (context: HandleContext) => BehaviorResult | Promise<BehaviorResult>
): BehaviorBackend & { contexts: HandleContext[] } {
  const contexts: HandleContext[] = [];
  return {
    contexts,
    describe() {
      return Promise.resolve({
        backendApiVersion: 1,
        stateSchemaVersion: 1,
        operations: []
      });
    },
    initialize() {
      return Promise.resolve({ state: {} });
    },
    async handle(_request: BehaviorRequest, context: HandleContext) {
      contexts.push(context);
      return respond(context);
    }
  };
}

function options(
  backendImpl: BehaviorBackend,
  init: {
    state?: Json;
    stateSchema?: Json;
    events?: Record<string, RegisteredEvent>;
    maxStateBytes?: number;
    timeoutMs?: number;
  } = {}
): ExecuteOptions {
  const executeOptions: ExecuteOptions = {
    backend: backendImpl,
    request: request(),
    runId: "run_test",
    requestId: "req_00000001",
    state: init.state ?? {},
    clock: { now: () => "2000-01-01T00:00:01.000Z", nowMs: () => 1_000 },
    ids: { next: (prefix) => `${prefix}_00000001` },
    random: {
      nextFloat: () => 0.5,
      nextInt: (maxExclusive) => maxExclusive - 1,
      nextBytes: (length) => new Uint8Array(length)
    },
    blobs: {
      put: (bytes: Uint8Array) =>
        Promise.reject(
          new Error(`unexpected blob put of ${bytes.length} bytes`)
        ),
      get: () => Promise.resolve(null)
    },
    maxStateBytes: init.maxStateBytes ?? 1_000_000,
    eventRegistry: new Map(Object.entries(init.events ?? {}))
  };
  if (init.stateSchema !== undefined) {
    executeOptions.stateSchema = init.stateSchema;
  }
  if (init.timeoutMs !== undefined) {
    executeOptions.timeoutMs = init.timeoutMs;
  }
  return executeOptions;
}

/** The internal error message, or a marker naming the wrong outcome. */
function internalMessage(outcome: ExecuteOutcome): string {
  if (!outcome.ok && outcome.kind === "internal") {
    return outcome.message;
  }
  return `<wrong outcome: ${outcome.ok ? "ok" : outcome.kind}>`;
}

function counted(): BehaviorResult {
  return {
    response: { status: 201 },
    nextState: { count: 1 },
    effects: [],
    semanticEvents: []
  };
}

describe("executeBehaviorRequest", () => {
  it("commits a valid nextState", async () => {
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(backend(() => counted()))
    );
    expect(outcome).toMatchObject({
      ok: true,
      committed: true,
      state: { count: 1 }
    });
  });

  it("keeps the input state when the backend returns no nextState", async () => {
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(
        backend(() => ({
          response: { status: 204 }
        }))
      )
    );
    expect(outcome).toMatchObject({ ok: true, committed: false, state: {} });
  });

  it("passes run identity, state, and services to the backend", async () => {
    const impl = backend(() => counted());
    await executeBehaviorRequest(options(impl, { state: { seedState: true } }));
    const context = impl.contexts[0];
    expect(context).toBeDefined();
    expect(context?.runId).toBe("run_test");
    expect(context?.requestId).toBe("req_00000001");
    expect(context?.state).toEqual({ seedState: true });
    expect(context?.clock.nowMs()).toBe(1_000);
    expect(context?.ids.next("evt")).toBe("evt_00000001");
  });

  it("returns an http_error outcome for BehaviorHttpError and keeps state", async () => {
    const impl = backend(() => {
      throw new BehaviorHttpError({
        status: 422,
        code: "invalid_team",
        message: "team is unknown"
      });
    });
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, { state: { before: true } })
    );
    expect(outcome).toMatchObject({
      ok: false,
      kind: "http_error",
      error: { status: 422, code: "invalid_team" }
    });
  });

  it("returns an internal outcome for an unexpected throw", async () => {
    const impl = backend(() => {
      throw new Error("module bug");
    });
    const outcome: ExecuteOutcome = await executeBehaviorRequest(options(impl));
    expect(outcome).toMatchObject({
      ok: false,
      kind: "internal",
      code: "behavior_internal_error",
      message: "module bug"
    });
  });

  it("rejects a nextState that is not JSON-serializable", async () => {
    const impl = backend(() => ({
      response: { status: 200 },
      nextState: { count: 1n } as unknown as Json
    }));
    const outcome: ExecuteOutcome = await executeBehaviorRequest(options(impl));
    expect(outcome).toMatchObject({
      ok: false,
      kind: "internal",
      code: "behavior_internal_error",
      message: "nextState is not JSON-serializable"
    });
  });

  it("rejects a nextState beyond the byte bound", async () => {
    const impl = backend(() => ({
      response: { status: 200 },
      nextState: { padding: "x".repeat(64) }
    }));
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, { state: {}, maxStateBytes: 16 })
    );
    expect(internalMessage(outcome)).toContain("state limit");
  });

  it("rejects a nextState that violates the pack state schema", async () => {
    const impl = backend(() => ({
      response: { status: 200 },
      nextState: { count: "not-a-number" }
    }));
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, {
        stateSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false
        }
      })
    );
    expect(internalMessage(outcome)).toContain("state schema");
  });

  it("rejects a semantic event the backend never registered", async () => {
    const impl = backend(() => ({
      response: { status: 200 },
      semanticEvents: [{ name: "thing.created", eventVersion: 1, payload: {} }]
    }));
    const outcome: ExecuteOutcome = await executeBehaviorRequest(options(impl));
    expect(internalMessage(outcome)).toContain("not registered");
  });

  it("rejects a registered event with the wrong version or payload", async () => {
    const events: Record<string, RegisteredEvent> = {
      "thing.created": {
        eventVersion: 2,
        payloadSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      }
    };
    const wrongVersion: ExecuteOutcome = await executeBehaviorRequest(
      options(
        backend(() => ({
          response: { status: 200 },
          semanticEvents: [
            { name: "thing.created", eventVersion: 1, payload: { id: "t1" } }
          ]
        })),
        { events }
      )
    );
    expect(internalMessage(wrongVersion)).toContain("version");
    const wrongPayload: ExecuteOutcome = await executeBehaviorRequest(
      options(
        backend(() => ({
          response: { status: 200 },
          semanticEvents: [
            { name: "thing.created", eventVersion: 2, payload: { id: 7 } }
          ]
        })),
        { events }
      )
    );
    expect(internalMessage(wrongPayload)).toContain("payload");
  });

  it("accepts a registered event with a matching payload", async () => {
    const impl = backend(() => ({
      response: { status: 200 },
      semanticEvents: [
        { name: "thing.created", eventVersion: 2, payload: { id: "t1" } }
      ]
    }));
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, {
        events: {
          "thing.created": {
            eventVersion: 2,
            payloadSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"]
            }
          }
        }
      })
    );
    expect(outcome.ok).toBe(true);
  });

  it("classifies a backend that exceeds its bound as a timeout", async () => {
    vi.useFakeTimers();
    const impl = backend(() => new Promise<BehaviorResult>(() => undefined));
    let settled = false;
    const promise = executeBehaviorRequest(
      options(impl, { state: { before: true }, timeoutMs: 50 })
    ).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      ok: false,
      kind: "timeout",
      code: "behavior_timeout",
      timeoutMs: 50
    });
    // A timeout outcome carries no state, so the caller keeps the input
    // state and nothing commits.
    expect(Object.hasOwn(outcome, "state")).toBe(false);
    expect(Object.hasOwn(outcome, "committed")).toBe(false);
  });

  it("applies the default bound when no timeout is configured", async () => {
    vi.useFakeTimers();
    const impl = backend(() => new Promise<BehaviorResult>(() => undefined));
    const promise = executeBehaviorRequest(options(impl));
    await vi.advanceTimersByTimeAsync(DEFAULT_BEHAVIOR_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: false,
      kind: "timeout",
      timeoutMs: DEFAULT_BEHAVIOR_TIMEOUT_MS
    });
  });

  it("classifies a backend-reported timeout outcome", async () => {
    const impl = backend(() =>
      Promise.reject(new BehaviorTimeoutError(5_000, "child timed out"))
    );
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, { timeoutMs: 60_000 })
    );
    expect(outcome).toMatchObject({
      ok: false,
      kind: "timeout",
      code: "behavior_timeout",
      timeoutMs: 5_000,
      message: "child timed out"
    });
  });

  it("commits a backend that answers inside the bound", async () => {
    vi.useFakeTimers();
    const impl = backend(
      () =>
        new Promise<BehaviorResult>((resolve) => {
          setTimeout(() => {
            resolve(counted());
          }, 20);
        })
    );
    const promise = executeBehaviorRequest(options(impl, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(20);
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: true,
      committed: true,
      state: { count: 1 }
    });
  });

  it("refuses a non-positive timeout bound as a configuration error", async () => {
    const impl = backend(() => counted());
    const outcome: ExecuteOutcome = await executeBehaviorRequest(
      options(impl, { timeoutMs: 0 })
    );
    expect(internalMessage(outcome)).toContain("timeoutMs");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
