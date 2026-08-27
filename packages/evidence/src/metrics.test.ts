import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";
import {
  METRICS_CARDINALITY_EXCEEDED,
  METRICS_INVALID_INCREMENT,
  METRICS_MISSING_LABEL,
  METRICS_UNKNOWN_LABEL,
  METRICS_UNKNOWN_LABEL_VALUE,
  METRICS_UNKNOWN_METRIC,
  METRICS_UNSAFE_LABEL,
  Metrics
} from "./metrics.ts";

function codeOf(action: () => void): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof OalError) {
      return error.code;
    }
    throw error;
  }
}

describe("Metrics registration", () => {
  it("rejects unsafe metric names and label values", () => {
    const metrics = new Metrics({ enabled: true });
    expect(
      codeOf(() => {
        metrics.register("Run Count");
      })
    ).toBe(METRICS_UNSAFE_LABEL);
    expect(
      codeOf(() => {
        metrics.register("compile.diagnostics", { code: ["/tmp/pack.yaml"] });
      })
    ).toBe(METRICS_UNSAFE_LABEL);
    expect(
      codeOf(() => {
        metrics.register("compile.diagnostics", { code: ["a".repeat(65)] });
      })
    ).toBe(METRICS_UNSAFE_LABEL);
  });

  it("refuses label values that look like ids or digests", () => {
    const metrics = new Metrics({ enabled: true });
    expect(
      codeOf(() => {
        metrics.register("run.counts", { run: ["run_01"] });
      })
    ).toBeUndefined();
    expect(
      codeOf(() => {
        metrics.register("run.ids", { run: ["run_0123456789abcdef01234567"] });
      })
    ).toBe(METRICS_UNSAFE_LABEL);
    expect(
      codeOf(() => {
        metrics.register("contract.digest", { sha256: ["a".repeat(64)] });
      })
    ).toBe(METRICS_UNSAFE_LABEL);
  });

  it("caps registered label values", () => {
    const metrics = new Metrics({ enabled: true });
    const values: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      values.push(`v${index}`);
    }
    expect(
      codeOf(() => {
        metrics.register("bounded.metric", { key: values });
      })
    ).toBe(METRICS_CARDINALITY_EXCEEDED);
  });

  it("refuses to register one metric twice", () => {
    const metrics = new Metrics({ enabled: true });
    metrics.register("compile.diagnostics", { severity: ["info", "error"] });
    expect(
      codeOf(() => {
        metrics.register("compile.diagnostics");
      })
    ).toBe(METRICS_CARDINALITY_EXCEEDED);
  });
});

describe("Metrics recording", () => {
  it("counts by registered labels and returns a sorted snapshot", () => {
    const metrics = new Metrics({ enabled: true });
    metrics.register("compile.diagnostics", {
      severity: ["info", "warning", "error"]
    });
    metrics.register("run.disposition", { disposition: ["completed"] });
    metrics.record("compile.diagnostics", { severity: "error" });
    metrics.record("compile.diagnostics", { severity: "error" });
    metrics.record("compile.diagnostics", { severity: "info" });
    metrics.record("run.disposition", { disposition: "completed" });
    expect(metrics.snapshot()).toEqual({
      enabled: true,
      counters: [
        {
          name: "compile.diagnostics",
          labels: { severity: "error" },
          value: 2
        },
        { name: "compile.diagnostics", labels: { severity: "info" }, value: 1 },
        {
          name: "run.disposition",
          labels: { disposition: "completed" },
          value: 1
        }
      ]
    });
  });

  it("rejects unknown metrics, label keys, and label values", () => {
    const metrics = new Metrics({ enabled: true });
    metrics.register("run.disposition", { disposition: ["completed"] });
    expect(
      codeOf(() => {
        metrics.record("unregistered.metric");
      })
    ).toBe(METRICS_UNKNOWN_METRIC);
    expect(
      codeOf(() => {
        metrics.record("run.disposition", { cell: "a" });
      })
    ).toBe(METRICS_UNKNOWN_LABEL);
    expect(
      codeOf(() => {
        metrics.record("run.disposition", { disposition: "timed_out" });
      })
    ).toBe(METRICS_UNKNOWN_LABEL_VALUE);
    expect(
      codeOf(() => {
        metrics.record("run.disposition");
      })
    ).toBe(METRICS_MISSING_LABEL);
    expect(
      codeOf(() => {
        metrics.record("run.disposition", { disposition: "x" }, 0);
      })
    ).toBe(METRICS_INVALID_INCREMENT);
    expect(metrics.snapshot().counters).toEqual([]);
  });

  it("is a no-op while telemetry is disabled", () => {
    const metrics = new Metrics();
    expect(metrics.enabled).toBe(false);
    metrics.record("compile.diagnostics", { severity: "error" });
    expect(metrics.snapshot()).toEqual({ enabled: false, counters: [] });
    expect(new Metrics({ enabled: true }).enabled).toBe(true);
  });

  it("keeps every snapshot deterministic", () => {
    const metrics = new Metrics({ enabled: true });
    metrics.register("lifecycle.stage", {
      stage: ["scheduled", "server_ready"]
    });
    metrics.record("lifecycle.stage", { stage: "server_ready" });
    metrics.record("lifecycle.stage", { stage: "scheduled" }, 3);
    const first = JSON.stringify(metrics.snapshot());
    const second = JSON.stringify(metrics.snapshot());
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual({
      enabled: true,
      counters: [
        {
          name: "lifecycle.stage",
          labels: { stage: "scheduled" },
          value: 3
        },
        { name: "lifecycle.stage", labels: { stage: "server_ready" }, value: 1 }
      ]
    });
  });
});
