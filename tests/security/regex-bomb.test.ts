/**
 * Security acceptance of the schema worker boundary (review fix F2).
 * A contract that carries a catastrophic regular expression must never
 * block the serving process: the hostile evaluation terminates at its
 * deadline, the outcome is an infrastructure response, the evidence
 * records it, and the controller keeps serving valid traffic.
 *
 * The attacks run against `oal serve` semantics through the same
 * serving path the command uses (startServe), with a short configured
 * worker deadline, and repeat through request validation, response
 * generation, and report evaluation.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  isJsonObject,
  type Json,
  type JsonObject
} from "../../packages/core/src/index.ts";
import {
  closeSchemaWorker,
  configureSchemaWorker
} from "../../packages/core/src/schema/worker-service.ts";
import { LIMIT_DEFAULTS } from "../../packages/config/src/limits.ts";
import {
  compileServeSource,
  serveRunIdentity,
  startServe,
  type ServeSession
} from "../../apps/cli/src/handlers/serve.ts";
import { loadRubric } from "../../packages/evaluator/src/rubric.ts";
import { evaluateRubric } from "../../packages/evaluator/src/evaluate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "adversarial",
  "regex-bomb.json"
);

/** Worker deadline the attacks run under. */
const SHORT_DEADLINE_MS = 400;
/** Wall-clock bound for one hostile request, deadline plus overhead. */
const HOSTILE_REQUEST_BOUND_MS = 5_000;
/** Wall-clock bound for an unrelated request during an attack. */
const UNRELATED_REQUEST_BOUND_MS = 3_000;
/** Repeated attacks the bounded-attack test fires. */
const REPEATS = 4;

/** A string whose rejection backtracks exponentially in `^(a+)+$`. */
const HOSTILE_SLUG = `${"a".repeat(33)}!`;
/** A string the request pattern accepts without backtracking. */
const VALID_SLUG = "aaaa";
/**
 * A string whose rejection backtracks exponentially in `^(a|aa)+b$`.
 * Forty characters push the search far past any configured deadline.
 */
const HOSTILE_EXAMPLE = `${"a".repeat(40)}c`;

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

afterAll(() => {
  closeSchemaWorker();
});

/** The default limit table with the short worker deadline. */
function shortDeadlineLimits(): LimitTableShape {
  return {
    ...LIMIT_DEFAULTS,
    schemaWorkerDeadlineMs: SHORT_DEADLINE_MS
  };
}

type LimitTableShape = typeof LIMIT_DEFAULTS;

