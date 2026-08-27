/**
 * Virtual clock (specification sections 12 and 17.4).
 *
 * Logical time starts at the default epoch 2000-01-01T00:00:00.000Z unless a
 * scenario configures another initial value. Every committed request advances
 * logical time by `tick_ms`, one millisecond by default. Wall time never
 * affects mock behavior; observed timestamps are separate observational fields.
 */

import {
  formatRfc3339,
  isRfc3339,
  parseRfc3339,
  VIRTUAL_EPOCH_MS
} from "@oal/core";

export interface VirtualClockOptions {
  /** Initial logical time in epoch milliseconds. Default: virtual epoch. */
  initialMs?: number;
  /** Logical milliseconds added by one committed request. Default: 1. */
  tickMs?: number;
}

export interface VirtualClockSnapshot {
  nowMs: number;
  now: string;
  tickMs: number;
}

function requireIntegerMs(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${what} must be a nonnegative integer number of milliseconds.`
    );
  }
  return value;
}

/** Deterministic logical clock producing RFC 3339 UTC timestamps. */
export class VirtualClock {
  private currentMs: number;
  readonly tickMs: number;

  constructor(options?: VirtualClockOptions) {
    const initialMs =
      options?.initialMs === undefined
        ? VIRTUAL_EPOCH_MS
        : requireIntegerMs(options.initialMs, "initialMs");
    const tickMs =
      options?.tickMs === undefined ? 1 : requireIntegerMs(options.tickMs, "tickMs");
    this.currentMs = initialMs;
    this.tickMs = tickMs;
  }

  /** Current logical time in epoch milliseconds. */
  nowMs(): number {
    return this.currentMs;
  }

  /** Current logical time as an RFC 3339 UTC string. */
  now(): string {
    return formatRfc3339(this.currentMs);
  }

  /**
   * Advance logical time by `ms`, or by one tick when omitted. Scenarios use
   * explicit advances instead of sleeping.
   */
  advance(ms?: number): string {
    const step = ms === undefined ? this.tickMs : requireIntegerMs(ms, "ms");
    this.currentMs += step;
    return formatRfc3339(this.currentMs);
  }

  /** Advance logical time by exactly one tick (one committed request). */
  tick(): string {
    return this.advance(this.tickMs);
  }

  /**
   * Set logical time to an absolute value. Accepts an RFC 3339 UTC string or
   * epoch milliseconds; moving backwards is rejected because the event log is
   * append-only in logical time.
   */
  set(value: string | number): string {
    const targetMs =
      typeof value === "number"
        ? requireIntegerMs(value, "value")
        : parseRfc3339(requireIso(value));
    if (targetMs < this.currentMs) {
      throw new Error(
        `Virtual clock cannot move backwards from ${formatRfc3339(this.currentMs)} to ${formatRfc3339(targetMs)}.`
      );
    }
    this.currentMs = targetMs;
    return formatRfc3339(this.currentMs);
  }

  snapshot(): VirtualClockSnapshot {
    return { nowMs: this.currentMs, now: formatRfc3339(this.currentMs), tickMs: this.tickMs };
  }
}

function requireIso(value: string): string {
  if (!isRfc3339(value)) {
    throw new Error(
      `Virtual clock accepts RFC 3339 UTC timestamps, got ${JSON.stringify(value)}.`
    );
  }
  return value;
}
