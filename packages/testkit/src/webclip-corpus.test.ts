/**
 * Webclip corpus acceptance (specification section 48.5): the pack's
 * portable cases pass against the real stateful backend in process,
 * and every negative double fails at a named assertion. Each double
 * carries exactly one defect, so a failure that moves to a different
 * assertion means the corpus lost its aim.
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
import type { Json, JsonObject } from "@oal/core";
import { parseCorpus, type CorpusCase, type CorpusDocument } from "@oal/pack";
import {
  runCorpus,
  type AssertionRecord,
  type CaseRecord,
  type CorpusReport,
  type CorpusTarget,
  type CorpusTargetRequest,
  type CorpusTargetResponse,
  type StepRecord
} from "@oal/corpus";

import { backend } from "../../../packs/webclip/behavior/index.ts";
import { compilePackContract, loadWebclipPack, readPackJson } from "./index.ts";

const pack = await loadWebclipPack();

const stateSchema: Json =
  readPackJson(pack.loaded, "schemas/scenario-state.schema.json") ?? null;
if (stateSchema === null) {
  throw new Error("The webclip pack declares no scenario state schema.");
}

const compiled = await compilePackContract(pack.loaded);
const operations = new Map<string, OperationIR>(
  compiled.contract.operations.map((operation) => [
    operation.operation_id ?? operation.key,
    operation
  ])
);

const corpusReference = pack.loaded.references.find(
  (reference) => reference.role === "corpus"
);
if (corpusReference === undefined) {
  throw new Error("The webclip pack declares no corpus.");
}
const corpus: CorpusDocument = parseCorpus(corpusReference.document ?? {});

const INPUTS: Readonly<Record<string, Json>> = {
  essay_url: "https://example.com/essay",
  dashboard_url: "https://example.com/dashboard"
};

/** The defects a double can carry; one at a time. */
type Defect =
  | "none"
  | "stateless"
  | "repeated-ids"
  | "swapped-resources"
  | "ignored-deletion"
  | "wrong-representation";

