/**
 * In-process mock agent adapter (specification section 21).
 *
 * The adapter runs a fixed script instead of a model. Test suites use it to
 * drive the runner, the evidence pipeline, and the evaluator without paid
 * model calls. The same script always produces the same session events, the
 * same workspace files, and the same final output.
 *
 * The name follows the package name. It is not the contract-response
 * `MockAdapter` of section 38.3, which serves the gateway.
 */

import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  buildSpawnEnvironment,
  SessionEventRecorder,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEventSink,
  type AgentProbe,
  type AgentRunContext,
  type AgentRunResult,
  type PreparedAgent
} from "@oal/agent-adapter";

import {
  DEFAULT_MOCK_ADAPTER_ID,
  DEFAULT_MOCK_CAPABILITIES,
  MOCK_ADAPTER_VERSION,
  MOCK_HTTP_REQUEST_FAILED,
  MOCK_HTTP_STATUS_MISMATCH,
  MOCK_SCRIPT_INVALID,
  type MockAgentConfig,
  type MockAgentScript,
  type MockEventSpec,
  type MockRequestSpec
} from "./script.ts";
import { validateMockScript } from "./validate.ts";

/** Longest single wait slice, so abort and timeout stay responsive. */
const WAIT_SLICE_MS = 20;

/** Preparation state of one mock run. */
export interface MockPreparedAgent extends PreparedAgent {
  readonly context: AgentRunContext;
  readonly script: MockAgentScript;
  /** Absolute paths the script writes, in script order. */
  readonly filePaths: readonly string[];
}

/**
 * The mock agent. One instance serves one script. Create one instance per
 * trial when each trial needs its own script.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly id: string;
  private readonly script: MockAgentScript;
  private readonly declared: AgentCapabilities;
  private readonly model: string | null;

  constructor(config: MockAgentConfig = {}) {
    this.id = config.id ?? DEFAULT_MOCK_ADAPTER_ID;
    this.script = config;
    this.declared = config.capabilities ?? DEFAULT_MOCK_CAPABILITIES;
    this.model = config.model ?? null;
  }

  /** The probe always succeeds, because no executable is involved. */
  probe(): Promise<AgentProbe> {
    return Promise.resolve({
      status: "available",
      version: MOCK_ADAPTER_VERSION,
      capabilities: this.declared,
      launcherEnvironmentNames: [],
      environmentSeparation: "enforced",
      toolNetworkPolicy: "enforced",
      details: {
        adapter_id: this.id,
        events: String(this.script.events?.length ?? 0),
        requests: String(this.script.requests?.length ?? 0),
        files: String(this.script.files?.length ?? 0)
      }
    });
  }

  /**
   * Validate the script and resolve every path the run touches. Preparation
   * performs no writes and no network calls.
   */
  prepare(context: AgentRunContext): Promise<MockPreparedAgent> {
    const problems = validateMockScript(this.script);
    if (problems.length > 0) {
      throw new Error(
        `${MOCK_SCRIPT_INVALID}: ${this.id} rejected its script: ${problems.join("; ")}`
      );
    }
    const filePaths = (this.script.files ?? []).map((file) =>
      resolve(context.workspaceDir, file.path)
    );
    for (const path of filePaths) {
      assertInsideWorkspace(context.workspaceDir, path);
    }
    const spawn = buildSpawnEnvironment(context, []);
    return Promise.resolve({
      runId: context.runId,
      adapter: this.id,
      executable: `in-process:${this.id}`,
      argv: [],
      workingDirectory: context.workspaceDir,
      environment: spawn.env,
      launcherEnvironmentApplied: spawn.appliedLauncherNames,
      context,
      script: this.script,
      filePaths
    });
  }

  async run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const run = prepared as MockPreparedAgent;
    const context = run.context;
    const startedAt = Date.now();
    const recorder = new SessionEventRecorder({
      runId: context.runId,
      adapter: this.id,
      sink
    });
    const deadline = startedAt + context.timeoutMs;
    const outcome: { status?: AgentRunResult["status"]; errorCode?: string } =
      {};

    recorder.started({
      model: context.model ?? this.model,
      cliVersion: MOCK_ADAPTER_VERSION
    });
    recorder.adapterEvent("mock.script", {
      events: run.script.events?.length ?? 0,
      requests: run.script.requests?.length ?? 0,
      files: run.script.files?.length ?? 0,
      durationMs: run.script.durationMs ?? 0
    });

    for (const request of run.script.requests ?? []) {
      if (stopForControl(signal, deadline, outcome)) {
        break;
      }
      if ((request.delayMs ?? 0) > 0) {
        await wait(request.delayMs ?? 0, signal, deadline);
      }
      if (stopForControl(signal, deadline, outcome)) {
        break;
      }
      await performRequest(request, context, recorder, outcome);
    }

    for (const event of run.script.events ?? []) {
      if (stopForControl(signal, deadline, outcome)) {
        break;
      }
      if ((event.delayMs ?? 0) > 0) {
        await wait(event.delayMs ?? 0, signal, deadline);
      }
      if (stopForControl(signal, deadline, outcome)) {
        break;
      }
      emitScriptEvent(recorder, event);
    }

    if (outcome.status === undefined) {
      for (let index = 0; index < (run.script.files ?? []).length; index += 1) {
        const file = run.script.files?.[index];
        const path = run.filePaths[index];
        if (file === undefined || path === undefined) {
          continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, "utf8");
        recorder.adapterEvent("file.written", {
          path: relative(context.workspaceDir, path),
          bytes: Buffer.byteLength(file.content, "utf8")
        });
      }
    }

    if (run.script.durationMs !== undefined && outcome.status === undefined) {
      await wait(run.script.durationMs, signal, deadline);
      stopForControl(signal, deadline, outcome);
    }

    const forcedStatus = outcome.status ?? run.script.status ?? "completed";
    const exitCode = resolveExitCode(outcome.status, run.script.exitCode);
    const finalText =
      outcome.status === undefined ? (run.script.finalText ?? null) : null;
    const finalJson = parseStructuredOutput(finalText, context);

    recorder.exited({
      exitCode,
      signal: null,
      graceful: outcome.status === undefined
    });

    return {
      status: forcedStatus,
      exitCode,
      signal: null,
      durationMs: Date.now() - startedAt,
      ...(finalText === null ? {} : { finalText }),
      ...(finalJson === undefined ? {} : { finalJson }),
      ...(run.script.usage === undefined
        ? {}
        : { usage: { ...run.script.usage } }),
      ...(outcome.errorCode === undefined && forcedStatus === "completed"
        ? {}
        : { errorCode: outcome.errorCode ?? "MOCK_SCRIPT_FAILED" })
    };
  }

  /** Remove the files the script wrote. Workspace content stays otherwise. */
  async cleanup(prepared: PreparedAgent): Promise<void> {
    const run = prepared as MockPreparedAgent;
    for (const path of run.filePaths) {
      await rm(path, { force: true });
    }
  }
}

