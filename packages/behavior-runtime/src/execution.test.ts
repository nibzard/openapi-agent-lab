/**
 * End-to-end execution tests across the behavior executor, the module
 * host, and the transactional state store. They cover timeout rollback
 * (AC-028) and idempotent replay through the backend execution path
 * (AC-031).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeBehaviorRequest,
  type BehaviorBackend,
  type BehaviorRequest,
  type BehaviorResult,
  type BlobStore,
  type DeterministicClock,
  type DeterministicRandom,
  type ExecuteOptions,
  type ExecuteOutcome,
  type RegisteredEvent
} from "@oal/behavior-api";
import type { ContractIR, OperationIR } from "@oal/contract-ir";
import {
  canonicalJson,
  isJsonObject,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  createNamespacePrng,
  StateStore,
  VirtualClock,
  type StoredResponse
} from "@oal/state-store";

import {
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "./adapters.ts";
import { BehaviorModuleHost } from "./host.ts";

const OBSERVED_AT = "2026-08-27T12:00:00.480Z";
const FINGERPRINT = '{"template":"system/chrome"}';
const RUN_SEED = "a".repeat(64);

const EVENT_REGISTRY = new Map<string, RegisteredEvent>([
  [
    "computer.counted",
    { eventVersion: 1, payloadSchema: { type: "object" } as Json }
  ]
]);

const fixtureEntry = fileURLToPath(
  new URL("./child.fixture.ts", import.meta.url)
);

function operation(): OperationIR {
  return {
    key: "path:POST /count",
    uid: "op_count1",
    surface: "path",
    method: "POST",
    path_template: "/count",
    route_segments: [{ kind: "literal", value: "count" }],
    operation_id: null,
    tool_name: "count",
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

function contract(): ContractIR {
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal", version: "0.1.0" },
    source: {
      entrypoint: "openapi.yaml",
      media_type: "application/yaml",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {},
    schemas: {},
    operations: [],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

function countRequest(body: Json): BehaviorRequest {
  return {
    operation: operation(),
    principal: null,
    parameters: { path: {}, query: {}, header: {}, cookie: {} },
    body: { kind: "json", value: body },
    selectedRequestMediaType: "application/json",
    acceptedResponseMediaTypes: []
  };
}

/** The participant-visible projection of one behavior result. */
function visibleResponse(result: BehaviorResult): StoredResponse {
  const headers: JsonObject = {};
  if (result.response.mediaType !== undefined) {
    headers["content-type"] = result.response.mediaType;
  }
  const body = result.response.body;
  return {
    status: result.response.status,
    headers,
    body: body !== undefined && body.kind === "json" ? body.value : null
  };
}

/** Wrap one backend and count how many times its handler ran. */
function countingBackend(inner: BehaviorBackend): BehaviorBackend & {
  handleCalls(): number;
} {
  let calls = 0;
  return {
    describe: () => inner.describe(),
    initialize: (context) => inner.initialize(context),
    handle: (request, context) => {
      calls += 1;
      return inner.handle(request, context);
    },
    handleCalls: () => calls
  };
}

function inProcessBackend(
  respond: () => Promise<BehaviorResult>
): BehaviorBackend {
  return {
    describe() {
      return Promise.resolve({
        backendApiVersion: 1,
        stateSchemaVersion: 1,
        operations: [{ key: "path:POST /count", support: "implemented" }]
      });
    },
    initialize() {
      return Promise.resolve({ state: {} });
    },
    handle() {
      return respond();
    }
  };
}

type DriveResult =
  | { kind: "committed"; response: StoredResponse }
  | { kind: "replayed"; response: StoredResponse }
  | { kind: "failed"; failure: ExecuteOutcome };

interface DriverServices {
  readonly clock: DeterministicClock;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
  readonly timeoutMs: number;
}

/**
 * One gateway-shaped request loop over a real store: idempotency
 * lookup, backend execution, then one transaction holding the state,
 * idempotency record, API event, semantic events, and the request
 * outcome.
 */
class RequestDriver {
  constructor(
    private readonly store: StateStore,
    private readonly backend: BehaviorBackend,
    private readonly services: DriverServices
  ) {}

