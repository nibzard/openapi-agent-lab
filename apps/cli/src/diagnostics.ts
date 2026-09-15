import {
  canonicalJson,
  diagnostic,
  type Diagnostic,
  type DiagnosticPhase,
  type Json,
  type JsonObject,
  type OalError
} from "@oal/core";

import type { Io } from "./io.ts";
import type { RunContext } from "./context.ts";

/** Default phase for shell-level failures; subsystems pass their own. */
export const SHELL_PHASE: DiagnosticPhase = "preflight";

/** Convert a typed error into its normalized diagnostic record. */
export function errorToDiagnostic(
  error: OalError,
  phase: DiagnosticPhase = SHELL_PHASE
): Diagnostic {
  return diagnostic({
    severity: "error",
    phase,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details
  });
}

export function diagnosticToJson(value: Diagnostic): JsonObject {
  return {
    severity: value.severity,
    phase: value.phase,
    code: value.code,
    message: value.message,
    document_uri: value.document_uri,
    json_pointer: value.json_pointer,
    operation_key: value.operation_key,
    retryable: value.retryable,
    related: value.related.map((location) => ({
      document_uri: location.document_uri,
      json_pointer: location.json_pointer
    })),
    details: value.details
  };
}

/** One-line JSON form used on stderr when --format json is selected. */
export function diagnosticJsonLine(value: Diagnostic): string {
  return canonicalJson(diagnosticToJson(value) as Json);
}

/** Text form: "code: message (json-pointer)". */
export function diagnosticTextLine(value: Diagnostic): string {
  const pointer = value.json_pointer === null ? "" : ` (${value.json_pointer})`;
  return `${value.code}: ${value.message}${pointer}`;
}

function shownByDefault(severity: Diagnostic["severity"]): boolean {
  return severity !== "info";
}

/** Emit diagnostics to stderr, one per line, honoring verbosity flags. */
export function emitDiagnostics(
  io: Io,
  context: Pick<RunContext, "format" | "verbose" | "quiet">,
  diagnostics: readonly Diagnostic[]
): void {
  for (const entry of diagnostics) {
    const visible = context.verbose
      ? true
      : context.quiet
        ? entry.severity === "error"
        : shownByDefault(entry.severity);
    if (!visible) {
      continue;
    }
    io.stderr(
      context.format === "json"
        ? diagnosticJsonLine(entry)
        : diagnosticTextLine(entry)
    );
  }
}

/** Emit one typed error; returns the exit code the CLI must return. */
export function emitOalError(
  io: Io,
  context: Pick<RunContext, "format" | "verbose" | "quiet">,
  error: OalError
): void {
  emitDiagnostics(io, context, [errorToDiagnostic(error)]);
}
