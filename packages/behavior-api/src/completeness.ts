/**
 * Exact behavior completeness (specification sections 12.3 and 16.3).
 * Under `completeness: exact` every operation in the resolved scope is
 * declared exactly once by the scenario backend, every declared
 * operation exists in that scope, and every scoped operation is
 * implemented. One missing or one extra key is fatal before the
 * listener starts.
 */

import { DiagnosticCode, diagnostic, type Diagnostic } from "@oal/core";

import type { BackendDescription } from "./types.ts";

/** Support level a backend description reports for one operation. */
export type OperationSupport =
  BackendDescription["operations"][number]["support"];

/** The unmatched keys, grouped by direction. */
export interface CompletenessDiff {
  /** Scope keys the backend description never declares. */
  readonly missing: readonly string[];
  /** Scope keys declared without implemented support. */
  readonly unimplemented: readonly string[];
  /** Declared keys outside the resolved scope. */
  readonly extra: readonly string[];
  /** Keys the backend description declares more than once. */
  readonly duplicated: readonly string[];
}

/**
 * Compare the backend's declared operations with the resolved operation
 * scope. Pure and deterministic: missing keys follow scope order, the
 * other groups follow declaration order.
 */
export function diffBehaviorCompleteness(
  description: Pick<BackendDescription, "operations">,
  scope: readonly string[]
): CompletenessDiff {
  const supportByKey = new Map<string, OperationSupport>();
  const duplicated: string[] = [];
  for (const entry of description.operations) {
    if (supportByKey.has(entry.key)) {
      duplicated.push(entry.key);
      continue;
    }
    supportByKey.set(entry.key, entry.support);
  }
  const scopeSet = new Set(scope);
  const missing: string[] = [];
  const unimplemented: string[] = [];
  const reported = new Set<string>();
  for (const key of scope) {
    if (reported.has(key)) {
      // A repeated scope key is reported once.
      continue;
    }
    reported.add(key);
    const support = supportByKey.get(key);
    if (support === undefined) {
      missing.push(key);
    } else if (support !== "implemented") {
      unimplemented.push(key);
    }
  }
  const extra: string[] = [];
  for (const entry of description.operations) {
    if (!scopeSet.has(entry.key) && !extra.includes(entry.key)) {
      extra.push(entry.key);
    }
  }
  return { missing, unimplemented, extra, duplicated };
}

/**
 * One error diagnostic per unmatched key, or an empty list when the
 * description covers the scope exactly. Codes are the stable
 * section 32.2 pack codes; the phase is preflight, where section
 * 22.1 places the completeness gate.
 */
export function checkBehaviorCompleteness(
  description: Pick<BackendDescription, "operations">,
  scope: readonly string[]
): Diagnostic[] {
  const diff = diffBehaviorCompleteness(description, scope);
  const diagnostics: Diagnostic[] = [];
  for (const key of diff.missing) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: DiagnosticCode.BehaviorOperationMissing,
        message: `Operation ${key} is in the resolved scope but the backend does not declare it.`,
        operation_key: key
      })
    );
  }
  for (const key of diff.unimplemented) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: DiagnosticCode.BehaviorOperationMissing,
        message: `Operation ${key} is declared without implemented support.`,
        operation_key: key
      })
    );
  }
  for (const key of diff.extra) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: DiagnosticCode.BehaviorOperationExtra,
        message: `Operation ${key} is declared by the backend but is outside the resolved scope.`,
        operation_key: key
      })
    );
  }
  for (const key of diff.duplicated) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: DiagnosticCode.BehaviorOperationExtra,
        message: `Operation ${key} is declared more than once.`,
        operation_key: key
      })
    );
  }
  return diagnostics;
}
