/**
 * Run profile model from specification section 12.4. A run profile
 * describes one homogeneous execution cell. It contains no hidden
 * business assertions.
 */

export const RUN_PROFILE_KIND = "RunProfile" as const;
export const RUN_PROFILE_API_VERSION = "agentlab.dev/v1" as const;

export type AgentAdapterKind = "codex-cli" | "generic";
export type AgentSandboxMode =
  | "danger-full-access"
  | "workspace-write"
  | "read-only";

export interface AgentProfile {
  adapter: AgentAdapterKind;
  /** Model identifier supplied by the operator or environment. */
  model: string | null;
  effort: "low" | "medium" | "high" | "xhigh" | null;
  sandbox: AgentSandboxMode | null;
}

export type ExposureMode = "raw-http" | "direct-tools" | "catalog-tools";
export type ContractVisibility = "none" | "file" | "discoverable";
export type DataPlaneScope = "all" | "task";

export interface ExposureProfile {
  mode: ExposureMode;
  contract_visibility: ContractVisibility;
  data_plane_scope: DataPlaneScope;
  /** Documentation profile ID, or null when visibility is not discoverable. */
  documentation_profile: string | null;
}

export interface ExecutionProfile {
  count: number;
  parallel: number;
  timeout_ms: number;
  cohort_seed: string;
  confirm_paid_calls: boolean;
}

export interface EvaluationProfile {
  model_judge: "disabled" | "enabled";
  fail_on: {
    required_check: boolean;
    infrastructure: boolean;
  };
}

/** Profile-level limit overrides; keys mirror the limit table. */
export interface ProfileLimits {
  max_agent_tool_calls: number;
  max_api_requests: number;
  max_artifact_bytes: number;
}

export interface RunProfileMetadata {
  id: string;
}

export interface RunProfile {
  apiVersion: typeof RUN_PROFILE_API_VERSION;
  kind: typeof RUN_PROFILE_KIND;
  metadata: RunProfileMetadata;
  agent: AgentProfile;
  exposure: ExposureProfile;
  execution: ExecutionProfile;
  evaluation: EvaluationProfile;
  limits: ProfileLimits;
}

export const PROFILE_LIMIT_DEFAULTS: ProfileLimits = {
  max_agent_tool_calls: 500,
  max_api_requests: 10_000,
  max_artifact_bytes: 1_073_741_824
};

/**
 * Construct a run profile with defaults filled in. Required fields stay
 * required so callers cannot assemble a half-defined cell silently.
 */
export function makeRunProfile(
  metadata: RunProfileMetadata,
  agent: AgentProfile,
  overrides: Partial<
    Pick<ExposureProfile, "documentation_profile"> &
      Partial<ExecutionProfile> &
      ProfileLimits
  > = {}
): RunProfile {
  return {
    apiVersion: RUN_PROFILE_API_VERSION,
    kind: RUN_PROFILE_KIND,
    metadata,
    agent,
    exposure: {
      mode: agent.adapter === "codex-cli" ? "raw-http" : "direct-tools",
      contract_visibility: "file",
      data_plane_scope: "all",
      documentation_profile: overrides.documentation_profile ?? null
    },
    execution: {
      count: 1,
      parallel: 1,
      timeout_ms: 1_800_000,
      cohort_seed: "",
      confirm_paid_calls: true,
      ...stripUndefined({
        count: overrides.count,
        parallel: overrides.parallel,
        timeout_ms: overrides.timeout_ms,
        cohort_seed: overrides.cohort_seed,
        confirm_paid_calls: overrides.confirm_paid_calls
      })
    },
    evaluation: {
      model_judge: "disabled",
      fail_on: { required_check: true, infrastructure: true }
    },
    limits: { ...PROFILE_LIMIT_DEFAULTS, ...stripUndefined({ ...overrides }) }
  };
}

function stripUndefined<T extends Record<string, unknown>>(
  values: T
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}
