import { afterEach, describe, expect, it } from "vitest";
import type { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectingSink,
  REDACTED_MARKER,
  validateAgentSessionEvent,
  type AgentCapabilities,
  type AgentRunContext,
  type AgentRunResult,
  type AgentSessionEvent,
  type AgentStreamPayload
} from "@oal/agent-adapter";

import { MockAgentAdapter, type MockPreparedAgent } from "./adapter.ts";
import type { MockAgentConfig } from "./script.ts";

const schemaPath = fileURLToPath(
  new URL("../../../schemas/agent-event.v1.schema.json", import.meta.url)
);

const MOCK_KEY = "mock-key-canary-0002";
/** Values shaped like the ones the runner mints into the tool environment. */
const RUN_BEARER = "oal_5f3a91c07d2e4b68a1c9e0b2";
const RUN_API_KEY = "oal_7b2d94f16e8a40c3b5d7f2a1";
const RUN_BASIC_USERNAME = "oal_1a2b3c4d5e6f7a8b9c0d1e2f";
const RUN_BASIC_PASSWORD = "oal_9c4e27d80f1a5b6c3d4e5f60";
const NO_SIGNAL = (): AbortSignal => new AbortController().signal;

const CAPABILITIES: AgentCapabilities = {
  nativeSystemPrompt: true,
  nativeOutputSchema: false,
  mcp: false,
  machineReadableTranscript: true,
  usageReporting: true,
  separateToolEnvironment: true,
  enforceableToolNetworkPolicy: true,
  sandboxModes: []
};

interface Harness {
  adapter: MockAgentAdapter;
  context: AgentRunContext;
  root: string;
}

async function harness(
  config: MockAgentConfig = {},
  contextOverride: Partial<AgentRunContext> = {},
  exposureBaseUrl = "http://127.0.0.1:8099/api"
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "oal-mock-agent-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });
  const context: AgentRunContext = {
    runId: "run_000001",
    workspaceDir: workspace,
    syntheticHomeDir: home,
    temporaryDir: temporary,
    prompts: {
      instructions: "Follow the contract.",
      task: "Create one computer.",
      launch: "launch text payload"
    },
    exposure: {
      mode: "raw-http",
      baseUrl: exposureBaseUrl,
      credentialNames: ["X_API_KEY"]
    },
    launcherEnvironment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LAUNCHER_KEY: "sk-launcher-topsecret-0001"
    },
    toolEnvironment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: temporary,
      X_API_KEY: MOCK_KEY
    },
    toolExecutionPolicy: {
      inheritEnvironment: "none",
      allowedEnvironmentNames: ["PATH", "HOME", "TMPDIR", "X_API_KEY"],
      network: "mock-only",
      filesystem: "workspace-only"
    },
    timeoutMs: 5000,
    ...contextOverride
  };
  return { adapter: new MockAgentAdapter(config), context, root };
}

async function runScript(
  state: Harness,
  signal: AbortSignal = NO_SIGNAL()
): Promise<{
  prepared: MockPreparedAgent;
  result: AgentRunResult;
  events: AgentSessionEvent[];
}> {
  const collector = collectingSink();
  const prepared: MockPreparedAgent = await state.adapter.prepare(
    state.context
  );
  const result = await state.adapter.run(prepared, collector.sink, signal);
  return { prepared, result, events: collector.events };
}

/** Captured request received by the local exposure server. */
interface CapturedRequest {
  method: string;
  url: string;
  authorization: string;
  body: string;
  headers: IncomingHttpHeaders;
}

