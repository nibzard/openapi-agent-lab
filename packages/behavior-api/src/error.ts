/**
 * Behavior errors (specification sections 16.3 and 16.4). A
 * BehaviorHttpError carries a contract-shaped failure to the participant;
 * it never commits state in backend API version 1. A BehaviorTimeoutError
 * marks a backend call that exceeded its bounded per-call timeout; the
 * gateway maps it to status 504 with the stable code behavior_timeout.
 */

import type { Body } from "./types.ts";

/** Bounded per-call timeout default; the host and executor share it. */
export const DEFAULT_BEHAVIOR_TIMEOUT_MS = 10_000;

export interface BehaviorHttpErrorInit {
  status: number;
  code: string;
  message: string;
  body?: Body | undefined;
  /** Redacted detail for the normalized trace, never the participant. */
  details?: Record<string, string> | undefined;
}

export class BehaviorHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly behaviorBody: Body | undefined;
  readonly details: Record<string, string>;
  readonly layer = "behavior";

  constructor(init: BehaviorHttpErrorInit) {
    super(init.message);
    this.name = "BehaviorHttpError";
    this.status = init.status;
    this.code = init.code;
    this.behaviorBody = init.body;
    this.details = init.details ?? {};
  }
}

/**
 * A behavior call exceeded its bounded timeout. The error is a transport
 * fact, not a domain outcome: state rolls back exactly as for an
 * unexpected exception.
 */
export class BehaviorTimeoutError extends Error {
  readonly code = "behavior_timeout";
  readonly timeoutMs: number;
  readonly layer = "behavior";

  constructor(
    timeoutMs: number,
    message = `The behavior call exceeded its ${timeoutMs} millisecond bound.`
  ) {
    super(message);
    this.name = "BehaviorTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
