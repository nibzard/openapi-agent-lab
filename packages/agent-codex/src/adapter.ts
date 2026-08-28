/**
 * Reference Codex CLI adapter (specification section 21.4).
 *
 * The adapter targets the non-interactive `codex exec` command. It probes the
 * installed CLI before use, builds the argv from verified flags only, feeds
 * the prompt through stdin, parses `--json` session events, and reads the
 * final message from `--output-last-message`.
 *
 * The documented successful terminal-turn signal is the session event with
 * channel `jsonrpc` and kind `turn.completed` (specification section 22.3).
 * Process exit alone never implies a completed turn.
 *
 * Credentials travel only in the environment: the provider credential comes
 * from the declared launcher names and the mock credential from the tool
 * environment. Neither ever appears in argv.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  assertAgentProbeUsable,
  buildSpawnEnvironment,
  createSessionRedactor,
  DEFAULT_MAX_FINAL_OUTPUT_BYTES,
  LineAssembler,
  readBoundedFile,
  runProcessGroup,
  SessionEventRecorder,
  type AgentAdapter,
  type AgentConfig,
  type AgentEventSink,
  type AgentRunContext,
  type AgentRunResult,
  type PreparedAgent,
  type ProcessGroupResult
} from "@oal/agent-adapter";

import { DEFAULT_CODEX_SANDBOX, type CodexAgentConfig } from "./config.ts";
import {
  mergeCodexConfig,
  probeCodexCli,
  type CodexProbeResult
} from "./probe.ts";

/** Name of the adapter-owned final message file inside the temporary dir. */
export const LAST_MESSAGE_NAME = "codex-last-message.txt";

/** stderr text that means provider infrastructure, not an agent answer. */
const PROVIDER_FAILURE_PATTERN =
  /unauthorized|forbidden|api[ _-]?key|quota|rate[ _-]?limit|billing|insufficient|authentication/i;

/** Preparation state of one codex run. */
export interface CodexPreparedAgent extends PreparedAgent {
  readonly context: AgentRunContext;
  readonly config: CodexAgentConfig;
  /** Text written to the CLI stdin. */
  readonly promptText: string;
  /** Absolute path given to `--output-last-message`. */
  readonly lastMessagePath: string | null;
  /** Flags the probe verified on the installed CLI. */
  readonly supportedFlags: readonly string[];
  /** Whether the CLI reads the prompt from stdin with `-`. */
  readonly stdinPrompt: boolean;
  readonly version: string | null;
  readonly helpDigest: string | null;
}

/** One parsed `--json` session event line. */
interface CodexLine {
  readonly kind: string | null;
  readonly text: string;
  readonly usage?: Record<string, number> | undefined;
}

/**
 * Build the `codex exec` argv from verified flags. Every value stays one argv
 * element, and no credential is ever placed in the vector.
 */
export function buildCodexArgv(
  context: AgentRunContext,
  supportedFlags: readonly string[],
  options: {
    lastMessagePath: string | null;
    defaultSandbox: string;
    skipGitRepoCheck: boolean;
    stdinPrompt: boolean;
    config: CodexAgentConfig;
  }
): string[] {
  const has = (flag: string): boolean => supportedFlags.includes(flag);
  const argv: string[] = ["exec"];
  if (has("--json")) {
    argv.push("--json");
  }
  if (has("--ephemeral")) {
    argv.push("--ephemeral");
  }
  if (has("--ignore-user-config")) {
    argv.push("--ignore-user-config");
  }
  if (has("--ignore-rules")) {
    argv.push("--ignore-rules");
  }
  const sandbox =
    context.sandbox ?? options.config.sandbox ?? options.defaultSandbox;
  if (has("--sandbox")) {
    argv.push("--sandbox", sandbox);
  }
  if (has("-C")) {
    argv.push("-C", context.workspaceDir);
  }
  if (has("--skip-git-repo-check") && options.skipGitRepoCheck) {
    argv.push("--skip-git-repo-check");
  }
  if (context.resultSchemaPath !== undefined && has("--output-schema")) {
    argv.push("--output-schema", context.resultSchemaPath);
  }
  if (options.lastMessagePath !== null && has("--output-last-message")) {
    argv.push("--output-last-message", options.lastMessagePath);
  }
  const model = context.model ?? options.config.model;
  if (model !== undefined && has("--model")) {
    argv.push("--model", model);
  }
  const effort = context.effort ?? options.config.effort;
  if (effort !== undefined && has("-c")) {
    argv.push("-c", `model_reasoning_effort="${effort}"`);
  }
  if (options.stdinPrompt) {
    argv.push("-");
  } else {
    argv.push(composePrompt(context));
  }
  return argv;
}

