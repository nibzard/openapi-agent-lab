import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";

import {
  DEFAULT_ALPHA,
  DEFAULT_FAMILY_ID,
  comparePairedMetrics,
  compareReports,
  computeCompatibility
} from "./compare.ts";
import {
  emptyCensorClassCounts,
  emptyTaskOutcomeCounts,
  type Report
} from "./model.ts";
import { SHA_A, SHA_B } from "./fixtures.ts";

interface RateSpec {
  id: string;
  numerator: number;
  denominator: number;
}

/**
 * Minimal valid report with hand-set metrics, so the comparison math is
 * tested against exact numerators and denominators.
 */
function rateReport(
  scopeId: string,
  metrics: readonly RateSpec[],
  compatibility: readonly string[],
  extensions: Record<string, Json> = {}
): Report {
  return {
    schema_version: 1,
    kind: "Report",
    scope: { level: "batch", id: scopeId },
    counts: {
      primary_assignments: 0,
      activated_replacements: 0,
      operational_assignments: 0,
      launched_trials: 0,
      held_unused: 0,
      not_started: 0,
      dispositions: {},
      evidence_integrity: { intact: 0, corrupt: 0, missing: 0 },
      censor_classes: emptyCensorClassCounts(),
      task_outcomes: emptyTaskOutcomeCounts()
    },
    metrics: metrics.map((metric) => ({
      id: metric.id,
      numerator: metric.numerator,
      denominator: metric.denominator,
      availability: {
        observed: metric.denominator,
        unknown: 0,
        not_applicable: 0,
        unavailable_due_to_evidence: 0
      }
    })),
    estimates: [],
    behavior: {
      api: {
        request_total: 0,
        status_distribution: {},
        operation_frequency: {}
      },
      documentation: { request_total: 0, outcome_distribution: {} }
    },
    surfaces: {
      participant_reports: {
        absent: 0,
        malformed: 0,
        schema_invalid: 0,
        valid: 0,
        agreement: null
      }
    },
    provenance: {
      cells: compatibility.map((digest) => ({
        cell_id: "cell-a",
        factor_levels: { model: "test-model" },
        compatibility_sha256: digest
      })),
      implementation: {}
    },
    warnings: [],
    extensions
  };
}

/** Baseline 2/10 and 8/10 against candidate 9/10 and 3/10. */
function comparisonPair(): { baseline: Report; candidate: Report } {
  const extensions = { analytical_status: "analytical" } as Record<
    string,
    Json
  >;
  return {
    baseline: rateReport(
      "batch-base",
      [
        { id: "pass_rate", numerator: 2, denominator: 10 },
        { id: "report_rate", numerator: 8, denominator: 10 }
      ],
      [SHA_A],
      extensions
    ),
    candidate: rateReport(
      "batch-cand",
      [
        { id: "pass_rate", numerator: 9, denominator: 10 },
        { id: "report_rate", numerator: 3, denominator: 10 }
      ],
      [SHA_A],
      extensions
    )
  };
}

