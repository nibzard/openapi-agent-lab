/**
 * Generic argv-based agent adapter (specification section 21.3).
 */

export const packageName = "@oal/agent-generic";

export { GENERIC_CONFIG_INVALID, validateGenericConfig } from "./config.ts";
export type {
  FinalOutputConfig,
  FinalOutputSource,
  GenericAgentConfig,
  StdinPolicy,
  TranscriptConfig,
  TranscriptKind,
  WorkingDirectoryPolicy
} from "./config.ts";

export {
  createTranscriptParser,
  DEFAULT_MAX_TRANSCRIPT_EVENTS
} from "./transcript.ts";
export type { TranscriptEvent, TranscriptParser } from "./transcript.ts";

export { DEFAULT_PROBE_TIMEOUT_MS, GenericCommandAdapter } from "./adapter.ts";
export type { GenericPreparedAgent } from "./adapter.ts";
