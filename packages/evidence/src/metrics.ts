/**
 * Bounded-cardinality metric recording (specification section 33.2).
 * Every metric name, label key, and label value is registered before
 * use, so raw paths, contract hashes, run ids, user text, pack object
 * ids, and credential material can never enter a label. Local
 * telemetry is off by default; a disabled recorder drops every
 * observation.
 */

import { invalidInput } from "@oal/core";

/** Stable code for a metric name that was never registered. */
export const METRICS_UNKNOWN_METRIC = "OAL-METRICS-UNKNOWN-METRIC";

/** Stable code for a label key that the metric never declared. */
export const METRICS_UNKNOWN_LABEL = "OAL-METRICS-UNKNOWN-LABEL";

/** Stable code for a declared label key the caller did not supply. */
export const METRICS_MISSING_LABEL = "OAL-METRICS-MISSING-LABEL";

/** Stable code for a label value outside the registered set. */
export const METRICS_UNKNOWN_LABEL_VALUE = "OAL-METRICS-UNKNOWN-LABEL-VALUE";

/** Stable code for a name or value the recorder refuses to register. */
export const METRICS_UNSAFE_LABEL = "OAL-METRICS-UNSAFE-LABEL";

/** Stable code for a non-positive increment. */
export const METRICS_INVALID_INCREMENT = "OAL-METRICS-INVALID-INCREMENT";

/** Stable code for a registration that would break the cardinality cap. */
export const METRICS_CARDINALITY_EXCEEDED = "OAL-METRICS-CARDINALITY-EXCEEDED";

/** Maximum registered values for one label key. */
export const MAX_LABEL_VALUES = 64;

/** Maximum distinct series held by one recorder. */
export const MAX_SERIES = 4096;