describe("compatibility gate (section 27.5)", () => {
  it("accepts equal compatibility keys with equal analytical status", () => {
    const { baseline, candidate } = comparisonPair();
    const gate = computeCompatibility(baseline, candidate);
    expect(gate.compatible).toBe(true);
    expect(gate.differences).toEqual([]);
  });

  it("refuses pooled estimates when compatibility keys differ", () => {
    const { baseline, candidate } = comparisonPair();
    const other = rateReport(
      "batch-cand",
      [{ id: "pass_rate", numerator: 9, denominator: 10 }],
      [SHA_B]
    );
    const gate = computeCompatibility(baseline, other);
    expect(gate.compatible).toBe(false);
    expect(gate.differences).toContain(
      `compatibility key only in baseline: ${SHA_A}`
    );
    expect(gate.differences).toContain(
      `compatibility key only in candidate: ${SHA_B}`
    );
    expect(candidate.provenance.cells).toHaveLength(1);
  });

  it("refuses the comparison when neither side carries keys", () => {
    const baseline = rateReport("b", [], []);
    const candidate = rateReport("c", [], []);
    const gate = computeCompatibility(baseline, candidate);
    expect(gate.compatible).toBe(false);
    expect(gate.differences).toEqual([
      "neither report carries compatibility keys"
    ]);
  });

  it("refuses the comparison when only one side carries keys", () => {
    const baseline = rateReport("b", [], [SHA_A]);
    const candidate = rateReport("c", [], []);
    const gate = computeCompatibility(baseline, candidate);
    expect(gate.compatible).toBe(false);
    expect(gate.differences).toEqual([
      "one report carries no compatibility keys"
    ]);
  });

  it("refuses mixed analytical and smoke data", () => {
    const { baseline } = comparisonPair();
    const smoke = rateReport(
      "batch-cand",
      [{ id: "pass_rate", numerator: 9, denominator: 10 }],
      [SHA_A],
      { analytical_status: "smoke" }
    );
    const gate = computeCompatibility(baseline, smoke);
    expect(gate.compatible).toBe(false);
    expect(gate.differences).toContain(
      "analytical status differs: baseline analytical, candidate smoke"
    );
  });
});

describe("comparison math (section 27.6)", () => {
  it("computes deltas, intervals, and adjusted p-values", () => {
    const { baseline, candidate } = comparisonPair();
    const comparison = compareReports(baseline, candidate);
    expect(comparison.compatible).toBe(true);
    expect(comparison.interpretation).toBe("descriptive");
    expect(comparison.metrics.map((metric) => metric.metric_id)).toEqual([
      "pass_rate",
      "report_rate"
    ]);

    const passRate = comparison.metrics[0];
    expect(passRate?.baseline).toEqual({
      numerator: 2,
      denominator: 10,
      rate: 0.2
    });
    expect(passRate?.candidate).toEqual({
      numerator: 9,
      denominator: 10,
      rate: 0.9
    });
    expect(passRate?.delta).toBeCloseTo(0.7, 12);
    // Newcombe interval for 9/10 minus 2/10, verified independently.
    expect(passRate?.interval?.[0]).toBeCloseTo(0.265826609700883, 12);
    expect(passRate?.interval?.[1]).toBeCloseTo(0.8651796660831854, 12);
    // Fisher exact p for [[9, 1], [2, 8]].
    expect(passRate?.p_value).toBeCloseTo(0.005477494641581338, 12);
    // Holm step-down with two tests in the family.
    expect(passRate?.adjusted_p_value).toBeCloseTo(0.010954989283162676, 12);
    expect(passRate?.verdict).toBe("difference_detected");

    const reportRate = comparison.metrics[1];
    expect(reportRate?.delta).toBeCloseTo(-0.5, 12);
    // Newcombe interval for 3/10 minus 8/10.
    expect(reportRate?.interval?.[0]).toBeCloseTo(-0.7397586340406183, 12);
    expect(reportRate?.interval?.[1]).toBeCloseTo(-0.06647631448630209, 12);
    // Fisher exact p for [[3, 7], [8, 2]].
    expect(reportRate?.p_value).toBeCloseTo(0.06977851869492753, 12);
    expect(reportRate?.adjusted_p_value).toBeCloseTo(0.06977851869492753, 12);
    expect(reportRate?.verdict).toBe("no_difference_detected");

    expect(comparison.family_id).toBe(DEFAULT_FAMILY_ID);
    expect(comparison.alpha).toBe(DEFAULT_ALPHA);
    expect(comparison.maximum_claim).toContain("Descriptive");
  });

  it("returns null instead of inventing values for empty denominators", () => {
    const baseline = rateReport(
      "b",
      [{ id: "pass_rate", numerator: 2, denominator: 10 }],
      [SHA_A]
    );
    const candidate = rateReport(
      "c",
      [{ id: "pass_rate", numerator: 0, denominator: 0 }],
      [SHA_A]
    );
    const comparison = compareReports(baseline, candidate);
    const metric = comparison.metrics[0];
    expect(metric?.verdict).toBe("not_estimable");
    expect(metric?.delta).toBeNull();
    expect(metric?.interval).toBeNull();
    expect(metric?.p_value).toBeNull();
    expect(metric?.adjusted_p_value).toBeNull();
    expect(metric?.candidate?.rate).toBeNull();
  });

  it("lists metrics that exist on one side only", () => {
    const baseline = rateReport(
      "b",
      [
        { id: "pass_rate", numerator: 2, denominator: 10 },
        { id: "legacy_rate", numerator: 1, denominator: 4 }
      ],
      [SHA_A]
    );
    const candidate = rateReport(
      "c",
      [
        { id: "pass_rate", numerator: 9, denominator: 10 },
        { id: "new_rate", numerator: 3, denominator: 4 }
      ],
      [SHA_A]
    );
    const comparison = compareReports(baseline, candidate);
    expect(comparison.only_baseline_metric_ids).toEqual(["legacy_rate"]);
    expect(comparison.only_candidate_metric_ids).toEqual(["new_rate"]);
    expect(comparison.metrics.map((metric) => metric.metric_id)).toEqual([
      "pass_rate"
    ]);
  });
});