/** One workspace the attacks can write their control tree into. */
async function newWorkspace(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Serve one contract source on loopback HTTP under the short deadline. */
async function serveContract(
  source: string,
  prefix: string,
  runId: string
): Promise<ServeSession> {
  const cwd = await newWorkspace(prefix);
  const compiled = await compileServeSource(source, cwd, 10 * 1024 * 1024);
  const runSeed = "a".repeat(64);
  return await startServe({
    contract: compiled.contract,
    capabilityReport: compiled.capabilityReport,
    pack: compiled.pack,
    host: "127.0.0.1",
    port: 0,
    runId,
    runSeed,
    controlDir: path.join(cwd, ".oal", "serve", runId),
    credentialsOut: null,
    identity: serveRunIdentity(compiled.contract, compiled.pack, runSeed),
    resumed: false,
    limits: shortDeadlineLimits()
  });
}

/** POST one slug value to the served contract. */
function postSlug(session: ServeSession, slug: string): Promise<Response> {
  return fetch(`${session.handle.baseUrl}/slugs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug })
  });
}

/** The parsed problem document of one response. */
async function problemOf(response: Response): Promise<JsonObject> {
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json"
  );
  const parsed = JSON.parse(await response.text()) as Json;
  expect(isJsonObject(parsed)).toBe(true);
  return parsed;
}

/** Read every trace event the serve recorded. */
async function traceEventsOf(session: ServeSession): Promise<JsonObject[]> {
  const text = await readFile(
    path.join(session.evidenceDir, "trace.jsonl"),
    "utf8"
  );
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

/** Whether one trace event records a schema worker timeout. */
function recordsWorkerTimeout(event: JsonObject): boolean {
  const response = event["response"];
  if (!isJsonObject(response) || response["status"] !== 504) {
    return false;
  }
  const validation = event["validation"];
  if (!isJsonObject(validation)) {
    return false;
  }
  const request = validation["request"];
  if (!isJsonObject(request)) {
    return false;
  }
  const violations = request["violations"];
  if (!Array.isArray(violations)) {
    return false;
  }
  return violations.some(
    (violation) =>
      isJsonObject(violation) &&
      violation["code"] === "OAL-SCHEMA-WORKER-TIMEOUT"
  );
}

describe("regex bomb defense through the serving path", () => {
  it("terminates a hostile request body within the deadline and records the outcome", async () => {
    const session = await serveContract(
      FIXTURE,
      "oal-regex-bomb-req-",
      "regex-bomb-request"
    );
    try {
      const startedAt = Date.now();
      const response = await postSlug(session, HOSTILE_SLUG);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(HOSTILE_REQUEST_BOUND_MS);
      expect(response.status).toBe(504);
      const problem = await problemOf(response);
      expect(problem["code"]).toBe("OAL-SCHEMA-WORKER-TIMEOUT");

      // The terminated worker is replaced, so a valid request after the
      // attack still passes request validation and generation.
      const valid = await postSlug(session, VALID_SLUG);
      expect(valid.status).toBe(202);
      expect(await valid.json()).toEqual({ echo: "ab" });

      // The timeout is part of the trial evidence, not just the wire.
      const timedOut = (await traceEventsOf(session)).filter(
        recordsWorkerTimeout
      );
      expect(timedOut).toHaveLength(1);
    } finally {
      await session.handle.close();
      session.store.close();
    }
  });

  it("keeps the controller responsive to an unrelated request during an attack", async () => {
    const session = await serveContract(
      FIXTURE,
      "oal-regex-bomb-live-",
      "regex-bomb-live"
    );
    try {
      const attack = postSlug(session, HOSTILE_SLUG).then(
        (response) => response.status,
        (): number => -1
      );
      const startedAt = Date.now();
      const unrelated = await fetch(`${session.handle.baseUrl}/slugs`);
      const elapsed = Date.now() - startedAt;
      expect(unrelated.status).toBe(405);
      expect(elapsed).toBeLessThan(UNRELATED_REQUEST_BOUND_MS);
      expect(await attack).toBe(504);
    } finally {
      await session.handle.close();
      session.store.close();
    }
  });

  it("survives repeated attacks and serves valid requests after worker cleanup", async () => {
    const first = await serveContract(
      FIXTURE,
      "oal-regex-bomb-rep-",
      "regex-bomb-repeat"
    );
    await first.handle.close();
    first.store.close();
    // Closing the process-wide boundary terminates every worker it
    // owns; a finished serve leaves no worker threads behind.
    closeSchemaWorker();

    const session = await serveContract(
      FIXTURE,
      "oal-regex-bomb-rep2-",
      "regex-bomb-repeat-2"
    );
    try {
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const startedAt = Date.now();
        const response = await postSlug(session, HOSTILE_SLUG);
        expect(Date.now() - startedAt).toBeLessThan(HOSTILE_REQUEST_BOUND_MS);
        expect(response.status).toBe(504);
        const problem = await problemOf(response);
        expect(problem["code"]).toBe("OAL-SCHEMA-WORKER-TIMEOUT");
      }
      const valid = await postSlug(session, VALID_SLUG);
      expect(valid.status).toBe(202);

      const timedOut = (await traceEventsOf(session)).filter(
        recordsWorkerTimeout
      );
      expect(timedOut).toHaveLength(REPEATS);
    } finally {
      await session.handle.close();
      session.store.close();
    }
  });

  it("terminates a hostile response schema during response generation", async () => {
    // The response example outranks pattern synthesis, so generation
    // returns the hostile bytes verbatim and response validation runs
    // the contract pattern over them inside the worker boundary.
    const contract = {
      openapi: "3.1.0",
      info: { title: "hostile response", version: "1.0.0" },
      paths: {
        "/slugs": {
          post: {
            operationId: "postSlug",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["slug"],
                    properties: {
                      slug: { type: "string", maxLength: 1024 }
                    }
                  }
                }
              }
            },
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["echo"],
                      properties: {
                        echo: {
                          type: "string",
                          pattern: "^(a|aa)+b$",
                          example: HOSTILE_EXAMPLE
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } as const;
    const cwd = await newWorkspace("oal-regex-bomb-resp-");
    const source = path.join(cwd, "contract.json");
    await writeFile(source, `${JSON.stringify(contract, null, 2)}\n`);

    const session = await serveContract(
      source,
      "oal-regex-bomb-resp2-",
      "regex-bomb-response"
    );
    try {
      const startedAt = Date.now();
      const response = await postSlug(session, VALID_SLUG);
      expect(Date.now() - startedAt).toBeLessThan(HOSTILE_REQUEST_BOUND_MS);
      expect(response.status).toBe(504);
      const problem = await problemOf(response);
      expect(problem["code"]).toBe("OAL-SCHEMA-WORKER-TIMEOUT");
    } finally {
      await session.handle.close();
      session.store.close();
    }
  });
});

describe("regex bomb defense through report evaluation", () => {
  it("turns a hostile report schema into an infrastructure error, not a task failure", async () => {
    configureSchemaWorker({ deadlineMs: SHORT_DEADLINE_MS });
    const schema: Json = {
      type: "object",
      required: ["notes"],
      properties: {
        notes: { type: "string", pattern: "^(a+)+$" }
      }
    };
    const loaded = await loadRubric(
      {
        rubric_version: 1,
        id: "regex-bomb-report",
        scoring: { method: "weighted_binary", pass_threshold: 1 },
        checks: [
          {
            id: "report_notes",
            kind: "json_schema",
            weight: 1,
            required: true,
            value: "report",
            schema: "result.schema.json"
          }
        ],
        signals: []
      },
      { resolveSchema: () => schema }
    );
    expect(loaded.rubric).not.toBeNull();
    const result = await evaluateRubric({
      rubric: loaded.rubric as NonNullable<typeof loaded.rubric>,
      runId: "run-regex-bomb",
      run: { run_id: "run-regex-bomb", mode: "record" },
      events: [],
      state: {},
      report: { notes: HOSTILE_SLUG },
      resolveSchema: () => schema
    });
    // The timeout is an infrastructure outcome: the check errors, the
    // evaluation never scores the participant, and the stable worker
    // code names the cause.
    expect(result.status).toBe("error");
    expect(result.status).not.toBe("failed");
    const check = result.checks[0];
    expect(check?.status).toBe("error");
    expect(check?.error?.code).toBe("OAL-SCHEMA-WORKER-TIMEOUT");
    expect(result.infrastructureErrors.map((error) => error.code)).toEqual([
      "OAL-SCHEMA-WORKER-TIMEOUT"
    ]);
  });
});