/** Json as text for keys and comparisons; objects stay JSON. */
function textOf(value: Json | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** One in-memory clip document. */
interface DoubleClip {
  readonly id: string;
  readonly url: string;
  readonly format: string;
  status: string;
}

/**
 * A double of the webclip API that behaves faithfully except for at
 * most one defect. It never imports the real backend, so a corpus
 * failure against it is the double's defect, not a pack bug.
 */
class WebclipDouble implements CorpusTarget {
  readonly id = "webclip-double";
  readonly version = "1.0.0";
  readonly capabilities = { operators: false, virtualTime: false };
  private clips: DoubleClip[] = [];
  private next = 1;

  constructor(private readonly defect: Defect) {}

  async prepare(): Promise<void> {
    await Promise.resolve();
    this.clips = [];
    this.next = 1;
  }

  async cleanup(): Promise<void> {
    await Promise.resolve();
    // Nothing to tear down; the world lives in this object.
  }

  async wait(): Promise<void> {
    // The double has no clock to advance.
  }

  private live(): DoubleClip[] {
    return this.defect === "stateless" ? [] : this.clips;
  }

  private clipOf(id: string): DoubleClip | undefined {
    const live = this.live();
    if (this.defect === "swapped-resources") {
      // Linkage by creation order: any known id reads the first clip.
      return live.find((clip) => clip.id === id) === undefined
        ? undefined
        : live[0];
    }
    return live.find((clip) => clip.id === id);
  }

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    await Promise.resolve();
    const clipId = textOf(instruction.parameters.path["clipId"], "");
    switch (instruction.operationId) {
      case "create_clip": {
        const body = (instruction.body ?? {}) as JsonObject;
        let id = `clip_${this.next.toString(10).padStart(8, "0")}`;
        if (this.defect === "repeated-ids") {
          id = "clip_00000001";
        }
        this.next += 1;
        const clip: DoubleClip = {
          id,
          url: textOf(body["url"], ""),
          format: textOf(body["format"], "markdown"),
          status: "pending"
        };
        if (this.defect !== "stateless") {
          this.clips.push(clip);
        }
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: { ...clip, created_at: "2026-01-01T00:00:00.000Z" },
          method: "POST",
          url: "/v1/clips"
        };
      }
      case "get_clip": {
        const clip = this.clipOf(clipId);
        return clip === undefined
          ? { status: 404, headers: {}, body: { message: "not_found" } }
          : {
              status: 200,
              headers: { "content-type": "application/json" },
              body: { ...clip, created_at: "2026-01-01T00:00:00.000Z" },
              method: "GET",
              url: "/v1/clips/x"
            };
      }
      case "list_clips": {
        const items = [...this.live()]
          .reverse()
          .map((clip) => ({ ...clip, created_at: "2026-01-01T00:00:00.000Z" }));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { items, nextCursor: "" },
          method: "GET",
          url: "/v1/clips"
        };
      }
      case "render_clip": {
        const clip = this.clipOf(clipId);
        if (clip === undefined) {
          return { status: 404, headers: {}, body: { message: "not_found" } };
        }
        clip.status = "rendered";
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { clipId: clip.id, status: "rendered", duration_ms: 100 },
          method: "POST",
          url: "/v1/clips/x/render"
        };
      }
      case "extract_text": {
        const clip = this.clipOf(clipId);
        if (clip === undefined) {
          return { status: 404, headers: {}, body: { message: "not_found" } };
        }
        if (clip.status !== "rendered" && clip.status !== "extracted") {
          return {
            status: 409,
            headers: {},
            body: { message: "clip_not_rendered" }
          };
        }
        clip.status = "extracted";
        const text = "Double text with four words";
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            clipId: clip.id,
            text,
            word_count: 4
          },
          method: "POST",
          url: "/v1/clips/x/extract"
        };
      }
      case "get_clip_content": {
        const clip = this.clipOf(clipId);
        if (clip === undefined) {
          return { status: 404, headers: {}, body: { message: "not_found" } };
        }
        const accept = textOf(
          instruction.parameters.header["Accept"] ??
            instruction.parameters.header["accept"],
          ""
        );
        if (accept.includes("image/svg+xml")) {
          if (clip.format === "markdown") {
            return { status: 406, headers: {}, body: null };
          }
          return {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
            body: { text: `<svg>${clip.id}</svg>`, sha256: "" },
            method: "GET",
            url: "/v1/clips/x/content"
          };
        }
        const text = "Double text with four words";
        return {
          status: 200,
          headers: {
            "content-type":
              this.defect === "wrong-representation"
                ? "application/json"
                : "text/markdown"
          },
          body: {
            text,
            sha256: createHash("sha256").update(text, "utf8").digest("hex")
          },
          method: "GET",
          url: "/v1/clips/x/content"
        };
      }
      case "delete_clip": {
        const id = clipId;
        const clip = this.clipOf(id);
        if (clip === undefined) {
          return { status: 404, headers: {}, body: null };
        }
        if (this.defect !== "ignored-deletion") {
          this.clips = this.clips.filter((entry) => entry.id !== id);
        }
        return { status: 204, headers: {}, body: null, method: "DELETE" };
      }
      case "get_account":
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            account_id: "acct_00000001",
            plan: "free",
            clips_used: this.live().length,
            clips_limit: 100
          },
          method: "GET",
          url: "/v1/account"
        };
      default:
        throw new Error(
          `The double serves no operation ${instruction.operationId}.`
        );
    }
  }
}

/** Fixed-epoch clock; every read advances one tick. */
function fakeClock(): DeterministicClock {
  let currentMs = Date.UTC(2026, 8, 1, 9, 0, 0);
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

/** Sequential counter per prefix. */
function fakeIds(): DeterministicIds {
  const counters = new Map<string, number>();
  return {
    next: (prefix: string): string => {
      const value = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, value);
      return `${prefix}_${value.toString(10).padStart(8, "0")}`;
    }
  };
}

/** xorshift32: one seeded sequence. */
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

/** One behavior body as the corpus engine sees it. */
function bodyJsonOf(body: Body): Json {
  if (body.kind === "json") {
    return body.value;
  }
  if (body.kind === "text") {
    return { text: body.text, sha256: body.sha256 };
  }
  if (body.kind === "binary") {
    return { sha256: body.sha256 };
  }
  return null;
}

