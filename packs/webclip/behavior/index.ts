/**
 * webclip scenario behavior backend (backend API version 1).
 *
 * Contract fixtures cannot answer request-dependently: every create
 * returned one fixed clip, no read ever saw a deletion, and extraction
 * never waited for a render. This module owns the clip lifecycle in
 * JSON state instead. Two creates return two identifiers, deleted
 * clips answer 404 on every later read, extraction refuses an
 * unrendered clip with 409, and the quota counts only live clips.
 *
 * The module runs as plain TypeScript under Node type stripping, so it
 * stays erasable-syntax only. It imports the one runtime value it
 * needs, the behavior error class, by relative path: a pack resolves
 * no bare workspace specifiers, because the module directory sits
 * outside the workspace package graph and the module process starts
 * with a minimal environment.
 */

import { createHash } from "node:crypto";

import { BehaviorHttpError } from "../../../packages/behavior-api/src/error.ts";
import type {
  BackendDescription,
  BackendFactoryContext,
  BackendModule,
  BehaviorBackend,
  BehaviorRequest,
  BehaviorResult,
  Body,
  DeterministicClock,
  DeterministicIds,
  DeterministicRandom,
  HandleContext,
  InitializeContext,
  InitializeResult,
  Json
} from "../../../packages/behavior-api/src/types.ts";

/** Free-plan clip quota; the account read serves it from state. */
const CLIPS_LIMIT = 100;

/** List defaults from the contract: 20 per page, at most 100. */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

const JSON_MEDIA_TYPE = "application/json";
const MARKDOWN_MEDIA_TYPE = "text/markdown";
const SVG_MEDIA_TYPE = "image/svg+xml";

/**
 * The synthetic page text. Sixteen words, so the extract word count is
 * a constant the tests can pin. Every markdown or html clip serves the
 * same essay, because the errand grades the protocol flow, not the
 * page content.
 */
const ESSAY =
  "# Example Essay\n\nThe page opens with a thesis. The argument " +
  "follows in three short steps.";

type ClipFormat = "markdown" | "html" | "image";
type ClipStatus = "pending" | "rendered" | "extracted" | "failed";

type ClipRecord = {
  id: string;
  url: string;
  format: ClipFormat;
  status: ClipStatus;
  created_at: string;
  notes?: string;
};

type ScenarioState = {
  /** Live clips keyed by identifier. A deletion removes the entry. */
  clips: Record<string, ClipRecord>;
  /** Identifiers of live clips in insertion order. */
  order: string[];
  account: { account_id: string; plan: string; clips_limit: number };
};

type DomainContext = {
  clock: DeterministicClock;
  ids: DeterministicIds;
  random: DeterministicRandom;
};

type DomainHandler = (
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
) => BehaviorResult;

const SEMANTIC_EVENTS: NonNullable<BackendDescription["semanticEvents"]> = [
  {
    name: "clip.created",
    eventVersion: 1,
    payloadSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", pattern: "^clip_[0-9a-z]+$" },
        url: { type: "string" },
        format: { type: "string", enum: ["markdown", "html", "image"] }
      },
      required: ["clipId", "url", "format"],
      additionalProperties: false
    }
  },
  {
    name: "clip.rendered",
    eventVersion: 1,
    payloadSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", pattern: "^clip_[0-9a-z]+$" }
      },
      required: ["clipId"],
      additionalProperties: false
    }
  },
  {
    name: "clip.extracted",
    eventVersion: 1,
    payloadSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", pattern: "^clip_[0-9a-z]+$" },
        wordCount: { type: "integer", minimum: 0 }
      },
      required: ["clipId", "wordCount"],
      additionalProperties: false
    }
  },
  {
    name: "clip.deleted",
    eventVersion: 1,
    payloadSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", pattern: "^clip_[0-9a-z]+$" }
      },
      required: ["clipId"],
      additionalProperties: false
    }
  }
];

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Answer with a contract-shaped error body; never commits state. */
function problem(init: {
  status: number;
  code: string;
  message: string;
  details?: Array<{ field: string; issue: string }>;
}): never {
  const value: Record<string, Json> = {
    code: init.code,
    message: init.message
  };
  if (init.details !== undefined) {
    value.details = init.details;
  }
  throw new BehaviorHttpError({
    status: init.status,
    code: init.code,
    message: init.message,
    body: { kind: "json", value }
  });
}

