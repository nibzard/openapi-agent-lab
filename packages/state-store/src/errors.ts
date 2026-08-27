/**
 * Typed state-store failures. Codes are the stable codes from specification
 * section 32.2; categories and exit codes follow that table.
 */

import {
  DiagnosticCode,
  EXIT_INFRASTRUCTURE,
  OalError,
  unsupported,
  type Json
} from "@oal/core";

/** Stored schema version is newer than this build understands. */
export function schemaVersionUnsupported(
  found: number,
  supported: number
): OalError {
  return unsupported(
    DiagnosticCode.UnsupportedSchemaVersion,
    `Database schema version ${found} is newer than the supported version ${supported}.`,
    { found, supported }
  );
}

/**
 * Optimistic-concurrency failure or any other state-commit failure. The spec
 * classifies this code under mock infrastructure failure.
 */
export function stateCommitFailed(message: string, details?: Json): OalError {
  return new OalError({
    code: DiagnosticCode.StateCommitFailed,
    message,
    category: "mock",
    exitCode: EXIT_INFRASTRUCTURE,
    ...(details === undefined ? {} : { details })
  });
}

/** A persisted byte or count limit stopped the write. */
export function limitReached(message: string, details?: Json): OalError {
  return new OalError({
    code: DiagnosticCode.LimitReached,
    message,
    category: "persistence",
    exitCode: EXIT_INFRASTRUCTURE,
    ...(details === undefined ? {} : { details })
  });
}

/**
 * Stable code for a refused resume or attach attempt. The specification
 * lists it under startup failures: infrastructure, not participant
 * behavior.
 */
export const RUN_IDENTITY_MISMATCH_CODE = "OAL-STATE-DIGEST-MISMATCH";

/**
 * A run record differs from the identity the caller expected, so the
 * database cannot be resumed or attached. Thrown before any write, so
 * the stored bytes are unchanged.
 */
export function runIdentityMismatch(
  field: string,
  expected: string | number | null,
  found: string | number | null
): OalError {
  return new OalError({
    code: RUN_IDENTITY_MISMATCH_CODE,
    message: `Run identity field ${field} is ${JSON.stringify(found)}, but the caller expected ${JSON.stringify(expected)}.`,
    category: "startup",
    exitCode: EXIT_INFRASTRUCTURE,
    details: { field, expected, found }
  });
}