  async apply(
    request: BehaviorRequest,
    idempotencyKey: string
  ): Promise<DriveResult> {
    const identity = {
      operationKey: request.operation.key,
      principalKey: "principal:primary-api-key",
      normalizedPath: request.operation.path_template,
      idempotencyKey
    };
    const lookup = this.store.lookupIdempotency({
      identity,
      requestFingerprint: FINGERPRINT
    });
    const allocation = this.store.beginRequest({
      ingressObservedAt: OBSERVED_AT,
      operationKey: identity.operationKey,
      method: request.operation.method,
      pathRedacted: request.operation.path_template
    });
    if (lookup.outcome === "replay" && lookup.response !== null) {
      this.store.completeRequest(allocation.sequence, {
        terminalStatus: "replayed",
        responseStatus: lookup.response.status,
        committed: false
      });
      return { kind: "replayed", response: lookup.response };
    }
    const executeOptions: ExecuteOptions = {
      backend: this.backend,
      request,
      runId: this.store.runId,
      requestId: allocation.requestId,
      state: this.store.getState()?.state ?? {},
      clock: this.services.clock,
      ids: idsAdapter(),
      random: this.services.random,
      blobs: this.services.blobs,
      maxStateBytes: 1_000_000,
      eventRegistry: EVENT_REGISTRY,
      timeoutMs: this.services.timeoutMs
    };
    const outcome = await executeBehaviorRequest(executeOptions);
    if (!outcome.ok) {
      this.store.completeRequest(allocation.sequence, {
        terminalStatus: "failed",
        committed: false
      });
      return { kind: "failed", failure: outcome };
    }
    const state = outcome.state;
    if (!isJsonObject(state)) {
      throw new Error("The committed state must be a JSON object.");
    }
    const response = visibleResponse(outcome.result);
    const revision = this.store.getState()?.revision ?? null;
    this.store.transaction(() => {
      this.store.putState({ state, expectedRevision: revision });
      this.store.putIdempotencyRecord({
        identity,
        requestFingerprint: FINGERPRINT,
        response,
        sequence: allocation.sequence,
        logicalTime: this.store.clock.now()
      });
      const apiEvent = this.store.appendApiEvent({
        sequence: allocation.sequence,
        eventJson: { type: "api.exchange", sequence: allocation.sequence }
      });
      for (const event of outcome.result.semanticEvents ?? []) {
        this.store.appendSemanticEvent({
          requestSequence: allocation.sequence,
          parentEventId: apiEvent.eventId,
          eventName: event.name,
          schemaVersion: event.eventVersion,
          eventJson: event.payload
        });
      }
      this.store.completeRequest(allocation.sequence, {
        terminalStatus: "committed",
        responseStatus: response.status,
        committed: true
      });
    });
    return { kind: "committed", response };
  }
}

interface OpenedHost {
  readonly host: BehaviorModuleHost;
  readonly store: StateStore;
  readonly services: DriverServices;
  readonly packRoot: string;
}

