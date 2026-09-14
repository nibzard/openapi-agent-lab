/**
 * Codex CLI adapter configuration (specification section 21.4).
 */

import type { AgentConfig } from "@oal/agent-adapter";

/** Sandbox mode used when the run context declares none. */
export const DEFAULT_CODEX_SANDBOX = "workspace-write";

/** Flags the adapter cannot run without. */
export const REQUIRED_CODEX_FLAGS = [
  "--json",
  "--output-last-message"
] as const;

/**
 * Launcher names the adapter declares when the caller passes none. Codex
 * 0.154 authenticates non-interactive runs from CODEX_API_KEY or an
 * auth.json under CODEX_HOME; it ignores OPENAI_API_KEY. An explicit
 * declaration, including an empty list, replaces this default.
 */
export const DEFAULT_CODEX_LAUNCHER_ENVIRONMENT_NAMES = [
  "CODEX_API_KEY"
] as const;

/** Flags the adapter uses whenever the installed CLI reports them. */
export const OPTIONAL_CODEX_FLAGS = [
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--sandbox",
  "--skip-git-repo-check",
  "-C",
  "--model",
  "-c"
] as const;

export interface CodexAgentConfig extends AgentConfig {
  /**
   * Executable path. Defaults to `codex` on PATH. Tests inject a fake CLI
   * here because the real binary may be absent.
   */
  readonly executablePath?: string | undefined;
  /** Extra flags the run profile requires. They join the required set. */
  readonly requiredFlags?: readonly string[] | undefined;
  /** Sandbox mode used when the run context declares none. */
  readonly defaultSandbox?: string | undefined;
  /**
   * Pass `--skip-git-repo-check`. Default true, because the participant
   * workspace is initialized by the runner, not by git.
   */
  readonly skipGitRepoCheck?: boolean | undefined;
  /** Adapter identifier recorded with every session event. */
  readonly id?: string | undefined;
  /** Timeout for the probe commands in milliseconds. */
  readonly probeTimeoutMs?: number | undefined;
}
