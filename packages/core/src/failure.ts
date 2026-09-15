/**
 * The failure taxonomy (specification section 32). Every stable code maps to
 * one category with a default phase, severity, and retryable flag. Programs
 * depend on the stable fields, never on message wording. HTTP domain failures
 * caused by a participant are normal trace evidence, not harness failures.
 */

import type { DiagnosticPhase, DiagnosticSeverity } from "./diagnostic.ts";

/**
 * Taxonomy categories from the section 32.2 table, including the HTTP
 * behavior domain. Unlike the coarse FailureCategory in errors.ts, these
 * follow the table rows one to one.
 */
export type TaxonomyCategory =
  | "input_config"
  | "parse"
  | "openapi"
  | "reference"
  | "capability"
  | "pack"
  | "study"
  | "startup"
  | "sandbox"
  | "adapter_provider"
  | "agent_execution"
  | "http_behavior"
  | "mock"
  | "evaluation"
  | "persistence";

/** What a failure of this category does to a batch. */
export type FailureEffect =
  | "batch_setup_failed"
  | "compile_failed"
  | "compile_failed_or_capability"
  | "strict_blocker_or_limitation"
  | "setup_failed"
  | "preflight_failed_or_invalid_evidence"
  | "infrastructure_failed"
  | "infrastructure_failed_or_expected_evidence"
  | "preflight_provider_or_infrastructure"
  | "valid_unsuccessful_outcome"
  | "normal_trace_evidence"
  | "task_failed_or_evaluation_infrastructure"
  | "infrastructure_invalid_evidence";

/** Retry policy from section 32.3. */
export type RetryPolicy = "never" | "startup_only";

export interface FailureClass {
  code: string;
  category: TaxonomyCategory;
  effect: FailureEffect;
  /** Default severity; an emitter may lower it for a scoped limitation. */
  severity: DiagnosticSeverity;
  /** Default lifecycle phase of the first emission. */
  phase: DiagnosticPhase;
  retryable: boolean;
}

/** HTTP domain outcome codes from section 32.2. They are trace evidence. */
export const HTTP_BEHAVIOR_CODES: readonly string[] = [
  "authentication_failed",
  "route_not_found",
  "method_not_allowed",
  "request_schema_invalid",
  "invalid_state",
  "fault_injected"
];

function entry(
  code: string,
  category: TaxonomyCategory,
  effect: FailureEffect,
  severity: DiagnosticSeverity,
  phase: DiagnosticPhase,
  retryable = false
): FailureClass {
  return { code, category, effect, severity, phase, retryable };
}

const INPUT: FailureClass[] = [
  entry(
    "OAL-CONFIG-INVALID",
    "input_config",
    "batch_setup_failed",
    "error",
    "ingest"
  ),
  entry(
    "OAL-INPUT-MISSING",
    "input_config",
    "batch_setup_failed",
    "error",
    "ingest"
  ),
  entry(
    "OAL-INPUT-TOO-LARGE",
    "input_config",
    "batch_setup_failed",
    "error",
    "ingest"
  ),
  entry(
    "OAL-PACK-SCHEMA-INVALID",
    "input_config",
    "batch_setup_failed",
    "error",
    "ingest"
  )
];

const PARSE: FailureClass[] = [
  entry("OAL-JSON-INVALID", "parse", "compile_failed", "error", "ingest"),
  entry("OAL-YAML-INVALID", "parse", "compile_failed", "error", "ingest"),
  entry("OAL-YAML-ALIAS-LIMIT", "parse", "compile_failed", "error", "ingest"),
  entry("OAL-DUPLICATE-KEY", "parse", "compile_failed", "error", "ingest")
];

const OPENAPI: FailureClass[] = [
  entry(
    "OAL-OAS-VERSION-UNSUPPORTED",
    "openapi",
    "compile_failed_or_capability",
    "error",
    "compile"
  ),
  entry(
    "OAL-OAS-STRUCTURE-INVALID",
    "openapi",
    "compile_failed_or_capability",
    "error",
    "compile"
  ),
  entry(
    "OAL-OAS-ROUTE-AMBIGUOUS",
    "openapi",
    "compile_failed_or_capability",
    "error",
    "compile"
  )
];

const REFERENCE: FailureClass[] = [
  entry(
    "OAL-REF-NOT-FOUND",
    "reference",
    "compile_failed_or_capability",
    "error",
    "compile"
  ),
  entry(
    "OAL-REF-OUTSIDE-ROOT",
    "reference",
    "compile_failed_or_capability",
    "error",
    "compile"
  ),
  entry(
    "OAL-REF-REMOTE-DISABLED",
    "reference",
    "compile_failed_or_capability",
    "error",
    "compile"
  ),
  entry(
    "OAL-REF-LIMIT",
    "reference",
    "compile_failed_or_capability",
    "error",
    "compile"
  )
];

