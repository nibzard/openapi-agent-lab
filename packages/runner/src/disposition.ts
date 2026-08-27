/**
 * Terminal disposition classification (specification sections 22.4,
 * 32.2, and 32.3). Disposition derives from persisted facts in one fixed
 * precedence. Censor class derives exactly once, in its own precedence,
 * and an operator can never choose or edit it.
 */

import { invalidInput, isSafeId } from "@oal/core";
import type { EvidenceIntegrityFlag, TerminalDisposition } from "@oal/evidence";

/** Stable reason codes of the disposition module. */
export const DispositionCode = {
  Completed: "OAL-RUN-DISPOSITION-COMPLETED",
  AgentIncomplete: "OAL-RUN-DISPOSITION-AGENT-INCOMPLETE",
  AgentFailed: "OAL-AGENT-EXIT-NONZERO",
  TimedOut: "OAL-AGENT-TIMEOUT",
  BudgetExhausted: "OAL-AGENT-BUDGET-EXHAUSTED",
  OperatorInterrupted: "OAL-RUN-OPERATOR-SIGNAL",
  ProviderFailed: "OAL-PROVIDER-UNAVAILABLE",
  InfrastructureFailed: "OAL-RUN-INFRASTRUCTURE-FAILED",
  HarnessAborted: "OAL-RUN-HARNESS-ABORTED",
  NotStarted: "OAL-RUN-NOT-STARTED",
  InvalidSetup: "OAL-RUN-INVALID-SETUP",
  RetryRecorded: "OAL-RUN-RETRY-RECORDED"
} as const;

/** Every terminal disposition of specification section 22.4. */
export const TERMINAL_DISPOSITIONS: readonly TerminalDisposition[] = [
  "completed",
  "agent_incomplete",
  "agent_failed",
  "timed_out",
  "budget_exhausted",
  "operator_interrupted",
  "provider_failed_pre_control",
  "provider_failed_post_control",
  "infrastructure_failed_pre_control",
  "infrastructure_failed_post_control",
  "harness_aborted",
  "not_started",
  "invalid_setup"
];

/** Censor classes of specification section 22.4. */
export type CensorClass =
  | "none"
  | "pre_control_nonparticipant"
  | "administrative_censor"
  | "instrumentation_censor";

/** Status of one evidence requirement of the frozen primary metric. */
export type RequirementStatus = "ok" | "corrupt" | "missing" | "unavailable";

/** One required evidence producer or artifact and its verified status. */
export interface EvidenceRequirement {
  readonly id: string;
  readonly status: RequirementStatus;
}

/** A persisted operator signal. */
export interface OperatorSignalFact {
  readonly signal: string;
  /** Wall-clock epoch milliseconds from the injected clock. */
  readonly receivedAtMs: number;
}

/** A provider or infrastructure failure observed by the runner. */
export interface FailureFact {
  readonly kind: "provider" | "infrastructure";
  /** Stable code of the underlying failure, for the terminal record. */
  readonly code: string;
}

/** Facts disposition derives from. All fields are persisted evidence. */
export interface DispositionInput {
  /** Stage snapshot at terminal derivation time. */
  readonly snapshot: {
    readonly stages: ReadonlySet<string>;
  };
  readonly operatorSignal: OperatorSignalFact | null;
  /** Epoch milliseconds of the fired wall-time limit, or null. */
  readonly timeoutFiredAtMs: number | null;
  /** Epoch milliseconds of the fired execution budget, or null. */
  readonly budgetExhaustedAtMs: number | null;
  /**
   * Stable code of a trial-local invalid input, materialization, or
   * configuration problem discovered after scheduling. Null when none.
   */
  readonly invalidSetupCode: string | null;
  readonly failure: FailureFact | null;
  /** Participant process exit facts, or null when no process ran. */
  readonly exit: {
    readonly code: number | null;
    readonly signal: string | null;
  } | null;
  /**
   * True for a scheduled assignment whose trial-local setup and launch
   * never began because the owning batch or StudyRun stopped.
   */
  readonly notStarted: boolean;
  /**
   * True for an active, unfinalized setup or execution ledger recovered
   * after controller death.
   */
  readonly unfinalizedLedger: boolean;
}

