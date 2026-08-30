import { describe, expect, it } from "vitest";

import { isJsonObject, type Json, type JsonObject } from "@oal/core";
import { evaluateRubric } from "@oal/evaluator";
import type { TraceBody, TraceEvent } from "@oal/evidence";

import {
  compilePackContract,
  loadPackFromRepo,
  loadPackRubric,
  readPackJson,
  rubricOf,
  traceExchange,
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

describe("the webclip pack", () => {
  it("validates with zero errors and zero warnings", () => {
    expect(pack.validation.errors).toEqual([]);
    expect(pack.validation.warnings).toEqual([]);
    expect(pack.validation.packIr).not.toBeNull();
    const behavior = pack.loaded.manifest.behavior as JsonObject;
    expect(behavior.mode).toBe("contract");
    expect(pack.loaded.manifest.evals).toHaveLength(1);
    expect(pack.loaded.manifest.scenarios).toHaveLength(1);
    // The before state: no fixtures, so every response is generated.
    const contract = pack.loaded.manifest.contract as JsonObject;
    expect(contract.response_fixtures).toEqual([]);
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

describe("the webclip site-errand rubric against a passing trace", () => {
  it("scores the two-clip errand as passed", () => {
    const markdown = "clip_01h8x9k4m2";
    const image = "clip_01h8x9k4n7";
    const createClip = (id: string, format: string, sequence: number) =>
      traceExchange({
        event_id: `evt-${sequence}`,
        sequence,
        operation_id: "create_clip",
        method: "POST",
        path_template: "/v1/clips",
        status: 201,
        request_body: traceJsonBody({
          url: "https://example.com/page",
          format
        }),
        response_body: traceJsonBody({
          id,
          url: "https://example.com/page",
          format,
          status: "pending",
          created_at: "2026-08-29T09:14:00Z"
        })
      });
    const step = (
      operationId: string,
      method: string,
      suffix: string,
      id: string,
      sequence: number,
      status: number,
      body: TraceBody
    ) =>
      traceExchange({
        event_id: `evt-${sequence}`,
        sequence,
        operation_id: operationId,
        method,
        path_template: `/v1/clips/{clipId}${suffix}`,
        status,
        path_parameters: { clipId: id },
        response_body: body
      });
    const events = [
      createClip(markdown, "markdown", 1),
      createClip(image, "image", 2),
      step("render_clip", "POST", "/render", markdown, 3, 200, {
        kind: "json",
        size_bytes: 48,
        value: { clipId: markdown, status: "rendered", duration_ms: 812 },
        truncated: false
      }),
      step("render_clip", "POST", "/render", image, 4, 200, {
        kind: "json",
        size_bytes: 47,
        value: { clipId: image, status: "rendered", duration_ms: 903 },
        truncated: false
      }),
      step("get_clip_content", "GET", "/content", markdown, 5, 200, {
        kind: "text",
        size_bytes: 18,
        sha256: null,
        text: "# Essay\n\nThesis.",
        truncated: false
      }),
      step("get_clip_content", "GET", "/content", image, 6, 200, {
        kind: "text",
        size_bytes: 67,
        sha256: null,
        text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        truncated: false
      }),
      step("extract_text", "POST", "/extract", markdown, 7, 200, {
        kind: "json",
        size_bytes: 44,
        value: { clipId: markdown, text: "Essay Thesis.", word_count: 2 },
        truncated: false
      }),
      step("delete_clip", "DELETE", "", markdown, 8, 204, {
        kind: "none"
      }),
      traceExchange({
        event_id: "evt-9",
        sequence: 9,
        operation_id: "get_account",
        method: "GET",
        path_template: "/v1/account",
        status: 200,
        response_body: traceJsonBody({
          account_id: "acct_7d2m01",
          plan: "free",
          clips_used: 2,
          clips_limit: 100
        })
      })
    ];
    const report = {
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
      uncertainties: [
        "Whether the quota counts deleted clips.",
        "Which Accept value names the picture form."
      ]
    };
    const result = evaluate(events, report);
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["errand_flow", "passed"],
      ["result_report", "passed"],
      ["two_clips_created", "passed"],
      ["no_unmatched_delete", "passed"],
      ["comprehension_probe", "passed"]
    ]);
  });
});
