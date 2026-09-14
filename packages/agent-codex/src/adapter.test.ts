import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAgentProbeUsable,
  collectingSink,
  createSecretRedactor,
  REDACTED_MARKER,
  validateAgentSessionEvent,
  type AgentRunContext,
  type AgentRunResult,
  type AgentSessionEvent,
  type AgentStreamPayload
} from "@oal/agent-adapter";

import {
  buildCodexArgv,
  CodexCliAdapter,
  composePrompt,
  LAST_MESSAGE_NAME,
  type CodexPreparedAgent
} from "./adapter.ts";
import { probeCodexCli } from "./probe.ts";
import type { CodexAgentConfig } from "./config.ts";

/** Version line the fake CLI prints for `--version`. */
const FAKE_VERSION = "codex-cli 0.44.0 (fake, no model calls)";

const fullFixture = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url)
);
const legacyFixture = fileURLToPath(
  new URL("./fixtures/fake-codex-legacy.mjs", import.meta.url)
);
const schemaPath = fileURLToPath(
  new URL("../../../schemas/agent-event.v1.schema.json", import.meta.url)
);

const PROVIDER_SECRET = "sk-provider-topsecret-0003";
const MOCK_KEY = "mock-key-canary-0002";
/** Values shaped like the ones the runner mints into the tool environment. */
const RUN_BEARER = "oal_5f3a91c07d2e4b68a1c9e0b2";
const RUN_API_KEY = "oal_7b2d94f16e8a40c3b5d7f2a1";
const RUN_BASIC_PASSWORD = "oal_9c4e27d80f1a5b6c3d4e5f60";
const NO_SIGNAL = (): AbortSignal => new AbortController().signal;

const BASE_CONFIG: CodexAgentConfig = {
  executablePath: fullFixture,
  launcherEnvironmentNames: ["CODEX_API_KEY"],
  probeTimeoutMs: 10000
};

interface Harness {
  adapter: CodexCliAdapter;
  context: AgentRunContext;
  root: string;
}

async function harness(
  contextOverride: Partial<AgentRunContext> = {},
  configOverride: Partial<CodexAgentConfig> = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "oal-codex-"));
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
      instructions: "Follow the provider contract.",
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
      CODEX_API_KEY: PROVIDER_SECRET
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
    adapter: new CodexCliAdapter({ ...BASE_CONFIG, ...configOverride }),
    context,
    root
  };
}

function withFakeEnv(
  context: AgentRunContext,
  extra: Record<string, string>
): AgentRunContext {
  return {
    ...context,
    toolEnvironment: { ...context.toolEnvironment, ...extra }
  };
}

async function runAdapter(
  harnessState: Harness,
  context: AgentRunContext
): Promise<{
  prepared: CodexPreparedAgent;
  result: AgentRunResult;
  events: AgentSessionEvent[];
}> {
  const collector = collectingSink();
  const prepared: CodexPreparedAgent =
    await harnessState.adapter.prepare(context);
  const result = await harnessState.adapter.run(
    prepared,
    collector.sink,
    NO_SIGNAL()
  );
  return { prepared, result, events: collector.events };
}

async function loadSchema(): Promise<unknown> {
  return await JSON.parse(await readFile(schemaPath, "utf8"));
}

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