/**
 * The stateful backend target: the real webclip behavior through
 * executeBehaviorRequest, one fresh world per case, no gateway and no
 * HTTP. This is the same transactional path the gateway composes.
 */
class StatefulBackendTarget implements CorpusTarget {
  readonly id = "stateful-webclip";
  readonly version = "0.0.0";
  readonly capabilities = { operators: false, virtualTime: false };
  private instance: BehaviorBackend | null = null;
  private registry: ReadonlyMap<string, RegisteredEvent> = new Map();
  private clock: DeterministicClock = fakeClock();
  private ids: DeterministicIds = fakeIds();
  private random: DeterministicRandom = fakeRandom();
  private blobs: BlobStore = memoryBlobs();
  private state: Json = null;
  private count = 0;
  private runId = "corpus-webclip";

  async prepare(corpusCase: CorpusCase): Promise<void> {
    this.instance = await backend.create({
      contract: compiled.contract,
      packRoot: pack.root,
      config: {}
    });
    const description: BackendDescription = await this.instance.describe();
    this.registry = new Map(
      (description.semanticEvents ?? []).map((event) => [
        event.name,
        { eventVersion: event.eventVersion, payloadSchema: event.payloadSchema }
      ])
    );
    this.clock = fakeClock();
    this.ids = fakeIds();
    this.random = fakeRandom();
    this.blobs = memoryBlobs();
    this.count = 0;
    this.runId = `corpus-${corpusCase.id}`;
    const initialized = await this.instance.initialize({
      runId: this.runId,
      fixtures: [],
      clock: this.clock,
      ids: this.ids,
      random: this.random,
      blobs: this.blobs
    });
    this.state = initialized.state;
  }

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    if (this.instance === null) {
      throw new Error("The target holds no world; prepare a case first.");
    }
    const operation = operations.get(instruction.operationId);
    if (operation === undefined) {
      throw new Error(
        `The contract serves no operation ${instruction.operationId}.`
      );
    }
    const acceptRaw = Object.entries(instruction.parameters.header).find(
      ([name]) => name.toLowerCase() === "accept"
    )?.[1];
    const request: BehaviorRequest = {
      operation,
      principal: null,
      parameters: {
        path: { ...instruction.parameters.path },
        query: { ...instruction.parameters.query },
        header: {},
        cookie: {}
      },
      body:
        instruction.body === undefined
          ? { kind: "none" }
          : { kind: "json", value: instruction.body },
      selectedRequestMediaType:
        instruction.body === undefined ? null : "application/json",
      acceptedResponseMediaTypes:
        typeof acceptRaw === "string"
          ? acceptRaw
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
          : []
    };
    this.count += 1;
    const outcome = await executeBehaviorRequest({
      backend: this.instance,
      request,
      runId: this.runId,
      requestId: `req-${this.count.toString(10)}`,
      state: this.state,
      clock: this.clock,
      ids: this.ids,
      random: this.random,
      blobs: this.blobs,
      stateSchema,
      maxStateBytes: 65_536,
      eventRegistry: this.registry
    });
    if (outcome.ok) {
      this.state = outcome.state;
      const response = outcome.result.response;
      return {
        status: response.status,
        headers:
          response.mediaType === undefined
            ? {}
            : { "content-type": response.mediaType },
        body: response.body === undefined ? null : bodyJsonOf(response.body)
      };
    }
    if (outcome.kind === "http_error") {
      return { status: outcome.error.status, headers: {}, body: null };
    }
    throw new Error(`The request failed outside the domain: ${outcome.kind}.`);
  }

  async wait(): Promise<void> {
    // The backend has no scheduled work to wait for.
  }

  async cleanup(): Promise<void> {
    await Promise.resolve();
    this.instance = null;
  }
}

function caseOf(report: CorpusReport, id: string): CaseRecord {
  const found = report.cases.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`The report carries no case ${JSON.stringify(id)}.`);
  }
  return found;
}

function stepOf(record: CaseRecord, id: string): StepRecord {
  const found = record.steps.find((step) => step.id === id);
  if (found === undefined) {
    throw new Error(`The case carries no step ${JSON.stringify(id)}.`);
  }
  return found;
}