/** One scripted reply of the sequence exposure server. */
interface SequencedReply {
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

async function startExposureServer(
  status: number,
  body: string
): Promise<{ server: Server; requests: CapturedRequest[]; baseUrl: string }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((message, response) => {
    let bodyText = "";
    message.on("data", (chunk: Buffer) => {
      bodyText += chunk.toString("utf8");
    });
    message.on("end", () => {
      requests.push({
        method: message.method ?? "GET",
        url: message.url ?? "/",
        authorization: message.headers.authorization ?? "none",
        body: bodyText,
        headers: message.headers
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/api`
  };
}

/**
 * Serve one reply per request, in order. Past the last reply the server
 * answers 500, so any extra request fails its declared expected status.
 */
async function startSequenceServer(
  replies: readonly SequencedReply[]
): Promise<{ server: Server; requests: CapturedRequest[]; baseUrl: string }> {
  const requests: CapturedRequest[] = [];
  let next = 0;
  const server = createServer((message, response) => {
    let bodyText = "";
    message.on("data", (chunk: Buffer) => {
      bodyText += chunk.toString("utf8");
    });
    message.on("end", () => {
      requests.push({
        method: message.method ?? "GET",
        url: message.url ?? "/",
        authorization: message.headers.authorization ?? "none",
        body: bodyText,
        headers: message.headers
      });
      const reply = replies[next] ?? {
        status: 500,
        body: '{"error":"no reply left"}'
      };
      next += 1;
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.headers ?? {})
      });
      response.end(reply.body);
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/api`
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    server.close(() => {
      resolvePromise();
    });
  });
}

const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      await closeServer(server);
    }
  }
});