/** The spawn error an exited payload carries, when one exists. */
function spawnErrorOf(
  payload: AgentSessionEvent["payload"] | undefined
): string | null {
  return payload !== undefined && "spawn_error" in payload
    ? (payload.spawn_error ?? null)
    : null;
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

describe("probeCodexCli", () => {
  it("verifies the version, the help digest, and the flag set", async () => {
    const probe = await probeCodexCli({ executablePath: fullFixture });
    expect(probe.status).toBe("available");
    expect(probe.version).toBe(FAKE_VERSION);
    expect(probe.helpDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(probe.details?.help_digest).toBe(probe.helpDigest);
    expect(probe.supportedFlags).toContain("--json");
    expect(probe.supportedFlags).toContain("--output-last-message");
    expect(probe.supportedFlags).toContain("-C");
    expect(probe.stdinPrompt).toBe(true);
    expect(probe.environmentSeparation).toBe("advisory");
    expect(probe.toolNetworkPolicy).toBe("enforced");
    expect(probe.capabilities.nativeOutputSchema).toBe(true);
  });

  it("fails preflight when the help text omits a required flag", async () => {
    const probe = await probeCodexCli({ executablePath: legacyFixture });
    expect(probe.status).toBe("unsupported");
    expect(probe.errorCode).toBe("AGENT_CAPABILITY_UNSUPPORTED");
    expect(probe.details?.missing_flags).toBe("--output-last-message");
    expect(probe.supportedFlags).not.toContain("--output-last-message");
    const check = (): void => {
      assertAgentProbeUsable(probe);
    };
    expect(check).toThrowError(/lacks required flags/);
  });

  it("reports a missing executable", async () => {
    const probe = await probeCodexCli({
      executablePath: "/nonexistent/codex-binary"
    });
    expect(probe.status).toBe("unavailable");
    expect(probe.errorCode).toBe("AGENT_EXECUTABLE_MISSING");
  });
});

describe("CodexCliAdapter.prepare", () => {
  it("builds the argv from verified flags and keeps credentials out", async () => {
    const state = await harness();
    try {
      const prepared: CodexPreparedAgent = await state.adapter.prepare(
        state.context
      );
      expect(prepared.executable).toBe(fullFixture);
      expect(prepared.argv[0]).toBe("exec");
      expect(prepared.argv).toContain("--json");
      expect(prepared.argv).toContain("-C");
      expect(prepared.argv.at(-1)).toBe("-");
      expect(prepared.lastMessagePath).toBe(
        join(state.context.temporaryDir, LAST_MESSAGE_NAME)
      );
      const flat = prepared.argv.join(" ");
      expect(flat).not.toContain(PROVIDER_SECRET);
      expect(flat).not.toContain(MOCK_KEY);
      expect(flat).not.toContain(state.context.prompts.task);
      expect(prepared.promptText).toBe(composePrompt(state.context));
      expect(prepared.workingDirectory).toBe(state.context.workspaceDir);
      expect(prepared.environment.CODEX_API_KEY).toBe(PROVIDER_SECRET);
      expect(prepared.environment.X_API_KEY).toBe(MOCK_KEY);
      expect(prepared.launcherEnvironmentApplied).toEqual(["CODEX_API_KEY"]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("refuses to prepare against an unsupported CLI", async () => {
    const state = await harness({}, { executablePath: legacyFixture });
    try {
      await expect(state.adapter.prepare(state.context)).rejects.toThrowError(
        /lacks required flags/
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("omits every flag the probe did not verify", async () => {
    const { context } = await harness();
    const argv = buildCodexArgv(context, ["--json", "--output-last-message"], {
      lastMessagePath: join(context.temporaryDir, LAST_MESSAGE_NAME),
      defaultSandbox: "workspace-write",
      skipGitRepoCheck: true,
      stdinPrompt: true,
      config: {}
    });
    expect(argv).toEqual([
      "exec",
      "--json",
      "--output-last-message",
      join(context.temporaryDir, LAST_MESSAGE_NAME),
      "-"
    ]);
  });
});

describe("CodexCliAdapter.run", () => {
  it("emits session events, usage, and the final message", async () => {
    const state = await harness();
    try {
      const { prepared, result, events } = await runAdapter(
        state,
        withFakeEnv(state.context, {})
      );
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.usage).toEqual({
        input_tokens: 120,
        cached_input_tokens: 64,
        output_tokens: 35,
        total_tokens: 155
      });
      expect(result.finalText).toBe(prepared.promptText.trim());
      const kinds = kindsOn(events, "jsonrpc");
      expect(kinds).toEqual([
        "thread.started",
        "turn.started",
        "item.completed",
        "turn.completed"
      ]);
      const stream = previews(events, "jsonrpc").join("\n");
      expect(stream).toContain(
        `fake agent processed ${prepared.promptText.length} prompt characters`
      );
      expect(events[0]?.type).toBe("agent.started");
      expect(events.at(-1)?.type).toBe("agent.exited");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("parses the structured final message against the result schema", async () => {
    const state = await harness({
      resultSchemaPath: "/run/tmp/result.schema.json"
    });
    try {
      const { result, events } = await runAdapter(
        state,
        withFakeEnv(state.context, {
          FAKE_CODEX_FINAL_TEXT: '{"computer_id":"c_9"}'
        })
      );
      expect(result.status).toBe("completed");
      expect(result.finalJson).toEqual({ computer_id: "c_9" });
      const adapterKinds = kindsOn(events, "adapter");
      expect(adapterKinds).toContain("argv.recorded");
      expect(adapterKinds).toContain("final_output");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("applies only the declared launcher environment names", async () => {
    const state = await harness();
    const strict = await harness({}, { launcherEnvironmentNames: undefined });
    try {
      const first = await runAdapter(
        state,
        withFakeEnv(state.context, { FAKE_CODEX_REPORT_ENV: "1" })
      );
      const names = previews(first.events, "jsonrpc")
        .find((preview) => preview.startsWith("env names: "))
        ?.slice("env names: ".length);
      expect(names).toContain("CODEX_API_KEY");
      expect(names).toContain("X_API_KEY");

      const second = await runAdapter(
        strict,
        withFakeEnv(strict.context, { FAKE_CODEX_REPORT_ENV: "1" })
      );
      const strictNames = previews(second.events, "jsonrpc")
        .find((preview) => preview.startsWith("env names: "))
        ?.slice("env names: ".length);
      expect(strictNames).not.toContain("CODEX_API_KEY");
      expect(JSON.stringify(second.events)).not.toContain(PROVIDER_SECRET);
    } finally {
      await rm(state.root, { recursive: true, force: true });
      await rm(strict.root, { recursive: true, force: true });
    }
  });

  it("classifies a provider infrastructure failure", async () => {
    const state = await harness();
    try {
      const { result } = await runAdapter(
        state,
        withFakeEnv(state.context, {
          FAKE_CODEX_EXIT_CODE: "1",
          FAKE_CODEX_STDERR: "stream error: unauthorized (401) api key rejected"
        })
      );
      expect(result.status).toBe("provider_failed");
      expect(result.errorCode).toBe("AGENT_PROVIDER_FAILED");
      expect(result.finalText).toBeUndefined();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("classifies a startup failure before any session event", async () => {
    const state = await harness();
    try {
      const { result, events } = await runAdapter(
        state,
        withFakeEnv(state.context, {
          FAKE_CODEX_EXIT_CODE: "2",
          FAKE_CODEX_STDERR: "unexpected key in config.toml"
        })
      );
      expect(result.status).toBe("provider_failed");
      expect(result.errorCode).toBe("AGENT_STARTUP_FAILED");
      expect(kindsOn(events, "jsonrpc")).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("records the spawn error on the exited event when the executable is missing", async () => {
    const state = await harness();
    try {
      const prepared = await state.adapter.prepare(state.context);
      const missing = join(state.root, "removed", "codex-binary");
      const collector = collectingSink();
      const result = await state.adapter.run(
        { ...prepared, executable: missing },
        collector.sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("AGENT_SPAWN_FAILED");
      expect(result.spawnError ?? "").toContain(missing);
      expect(result.spawnError ?? "").toContain("ENOENT");
      const exited = collector.events
        .filter((event) => event.type === "agent.exited")
        .at(-1);
      const spawnError = spawnErrorOf(exited?.payload);
      expect(spawnError ?? "").toContain(missing);
      expect(spawnError ?? "").toContain("ENOENT");
      expect(validateAgentSessionEvent(exited, await loadSchema())).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("classifies a nonzero exit after a live session", async () => {
    const state = await harness();
    try {
      const { result } = await runAdapter(
        state,
        withFakeEnv(state.context, {
          FAKE_CODEX_EXIT_CODE: "1",
          FAKE_CODEX_EXIT_AFTER_EVENTS: "1"
        })
      );
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("AGENT_EXIT_NONZERO");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("times out and reports the terminal status", async () => {
    const state = await harness({ timeoutMs: 500 });
    try {
      const { result } = await runAdapter(
        state,
        withFakeEnv(state.context, { FAKE_CODEX_HANG_MS: "8000" })
      );
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();
      expect(result.finalText).toBeUndefined();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("cancels through the abort signal", async () => {
    const state = await harness();
    try {
      const collector = collectingSink();
      const prepared: CodexPreparedAgent = await state.adapter.prepare(
        withFakeEnv(state.context, { FAKE_CODEX_HANG_MS: "8000" })
      );
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 150);
      const result = await state.adapter.run(
        prepared,
        collector.sink,
        controller.signal
      );
      expect(result.status).toBe("cancelled");
      expect(result.errorCode).toBe("AGENT_CANCELLED");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("removes the final message file on cleanup", async () => {
    const state = await harness();
    try {
      const { prepared, result } = await runAdapter(
        state,
        withFakeEnv(state.context, {})
      );
      expect(result.status).toBe("completed");
      expect(await exists(prepared.lastMessagePath ?? "/none")).toBe(true);
      await state.adapter.cleanup(prepared);
      expect(await exists(prepared.lastMessagePath ?? "/none")).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("emits session events that satisfy the published schema", async () => {
    const state = await harness();
    try {
      const collector = collectingSink();
      const prepared: CodexPreparedAgent = await state.adapter.prepare(
        withFakeEnv(state.context, {
          FAKE_CODEX_STDERR: `note ${PROVIDER_SECRET} before the turn`
        })
      );
      await state.adapter.run(
        prepared,
        {
          emit: (event) => {
            collector.sink.emit(event);
          },
          redact: createSecretRedactor([PROVIDER_SECRET])
        },
        NO_SIGNAL()
      );
      const schema = await loadSchema();
      for (const event of collector.events) {
        expect(validateAgentSessionEvent(event, schema)).toEqual([]);
      }
      expect(JSON.stringify(collector.events)).not.toContain(PROVIDER_SECRET);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("redacts credentials the child prints without a sink redactor", async () => {
    const state = await harness();
    const context: AgentRunContext = {
      ...state.context,
      exposure: {
        ...state.context.exposure,
        credentialNames: [
          "OAL_AUTH_BEARER",
          "OAL_AUTH_X_API_KEY",
          "OAL_AUTH_BASIC_PASSWORD"
        ]
      },
      toolEnvironment: {
        ...state.context.toolEnvironment,
        OAL_AUTH_BEARER: RUN_BEARER,
        OAL_AUTH_X_API_KEY: RUN_API_KEY,
        OAL_AUTH_BASIC_PASSWORD: RUN_BASIC_PASSWORD
      }
    };
    try {
      const collector = collectingSink();
      const prepared = await state.adapter.prepare(
        withFakeEnv(context, {
          FAKE_CODEX_STDOUT_NOTE: `echo bearer ${RUN_BEARER}`,
          FAKE_CODEX_STDERR:
            `env OAL_AUTH_BEARER=${RUN_BEARER} ` +
            `OAL_AUTH_X_API_KEY=${RUN_API_KEY} ` +
            `OAL_AUTH_BASIC_PASSWORD=${RUN_BASIC_PASSWORD} ` +
            `CODEX_API_KEY=${PROVIDER_SECRET}`
        })
      );
      const result = await state.adapter.run(
        prepared,
        collector.sink,
        NO_SIGNAL()
      );
      expect(result.status).toBe("completed");
      const recorded = JSON.stringify(collector.events);
      expect(recorded).not.toContain(RUN_BEARER);
      expect(recorded).not.toContain(RUN_API_KEY);
      expect(recorded).not.toContain(RUN_BASIC_PASSWORD);
      expect(recorded).not.toContain(PROVIDER_SECRET);
      const stderrPreview = previews(collector.events, "stderr").join("\n");
      expect(stderrPreview).toContain(`OAL_AUTH_BEARER=${REDACTED_MARKER}`);
      expect(stderrPreview).toContain(`OAL_AUTH_X_API_KEY=${REDACTED_MARKER}`);
      expect(stderrPreview).toContain(
        `OAL_AUTH_BASIC_PASSWORD=${REDACTED_MARKER}`
      );
      expect(stderrPreview).toContain(`CODEX_API_KEY=${REDACTED_MARKER}`);
      const stdoutPreview = previews(collector.events, "jsonrpc").join("\n");
      expect(stdoutPreview).toContain(`echo bearer ${REDACTED_MARKER}`);
      for (const event of collector.events) {
        const payload = event.payload;
        if ("channel" in payload && payload.channel === "stderr") {
          expect(payload.redacted).toBe(true);
        }
      }
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
