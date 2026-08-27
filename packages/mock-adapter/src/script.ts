/**
 * Script vocabulary for the in-process mock agent (specification section 21).
 *
 * A script is a fixed list of behaviors. The mock performs them in order, so
 * two runs of the same script produce the same session events, the same
 * workspace files, and the same final output. No model is called.
 */

import type { AgentCapabilities } from "@oal/agent-adapter";

/** One stream line the mock emits as a session event. */
export interface MockEventSpec {
  /** Channel the line is recorded on. */
  readonly channel: "stdout" | "stderr" | "jsonrpc" | "adapter";
  /** Text of the line. The sink redactor runs before the text is stored. */
  readonly text: string;
  /** Machine-readable kind recorded with the line. */
  readonly kind?: string | undefined;
  /** Pause before this line, in milliseconds. */
  readonly delayMs?: number | undefined;
}

/** One file the mock writes inside the participant workspace. */
export interface MockFileSpec {
  /** Path relative to the workspace root. It cannot escape the workspace. */
  readonly path: string;
  readonly content: string;
}

/** One HTTP request the mock sends to the exposure base URL. */
export interface MockRequestSpec {
  /** Path appended to the exposure base URL. It must start with a slash. */
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  /**
   * Name of the credential in the tool environment. When set, the value is
   * sent as a bearer token. The value is never recorded in any event.
   */
  readonly credentialName?: string | undefined;
  /** JSON body sent with the request. */
  readonly body?: unknown;
  /** Status the mock expects. Any other status fails the run. */
  readonly expectStatus?: number | undefined;
  /** Pause before this request, in milliseconds. */
  readonly delayMs?: number | undefined;
}

/** The full script of one mock run. */
export interface MockAgentScript {
  readonly events?: readonly MockEventSpec[] | undefined;
  readonly files?: readonly MockFileSpec[] | undefined;
  readonly requests?: readonly MockRequestSpec[] | undefined;
  /** Final message the run reports. */
  readonly finalText?: string | undefined;
  /** Usage totals the run reports. */
  readonly usage?: Readonly<Record<string, number>> | undefined;
  /**
   * Status the run reports. Defaults to `completed`. A script can force
   * `failed`, `timed_out`, `cancelled`, or `provider_failed`.
   */
  readonly status?:
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "provider_failed"
    | undefined;
  /** Exit code the run reports. Defaults to 0. */
  readonly exitCode?: number | undefined;
  /** Simulated work time in milliseconds. Defaults to 0. */
  readonly durationMs?: number | undefined;
}

/** Adapter configuration. */
export interface MockAgentConfig extends MockAgentScript {
  /** Capabilities the probe declares. */
  readonly capabilities?: AgentCapabilities | undefined;
  /** Model name recorded in the `agent.started` event. */
  readonly model?: string | undefined;
  /** Adapter identifier recorded with every session event. */
  readonly id?: string | undefined;
}

/** Capabilities used when the configuration declares none. */
export const DEFAULT_MOCK_CAPABILITIES: AgentCapabilities = {
  nativeSystemPrompt: true,
  nativeOutputSchema: false,
  mcp: false,
  machineReadableTranscript: true,
  usageReporting: true,
  separateToolEnvironment: true,
  enforceableToolNetworkPolicy: true,
  sandboxModes: []
};

/** Version line the probe reports. */
export const MOCK_ADAPTER_VERSION =
  "oal-mock-agent 1.0.0 (in-process, no model)";

/** Default adapter identifier. */
export const DEFAULT_MOCK_ADAPTER_ID = "mock-agent";

/** Reason a script was rejected before the run started. */
export const MOCK_SCRIPT_INVALID = "MOCK_SCRIPT_INVALID";

/** A request returned a status the script did not declare. */
export const MOCK_HTTP_STATUS_MISMATCH = "MOCK_HTTP_STATUS_MISMATCH";

/** A request could not be completed. */
export const MOCK_HTTP_REQUEST_FAILED = "MOCK_HTTP_REQUEST_FAILED";
