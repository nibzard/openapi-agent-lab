/**
 * Generic command adapter (specification section 21.3).
 *
 * The adapter runs one configured executable with a fixed argv template. It
 * never builds a shell command, passes only the tool environment plus the
 * declared launcher names, and streams normalized session events while the
 * child runs.
 */

import { access, constants, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  argvTokenSourceFromContext,
  buildSpawnEnvironment,
  DEFAULT_MAX_FINAL_OUTPUT_BYTES,
  expandArgv,
  LineAssembler,
  readBoundedFile,
  runProcessGroup,
  SessionEventRecorder,
  type AgentAdapter,
  type AgentConfig,
  type AgentEventSink,
  type AgentProbe,
  type AgentRunContext,
  type AgentRunResult,
  type PreparedAgent,
  type ProcessGroupResult
} from "@oal/agent-adapter";

import {
  validateGenericConfig,
  type GenericAgentConfig,
  type WorkingDirectoryPolicy
} from "./config.ts";
import { createTranscriptParser, type TranscriptEvent } from "./transcript.ts";

/** Default probe timeout in milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10000;

/** Environment used for the probe command. It carries no credentials. */
const PROBE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmpdir()
};

/** Preparation state of one generic run. */
export interface GenericPreparedAgent extends PreparedAgent {
  readonly context: AgentRunContext;
  readonly config: GenericAgentConfig;
  readonly stdinText: string | null;
  /** Absolute path of the final-output file, when the source is a file. */
  readonly finalOutputPath: string | null;
  readonly usedTokens: readonly string[];
}

function workingDirectoryFor(
  policy: WorkingDirectoryPolicy,
  context: AgentRunContext
): string {
  switch (policy) {
    case "temporary":
      return context.temporaryDir;
    case "home":
      return context.syntheticHomeDir;
    default:
      return context.workspaceDir;
  }
}

function stdinTextFor(
  policy: GenericAgentConfig["stdin"],
  context: AgentRunContext
): string | null {
  switch (policy) {
    case "launch-text":
      return context.prompts.launch;
    case "task-text":
      return context.prompts.task;
    default:
      return null;
  }
}

/** Merge the run-independent fields of a probe-time configuration. */
function mergeConfig(
  own: GenericAgentConfig,
  override: AgentConfig
): GenericAgentConfig {
  return {
    ...own,
    model: override.model ?? own.model,
    effort: override.effort ?? own.effort,
    sandbox: override.sandbox ?? own.sandbox,
    launcherEnvironmentNames:
      override.launcherEnvironmentNames ?? own.launcherEnvironmentNames
  };
}

/**
 * Adapter for any local agent command with a declared argv template. Build
 * one per configuration; the object holds no per-run state.
 */
export class GenericCommandAdapter implements AgentAdapter {
  readonly id: string;
  private readonly own: GenericAgentConfig;

  constructor(config: GenericAgentConfig) {
    this.own = validateGenericConfig(config);
    this.id = config.id ?? "generic";
  }

  async probe(config: AgentConfig = {}): Promise<AgentProbe> {
    const effective = validateGenericConfig(mergeConfig(this.own, config));
    const launcherNames = [...(effective.launcherEnvironmentNames ?? [])];
    const base = {
      capabilities: effective.capabilities,
      launcherEnvironmentNames: launcherNames,
      environmentSeparation: separationFor(launcherNames),
      toolNetworkPolicy: "advisory" as const
    };
    if (!(await pathIsExecutable(effective.executablePath))) {
      return {
        ...base,
        status: "unavailable",
        version: null,
        errorCode: "AGENT_EXECUTABLE_MISSING",
        error: "the configured executable is missing or not executable"
      };
    }
    const probeArgs = effective.probeArgs ?? [];
    let version: string | null = null;
    if (probeArgs.length > 0) {
      const probed = await runProcessGroup({
        executable: effective.executablePath,
        args: probeArgs,
        cwd: tmpdir(),
        env: PROBE_ENV,
        timeoutMs: DEFAULT_PROBE_TIMEOUT_MS
      });
      if (!probed.spawned) {
        return {
          ...base,
          status: "unavailable",
          version: null,
          errorCode: "AGENT_SPAWN_FAILED",
          error: "the probe command could not be started"
        };
      }
      version = firstLine(probed.stdout) ?? firstLine(probed.stderr);
    }
    return {
      ...base,
      status: "available",
      version,
      ...(version === null ? {} : { details: { probe_version_line: version } })
    };
  }

  /**
   * Validate the run context and expand the declared tokens into the exact
   * effective argv. Preparation reads directories and creates no files.
   */
  async prepare(context: AgentRunContext): Promise<GenericPreparedAgent> {
    const config = validateGenericConfig(this.own);
    await assertDirectory(context.workspaceDir, "workspaceDir");
    await assertDirectory(context.syntheticHomeDir, "syntheticHomeDir");
    await assertDirectory(context.temporaryDir, "temporaryDir");
    const source = argvTokenSourceFromContext(context);
    const expansion = expandArgv(config.args ?? [], source);
    const finalPath = expandFinalOutputPath(config, source);
    const spawn = buildSpawnEnvironment(
      context,
      config.launcherEnvironmentNames ?? []
    );
    return {
      runId: context.runId,
      adapter: this.id,
      executable: config.executablePath,
      argv: expansion.argv,
      workingDirectory: workingDirectoryFor(config.workingDirectory, context),
      environment: spawn.env,
      launcherEnvironmentApplied: spawn.appliedLauncherNames,
      context,
      config,
      stdinText: stdinTextFor(config.stdin, context),
      finalOutputPath: finalPath,
      usedTokens: expansion.usedTokens
    };
  }

