/**
 * Generic command adapter configuration (specification section 21.3).
 *
 * The configuration names an executable and a fixed argv template. It never
 * carries a shell snippet: path fields are rejected when they contain shell
 * metacharacters, and prompt text reaches the child as one argv element or
 * through stdin.
 */

import { invalidInput } from "@oal/core";
import type { AgentCapabilities, AgentConfig } from "@oal/agent-adapter";

/** Error code for a configuration the adapter refuses to run. */
export const GENERIC_CONFIG_INVALID = "AGENT_CONFIG_INVALID";

/** Shell metacharacters a path field must not contain. */
const SHELL_METACHARACTERS = /[;&|`$<>!{}[\]"'\\\n\r\t]/;

/**
 * Metacharacters a path template must not contain. Braces stay allowed
 * because they carry the declared placeholder tokens.
 */
const TEMPLATE_METACHARACTERS = /[;&|`$<>![\]"'\\\n\r\t]/;

/** How the transcript stream is parsed. */
export type TranscriptKind = "json-events" | "ndjson" | "text-tail";

export interface TranscriptConfig {
  /**
   * `json-events` reads one object per line and extracts kind, text, and
   * usage. `ndjson` records each line as bounded text. `text-tail` records
   * plain text lines.
   */
  readonly kind: TranscriptKind;
  /** Stream the parser consumes. */
  readonly stream: "stdout" | "stderr";
  /** Bound on parsed events. Default 1000. */
  readonly maxEvents?: number | undefined;
}

/** Where the participant's final answer comes from. */
export type FinalOutputSource = "stdout-last-line" | "file-at-path" | "none";

export interface FinalOutputConfig {
  readonly source: FinalOutputSource;
  /**
   * Path template for `file-at-path`. May name the declared path tokens and
   * stays exactly one argv element.
   */
  readonly path?: string | undefined;
}

/** Which directory the child runs in. */
export type WorkingDirectoryPolicy = "workspace" | "temporary" | "home";

/** What the adapter writes to the child's stdin. */
export type StdinPolicy = "none" | "launch-text" | "task-text";

export interface GenericAgentConfig extends AgentConfig {
  /** Absolute path to the executable. */
  readonly executablePath: string;
  /** Fixed argument template. Each element stays one argument. */
  readonly args?: readonly string[] | undefined;
  readonly workingDirectory: WorkingDirectoryPolicy;
  readonly stdin: StdinPolicy;
  readonly transcript: TranscriptConfig;
  readonly finalOutput: FinalOutputConfig;
  /** Capability declaration supplied by the configuration. */
  readonly capabilities: AgentCapabilities;
  /** Probe command, for example `["--version"]`. Optional. */
  readonly probeArgs?: readonly string[] | undefined;
  /** Exit codes that mean infrastructure, not an agent answer. */
  readonly infrastructureExitCodes?: readonly number[] | undefined;
  /** Adapter identifier recorded with every session event. */
  readonly id?: string | undefined;
}

/**
 * Validate one configuration. Path fields are checked for shell
 * metacharacters so no configuration can smuggle a shell command into a place
 * where the adapter expects a path.
 */
export function validateGenericConfig(
  config: GenericAgentConfig
): GenericAgentConfig {
  const failures: string[] = [];
  if (config.args === undefined || config.args.length === 0) {
    failures.push("args must name at least one argument");
  }
  if (typeof config.executablePath !== "string") {
    failures.push("executablePath must be a string");
  } else {
    if (!config.executablePath.startsWith("/")) {
      failures.push("executablePath must be absolute");
    }
    failures.push(
      ...checkPathField(
        config.executablePath,
        "executablePath",
        SHELL_METACHARACTERS
      )
    );
  }
  if (
    config.finalOutput.source === "file-at-path" &&
    typeof config.finalOutput.path !== "string"
  ) {
    failures.push("finalOutput.path is required for file-at-path");
  }
  if (
    config.finalOutput.source !== "file-at-path" &&
    config.finalOutput.path !== undefined
  ) {
    failures.push("finalOutput.path is only valid for file-at-path");
  }
  if (typeof config.finalOutput.path === "string") {
    failures.push(
      ...checkPathField(
        config.finalOutput.path,
        "finalOutput.path",
        TEMPLATE_METACHARACTERS
      )
    );
  }
  if (failures.length > 0) {
    throw invalidInput(
      GENERIC_CONFIG_INVALID,
      `The generic adapter configuration is invalid: ${failures.join("; ")}.`,
      { failures }
    );
  }
  return config;
}

/**
 * Reject a path field that carries shell syntax or control characters. The
 * forbidden class comes from the caller, so a token template can keep braces.
 */
function checkPathField(
  value: string,
  field: string,
  forbidden: RegExp
): string[] {
  const failures: string[] = [];
  if (forbidden.test(value)) {
    failures.push(`${field} contains shell metacharacters`);
  }
  if (value.includes("\0")) {
    failures.push(`${field} contains a null byte`);
  }
  if (value.includes("..")) {
    failures.push(`${field} must not contain a parent reference`);
  }
  return failures;
}