describe("MockAgentAdapter.probe", () => {
  it("always succeeds with the declared capabilities", async () => {
    const state = await harness({
      capabilities: CAPABILITIES,
      model: "mock-model"
    });
    try {
      const probe = await state.adapter.probe();
      expect(probe.status).toBe("available");
      expect(probe.version).toBe("oal-mock-agent 1.0.0 (in-process, no model)");
      expect(probe.capabilities).toEqual(CAPABILITIES);
      expect(probe.environmentSeparation).toBe("enforced");
      expect(probe.launcherEnvironmentNames).toEqual([]);
      expect(probe.details?.requests).toBe("0");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});

describe("MockAgentAdapter.run", () => {
  it("emits the scripted session events in order", async () => {
    const state = await harness({
      events: [
        { channel: "jsonrpc", text: "thread.started", kind: "thread.started" },
        { channel: "stdout", text: "creating computer" },
        { channel: "adapter", text: "tool call prepared", kind: "mock.note" }
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      finalText: '{"computer_id":"c_1"}'
    });
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('{"computer_id":"c_1"}');
      expect(result.usage).toEqual({
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8
      });
      expect(events.map((event) => event.type)).toEqual([
        "agent.started",
        "agent.session_event",
        "agent.session_event",
        "agent.session_event",
        "agent.session_event",
        "agent.session_event",
        "agent.exited"
      ]);
      expect(previews(events, "stdout")).toEqual(["creating computer"]);
      expect(kindsOn(events, "jsonrpc")).toEqual(["thread.started"]);
      // A script that reaches its final message finished its turn, so
      // the runner can count the report agreement denominator.
      expect(kindsOn(events, "adapter")).toEqual([
        "mock.script",
        "mock.note",
        "turn.completed"
      ]);
      expect(events.at(-1)?.type).toBe("agent.exited");
      const note = events.find(
        (event) => streamPayload(event)?.kind === "mock.note"
      );
      expect(streamPayload(note)?.redacted).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("writes the declared workspace files and removes them on cleanup", async () => {
    const state = await harness({
      files: [
        { path: "report.txt", content: "kept" },
        { path: "nested/artifacts/notes.json", content: '{"ok":true}' }
      ]
    });
    try {
      const { prepared, result } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(
        await readFile(join(state.context.workspaceDir, "report.txt"), "utf8")
      ).toBe("kept");
      expect(
        await readFile(
          join(state.context.workspaceDir, "nested/artifacts/notes.json"),
          "utf8"
        )
      ).toBe('{"ok":true}');
      await state.adapter.cleanup(prepared);
      expect(await exists(join(state.context.workspaceDir, "report.txt"))).toBe(
        false
      );
      expect(
        await exists(
          join(state.context.workspaceDir, "nested/artifacts/notes.json")
        )
      ).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("calls the exposure base URL and records no credential value", async () => {
    const exposure = await startExposureServer(201, '{"id":"c_1"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/computers",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { name: "worker" },
            expectStatus: 201
          }
        ]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(exposure.requests.length).toBe(1);
      expect(exposure.requests[0]?.method).toBe("POST");
      expect(exposure.requests[0]?.url).toBe("/api/computers");
      expect(exposure.requests[0]?.authorization).toBe(`Bearer ${MOCK_KEY}`);
      expect(JSON.parse(exposure.requests[0]?.body ?? "{}")).toEqual({
        name: "worker"
      });
      const recorded = JSON.stringify(events);
      expect(recorded).toContain("X_API_KEY");
      expect(recorded).not.toContain(MOCK_KEY);
      expect(kindsOn(events, "adapter")).toEqual([
        "mock.script",
        "http.request",
        "http.response"
      ]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails the run when the exposure status differs", async () => {
    const exposure = await startExposureServer(500, '{"error":"boom"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [{ path: "/computers", expectStatus: 201 }],
        events: [{ channel: "stdout", text: "after the request" }]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MOCK_HTTP_STATUS_MISMATCH");
      expect(previews(events, "stdout")).toEqual([]);
      // A script cut short by a failed request never completes a turn.
      expect(kindsOn(events, "adapter")).toEqual([
        "mock.script",
        "http.request",
        "http.response"
      ]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails the run when no exposure base URL is configured", async () => {
    const state = await harness(
      { requests: [{ path: "/computers" }] },
      { exposure: { mode: "direct-tools" } }
    );
    try {
      const { result } = await runScript(state);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MOCK_HTTP_REQUEST_FAILED");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("cancels through the abort signal", async () => {
    const state = await harness({
      events: [
        { channel: "stdout", text: "first" },
        { channel: "stdout", text: "second", delayMs: 400 },
        { channel: "stdout", text: "third" }
      ],
      finalText: "never reached"
    });
    try {
      const collector = collectingSink();
      const prepared = await state.adapter.prepare(state.context);
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 100);
      const result = await state.adapter.run(
        prepared,
        collector.sink,
        controller.signal
      );
      expect(result.status).toBe("cancelled");
      expect(result.errorCode).toBe("AGENT_CANCELLED");
      expect(result.exitCode).toBeNull();
      expect(result.finalText).toBeUndefined();
      expect(previews(collector.events, "stdout")).toEqual(["first"]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("stops at the run deadline", async () => {
    const state = await harness(
      {
        events: [
          { channel: "stdout", text: "first" },
          { channel: "stdout", text: "second", delayMs: 5000 }
        ]
      },
      { timeoutMs: 250 }
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();
      expect(previews(events, "stdout")).toEqual(["first"]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("reports a scripted provider failure", async () => {
    const state = await harness({
      status: "provider_failed",
      exitCode: 78,
      events: [{ channel: "stderr", text: "provider quota exceeded" }]
    });
    try {
      const { result } = await runScript(state);
      expect(result.status).toBe("provider_failed");
      expect(result.exitCode).toBe(78);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("parses the structured final output", async () => {
    const state = await harness(
      { finalText: '{"computer_id":"c_7"}' },
      { resultSchemaPath: "/run/tmp/result.schema.json" }
    );
    try {
      const { result } = await runScript(state);
      expect(result.finalJson).toEqual({ computer_id: "c_7" });
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("redacts credentials the script echoes without a sink redactor", async () => {
    const state = await harness(
      {
        events: [
          { channel: "stdout", text: `Authorization: Bearer ${RUN_BEARER}` },
          {
            channel: "stderr",
            text: `x-api-key ${RUN_API_KEY} basic password ${RUN_BASIC_PASSWORD}`
          },
          { channel: "adapter", text: `note token ${RUN_BEARER}` }
        ]
      },
      {
        exposure: {
          mode: "raw-http",
          baseUrl: "http://127.0.0.1:8099/api",
          credentialNames: [
            "OAL_AUTH_BEARER",
            "OAL_AUTH_X_API_KEY",
            "OAL_AUTH_BASIC_PASSWORD"
          ]
        },
        toolEnvironment: {
          OAL_AUTH_BEARER: RUN_BEARER,
          OAL_AUTH_X_API_KEY: RUN_API_KEY,
          OAL_AUTH_BASIC_PASSWORD: RUN_BASIC_PASSWORD
        }
      }
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(previews(events, "stdout")).toEqual([
        `Authorization: Bearer ${REDACTED_MARKER}`
      ]);
      expect(previews(events, "stderr")).toEqual([
        `x-api-key ${REDACTED_MARKER} basic password ${REDACTED_MARKER}`
      ]);
      const note = events.find(
        (event) =>
          "channel" in event.payload &&
          event.payload.channel === "adapter" &&
          event.payload.kind === "mock.note"
      );
      expect(note?.extensions.text).toBe(`note token ${REDACTED_MARKER}`);
      expect(streamPayload(note)?.redacted).toBe(true);
      const recorded = JSON.stringify(events);
      expect(recorded).not.toContain(RUN_BEARER);
      expect(recorded).not.toContain(RUN_API_KEY);
      expect(recorded).not.toContain(RUN_BASIC_PASSWORD);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("redacts the basic username written under a scheme alias", async () => {
    const state = await harness(
      {
        events: [
          { channel: "stdout", text: `login user=${RUN_BASIC_USERNAME}` },
          {
            channel: "adapter",
            text: `adapter login user=${RUN_BASIC_USERNAME}`,
            kind: "mock.note"
          }
        ]
      },
      {
        exposure: {
          mode: "raw-http",
          baseUrl: "http://127.0.0.1:8099/api",
          credentialNames: [
            "OAL_AUTH_BEARER",
            "OAL_AUTH_INTERNAL_AUTH",
            "OAL_AUTH_BASIC_USERNAME",
            "OAL_AUTH_BASIC_PASSWORD"
          ]
        },
        toolEnvironment: {
          OAL_AUTH_BEARER: RUN_BEARER,
          OAL_AUTH_INTERNAL_AUTH_USERNAME: RUN_BASIC_USERNAME,
          OAL_AUTH_INTERNAL_AUTH_PASSWORD: RUN_BASIC_PASSWORD
        }
      }
    );
    try {
      const { events } = await runScript(state);
      expect(previews(events, "stdout")).toEqual([
        `login user=${REDACTED_MARKER}`
      ]);
      const note = events.find(
        (event) => streamPayload(event)?.kind === "mock.note"
      );
      expect(note?.extensions.text).toBe(
        `adapter login user=${REDACTED_MARKER}`
      );
      const recorded = JSON.stringify(events);
      expect(recorded).not.toContain(RUN_BASIC_USERNAME);
      expect(recorded).not.toContain(RUN_BASIC_PASSWORD);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects a script that escapes the workspace", async () => {
    const state = await harness({
      files: [{ path: "../escape.txt", content: "no" }]
    });
    try {
      expect(() => {
        void state.adapter.prepare(state.context);
      }).toThrowError(/must stay inside the workspace/);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("produces the same event sequence for the same script", async () => {
    const config: MockAgentConfig = {
      events: [
        { channel: "stdout", text: "step one" },
        { channel: "jsonrpc", text: "turn.completed", kind: "turn.completed" }
      ],
      files: [{ path: "out.txt", content: "same" }],
      finalText: "done"
    };
    const first = await harness(config);
    const second = await harness(config);
    try {
      const firstRun = await runScript(first);
      const secondRun = await runScript(second);
      expect(shapeOf(firstRun.events)).toEqual(shapeOf(secondRun.events));
      expect(firstRun.result.finalText).toBe(secondRun.result.finalText);
      expect(
        await readFile(join(first.context.workspaceDir, "out.txt"), "utf8")
      ).toBe(
        await readFile(join(second.context.workspaceDir, "out.txt"), "utf8")
      );
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });

  it("emits session events that satisfy the published schema", async () => {
    const state = await harness({
      events: [{ channel: "stdout", text: "visible text" }],
      requests: [
        { path: "/ping", credentialName: "X_API_KEY", expectStatus: 204 }
      ],
      files: [{ path: "out.txt", content: "kept" }]
    });
    const exposure = await startExposureServer(204, "");
    openServers.push(exposure.server);
    try {
      const collector = collectingSink();
      const prepared = await state.adapter.prepare({
        ...state.context,
        exposure: { ...state.context.exposure, baseUrl: exposure.baseUrl }
      });
      await state.adapter.run(prepared, collector.sink, NO_SIGNAL());
      const schema: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
      expect(collector.events.length).toBeGreaterThan(0);
      for (const event of collector.events) {
        expect(validateAgentSessionEvent(event, schema)).toEqual([]);
      }
      expect(JSON.stringify(collector.events)).not.toContain(MOCK_KEY);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});

describe("MockAgentAdapter.run with capture and templates", () => {
  it("carries captured ids into later paths, headers, and the report", async () => {
    const exposure = await startSequenceServer([
      { status: 201, body: '{"id":"clip_7"}', headers: { etag: 'W/"7"' } },
      { status: 201, body: '{"id":"clip_8"}' },
      {
        status: 200,
        body: "# markdown",
        headers: { "content-type": "text/markdown" }
      },
      { status: 200, body: '{"text":"clip text"}' },
      { status: 204, body: "" }
    ]);
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/v1/clips",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { url: "https://example.test/a" },
            expectStatus: 201,
            capture: { body: { clipA: "id" }, headers: { clipEtag: "etag" } }
          },
          {
            path: "/v1/clips",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { url: "https://example.test/b" },
            expectStatus: 201,
            capture: { body: { clipB: "id" } }
          },
          {
            path: "/v1/clips/{{clipA}}/render?neighbor={{clipB}}",
            credentialName: "X_API_KEY",
            headers: { accept: "text/markdown", "if-match": "{{clipEtag}}" },
            expectStatus: 200
          },
          {
            path: "/v1/clips/{{clipA}}/extract",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { after: "{{clipB}}" },
            expectStatus: 200
          },
          {
            path: "/v1/clips/{{clipB}}",
            method: "DELETE",
            credentialName: "X_API_KEY",
            expectStatus: 204
          }
        ],
        finalReport: {
          first_clip: "{{clipA}}",
          second_clip: "{{clipB}}",
          deleted: true
        }
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(result.finalText).toBe(
        '{"first_clip":"clip_7","second_clip":"clip_8","deleted":true}'
      );
      expect(exposure.requests.length).toBe(5);
      expect(exposure.requests[0]?.url).toBe("/api/v1/clips");
      expect(exposure.requests[2]?.url).toBe(
        "/api/v1/clips/clip_7/render?neighbor=clip_8"
      );
      expect(exposure.requests[2]?.headers.accept).toBe("text/markdown");
      expect(exposure.requests[2]?.headers["if-match"]).toBe('W/"7"');
      expect(exposure.requests[2]?.authorization).toBe(`Bearer ${MOCK_KEY}`);
      expect(JSON.parse(exposure.requests[3]?.body ?? "{}")).toEqual({
        after: "clip_8"
      });
      expect(exposure.requests[4]?.url).toBe("/api/v1/clips/clip_8");
      expect(kindsOn(events, "adapter")).toEqual([
        "mock.script",
        "http.request",
        "http.response",
        "http.capture",
        "http.request",
        "http.response",
        "http.capture",
        "http.request",
        "http.response",
        "http.request",
        "http.response",
        "http.request",
        "http.response",
        "turn.completed"
      ]);
      expect(JSON.stringify(events)).not.toContain(MOCK_KEY);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("sends script headers and never drops the injected credential", async () => {
    const exposure = await startExposureServer(200, '{"ok":true}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/v1/clips",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { url: "https://example.test/a" },
            headers: {
              accept: "image/svg+xml",
              "content-type": "application/merge-patch+json",
              "x-trace": "t-1",
              authorization: "Bearer script-value"
            },
            expectStatus: 200
          }
        ]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result } = await runScript(state);
      expect(result.status).toBe("completed");
      const headers = exposure.requests[0]?.headers;
      expect(headers?.accept).toBe("image/svg+xml");
      expect(headers?.["content-type"]).toBe("application/merge-patch+json");
      expect(headers?.["x-trace"]).toBe("t-1");
      expect(exposure.requests[0]?.authorization).toBe(`Bearer ${MOCK_KEY}`);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("records the expected status and a message when the status differs", async () => {
    const exposure = await startExposureServer(404, '{"error":"missing"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          { path: "/v1/clips/clip_9", method: "DELETE", expectStatus: 204 }
        ],
        events: [{ channel: "stdout", text: "never emitted" }]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MOCK_HTTP_STATUS_MISMATCH");
      const note = events.find(
        (event) => streamPayload(event)?.kind === "http.response"
      );
      expect(note?.extensions.expectedStatus).toBe(204);
      expect(note?.extensions.error).toBe(
        "expected status 204 but received 404"
      );
      expect(previews(events, "stdout")).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails the participant when a declared body path is missing", async () => {
    const exposure = await startExposureServer(200, '{"other":"value"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/v1/clips",
            method: "POST",
            expectStatus: 200,
            capture: { body: { clipId: "id" } }
          },
          { path: "/v1/clips/{{clipId}}", method: "DELETE", expectStatus: 204 }
        ]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MOCK_CAPTURE_FAILED");
      expect(exposure.requests.length).toBe(1);
      const note = events.find(
        (event) => streamPayload(event)?.kind === "http.capture"
      );
      expect(note?.extensions.error).toBe(
        "cannot capture a declared value: the response body has no value at id"
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails the participant when a declared header is absent", async () => {
    const exposure = await startExposureServer(200, '{"id":"clip_7"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/v1/clips",
            method: "POST",
            expectStatus: 200,
            capture: { headers: { clipEtag: "etag" } }
          }
        ]
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MOCK_CAPTURE_FAILED");
      const note = events.find(
        (event) => streamPayload(event)?.kind === "http.capture"
      );
      expect(note?.extensions.error).toBe(
        "cannot capture a declared value: the response has no etag header"
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("parses the emitted final report as structured output", async () => {
    const exposure = await startSequenceServer([
      { status: 201, body: '{"id":"clip_8"}' }
    ]);
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/v1/clips",
            method: "POST",
            expectStatus: 201,
            capture: { body: { clipId: "id" } }
          }
        ],
        finalReport: { clip_id: "{{clipId}}", created: true }
      },
      { resultSchemaPath: "/run/tmp/result.schema.json" },
      exposure.baseUrl
    );
    try {
      const { result } = await runScript(state);
      expect(result.finalText).toBe('{"clip_id":"clip_8","created":true}');
      expect(result.finalJson).toEqual({ clip_id: "clip_8", created: true });
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects at load time a variable nothing captures", async () => {
    const state = await harness({
      requests: [
        {
          path: "/v1/clips",
          method: "POST",
          capture: { body: { clipId: "id" } }
        },
        { path: "/v1/clips/{{unknown}}/render" }
      ]
    });
    try {
      expect(() => {
        void state.adapter.prepare(state.context);
      }).toThrowError(
        /requests\[1\].path uses \{\{unknown\}\} but no earlier request captures it/
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("keeps an existing-shape script running unchanged", async () => {
    const exposure = await startExposureServer(201, '{"id":"c_1"}');
    openServers.push(exposure.server);
    const state = await harness(
      {
        requests: [
          {
            path: "/computers",
            method: "POST",
            credentialName: "X_API_KEY",
            body: { name: "worker" },
            expectStatus: 201
          }
        ],
        finalText: '{"computer_id":"c_1"}'
      },
      {},
      exposure.baseUrl
    );
    try {
      const { result, events } = await runScript(state);
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('{"computer_id":"c_1"}');
      expect(kindsOn(events, "adapter")).toEqual([
        "mock.script",
        "http.request",
        "http.response",
        "turn.completed"
      ]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false
  );
}

/** Previews recorded on one stream channel. */
function previews(
  events: readonly AgentSessionEvent[],
  channel: AgentStreamPayload["channel"]
): string[] {
  const out: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if ("channel" in payload && payload.channel === channel) {
      if (typeof payload.preview === "string") {
        out.push(payload.preview);
      }
    }
  }
  return out;
}

/** Stream payload of one event, or null when the event carries none. */
function streamPayload(
  event: AgentSessionEvent | undefined
): AgentStreamPayload | null {
  if (event === undefined || !("channel" in event.payload)) {
    return null;
  }
  return event.payload;
}

/** Adapter-declared kinds recorded on one stream channel. */
function kindsOn(
  events: readonly AgentSessionEvent[],
  channel: AgentStreamPayload["channel"]
): string[] {
  const out: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if ("channel" in payload && payload.channel === channel) {
      if (typeof payload.kind === "string") {
        out.push(payload.kind);
      }
    }
  }
  return out;
}

/** Event sequence without timestamps, so two runs compare equal. */
function shapeOf(events: readonly AgentSessionEvent[]): unknown {
  return events.map((event) => ({
    type: event.type,
    sequence: event.sequence,
    payload: event.payload,
    extensions: event.extensions
  }));
}