function clipNotFound(): never {
  problem({
    status: 404,
    code: "not_found",
    message: "No clip has this identifier."
  });
}

/**
 * Narrow committed JSON state back to the scenario shape. The pack
 * state schema already gates every commit, so a malformed document is
 * state corruption and stays an internal error, never a domain answer.
 */
function readState(value: Readonly<Json>): ScenarioState {
  if (
    !isObject(value) ||
    !isObject(value.clips) ||
    !Array.isArray(value.order) ||
    !isObject(value.account)
  ) {
    throw new Error("The scenario state lacks clips, order, or account.");
  }
  const clips: Record<string, ClipRecord> = {};
  for (const raw of Object.values(value.clips)) {
    if (!isObject(raw)) {
      throw new Error("A clip entry is not an object.");
    }
    const format = raw.format;
    const status = raw.status;
    if (
      typeof raw.id !== "string" ||
      typeof raw.url !== "string" ||
      (format !== "markdown" && format !== "html" && format !== "image") ||
      (status !== "pending" &&
        status !== "rendered" &&
        status !== "extracted" &&
        status !== "failed") ||
      typeof raw.created_at !== "string"
    ) {
      throw new Error(`The clip entry ${String(raw.id)} is malformed.`);
    }
    const clip: ClipRecord = {
      id: raw.id,
      url: raw.url,
      format,
      status,
      created_at: raw.created_at
    };
    if (typeof raw.notes === "string") {
      clip.notes = raw.notes;
    }
    clips[clip.id] = clip;
  }
  const order = value.order.map((id, index) => {
    if (typeof id !== "string") {
      throw new Error(`The order entry ${index} is not a string.`);
    }
    return id;
  });
  const account = value.account;
  if (
    typeof account.account_id !== "string" ||
    typeof account.plan !== "string" ||
    typeof account.clips_limit !== "number"
  ) {
    throw new Error("The account entry is malformed.");
  }
  return {
    clips,
    order,
    account: {
      account_id: account.account_id,
      plan: account.plan,
      clips_limit: account.clips_limit
    }
  };
}

/** The live clip for an identifier, or 404 for unknown and deleted. */
function liveClip(state: ScenarioState, id: string): ClipRecord {
  const clip = state.clips[id];
  if (clip === undefined) {
    clipNotFound();
  }
  return clip;
}

function clipIdOf(request: BehaviorRequest): string {
  const raw = request.parameters.path.clipId;
  return typeof raw === "string" ? raw : "";
}

function jsonResult(status: number, value: Json): BehaviorResult {
  return {
    response: {
      status,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value }
    }
  };
}

/** Replace one clip in state; the order and the account stay as they are. */
function withClip(state: ScenarioState, clip: ClipRecord): ScenarioState {
  return {
    clips: { ...state.clips, [clip.id]: clip },
    order: state.order,
    account: state.account
  };
}

function textBody(text: string): Body {
  return {
    kind: "text",
    text,
    sizeBytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex")
  };
}

/**
 * The picture of one clip. The identifier sits in the text element, so
 * two clips serve two different pictures without any randomness.
 */
function svgPictureOf(clipId: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">' +
    '<rect width="1440" height="900" fill="#f5f2ea"/>' +
    `<text x="72" y="96" font-family="Georgia" font-size="36">${clipId}</text>` +
    "</svg>"
  );
}

