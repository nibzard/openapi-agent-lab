/**
 * Agent adapter public API (specification section 21).
 */

export const packageName = "@oal/agent-adapter";

export {
  AGENT_CAPABILITY_UNSUPPORTED,
  AGENT_ERROR_CODES,
  assertAgentProbeUsable
} from "./types.ts";
export type {
  AgentAdapter,
  AgentCapabilities,
  AgentConfig,
  AgentEnforcement,
  AgentErrorCode,
  AgentEventSink,
  AgentExitedPayload,
  AgentProbe,
  AgentProbeStatus,
  AgentRunContext,
  AgentRunResult,
  AgentRunStatus,
  AgentSessionEvent,
  AgentStartedPayload,
  AgentStreamPayload,
  ExposureDescriptor,
  PreparedAgent,
  TextRedactor
} from "./types.ts";

export {
  ARGV_TOKEN_NAMES,
  ARGV_TOKEN_PATTERN,
  ARGV_TOKEN_UNKNOWN,
  ARGV_TOKEN_UNRESOLVED,
  argvTokenSourceFromContext,
  expandArgument,
  expandArgv,
  listArgumentTokens
} from "./argv.ts";
export type { ArgvExpansion, ArgvTokenName, ArgvTokenSource } from "./argv.ts";

export {
  collectingSink,
  createSecretRedactor,
  DEFAULT_MAX_PREVIEW_CHARS,
  identityRedactor,
  REDACTED_MARKER,
  SessionEventRecorder,
  validateAgentSessionEvent
} from "./events.ts";
export type { SessionEventRecorderOptions } from "./events.ts";

export {
  BoundedCapture,
  buildSpawnEnvironment,
  DEFAULT_DRAIN_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_MAX_FINAL_OUTPUT_BYTES,
  descendantPids,
  LineAssembler,
  readBoundedFile,
  runProcessGroup,
  signalTree
} from "./process.ts";
export type {
  BoundedFileRead,
  ProcessGroupOptions,
  ProcessGroupResult,
  SpawnEnvironment
} from "./process.ts";