/** Terminal classification of one trial. */
export interface DispositionOutcome {
  readonly disposition: TerminalDisposition;
  readonly reasonCode: string;
}

function has(input: DispositionInput, stage: string): boolean {
  return input.snapshot.stages.has(stage);
}

/**
 * Derive the terminal disposition from persisted facts using the
 * section 22.4 precedence, top to bottom.
 */
export function classifyDisposition(
  input: DispositionInput
): DispositionOutcome {
  const controlStarted = has(input, "participant_control_started");
  const spawned = has(input, "participant_spawned");

  // Rule 1: an operator signal that fired before timeout or budget.
  const fired = earliest(input.timeoutFiredAtMs, input.budgetExhaustedAtMs);
  if (
    input.operatorSignal !== null &&
    (fired === null || input.operatorSignal.receivedAtMs < fired)
  ) {
    return {
      disposition: "operator_interrupted",
      reasonCode: DispositionCode.OperatorInterrupted
    };
  }
  // Rules 2 and 3: fired limits.
  if (input.timeoutFiredAtMs !== null) {
    return { disposition: "timed_out", reasonCode: DispositionCode.TimedOut };
  }
  if (input.budgetExhaustedAtMs !== null) {
    return {
      disposition: "budget_exhausted",
      reasonCode: DispositionCode.BudgetExhausted
    };
  }
  // Rule 4: trial-local invalid setup, after scheduling, before spawn.
  if (input.invalidSetupCode !== null && !spawned) {
    return {
      disposition: "invalid_setup",
      reasonCode: input.invalidSetupCode
    };
  }
  // Rule 5: provider or infrastructure failure, split by control start.
  if (input.failure !== null) {
    if (input.failure.kind === "provider") {
      return {
        disposition: controlStarted
          ? "provider_failed_post_control"
          : "provider_failed_pre_control",
        reasonCode: input.failure.code
      };
    }
    return {
      disposition: controlStarted
        ? "infrastructure_failed_post_control"
        : "infrastructure_failed_pre_control",
      reasonCode: input.failure.code
    };
  }
  // Rule 6: nonzero participant exit after control.
  if (
    controlStarted &&
    input.exit !== null &&
    ((input.exit.code !== null && input.exit.code !== 0) ||
      input.exit.signal !== null)
  ) {
    return {
      disposition: "agent_failed",
      reasonCode: DispositionCode.AgentFailed
    };
  }
  // Rule 7: a persisted turn-completed fact.
  if (has(input, "turn_completed")) {
    return {
      disposition: "completed",
      reasonCode: DispositionCode.Completed
    };
  }
  // Rule 8: participant exit without turn completion. Graceful cleanup
  // exit zero alone never implies completion.
  if (spawned) {
    return {
      disposition: "agent_incomplete",
      reasonCode: DispositionCode.AgentIncomplete
    };
  }
  // Rule 9: never-launched assignment.
  if (input.notStarted) {
    return {
      disposition: "not_started",
      reasonCode: DispositionCode.NotStarted
    };
  }
  // Rule 10: recovered unfinalized ledger. Never guess success.
  return {
    disposition: "harness_aborted",
    reasonCode: DispositionCode.HarnessAborted
  };
}

/** The harness-aborted derivation for crash recovery (section 32.4). */
export function harnessAborted(
  unfinalizedLedger: boolean
): DispositionOutcome | null {
  if (!unfinalizedLedger) {
    return null;
  }
  return {
    disposition: "harness_aborted",
    reasonCode: DispositionCode.HarnessAborted
  };
}

/** Input of {@link classifyCensorClass}. */
export interface CensorInput {
  readonly disposition: TerminalDisposition;
  /** Whether participant control started. */
  readonly controlStarted: boolean;
  /** Evidence dependencies the frozen primary metric requires. */
  readonly requirements: readonly EvidenceRequirement[];
}