describe("incompatible reports", () => {
  it("shows counts side by side without any pooled estimate", () => {
    const baseline = rateReport(
      "b",
      [{ id: "pass_rate", numerator: 2, denominator: 10 }],
      [SHA_A]
    );
    const candidate = rateReport(
      "c",
      [{ id: "pass_rate", numerator: 9, denominator: 10 }],
      [SHA_B]
    );
    const comparison = compareReports(baseline, candidate, {
      paired: [
        {
          metric_id: "pass_rate",
          counts: { both: 6, onlyFirst: 1, onlySecond: 3, neither: 0 }
        }
      ]
    });
    expect(comparison.compatible).toBe(false);
    expect(comparison.interpretation).toBe("incompatible");
    expect(comparison.family_id).toBeNull();
    const metric = comparison.metrics[0];
    expect(metric?.verdict).toBe("not_compared_incompatible");
    expect(metric?.baseline?.rate).toBe(0.2);
    expect(metric?.candidate?.rate).toBe(0.9);
    expect(metric?.delta).toBeNull();
    expect(metric?.p_value).toBeNull();
    const paired = comparison.paired[0];
    expect(paired?.verdict).toBe("not_compared_incompatible");
    expect(paired?.difference).toBeNull();
    expect(paired?.p_value).toBeNull();
    expect(comparison.maximum_claim).toContain("no pooled estimate");
  });
});

describe("paired comparisons (section 27.6)", () => {
  it("computes the paired difference and exact McNemar p-value", () => {
    const results = comparePairedMetrics(
      [
        {
          metric_id: "task_pass",
          counts: { both: 6, onlyFirst: 1, onlySecond: 3, neither: 0 }
        }
      ],
      0.05
    );
    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(entry?.metric_id).toBe("task_pass");
    // (1 - 3) / 10: first condition minus second condition.
    expect(entry?.difference).toBeCloseTo(-0.2, 12);
    expect(entry?.discordant).toBe(4);
    expect(entry?.n).toBe(10);
    // Exact two-sided binomial over four discordant pairs.
    expect(entry?.p_value).toBeCloseTo(0.625, 12);
    expect(entry?.adjusted_p_value).toBeCloseTo(0.625, 12);
    expect(entry?.verdict).toBe("no_difference_detected");
  });

  it("sorts paired entries by metric id and marks empty pairs", () => {
    const results = comparePairedMetrics(
      [
        {
          metric_id: "zeta_pass",
          counts: { both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 }
        },
        {
          metric_id: "alpha_pass",
          counts: { both: 5, onlyFirst: 5, onlySecond: 0, neither: 0 }
        }
      ],
      0.05
    );
    expect(results.map((entry) => entry.metric_id)).toEqual([
      "alpha_pass",
      "zeta_pass"
    ]);
    const empty = results[1];
    expect(empty?.verdict).toBe("not_estimable");
    expect(empty?.difference).toBeNull();
    expect(empty?.p_value).toBeNull();
    // Five discordant pairs on one side: exact p is 2 / 2^5.
    const oneSided = results[0];
    expect(oneSided?.p_value).toBeCloseTo(0.0625, 12);
    expect(oneSided?.difference).toBeCloseTo(0.5, 12);
  });
});

