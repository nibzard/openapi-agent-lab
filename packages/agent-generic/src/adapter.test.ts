import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectingSink,
  createSecretRedactor,
  REDACTED_MARKER,
  validateAgentSessionEvent,
  type AgentCapabilities,
  type AgentRunContext,
  type AgentSessionEvent,
  type AgentStreamPayload
} from "@oal/agent-adapter";

import { GenericCommandAdapter } from "./adapter.ts";
import type { GenericAgentConfig } from "./config.ts";
import { createTranscriptParser } from "./transcript.ts";

const NODE = process.execPath;
const fixtureEntry = fileURLToPath(
  new URL("./fixtures/echo-agent.mjs", import.meta.url)
);
const schemaPath = fileURLToPath(
  new URL("../../../schemas/agent-event.v1.schema.json", import.meta.url)
);

const CAPABILITIES: AgentCapabilities = {
  nativeSystemPrompt: false,
  nativeOutputSchema: false,
  mcp: false,
  machineReadableTranscript: true,
  usageReporting: true,
  separateToolEnvironment: true,
  enforceableToolNetworkPolicy: false,
  sandboxModes: []
};

const LAUNCHER_SECRET = "sk-launcher-topsecret-0001";
const MOCK_KEY = "mock-key-canary-0002";
/** Values shaped like the ones the runner mints into the tool environment. */
const RUN_BEARER = "oal_5f3a91c07d2e4b68a1c9e0b2";
const RUN_API_KEY = "oal_7b2d94f16e8a40c3b5d7f2a1";
const RUN_BASIC_PASSWORD = "oal_9c4e27d80f1a5b6c3d4e5f60";
const NO_SIGNAL = (): AbortSignal => new AbortController().signal;

const BASE_CONFIG: GenericAgentConfig = {
  executablePath: NODE,
  args: [fixtureEntry],
  workingDirectory: "workspace",
  stdin: "none",
  transcript: { kind: "json-events", stream: "stdout" },
  finalOutput: { source: "stdout-last-line" },
  capabilities: CAPABILITIES
};

interface Harness {
  adapter: GenericCommandAdapter;
  context: AgentRunContext;
  root: string;
}

async function harness(
  contextOverride: Partial<AgentRunContext> = {},
  configOverride: Partial<GenericAgentConfig> = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "oal-generic-"));
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
      baseUrl: "http://127.0.0.1:8099/api",
      credentialNames: ["X_API_KEY"]
    },
    launcherEnvironment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PROVIDER_KEY: LAUNCHER_SECRET
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
    timeoutMs: 20000,
    ...contextOverride
  };
  return {
    adapter: new GenericCommandAdapter({ ...BASE_CONFIG, ...configOverride }),
    context,
    root
  };
}

function withFixtureEnv(
  context: AgentRunContext,
  extra: Record<string, string>
): AgentRunContext {
  return {
    ...context,
    toolEnvironment: { ...context.toolEnvironment, ...extra }
  };
}

async function loadSchema(): Promise<unknown> {
  return await JSON.parse(await readFile(schemaPath, "utf8"));
}

describe("GenericCommandAdapter.probe", () => {
  it("reports the declared capabilities and a probed version line", async () => {
    const { adapter } = await harness({}, { probeArgs: ["--version"] });
    const probe = await adapter.probe({});
    expect(probe.status).toBe("available");
    expect(probe.version).toBe(`v${process.versions.node}`);
    expect(probe.capabilities).toEqual(CAPABILITIES);
    expect(probe.environmentSeparation).toBe("enforced");
    expect(probe.toolNetworkPolicy).toBe("advisory");
  });

  it("fails when the executable is missing", async () => {
    const { adapter } = await harness(
      {},
      { executablePath: "/nonexistent/agent-binary" }
    );
    const probe = await adapter.probe({});
    expect(probe.status).toBe("unavailable");
    expect(probe.errorCode).toBe("AGENT_EXECUTABLE_MISSING");
  });

  it("declares advisory separation when launcher names are required", async () => {
    const { adapter } = await harness(
      {},
      { launcherEnvironmentNames: ["PROVIDER_KEY"] }
    );
    const probe = await adapter.probe({});
    expect(probe.launcherEnvironmentNames).toEqual(["PROVIDER_KEY"]);
    expect(probe.environmentSeparation).toBe("advisory");
  });
});

