/**
 * The target contract corpus execution runs against (specification
 * section 48.5). A target owns a world or a provider, never the
 * assertions: it executes requests and reports what came back. The
 * local target drives the public HTTP listener and the separate
 * operator controls; a provider target drives provider HTTP directly.
 * Neither may synthesize a missing response to make a case pass.
 */

import type { CorpusCase } from "@oal/pack";

import type { Json } from "@oal/core";

/** One resolved request the engine asks the target to execute. */
export interface CorpusTargetRequest {
  readonly operationId: string;
  readonly parameters: {
    readonly path: Readonly<Record<string, Json>>;
    readonly query: Readonly<Record<string, Json>>;
    readonly header: Readonly<Record<string, Json>>;
  };
  readonly body: Json | undefined;
  /**
   * True inside a poll. A target that knows the operation method
   * MUST refuse a mutating operation here: polls repeat reads only.
   */
  readonly poll: boolean;
}

/** What came back for one request. */
export interface CorpusTargetResponse {
  readonly status: number;
  /** Response headers; names may arrive in any case. */
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded body when one came back. */
  readonly body: Json | null;
  /** HTTP method, when the target can name it for the report. */
  readonly method?: string;
  /** Redacted request URL, when the target can name it. */
  readonly url?: string;
}

/** One world operation an operator step requested. */
export interface CorpusOperatorCommand {
  readonly kind:
    | "inspect"
    | "reset"
    | "checkpoint"
    | "fork"
    | "advance_time"
    | "install_fault";
  readonly byMs?: number;
  readonly expectGeneration?: number;
  readonly fixture?: string;
  readonly out?: string;
}

/** What a target can do; the engine refuses what is absent. */
export interface CorpusTargetCapabilities {
  /** Whether emulator-only scope and operator steps may run. */
  readonly operators: boolean;
  /** Whether waits advance a virtual clock instead of wall time. */
  readonly virtualTime: boolean;
}

/**
 * The adapter every corpus target implements. `prepare` gives each
 * case a fresh world; `cleanup` tears that world down whether the
 * case passed, failed, or errored.
 */
export interface CorpusTarget {
  readonly id: string;
  readonly version: string;
  readonly capabilities: CorpusTargetCapabilities;
  prepare(corpusCase: CorpusCase): Promise<void>;
  request(request: CorpusTargetRequest): Promise<CorpusTargetResponse>;
  /** Wait between poll attempts: virtual time locally, wall clock remotely. */
  wait(ms: number): Promise<void>;
  /** Operator steps; present only when capabilities.operators is true. */
  operate?(command: CorpusOperatorCommand): Promise<Json>;
  cleanup(corpusCase: CorpusCase): Promise<void>;
}