/** Emit one scripted line on its declared channel. */
function emitScriptEvent(
  recorder: SessionEventRecorder,
  event: MockEventSpec
): void {
  if (event.channel === "adapter") {
    recorder.adapterEvent(event.kind ?? "mock.note", { text: event.text });
    return;
  }
  recorder.text(event.channel, event.text, event.kind);
}

/**
 * Run one scripted request against the exposure base URL. Only the path, the
 * method, and the response status are recorded. Header values never reach an
 * event, so a credential cannot leak through the transcript.
 */
async function performRequest(
  request: MockRequestSpec,
  context: AgentRunContext,
  recorder: SessionEventRecorder,
  outcome: { status?: AgentRunResult["status"]; errorCode?: string }
): Promise<void> {
  const baseUrl = context.exposure.baseUrl;
  if (baseUrl === undefined) {
    outcome.status = "failed";
    outcome.errorCode = MOCK_HTTP_REQUEST_FAILED;
    recorder.adapterEvent("http.request", {
      path: request.path,
      method: request.method ?? "GET",
      error: "exposure base URL is not configured"
    });
    return;
  }
  const headers: Record<string, string> = {};
  if (request.credentialName !== undefined) {
    const value = context.toolEnvironment[request.credentialName];
    if (value !== undefined) {
      headers.Authorization = `Bearer ${value}`;
    }
  }
  const body =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const method = request.method ?? "GET";
  recorder.adapterEvent("http.request", {
    path: request.path,
    method,
    credential: request.credentialName ?? "none"
  });
  let status: number;
  try {
    const response = await fetch(joinUrl(baseUrl, request.path), {
      method,
      headers,
      ...(body === undefined ? {} : { body })
    });
    status = response.status;
    await response.arrayBuffer().then(
      () => undefined,
      () => undefined
    );
  } catch (error) {
    outcome.status = "failed";
    outcome.errorCode = MOCK_HTTP_REQUEST_FAILED;
    recorder.adapterEvent("http.response", {
      path: request.path,
      error: error instanceof Error ? error.message : "fetch failed"
    });
    return;
  }
  recorder.adapterEvent("http.response", {
    path: request.path,
    method,
    status
  });
  if (request.expectStatus !== undefined && request.expectStatus !== status) {
    outcome.status = "failed";
    outcome.errorCode = MOCK_HTTP_STATUS_MISMATCH;
  }
}

/** Append a slash-leading path to a base URL without dropping its prefix. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Stop the script when the run was aborted or passed its deadline. Returns
 * true when the loop must break, and records the terminal status once.
 */
function stopForControl(
  signal: AbortSignal,
  deadline: number,
  outcome: { status?: AgentRunResult["status"]; errorCode?: string }
): boolean {
  if (outcome.status !== undefined) {
    return true;
  }
  if (signal.aborted) {
    outcome.status = "cancelled";
    outcome.errorCode = "AGENT_CANCELLED";
    return true;
  }
  if (Date.now() >= deadline) {
    outcome.status = "timed_out";
    return true;
  }
  return false;
}

/**
 * Wait in short slices, so abort and timeout stay responsive. The wait ends
 * early when the signal fires or the deadline passes.
 */
async function wait(
  totalMs: number,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !signal.aborted && Date.now() < deadline) {
    const slice = Math.min(WAIT_SLICE_MS, remaining);
    await sleep(slice);
    remaining -= slice;
  }
}

/** Exit code the run reports for one terminal status. */
function resolveExitCode(
  status: AgentRunResult["status"] | undefined,
  scripted: number | undefined
): number | null {
  if (status === undefined) {
    return scripted ?? 0;
  }
  if (status === "timed_out" || status === "cancelled") {
    return null;
  }
  return scripted ?? 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Parse the structured final output when the run declares a schema. */
function parseStructuredOutput(
  finalText: string | null,
  context: AgentRunContext
): unknown {
  if (finalText === null || context.resultSchemaPath === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(finalText) as unknown;
  } catch {
    return undefined;
  }
}

/** Refuse a resolved path outside the workspace root. */
function assertInsideWorkspace(workspaceDir: string, path: string): void {
  const rel = relative(resolve(workspaceDir), path);
  if (rel === "" || rel.startsWith("..")) {
    throw new Error(
      `${MOCK_SCRIPT_INVALID}: resolved path escapes the workspace: ${path}`
    );
  }
}