describe("GenericCommandAdapter configuration", () => {
  it("rejects a shell snippet where a path is expected", () => {
    expect(
      () =>
        new GenericCommandAdapter({
          ...BASE_CONFIG,
          executablePath: "/bin/sh -c 'echo hi'"
        })
    ).toThrowError(/shell metacharacters/);
    expect(
      () =>
        new GenericCommandAdapter({
          ...BASE_CONFIG,
          finalOutput: { source: "file-at-path", path: "/tmp/a;rm -rf /" }
        })
    ).toThrowError(/shell metacharacters/);
  });

  it("rejects a relative executable and an incomplete final output", () => {
    expect(
      () =>
        new GenericCommandAdapter({ ...BASE_CONFIG, executablePath: "node" })
    ).toThrowError(/executablePath must be absolute/);
    expect(
      () =>
        new GenericCommandAdapter({
          ...BASE_CONFIG,
          finalOutput: { source: "file-at-path" }
        })
    ).toThrowError(/finalOutput\.path is required/);
    expect(
      () =>
        new GenericCommandAdapter({
          ...BASE_CONFIG,
          finalOutput: { source: "none", path: "/tmp/out.txt" }
        })
    ).toThrowError(/finalOutput\.path is only valid/);
  });

  it("keeps prompt text with quotes as one argv element", async () => {
    const { adapter, context } = await harness(
      {},
      {
        args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "{task}"]
      }
    );
    const injected = 'task"; rm -rf /; echo "';
    const prepared = await adapter.prepare({
      ...context,
      prompts: { ...context.prompts, task: injected }
    });
    expect(prepared.argv).toEqual([
      "-e",
      "process.stdout.write(process.argv[1] ?? '')",
      injected
    ]);
  });
});

