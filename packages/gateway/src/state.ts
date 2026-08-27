/**
 * Gateway state transactions (specification section 15.1 step 13).
 * The pipeline stages one transaction per served product request and
 * commits it only after response validation passes, so an invalid
 * backend result never becomes visible state.
 */

export interface GatewayState {
  /** Stage one domain effect inside the open transaction. */
  stage(effect: string): void;
  /** Apply the open transaction and bump the revision. */
  commit(): void;
  /** Discard the open transaction; the revision stays unchanged. */
  rollback(): void;
  /** Number of committed transactions. */
  readonly revision: number;
  /** Effects of committed transactions, in commit order. */
  readonly appliedEffects: readonly string[];
  /** Effects still staged in the open transaction. */
  readonly pendingEffects: readonly string[];
  /** Transactions discarded after failed response validation. */
  readonly rollbacks: number;
}

/**
 * In-memory GatewayState. The pipeline runs synchronously, so one
 * transaction is open at a time and no interleaving is possible.
 */
export function createGatewayState(): GatewayState {
  let revision = 0;
  let rollbacks = 0;
  let pending: string[] = [];
  const applied: string[] = [];
  return {
    stage(effect: string): void {
      pending.push(effect);
    },
    commit(): void {
      applied.push(...pending);
      pending = [];
      revision += 1;
    },
    rollback(): void {
      pending = [];
      rollbacks += 1;
    },
    get revision(): number {
      return revision;
    },
    get appliedEffects(): readonly string[] {
      return applied;
    },
    get pendingEffects(): readonly string[] {
      return pending;
    },
    get rollbacks(): number {
      return rollbacks;
    }
  };
}
