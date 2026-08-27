/**
 * Agent adapter public types (specification section 21.1).
 *
 * The runner drives every agent CLI through this interface. An adapter sees
 * the run context, an event sink, and an abort signal. It never sees the
 * artifact root, the state database, the trace, behavior code, fixtures, or
 * the rubric.
 */

import { unsupported } from "@oal/core";

/** Capability flags a probe reports for one installed agent driver. */
export interface AgentCapabilities {
  nativeSystemPrompt: boolean;
  nativeOutputSchema: boolean;
  mcp: boolean;
  machineReadableTranscript: boolean;
  usageReporting: boolean;
  separateToolEnvironment: boolean;
  enforceableToolNetworkPolicy: boolean;
  sandboxModes: string[];
}

/** Minimal structural exposure descriptor the adapter needs at run time. */
export interface ExposureDescriptor {
  /** Exposure treatment (specification section 9.3). */
  readonly mode: "raw-http" | "direct-tools" | "catalog-tools";
  /** Participant-visible base URL, when the treatment serves HTTP. */
  readonly baseUrl?: string | undefined;
  /**
   * Names of credentials injected into the tool environment. Names only:
   * the adapter never receives or records credential values.
   */
  readonly credentialNames?: readonly string[] | undefined;
  /** Documentation facade base URL, when one is served. */
  readonly documentationUrl?: string | undefined;
}

/** Run context built by the runner for one trial. */
export interface AgentRunContext {
  runId: string;
  workspaceDir: string;
  syntheticHomeDir: string;
  temporaryDir: string;
  prompts: {
    instructions?: string | undefined;
    task: string;
    launch: string;
  };
  resultSchemaPath?: string | undefined;
  exposure: ExposureDescriptor;
  launcherEnvironment: Record<string, string>;
  toolEnvironment: Record<string, string>;
  toolExecutionPolicy: {
    inheritEnvironment: "none";
    allowedEnvironmentNames: string[];
    network: "mock-only" | "deny" | "advisory";
    filesystem: "workspace-only" | "read-only" | "advisory";
  };
  model?: string | undefined;
  effort?: string | undefined;
  timeoutMs: number;
  sandbox?: string | undefined;
}

/** Terminal status of one agent run. */
export type AgentRunStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "provider_failed";

/** Result of one agent run (specification section 21.1). */
export interface AgentRunResult {
  status:
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "provider_failed";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  finalText?: string;
  finalJson?: unknown;
  usage?: Record<string, number>;
  errorCode?: string;
}

/** Adapter configuration. Concrete adapters extend this base. */
export interface AgentConfig {
  /** Model identifier handed to the driver when it supports one. */
  readonly model?: string | undefined;
  /** Reasoning effort label handed to the driver when it supports one. */
  readonly effort?: string | undefined;
  /** Sandbox mode label handed to the driver when it supports one. */
  readonly sandbox?: string | undefined;
  /**
   * Launcher environment names the driver needs to start. The adapter copies
   * only these names from the launcher environment. It never merges the two
   * environments wholesale.
   */
  readonly launcherEnvironmentNames?: readonly string[] | undefined;
}

/** Whether the adapter enforces a policy or only advises it. */
export type AgentEnforcement = "enforced" | "advisory";

/** Outcome of a capability probe. */
export type AgentProbeStatus = "available" | "unsupported" | "unavailable";

/** Result of probing an installed driver without a paid run. */
export interface AgentProbe {
  readonly status: AgentProbeStatus;
  /** Reported executable or SDK version, when the probe could read one. */
  readonly version: string | null;
  readonly capabilities: AgentCapabilities;
  /**
   * Launcher environment names the driver needs. Run metadata records these
   * names, never their values.
   */
  readonly launcherEnvironmentNames: readonly string[];
  /** Whether launcher and tool environments are hard separated. */
  readonly environmentSeparation: AgentEnforcement;
  /** Whether the tool network policy is enforced or advisory. */
  readonly toolNetworkPolicy: AgentEnforcement;
  /** Stable error code, when the probe did not succeed. */
  readonly errorCode?: string | undefined;
  /** Short secret-free reason, when the probe did not succeed. */
  readonly error?: string | undefined;
  /** Secret-free probe facts such as a help digest or missing flags. */
  readonly details?: Readonly<Record<string, string>> | undefined;
}