const CAPABILITY: FailureClass[] = [
  entry(
    "OAL-CAP-CALLBACK-UNSUPPORTED",
    "capability",
    "strict_blocker_or_limitation",
    "error",
    "compile"
  ),
  entry(
    "OAL-CAP-AUTH-FLOW-UNSUPPORTED",
    "capability",
    "strict_blocker_or_limitation",
    "error",
    "compile"
  ),
  entry(
    "OAL-CAP-SCHEMA-APPROXIMATED",
    "capability",
    "strict_blocker_or_limitation",
    "warning",
    "compile"
  ),
  entry(
    "OAL-PATTERN-HOSTILE",
    "capability",
    "strict_blocker_or_limitation",
    "warning",
    "compile"
  )
];

const PACK: FailureClass[] = [
  entry(
    "OAL-PACK-DIGEST-MISMATCH",
    "pack",
    "setup_failed",
    "error",
    "preflight"
  ),
  entry(
    "OAL-BEHAVIOR-OPERATION-MISSING",
    "pack",
    "setup_failed",
    "error",
    "preflight"
  ),
  entry("OAL-RUBRIC-INVALID", "pack", "setup_failed", "error", "preflight")
];

const STUDY: FailureClass[] = [
  entry(
    "OAL-STUDY-SCHEMA-INVALID",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-PROTOCOL-LOCK-MISMATCH",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-PHASE-LOCK-MISMATCH",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-SCHEDULE-INVALID",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-CELL-DRIFT",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-CUE-LEAK",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  ),
  entry(
    "OAL-COMPATIBILITY-MISMATCH",
    "study",
    "preflight_failed_or_invalid_evidence",
    "error",
    "preflight"
  )
];

const STARTUP: FailureClass[] = [
  entry(
    "OAL-PORT-BIND-FAILED",
    "startup",
    "infrastructure_failed",
    "error",
    "serve",
    true
  ),
  entry(
    "OAL-STATE-DIGEST-MISMATCH",
    "startup",
    "infrastructure_failed",
    "error",
    "preflight"
  ),
  entry(
    "OAL-ARTIFACT-EXISTS",
    "startup",
    "infrastructure_failed",
    "error",
    "preflight"
  ),
  entry(
    "OAL-MOCK-NOT-READY",
    "startup",
    "infrastructure_failed",
    "error",
    "serve",
    true
  )
];

const SANDBOX: FailureClass[] = [
  entry(
    "OAL-SANDBOX-UNAVAILABLE",
    "sandbox",
    "infrastructure_failed_or_expected_evidence",
    "error",
    "run"
  ),
  entry(
    "OAL-FILESYSTEM-DENIED",
    "sandbox",
    "infrastructure_failed_or_expected_evidence",
    "warning",
    "run"
  ),
  entry(
    "OAL-NETWORK-DENIED",
    "sandbox",
    "infrastructure_failed_or_expected_evidence",
    "warning",
    "run"
  ),
  entry(
    "OAL-DESCENDANT-CLEANUP-FAILED",
    "sandbox",
    "infrastructure_failed_or_expected_evidence",
    "error",
    "run"
  )
];

const ADAPTER: FailureClass[] = [
  entry(
    "OAL-AGENT-NOT-FOUND",
    "adapter_provider",
    "preflight_provider_or_infrastructure",
    "error",
    "preflight"
  ),
  entry(
    "OAL-AGENT-CAPABILITY-UNSUPPORTED",
    "adapter_provider",
    "preflight_provider_or_infrastructure",
    "error",
    "preflight"
  ),
  entry(
    "OAL-PROVIDER-AUTH-FAILED",
    "adapter_provider",
    "preflight_provider_or_infrastructure",
    "error",
    "run"
  ),
  entry(
    "OAL-PROVIDER-UNAVAILABLE",
    "adapter_provider",
    "preflight_provider_or_infrastructure",
    "error",
    "run",
    true
  )
];

const AGENT_EXECUTION: FailureClass[] = [
  entry(
    "OAL-AGENT-EXIT-NONZERO",
    "agent_execution",
    "valid_unsuccessful_outcome",
    "error",
    "run"
  ),
  entry(
    "OAL-AGENT-TIMEOUT",
    "agent_execution",
    "valid_unsuccessful_outcome",
    "error",
    "run"
  ),
  entry(
    "OAL-AGENT-CANCELLED",
    "agent_execution",
    "valid_unsuccessful_outcome",
    "error",
    "run"
  ),
  entry(
    "OAL-AGENT-BUDGET-EXHAUSTED",
    "agent_execution",
    "valid_unsuccessful_outcome",
    "error",
    "run"
  )
];

const MOCK: FailureClass[] = [
  entry(
    "OAL-GENERATION-FAILED",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  ),
  entry(
    "OAL-STATE-COMMIT-FAILED",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  ),
  entry("OAL-MOCK-INTERNAL", "mock", "infrastructure_failed", "error", "serve"),
  entry(
    "OAL-SCHEMA-WORKER-TIMEOUT",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  ),
  entry(
    "OAL-SCHEMA-WORKER-FAILED",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  ),
  entry(
    "OAL-SCHEMA-WORKER-QUEUE-FULL",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  ),
  entry(
    "OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE",
    "mock",
    "infrastructure_failed",
    "error",
    "serve"
  )
];

const EVALUATION: FailureClass[] = [
  entry(
    "OAL-REPORT-MISSING",
    "evaluation",
    "task_failed_or_evaluation_infrastructure",
    "error",
    "evaluate"
  ),
  entry(
    "OAL-REPORT-INVALID",
    "evaluation",
    "task_failed_or_evaluation_infrastructure",
    "error",
    "evaluate"
  ),
  entry(
    "OAL-CHECK-FAILED",
    "evaluation",
    "task_failed_or_evaluation_infrastructure",
    "error",
    "evaluate"
  ),
  entry(
    "OAL-CHECK-INDETERMINATE",
    "evaluation",
    "task_failed_or_evaluation_infrastructure",
    "warning",
    "evaluate"
  ),
  entry(
    "OAL-EVALUATOR-CRASHED",
    "evaluation",
    "task_failed_or_evaluation_infrastructure",
    "error",
    "evaluate"
  )
];

const PERSISTENCE: FailureClass[] = [
  entry(
    "OAL-ARTIFACT-WRITE-FAILED",
    "persistence",
    "infrastructure_invalid_evidence",
    "error",
    "report"
  ),
  entry(
    "OAL-HASH-MISMATCH",
    "persistence",
    "infrastructure_invalid_evidence",
    "error",
    "report"
  ),
  entry(
    "OAL-INVALID-EVIDENCE",
    "persistence",
    "infrastructure_invalid_evidence",
    "error",
    "report"
  ),
  entry(
    "OAL-DISK-LIMIT",
    "persistence",
    "infrastructure_invalid_evidence",
    "error",
    "report"
  )
];

const HTTP_BEHAVIOR: FailureClass[] = HTTP_BEHAVIOR_CODES.map((code) =>
  entry(code, "http_behavior", "normal_trace_evidence", "info", "serve")
);

/** The full registry, keyed by stable code. */
export const FAILURE_REGISTRY: ReadonlyMap<string, FailureClass> = new Map(
  [
    ...INPUT,
    ...PARSE,
    ...OPENAPI,
    ...REFERENCE,
    ...CAPABILITY,
    ...PACK,
    ...STUDY,
    ...STARTUP,
    ...SANDBOX,
    ...ADAPTER,
    ...AGENT_EXECUTION,
    ...HTTP_BEHAVIOR,
    ...MOCK,
    ...EVALUATION,
    ...PERSISTENCE
  ].map((failure) => [failure.code, failure])
);

/** Look up one failure class. Unknown codes are unclassified. */
export function failureClassOf(code: string): FailureClass | null {
  return FAILURE_REGISTRY.get(code) ?? null;
}

/**
 * Whether a code represents a harness failure. HTTP domain failures a
 * participant causes intentionally are normal evidence, never harness
 * failures (section 32.2 closing rule).
 */
export function isHarnessFailure(code: string): boolean {
  const failure = FAILURE_REGISTRY.get(code);
  return failure !== undefined && failure.category !== "http_behavior";
}

/** Retry policy for one code (section 32.3). */
export function retryPolicyOf(code: string): RetryPolicy {
  const failure = FAILURE_REGISTRY.get(code);
  if (failure === undefined) {
    return "never";
  }
  if (failure.category === "startup") {
    return "startup_only";
  }
  if (failure.category === "adapter_provider" && failure.retryable) {
    return "startup_only";
  }
  return "never";
}

/**
 * Whether a failure with this code makes evidence infrastructure-invalid:
 * persistence failures and strict study preflight failures do.
 */
export function invalidatesEvidence(code: string): boolean {
  const failure = FAILURE_REGISTRY.get(code);
  if (failure === undefined) {
    return false;
  }
  return (
    failure.effect === "infrastructure_invalid_evidence" ||
    failure.effect === "preflight_failed_or_invalid_evidence"
  );
}

/** Every code in one category, in registry order. */
export function failuresByCategory(category: TaxonomyCategory): FailureClass[] {
  return [...FAILURE_REGISTRY.values()].filter(
    (failure) => failure.category === category
  );
}
