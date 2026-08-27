import type { Diagnostic } from "@oal/core";
import type { SupportLevel } from "@oal/contract-ir";

/**
 * Machine-readable support assessment produced before any server or agent
 * starts. Serialized form validates against
 * schemas/capability-report.v1.schema.json.
 */

export const CAPABILITY_REPORT_SCHEMA_VERSION = 1 as const;

export type SupportCounts = Record<SupportLevel, number>;

/** Which request/response surface a capability finding attaches to. */
export interface CapabilitySurfaceRef {
  kind:
    | "parameter"
    | "request_media_type"
    | "response_selector"
    | "response_media_type"
    | "security_alternative"
    | "callback"
    | "webhook"
    | "schema"
    | "operation";
  name: string | null;
}

export interface OperationCapability {
  key: string;
  uid: string;
  operation_id: string | null;
  method: string;
  path_template: string;
  level: SupportLevel;
  reason_codes: string[];
  surfaces: CapabilitySurfaceRef[];
}

export interface FeatureCapability {
  kind:
    | "serialization"
    | "media_type"
    | "security_flow"
    | "schema"
    | "callback"
    | "webhook"
    | "link"
    | "response_generation";
  name: string;
  level: SupportLevel;
  reason_codes: string[];
  operation_keys: string[];
}

export interface ToolViability {
  viable: boolean;
  operation_count: number;
  serialized_schema_bytes: number | null;
  max_operations: number;
  max_schema_bytes: number;
  reason_codes: string[];
}

export interface CapabilityRecommendations {
  contract_mode_viability: "viable" | "partial" | "not_viable";
  scenario_requirements: string[];
  direct_tools: ToolViability;
  catalog_tools: { viable: boolean; reason_codes: string[] };
  recommended_exposure: "raw-http" | "direct-tools" | "catalog-tools";
  strict_blockers: string[];
}

export interface CapabilityReport {
  schema_version: typeof CAPABILITY_REPORT_SCHEMA_VERSION;
  kind: "CapabilityReport";
  contract_semantic_sha256: string;
  source: {
    openapi_version: string;
    media_type: string;
    entrypoint: string;
  };
  counts: {
    operations: SupportCounts;
    security_schemes: SupportCounts;
  };
  operations: OperationCapability[];
  features: FeatureCapability[];
  missing_operation_ids: number;
  duplicate_operation_ids: string[];
  tool_name_collisions: string[];
  recommendations: CapabilityRecommendations;
  diagnostics: Diagnostic[];
}