describe("comparison determinism", () => {
  it("produces identical output for identical inputs", () => {
    const { baseline, candidate } = comparisonPair();
    const first = compareReports(baseline, candidate, {
      family_id: "holm-family"
    });
    const second = compareReports(baseline, candidate, {
      family_id: "holm-family"
    });
    expect(first).toEqual(second);
    expect(first.family_id).toBe("holm-family");
  });
});

describe("pairing inference (section 27.6)", () => {
  const SEED = "steel-baseline-2026-08-27";

  /** Two cells of one study: equal keys, equal status, one shared seed. */
  function sharedSeedPair(): { baseline: Report; candidate: Report } {
    const extensions = {
      analytical_status: "analytical",
      cohort_seed: SEED
    } as Record<string, Json>;
    return {
      baseline: rateReport(
        "cell-baseline",
        [{ id: "pass_rate", numerator: 2, denominator: 10 }],
        [SHA_A],
        extensions
      ),
      candidate: rateReport(
        "cell-candidate",
        [{ id: "pass_rate", numerator: 9, denominator: 10 }],
        [SHA_A],
        extensions
      )
    };
  }

  it("never pairs two cells that only share a cohort seed", () => {
    const { baseline, candidate } = sharedSeedPair();
    const comparison = compareReports(baseline, candidate);
    // The shared seed is a cell-identity concern, not a pairing and not
    // a compatibility refusal.
    expect(comparison.paired).toEqual([]);
    expect(comparison.compatible).toBe(true);
    expect(comparison.pairing_warnings).toEqual([
      `shared cohort seed ${SEED} never establishes pairing (section 27.6)`
    ]);
    // The metrics stay independent: Fisher and Newcombe, never McNemar.
    const metric = comparison.metrics[0];
    expect(metric?.verdict).toBe("difference_detected");
    expect(metric?.p_value).not.toBeNull();
    expect(metric?.interval).not.toBeNull();
  });

  it("reads a shared cohort seed from cell input digests", () => {
    const seedDigest = "c".repeat(64);
    const withDigest = (id: string): Report => ({
      ...rateReport(
        id,
        [{ id: "pass_rate", numerator: 2, denominator: 10 }],
        [SHA_A]
      ),
      provenance: {
        cells: [
          {
            cell_id: id,
            factor_levels: { model: "test-model" },
            compatibility_sha256: SHA_A,
            input_digests: { cohort_seed: seedDigest }
          }
        ],
        implementation: {}
      }
    });
    const comparison = compareReports(
      withDigest("cell-baseline"),
      withDigest("cell-candidate")
    );
    expect(comparison.paired).toEqual([]);
    expect(comparison.pairing_warnings).toEqual([
      `shared cohort seed ${seedDigest} never establishes pairing (section 27.6)`
    ]);
  });

  it("stays silent when the seeds differ or pairing is declared", () => {
    const { baseline, candidate } = sharedSeedPair();
    const otherSeed = {
      ...candidate,
      extensions: {
        ...candidate.extensions,
        cohort_seed: "steel-replacement-2026-08-27"
      }
    };
    expect(compareReports(baseline, otherSeed).pairing_warnings).toEqual([]);

    const paired = compareReports(baseline, candidate, {
      paired: [
        {
          metric_id: "pass_rate",
          counts: { both: 2, onlyFirst: 0, onlySecond: 7, neither: 1 }
        }
      ]
    });
    expect(paired.pairing_warnings).toEqual([]);
    expect(paired.paired).toHaveLength(1);
    expect(paired.paired[0]?.metric_id).toBe("pass_rate");
  });
});
