/**
 * Shared fixtures of the evaluator integration suite (specification
 * section 36.1).
 *
 * The evaluator package depends only on `@oal/core` and `@oal/evidence`,
 * so this module rebuilds the minimal loading path the testkit offers:
 * repository-root discovery, a YAML subset parser that mirrors the pack
 * parser, pack-relative schema resolution, and Steel trace builders.
 *
 * The rubric digests pinned in `integration-steel.test.ts` prove that the
 * rebuilt path loads the shipped Steel rubrics exactly as the pack loader
 * does.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isJsonObject,
  parseBlockYaml,
  type BlockYamlDialect,
  type BlockYamlFailure,
  type Json,
  type JsonObject
} from "@oal/core";
import type { TraceBody, TraceEvent } from "@oal/evidence";

import { loadRubric, type Rubric, type RubricLoadResult } from "./rubric.ts";

/** File whose presence marks the repository root. */
const REPO_ROOT_MARKER = "pnpm-workspace.yaml";

/** Directory of this module, always inside the repository. */
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Find the repository root.
 *
 * The search starts at this module and walks up, so it works from any
 * working directory. The module fallback keeps the helper usable when a
 * caller passes a start directory outside the repository.
 */
export function repoRoot(start: string = MODULE_DIR): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, REPO_ROOT_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No ${REPO_ROOT_MARKER} found above ${start}.`);
    }
    current = parent;
  }
}

/** Directory of the shipped Steel Computer pack. */
export function steelPackRoot(): string {
  return path.join(repoRoot(), "packs", "steel-computer");
}

/** Read one JSON document inside the Steel pack. */
export function readSteelJson(relativePath: string): Json {
  const absolute = path.join(steelPackRoot(), relativePath);
  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as Json;
  if (!isJsonObject(parsed)) {
    throw new Error(`Not a JSON object: ${relativePath}`);
  }
  return parsed;
}

/** Every eval of the Steel Computer pack. */
export const STEEL_EVAL_IDS = [
  "checkpoint-recovery",
  "basic-lifecycle",
  "documentation-discovery"
] as const;

/** One eval of the Steel Computer pack. */
export type SteelEvalId = (typeof STEEL_EVAL_IDS)[number];

/**
 * Load one shipped Steel rubric with the repository rubric schema.
 *
 * `schema:` references inside the rubric resolve against the pack root,
 * which is the convention the pack rubrics follow.
 */
export async function loadSteelRubric(
  evalId: SteelEvalId
): Promise<RubricLoadResult> {
  const rubricPath = path.join("evals", evalId, "rubric.yaml");
  const document = parseSteelYaml(
    readFileSync(path.join(steelPackRoot(), rubricPath), "utf8")
  );
  const schema = readFileSync(
    path.join(repoRoot(), "schemas", "rubric.v1.schema.json"),
    "utf8"
  );
  return await loadRubric(document, {
    schema: JSON.parse(schema) as Json,
    resolveSchema: (reference: string): Json | undefined => {
      try {
        return readSteelJson(reference);
      } catch {
        return undefined;
      }
    },
    documentUri: `file://${path.join(steelPackRoot(), rubricPath)}`
  });
}

/** The rubric of one Steel eval, or a thrown error when it did not load. */
export async function steelRubric(evalId: SteelEvalId): Promise<Rubric> {
  const result = await loadSteelRubric(evalId);
  if (result.rubric !== null && result.diagnostics.length === 0) {
    return result.rubric;
  }
  const first = result.diagnostics[0];
  throw new Error(
    first === undefined
      ? `The rubric of ${evalId} did not load.`
      : `${first.code}: ${first.message}`
  );
}

/**
 * Parse the YAML subset the pack rubrics use.
 *
 * The semantics mirror `parsePackYaml` of `@oal/pack`: block mappings,
 * block sequences with compact mapping items, comments, plain and quoted
 * scalars, literal `|` and folded `>` block scalars with chomping, and
 * duplicate-key rejection. Anchors, aliases, tags, and flow collections
 * are rejected, because no shipped rubric uses them. The engine is the
 * shared line-based engine of `@oal/core`; the dialect below reproduces
 * the historical Steel behavior exactly.
 */

