import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "@oal/core";

import {
  collectingSink,
  createSecretRedactor,
  identityRedactor,
  REDACTED_MARKER,
  SessionEventRecorder,
  validateAgentSessionEvent
} from "./events.ts";
import { assertAgentProbeUsable } from "./types.ts";
import type { AgentProbe, AgentSessionEvent } from "./types.ts";

const schemaUrl = new URL(
  "../../../schemas/agent-event.v1.schema.json",
  import.meta.url
);

async function loadSchema(): Promise<unknown> {
  return await JSON.parse(await readFile(fileURLToPath(schemaUrl), "utf8"));
}

describe("SessionEventRecorder", () => {
  it("emits ordered events that satisfy the published schema", async () => {
    const schema = await loadSchema();
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "codex-cli",
      sink: collector.sink,
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.started({ model: "gpt-5", cliVersion: "0.20.0" });
    recorder.text("stdout", "first line\n");
    recorder.adapterEvent("turn.completed", { usage: "reported" });
    recorder.exited({ exitCode: 0, signal: null, graceful: true });

    expect(collector.events).toHaveLength(4);
    expect(
      collector.events.map((event: AgentSessionEvent) => event.sequence)
    ).toEqual([1, 2, 3, 4]);
    expect(collector.events[0]?.type).toBe("agent.started");
    expect(collector.events[3]?.type).toBe("agent.exited");
    for (const event of collector.events) {
      expect(validateAgentSessionEvent(event, schema)).toEqual([]);
    }
  });

  it("builds stable identifiers from the run and the sequence", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "codex-cli",
      sink: collector.sink,
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.exited({ exitCode: 0, signal: null, graceful: true });
    recorder.exited({ exitCode: 0, signal: null, graceful: true });
    const first = collector.events[0];
    const second = collector.events[1];
    expect(first?.event_id).toMatch(/^ag_[a-f0-9]{24}$/);
    expect(second?.event_id).toMatch(/^ag_[a-f0-9]{24}$/);
    expect(first?.event_id).not.toBe(second?.event_id);
  });

  it("bounds the preview and keeps the byte count of the bound", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "generic",
      sink: collector.sink,
      now: () => "2026-08-27T10:00:00.000Z",
      maxPreviewChars: 10
    });
    recorder.text("stdout", "abcdefghijklmnop");
    const payload = collector.events[0]?.payload;
    expect(payload).toEqual({
      channel: "stdout",
      redacted: false,
      bytes: 10,
      sha256: sha256Hex("abcdefghij"),
      preview: "abcdefghij"
    });
  });

  it("uses the sink redactor when no explicit redactor is given", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "generic",
      sink: {
        emit: (event: AgentSessionEvent): void => {
          collector.sink.emit(event);
        },
        redact: createSecretRedactor(["sk-live-secret-value"])
      },
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.text("stdout", "token=sk-live-secret-value done\n");
    const payload = collector.events[0]?.payload;
    expect(payload).toMatchObject({
      channel: "stdout",
      redacted: true,
      preview: `token=${REDACTED_MARKER} done\n`
    });
    expect(
      JSON.stringify(collector.events).includes("sk-live-secret-value")
    ).toBe(false);
  });

  it("reports no redaction for clean text", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "generic",
      sink: collector.sink,
      redact: createSecretRedactor(["verysecretvalue"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.text("stderr", "ordinary text");
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "stderr",
      redacted: false
    });
  });

  it("reports no redaction for a clean adapter detail record", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "generic",
      sink: collector.sink,
      redact: createSecretRedactor(["verysecretvalue"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.adapterEvent("turn.completed", {
      usage: "reported",
      turns: 2,
      nested: { model: "mock" }
    });
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "adapter",
      redacted: false,
      kind: "turn.completed"
    });
    expect(collector.events[0]?.extensions).toEqual({
      usage: "reported",
      turns: 2,
      nested: { model: "mock" }
    });
  });

  it("redacts adapter detail strings and reports the change", async () => {
    const schema = await loadSchema();
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "mock-agent",
      sink: collector.sink,
      redact: createSecretRedactor(["sk-live-secret-value"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.adapterEvent("mock.note", {
      text: "token=sk-live-secret-value done",
      turns: 1,
      echoes: ["sk-live-secret-value", "clean"]
    });
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "adapter",
      redacted: true,
      kind: "mock.note"
    });
    expect(collector.events[0]?.extensions).toEqual({
      text: `token=${REDACTED_MARKER} done`,
      turns: 1,
      echoes: [REDACTED_MARKER, "clean"]
    });
    expect(validateAgentSessionEvent(collector.events[0], schema)).toEqual([]);
    expect(
      JSON.stringify(collector.events).includes("sk-live-secret-value")
    ).toBe(false);
  });

  it("keeps an own __proto__ detail key as a data property", async () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "mock-agent",
      sink: collector.sink,
      redact: createSecretRedactor(["sk-live-secret-value"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    const detail = JSON.parse(
      '{"__proto__": {"polluted": true}, "note": "token=sk-live-secret-value done", "safe": 1}'
    ) as Record<string, unknown>;
    recorder.adapterEvent("mock.proto", detail);

    const extensions = collector.events[0]?.extensions;
    expect(extensions).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(extensions, "__proto__")).toBe(
      true
    );
    expect(Object.getPrototypeOf(extensions)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(extensions, "__proto__")?.value
    ).toEqual({ polluted: true });
    expect(Object.entries(extensions ?? {})).toEqual([
      ["__proto__", { polluted: true }],
      ["note", `token=${REDACTED_MARKER} done`],
      ["safe", 1]
    ]);
    expect(JSON.stringify(extensions)).toBe(
      `{"__proto__":{"polluted":true},"note":"token=${REDACTED_MARKER} done","safe":1}`
    );
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "adapter",
      redacted: true,
      kind: "mock.proto"
    });
    expect(
      validateAgentSessionEvent(collector.events[0], await loadSchema())
    ).toEqual([]);
  });

  it("keeps a string __proto__ detail key and redacts its value", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "mock-agent",
      sink: collector.sink,
      redact: createSecretRedactor(["sk-live-secret-value"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    const detail = JSON.parse(
      '{"__proto__": "token=sk-live-secret-value done"}'
    ) as Record<string, unknown>;
    recorder.adapterEvent("mock.proto", detail);

    const extensions = collector.events[0]?.extensions;
    expect(Object.prototype.hasOwnProperty.call(extensions, "__proto__")).toBe(
      true
    );
    expect(Object.getPrototypeOf(extensions)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(extensions, "__proto__")?.value
    ).toBe(`token=${REDACTED_MARKER} done`);
    expect(
      JSON.stringify(collector.events).includes("sk-live-secret-value")
    ).toBe(false);
  });

  it("passes a Date detail value through untouched", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "mock-agent",
      sink: collector.sink,
      redact: createSecretRedactor(["sk-live-secret-value"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.adapterEvent("mock.clock", {
      when: new Date("2026-08-27T10:00:00.000Z"),
      nested: { when: new Date("2026-08-27T11:30:00.000Z") },
      stamps: [new Date("2026-08-27T12:45:00.000Z")]
    });

    expect(JSON.stringify(collector.events[0]?.extensions)).toBe(
      '{"when":"2026-08-27T10:00:00.000Z",' +
        '"nested":{"when":"2026-08-27T11:30:00.000Z"},' +
        '"stamps":["2026-08-27T12:45:00.000Z"]}'
    );
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "adapter",
      redacted: false,
      kind: "mock.clock"
    });
  });

  it("redacts secrets nested in plain objects and arrays only", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "mock-agent",
      sink: collector.sink,
      redact: createSecretRedactor(["sk-live-secret-value"]),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    const empty = Object.create(null) as Record<string, unknown>;
    empty.token = "sk-live-secret-value";
    recorder.adapterEvent("mock.nested", {
      plain: { token: "sk-live-secret-value" },
      list: [{ token: "sk-live-secret-value" }],
      nullProto: empty
    });

    expect(collector.events[0]?.extensions).toEqual({
      plain: { token: REDACTED_MARKER },
      list: [{ token: REDACTED_MARKER }],
      nullProto: { token: REDACTED_MARKER }
    });
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "adapter",
      redacted: true
    });
  });

  it("rejects an unsafe run identifier and adapter identifier", () => {
    const collector = collectingSink();
    expect(
      () =>
        new SessionEventRecorder({
          runId: "bad id",
          adapter: "generic",
          sink: collector.sink
        })
    ).toThrowError(/safe identifier/);
    expect(
      () =>
        new SessionEventRecorder({
          runId: "run_000001",
          adapter: "Generic",
          sink: collector.sink
        })
    ).toThrowError(/adapter id/);
  });
});