/** Compose the prompt handed to the CLI. The text is never rewritten. */
export function composePrompt(context: AgentRunContext): string {
  return [
    context.prompts.instructions,
    context.prompts.task,
    context.prompts.launch
  ]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join("\n\n");
}

/**
 * Adapter for the Codex CLI. One instance serves one configuration and caches
 * the last probe, so `prepare` can build the argv from verified flags.
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly id: string;
  private readonly own: CodexAgentConfig;
  private probeCache: CodexProbeResult | null = null;

  constructor(config: CodexAgentConfig = {}) {
    this.own = config;
    this.id = config.id ?? "codex-cli";
  }

  async probe(config: AgentConfig = {}): Promise<CodexProbeResult> {
    const probe = await probeCodexCli(mergeCodexConfig(this.own, config));
    this.probeCache = probe;
    return probe;
  }

  /**
   * Validate the run context and build the argv from the verified flag set.
   * Preparation uses the cached probe and probes once when none ran yet.
   */
  async prepare(context: AgentRunContext): Promise<CodexPreparedAgent> {
    const config = mergeCodexConfig(this.own, {});
    const probe = this.probeCache ?? (await this.probe(config));
    this.probeCache = probe;
    assertAgentProbeUsable(probe);
    const lastMessagePath = probe.supportedFlags.includes(
      "--output-last-message"
    )
      ? join(context.temporaryDir, LAST_MESSAGE_NAME)
      : null;
    const argv = buildCodexArgv(context, probe.supportedFlags, {
      lastMessagePath,
      defaultSandbox: config.defaultSandbox ?? DEFAULT_CODEX_SANDBOX,
      skipGitRepoCheck: config.skipGitRepoCheck ?? true,
      stdinPrompt: probe.stdinPrompt,
      config
    });
    const spawn = buildSpawnEnvironment(
      context,
      config.launcherEnvironmentNames ?? []
    );
    return {
      runId: context.runId,
      adapter: this.id,
      executable: config.executablePath ?? "codex",
      argv,
      workingDirectory: context.workspaceDir,
      environment: spawn.env,
      launcherEnvironmentApplied: spawn.appliedLauncherNames,
      context,
      config,
      promptText: composePrompt(context),
      lastMessagePath,
      supportedFlags: probe.supportedFlags,
      stdinPrompt: probe.stdinPrompt,
      version: probe.version,
      helpDigest: probe.helpDigest
    };
  }

  async run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const run = prepared as CodexPreparedAgent;
    const context = run.context;
    const recorder = new SessionEventRecorder({
      runId: context.runId,
      adapter: this.id,
      sink,
      redact: createSessionRedactor(context)
    });
    const usage: Record<string, number> = {};
    const events = new LineAssembler();
    const stderrLines = new LineAssembler();
    let stderrText = "";
    let sessionEvents = 0;

    /** Record one `--json` stream line as a normalized session event. */
    function recordJsonLine(line: string): void {
      if (line.trim() === "") {
        return;
      }
      const parsed = parseCodexLine(line);
      sessionEvents += 1;
      recorder.text("jsonrpc", parsed.text, parsed.kind ?? undefined);
      mergeUsage(usage, parsed.usage);
    }

    recorder.started({
      model: context.model ?? run.config.model ?? null,
      cliVersion: run.version,
      effort: context.effort ?? run.config.effort ?? null,
      sandbox: context.sandbox ?? run.config.sandbox ?? null
    });
    recorder.adapterEvent("argv.recorded", {
      argc: run.argv.length,
      executable: run.executable,
      flags: run.supportedFlags.join(",")
    });

    const process = await runProcessGroup({
      executable: run.executable,
      args: run.argv,
      cwd: run.workingDirectory,
      env: { ...run.environment },
      stdinText: run.stdinPrompt ? run.promptText : undefined,
      timeoutMs: context.timeoutMs,
      signal,
      onStdoutText: (text: string): void => {
        for (const line of events.push(text)) {
          recordJsonLine(line);
        }
      },
      onStderrText: (text: string): void => {
        stderrText += text;
        for (const line of stderrLines.push(text)) {
          if (line.trim() !== "") {
            recorder.text("stderr", line);
          }
        }
      }
    });
    const trailingEvent = events.flush();
    if (trailingEvent !== null) {
      recordJsonLine(trailingEvent);
    }
    const trailingStderr = stderrLines.flush();
    if (trailingStderr !== null && trailingStderr.trim() !== "") {
      recorder.text("stderr", trailingStderr);
    }

    const final = await readFinalMessage(run, process.exitCode === 0);
    recorder.adapterEvent("final_output", {
      source: run.lastMessagePath === null ? "none" : "output-last-message",
      read: final.readStatus,
      parse: final.parseStatus
    });
    recorder.exited({
      exitCode: process.exitCode,
      signal: process.signal,
      graceful: process.graceful
    });

    const classification = classify(process, sessionEvents, stderrText, final);
    return {
      status: classification.status,
      exitCode: process.exitCode,
      signal: process.signal,
      durationMs: process.durationMs,
      ...(final.text === null ? {} : { finalText: final.text }),
      ...(final.json === undefined ? {} : { finalJson: final.json }),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      ...(classification.errorCode === undefined
        ? {}
        : { errorCode: classification.errorCode })
    };
  }

  /** Remove the adapter-owned final message file. */
  async cleanup(prepared: PreparedAgent): Promise<void> {
    const run = prepared as CodexPreparedAgent;
    if (run.lastMessagePath === null) {
      return;
    }
    await rm(run.lastMessagePath, { force: true });
  }
}