describe("GenericCommandAdapter.run", () => {
  it("applies the tool environment and hides the launcher environment", async () => {
    const { adapter, context, root } = await harness(
      {},
      { finalOutput: { source: "none" } }
    );
    try {
      const collector = collectingSink();
      const prepared = await adapter.prepare(
        withFixtureEnv(context, { FIXTURE_REPORT_ENV: "1" })
      );
      const result = await adapter.run(prepared, collector.sink, NO_SIGNAL());
      expect(result.status).toBe("completed");
      const seen = previews(collector.events, "jsonrpc").join("\n");
      expect(seen).toContain(
        "names=FIXTURE_REPORT_ENV,HOME,PATH,TMPDIR,X_API_KEY"
      );
      expect(seen).not.toContain("PROVIDER_KEY");
      expect(seen).not.toContain(LAUNCHER_SECRET);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the declared stdin policy to the child", async () => {
    const { adapter, context, root } = await harness(
      {},
      {
        stdin: "task-text",
        transcript: { kind: "text-tail", stream: "stdout" }
      }
    );
    try {
      const prepared = await adapter.prepare(
        withFixtureEnv(context, { FIXTURE_STDIN: "1" })
      );
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("completed");
      expect(result.finalText).toBe("stdin=Create one computer.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses json events, reports usage, and extracts the final answer", async () => {
    const { adapter, context, root } = await harness({
      resultSchemaPath: "/run/tmp/result.schema.json"
    });
    try {
      const collector = collectingSink();
      const prepared = await adapter.prepare(
        withFixtureEnv(context, {
          FIXTURE_JSON_EVENTS: "3",
          FIXTURE_FINAL_TEXT: '{"computer_id":"c_1"}'
        })
      );
      const result = await adapter.run(prepared, collector.sink, NO_SIGNAL());
      expect(result.status).toBe("completed");
      expect(result.usage).toEqual({
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18
      });
      expect(result.finalText).toBe('{"computer_id":"c_1"}');
      expect(result.finalJson).toEqual({ computer_id: "c_1" });
      const kinds = kindsOn(collector.events, "jsonrpc");
      expect(kinds).toEqual([
        "session_event",
        "session_event",
        "session_event",
        "turn.completed"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the final message from a file and cleans it up", async () => {
    const root = await mkdtemp(join(tmpdir(), "oal-generic-final-"));
    const temporary = join(root, "tmp");
    await mkdir(temporary, { recursive: true });
    const finalPath = join(temporary, "last-message.txt");
    const { adapter, context } = await harness(
      { temporaryDir: temporary },
      {
        finalOutput: {
          source: "file-at-path",
          path: "{tmpdir}/last-message.txt"
        },
        transcript: { kind: "text-tail", stream: "stdout" }
      }
    );
    try {
      const prepared = await adapter.prepare(
        withFixtureEnv(context, {
          FIXTURE_FINAL_FILE: finalPath,
          FIXTURE_FINAL_TEXT: "final answer from file"
        })
      );
      expect(prepared.finalOutputPath).toBe(finalPath);
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("completed");
      expect(result.finalText).toBe("final answer from file");
      expect(await exists(finalPath)).toBe(true);
      await adapter.cleanup(prepared);
      expect(await exists(finalPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out and reports the terminal status", async () => {
    const { adapter, context, root } = await harness(
      { timeoutMs: 400 },
      {
        args: ["-e", "setInterval(()=>{},50);"],
        finalOutput: { source: "none" }
      }
    );
    try {
      const prepared = await adapter.prepare(context);
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();
      expect(result.finalText).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a nonzero exit as an agent failure", async () => {
    const { adapter, context, root } = await harness();
    try {
      const prepared = await adapter.prepare(
        withFixtureEnv(context, { FIXTURE_EXIT_CODE: "3" })
      );
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(3);
      expect(result.errorCode).toBe("AGENT_EXIT_NONZERO");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a declared infrastructure exit as a provider failure", async () => {
    const { adapter, context, root } = await harness(
      {},
      { infrastructureExitCodes: [70] }
    );
    try {
      const prepared = await adapter.prepare(
        withFixtureEnv(context, { FIXTURE_EXIT_CODE: "70" })
      );
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("provider_failed");
      expect(result.errorCode).toBe("AGENT_PROVIDER_FAILED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels through the abort signal", async () => {
    const { adapter, context, root } = await harness(
      { timeoutMs: 20000 },
      {
        args: ["-e", "setInterval(()=>{},50);"],
        finalOutput: { source: "none" }
      }
    );
    try {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 200);
      const prepared = await adapter.prepare(context);
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        controller.signal
      );
      expect(result.status).toBe("cancelled");
      expect(result.errorCode).toBe("AGENT_CANCELLED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits session events that satisfy the published schema", async () => {
    const { adapter, context, root } = await harness();
    try {
      const collector = collectingSink();
      const prepared = await adapter.prepare(
        withFixtureEnv(context, {
          FIXTURE_JSON_EVENTS: "1",
          FIXTURE_SECRET: LAUNCHER_SECRET
        })
      );
      await adapter.run(
        prepared,
        {
          emit: (event) => {
            collector.sink.emit(event);
          },
          redact: createSecretRedactor([LAUNCHER_SECRET])
        },
        NO_SIGNAL()
      );
      const schema = await loadSchema();
      for (const event of collector.events) {
        expect(validateAgentSessionEvent(event, schema)).toEqual([]);
      }
      expect(JSON.stringify(collector.events)).not.toContain(LAUNCHER_SECRET);
      expect(collector.events[0]?.type).toBe("agent.started");
      expect(collector.events.at(-1)?.type).toBe("agent.exited");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts a registered secret through the sink redactor", async () => {
    const { adapter, context, root } = await harness(
      {},
      { transcript: { kind: "text-tail", stream: "stdout" } }
    );
    try {
      const collector = collectingSink();
      const prepared = await adapter.prepare(
        withFixtureEnv(context, { FIXTURE_SECRET: LAUNCHER_SECRET })
      );
      await adapter.run(
        prepared,
        {
          emit: (event) => {
            collector.sink.emit(event);
          },
          redact: createSecretRedactor([LAUNCHER_SECRET])
        },
        NO_SIGNAL()
      );
      const preview = previews(collector.events, "stdout").join("\n");
      expect(preview).toContain(`secret seen: ${REDACTED_MARKER}`);
      expect(preview).not.toContain(LAUNCHER_SECRET);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts credentials the child prints without a sink redactor", async () => {
    const { adapter, context, root } = await harness(
      {},
      {
        transcript: { kind: "text-tail", stream: "stdout" },
        finalOutput: { source: "none" }
      }
    );
    try {
      const collector = collectingSink();
      const prepared = await adapter.prepare(
        withFixtureEnv(
          {
            ...context,
            exposure: {
              ...context.exposure,
              credentialNames: [
                "OAL_AUTH_BEARER",
                "OAL_AUTH_X_API_KEY",
                "OAL_AUTH_BASIC_PASSWORD"
              ]
            },
            toolEnvironment: {
              ...context.toolEnvironment,
              OAL_AUTH_BEARER: RUN_BEARER,
              OAL_AUTH_X_API_KEY: RUN_API_KEY,
              OAL_AUTH_BASIC_PASSWORD: RUN_BASIC_PASSWORD
            }
          },
          { FIXTURE_DUMP_ENV: "1" }
        )
      );
      const result = await adapter.run(prepared, collector.sink, NO_SIGNAL());
      expect(result.status).toBe("completed");
      const seen = previews(collector.events, "stdout").join("\n");
      expect(seen).toContain(`OAL_AUTH_BEARER=${REDACTED_MARKER}`);
      expect(seen).toContain(`OAL_AUTH_X_API_KEY=${REDACTED_MARKER}`);
      expect(seen).toContain(`OAL_AUTH_BASIC_PASSWORD=${REDACTED_MARKER}`);
      expect(seen).toContain(`X_API_KEY=${REDACTED_MARKER}`);
      expect(seen).toContain("HOME=");
      const recorded = JSON.stringify(collector.events);
      expect(recorded).not.toContain(RUN_BEARER);
      expect(recorded).not.toContain(RUN_API_KEY);
      expect(recorded).not.toContain(RUN_BASIC_PASSWORD);
      expect(recorded).not.toContain(MOCK_KEY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a workspace file written by the participant", async () => {
    const root = await mkdtemp(join(tmpdir(), "oal-generic-ws-"));
    await mkdir(root, { recursive: true });
    const { adapter, context } = await harness(
      { workspaceDir: root },
      {
        args: ["-e", "require('node:fs').writeFileSync('report.txt','kept');"],
        finalOutput: { source: "none" }
      }
    );
    try {
      const prepared = await adapter.prepare(context);
      expect(prepared.workingDirectory).toBe(root);
      const result = await adapter.run(
        prepared,
        collectingSink().sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("completed");
      await adapter.cleanup(prepared);
      expect(await readFile(join(root, "report.txt"), "utf8")).toBe("kept");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createTranscriptParser", () => {
  it("parses json events across chunk boundaries", () => {
    const parser = createTranscriptParser({
      kind: "json-events",
      stream: "stdout"
    });
    expect(parser.push('{"type":"a","text":"hel')).toEqual([]);
    expect(parser.push('lo"}\n{"type":"b","usage":{"x":1}}\n')).toEqual([
      { kind: "a", text: "hello" },
      { kind: "b", text: "", usage: { x: 1 } }
    ]);
    expect(parser.flush()).toBeNull();
  });

  it("marks an unparsable json line and bounds the event count", () => {
    const bounded = createTranscriptParser({
      kind: "json-events",
      stream: "stdout",
      maxEvents: 1
    });
    expect(bounded.push('not json\n{"type":"a"}\n')).toEqual([
      { kind: "unparsed", text: "not json" }
    ]);
  });

  it("records plain text lines without a kind", () => {
    const parser = createTranscriptParser({
      kind: "text-tail",
      stream: "stderr"
    });
    expect(parser.push("one\ntwo")).toEqual([{ kind: null, text: "one" }]);
    expect(parser.flush()).toEqual({ kind: null, text: "two" });
  });

  it("records ndjson lines verbatim", () => {
    const parser = createTranscriptParser({ kind: "ndjson", stream: "stdout" });
    expect(parser.push('{"a":1}\n')).toEqual([{ kind: null, text: '{"a":1}' }]);
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
