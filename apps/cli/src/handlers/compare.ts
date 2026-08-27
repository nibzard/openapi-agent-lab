/**
 * `oal compare` (specification section 23.11). A descriptive comparison
 * of two batches, run trees, or saved Report documents. The command
 * never pools incompatible batches and never selects a winner.
 */

import path from "node:path";

import {
  EXIT_OK,
  invalidInput,
  stableJsonStringify,
  type Json
} from "@oal/core";
import {
  compareReports,
  computeCompatibility,
  type Report,
  type ReportComparison
} from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { invalidOptionValue, missingArgument } from "../usage.ts";
import {
  implementationOf,
  inputsDirOf,
  readReport,
  reportOf
} from "./report.ts";
import { loadRunOrBatch, trialsOf, verifyTrialArtifacts } from "./run-tree.ts";

/** Stable diagnostic codes of the compare command. */
export const CompareCliCode = {
  SameTarget: "OAL-COMPARE-SAME-TARGET",
  HtmlUnsupported: "OAL-COMPARE-HTML-UNSUPPORTED"
} as const;

/** One side of a comparison, already resolved to a Report. */
export interface CompareSide {
  readonly label: string;
  readonly report: Report;
}

/** Resolve one compare argument: a Report file, a batch, or a run. */
export async function compareSideOf(
  target: string,
  cwd: string
): Promise<CompareSide> {
  const absolute = path.resolve(cwd, target);
  const asReport = await readReport(absolute).catch(() => null);
  if (asReport !== null) {
    return { label: absolute, report: asReport };
  }
  const subject = await loadRunOrBatch(absolute);
  const trials = trialsOf(subject);
  for (const trial of trials) {
    const drift = await verifyTrialArtifacts(trial);
    if (drift.length > 0) {
      throw invalidOptionValue(
        "batch",
        target,
        `a tree whose artifact hashes verify (${drift[0]?.path ?? "manifest"})`
      );
    }
  }
  const implementation = await implementationOf(
    await inputsDirOf(subject, absolute)
  );
  return {
    label: absolute,
    report: reportOf(
      subject,
      trials.map((trial) => ({
        trial,
        evaluation: trial.evaluation
      })),
      Object.keys(implementation).length === 0 ? {} : { implementation }
    )
  };
}

/** Render the terminal projection of one comparison. */
export function comparisonLinesOf(comparison: ReportComparison): string[] {
  const lines: string[] = [];
  lines.push(
    `baseline: ${comparison.baseline_scope.level} ${comparison.baseline_scope.id}`
  );
  lines.push(
    `candidate: ${comparison.candidate_scope.level} ${comparison.candidate_scope.id}`
  );
  lines.push(`compatible: ${comparison.compatible}`);
  for (const difference of comparison.compatibility_differences) {
    lines.push(`difference: ${difference}`);
  }
  lines.push(`interpretation: ${comparison.interpretation}`);
  lines.push(`claim: ${comparison.maximum_claim}`);
  for (const metric of comparison.metrics) {
    const baseline =
      metric.baseline === null
        ? "-"
        : `${metric.baseline.numerator}/${metric.baseline.denominator}`;
    const candidate =
      metric.candidate === null
        ? "-"
        : `${metric.candidate.numerator}/${metric.candidate.denominator}`;
    const delta = metric.delta === null ? "-" : metric.delta.toFixed(4);
    lines.push(
      `metric: ${metric.metric_id} baseline=${baseline} ` +
        `candidate=${candidate} delta=${delta} verdict=${metric.verdict}`
    );
  }
  return lines;
}

/** Render the markdown projection of one comparison. */
export function comparisonMarkdownOf(comparison: ReportComparison): string {
  const lines: string[] = [];
  lines.push(
    `# Comparison ${comparison.baseline_scope.id} vs ${comparison.candidate_scope.id}`
  );
  lines.push("");
  lines.push(`- Compatible: ${comparison.compatible}`);
  lines.push(`- Interpretation: ${comparison.interpretation}`);
  lines.push(`- Claim: ${comparison.maximum_claim}`);
  lines.push("");
  lines.push("| Metric | Baseline | Candidate | Delta | Verdict |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const metric of comparison.metrics) {
    const baseline =
      metric.baseline === null
        ? "-"
        : `${metric.baseline.numerator}/${metric.baseline.denominator}`;
    const candidate =
      metric.candidate === null
        ? "-"
        : `${metric.candidate.numerator}/${metric.candidate.denominator}`;
    const delta = metric.delta === null ? "-" : metric.delta.toFixed(4);
    lines.push(
      `| ${metric.metric_id} | ${baseline} | ${candidate} | ${delta} | ${metric.verdict} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `oal compare <batch-a> <batch-b>` (specification section 23.11). */
export const compareCommand: CommandHandler = async (args, io) => {
  if (args.positionals.length < 2) {
    throw missingArgument(args.command.name, "batch-b");
  }
  if (args.positionals.length > 2) {
    throw invalidOptionValue(
      "batch-a",
      args.positionals[2] ?? "",
      "exactly two compare targets"
    );
  }
  if (args.context.format === "html") {
    throw invalidOptionValue(
      "--format",
      "html",
      "one of: terminal, json, markdown"
    );
  }
  const first = args.positionals[0];
  const second = args.positionals[1];
  if (first === undefined || second === undefined) {
    throw missingArgument(args.command.name, "batch-b");
  }
  if (
    path.resolve(args.context.cwd, first) ===
    path.resolve(args.context.cwd, second)
  ) {
    throw invalidInput(
      CompareCliCode.SameTarget,
      "Both compare targets resolve to the same path; comparison needs " +
        "two distinct trees or reports."
    );
  }
  const baseline = await compareSideOf(first, args.context.cwd);
  const candidate = await compareSideOf(second, args.context.cwd);
  const comparison = compareReports(baseline.report, candidate.report);
  const compatibility = computeCompatibility(baseline.report, candidate.report);
  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        kind: "CompareCli",
        baseline: baseline.label,
        candidate: candidate.label,
        compatible: compatibility.compatible,
        compatibility_differences: compatibility.differences,
        comparison
      } as unknown as Json)
    );
  } else if (args.context.format === "markdown") {
    io.stdout(comparisonMarkdownOf(comparison));
  } else {
    for (const line of comparisonLinesOf(comparison)) {
      io.stdout(line);
    }
  }
  return EXIT_OK;
};
