/**
 * `oal friction <run-or-batch>`. Deterministic analysis of recorded
 * trials: every friction incident the trace can prove, plus the sidecar
 * worklist that removes it. A serve session directory is accepted as a
 * third subject kind and reports its incidents as origin external. A
 * measurement is not a verdict, so the command exits EXIT_OK whatever
 * it finds; only usage and unsupported projections fail.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_OK,
  type ExitCode,
  EXIT_UNSUPPORTED,
  diagnostic,
  formatRfc3339,
  stableJsonStringify,
  type Json
} from "@oal/core";
import { buildFrictionReport, type FrictionReport } from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { missingArgument, tooManyArguments } from "../usage.ts";
import {
  loadRunOrBatch,
  scopeOf,
  trialsOf,
  type LoadedTrial,
  type RunOrBatch
} from "./run-tree.ts";

/** Stable diagnostic codes of the friction command. */
export const FrictionCliCode = {
  ProjectionUnsupported: "OAL-FRICTION-PROJECTION-UNSUPPORTED"
} as const;

/** Build the friction report of one resolved run-or-batch argument. */
export function frictionOf(
  subject: RunOrBatch,
  trials: readonly LoadedTrial[]
): FrictionReport {
  // A serve session was recorded without the runner harness, so its
  // incidents report origin external instead of api.
  const source = subject.kind === "session" ? "external" : "runner";
  return buildFrictionReport({
    scope: scopeOf(subject),
    trials: trials.map((trial) => ({
      runId: trial.runId,
      events: trial.trace,
      ...(source === "external" ? { source: "external" as const } : {})
    })),
    generatedAt: formatRfc3339(Date.now())
  });
}

/** Terminal projection of one friction report, doctor style. */
export function frictionLines(report: FrictionReport): readonly string[] {
  const lines: string[] = [];
  lines.push(`friction: ${report.scope.level} ${report.scope.id}`);
  for (const incident of report.incidents) {
    const where = incident.operation ?? "-";
    const near =
      incident.near_miss_of === null ? "" : ` near ${incident.near_miss_of}`;
    lines.push(
      `incident: ${incident.kind} [${incident.class}/${incident.origin}] ` +
        `${where}${near} x${incident.occurrences} trials=${incident.trials.length}`
    );
  }
  if (report.worklist.length === 0) {
    lines.push("worklist: empty");
  } else {
    lines.push(`worklist: ${report.worklist.length} item(s)`);
    for (const item of report.worklist) {
      const fixture =
        item.fixture === undefined
          ? ""
          : ` fixture=${item.fixture.status} ${item.fixture.media_type} (${item.fixture.body_kind})`;
      lines.push(`  ${item.action} ${item.operation ?? "-"}${fixture}`);
      lines.push(`    ${item.summary}`);
    }
  }
  const byClass = Object.entries(report.counts.incidents_by_class)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  lines.push(
    `counts: trials=${report.counts.trials} exchanges=${report.counts.exchanges} ` +
      `operations=${report.counts.operations} incidents=${report.counts.incidents}` +
      (byClass === "" ? "" : ` (${byClass})`) +
      ` worklist=${report.counts.worklist_items}`
  );
  return lines;
}

/**
 * The exit code of a friction run: always EXIT_OK, because a finding is
 * the product, not a failure.
 */
export function frictionExitCode(): ExitCode {
  return EXIT_OK;
}

/** `oal friction <run-or-batch>` (specification section 23.10). */
export const frictionCommand: CommandHandler = async (args, io) => {
  const target = args.positionals[0];
  if (target === undefined) {
    throw missingArgument(args.command.name, "run-or-batch");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format === "html" || args.context.format === "markdown") {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "report",
        code: FrictionCliCode.ProjectionUnsupported,
        message:
          "The friction report renders as JSON or terminal only. Use " +
          "--format json or terminal."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  const root = path.resolve(args.context.cwd, target);
  const subject = await loadRunOrBatch(root, { sessions: "allow" });
  const report = frictionOf(subject, trialsOf(subject));
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(report as unknown as Json));
  } else {
    for (const line of frictionLines(report)) {
      io.stdout(line);
    }
  }
  const outPath = args.context.outPath;
  if (outPath !== null) {
    await writeFile(
      outPath,
      `${stableJsonStringify(report as unknown as Json)}\n`
    );
  }
  return frictionExitCode();
};
