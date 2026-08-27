import type { Json } from "./json.ts";

/** Diagnostic severity levels. */
export type DiagnosticSeverity = "info" | "warning" | "error";

/** Lifecycle phase in which a diagnostic was produced. */
export type DiagnosticPhase =
  | "ingest"
  | "compile"
  | "preflight"
  | "serve"
  | "run"
  | "evaluate"
  | "report";

export interface DiagnosticLocation {
  document_uri: string;
  json_pointer: string;
}

/**
 * Normalized diagnostic record. Codes are stable API; wording is not.
 * Serialized form validates against schemas/diagnostic.v1.schema.json.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  phase: DiagnosticPhase;
  code: string;
  message: string;
  document_uri: string | null;
  json_pointer: string | null;
  operation_key: string | null;
  retryable: boolean;
  related: DiagnosticLocation[];
  details: Json;
}

export function diagnostic(partial: {
  severity: DiagnosticSeverity;
  phase: DiagnosticPhase;
  code: string;
  message: string;
  document_uri?: string | null;
  json_pointer?: string | null;
  operation_key?: string | null;
  retryable?: boolean;
  related?: DiagnosticLocation[];
  details?: Json;
}): Diagnostic {
  return {
    severity: partial.severity,
    phase: partial.phase,
    code: partial.code,
    message: partial.message,
    document_uri: partial.document_uri ?? null,
    json_pointer: partial.json_pointer ?? null,
    operation_key: partial.operation_key ?? null,
    retryable: partial.retryable ?? false,
    related: partial.related ?? [],
    details: partial.details ?? {}
  };
}

export function errorDiagnostics(
  diagnostics: readonly Diagnostic[]
): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

/** Stable diagnostic codes used across the compiler and runtime. */
export const DiagnosticCode = {
  OasVersionUnsupported: "OAL-OAS-VERSION-UNSUPPORTED",
  OasStructureInvalid: "OAL-OAS-STRUCTURE-INVALID",
  RouteAmbiguous: "OAL-OAS-ROUTE-AMBIGUOUS",
  PathParameterMissing: "OAL-OAS-PATH-PARAMETER-MISSING",
  JsonInvalid: "OAL-JSON-INVALID",
  YamlInvalid: "OAL-YAML-INVALID",
  YamlAliasLimit: "OAL-YAML-ALIAS-LIMIT",
  YamlNodeLimit: "OAL-YAML-NODE-LIMIT",
  YamlDepthLimit: "OAL-YAML-DEPTH-LIMIT",
  DuplicateKey: "OAL-DUPLICATE-KEY",
  InputMissing: "OAL-INPUT-MISSING",
  InputTooLarge: "OAL-INPUT-TOO-LARGE",
  InputSecretDetected: "OAL-INPUT-SECRET-DETECTED",
  RefNotFound: "OAL-REF-NOT-FOUND",
  RefOutsideRoot: "OAL-REF-OUTSIDE-ROOT",
  RefRemoteDisabled: "OAL-REF-REMOTE-DISABLED",
  RefLimit: "OAL-REF-LIMIT",
  RefCycleUnsupported: "OAL-REF-CYCLE-UNSUPPORTED",
  CapCallbackUnsupported: "OAL-CAP-CALLBACK-UNSUPPORTED",
  CapAuthFlowUnsupported: "OAL-CAP-AUTH-FLOW-UNSUPPORTED",
  CapSchemaApproximated: "OAL-CAP-SCHEMA-APPROXIMATED",
  CapMediaUnsupported: "OAL-CAP-MEDIA-UNSUPPORTED",
  CapParameterUnsupported: "OAL-CAP-PARAMETER-UNSUPPORTED",
  CapResponseGenerationUnsupported: "OAL-CAP-RESPONSE-GENERATION-UNSUPPORTED",
  ExampleSensitiveSkipped: "OAL-EXAMPLE-SENSITIVE-SKIPPED",
  ConfigInvalid: "OAL-CONFIG-INVALID",
  PackSchemaInvalid: "OAL-PACK-SCHEMA-INVALID",
  PackDigestMismatch: "OAL-PACK-DIGEST-MISMATCH",
  BehaviorOperationMissing: "OAL-BEHAVIOR-OPERATION-MISSING",
  BehaviorOperationExtra: "OAL-BEHAVIOR-OPERATION-EXTRA",
  RubricInvalid: "OAL-RUBRIC-INVALID",
  ArtifactExists: "OAL-ARTIFACT-EXISTS",
  ArtifactWriteFailed: "OAL-ARTIFACT-WRITE-FAILED",
  HashMismatch: "OAL-HASH-MISMATCH",
  InvalidEvidence: "OAL-INVALID-EVIDENCE",
  StateCommitFailed: "OAL-STATE-COMMIT-FAILED",
  GenerationFailed: "OAL-GENERATION-FAILED",
  MockInternal: "OAL-MOCK-INTERNAL",
  PortBindFailed: "OAL-PORT-BIND-FAILED",
  MockNotReady: "OAL-MOCK-NOT-READY",
  AgentNotFound: "OAL-AGENT-NOT-FOUND",
  AgentCapabilityUnsupported: "OAL-AGENT-CAPABILITY-UNSUPPORTED",
  ReportMissing: "OAL-REPORT-MISSING",
  ReportInvalid: "OAL-REPORT-INVALID",
  CheckIndeterminate: "OAL-CHECK-INDETERMINATE",
  EvaluatorCrashed: "OAL-EVALUATOR-CRASHED",
  LimitReached: "OAL-LIMIT-REACHED",
  UnsupportedSchemaVersion: "OAL-SCHEMA-VERSION-UNSUPPORTED"
} as const;