/** Start the real child fixture with one seeded store and services. */
async function openHostStore(timeoutMs: number): Promise<OpenedHost> {
  const packRoot = await mkdtemp(join(tmpdir(), "oal-exec-"));
  const store = StateStore.open({
    path: join(packRoot, "state.db"),
    runId: "run_exec",
    clock: new VirtualClock({ initialMs: 0, tickMs: 1 })
  });
  const host = new BehaviorModuleHost({
    entry: fixtureEntry,
    context: { contract: contract(), packRoot, config: {} },
    runSeed: RUN_SEED,
    timeoutMs
  });
  await host.start();
  const clock = clockAdapter(store.clock);
  const blobs = fileBlobStore(join(packRoot, ".oal", "blobs"));
  const random = randomAdapter(createNamespacePrng(RUN_SEED, "execution-test"));
  const initialized = await host.initialize({
    runId: store.runId,
    fixtures: [],
    clock,
    ids: idsAdapter(),
    random,
    blobs
  });
  if (!isJsonObject(initialized.state)) {
    throw new Error("The fixture must initialize with an object state.");
  }
  store.putState({ state: initialized.state, expectedRevision: null });
  return {
    host,
    store,
    services: { clock, random, blobs, timeoutMs: 30_000 },
    packRoot
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("request execution across executor, host, and store", () => {
  it("classifies a child timeout as behavior_timeout and rolls state back", async () => {
    // Fake timers keep the 50 millisecond host bound from racing the
    // child's startup; only the hung call fires it.
    vi.useFakeTimers();
    const opened = await openHostStore(50);
    const driver = new RequestDriver(
      opened.store,
      opened.host,
      opened.services
    );
    try {
      const hung = driver.apply(countRequest({ hang: true }), "idem-1");
      await vi.advanceTimersByTimeAsync(50);
      const result = await hung;
      expect(result).toMatchObject({
        kind: "failed",
        failure: {
          ok: false,
          kind: "timeout",
          code: "behavior_timeout",
          timeoutMs: 50
        }
      });
      // Nothing from the timed-out request survived.
      expect(opened.store.getState()?.revision).toBe(0);
      expect(opened.store.getState()?.state).toEqual({ count: 0 });
      expect(opened.store.countIdempotencyEntries()).toBe(0);
      expect(opened.store.eventLogBytes()).toBe(0);
      expect(opened.store.getRequest(1)).toMatchObject({
        terminalStatus: "failed",
        committed: false
      });
    } finally {
      vi.useRealTimers();
      await opened.host.close();
      opened.store.close();
      await rm(opened.packRoot, { recursive: true, force: true });
    }
  });

  it("replays the stored response and runs the handler once", async () => {
    const opened = await openHostStore(30_000);
    const counting = countingBackend(opened.host);
    const driver = new RequestDriver(opened.store, counting, opened.services);
    try {
      const request = countRequest({});
      const first = await driver.apply(request, "idem-1");
      const second = await driver.apply(request, "idem-1");
      if (first.kind !== "committed" || second.kind !== "replayed") {
        throw new Error(
          `expected committed then replayed, got ${first.kind} and ${second.kind}`
        );
      }

      // The replay returns the exact stored visible response.
      expect(second.response).toEqual(first.response);
      expect(canonicalJson(second.response.body)).toBe(
        canonicalJson(first.response.body)
      );
      expect(first.response).toEqual({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { count: 1 }
      });

      // The backend handler ran exactly once and state moved once.
      expect(counting.handleCalls()).toBe(1);
      expect(opened.store.getState()?.revision).toBe(1);
      expect(opened.store.getState()?.state).toEqual({ count: 1 });
      expect(opened.store.countIdempotencyEntries()).toBe(1);
      expect(opened.store.countRequests()).toBe(2);
      expect(opened.store.getRequest(1)).toMatchObject({
        terminalStatus: "committed",
        committed: true
      });
      expect(opened.store.getRequest(2)).toMatchObject({
        terminalStatus: "replayed",
        committed: false
      });

      // A different key executes again and mutates state a second time.
      const third = await driver.apply(countRequest({}), "idem-2");
      expect(third.kind).toBe("committed");
      expect(counting.handleCalls()).toBe(2);
      expect(opened.store.getState()?.state).toEqual({ count: 2 });
    } finally {
      await opened.host.close();
      opened.store.close();
      await rm(opened.packRoot, { recursive: true, force: true });
    }
  });

  it("rolls an in-process timeout back and recovers on the next request", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "oal-exec-"));
    const store = StateStore.open({
      path: join(dir, "state.db"),
      runId: "run_exec",
      clock: new VirtualClock({ initialMs: 0, tickMs: 1 })
    });
    let hanging = true;
    const backend = inProcessBackend(() => {
      if (hanging) {
        return new Promise<BehaviorResult>(() => undefined);
      }
      return Promise.resolve({
        response: {
          status: 200,
          mediaType: "application/json",
          body: { kind: "json", value: { ok: true } }
        },
        nextState: { ok: true },
        semanticEvents: [
          { name: "computer.counted", eventVersion: 1, payload: { ok: true } }
        ]
      });
    });
    const driver = new RequestDriver(store, backend, {
      clock: clockAdapter(store.clock),
      random: randomAdapter(createNamespacePrng(RUN_SEED, "execution-test")),
      blobs: fileBlobStore(join(dir, "blobs")),
      timeoutMs: 50
    });
    try {
      const hung = driver.apply(countRequest({}), "idem-1");
      await vi.advanceTimersByTimeAsync(49);
      await vi.advanceTimersByTimeAsync(1);
      const failed = await hung;
      expect(failed).toMatchObject({
        kind: "failed",
        failure: { ok: false, kind: "timeout", code: "behavior_timeout" }
      });
      expect(store.getState()).toBeNull();
      expect(store.countIdempotencyEntries()).toBe(0);
      expect(store.eventLogBytes()).toBe(0);
      expect(store.getRequest(1)).toMatchObject({
        terminalStatus: "failed",
        committed: false
      });

      // The same key is still a miss and the next request commits.
      hanging = false;
      const committed = await driver.apply(countRequest({}), "idem-1");
      expect(committed.kind).toBe("committed");
      expect(store.getState()?.state).toEqual({ ok: true });
      expect(store.countIdempotencyEntries()).toBe(1);
      expect(store.listSemanticEvents(2)).toHaveLength(1);
      expect(store.getRequest(2)).toMatchObject({
        terminalStatus: "committed",
        committed: true
      });
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
