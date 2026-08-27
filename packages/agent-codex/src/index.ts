/**
 * Reference Codex CLI adapter (specification section 21.4).
 */

export const packageName = "@oal/agent-codex";

export {
  DEFAULT_CODEX_SANDBOX,
  OPTIONAL_CODEX_FLAGS,
  REQUIRED_CODEX_FLAGS
} from "./config.ts";
export type { CodexAgentConfig } from "./config.ts";

export {
  codexCapabilities,
  DEFAULT_CODEX_PROBE_TIMEOUT_MS,
  mergeCodexConfig,
  probeCodexCli
} from "./probe.ts";
export type { CodexFlagSet, CodexProbeResult } from "./probe.ts";

export {
  buildCodexArgv,
  CodexCliAdapter,
  composePrompt,
  LAST_MESSAGE_NAME,
  parseCodexLine
} from "./adapter.ts";
export type { CodexPreparedAgent } from "./adapter.ts";
