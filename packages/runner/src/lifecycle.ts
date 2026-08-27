/**
 * Trial lifecycle state machine (specification sections 22.3 and 22.4).
 * Each trial owns one append-only lifecycle stream. Stages are monotonic,
 * write-once facts: the machine refuses a repeated stage and a backward
 * transition. The operator-signal stage is orthogonal to that order.
 */

import { formatRfc3339, invalidInput } from "@oal/core";
import {
  LIFECYCLE_STAGES,
  LifecycleStream,
  lifecycleStage,
  runCreated,
  stageRecord,
  type JsonlSink,
  type LifecycleDetails,
  type LifecycleEvent,
  type LifecycleEvidenceSource,
  type LifecycleStage,
  type LifecycleStageRecord
} from "@oal/evidence";

/**
 * Injected time source. The runner library never reads the wall clock
 * itself, so every timestamp it records comes from this function.
 */
export type Clock = () => number;

/** Stable error codes of the lifecycle state machine. */
export const LifecycleCode = {
  StageUnknown: "OAL-RUN-LIFECYCLE-STAGE-UNKNOWN",
  StageDuplicate: "OAL-RUN-LIFECYCLE-STAGE-DUPLICATE",
  StageOutOfOrder: "OAL-RUN-LIFECYCLE-STAGE-OUT-OF-ORDER",
  RecordInvalid: "OAL-RUN-LIFECYCLE-RECORD-INVALID"
} as const;

/** The one stage that sits outside the monotonic stage order. */
export const OPERATOR_SIGNAL_STAGE: LifecycleStage = "operator_signal_received";

/** Forward-only stage order of specification section 22.3. */
export const ORDERED_STAGES: readonly LifecycleStage[] =
  LIFECYCLE_STAGES.filter((stage) => stage !== OPERATOR_SIGNAL_STAGE);

/** Stream record shape readers of a lifecycle ledger parse. */
export type { LifecycleEvent, LifecycleStage };

/** One persisted stage fact with its sequence and timestamp. */
export interface StageFact {
  readonly stage: LifecycleStage;
  readonly sequence: number;
  readonly recordedAt: string;
}

/** Immutable view of every stage fact a trial has persisted. */
export interface LifecycleSnapshot {
  /** Recorded stages. A stage appears at most once. */
  readonly stages: ReadonlySet<LifecycleStage>;
  /** Facts in persistence order. */
  readonly facts: readonly StageFact[];
}

/** Whether one stage was recorded. */
export function hasStage(
  snapshot: LifecycleSnapshot,
  stage: LifecycleStage
): boolean {
  return snapshot.stages.has(stage);
}

/**
 * Whether the portable denominator boundary was reached: reliable
 * evidence shows the agent or model received control of the task.
 */
export function controlStarted(snapshot: LifecycleSnapshot): boolean {
  return snapshot.stages.has("participant_control_started");
}

/** Whether the trial wrote its terminal evidence-finalized fact. */
export function evidenceFinalized(snapshot: LifecycleSnapshot): boolean {
  return snapshot.stages.has("evidence_finalized");
}

function orderIndexOf(stage: LifecycleStage): number {
  return ORDERED_STAGES.indexOf(stage);
}

function snapshotOf(facts: readonly StageFact[]): LifecycleSnapshot {
  const stages = new Set<LifecycleStage>();
  for (const fact of facts) {
    if (!stages.has(fact.stage)) {
      stages.add(fact.stage);
    }
  }
  return Object.freeze({ stages, facts: Object.freeze([...facts]) });
}

/**
 * The trial-local lifecycle ledger. Every record call appends one
 * lifecycle.stage event through the evidence stream and returns the new
 * fact. A rejected transition appends nothing.
 */
export class TrialLifecycle {
  private readonly recorded: StageFact[] = [];
  private lastOrderIndex = -1;

  private constructor(private readonly stream: LifecycleStream) {}

  /** Open the ledger on an exclusively created trial directory. */
  static open(
    sink: JsonlSink,
    scope?: { batchId?: string; runId?: string }
  ): TrialLifecycle {
    return new TrialLifecycle(
      LifecycleStream.open(sink, {
        ...(scope?.batchId === undefined ? {} : { batch_id: scope.batchId }),
        ...(scope?.runId === undefined ? {} : { run_id: scope.runId })
      })
    );
  }

  /** The underlying evidence stream, for non-stage event families. */
  get events(): LifecycleStream {
    return this.stream;
  }

