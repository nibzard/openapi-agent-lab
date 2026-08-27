/**
 * State-store resource limits.
 *
 * Field names and default values mirror specification section 31.1 so a caller
 * can pass the matching subset of a resolved `LimitTable` without the store
 * depending on `@oal/config`. Every value is configurable downward.
 */

export interface StateStoreLimits {
  /** Requests (control plus participant) allowed in one run. Default 10,000. */
  maxRequestsPerRun: number;
  /** Total persisted API-event JSON bytes. Default 100 MiB. */
  maxEventLogBytes: number;
  /** Serialized domain-state bytes. Default 100 MiB. */
  maxPersistedStateBytes: number;
  /** Top-level entries in the domain-state document. Default 10,000. */
  maxDomainObjects: number;
  /** Idempotency entries retained per run. Default 10,000. */
  maxIdempotencyEntries: number;
}

export const STATE_STORE_LIMIT_DEFAULTS: Readonly<StateStoreLimits> = {
  maxRequestsPerRun: 10_000,
  maxEventLogBytes: 100 * 1024 * 1024,
  maxPersistedStateBytes: 100 * 1024 * 1024,
  maxDomainObjects: 10_000,
  maxIdempotencyEntries: 10_000
};

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Apply caller overrides to the section 31.1 defaults. Values must be positive
 * integers; the caller enforces ceilings because this package owns no ceiling
 * table.
 */
export function resolveStateStoreLimits(
  overrides?: Partial<StateStoreLimits>
): StateStoreLimits {
  const resolved: StateStoreLimits = { ...STATE_STORE_LIMIT_DEFAULTS };
  if (overrides === undefined) {
    return resolved;
  }
  for (const key of Object.keys(overrides) as Array<keyof StateStoreLimits>) {
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    if (!isPositiveInteger(value)) {
      throw new Error(
        `State-store limit ${key} must be a positive integer, got ${String(value)}.`
      );
    }
    resolved[key] = value;
  }
  return resolved;
}
