/** One task that keeps the stateful milestone from readiness. */
export interface StatefulBlockingTask {
  readonly id: string;
  readonly phase: string;
  readonly status: string;
  readonly summary: string;
}

/** Result of evaluating a stateful acceptance map. */
export interface StatefulReadinessResult {
  readonly ok: boolean;
  readonly blocking: readonly StatefulBlockingTask[];
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Evaluate the tasks of a stateful acceptance map. A task blocks while
 * it is pending or partial, and a completed task that requires live
 * provider verification blocks until a live pass is recorded.
 */
export declare function evaluateStatefulReadiness(
  tasks: readonly unknown[]
): StatefulReadinessResult;
