/**
 * End-to-end behavior tests for the webclip scenario backend. The
 * module runs in process without the gateway: every request goes
 * through executeBehaviorRequest with the pack state schema and the
 * event registry from describe(), which is the transactional path the
 * gateway composes. Domain failures must surface as declared HTTP
 * errors, so a 404 that degraded into an internal error fails here.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  executeBehaviorRequest,
  type BackendDescription,
  type BehaviorBackend,
  type BehaviorRequest,
  type BlobStore,
  type Body,
  type DeterministicClock,
  type DeterministicIds,
  type DeterministicRandom,
  type RegisteredEvent
} from "@oal/behavior-api";
import type { OperationIR } from "@oal/contract-ir";
import { isJsonObject, validateSchemaInstance, type Json } from "@oal/core";

import { backend } from "../../../packs/webclip/behavior/index.ts";
import {
  compilePackContract,
  loadPackFromRepo,
  readPackJson
} from "./index.ts";

const pack = await loadPackFromRepo("webclip");

const stateSchemaDocument = readPackJson(
  pack.loaded,
  "schemas/scenario-state.schema.json"
);
if (stateSchemaDocument === undefined) {
  throw new Error("The webclip pack declares no scenario state schema.");
}
// A narrowed alias: control-flow narrowing of the read result does not
// follow into the closures below.
const stateSchema: Json = stateSchemaDocument;

const compiled = await compilePackContract(pack.loaded);
const operations = new Map<string, OperationIR>(
  compiled.contract.operations.map((operation) => [
    operation.operation_id ?? operation.key,
    operation
  ])
);

const ESSAY_URL = "https://example.com/essay";
const DASHBOARD_URL = "https://example.com/dashboard";
const ESSAY_NOTES = "Source for the weekly digest";
const ESSAY_TEXT =
  "# Example Essay\n\nThe page opens with a thesis. The argument " +
  "follows in three short steps.";
const ESSAY_WORDS = 16;
const EPOCH_MS = Date.UTC(2026, 8, 1, 9, 0, 0);
const RUN_ID = "run-webclip-behavior";
const MAX_STATE_BYTES = 65_536;

/** Fixed-epoch clock; every read advances one tick so timestamps differ. */
function fakeClock(): DeterministicClock {
  let currentMs = EPOCH_MS;
  const tick = (): number => {
    const at = currentMs;
    currentMs += 1_000;
    return at;
  };
  return {
    now: () => new Date(tick()).toISOString(),
    nowMs: () => tick()
  };
}

/** Sequential counter per prefix, formatted like the runtime adapter. */
function fakeIds(): DeterministicIds {
  const counters = new Map<string, number>();
  return {
    next: (prefix: string): string => {
      const value = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, value);
      return `${prefix}_${value.toString().padStart(8, "0")}`;
    }
  };
}

/** xorshift32: one seeded sequence, identical on every replay. */
function fakeRandom(seed = 0x9e3779b9): DeterministicRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  return {
    nextFloat: () => next() / 4294967296,
    nextInt: (maxExclusive: number): number => next() % maxExclusive,
    nextBytes: (length: number): Uint8Array => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = next() % 256;
      }
      return bytes;
    }
  };
}

/** In-memory blob store; the webclip backend stores no blobs. */
function memoryBlobs(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: (bytes: Uint8Array) => {
      const digest = createHash("sha256").update(bytes).digest("hex");
      blobs.set(digest, bytes);
      return Promise.resolve({ digest, sizeBytes: bytes.length });
    },
    get: (digest: string) => Promise.resolve(blobs.get(digest) ?? null)
  };
}

interface Services {
  readonly clock: DeterministicClock;
  readonly ids: DeterministicIds;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
}

function makeServices(): Services {
  return {
    clock: fakeClock(),
    ids: fakeIds(),
    random: fakeRandom(),
    blobs: memoryBlobs()
  };
}

interface RequestInit {
  readonly path?: Readonly<Record<string, Json>>;
  readonly query?: Readonly<Record<string, Json>>;
  readonly body?: Json;
  readonly accept?: readonly string[];
}

function requestOf(
  operationId: string,
  init: RequestInit = {}
): BehaviorRequest {
  const operation = operations.get(operationId);
  if (operation === undefined) {
    throw new Error(`The compiled contract has no operation ${operationId}.`);
  }
  return {
    operation,
    principal: null,
    parameters: {
      path: { ...init.path },
      query: { ...init.query },
      header: {},
      cookie: {}
    },
    body:
      init.body === undefined
        ? { kind: "none" }
        : { kind: "json", value: init.body },
    selectedRequestMediaType:
      init.body === undefined ? null : "application/json",
    acceptedResponseMediaTypes: [...(init.accept ?? [])]
  };
}