describe("createSecretRedactor", () => {
  it("replaces the longest secret first and skips short values", () => {
    const redact = createSecretRedactor(["ab", "alpha-secret", "alpha"]);
    expect(redact("value alpha-secret and alpha")).toBe(
      `value ${REDACTED_MARKER} and ${REDACTED_MARKER}`
    );
  });

  it("returns the text unchanged when nothing can be replaced", () => {
    expect(identityRedactor("plain")).toBe("plain");
  });
});

describe("validateAgentSessionEvent", () => {
  it("reports every rule a broken event breaks", async () => {
    const schema = await loadSchema();
    const problems = validateAgentSessionEvent(
      {
        schema_version: 2,
        type: "agent.other",
        event_id: "nope",
        sequence: 0,
        observed_at: "yesterday",
        run_id: "run 1",
        adapter: "Codex",
        payload: { channel: "tty", redacted: false },
        extensions: {},
        extra: 1
      },
      schema
    );
    expect(problems).toContain("schema_version must be 1");
    expect(problems).toContain("unexpected field extra");
    expect(problems).toContain("sequence is below the schema minimum");
    expect(problems).toContain("event_id does not match its pattern");
    expect(problems).toContain("adapter does not match its pattern");
    expect(problems.some((line) => line.startsWith("payload matches"))).toBe(
      true
    );
  });
});

describe("assertAgentProbeUsable", () => {
  const capabilities = {
    nativeSystemPrompt: false,
    nativeOutputSchema: false,
    mcp: false,
    machineReadableTranscript: false,
    usageReporting: false,
    separateToolEnvironment: false,
    enforceableToolNetworkPolicy: false,
    sandboxModes: []
  };

  it("accepts an available probe", () => {
    const probe: AgentProbe = {
      status: "available",
      version: "1.0.0",
      capabilities,
      launcherEnvironmentNames: [],
      environmentSeparation: "enforced",
      toolNetworkPolicy: "advisory"
    };
    expect(() => {
      assertAgentProbeUsable(probe);
    }).not.toThrow();
  });

  it("throws a capability error for an unsupported driver", () => {
    const probe: AgentProbe = {
      status: "unsupported",
      version: "0.1.0",
      capabilities,
      launcherEnvironmentNames: [],
      environmentSeparation: "advisory",
      toolNetworkPolicy: "advisory",
      error: "--json is missing"
    };
    try {
      assertAgentProbeUsable(probe);
      expect.unreachable("the probe must fail");
    } catch (error) {
      const failure = error as {
        code: string;
        details: Record<string, string>;
      };
      expect(failure.code).toBe("AGENT_CAPABILITY_UNSUPPORTED");
      expect(failure.details.adapter_status).toBe("unsupported");
    }
  });
});