function failingAssertion(step: StepRecord): AssertionRecord {
  const failed = step.assertions.find((assertion) => !assertion.passed);
  if (failed === undefined) {
    throw new Error(`Step ${JSON.stringify(step.id)} has no failed assertion.`);
  }
  return failed;
}

/** Run the pack corpus against one target. */
async function corpusOn(target: CorpusTarget): Promise<CorpusReport> {
  return runCorpus(corpus, target, { inputs: INPUTS });
}

describe("the webclip corpus", () => {
  it("declares the portable cases the plan requires", () => {
    expect(corpus.id).toBe("webclip-core");
    expect(corpus.cases.map((entry) => entry.id)).toEqual([
      "clip-lifecycle",
      "distinct-clips",
      "list-order",
      "delete-then-gone",
      "quota-counts-live-clips",
      "content-negotiation",
      "extract-after-render"
    ]);
    expect(corpus.cases.every((entry) => entry.scope === "black_box")).toBe(
      true
    );
  });

  it("passes every case against the stateful backend", async () => {
    const report = await corpusOn(new StatefulBackendTarget());
    expect(report.summary).toEqual({
      passed: corpus.cases.length,
      failed: 0,
      skipped: 0,
      error: 0
    });
  });

  it("fails a stateless double at the first persisted read", async () => {
    const report = await corpusOn(new WebclipDouble("stateless"));
    const lifecycle = caseOf(report, "clip-lifecycle");
    expect(lifecycle.status).toBe("failed");
    const read = stepOf(lifecycle, "read-pending");
    expect(read.status).toBe("failed");
    const assertion = failingAssertion(read);
    expect(assertion.op).toBe("status");
    expect(assertion.expected).toBe(200);
    expect(assertion.actual).toBe(404);
  });

  it("fails a repeated-id double at the distinctness assertion", async () => {
    const report = await corpusOn(new WebclipDouble("repeated-ids"));
    const distinct = caseOf(report, "distinct-clips");
    expect(distinct.status).toBe("failed");
    const assertion = failingAssertion(stepOf(distinct, "create-dashboard"));
    expect(assertion.op).toBe("not_equals");
    expect(assertion.expected).toBe("clip_00000001");
    expect(assertion.actual).toBe("clip_00000001");
  });

  it("fails a swapped-resource double at the linked read", async () => {
    const report = await corpusOn(new WebclipDouble("swapped-resources"));
    const distinct = caseOf(report, "distinct-clips");
    expect(distinct.status).toBe("failed");
    const assertion = failingAssertion(stepOf(distinct, "read-dashboard"));
    expect(assertion.op).toBe("equals");
    expect(assertion.expected).toBe(INPUTS.dashboard_url);
    expect(assertion.actual).toBe(INPUTS.essay_url);
  });

  it("fails an ignored-deletion double at the read-after-delete", async () => {
    const report = await corpusOn(new WebclipDouble("ignored-deletion"));
    const deletion = caseOf(report, "delete-then-gone");
    expect(deletion.status).toBe("failed");
    const assertion = failingAssertion(stepOf(deletion, "read-deleted"));
    expect(assertion.op).toBe("status");
    expect(assertion.expected).toBe(404);
    expect(assertion.actual).toBe(200);
  });

  it("fails a wrong-representation double at the media type", async () => {
    const report = await corpusOn(new WebclipDouble("wrong-representation"));
    const content = caseOf(report, "content-negotiation");
    expect(content.status).toBe("failed");
    const assertion = failingAssertion(stepOf(content, "read-markdown"));
    expect(assertion.op).toBe("equals");
    expect(assertion.expected).toBe("text/markdown");
    expect(assertion.actual).toBe("application/json");
    expect(report.summary).toEqual({
      passed: corpus.cases.length - 1,
      failed: 1,
      skipped: 0,
      error: 0
    });
  });

  it("fails a faithful-free double nowhere", async () => {
    // The double with no defect must pass, so the corpus cannot be
    // failing doubles by construction.
    const report = await corpusOn(new WebclipDouble("none"));
    expect(report.summary).toEqual({
      passed: corpus.cases.length,
      failed: 0,
      skipped: 0,
      error: 0
    });
  });
});