const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const LABEL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Label grammar. It allows status classes such as "5xx" and reason
 * codes such as "OAL-OK", and rejects separators and whitespace.
 */
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Control ids and hexadecimal digests never belong in a label. */
const CONTROL_ID_PATTERN = /^(run|bat|asg)_[a-f0-9]{16,32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{40,64}$/;

/** One counter series. Label keys are sorted for a stable form. */
export interface MetricCounter {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

/** Deterministic sorted view of every recorded series. */
export interface MetricsSnapshot {
  enabled: boolean;
  counters: MetricCounter[];
}

export interface MetricsOptions {
  /** Local telemetry gate; false by default (section 33.2). */
  enabled?: boolean | undefined;
}

/** Label keys to allowed values for one metric. */
export type MetricLabels = Readonly<Record<string, readonly string[]>>;

export class Metrics {
  readonly enabled: boolean;

  private readonly metrics = new Map<string, MetricLabels>();

  private readonly counters = new Map<string, MetricCounter>();

  constructor(options: MetricsOptions = {}) {
    this.enabled = options.enabled ?? false;
  }

  /**
   * Declare one metric with its bounded label sets. Registration still
   * validates when telemetry is disabled, so bad setup surfaces early.
   */
  register(name: string, labels: MetricLabels = {}): void {
    requireMetricName(name);
    if (this.metrics.has(name)) {
      throw invalidInput(
        METRICS_CARDINALITY_EXCEEDED,
        `metric ${name} is already registered`,
        { name }
      );
    }
    for (const key of Object.keys(labels).sort()) {
      requireLabelKey(key);
      const values = labels[key] ?? [];
      if (values.length > MAX_LABEL_VALUES) {
        throw invalidInput(
          METRICS_CARDINALITY_EXCEEDED,
          `label ${key} of ${name} registers more than ${MAX_LABEL_VALUES} values`,
          { name, label: key }
        );
      }
      for (const value of values) {
        requireLabelValue(value, key);
      }
    }
    this.metrics.set(name, sortLabelSets(labels));
  }

  /**
   * Add to one counter. A disabled recorder ignores the call. An
   * unknown metric, label key, or label value throws a stable code.
   */
  record(
    name: string,
    labels: Readonly<Record<string, string>> = {},
    increment = 1
  ): void {
    if (!this.enabled) {
      return;
    }
    const declared = this.metrics.get(name);
    if (declared === undefined) {
      throw invalidInput(
        METRICS_UNKNOWN_METRIC,
        `metric ${name} is not registered`,
        { name }
      );
    }
    if (!Number.isFinite(increment) || increment <= 0) {
      throw invalidInput(
        METRICS_INVALID_INCREMENT,
        "counter increment must be a positive number",
        { name, increment }
      );
    }
    const supplied = sortLabelValues(labels);
    for (const key of Object.keys(supplied)) {
      const allowed = declared[key];
      if (allowed === undefined) {
        throw invalidInput(
          METRICS_UNKNOWN_LABEL,
          `label ${key} is not registered for metric ${name}`,
          { name, label: key }
        );
      }
      const value = supplied[key] ?? "";
      if (!allowed.includes(value)) {
        throw invalidInput(
          METRICS_UNKNOWN_LABEL_VALUE,
          `label ${key} value ${value} is not registered for metric ${name}`,
          { name, label: key, value }
        );
      }
    }
    for (const key of Object.keys(declared)) {
      if (!(key in supplied)) {
        throw invalidInput(
          METRICS_MISSING_LABEL,
          `label ${key} is required for metric ${name}`,
          { name, label: key }
        );
      }
    }
    const series = this.counters.get(seriesKey(name, supplied));
    if (series === undefined && this.counters.size >= MAX_SERIES) {
      throw invalidInput(
        METRICS_CARDINALITY_EXCEEDED,
        `recorder holds more than ${MAX_SERIES} series`,
        { name }
      );
    }
    if (series === undefined) {
      this.counters.set(seriesKey(name, supplied), {
        name,
        labels: supplied,
        value: increment
      });
      return;
    }
    series.value += increment;
  }

  /** Deterministic sorted view of every recorded series. */
  snapshot(): MetricsSnapshot {
    const counters = [...this.counters.values()].map(cloneCounter);
    counters.sort(compareCounters);
    return { enabled: this.enabled, counters };
  }
}

function seriesKey(
  name: string,
  labels: Readonly<Record<string, string>>
): string {
  const parts = [name];
  for (const key of Object.keys(labels)) {
    parts.push(`${key}=${labels[key] ?? ""}`);
  }
  return parts.join("|");
}

function cloneCounter(counter: MetricCounter): MetricCounter {
  return {
    name: counter.name,
    labels: { ...counter.labels },
    value: counter.value
  };
}

function sortLabelSets(
  labels: Readonly<Record<string, readonly string[]>>
): Record<string, readonly string[]> {
  const sorted: Record<string, readonly string[]> = {};
  for (const key of Object.keys(labels).sort()) {
    sorted[key] = [...(labels[key] ?? [])].sort();
  }
  return sorted;
}

function sortLabelValues(
  labels: Readonly<Record<string, string>>
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    sorted[key] = labels[key] ?? "";
  }
  return sorted;
}

function compareCounters(left: MetricCounter, right: MetricCounter): number {
  if (left.name !== right.name) {
    return left.name < right.name ? -1 : 1;
  }
  const leftKeys = Object.keys(left.labels);
  const rightKeys = Object.keys(right.labels);
  const length = Math.max(leftKeys.length, rightKeys.length);
  for (let index = 0; index < length; index += 1) {
    const leftKey = leftKeys[index];
    const rightKey = rightKeys[index];
    if (leftKey === undefined) {
      return -1;
    }
    if (rightKey === undefined) {
      return 1;
    }
    if (leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }
    const leftValue = left.labels[leftKey] ?? "";
    const rightValue = right.labels[rightKey] ?? "";
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return 0;
}

function requireMetricName(name: string): void {
  if (!METRIC_NAME_PATTERN.test(name)) {
    throw invalidInput(
      METRICS_UNSAFE_LABEL,
      `metric name ${name} is not a stable lowercase name`,
      { name }
    );
  }
}

function requireLabelKey(key: string): void {
  if (!LABEL_KEY_PATTERN.test(key)) {
    throw invalidInput(
      METRICS_UNSAFE_LABEL,
      `label key ${key} is not a stable lowercase name`,
      { label: key }
    );
  }
}

function requireLabelValue(value: string, key: string): void {
  if (!LABEL_VALUE_PATTERN.test(value)) {
    throw invalidInput(
      METRICS_UNSAFE_LABEL,
      `label value ${value} for ${key} contains forbidden characters`,
      { label: key, value }
    );
  }
  if (CONTROL_ID_PATTERN.test(value) || DIGEST_PATTERN.test(value)) {
    throw invalidInput(
      METRICS_UNSAFE_LABEL,
      `label value ${value} for ${key} looks like a control id or digest`,
      { label: key, value }
    );
  }
}