function mergeUsage(
  target: Record<string, number>,
  usage: Record<string, number> | undefined
): void {
  if (usage === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(usage)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

/** Parse one `--json` line into a normalized event. */
export function parseCodexLine(line: string): CodexLine {
  if (line.trim() === "") {
    return { kind: null, text: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unparsed", text: line };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparsed", text: line };
  }
  const record = parsed as Record<string, unknown>;
  const kind = typeof record.type === "string" ? record.type : null;
  return {
    kind,
    text: readLineText(record),
    ...(!hasUsage(record) ? {} : { usage: readUsage(record.usage) })
  };
}

function readLineText(record: Record<string, unknown>): string {
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  const item = record.item;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

function hasUsage(record: Record<string, unknown>): boolean {
  const usage = record.usage;
  return (
    typeof usage === "object" &&
    usage !== null &&
    !Array.isArray(usage) &&
    Object.keys(usage).length > 0
  );
}

function readUsage(value: unknown): Record<string, number> {
  const source = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      usage[key] = entry;
    }
  }
  return usage;
}

interface FinalMessage {
  text: string | null;
  json: unknown;
  readStatus: "ok" | "missing" | "unused";
  parseStatus: "ok" | "failed" | "skipped";
}

async function readFinalMessage(
  run: CodexPreparedAgent,
  exitedClean: boolean
): Promise<FinalMessage> {
  if (run.lastMessagePath === null) {
    return {
      text: null,
      json: undefined,
      readStatus: "unused",
      parseStatus: "skipped"
    };
  }
  try {
    const read = await readBoundedFile(
      run.lastMessagePath,
      DEFAULT_MAX_FINAL_OUTPUT_BYTES
    );
    const text = read.text.replace(/\r?\n$/, "");
    if (run.context.resultSchemaPath === undefined) {
      return {
        text,
        json: undefined,
        readStatus: "ok",
        parseStatus: "skipped"
      };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return { text, json: parsed, readStatus: "ok", parseStatus: "ok" };
    } catch {
      return { text, json: undefined, readStatus: "ok", parseStatus: "failed" };
    }
  } catch {
    return {
      text: null,
      json: undefined,
      readStatus: exitedClean ? "missing" : "unused",
      parseStatus: "skipped"
    };
  }
}

function classify(
  process: ProcessGroupResult,
  sessionEvents: number,
  stderrText: string,
  final: FinalMessage
): { status: AgentRunResult["status"]; errorCode?: string } {
  if (process.spawnError !== null) {
    return { status: "failed", errorCode: "AGENT_SPAWN_FAILED" };
  }
  if (process.timedOut) {
    return { status: "timed_out" };
  }
  if (process.cancelled) {
    return { status: "cancelled", errorCode: "AGENT_CANCELLED" };
  }
  if (process.exitCode === 0) {
    if (final.readStatus === "missing") {
      return { status: "failed", errorCode: "AGENT_OUTPUT_UNREADABLE" };
    }
    return { status: "completed" };
  }
  if (PROVIDER_FAILURE_PATTERN.test(stderrText)) {
    return { status: "provider_failed", errorCode: "AGENT_PROVIDER_FAILED" };
  }
  if (sessionEvents === 0) {
    return { status: "provider_failed", errorCode: "AGENT_STARTUP_FAILED" };
  }
  return { status: "failed", errorCode: "AGENT_EXIT_NONZERO" };
}
