import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SchemaValidator,
  isJsonObject,
  type Json,
  type JsonObject
} from "@oal/core";
import { evaluateRubric } from "@oal/evaluator";
import type { TraceEvent } from "@oal/evidence";

import {
  compilePackContract,
  findRepoRoot,
  loadPackRubric,
  loadSteelPack,
  readPackJson,
  rubricOf,
  traceBinaryBody,
  traceExchange,
  traceJsonBody,
  traceMultipartBody,
  type PackForTest
} from "./index.ts";

const pack: PackForTest = await loadSteelPack();

const CLEAN_SHA = "a".repeat(64);
const CHANGED_SHA = "b".repeat(64);
const RUN_ID = "run-steel-1";
const RUN: JsonObject = { run_id: RUN_ID, mode: "record" };

function referencesOf(role: string): readonly string[] {
  return pack.loaded.references
    .filter((reference) => reference.role === role)
    .map((reference) => reference.path);
}

async function evaluate(
  rubricPath: string,
  events: readonly TraceEvent[],
  report: Json
): ReturnType<typeof evaluateRubric> {
  return evaluateRubric({
    rubric: rubricOf(await loadPackRubric(pack.loaded, rubricPath)),
    runId: RUN_ID,
    run: RUN,
    events,
    state: {},
    report,
    resolveSchema: (reference) => readPackJson(pack.loaded, reference)
  });
}

