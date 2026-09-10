import { describe, expect, it } from "vitest";

import { isJsonObject, type Json, type JsonObject } from "@oal/core";
import { evaluateRubric } from "@oal/evaluator";
import type { TraceEvent } from "@oal/evidence";

import {
  compilePackContract,
  loadPackFromRepo,
  loadPackRubric,
  readPackJson,
  rubricOf,
  traceExchange,
  traceHeader,
  traceJsonBody,
  type PackForTest
} from "./index.ts";

const pack: PackForTest = await loadPackFromRepo("webclip");

const RUN_ID = "run-webclip-1";
const RUN: JsonObject = { run_id: RUN_ID, mode: "record" };

const RESULT_SCHEMA = "schemas/site-errand-result.schema.json";
const PROBE_SCHEMA = "schemas/comprehension-probe.schema.json";

function evaluate(
  events: readonly TraceEvent[],
  report: Json
): ReturnType<typeof evaluateRubric> {
  return evaluateRubric({
    rubric: rubricOf(
      loadPackRubric(pack.loaded, "evals/site-errand/rubric.yaml")
    ),
    runId: RUN_ID,
    run: RUN,
    events,
    state: {},
    report,
    resolveSchema: (reference) => readPackJson(pack.loaded, reference)
  });
}

function checkStatus(
  result: ReturnType<typeof evaluateRubric>,
  id: string
): string {
  const check = result.checks.find((candidate) => candidate.id === id);
  if (check === undefined) {
    throw new Error(`Check ${id} is missing from the result.`);
  }
  return check.status;
}

describe("the webclip pack", () => {
  it("validates with zero errors and zero warnings", () => {
    expect(pack.validation.errors).toEqual([]);
    expect(pack.validation.warnings).toEqual([]);
    expect(pack.validation.packIr).not.toBeNull();
    const behavior = pack.loaded.manifest.behavior as JsonObject;
    expect(behavior.mode).toBe("contract");
    expect(pack.loaded.manifest.evals).toHaveLength(1);
    expect(pack.loaded.manifest.scenarios).toHaveLength(1);
    const metadata = pack.loaded.manifest.metadata as JsonObject;
    expect(metadata.version).toBe("0.2.0");
    // The after state: six authored fixtures cover every operation the
    // errand touches except the content endpoint, which keeps Accept
    // negotiation, and the bodyless delete.
    const contract = pack.loaded.manifest.contract as JsonObject;
    const fixtures = contract.response_fixtures as Json[];
    expect(fixtures).toHaveLength(6);
    expect(
      pack.loaded.references
        .filter((reference) => reference.role === "fixture_body")
        .map((reference) => reference.path)
    ).toEqual([
      "fixtures/clip-created.json",
      "fixtures/clips-page.json",
      "fixtures/clip-read.json",
      "fixtures/render-result.json",
      "fixtures/extract-result.json",
      "fixtures/account.json"
    ]);
  });

  it("compiles the eight greenfield operations with none unsupported", async () => {
    const compiled = await compilePackContract(pack.loaded);
    const keys = compiled.contract.operations.map((operation) => operation.key);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    expect([...pack.validation.coverage.contractOperations]).toEqual(keys);
    expect(compiled.report.counts.operations.unsupported).toBe(0);
    const content = compiled.contract.operations.find(
      (operation) => operation.operation_id === "get_clip_content"
    );
    const ok = content?.responses.find(
      (response) => response.selector === "200"
    );
    const media = ok?.content.map((entry) => entry.media_type);
    expect(media).toEqual(["image/svg+xml", "text/markdown"]);
    const svg = ok?.content.find(
      (entry) => entry.media_type === "image/svg+xml"
    );
    expect(svg?.schema_ref).toBeNull();
  });

  it("loads the rubric and both report schemas", () => {
    const result = loadPackRubric(pack.loaded, "evals/site-errand/rubric.yaml");
    expect(result.diagnostics).toEqual([]);
    expect(rubricOf(result).id).toBe("webclip-site-errand");
    for (const schemaPath of [RESULT_SCHEMA, PROBE_SCHEMA]) {
      const document = readPackJson(pack.loaded, schemaPath);
      expect(isJsonObject(document)).toBe(true);
    }
  });
});

/** One step of the errand, named for the negative controls. */
type ErrandPartId =
  | "create_markdown"
  | "create_image"
  | "render_markdown"
  | "render_image"
  | "fetch_markdown"
  | "fetch_image"
  | "extract_markdown"
  | "delete_markdown"
  | "read_quota";

