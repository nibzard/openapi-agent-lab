/**
 * The world fault engine (specification section 48.6). Declared rules
 * match at the three commit boundaries; every consumption commits in
 * its own store transaction - counters, stream position, and one
 * durable consumption row together - so a restart or a fork continues
 * the exact occurrence numbering and random selection. The engine
 * never mutates domain state: before_behavior answers without
 * behavior, before_commit only rolls back, and after_commit acts
 * strictly after everything is durable.
 */

import {
  matchFault,
  validateFaultRules,
  type FaultRule
} from "@oal/behavior-api";
import type {
  GatewayFaultQuery,
  GatewayFaultResponse,
  GatewayFaults
} from "@oal/gateway";
import {
  createNamespacePrng,
  DeterministicPrng,
  type StateStore
} from "@oal/state-store";
import type { Json } from "@oal/core";

/** One recorded fault consumption, in order. */
export interface FaultConsumptionRecord {
  readonly sequence: number;
  readonly ruleId: string;
  readonly occurrence: number;
  readonly phase: string;
  readonly action: string;
}

/** The durable position of the fault engine. */
export interface FaultEngineState {
  readonly counters: Readonly<Record<string, number>>;
  readonly prngState: string;
}

export class WorldFaultInjector implements GatewayFaults {
  private counters = new Map<string, number>();
  private prng: DeterministicPrng;
  private advanced = false;

  constructor(
    private readonly store: StateStore,
    private readonly rules: readonly FaultRule[],
    seed: string,
    restored: FaultEngineState | null
  ) {
    const persisted = restored ?? store.readFaultState();
    if (persisted !== null) {
      for (const [ruleId, count] of Object.entries(persisted.counters)) {
        if (typeof count === "number" && Number.isInteger(count) && count > 0) {
          this.counters.set(ruleId, count);
        }
      }
      this.prng = DeterministicPrng.fromState(persisted.prngState);
    } else {
      this.prng = createNamespacePrng(seed, "faults");
    }
    void this.advanced;
  }

  /** The durable position, for checkpoint export. */
  state(): FaultEngineState {
    const counters: Record<string, number> = {};
    for (const [ruleId, count] of this.counters) {
      counters[ruleId] = count;
    }
    return { counters, prngState: this.prng.exportState() };
  }

  /**
   * Restore the declared baseline: counters restart and the stream
   * returns to its seeded position (section 48.4 reset semantics).
   */
  reset(freshPrngState: string): void {
    this.counters.clear();
    this.prng = DeterministicPrng.fromState(freshPrngState);
    this.persist(-1, null);
  }

  /** Adopt a position after its database transaction commits. */
  restorePosition(position: FaultEngineState): void {
    this.counters.clear();
    for (const [ruleId, count] of Object.entries(position.counters)) {
      this.counters.set(ruleId, count);
    }
    this.prng = DeterministicPrng.fromState(position.prngState);
    this.advanced = false;
  }

  /** Every consumption this world recorded, in order. */
  consumptions(): readonly FaultConsumptionRecord[] {
    return this.store.listFaultConsumptions();
  }

  beforeBehavior(query: GatewayFaultQuery): GatewayFaultResponse | null {
    const evaluation = this.evaluate("before_behavior", query);
    if (evaluation === null || evaluation.rule.action.kind !== "response") {
      return null;
    }
    const action = evaluation.rule.action;
    return {
      status: action.status,
      ...(action.headers === undefined ? {} : { headers: action.headers }),
      ...(action.body === undefined ? {} : { body: action.body })
    };
  }

  corruptCandidate(query: GatewayFaultQuery): boolean {
    const evaluation = this.evaluate("before_commit", query);
    return evaluation !== null;
  }

  afterCommit(
    query: GatewayFaultQuery
  ): { readonly afterBytes: number } | null {
    const evaluation = this.evaluate("after_commit", query);
    if (evaluation === null || evaluation.rule.action.kind !== "disconnect") {
      return null;
    }
    return { afterBytes: evaluation.rule.action.after_bytes ?? 0 };
  }

  /**
   * Match one phase. Counter advances and probability draws mark the
   * engine dirty even without a match, because occurrence numbering
   * and stream position are part of the durable state.
   */
  private evaluate(
    phase: "before_behavior" | "before_commit" | "after_commit",
    query: GatewayFaultQuery
  ): {
    readonly rule: FaultRule;
    readonly occurrence: number;
  } | null {
    const needsSample = this.rules.some(
      (rule) => rule.phase === phase && rule.match.probability !== undefined
    );
    const sample = needsSample ? this.prng.nextFloat() : 0;
    const drewSample = needsSample;
    const counters = {
      next: (ruleId: string): number => {
        const value = (this.counters.get(ruleId) ?? 0) + 1;
        this.counters.set(ruleId, value);
        this.advanced = true;
        return value;
      }
    };
    const parameters: Record<string, Json> = { ...query.parameters };
    const evaluation = matchFault(
      this.rules,
      {
        operation: query.operationKey,
        phase,
        parameters,
        body: query.body,
        nowMs: this.store.clock.nowMs(),
        sample
      },
      counters
    );
    if (evaluation === null) {
      if (this.advanced || drewSample) {
        this.persist(query.sequence, null);
      }
      return null;
    }
    this.persist(query.sequence, {
      ruleId: evaluation.rule.id,
      occurrence: evaluation.occurrence,
      phase,
      action: evaluation.rule.action.kind
    });
    return evaluation;
  }

  /**
   * One consumption transaction: counters, stream position, and the
   * consumption row commit together or not at all. Called after a
   * rollback, this is the explicit separate failure transaction
   * section 48.6 requires, never a partial domain commit.
   */
  private persist(
    sequence: number,
    consumption: {
      readonly ruleId: string;
      readonly occurrence: number;
      readonly phase: string;
      readonly action: string;
    } | null
  ): void {
    const snapshot = this.state();
    this.advanced = false;
    this.store.transaction(() => {
      this.store.writeFaultState(snapshot);
      if (consumption !== null) {
        this.store.appendFaultConsumption({
          sequence,
          ruleId: consumption.ruleId,
          occurrence: consumption.occurrence,
          phase: consumption.phase,
          action: consumption.action,
          createdAt: this.store.clock.now()
        });
      }
    });
  }
}

/** Validate declared rules; error text names the first problem. */
export function faultRuleProblem(rules: readonly FaultRule[]): string | null {
  return validateFaultRules(rules);
}