  async run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const run = prepared as GenericPreparedAgent;
    const { context, config } = run;
    const recorder = new SessionEventRecorder({
      runId: context.runId,
      adapter: this.id,
      sink
    });
    const parser = createTranscriptParser(config.transcript);
    const usage: Record<string, number> = {};
    const rawStdout = rawLineEmitter(recorder, "stdout");
    const rawStderr = rawLineEmitter(recorder, "stderr");

    recorder.started({
      model: context.model ?? config.model ?? null,
      effort: context.effort ?? config.effort ?? null,
      sandbox: context.sandbox ?? config.sandbox ?? null,
      cliVersion: null
    });
    recorder.adapterEvent("argv.recorded", {
      argc: run.argv.length,
      executable: run.executable,
      tokens: run.usedTokens.join(",")
    });

    const emitTranscript = (events: readonly TranscriptEvent[]): void => {
      for (const event of events) {
        if (event.kind !== null || event.text !== "") {
          recorder.text(
            config.transcript.kind === "json-events"
              ? "jsonrpc"
              : config.transcript.stream,
            event.text,
            event.kind ?? undefined
          );
        }
        mergeUsage(usage, event.usage);
      }
    };
    const onTranscriptText = (text: string): void => {
      emitTranscript(parser.push(text));
    };

    const process = await runProcessGroup({
      executable: run.executable,
      args: run.argv,
      cwd: run.workingDirectory,
      env: { ...run.environment },
      stdinText: run.stdinText ?? undefined,
      timeoutMs: context.timeoutMs,
      signal,
      onStdoutText:
        config.transcript.stream === "stdout" ? onTranscriptText : rawStdout,
      onStderrText:
        config.transcript.stream === "stderr" ? onTranscriptText : rawStderr
    });

    const trailing = parser.flush();
    if (trailing !== null) {
      emitTranscript([trailing]);
    }

    const final = await readFinalOutput(
      process,
      context,
      config,
      run.finalOutputPath
    );
    recorder.adapterEvent("final_output", {
      source: config.finalOutput.source,
      parse: final.parseStatus
    });
    // The exit record stays last so a consumer can treat it as terminal.
    recorder.exited({
      exitCode: process.exitCode,
      signal: process.signal,
      graceful: process.graceful
    });

    const classification = classify(process, config);
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

  /**
   * Remove the final-output file when the adapter owns it, that is when it
   * lives inside the run temporary directory. Participant workspace files
   * are evidence and stay in place.
   */
  async cleanup(prepared: PreparedAgent): Promise<void> {
    const run = prepared as GenericPreparedAgent;
    const path = run.finalOutputPath;
    if (path === null) {
      return;
    }
    if (!path.startsWith(`${run.context.temporaryDir}/`)) {
      return;
    }
    await rm(path, { force: true });
  }
}

function rawLineEmitter(
  recorder: SessionEventRecorder,
  channel: "stdout" | "stderr"
): (text: string) => void {
  const assembler = new LineAssembler();
  return (text: string): void => {
    for (const line of assembler.push(text)) {
      recorder.text(channel, line);
    }
  };
}

function expandFinalOutputPath(
  config: GenericAgentConfig,
  source: ReturnType<typeof argvTokenSourceFromContext>
): string | null {
  if (config.finalOutput.source !== "file-at-path") {
    return null;
  }
  const template = config.finalOutput.path;
  if (template === undefined) {
    return null;
  }
  return expandArgv([template], source).argv[0] ?? null;
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

function separationFor(
  launcherNames: readonly string[]
): AgentProbe["environmentSeparation"] {
  return launcherNames.length === 0 ? "enforced" : "advisory";
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return null;
}

async function pathIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(path: string, what: string): Promise<void> {
  const info = await stat(path).catch((): null => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(`${what} is not a directory: ${path}`);
  }
}

interface FinalOutput {
  text: string | null;
  json: unknown;
  parseStatus: "ok" | "failed" | "skipped";
}

async function readFinalOutput(
  process: ProcessGroupResult,
  context: AgentRunContext,
  config: GenericAgentConfig,
  finalOutputPath: string | null
): Promise<FinalOutput> {
  let text: string | null = null;
  let readFailed = false;
  if (config.finalOutput.source === "stdout-last-line") {
    text = lastNonEmptyLine(process.stdout);
  } else if (config.finalOutput.source === "file-at-path") {
    if (finalOutputPath !== null) {
      try {
        const read = await readBoundedFile(
          finalOutputPath,
          DEFAULT_MAX_FINAL_OUTPUT_BYTES
        );
        text = read.text.replace(/\r?\n$/, "");
      } catch {
        readFailed = true;
      }
    }
  }
  if (readFailed) {
    return { text: null, json: undefined, parseStatus: "failed" };
  }
  if (text === null || context.resultSchemaPath === undefined) {
    return { text, json: undefined, parseStatus: "skipped" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { text, json: parsed, parseStatus: "ok" };
  } catch {
    return { text, json: undefined, parseStatus: "failed" };
  }
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && line.trim() !== "") {
      return line;
    }
  }
  return null;
}

function classify(
  process: ProcessGroupResult,
  config: GenericAgentConfig
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
    return { status: "completed" };
  }
  const infrastructure = config.infrastructureExitCodes ?? [];
  if (process.exitCode !== null && infrastructure.includes(process.exitCode)) {
    return { status: "provider_failed", errorCode: "AGENT_PROVIDER_FAILED" };
  }
  return { status: "failed", errorCode: "AGENT_EXIT_NONZERO" };
}