  /** Record the run identity, including retry lineage when present. */
  async created(
    runId: string,
    retryOf: string | null,
    now: Clock
  ): Promise<void> {
    await this.stream.emit(
      runCreated({
        run_id: runId,
        ...(retryOf === null ? {} : { retry_of: retryOf }),
        observed_at: formatRfc3339(now())
      })
    );
  }

  /**
   * Record one stage. Stages other than the operator signal must move
   * strictly forward through the section 22.3 order, and each is
   * write-once.
   */
  async record(
    stage: LifecycleStage,
    evidenceSource: LifecycleEvidenceSource,
    details: LifecycleDetails,
    now: Clock
  ): Promise<StageFact> {
    if (!LIFECYCLE_STAGES.includes(stage)) {
      throw invalidInput(
        LifecycleCode.StageUnknown,
        `Unknown lifecycle stage: ${stage}.`
      );
    }
    const observedAt = formatRfc3339(now());
    if (stage === OPERATOR_SIGNAL_STAGE) {
      return this.append(stage, observedAt, evidenceSource, details);
    }
    if (this.recorded.some((fact) => fact.stage === stage)) {
      throw invalidInput(
        LifecycleCode.StageDuplicate,
        `Lifecycle stage ${stage} was already recorded and cannot be recorded again.`
      );
    }
    const index = orderIndexOf(stage);
    if (index <= this.lastOrderIndex) {
      throw invalidInput(
        LifecycleCode.StageOutOfOrder,
        `Lifecycle stage ${stage} cannot follow ${
          ORDERED_STAGES[this.lastOrderIndex] ?? "nothing"
        }; stages only move forward.`
      );
    }
    this.lastOrderIndex = index;
    return this.append(stage, observedAt, evidenceSource, details);
  }

  private async append(
    stage: LifecycleStage,
    observedAt: string,
    evidenceSource: LifecycleEvidenceSource,
    details: LifecycleDetails
  ): Promise<StageFact> {
    const event = await this.stream.emit(
      lifecycleStage({
        stage,
        recorded_at: observedAt,
        evidence_source: evidenceSource,
        details,
        observed_at: observedAt
      })
    );
    const fact: StageFact = Object.freeze({
      stage,
      sequence: event.sequence,
      recordedAt: observedAt
    });
    this.recorded.push(fact);
    return fact;
  }

  /** Frozen view of every stage fact persisted so far. */
  snapshot(): LifecycleSnapshot {
    return snapshotOf(this.recorded);
  }
}

/** Project lifecycle events onto their section 22.3 record shape. */
export function stageRecordsOf(
  events: readonly LifecycleEvent[]
): readonly LifecycleStageRecord[] {
  const records: LifecycleStageRecord[] = [];
  for (const event of events) {
    if (event.type === "lifecycle.stage") {
      records.push(stageRecord(event));
    }
  }
  return records;
}

/**
 * Rebuild a snapshot from records read back from lifecycle.jsonl, for
 * example after a controller died. Sequences must increase, and the
 * monotonic stage order must hold, so a corrupt ledger fails loudly
 * instead of silently feeding disposition derivation.
 */
export function snapshotOfRecords(
  records: readonly LifecycleStageRecord[]
): LifecycleSnapshot {
  const facts: StageFact[] = [];
  let lastSequence = 0;
  let lastOrderIndex = -1;
  const seen = new Set<LifecycleStage>();
  for (const record of records) {
    if (!LIFECYCLE_STAGES.includes(record.stage)) {
      throw invalidInput(
        LifecycleCode.RecordInvalid,
        `Recovered record holds unknown stage ${record.stage}.`
      );
    }
    if (record.sequence <= lastSequence) {
      throw invalidInput(
        LifecycleCode.RecordInvalid,
        `Recovered lifecycle sequences do not increase at stage ${record.stage}.`
      );
    }
    lastSequence = record.sequence;
    if (record.stage === OPERATOR_SIGNAL_STAGE) {
      facts.push(
        Object.freeze({
          stage: record.stage,
          sequence: record.sequence,
          recordedAt: record.recorded_at
        })
      );
      continue;
    }
    if (seen.has(record.stage)) {
      throw invalidInput(
        LifecycleCode.RecordInvalid,
        `Recovered ledger records stage ${record.stage} twice.`
      );
    }
    seen.add(record.stage);
    const index = orderIndexOf(record.stage);
    if (index <= lastOrderIndex) {
      throw invalidInput(
        LifecycleCode.RecordInvalid,
        `Recovered ledger records stage ${record.stage} out of order.`
      );
    }
    lastOrderIndex = index;
    facts.push(
      Object.freeze({
        stage: record.stage,
        sequence: record.sequence,
        recordedAt: record.recorded_at
      })
    );
  }
  return snapshotOf(facts);
}
