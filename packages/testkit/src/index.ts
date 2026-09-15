/**
 * Shared test helpers for repository tests.
 *
 * The helpers resolve repository paths relative to `process.cwd()`, so a
 * test keeps working from the repository root and from any workspace
 * package directory. When the working directory sits outside the
 * repository, resolution falls back to the location of this module.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isJsonObject,
  isSafeRelativePath,
  isWithin,
  type Json
} from "@oal/core";
import type { TraceBody, TraceEvent, TraceHeader } from "@oal/evidence";
import { loadRubric, type Rubric, type RubricLoadResult } from "@oal/evaluator";
import { compileOpenApi, type CompileResult } from "@oal/openapi";
import {
  loadPack,
  validatePack,
  type LoadedPack,
  type PackValidationResult
} from "@oal/pack";

export const packageName = "@oal/testkit";

/** File whose presence marks the repository root. */
const REPO_ROOT_MARKER = "pnpm-workspace.yaml";

/** Directory of this module, always inside the repository. */
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

function repoRootAbove(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, REPO_ROOT_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Find the repository root. The search starts at `start`, walks up to
 * the file system root, and falls back to the directory of this module.
 */
export function findRepoRoot(start = process.cwd()): string {
  const fromStart = repoRootAbove(start);
  if (fromStart !== null) {
    return fromStart;
  }
  const fromModule = repoRootAbove(MODULE_DIR);
  if (fromModule !== null) {
    return fromModule;
  }
  throw new Error(
    `No ${REPO_ROOT_MARKER} found above ${start} or ${MODULE_DIR}.`
  );
}

/** One pack loaded from `packs/<id>` plus its validation result. */
export interface PackForTest {
  readonly root: string;
  readonly loaded: LoadedPack;
  readonly validation: PackValidationResult;
}

/**
 * Load and validate one pack of this repository by id. The pack
 * directory resolves against the repository root, never against the
 * working directory.
 */
export async function loadPackFromRepo(
  packId: string,
  root = findRepoRoot()
): Promise<PackForTest> {
  const directory = path.join(root, "packs", packId);
  const loaded = await loadPack(directory);
  const validation = await validatePack(directory);
  return { root: directory, loaded, validation };
}

/** The first migrated built-in pack (specification section 39). */
export const STEEL_PACK_ID = "steel-computer";

/** Load and validate the Steel Computer pack. */
export function loadSteelPack(root = findRepoRoot()): Promise<PackForTest> {
  return loadPackFromRepo(STEEL_PACK_ID, root);
}

/**
 * Compile the contract entrypoint of one loaded pack.
 *
 * The documents-plus-entrypoint call shape mirrors the `compile` helper
 * of `packages/openapi/tests/compile.test.ts`.
 */
export async function compilePackContract(
  pack: LoadedPack
): Promise<CompileResult> {
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  if (entry === undefined) {
    throw new Error("The pack declares no contract entrypoint.");
  }
  const documents: Record<string, string> = {
    [entry.path]: await readFile(entry.absolutePath, "utf8")
  };
  return compileOpenApi({ documents, entrypoint: entry.path });
}

function readJsonFile(absolutePath: string): Json | undefined {
  const text = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(text) as Json;
  return isJsonObject(parsed) ? parsed : undefined;
}

/**
 * Read one JSON document from a pack by pack-root relative path. The
 * read stays inside the pack root, so it is safe to hand to callers
 * that resolve rubric schema references.
 */
export function readPackJson(
  pack: LoadedPack,
  relativePath: string
): Json | undefined {
  if (!isSafeRelativePath(relativePath)) {
    return undefined;
  }
  const absolute = path.resolve(pack.root, relativePath);
  if (!isWithin(pack.root, absolute)) {
    return undefined;
  }
  return readJsonFile(absolute);
}

/**
 * Load one rubric of a pack with the repository rubric schema.
 *
 * `schema` references inside the rubric resolve against the pack root,
 * matching the safe relative path convention of the pack rubrics. The
 * rubric document comes pre-parsed from the pack loader, which parses
 * `rubric` references as documents.
 */
export async function loadPackRubric(
  pack: LoadedPack,
  rubricPath: string,
  root = findRepoRoot()
): Promise<RubricLoadResult> {
  const reference = pack.references.find(
    (candidate) => candidate.role === "rubric" && candidate.path === rubricPath
  );
  if (reference === undefined || reference.document === null) {
    throw new Error(`The pack declares no rubric at ${rubricPath}.`);
  }
  const schema = readJsonFile(
    path.join(root, "schemas", "rubric.v1.schema.json")
  );
  const resolveSchema = (referencePath: string): Json | undefined =>
    readPackJson(pack, referencePath);
  return await loadRubric(reference.document, {
    ...(schema === undefined ? {} : { schema }),
    resolveSchema,
    documentUri: `file://${path.join(pack.root, rubricPath)}`
  });
}

/** The rubric of a pack, or a thrown error when it did not load. */
export function rubricOf(result: RubricLoadResult): Rubric {
  if (result.rubric === null) {
    const first = result.diagnostics[0];
    throw new Error(
      first === undefined
        ? "The rubric did not load."
        : `${first.code}: ${first.message}`
    );
  }
  return result.rubric;
}

/**
 * Build one `api.exchange` trace event for evaluator tests.
 *
 * The field set is copied from the `exchange` helper of
 * `packages/evaluator/src/evaluate.test.ts`. Two adjustments fit the
 * Steel pack: the authentication scheme is `apiKey`, and the content
 * types of request and response are configurable so a multipart upload
 * and an octet-stream download keep their real media types.
 */
export interface TraceExchangeInit {
  readonly event_id: string;
  readonly sequence: number;
  readonly operation_id: string;
  readonly method: string;
  readonly path_template: string;
  readonly status: number;
  readonly request_path?: string;
  readonly path_parameters?: Record<string, string>;
  readonly request_headers?: readonly TraceHeader[];
  readonly response_headers?: readonly TraceHeader[];
  readonly request_content_type?: string;
  readonly response_content_type?: string;
  readonly request_body?: TraceBody;
  readonly response_body?: TraceBody;
}

/** One trace header record with an unredacted single value. */
export function traceHeader(
  name: string,
  values: readonly string[]
): TraceHeader {
  return { name, values: [...values], redacted: false };
}

export function traceExchange(init: TraceExchangeInit): TraceEvent {
  const operationKey = `path:${init.method} ${init.path_template}`;
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: init.event_id,
    sequence: init.sequence,
    participant_ingress_sequence: init.sequence,
    observed_at: "2026-01-01T00:00:00.000Z",
    logical_time: null,
    batch_id: null,
    run_id: null,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: true,
      key: operationKey,
      uid: `op-${init.operation_id}`,
      operation_id: init.operation_id,
      method: init.method,
      path_template: init.path_template,
      support: "supported"
    },
    request: {
      received_at: "2026-01-01T00:00:00.000Z",
      method: init.method,
      path: init.request_path ?? init.path_template,
      query_string: "",
      query: [],
      path_parameters: init.path_parameters ?? {},
      headers:
        init.request_headers?.map((header) => ({
          name: header.name,
          values: [...header.values],
          redacted: header.redacted
        })) ?? [],
      credential_present: true,
      content_type: init.request_content_type ?? "application/json",
      body: init.request_body ?? { kind: "none" }
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
      completed_at: "2026-01-01T00:00:00.000Z",
      status: init.status,
      headers:
        init.response_headers?.map((header) => ({
          name: header.name,
          values: [...header.values],
          redacted: header.redacted
        })) ?? [],
      content_type: init.response_content_type ?? "application/json",
      body: init.response_body ?? { kind: "none" }
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

/**
 * Build a JSON trace body. Copied from `jsonBody` of
 * `packages/evaluator/src/evaluate.test.ts`.
 */
export function traceJsonBody(value: Json): TraceBody {
  return {
    kind: "json",
    size_bytes: JSON.stringify(value).length,
    value,
    truncated: false
  };
}

/**
 * Build a binary trace body. Copied from `binaryBody` of
 * `packages/evaluator/src/evaluate.test.ts`.
 */
export function traceBinaryBody(sha256: string): TraceBody {
  return { kind: "binary", size_bytes: 32, sha256, blob_ref: null };
}

/**
 * Build a multipart trace body with one file part, following the
 * `parts[].body` binary shape of specification section 25.3 and
 * `captureBody` of `packages/evidence/src/trace.ts`.
 */
export function traceMultipartBody(part: {
  readonly name: string;
  readonly filename?: string;
  readonly sha256: string;
}): TraceBody {
  return {
    kind: "multipart",
    size_bytes: 32,
    parts: [
      {
        name: part.name,
        filename: part.filename ?? part.name,
        headers: [],
        body: traceBinaryBody(part.sha256)
      }
    ]
  };
}