/** The synthetic content a clip serves, by format. */
function contentOf(clip: ClipRecord): string {
  return clip.format === "image" ? svgPictureOf(clip.id) : ESSAY;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Does the Accept header admit the media type? The gateway hands over
 * lowercase parsed entries with parameters stripped; an empty list
 * means the client sent no Accept header and everything is admissible.
 * Subtype wildcards such as text/* count, as they do in negotiation.
 */
function accepts(
  accepted: ReadonlyArray<string>,
  media: string
): boolean {
  if (accepted.length === 0) {
    return true;
  }
  return accepted.some((entry) => {
    if (entry === media || entry === "*/*") {
      return true;
    }
    return (
      entry.endsWith("/*") && media.startsWith(entry.slice(0, -1))
    );
  });
}

function createClip(
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
): BehaviorResult {
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const url = body?.url;
  if (body === null || typeof url !== "string" || url.length < 8) {
    problem({
      status: 422,
      code: "validation_failed",
      message: "The request body failed validation.",
      details: [
        { field: "/url", issue: "must be an absolute http or https URL" }
      ]
    });
  }
  const format = body.format;
  if (format !== "markdown" && format !== "html" && format !== "image") {
    problem({
      status: 422,
      code: "validation_failed",
      message: "The request body failed validation.",
      details: [
        { field: "/format", issue: "must be one of markdown, html, image" }
      ]
    });
  }
  // The ids service is the only identifier source. The runtime hands
  // the module a fresh service per request, which returns the same
  // first identifier every time, so the loop keeps allocating while
  // the identifier is already live. A run-scoped service stops at the
  // first value; a per-request service walks past the live clips.
  let id = domain.ids.next("clip");
  while (state.clips[id] !== undefined) {
    id = domain.ids.next("clip");
  }
  const clip: ClipRecord = {
    id,
    url,
    format,
    status: "pending",
    created_at: domain.clock.now()
  };
  if (typeof body.notes === "string") {
    clip.notes = body.notes;
  }
  return {
    response: {
      status: 201,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value: clip }
    },
    nextState: {
      clips: { ...state.clips, [id]: clip },
      order: [...state.order, id],
      account: state.account
    },
    semanticEvents: [
      {
        name: "clip.created",
        eventVersion: 1,
        payload: { clipId: id, url, format }
      }
    ]
  };
}

function listClips(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const rawLimit = request.parameters.query.limit;
  const requested =
    typeof rawLimit === "number" && Number.isInteger(rawLimit)
      ? rawLimit
      : LIST_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), LIST_MAX_LIMIT);
  const rawCursor = request.parameters.query.cursor;
  const cursor = typeof rawCursor === "string" ? rawCursor : null;
  // The contract documents pages newest first, so the walk runs the
  // insertion order backwards. The cursor is the last identifier served
  // on the previous page. A cursor that no longer names a live clip,
  // because the clip was deleted between pages, restarts at the first
  // page: the contract declares no cursor error and a restart can never
  // skip a live clip.
  const newestFirst = [...state.order].reverse();
  let start = 0;
  if (cursor !== null) {
    const anchor = newestFirst.indexOf(cursor);
    start = anchor === -1 ? 0 : anchor + 1;
  }
  const items = newestFirst
    .slice(start, start + limit)
    .map((id) => state.clips[id])
    .filter((clip): clip is ClipRecord => clip !== undefined);
  const more = start + items.length < newestFirst.length;
  const last = items[items.length - 1];
  const nextCursor = more && last !== undefined ? last.id : "";
  return jsonResult(200, { items, nextCursor });
}

function getClip(request: BehaviorRequest, state: ScenarioState): BehaviorResult {
  return jsonResult(200, liveClip(state, clipIdOf(request)));
}

function deleteClip(request: BehaviorRequest, state: ScenarioState): BehaviorResult {
  const id = clipIdOf(request);
  liveClip(state, id);
  const clips = { ...state.clips };
  delete clips[id];
  return {
    // 204 carries no body, so the response names no media type either.
    response: { status: 204 },
    nextState: {
      clips,
      order: state.order.filter((entry) => entry !== id),
      account: state.account
    },
    semanticEvents: [
      { name: "clip.deleted", eventVersion: 1, payload: { clipId: id } }
    ]
  };
}