describe("the Steel Computer pack", () => {
  it("validates with zero errors and zero warnings", () => {
    expect(pack.validation.errors).toEqual([]);
    expect(pack.validation.warnings).toEqual([]);
    expect(pack.validation.packIr).not.toBeNull();
    const behavior = pack.loaded.manifest.behavior as JsonObject;
    expect(behavior.mode).toBe("contract");
    expect(pack.loaded.manifest.evals).toHaveLength(5);
    expect(pack.loaded.manifest.scenarios).toHaveLength(1);
  });

  it("keeps all 41 Steel v1 operations in the contract", async () => {
    const compiled = await compilePackContract(pack.loaded);
    const keys = compiled.contract.operations.map((operation) => operation.key);
    expect(keys).toHaveLength(41);
    expect(new Set(keys).size).toBe(41);
    expect([...pack.validation.coverage.contractOperations]).toEqual(keys);
    expect(compiled.report.counts.operations.unsupported).toBe(1);
    const media = compiled.report.diagnostics.filter(
      (entry) => entry.code === "OAL-CAP-MEDIA-UNSUPPORTED"
    );
    expect(media).toHaveLength(1);
    expect(media[0]?.message).toContain("application/zip");
  });

  it("loads every rubric with zero diagnostics", async () => {
    const rubricPaths = referencesOf("rubric");
    expect(rubricPaths).toEqual([
      "evals/checkpoint-recovery/rubric.yaml",
      "evals/basic-lifecycle/rubric.yaml",
      "evals/documentation-discovery/rubric.yaml",
      "evals/site-errand/rubric.yaml",
      "evals/open-ended/rubric.yaml"
    ]);
    const ids = await Promise.all(
      rubricPaths.map(async (rubricPath) => {
        const result = await loadPackRubric(pack.loaded, rubricPath);
        expect(result.diagnostics).toEqual([]);
        return rubricOf(result).id;
      })
    );
    expect(ids).toEqual([
      "steel-checkpoint-recovery",
      "steel-basic-lifecycle",
      "steel-documentation-discovery",
      "steel-site-errand",
      "steel-open-ended"
    ]);
  });

  it("ships cases that satisfy the line and input schemas", async () => {
    const source = pack.loaded.references.find(
      (reference) => reference.role === "case_source"
    );
    const schema = pack.loaded.references.find(
      (reference) => reference.role === "case_schema"
    );
    expect(source?.path).toBe("tasks/checkpoint-recovery/cases.jsonl");
    expect(schema?.path).toBe("schemas/checkpoint-recovery-case.schema.json");
    const repositorySchema = JSON.parse(
      await readFile(
        path.join(findRepoRoot(), "schemas", "eval-case.v1.schema.json"),
        "utf8"
      )
    ) as Json;
    const repository = new SchemaValidator(repositorySchema);
    const packCase = new SchemaValidator(schema?.document ?? {});
    const text = await readFile(source?.absolutePath ?? "", "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const seen = new Set<Json>();
    for (const line of lines) {
      const entry = JSON.parse(line) as JsonObject;
      // The repository schema governs the whole line; the pack schema
      // governs the synthetic input object only (SPEC section 12.6).
      expect(repository.errors(entry)).toEqual([]);
      const input = entry.input;
      expect(typeof input === "object" && input !== null).toBe(true);
      if (isJsonObject(input)) {
        expect(packCase.errors(input)).toEqual([]);
      }
      expect(seen.has(entry.id ?? null)).toBe(false);
      seen.add(entry.id ?? null);
    }
  });
});

describe("the Steel Computer rubrics against a passing trace", () => {
  it("scores the checkpoint-recovery happy path as passed", async () => {
    const session = "s-1";
    const upload = (name: string, sha: string, sequence: number) =>
      traceExchange({
        event_id: `evt-${sequence}`,
        sequence,
        operation_id: "upload_file",
        method: "POST",
        path_template: "/v1/sessions/{sessionId}/files",
        status: 201,
        path_parameters: { sessionId: session },
        request_content_type: "multipart/form-data",
        request_body: traceMultipartBody({ name, sha256: sha })
      });
    const download = (sha: string, sequence: number) =>
      traceExchange({
        event_id: `evt-${sequence}`,
        sequence,
        operation_id: "download_file",
        method: "GET",
        path_template: "/v1/sessions/{sessionId}/files/{path}",
        status: 200,
        path_parameters: { sessionId: session, path: "brief.txt" },
        response_content_type: "application/octet-stream",
        response_body: traceBinaryBody(sha)
      });
    const events = [
      traceExchange({
        event_id: "evt-1",
        sequence: 1,
        operation_id: "create_session",
        method: "POST",
        path_template: "/v1/sessions",
        status: 201,
        response_body: traceJsonBody({ id: session, status: "live" })
      }),
      upload("file", CLEAN_SHA, 2),
      download(CLEAN_SHA, 3),
      upload("file", CHANGED_SHA, 4),
      download(CHANGED_SHA, 5),
      upload("file", CLEAN_SHA, 6),
      download(CLEAN_SHA, 7),
      traceExchange({
        event_id: "evt-8",
        sequence: 8,
        operation_id: "release_session",
        method: "POST",
        path_template: "/v1/sessions/{id}/release",
        status: 200,
        path_parameters: { id: session },
        response_body: traceJsonBody({ success: true, message: "released" })
      }),
      traceExchange({
        event_id: "evt-9",
        sequence: 9,
        operation_id: "get_session",
        method: "GET",
        path_template: "/v1/sessions/{id}",
        status: 200,
        path_parameters: { id: session },
        response_body: traceJsonBody({ id: session, status: "released" })
      })
    ];
    const result = await evaluate(
      "evals/checkpoint-recovery/rubric.yaml",
      events,
      {
        released_session: true,
        saved_state_create_supported: false,
        notes: "Steel v1 publishes no saved-state session creation."
      }
    );
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["recovery_flow", "passed"],
      ["result_report", "passed"],
      ["single_create", "passed"],
      ["saved_state_reported_unsupported", "passed"],
      ["no_unmatched_requests", "passed"]
    ]);
  });

  it("scores the basic-lifecycle happy path as passed", async () => {
    const session = "s-2";
    const read = (status: string, sequence: number) =>
      traceExchange({
        event_id: `evt-${sequence}`,
        sequence,
        operation_id: "get_session",
        method: "GET",
        path_template: "/v1/sessions/{id}",
        status: 200,
        path_parameters: { id: session },
        response_body: traceJsonBody({ id: session, status })
      });
    const events = [
      traceExchange({
        event_id: "evt-1",
        sequence: 1,
        operation_id: "create_session",
        method: "POST",
        path_template: "/v1/sessions",
        status: 201,
        response_body: traceJsonBody({ id: session, status: "live" })
      }),
      read("live", 2),
      traceExchange({
        event_id: "evt-3",
        sequence: 3,
        operation_id: "release_session",
        method: "POST",
        path_template: "/v1/sessions/{id}/release",
        status: 200,
        path_parameters: { id: session },
        response_body: traceJsonBody({ success: true, message: "released" })
      }),
      read("released", 4)
    ];
    const result = await evaluate("evals/basic-lifecycle/rubric.yaml", events, {
      session_created: true,
      session_released: true,
      final_status: "released"
    });
    expect(result.status).toBe("passed");
    expect(result.score).toBe(1);
  });

  it("scores the documentation-discovery happy path as passed", async () => {
    const events = [
      traceExchange({
        event_id: "evt-1",
        sequence: 1,
        operation_id: "create_session",
        method: "POST",
        path_template: "/v1/sessions",
        status: 201,
        response_body: traceJsonBody({ id: "s-3", status: "live" })
      })
    ];
    const result = await evaluate(
      "evals/documentation-discovery/rubric.yaml",
      events,
      {
        session_created: true,
        operations_discovered: 41,
        contract_source: "openapi.json"
      }
    );
    expect(result.status).toBe("passed");
    expect(result.score).toBe(1);
  });
});
