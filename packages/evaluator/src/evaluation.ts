/**
 * Evaluation result document (specification sections 26.5 and 26.8).
 *
 * The document is the wire form of one evaluated run: per-check
 * status, weight, evidence, non-scoring signals, and the infrastructure
 * error list. It validates against schemas/evaluation.v1.schema.json.
 */

import { DiagnosticCode, type JsonObject } from "@oal/core";

export const EVALUATION_SCHEMA_VERSION = 1;
export const EVALUATOR_NAME = "@oal/evaluator";
/**
 * Evaluator implementation version. Version 0.1.0 adds the normalized
 * header view (event.request.header_values and
 * event.response.header_values) to expression scopes. Both evaluation
 * documents and derived re-evaluations record this identity.
 */
export const EVALUATOR_VERSION = "0.1.0";

/** Status of one check, one signal outcome, or the whole run. */
export type EvaluationStatus = "passed" | "failed" | "error" | "skipped";

/**
 * Stable infrastructure error codes. Evaluator problems are
 * infrastructure outcomes and never task failures. The taxonomy in
 * section 32.2 lists examples, so evaluator-specific codes extend it.
 */
export const EvaluatorErrorCode = {
  ExpressionLength: "OAL-EXPRESSION-LENGTH",
  ExpressionDepth: "OAL-EXPRESSION-DEPTH",
  ExpressionSyntax: "OAL-EXPRESSION-SYNTAX",
  ExpressionForbidden: "OAL-EXPRESSION-FORBIDDEN",
  ExpressionType: "OAL-EXPRESSION-TYPE",
  ExpressionDivision: "OAL-EXPRESSION-DIVISION",
  ExpressionSteps: "OAL-EXPRESSION-STEPS",
  ExpressionNotBoolean: "OAL-EXPRESSION-NOT-BOOLEAN",
  CheckMissingValue: "OAL-CHECK-MISSING-VALUE",
  CheckCandidateLimit: "OAL-CHECK-CANDIDATE-LIMIT",
  CheckCaptureLimit: "OAL-CHECK-CAPTURE-LIMIT",
  CheckHeaderViewLimit: "OAL-CHECK-HEADER-VIEW-LIMIT",
  CheckSchemaWorkerTimeout: "OAL-SCHEMA-WORKER-TIMEOUT",
  CheckSchemaWorkerFailed: "OAL-SCHEMA-WORKER-FAILED",
  RubricSchemaUnresolved: "OAL-RUBRIC-SCHEMA-UNRESOLVED",
  RubricInvalid: DiagnosticCode.RubricInvalid,
  EvaluatorCrashed: DiagnosticCode.EvaluatorCrashed
} as const;

export type EvaluatorErrorCodeValue =
  (typeof EvaluatorErrorCode)[keyof typeof EvaluatorErrorCode];

export interface InfrastructureErrorRecord {
  code: string;
  message: string;
  check_id?: string | null | undefined;
}

export interface EvaluationCheckRecord {
  id: string;
  status: EvaluationStatus;
  weight: number;
  required: boolean;
  event_ids?: string[] | undefined;
  captures?: JsonObject | undefined;
  failed_pointers?: string[] | undefined;
  artifact_refs?: string[] | undefined;
  message?: string | null | undefined;
}

export interface Evaluation {
  schema_version: 1;
  rubric_id: string;
  run_id: string;
  evaluated_at?: string | undefined;
  evaluator?: { name: string; version: string } | undefined;
  rubric_sha256?: string | undefined;
  status: EvaluationStatus;
  score: number;
  passed_weight: number;
  total_weight: number;
  checks: EvaluationCheckRecord[];
  signals: Record<string, boolean>;
  infrastructure_errors: InfrastructureErrorRecord[];
}

/** Build one infrastructure error record. */
export function infrastructureError(init: {
  code: string;
  message: string;
  checkId?: string | null | undefined;
}): InfrastructureErrorRecord {
  return {
    code: init.code,
    message: init.message,
    ...(init.checkId === undefined ? {} : { check_id: init.checkId })
  };
}