type Step =
  | {
      ok: true;
      status: number;
      mediaType: string | undefined;
      body: Body | undefined;
      committed: boolean;
    }
  | { ok: false; status: number; code: string };

/** One scripted run over the shared backend instance. */
class BehaviorRun {
  private state: Json;
  private requestCount = 0;
  readonly events: Array<{ name: string; payload: Json }> = [];

  constructor(
    private readonly instance: BehaviorBackend,
    private readonly registry: ReadonlyMap<string, RegisteredEvent>,
    private readonly services: Services,
    initialState: Json
  ) {
    this.state = initialState;
  }

  async apply(request: BehaviorRequest): Promise<Step> {
    this.requestCount += 1;
    const outcome = await executeBehaviorRequest({
      backend: this.instance,
      request,
      runId: RUN_ID,
      requestId: `req-${this.requestCount}`,
      state: this.state,
      clock: this.services.clock,
      ids: this.services.ids,
      random: this.services.random,
      blobs: this.services.blobs,
      stateSchema,
      maxStateBytes: MAX_STATE_BYTES,
      eventRegistry: this.registry
    });
    if (outcome.ok) {
      this.state = outcome.state;
      for (const event of outcome.result.semanticEvents ?? []) {
        this.events.push({ name: event.name, payload: event.payload });
      }
      return {
        ok: true,
        status: outcome.result.response.status,
        mediaType: outcome.result.response.mediaType,
        body: outcome.result.response.body,
        committed: outcome.committed
      };
    }
    if (outcome.kind === "http_error") {
      return {
        ok: false,
        status: outcome.error.status,
        code: outcome.error.code
      };
    }
    throw new Error(`The request failed outside the domain: ${outcome.kind}.`);
  }

  currentState(): Json {
    return this.state;
  }
}

async function openBackend(): Promise<BehaviorBackend> {
  return await backend.create({
    contract: compiled.contract,
    packRoot: pack.root,
    config: {}
  });
}

function eventRegistryOf(
  description: BackendDescription
): ReadonlyMap<string, RegisteredEvent> {
  return new Map(
    (description.semanticEvents ?? []).map((event) => [
      event.name,
      { eventVersion: event.eventVersion, payloadSchema: event.payloadSchema }
    ])
  );
}

/** Create one run: fresh backend instance, fresh identical services. */
async function openRun(): Promise<BehaviorRun> {
  const instance = await openBackend();
  const registry = eventRegistryOf(await instance.describe());
  const services = makeServices();
  const initialized = await instance.initialize({
    runId: RUN_ID,
    fixtures: [],
    clock: services.clock,
    ids: services.ids,
    random: services.random,
    blobs: services.blobs
  });
  // The pack state schema gates every commit; the initial state must
  // pass the same gate before the first request runs.
  expect(await validateSchemaInstance(stateSchema, initialized.state)).toEqual(
    []
  );
  return new BehaviorRun(instance, registry, services, initialized.state);
}

function jsonBodyOf(step: Step): Json {
  if (!step.ok || step.body === undefined || step.body.kind !== "json") {
    throw new Error("The step carried no JSON body.");
  }
  return step.body.value;
}

function textBodyOf(step: Step): { text: string; sha256: string } {
  if (!step.ok || step.body === undefined || step.body.kind !== "text") {
    throw new Error("The step carried no text body.");
  }
  return { text: step.body.text, sha256: step.body.sha256 };
}

function stringField(step: Step, field: string): string {
  const value = jsonBodyOf(step);
  if (!isJsonObject(value) || typeof value[field] !== "string") {
    throw new Error(`The step body carries no string field ${field}.`);
  }
  return value[field];
}

interface ScriptSteps {
  readonly createMarkdown: Step;
  readonly createImage: Step;
  readonly listDefault: Step;
  readonly listPageOne: Step;
  readonly listPageTwo: Step;
  readonly getMarkdownEarly: Step;
  readonly renderUnknown: Step;
  readonly extractTooEarly: Step;
  readonly renderMarkdown: Step;
  readonly extractMarkdown: Step;
  readonly contentMarkdownSvgOnly: Step;
  readonly contentMarkdownDefault: Step;
  readonly contentMarkdownAny: Step;
  readonly renderImage: Step;
  readonly contentImage: Step;
  readonly getMarkdownLate: Step;
  readonly accountBeforeDelete: Step;
  readonly deleteMarkdown: Step;
  readonly getMarkdownDeleted: Step;
  readonly deleteMarkdownAgain: Step;
  readonly accountAfterDelete: Step;
  readonly listAfterDelete: Step;
  readonly getImage: Step;
}

