/**
 * Shared fixtures of the runner integration suites (specification 36.1).
 *
 * Rules that hold for every helper in this module:
 *
 * - Deterministic. The clock is injected, the adapter follows a fixed
 *   script, and ports are pinned or ephemeral on loopback.
 * - Hermetic. Every listener binds 127.0.0.1. No external network, no
 *   paid provider, no repository mutation.
 * - Copy before edit. Packs that need a permissive schema are copied to
 *   a temporary directory first. The repository stays read-only.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalJsonSha256,
  isJsonObject,
  type Json,
  type JsonObject
} from "@oal/core";
import type { AgentAdapter } from "@oal/agent-adapter";
import {
  ArtifactStore,
  type LifecycleEvent,
  type TraceEvent
} from "@oal/evidence";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { loadPack, type LoadedPack } from "@oal/pack";
import { findRepoRoot } from "@oal/testkit";

import {
  assertPreflightClean,
  createLoopbackExposure,
  runPreflight,
  stageRecordsOf,
  type Clock,
  type ExposureFactory,
  type FrozenPlan
} from "./index.ts";

/** One fixed instant. Every timestamp in a trial derives from it. */
export const FIXED_NOW_MS = 1_700_000_000_000;

/** The clock every integration test injects. */
export const fixedClock = (): Clock => (): number => FIXED_NOW_MS;

/**
 * Session identifier the Steel scripts address. The value is a fixed UUID
 * so both the request path and the recorded path parameters stay stable.
 */
export const STEEL_SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** Every eval of the Steel Computer pack. */
export const STEEL_EVAL_IDS = [
  "checkpoint-recovery",
  "basic-lifecycle",
  "documentation-discovery"
] as const;

/** One eval of the Steel Computer pack. */
export type SteelEvalId = (typeof STEEL_EVAL_IDS)[number];

/** Final reports, one per Steel eval. Each matches its pack result schema. */
const STEEL_REPORTS: Readonly<Record<SteelEvalId, string>> = {
  "checkpoint-recovery": JSON.stringify({
    released_session: true,
    saved_state_create_supported: false,
    notes: "flow complete"
  }),
  "basic-lifecycle": JSON.stringify({
    session_created: true,
    session_released: true,
    final_status: "released"
  }),
  "documentation-discovery": JSON.stringify({
    session_created: true,
    operations_discovered: 41,
    contract_source: "openapi.json"
  })
};

/** One scripted request. Status is left unchecked because the loopback
 * gateway answers contract-unsupported calls with 501. */
interface ScriptedRequest {
  readonly path: string;
  readonly method: "GET" | "POST";
}

/**
 * The request script of one Steel eval. The participant follows the task
 * order: create, upload, download, release, then read back.
 */
