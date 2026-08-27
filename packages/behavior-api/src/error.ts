/**
 * Behavior errors (specification section 16.4). A BehaviorHttpError
 * carries a contract-shaped failure to the participant; it never
 * commits state in backend API version 1.
 */

import type { Body } from "./types.ts";

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