interface ScriptOutcome {
  readonly steps: ScriptSteps;
  readonly markdownId: string;
  readonly imageId: string;
  readonly events: ReadonlyArray<{ name: string; payload: Json }>;
  readonly finalState: Json;
}

/**
 * Play the two-clip errand with every negative control in one fixed
 * order. The record fields list in execution order, so Object.values
 * yields the scripted sequence for the replay comparison.
 */
async function playScript(run: BehaviorRun): Promise<ScriptOutcome> {
  const createMarkdown = await run.apply(
    requestOf("create_clip", {
      body: { url: ESSAY_URL, format: "markdown", notes: ESSAY_NOTES }
    })
  );
  const markdownId = stringField(createMarkdown, "id");
  const createImage = await run.apply(
    requestOf("create_clip", {
      body: { url: DASHBOARD_URL, format: "image" }
    })
  );
  const imageId = stringField(createImage, "id");

  const listDefault = await run.apply(requestOf("list_clips", { query: {} }));
  const listPageOne = await run.apply(
    requestOf("list_clips", { query: { limit: 1 } })
  );
  const listPageTwo = await run.apply(
    requestOf("list_clips", { query: { limit: 1, cursor: imageId } })
  );
  const getMarkdownEarly = await run.apply(
    requestOf("get_clip", { path: { clipId: markdownId } })
  );
  const renderUnknown = await run.apply(
    requestOf("render_clip", { path: { clipId: "clip_ghost" } })
  );
  const extractTooEarly = await run.apply(
    requestOf("extract_text", { path: { clipId: markdownId } })
  );
  const renderMarkdown = await run.apply(
    requestOf("render_clip", { path: { clipId: markdownId } })
  );
  const extractMarkdown = await run.apply(
    requestOf("extract_text", { path: { clipId: markdownId } })
  );
  const contentMarkdownSvgOnly = await run.apply(
    requestOf("get_clip_content", {
      path: { clipId: markdownId },
      accept: ["image/svg+xml"]
    })
  );
  const contentMarkdownDefault = await run.apply(
    requestOf("get_clip_content", { path: { clipId: markdownId } })
  );
  const contentMarkdownAny = await run.apply(
    requestOf("get_clip_content", {
      path: { clipId: markdownId },
      accept: ["application/json", "*/*"]
    })
  );
  const renderImage = await run.apply(
    requestOf("render_clip", { path: { clipId: imageId } })
  );
  const contentImage = await run.apply(
    requestOf("get_clip_content", {
      path: { clipId: imageId },
      accept: ["image/svg+xml"]
    })
  );
  const getMarkdownLate = await run.apply(
    requestOf("get_clip", { path: { clipId: markdownId } })
  );
  const accountBeforeDelete = await run.apply(requestOf("get_account"));
  const deleteMarkdown = await run.apply(
    requestOf("delete_clip", { path: { clipId: markdownId } })
  );
  const getMarkdownDeleted = await run.apply(
    requestOf("get_clip", { path: { clipId: markdownId } })
  );
  const deleteMarkdownAgain = await run.apply(
    requestOf("delete_clip", { path: { clipId: markdownId } })
  );
  const accountAfterDelete = await run.apply(requestOf("get_account"));
  const listAfterDelete = await run.apply(
    requestOf("list_clips", { query: {} })
  );
  const getImage = await run.apply(
    requestOf("get_clip", { path: { clipId: imageId } })
  );

  const steps: ScriptSteps = {
    createMarkdown,
    createImage,
    listDefault,
    listPageOne,
    listPageTwo,
    getMarkdownEarly,
    renderUnknown,
    extractTooEarly,
    renderMarkdown,
    extractMarkdown,
    contentMarkdownSvgOnly,
    contentMarkdownDefault,
    contentMarkdownAny,
    renderImage,
    contentImage,
    getMarkdownLate,
    accountBeforeDelete,
    deleteMarkdown,
    getMarkdownDeleted,
    deleteMarkdownAgain,
    accountAfterDelete,
    listAfterDelete,
    getImage
  };
  return {
    steps,
    markdownId,
    imageId,
    events: run.events,
    finalState: run.currentState()
  };
}