function steelRequests(evalId: SteelEvalId): readonly ScriptedRequest[] {
  if (evalId === "basic-lifecycle") {
    return [
      { path: "/v1/sessions", method: "POST" },
      { path: `/v1/sessions/${STEEL_SESSION_ID}`, method: "GET" },
      { path: `/v1/sessions/${STEEL_SESSION_ID}/release`, method: "POST" },
      { path: `/v1/sessions/${STEEL_SESSION_ID}`, method: "GET" }
    ];
  }
  if (evalId === "documentation-discovery") {
    return [{ path: "/v1/sessions", method: "POST" }];
  }
  return [
    { path: "/v1/sessions", method: "POST" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files`, method: "POST" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files/brief.txt`, method: "GET" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files`, method: "POST" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files/draft.txt`, method: "GET" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files`, method: "POST" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/files/brief.txt`, method: "GET" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}/release`, method: "POST" },
    { path: `/v1/sessions/${STEEL_SESSION_ID}`, method: "GET" }
  ];
}

/** The scripted participant of one Steel eval. */
export function steelAdapter(evalId: SteelEvalId): MockAgentAdapter {
  return new MockAgentAdapter({
    model: "mock-model-1",
    requests: steelRequests(evalId).map((request) => ({
      path: request.path,
      method: request.method
    })),
    events: [{ channel: "stdout", kind: "turn.completed", text: "done" }],
    finalText: STEEL_REPORTS[evalId]
  });
}

/** Final report of the synthetic smoke pack. */
export const SMOKE_REPORT = JSON.stringify({
  pinged: true,
  status: "ok"
});

/** The scripted participant of the synthetic smoke pack. */
export function smokeAdapter(): MockAgentAdapter {
  return new MockAgentAdapter({
    model: "mock-model-1",
    requests: [{ path: "/v1/ping", method: "GET", expectStatus: 200 }],
    events: [{ channel: "stdout", kind: "turn.completed", text: "done" }],
    finalText: SMOKE_REPORT
  });
}

/** Repository root, found the way the testkit finds it. */
export function repoRoot(): string {
  return findRepoRoot();
}

/** Directory of the JSON schemas the runner validates against. */
export function schemaDirectory(): string {
  return path.join(repoRoot(), "schemas");
}

/** Directory of the shipped Steel Computer pack. */
export function steelPackRoot(): string {
  return path.join(repoRoot(), "packs", "steel-computer");
}

/**
 * A copy of the Steel pack whose checkpoint-recovery case schema is
 * permissive.
 *
 * The shipped schema rejects the shipped case inputs, so preflight blocks
 * the eval before any trial starts. The copy keeps `{"type": "object"}`,
 * which accepts every input, so the trial itself stays observable. The
 * unmodified pack keeps its pinned preflight failure in the trial suite.
 */
export async function writePermissiveSteelPack(
  scratchParent: string
): Promise<string> {
  const target = path.join(scratchParent, "steel-computer");
  await cp(steelPackRoot(), target, { recursive: true });
  await writeFile(
    path.join(target, "schemas", "checkpoint-recovery-case.schema.json"),
    `${JSON.stringify({ type: "object" }, null, 2)}\n`,
    "utf8"
  );
  return target;
}

const SMOKE_PACK_MANIFEST = `apiVersion: agentlab.dev/v1
kind: Pack

metadata:
  id: smoke-ping
  name: Smoke Ping
  version: 0.1.0
  description: >-
    Minimal contract-mode pack for runner integration checks.

requires:
  agentlab: ">=0.1.0 <0.2.0"
  backend_api: 1
  rubric_api: 1

contract:
  entrypoint: contract/openapi.json
  response_fixtures: []

server:
  host: 127.0.0.1
  port: 0
  request_body_limit_bytes: 5242880
  request_timeout_ms: 30000
  response_validation: error
  request_validation: error
  concurrency: serial

behavior:
  mode: contract
  completeness: exact
  fallback: none

security:
  enforce: false
  credentials: []
  base_url_environment: OAL_BASE_URL

redaction:
  header_names:
    - authorization
  key_patterns:
    - "(?i)api.?key"
    - "(?i)token"
    - "(?i)secret"
  capture_binary_blobs: false
  max_text_capture_bytes: 65536

participant:
  environment:
    inherit: none
    allow:
      - PATH
      - HOME
      - TMPDIR
      - OAL_BASE_URL

prompt_sets:
  - id: smoke
    purpose_disclosure: diagnostic
    instructions:
      source: prompts/smoke/instructions.md
      engine: literal
      delivery: file
      target: AGENTS.md
    launch:
      source: prompts/smoke/launch.txt
      engine: literal

evals:
  - id: smoke
    prompt_set: smoke
    task:
      source: tasks/smoke/task.md
      engine: literal
      target: TASK.md
    operation_scope:
      mode: all
    result:
      source: adapter_final
      schema: schemas/result.schema.json
      required: true
    rubric: evals/smoke/rubric.yaml
    scenario: baseline

scenarios:
  - id: baseline

extensions: {}
`;

const SMOKE_PACK_CONTRACT = `${JSON.stringify(
  {
    openapi: "3.1.0",
    info: { title: "Smoke Ping", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:0" }],
    paths: {
      "/v1/ping": {
        get: {
          operationId: "ping",
          summary: "Answer with one constant status value.",
          responses: {
            200: {
              description: "Constant status document.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["status"],
                    properties: { status: { type: "string", enum: ["ok"] } }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  null,
  2
)}\n`;

const SMOKE_PACK_RESULT_SCHEMA = `${JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://agentlab.dev/packs/smoke-ping/result.schema.json",
    title: "Smoke result",
    type: "object",
    additionalProperties: false,
    required: ["pinged", "status"],
    properties: {
      pinged: { type: "boolean" },
      status: { type: "string" }
    }
  },
  null,
  2
)}\n`;

const SMOKE_PACK_RUBRIC = `rubric_version: 1
id: smoke-ping
description: >-
  One ping call and one schema-valid report.
scoring:
  method: weighted_binary
  pass_threshold: 0.9
checks:
  - id: ping_called
    kind: event
    match: counted
    where: >-
      event.operation.operation_id == "ping" &&
      event.response.status == 200
    min_count: 1
    weight: 2
    required: true
    evidence_class: participant_observable
    description: The participant called the ping operation.
  - id: result_report
    kind: json_schema
    value: report
    schema: schemas/result.schema.json
    weight: 1
    required: true
    evidence_class: participant_observable
    description: The final report matches the pack result schema.
  - id: report_agrees
    kind: predicate
    expression: report.pinged == true
    weight: 1
    required: true
    evidence_class: participant_observable
    description: The report states that the ping happened.
signals:
  - id: first_call_is_ping
    kind: predicate
    expression: events[0].operation.operation_id == "ping"
    description: The participant opened with the ping call.
`;

/**
 * A synthetic pack with one operation the contract mode fully supports.
 *
 * The Steel rubrics cannot turn green through the loopback exposure: the
 * gateway cannot generate the Steel session responses, so their flow checks
 * fail. This pack gives the suites one eval that passes end to end.
 */
export async function writeSmokePack(scratchParent: string): Promise<string> {
  const root = path.join(scratchParent, "smoke-ping");
  const files: readonly { readonly relative: string; readonly text: string }[] =
    [
      { relative: "pack.yaml", text: SMOKE_PACK_MANIFEST },
      { relative: "contract/openapi.json", text: SMOKE_PACK_CONTRACT },
      {
        relative: "prompts/smoke/instructions.md",
        text: "Call the ping operation, then report the result.\n"
      },
      {
        relative: "prompts/smoke/launch.txt",
        text: "Complete the task in TASK.md.\n"
      },
      {
        relative: "tasks/smoke/task.md",
        text: "Call the ping operation once, then answer in JSON.\n"
      },
      { relative: "evals/smoke/rubric.yaml", text: SMOKE_PACK_RUBRIC },
      {
        relative: "schemas/result.schema.json",
        text: SMOKE_PACK_RESULT_SCHEMA
      }
    ];
  for (const file of files) {
    const target = path.join(root, file.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.text, "utf8");
  }
  return root;
}

/** A fresh harness: temporary store plus a clean frozen plan. */
export interface TrialHarness {
  readonly plan: FrozenPlan;
  readonly pack: LoadedPack;
  readonly store: ArtifactStore;
  /** Temporary directory that holds the store and any pack copy. */
  readonly scratchRoot: string;
  readonly clean: () => Promise<void>;
}

/** Options of {@link prepareTrial}. */
export interface PrepareTrialOptions {
  /** Prefix of the temporary directory. */
  readonly label: string;
  /** Pack directory the plan freezes. */
  readonly packDir: string;
  readonly evalId: string;
  readonly batchId: string;
  readonly adapter: AgentAdapter;
  readonly count?: number | undefined;
  readonly parallel?: number | undefined;
  /**
   * Limit overrides. The defaults cap a batch at one trial, so every
   * multi-trial harness raises `maxBatchTrials` and, when trials run in
   * parallel, `maxParallelTrials`.
   */
  readonly limitOverrides?: Partial<Record<string, number>> | undefined;
}

/** Create a store, freeze a plan, and load the same pack bytes. */
export async function prepareTrial(
  options: PrepareTrialOptions
): Promise<TrialHarness> {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), options.label));
  const store = new ArtifactStore(path.join(scratchRoot, ".oal"));
  const plan = assertPreflightClean(
    await runPreflight({
      packDir: options.packDir,
      evalId: options.evalId,
      batchId: options.batchId,
      store,
      adapter: options.adapter,
      paid: false,
      schemaDir: schemaDirectory(),
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
      ...(options.limitOverrides === undefined
        ? {}
        : { limitOverrides: options.limitOverrides })
    })
  );
  const pack = await loadPack(options.packDir);
  return {
    plan,
    pack,
    store,
    scratchRoot,
    clean: async () => {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  };
}

/** Evidence root of one trial. */
export function trialRootOf(batchId: string, runId: string): string {
  return `runs/${batchId}/trials/${runId}`;
}

/**
 * Artifact paths a completed trial manifests, evidence order. The list
 * mirrors the artifact set of section 22.4 and stays independent of the
 * manifest writer, so a digest change cannot hide a missing artifact.
 */
export const TRIAL_ARTIFACTS: readonly string[] = [
  "run.started.json",
  "lifecycle.jsonl",
  "trace.jsonl",
  "evaluation.json",
  "state.final.json",
  "state.summary.json",
  "resource-usage.json",
  "participant-final.txt",
  "participant-surface-verification.json",
  "session/events.redacted.jsonl",
  "artifact-manifest.json",
  "run.completed.json"
];

/** Parse non-empty lines of a JSONL document. */
export function parseJsonl(text: string): readonly Json[] {
  const values: Json[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    values.push(JSON.parse(line) as Json);
  }
  return values;
}

/** Read and parse one JSON artifact as an object. */
export async function readJsonObject(
  store: ArtifactStore,
  relativePath: string
): Promise<JsonObject> {
  const parsed = JSON.parse(await store.read(relativePath)) as Json;
  if (!isJsonObject(parsed)) {
    throw new Error(`Artifact is not a JSON object: ${relativePath}`);
  }
  return parsed;
}

/** Read the ordered stage list of one trial ledger. */
export async function readStageList(
  store: ArtifactStore,
  relativeRoot: string
): Promise<readonly string[]> {
  const events = parseJsonl(
    await store.read(`${relativeRoot}/lifecycle.jsonl`)
  ) as unknown as readonly LifecycleEvent[];
  return stageRecordsOf([...events]).map((record) => record.stage);
}

/** Read the logical trace of one trial. */
export async function readTraceEvents(
  store: ArtifactStore,
  relativeRoot: string
): Promise<readonly TraceEvent[]> {
  const values = parseJsonl(await store.read(`${relativeRoot}/trace.jsonl`));
  return values as unknown as readonly TraceEvent[];
}

/**
 * Pin the exposure port.
 *
 * Two trials that share a pinned port and an injected clock produce
 * byte-identical artifacts, except for the wall-clock fields listed with
 * {@link VOLATILE_ARTIFACTS}. The caller must run such trials one after
 * the other, because the port serves one listener at a time.
 */
export function pinPort(port: number): ExposureFactory {
  return (request) => createLoopbackExposure({ ...request, port });
}

/** One observed exposure treatment. */
export interface RecordedExposure {
  readonly runId: string;
  readonly port: number;
  readonly baseUrl: string;
}

/**
 * Wraps an exposure factory, by default the real loopback exposure, and
 * records what it served.
 *
 * The wrapper never changes behavior: it only pins a port when asked and
 * counts how many listeners were live at once, so a suite can prove the
 * batch runner honors its parallel bound.
 */
export class ExposureRecorder {
  private readonly pinnedPort: number | undefined;
  private readonly inner: ExposureFactory;
  private readonly opened: RecordedExposure[] = [];
  private live = 0;
  private peak = 0;

  constructor(
    options: {
      readonly pinPort?: number | undefined;
      readonly inner?: ExposureFactory | undefined;
    } = {}
  ) {
    this.pinnedPort = options.pinPort;
    this.inner = options.inner ?? createLoopbackExposure;
  }

  /** Factory to hand to the runner. */
  readonly factory: ExposureFactory = async (request) => {
    const handle = await this.inner({
      ...request,
      ...(this.pinnedPort === undefined ? {} : { port: this.pinnedPort })
    });
    this.live += 1;
    this.peak = Math.max(this.peak, this.live);
    const record: RecordedExposure = {
      runId: request.runId,
      port: portOf(handle.baseUrl),
      baseUrl: handle.baseUrl
    };
    this.opened.push(record);
    return {
      ...handle,
      close: async () => {
        await handle.close();
        this.live -= 1;
      }
    };
  };

  /** Every exposure opened so far, in open order. */
  exposures(): readonly RecordedExposure[] {
    return this.opened;
  }

  /** Ports of every exposure opened so far. */
  ports(): readonly number[] {
    return this.opened.map((record) => record.port);
  }

  /** Largest number of listeners live at once. */
  peakConcurrency(): number {
    return this.peak;
  }
}

/** Extract the TCP port of a loopback base URL. */
export function portOf(baseUrl: string): number {
  const port = new URL(baseUrl).port;
  return port === "" ? 80 : Number.parseInt(port, 10);
}

/**
 * Artifacts that never repeat byte for byte, with the field that makes
 * each one volatile:
 *
 * - `session/events.redacted.jsonl`: the mock adapter stamps
 *   `observed_at` from the wall clock. The injected clock does not reach
 *   the adapter session recorder.
 * - `resource-usage.json`: `duration_ms` is wall-clock elapsed time
 *   inside the adapter.
 * - `artifact-manifest.json` and `run.completed.json`: both pin the
 *   digest of `resource-usage.json`, so they inherit its volatility.
 */
export const VOLATILE_ARTIFACTS: readonly string[] = [
  "session/events.redacted.jsonl",
  "resource-usage.json",
  "artifact-manifest.json",
  "run.completed.json"
];

/**
 * Artifacts whose bytes depend only on the frozen plan, the injected
 * clock, and the scripted participant. They carry the logical record of
 * the run: trace, ledger, state, evaluation, and report.
 */
export const LOGICAL_ARTIFACTS: readonly string[] = [
  "trace.jsonl",
  "lifecycle.jsonl",
  "state.final.json",
  "state.summary.json",
  "evaluation.json",
  "participant-final.txt"
];

/** Placeholder that replaces every loopback base URL. */
const BASE_URL_PLACEHOLDER = "http://127.0.0.1:PORT";

/** Keys whose values come from the wall clock or from a digest of it. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "observed_at",
  "duration_ms",
  "artifact_manifest_sha256",
  "manifest_sha256"
]);

/** Whether a manifest entry path names a wall-clock artifact. */
function isVolatileEntry(entryPath: unknown): boolean {
  if (typeof entryPath !== "string") {
    return false;
  }
  return VOLATILE_ARTIFACTS.some(
    (artifact) => entryPath === artifact || entryPath.endsWith(`/${artifact}`)
  );
}

/**
 * Mask the fields that differ between identical seeded runs.
 *
 * The mask replaces loopback base URLs, the wall-clock fields
 * `observed_at` and `duration_ms`, the manifest digests that cover a
 * wall-clock artifact, and the size and digest of such an artifact in a
 * manifest entry. Everything else must match exactly.
 */
export function stripVolatile(value: Json, baseUrls: readonly string[]): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => stripVolatile(entry, baseUrls));
  }
  if (isJsonObject(value)) {
    const volatileEntry = isVolatileEntry(value["path"]);
    const masked: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) {
        masked[key] = `<${key}>`;
        continue;
      }
      if (volatileEntry && (key === "sha256" || key === "bytes")) {
        masked[key] = `<volatile-${key}>`;
        continue;
      }
      masked[key] = stripVolatile(entry, baseUrls);
    }
    return masked;
  }
  if (typeof value === "string") {
    return maskBaseUrls(value, baseUrls);
  }
  return value;
}

/** Replace every loopback base URL, then any leftover port, in text. */
export function maskBaseUrls(
  text: string,
  baseUrls: readonly string[]
): string {
  let masked = text;
  for (const baseUrl of baseUrls) {
    masked = masked.split(baseUrl).join(BASE_URL_PLACEHOLDER);
  }
  return masked.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:PORT");
}

/** Canonical digest of one artifact after the volatile mask. */
export async function normalizedArtifactDigest(
  store: ArtifactStore,
  relativePath: string,
  baseUrls: readonly string[]
): Promise<string> {
  const text = await store.read(relativePath);
  if (relativePath.endsWith(".jsonl")) {
    const events = parseJsonl(text).map((event) =>
      stripVolatile(event, baseUrls)
    );
    return canonicalJsonSha256(events as Json);
  }
  const parsed = JSON.parse(maskBaseUrls(text, baseUrls)) as Json;
  if (!isJsonObject(parsed)) {
    throw new Error(`Artifact is not a JSON object: ${relativePath}`);
  }
  return canonicalJsonSha256(stripVolatile(parsed, baseUrls));
}