const CANONICAL_ORDER: readonly ErrandPartId[] = [
  "create_markdown",
  "create_image",
  "render_markdown",
  "render_image",
  "fetch_markdown",
  "fetch_image",
  "extract_markdown",
  "delete_markdown",
  "read_quota"
];

const MARKDOWN_ID = "clip_01h8x9k4m2";
const IMAGE_ID = "clip_01h8x9k4n7";
const EXTRA_ID = "clip_01h8x9k4p9";
const ESSAY_URL = "https://example.com/essay";
const DASHBOARD_URL = "https://example.com/dashboard";

interface ErrandOptions {
  /** Drops one errand step from the trace. */
  readonly omit?: ErrandPartId;
  /** Identifier returned by the markdown create. */
  readonly markdownId?: string;
  /** Identifier returned by the image create. */
  readonly imageId?: string;
  /** Request body of the markdown create. */
  readonly markdownCreate?: {
    readonly url: string;
    readonly format: string;
  };
  /** Request body of the image create. */
  readonly imageCreate?: {
    readonly url: string;
    readonly format: string;
  };
  /** Which clip the deletion targets. */
  readonly deletedClip?: "markdown" | "image";
  /** Representation of the markdown content fetch. */
  readonly markdownFetch?: {
    readonly accept?: string;
    readonly contentType?: string;
  };
  /** Representation of the image content fetch. */
  readonly imageFetch?: {
    readonly accept?: string;
    readonly contentType?: string;
  };
  /** Appends one extra successful create call. */
  readonly extraCreate?: boolean;
}

type PartInit = Omit<
  Parameters<typeof traceExchange>[0],
  "event_id" | "sequence"
>;

function errandPart(id: ErrandPartId, options: ErrandOptions): PartInit {
  const markdownId = options.markdownId ?? MARKDOWN_ID;
  const imageId = options.imageId ?? IMAGE_ID;
  const markdownCreate = options.markdownCreate ?? {
    url: ESSAY_URL,
    format: "markdown"
  };
  const imageCreate = options.imageCreate ?? {
    url: DASHBOARD_URL,
    format: "image"
  };
  const markdownFetch = {
    accept: options.markdownFetch?.accept ?? "text/markdown",
    contentType: options.markdownFetch?.contentType ?? "text/markdown"
  };
  const imageFetch = {
    accept: options.imageFetch?.accept ?? "image/svg+xml",
    contentType: options.imageFetch?.contentType ?? "image/svg+xml"
  };
  const clipStep = (
    operationId: string,
    method: string,
    suffix: string,
    clipId: string,
    status: number,
    responseBody: Parameters<typeof traceJsonBody>[0]
  ): PartInit => ({
    operation_id: operationId,
    method,
    path_template: `/v1/clips/{clipId}${suffix}`,
    status,
    path_parameters: { clipId },
    response_body: traceJsonBody(responseBody)
  });
  switch (id) {
    case "create_markdown":
      return {
        operation_id: "create_clip",
        method: "POST",
        path_template: "/v1/clips",
        status: 201,
        request_body: traceJsonBody(markdownCreate),
        response_body: traceJsonBody({
          id: markdownId,
          url: markdownCreate.url,
          format: markdownCreate.format,
          status: "pending",
          created_at: "2026-08-29T09:14:00Z"
        })
      };
    case "create_image":
      return {
        operation_id: "create_clip",
        method: "POST",
        path_template: "/v1/clips",
        status: 201,
        request_body: traceJsonBody(imageCreate),
        response_body: traceJsonBody({
          id: imageId,
          url: imageCreate.url,
          format: imageCreate.format,
          status: "pending",
          created_at: "2026-08-29T09:14:04Z"
        })
      };
    case "render_markdown":
      return clipStep("render_clip", "POST", "/render", markdownId, 200, {
        clipId: markdownId,
        status: "rendered",
        duration_ms: 812
      });
    case "render_image":
      return clipStep("render_clip", "POST", "/render", imageId, 200, {
        clipId: imageId,
        status: "rendered",
        duration_ms: 903
      });
    case "fetch_markdown":
      return {
        operation_id: "get_clip_content",
        method: "GET",
        path_template: "/v1/clips/{clipId}/content",
        status: 200,
        path_parameters: { clipId: markdownId },
        request_headers: [traceHeader("accept", [markdownFetch.accept])],
        response_headers: [
          traceHeader("content-type", [markdownFetch.contentType])
        ],
        response_content_type: markdownFetch.contentType,
        response_body: {
          kind: "text",
          size_bytes: 18,
          sha256: null,
          text: "# Essay\n\nThesis.",
          truncated: false
        }
      };
    case "fetch_image":
      return {
        operation_id: "get_clip_content",
        method: "GET",
        path_template: "/v1/clips/{clipId}/content",
        status: 200,
        path_parameters: { clipId: imageId },
        request_headers: [traceHeader("accept", [imageFetch.accept])],
        response_headers: [
          traceHeader("content-type", [imageFetch.contentType])
        ],
        response_content_type: imageFetch.contentType,
        response_body: {
          kind: "text",
          size_bytes: 67,
          sha256: null,
          text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          truncated: false
        }
      };
    case "extract_markdown":
      return clipStep("extract_text", "POST", "/extract", markdownId, 200, {
        clipId: markdownId,
        text: "Essay Thesis.",
        word_count: 2
      });
    case "delete_markdown": {
      const deleted = options.deletedClip ?? "markdown";
      const clipId = deleted === "image" ? imageId : markdownId;
      return {
        operation_id: "delete_clip",
        method: "DELETE",
        path_template: "/v1/clips/{clipId}",
        status: 204,
        path_parameters: { clipId },
        response_body: { kind: "none" }
      };
    }
    case "read_quota":
      return {
        operation_id: "get_account",
        method: "GET",
        path_template: "/v1/account",
        status: 200,
        response_body: traceJsonBody({
          account_id: "acct_7d2m01",
          plan: "free",
          clips_used: 1,
          clips_limit: 100
        })
      };
  }
}