/** Censor classification plus its reason and failed requirement ids. */
export interface CensorOutcome {
  readonly censorClass: CensorClass;
  readonly reasonCode: string;
  /** Requirement IDs that failed, in the given order. */
  readonly failedRequirements: readonly string[];
}

/** Stable censor reason codes. */
export const CensorCode = {
  PreControlNonParticipant: "OAL-RUN-CENSOR-PRE-CONTROL-NONPARTICIPANT",
  Administrative: "OAL-RUN-CENSOR-ADMINISTRATIVE",
  Instrumentation: "OAL-RUN-CENSOR-INSTRUMENTATION",
  None: "OAL-RUN-CENSOR-NONE"
} as const;

/**
 * Derive the censor class exactly once, using the four exhaustive rules
 * of section 22.4. Disposition alone never creates an instrumentation
 * censor, and a participant failure never censors on its own.
 */
export function classifyCensorClass(input: CensorInput): CensorOutcome {
  if (!input.controlStarted) {
    return {
      censorClass: "pre_control_nonparticipant",
      reasonCode: CensorCode.PreControlNonParticipant,
      failedRequirements: []
    };
  }
  if (
    input.disposition === "operator_interrupted" ||
    input.disposition === "harness_aborted"
  ) {
    return {
      censorClass: "administrative_censor",
      reasonCode: CensorCode.Administrative,
      failedRequirements: []
    };
  }
  const failed = input.requirements
    .filter((requirement) => requirement.status !== "ok")
    .map((requirement) => requirement.id);
  if (failed.length > 0) {
    return {
      censorClass: "instrumentation_censor",
      reasonCode: CensorCode.Instrumentation,
      failedRequirements: Object.freeze([...failed])
    };
  }
  return {
    censorClass: "none",
    reasonCode: CensorCode.None,
    failedRequirements: []
  };
}

/**
 * Evidence integrity over the frozen requirements: corrupt wins over
 * missing, and one valid set is intact.
 */
export function evidenceIntegrityOf(
  requirements: readonly EvidenceRequirement[]
): EvidenceIntegrityFlag {
  const statuses = requirements.map((requirement) => requirement.status);
  if (statuses.every((status) => status === "ok")) {
    return "intact";
  }
  if (statuses.includes("corrupt")) {
    return "corrupt";
  }
  return "missing";
}

/** Retry lineage of specification section 32.3. */
export interface RetryLineage {
  /** Identifier of the new immutable trial. */
  readonly runId: string;
  /** Identifier of the failed attempt this trial replaces. */
  readonly retryOf: string;
  /** Attempt number; the first retry of a run is attempt 2. */
  readonly attempt: number;
  /** Stable reason code recorded with the lineage. */
  readonly reasonCode: string;
  /** Terminal disposition of the replaced attempt. */
  readonly disposition: TerminalDisposition;
}

/**
 * Build the retry lineage record for a new trial. Failed attempts stay
 * in the batch lineage; this record only names the link.
 */
export function retryLineage(input: {
  readonly runId: string;
  readonly retryOf: string;
  readonly attempt: number;
  readonly reasonCode: string;
  readonly disposition: TerminalDisposition;
}): RetryLineage {
  if (!isSafeId(input.runId) || !isSafeId(input.retryOf)) {
    throw invalidInput(
      DispositionCode.RetryRecorded,
      "Retry lineage requires safe run identifiers."
    );
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 2) {
    throw invalidInput(
      DispositionCode.RetryRecorded,
      "A retry attempt must be an integer of at least 2."
    );
  }
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(input.reasonCode)) {
    throw invalidInput(
      DispositionCode.RetryRecorded,
      `Retry reason must be a stable code: ${input.reasonCode}.`
    );
  }
  if (!TERMINAL_DISPOSITIONS.includes(input.disposition)) {
    throw invalidInput(
      DispositionCode.RetryRecorded,
      `Retry lineage requires a terminal disposition: ${input.disposition}.`
    );
  }
  return Object.freeze({ ...input });
}

function earliest(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.min(left, right);
}