function renderClip(
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
): BehaviorResult {
  const id = clipIdOf(request);
  const clip = liveClip(state, id);
  const durationMs = 100 + domain.random.nextInt(900);
  return {
    response: {
      status: 200,
      mediaType: JSON_MEDIA_TYPE,
      body: {
        kind: "json",
        value: { clipId: id, status: "rendered", duration_ms: durationMs }
      }
    },
    nextState: withClip(state, { ...clip, status: "rendered" }),
    semanticEvents: [
      { name: "clip.rendered", eventVersion: 1, payload: { clipId: id } }
    ]
  };
}

function getClipContent(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const clip = liveClip(state, clipIdOf(request));
  const media = clip.format === "image" ? SVG_MEDIA_TYPE : MARKDOWN_MEDIA_TYPE;
  if (!accepts(request.acceptedResponseMediaTypes, media)) {
    problem({
      status: 406,
      code: "not_acceptable",
      message:
        "The Accept header names no representation this clip can serve."
    });
  }
  return {
    response: { status: 200, mediaType: media, body: textBody(contentOf(clip)) }
  };
}

function extractText(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const id = clipIdOf(request);
  const clip = liveClip(state, id);
  // The contract lets only a pending or failed clip answer 409, so an
  // extracted clip stays extractable.
  if (clip.status !== "rendered" && clip.status !== "extracted") {
    problem({
      status: 409,
      code: "clip_not_rendered",
      message:
        "The clip is not rendered yet. Render the clip first, then " +
        "extract its text."
    });
  }
  const text = contentOf(clip);
  const wordCount = countWords(text);
  return {
    response: {
      status: 200,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value: { clipId: id, text, word_count: wordCount } }
    },
    nextState: withClip(state, { ...clip, status: "extracted" }),
    semanticEvents: [
      {
        name: "clip.extracted",
        eventVersion: 1,
        payload: { clipId: id, wordCount }
      }
    ]
  };
}

function getAccount(
  _request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  return jsonResult(200, {
    account_id: state.account.account_id,
    plan: state.account.plan,
    clips_used: state.order.length,
    clips_limit: state.account.clips_limit
  });
}

const HANDLERS: Record<string, DomainHandler> = {
  "POST /v1/clips": createClip,
  "GET /v1/clips": listClips,
  "GET /v1/clips/{clipId}": getClip,
  "DELETE /v1/clips/{clipId}": deleteClip,
  "POST /v1/clips/{clipId}/render": renderClip,
  "GET /v1/clips/{clipId}/content": getClipContent,
  "POST /v1/clips/{clipId}/extract": extractText,
  "GET /v1/account": getAccount
};

/**
 * Build the backend for one contract. The description derives from the
 * compiled contract, so the declared keys can never drift from the
 * operations the gateway actually routes.
 */
function webclipBackend(contract: BackendFactoryContext["contract"]): BehaviorBackend {
  return {
    async describe(): Promise<BackendDescription> {
      return {
        backendApiVersion: 1,
        stateSchemaVersion: 1,
        operations: contract.operations.map((operation) => ({
          key: operation.key,
          support:
            HANDLERS[`${operation.method} ${operation.path_template}`] !==
            undefined
              ? "implemented"
              : "unsupported"
        })),
        semanticEvents: SEMANTIC_EVENTS
      };
    },
    initialize(context: InitializeContext): Promise<InitializeResult> {
      return Promise.resolve({
        state: {
          clips: {},
          order: [],
          account: {
            account_id: context.ids.next("acct"),
            plan: "free",
            clips_limit: CLIPS_LIMIT
          }
        }
      });
    },
    async handle(
      request: BehaviorRequest,
      context: HandleContext
    ): Promise<BehaviorResult> {
      const key = `${request.operation.method} ${request.operation.path_template}`;
      const handler = HANDLERS[key];
      if (handler === undefined) {
        throw new Error(`The webclip backend implements no ${key} handler.`);
      }
      const state = readState(context.state);
      const domain: DomainContext = {
        clock: context.clock,
        ids: context.ids,
        random: context.random
      };
      return handler(request, state, domain);
    }
  };
}

export const backend: BackendModule = {
  apiVersion: 1,
  name: "webclip",
  version: "0.1.0",
  async create(context: BackendFactoryContext): Promise<BehaviorBackend> {
    return webclipBackend(context.contract);
  }
};