/**
 * Preparation state for one run. `argv` is the exact effective argv after
 * secret-free expansion; the adapter records it unchanged.
 */
export interface PreparedAgent {
  readonly runId: string;
  readonly adapter: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  /** Environment applied to the spawned driver process. */
  readonly environment: Readonly<Record<string, string>>;
  /** Launcher names actually copied into the spawn environment. */
  readonly launcherEnvironmentApplied: readonly string[];
}

/** One normalized session event record (schemas/agent-event.v1.schema.json). */
export interface AgentSessionEvent {
  readonly schema_version: 1;
  readonly type: "agent.started" | "agent.session_event" | "agent.exited";
  readonly event_id: string;
  readonly sequence: number;
  readonly observed_at: string;
  readonly run_id: string;
  readonly adapter: string;
  readonly payload:
    | AgentStartedPayload
    | AgentStreamPayload
    | AgentExitedPayload;
  readonly extensions: Readonly<Record<string, unknown>>;
}

/** Payload of an `agent.started` event. */
export interface AgentStartedPayload {
  readonly model: string | null;
  readonly cli_version?: string | null | undefined;
  readonly effort?: string | null | undefined;
  readonly sandbox?: string | null | undefined;
}

/** Payload of an `agent.session_event` event. */
export interface AgentStreamPayload {
  readonly channel: "stdout" | "stderr" | "jsonrpc" | "adapter";
  /**
   * True when redaction changed the recorded text. Every preview passes the
   * redaction pipeline before it is recorded, so a false value means the text
   * was clean, not that it skipped redaction.
   */
  readonly redacted: boolean;
  readonly bytes?: number | null | undefined;
  readonly sha256?: string | null | undefined;
  readonly preview?: string | null | undefined;
  /** Adapter-declared machine-readable session event kind. */
  readonly kind?: string | null | undefined;
}

/** Payload of an `agent.exited` event. */
export interface AgentExitedPayload {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly graceful?: boolean | undefined;
}

/** Function that removes credential material from text. */
export type TextRedactor = (text: string) => string;

/** Sink that receives normalized, already-redacted session events. */
export interface AgentEventSink {
  emit(event: AgentSessionEvent): void;
  /**
   * Redaction hook the adapter must apply to text before it is recorded.
   * When absent, the adapter falls back to its own secret scrub.
   */
  readonly redact?: TextRedactor | undefined;
}

/** The adapter interface every concrete adapter implements. */
export interface AgentAdapter {
  readonly id: string;
  probe(config: AgentConfig): Promise<AgentProbe>;
  prepare(context: AgentRunContext): Promise<PreparedAgent>;
  run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult>;
  cleanup?(prepared: PreparedAgent): Promise<void>;
}

/** Preflight error code from specification section 21.4. */
export const AGENT_CAPABILITY_UNSUPPORTED = "AGENT_CAPABILITY_UNSUPPORTED";

/** Error codes this API guarantees across adapters. */
export const AGENT_ERROR_CODES = [
  AGENT_CAPABILITY_UNSUPPORTED,
  "AGENT_SPAWN_FAILED",
  "AGENT_EXIT_NONZERO",
  "AGENT_STARTUP_FAILED",
  "AGENT_PROVIDER_FAILED",
  "AGENT_OUTPUT_UNREADABLE",
  "AGENT_CANCELLED"
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/**
 * Turn a failed probe into a preflight error. Callers run this before any
 * paid work so an unsupported driver stops the batch early.
 */
export function assertAgentProbeUsable(probe: AgentProbe): void {
  if (probe.status === "available") {
    return;
  }
  const code = probe.errorCode ?? AGENT_CAPABILITY_UNSUPPORTED;
  const reason = probe.error ?? "the agent driver is not usable";
  const details: Record<string, string> = {
    adapter_status: probe.status,
    version: probe.version ?? ""
  };
  for (const [key, value] of Object.entries(probe.details ?? {})) {
    details[key] = value;
  }
  throw unsupported(code, `Agent probe failed: ${reason}`, details);
}
