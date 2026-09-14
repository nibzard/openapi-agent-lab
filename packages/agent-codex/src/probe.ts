/**
 * Codex CLI feature probe (specification section 21.4).
 *
 * The probe runs `codex --version` and `codex exec --help`, records the
 * version and a digest of the help text, and verifies every required flag.
 * A missing flag fails preflight with AGENT_CAPABILITY_UNSUPPORTED.
 */

import { sha256Hex } from "@oal/core";
import {
  AGENT_CAPABILITY_UNSUPPORTED,
  runProcessGroup,
  type AgentCapabilities,
  type AgentConfig,
  type AgentProbe
} from "@oal/agent-adapter";
import { tmpdir } from "node:os";

import {
  DEFAULT_CODEX_LAUNCHER_ENVIRONMENT_NAMES,
  DEFAULT_CODEX_SANDBOX,
  OPTIONAL_CODEX_FLAGS,
  REQUIRED_CODEX_FLAGS
} from "./config.ts";
import type { CodexAgentConfig } from "./config.ts";

/** Help-text marker for the stdin prompt convention. */
const STDIN_PROMPT_PATTERN = /stdin/i;

/** Default probe timeout in milliseconds. */
export const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 15000;

/** Environment for the probe commands. It carries no credentials. */
const PROBE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmpdir()
};

/** Capabilities the reference adapter claims for a supported CLI. */
export function codexCapabilities(
  supported: readonly string[]
): AgentCapabilities {
  return {
    nativeSystemPrompt: true,
    nativeOutputSchema: supported.includes("--output-schema"),
    mcp: true,
    machineReadableTranscript: supported.includes("--json"),
    usageReporting: true,
    separateToolEnvironment: false,
    enforceableToolNetworkPolicy: supported.includes("--sandbox"),
    sandboxModes: ["read-only", "workspace-write", "danger-full-access"]
  };
}

export interface CodexProbeResult extends AgentProbe {
  /** Flags the installed CLI reports in `codex exec --help`. */
  readonly supportedFlags: readonly string[];
  /** Digest of the help text the probe read. */
  readonly helpDigest: string | null;
  /** Whether the help text documents reading the prompt from stdin. */
  readonly stdinPrompt: boolean;
}

/** Flags used to build the argv for one run. */
export interface CodexFlagSet {
  readonly supported: readonly string[];
  readonly sandboxDefault: string;
}

/**
 * Probe the installed CLI. The probe makes no provider call and starts no
 * session.
 */
export async function probeCodexCli(
  config: CodexAgentConfig
): Promise<CodexProbeResult> {
  const executable = config.executablePath ?? "codex";
  const timeoutMs = config.probeTimeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS;
  // the declared credential names; an explicit list replaces the default
  const launcherNames = [
    ...(config.launcherEnvironmentNames ??
      DEFAULT_CODEX_LAUNCHER_ENVIRONMENT_NAMES)
  ];
  const versionRun = await runProcessGroup({
    executable,
    args: ["--version"],
    cwd: tmpdir(),
    env: PROBE_ENV,
    timeoutMs
  });
  const helpRun = await runProcessGroup({
    executable,
    args: ["exec", "--help"],
    cwd: tmpdir(),
    env: PROBE_ENV,
    timeoutMs
  });
  const failed =
    versionRun.spawnError !== null ||
    helpRun.spawnError !== null ||
    versionRun.exitCode !== 0 ||
    helpRun.exitCode !== 0;
  if (failed) {
    return {
      status: "unavailable",
      version: null,
      capabilities: codexCapabilities([]),
      launcherEnvironmentNames: launcherNames,
      environmentSeparation: "advisory",
      toolNetworkPolicy: "advisory",
      errorCode: "AGENT_EXECUTABLE_MISSING",
      error: "codex --version or codex exec --help did not succeed",
      helpDigest: null,
      supportedFlags: [],
      stdinPrompt: false
    };
  }
  const helpText = helpRun.stdout;
  const supported = [...OPTIONAL_CODEX_FLAGS, ...REQUIRED_CODEX_FLAGS].filter(
    (flag) => helpText.includes(flag)
  );
  const required = [
    ...REQUIRED_CODEX_FLAGS,
    ...(config.requiredFlags ?? [])
  ].filter((flag, index, all) => all.indexOf(flag) === index);
  const missing = required.filter((flag) => !helpText.includes(flag));
  if (missing.length > 0) {
    return {
      status: "unsupported",
      version: firstLine(versionRun.stdout) ?? firstLine(versionRun.stderr),
      capabilities: codexCapabilities(supported),
      launcherEnvironmentNames: launcherNames,
      environmentSeparation: "advisory",
      toolNetworkPolicy: "advisory",
      errorCode: AGENT_CAPABILITY_UNSUPPORTED,
      error: `the installed codex CLI lacks required flags: ${missing.join(", ")}`,
      details: {
        help_digest: sha256Hex(helpText),
        missing_flags: missing.join(","),
        supported_flags: supported.join(",")
      },
      helpDigest: sha256Hex(helpText),
      supportedFlags: supported,
      stdinPrompt: STDIN_PROMPT_PATTERN.test(helpText)
    };
  }
  return {
    status: "available",
    version: firstLine(versionRun.stdout) ?? firstLine(versionRun.stderr),
    capabilities: codexCapabilities(supported),
    launcherEnvironmentNames: launcherNames,
    environmentSeparation: "advisory",
    toolNetworkPolicy: supported.includes("--sandbox")
      ? "enforced"
      : "advisory",
    details: {
      help_digest: sha256Hex(helpText),
      supported_flags: supported.join(",")
    },
    helpDigest: sha256Hex(helpText),
    supportedFlags: supported,
    stdinPrompt: STDIN_PROMPT_PATTERN.test(helpText)
  };
}

/** Resolve the effective configuration from a constructor config and a probe. */
export function mergeCodexConfig(
  own: CodexAgentConfig,
  override: AgentConfig
): CodexAgentConfig {
  return {
    ...own,
    model: override.model ?? own.model,
    effort: override.effort ?? own.effort,
    sandbox: override.sandbox ?? own.sandbox,
    // an explicit declaration, including the empty list, replaces the
    // adapter default; only an absent one falls through
    launcherEnvironmentNames:
      override.launcherEnvironmentNames ??
      own.launcherEnvironmentNames ??
      DEFAULT_CODEX_LAUNCHER_ENVIRONMENT_NAMES,
    defaultSandbox: own.defaultSandbox ?? DEFAULT_CODEX_SANDBOX
  };
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return null;
}