/** Participant-visible view of one step for the replay comparison. */
function visible(step: Step): Json {
  if (!step.ok) {
    return { ok: false, status: step.status, code: step.code };
  }
  const body = step.body;
  const value: Json =
    body === undefined
      ? null
      : body.kind === "json"
        ? body.value
        : body.kind === "text"
          ? { kind: "text", text: body.text, sha256: body.sha256 }
          : { kind: body.kind };
  return {
    ok: true,
    status: step.status,
    mediaType: step.mediaType ?? null,
    body: value
  };
}

describe("the webclip scenario behavior backend", () => {
  it("describes all eight contract operations as implemented", async () => {
    const instance = await openBackend();
    const description = await instance.describe();
    expect(description.backendApiVersion).toBe(1);
    expect(description.stateSchemaVersion).toBe(1);
    expect(description.operations).toHaveLength(8);
    expect(
      new Set(description.operations.map((operation) => operation.key))
    ).toEqual(new Set(compiled.contract.operations.map((op) => op.key)));
    expect(
      description.operations.every(
        (operation) => operation.support === "implemented"
      )
    ).toBe(true);
  });

  it("registers the four lifecycle events at version 1", async () => {
    const description = await openBackend().then((instance) =>
      instance.describe()
    );
    expect(
      description.semanticEvents?.map((event) => [
        event.name,
        event.eventVersion
      ])
    ).toEqual([
      ["clip.created", 1],
      ["clip.rendered", 1],
      ["clip.extracted", 1],
      ["clip.deleted", 1]
    ]);
    for (const event of description.semanticEvents ?? []) {
      expect(isJsonObject(event.payloadSchema)).toBe(true);
    }
  });

  it("answers the two-clip errand request-dependently", async () => {
    const run = await openRun();
    const outcome = await playScript(run);
    const { steps, markdownId, imageId } = outcome;

    // Two creates echo the request and return distinct identifiers.
    expect(markdownId).toBe("clip_00000001");
    expect(imageId).toBe("clip_00000002");
    expect(markdownId).not.toBe(imageId);
    expect(steps.createMarkdown).toMatchObject({
      ok: true,
      status: 201,
      committed: true
    });
    expect(jsonBodyOf(steps.createMarkdown)).toEqual({
      id: markdownId,
      url: ESSAY_URL,
      format: "markdown",
      status: "pending",
      created_at: "2026-09-01T09:00:00.000Z",
      notes: ESSAY_NOTES
    });
    expect(jsonBodyOf(steps.createImage)).toEqual({
      id: imageId,
      url: DASHBOARD_URL,
      format: "image",
      status: "pending",
      created_at: "2026-09-01T09:00:01.000Z"
    });

    // The list reflects the creations, newest first as the contract
    // documents, with a cursor that pages through the live clips.
    expect(jsonBodyOf(steps.listDefault)).toEqual({
      items: [jsonBodyOf(steps.createImage), jsonBodyOf(steps.createMarkdown)],
      nextCursor: ""
    });
    expect(jsonBodyOf(steps.listPageOne)).toEqual({
      items: [jsonBodyOf(steps.createImage)],
      nextCursor: imageId
    });
    expect(jsonBodyOf(steps.listPageTwo)).toEqual({
      items: [jsonBodyOf(steps.createMarkdown)],
      nextCursor: ""
    });

    // Reads before the lifecycle: the clip is pending, unknown ids 404.
    expect(steps.getMarkdownEarly).toMatchObject({ ok: true, status: 200 });
    expect(jsonBodyOf(steps.getMarkdownEarly)).toMatchObject({
      id: markdownId,
      status: "pending"
    });
    expect(steps.renderUnknown).toEqual({
      ok: false,
      status: 404,
      code: "not_found"
    });

    // Extraction waits for the render; the render reports a duration.
    expect(steps.extractTooEarly).toEqual({
      ok: false,
      status: 409,
      code: "clip_not_rendered"
    });
    const render = jsonBodyOf(steps.renderMarkdown);
    expect(steps.renderMarkdown).toMatchObject({ ok: true, status: 200 });
    expect(render).toMatchObject({ clipId: markdownId, status: "rendered" });
    const duration = isJsonObject(render) ? render.duration_ms : undefined;
    expect(typeof duration).toBe("number");
    expect(duration as number).toBeGreaterThanOrEqual(100);
    expect(duration as number).toBeLessThanOrEqual(999);
    expect(jsonBodyOf(steps.extractMarkdown)).toEqual({
      clipId: markdownId,
      text: ESSAY_TEXT,
      word_count: ESSAY_WORDS
    });

    // Content negotiation: the format picks the representation, the
    // Accept header can refuse it, and the text body is the essay.
    expect(steps.contentMarkdownSvgOnly).toEqual({
      ok: false,
      status: 406,
      code: "not_acceptable"
    });
    for (const step of [
      steps.contentMarkdownDefault,
      steps.contentMarkdownAny
    ]) {
      expect(step).toMatchObject({ ok: true, status: 200 });
      expect(step.ok && step.mediaType).toBe("text/markdown");
      expect(textBodyOf(step).text).toBe(ESSAY_TEXT);
    }
    expect(textBodyOf(steps.contentMarkdownDefault).sha256).toBe(
      createHash("sha256").update(ESSAY_TEXT, "utf8").digest("hex")
    );

    // The image clip serves a picture that names its own clip id.
    expect(steps.contentImage).toMatchObject({
      ok: true,
      status: 200,
      mediaType: "image/svg+xml"
    });
    const picture = textBodyOf(steps.contentImage).text;
    expect(picture).toContain(imageId);
    expect(picture.startsWith("<svg")).toBe(true);

    // The extraction moved the markdown clip to extracted.
    expect(jsonBodyOf(steps.getMarkdownLate)).toMatchObject({
      id: markdownId,
      status: "extracted"
    });

    // The quota counts live clips and drops the deleted one.
    expect(jsonBodyOf(steps.accountBeforeDelete)).toEqual({
      account_id: "acct_00000001",
      plan: "free",
      clips_used: 2,
      clips_limit: 100
    });

    // Deletion is 204 with no body; every later read answers 404.
    expect(steps.deleteMarkdown).toEqual({
      ok: true,
      status: 204,
      mediaType: undefined,
      body: undefined,
      committed: true
    });
    expect(steps.getMarkdownDeleted).toEqual({
      ok: false,
      status: 404,
      code: "not_found"
    });
    expect(steps.deleteMarkdownAgain).toEqual({
      ok: false,
      status: 404,
      code: "not_found"
    });
    expect(jsonBodyOf(steps.accountAfterDelete)).toEqual({
      account_id: "acct_00000001",
      plan: "free",
      clips_used: 1,
      clips_limit: 100
    });
    // The list serves the current clip document, so after the render
    // the image item shows the rendered status. The getImage step runs
    // after this one but reads the same unchanged clip.
    expect(jsonBodyOf(steps.listAfterDelete)).toEqual({
      items: [jsonBodyOf(steps.getImage)],
      nextCursor: ""
    });
    expect(jsonBodyOf(steps.getImage)).toMatchObject({
      id: imageId,
      status: "rendered"
    });

    // The committed state keeps only the live image clip.
    expect(outcome.finalState).toEqual({
      clips: { [imageId]: jsonBodyOf(steps.getImage) },
      order: [imageId],
      account: {
        account_id: "acct_00000001",
        plan: "free",
        clips_limit: 100
      }
    });
  });

  it("emits the lifecycle events in order and validated", async () => {
    const run = await openRun();
    const outcome = await playScript(run);
    // The executor checks every event against the registry schema;
    // an unregistered or invalid event fails the whole request, so
    // reaching here already proves the events validate.
    expect(outcome.events.map((event) => event.name)).toEqual([
      "clip.created",
      "clip.created",
      "clip.rendered",
      "clip.extracted",
      "clip.rendered",
      "clip.deleted"
    ]);
    expect(outcome.events[0]?.payload).toEqual({
      clipId: outcome.markdownId,
      url: ESSAY_URL,
      format: "markdown"
    });
    expect(outcome.events[1]?.payload).toEqual({
      clipId: outcome.imageId,
      url: DASHBOARD_URL,
      format: "image"
    });
    expect(outcome.events[3]?.payload).toEqual({
      clipId: outcome.markdownId,
      wordCount: ESSAY_WORDS
    });
    expect(outcome.events[5]?.payload).toEqual({
      clipId: outcome.markdownId
    });
  });

  it("replays identically from a fresh backend with identical services", async () => {
    const first = await playScript(await openRun());
    const second = await playScript(await openRun());
    expect(second.markdownId).toBe(first.markdownId);
    expect(second.imageId).toBe(first.imageId);
    expect(Object.values(second.steps).map(visible)).toEqual(
      Object.values(first.steps).map(visible)
    );
    expect(second.events).toEqual(first.events);
    expect(second.finalState).toEqual(first.finalState);
  });
});