/** Build the errand trace in the given step order, minus any omit. */
function errandEvents(
  order: readonly ErrandPartId[] = CANONICAL_ORDER,
  options: ErrandOptions = {}
): TraceEvent[] {
  const events: TraceEvent[] = [];
  const push = (init: PartInit): void => {
    events.push(
      traceExchange({
        ...init,
        event_id: `evt-${events.length + 1}`,
        sequence: events.length + 1
      })
    );
  };
  for (const id of order) {
    if (id === options.omit) {
      continue;
    }
    push(errandPart(id, options));
  }
  if (options.extraCreate === true) {
    push(errandPart("create_image", { imageId: EXTRA_ID }));
  }
  return events;
}

/** The agreeing report, with optional claim overrides. */
function errandReport(
  claims: Partial<Record<string, boolean>> = {}
): JsonObject {
  return {
    clips_created: true,
    markdown_clipped: true,
    image_clipped: true,
    both_rendered: true,
    markdown_content_fetched: true,
    image_content_fetched: true,
    text_extracted: true,
    clip_deleted: true,
    quota_checked: true,
    api_model:
      "webclip stores clips of web pages. A clip is created with a URL " +
      "and a fixed format, then rendered, and its content is fetched as " +
      "markdown or as a picture. Extracted text and deletion close the " +
      "clip lifecycle, and the account endpoint reports the quota.",
    authentication_model:
      "Every request carries an Authorization header with a Bearer token " +
      "taken from the OAL_AUTH_BEARER environment variable.",
    uncertainties: [],
    ...claims
  };
}

describe("the corrected webclip site-errand rubric", () => {
  it("passes a complete trace with all required checks", () => {
    const result = evaluate(errandEvents(), errandReport());
    expect(result.status).toBe("passed");
    expect(result.score).toBe(1);
    expect(result.passedWeight).toBe(7);
    expect(result.totalWeight).toBe(7);
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["markdown_clip_chain", "passed"],
      ["image_clip_chain", "passed"],
      ["clip_ids_distinct", "passed"],
      ["two_clips_created", "passed"],
      ["single_clip_deletion", "passed"],
      ["result_report", "passed"],
      ["no_unmatched_delete", "passed"],
      ["comprehension_probe", "passed"],
      ["extra_create_calls", "passed"]
    ]);
    expect(result.signals).toEqual({
      first_call_is_create: true,
      first_call_matched: true
    });
  });

  it("passes when the two clip lifecycles interleave", () => {
    const events = errandEvents([
      "create_markdown",
      "render_markdown",
      "create_image",
      "fetch_markdown",
      "render_image",
      "extract_markdown",
      "fetch_image",
      "delete_markdown",
      "read_quota"
    ]);
    const result = evaluate(events, errandReport());
    expect(result.status).toBe("passed");
    expect(checkStatus(result, "markdown_clip_chain")).toBe("passed");
    expect(checkStatus(result, "image_clip_chain")).toBe("passed");
  });
});