/** Error thrown for any unsupported YAML construct. */
export class SteelYamlError extends Error {
  /** One-based line number of the failure. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "SteelYamlError";
    this.line = line;
  }
}

function steelYamlMessage(failure: BlockYamlFailure): string {
  switch (failure.situation) {
    case "tab-indent":
      return "Tab characters are not allowed in indentation.";
    case "multiple-documents":
    case "trailing-content":
      return "Unexpected content after the document.";
    case "sequence-indent":
      return "Unexpected indentation in a block sequence.";
    case "compact-sequence":
      return "Compact nested sequences are not supported.";
    case "mapping-indent":
      return "Unexpected indentation in a block mapping.";
    case "expected-entry":
      return "Expected a 'key: value' mapping entry.";
    case "empty-key":
      return "Mapping keys must not be empty.";
    case "duplicate-key":
      return `Duplicate mapping key: ${failure.key}`;
    case "anchors":
      return "Anchors, aliases, and tags are not supported.";
    case "flow-unsupported":
      return "Flow collections are not supported.";
    case "quoted-scalar":
      return "Unterminated or trailing quoted scalar.";
    default:
      return "The rubric document is not valid YAML.";
  }
}

/** Dialect that reproduces the Steel rubric parser exactly. */
const STEEL_YAML_DIALECT: BlockYamlDialect = {
  fail(failure) {
    throw new SteelYamlError(steelYamlMessage(failure), failure.line);
  },
  skipDirectives: true,
  tabCheck: "split",
  flow: false,
  limits: null,
  extendedEscapes: true,
  blankIsContent: false,
  chompFormulation: "text",
  flowSkipsBreaks: true,
  flowKeyBreaksOnBracket: true
};

/** Parse the YAML subset the Steel rubrics use. */
export function parseSteelYaml(text: string): Json {
  return parseBlockYaml(text, STEEL_YAML_DIALECT);
}

/**
 * Build one `api.exchange` trace event.
 *
 * The field set mirrors the trace the loopback exposure writes: the
 * operation block carries the contract identity, the request carries the
 * path parameters the participant used, and the response carries the
 * status and body the rubric inspects.
 */
export interface TraceExchangeInit {
  readonly sequence: number;
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly status: number;
  readonly pathParameters?: Record<string, string>;
  readonly requestPath?: string;
  readonly requestBody?: TraceBody;
  readonly responseBody?: TraceBody;
  readonly matched?: boolean;
}

/** Session identifier the Steel fixtures use. */
export const SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** Fixed instant every fixture exchange reports. */
export const OBSERVED_AT = "2023-11-14T22:13:20.000Z";

export function traceExchange(init: TraceExchangeInit): TraceEvent {
  const operationKey = `path:${init.method} ${init.pathTemplate}`;
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: `req_${init.sequence.toString(10).padStart(8, "0")}`,
    sequence: init.sequence,
    participant_ingress_sequence: init.sequence,
    observed_at: OBSERVED_AT,
    logical_time: null,
    batch_id: null,
    run_id: null,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: init.matched ?? true,
      key: operationKey,
      uid: `op-${init.operationId}`,
      operation_id: init.operationId,
      method: init.method,
      path_template: init.pathTemplate,
      support: "supported"
    },
    request: {
      received_at: OBSERVED_AT,
      method: init.method,
      path: init.requestPath ?? init.pathTemplate,
      query_string: "",
      query: [],
      path_parameters: init.pathParameters ?? {},
      headers: [],
      credential_present: true,
      content_type: "application/json",
      body: init.requestBody ?? { kind: "none" }
    },
    authentication: {
      status: "authenticated",
      alternative_index: null,
      schemes: ["apiKey"],
      principal_ref: null
    },
    validation: {
      request: { status: "valid", violations: [] },
      response: { status: "valid", violations: [] }
    },
    backend: null,
    response: {
      completed_at: OBSERVED_AT,
      status: init.status,
      headers: [],
      content_type: "application/json",
      body: init.responseBody ?? { kind: "none" }
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: null,
    duration_ms: 4,
    resource_usage: null,
    extensions: {}
  };
}

/** Build one JSON trace body. */
export function jsonBody(value: Json): TraceBody {
  return {
    kind: "json",
    size_bytes: JSON.stringify(value).length,
    value,
    truncated: false
  };
}

/** Build one binary trace body with the digest a rubric compares. */
export function binaryBody(sha256: string): TraceBody {
  return { kind: "binary", size_bytes: 32, sha256, blob_ref: null };
}

/** Build one multipart trace body with a single file part. */
export function multipartBody(filename: string): TraceBody {
  return {
    kind: "multipart",
    size_bytes: 32,
    parts: [
      {
        name: "file",
        filename,
        headers: [],
        body: binaryBody(
          `sha256-${filename.replace(/[^a-z0-9]/gu, "")}`.padEnd(64, "0")
        )
      }
    ]
  };
}

/** Final reports, one per Steel eval. Each matches its pack schema. */
export const STEEL_REPORTS: Readonly<Record<SteelEvalId, JsonObject>> = {
  "checkpoint-recovery": {
    released_session: true,
    saved_state_create_supported: false,
    notes: "flow complete"
  },
  "basic-lifecycle": {
    session_created: true,
    session_released: true,
    final_status: "released"
  },
  "documentation-discovery": {
    session_created: true,
    operations_discovered: 41,
    contract_source: "openapi.json"
  }
};

/** Path parameters of one session-scoped Steel route. */
function sessionParams(extra: Readonly<Record<string, string>> = {}): {
  sessionId: string;
} & Record<string, string> {
  return { sessionId: SESSION_ID, ...extra };
}

/** One create-session exchange with a live session body. */
export function createSession(sequence: number, status = 201): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "create_session",
    method: "POST",
    pathTemplate: "/v1/sessions",
    status,
    responseBody: jsonBody({ id: SESSION_ID, status: "live" })
  });
}

/** One read-session exchange with the given status value. */
export function readSession(
  sequence: number,
  sessionStatus: string
): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "get_session",
    method: "GET",
    pathTemplate: "/v1/sessions/{id}",
    status: 200,
    pathParameters: { id: SESSION_ID },
    responseBody: jsonBody({ id: SESSION_ID, status: sessionStatus })
  });
}

/** One release-session exchange. */
export function releaseSession(sequence: number): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "release_session",
    method: "POST",
    pathTemplate: "/v1/sessions/{id}/release",
    status: 200,
    pathParameters: { id: SESSION_ID },
    responseBody: jsonBody({ id: SESSION_ID, status: "released" })
  });
}

/** One file upload exchange. */
export function uploadFile(sequence: number, filename: string): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "upload_file",
    method: "POST",
    pathTemplate: "/v1/sessions/{sessionId}/files",
    status: 201,
    pathParameters: sessionParams(),
    requestBody: multipartBody(filename),
    responseBody: jsonBody({ path: filename })
  });
}

/** One file download exchange. */
export function downloadFile(
  sequence: number,
  filename: string,
  sha256: string
): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "download_file",
    method: "GET",
    pathTemplate: "/v1/sessions/{sessionId}/files/{path}",
    status: 200,
    pathParameters: sessionParams({ path: filename }),
    requestPath: `/v1/sessions/${SESSION_ID}/files/${filename}`,
    responseBody: binaryBody(sha256)
  });
}
