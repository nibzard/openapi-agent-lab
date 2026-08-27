import type { Json } from "./json.ts";

/** Stable process exit codes (specification section 23.18). */
export type ExitCode = 0 | 2 | 3 | 4 | 5 | 130 | 143;

export const EXIT_OK: ExitCode = 0;
export const EXIT_INVALID: ExitCode = 2;
export const EXIT_INFRASTRUCTURE: ExitCode = 3;
export const EXIT_UNSUPPORTED: ExitCode = 4;
export const EXIT_EVAL_THRESHOLD: ExitCode = 5;
export const EXIT_SIGINT: ExitCode = 130;
export const EXIT_SIGTERM: ExitCode = 143;

/** Normalized failure categories (specification section 32.2). */
export type FailureCategory =
  | "input"
  | "parse"
  | "openapi"
  | "reference"
  | "capability"
  | "pack"
  | "study"
  | "startup"
  | "sandbox"
  | "provider"
  | "agent_execution"
  | "mock"
  | "evaluation"
  | "persistence"
  | "internal";

/**
 * Typed error carrying a stable code, a failure category, and the process
 * exit code the CLI must map the failure to.
 */
export class OalError extends Error {
  readonly code: string;
  readonly category: FailureCategory;
  readonly exitCode: ExitCode;
  readonly retryable: boolean;
  readonly details: Json;

  constructor(init: {
    code: string;
    message: string;
    category: FailureCategory;
    exitCode: ExitCode;
    retryable?: boolean;
    details?: Json;
    cause?: unknown;
  }) {
    super(init.message, { cause: init.cause });
    this.name = "OalError";
    this.code = init.code;
    this.category = init.category;
    this.exitCode = init.exitCode;
    this.retryable = init.retryable ?? false;
    this.details = init.details ?? {};
  }
}

export function invalidInput(
  code: string,
  message: string,
  details?: Json
): OalError {
  return new OalError({
    code,
    message,
    category: "input",
    exitCode: EXIT_INVALID,
    ...(details === undefined ? {} : { details })
  });
}

export function unsupported(
  code: string,
  message: string,
  details?: Json
): OalError {
  return new OalError({
    code,
    message,
    category: "capability",
    exitCode: EXIT_UNSUPPORTED,
    ...(details === undefined ? {} : { details })
  });
}

export function infrastructure(
  code: string,
  message: string,
  details?: Json
): OalError {
  return new OalError({
    code,
    message,
    category: "startup",
    exitCode: EXIT_INFRASTRUCTURE,
    ...(details === undefined ? {} : { details })
  });
}

export function toOalError(error: unknown): OalError {
  if (error instanceof OalError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OalError({
    code: "OAL-INTERNAL",
    message,
    category: "internal",
    exitCode: EXIT_INFRASTRUCTURE,
    retryable: true,
    cause: error
  });
}
