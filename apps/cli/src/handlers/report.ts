/**
 * `oal report` (specification section 23.10). The JSON output is the
 * canonical Report document; terminal and markdown are projections of
 * it. `--regrade` needs an explicit rubric and produces a derived
 * lineage that records the evaluator identity and rubric digest.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  diagnostic,
  formatRfc3339,
  isJsonObject,
  sha256HexBytes,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { LifecycleEvent } from "@oal/evidence";
import {
  evaluateRubric,
  loadRubric,
  toEvaluation,
  type Evaluation,
  type Rubric
} from "@oal/evaluator";
import {
  buildReport,
  reportSha256,
  type ParticipantReportStatus,
  type Report,
  type TrialInput
} from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  missingArgument,
  tooManyArguments,
  invalidOptionValue
} from "../usage.ts";
import {
  participantReportOf,
  preloadRubricSchemas,
  readRubricDocument,
  runMetadataOf,
  writeDerivedEvaluation
} from "./evaluate.ts";
import {
  assignmentEventsOf,
  assignmentFinishedOf,
  assignmentViewOf,
  batchRootOf,
  loadRunOrBatch,
  scopeOf,
  trialsOf,
  verifyTrialArtifacts,
  type LoadedTrial,
  type RunOrBatch
} from "./run-tree.ts";

/** Stable diagnostic codes of the report command. */
export const ReportCliCode = {
  HtmlUnsupported: "OAL-REPORT-HTML-UNSUPPORTED",
  RegradeNeedsRubric: "OAL-REPORT-REGRADE-NEEDS-RUBRIC",
  EvidenceDrift: "OAL-REPORT-EVIDENCE-DRIFT",
  TerminalFromLedger: "OAL-REPORT-TERMINAL-FROM-LEDGER"
} as const;

/** Read one string field of a JSON object. */
function stringOf(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Assemble one TrialInput from a recorded run directory. */
export function trialInputOf(
  trial: LoadedTrial,
  evaluation: Evaluation | null,
  assignment: {
    readonly assignmentId: string | null;
    readonly replacementOf: string | null;
    readonly terminal: LifecycleEvent | null;
  }
): TrialInput {
  const usage = trial.usage ?? {};
  const number = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  const summary = trial.stateSummary ?? {};
  const stateSha = stringOf(summary, "state_sha256");
  const reportStatus = readReportStatus(trial);
  return {
    run_id: trial.runId,
    evidence_uri: trial.root,
    eval_id: evalIdOf(trial),
    ...(assignment.assignmentId === null
      ? {}
      : { assignment_id: assignment.assignmentId }),
    ...(assignment.replacementOf === null
      ? {}
      : { replacement_of: assignment.replacementOf }),
    events: [
      ...trial.lifecycle,
      ...trial.session,
      ...(assignment.terminal === null ? [] : [assignment.terminal])
    ],
    trace: [...trial.trace],
    ...(evaluation === null ? {} : { evaluation }),
    ...(reportStatus === null
      ? {}
      : { participant_report_status: reportStatus }),
    usage: {
      tokens: number(usage["total_tokens"]),
      tool_calls: number(usage["tool_calls"]),
      provider_cost: number(usage["provider_cost"])
    },
    final_state:
      stateSha === null
        ? null
        : { state_sha256: stateSha, summary: summary as Json }
  };
}

/**
 * Resolve the scheduling view of every trial of one subject: its
 * assignment identifier, its replacement parent, and its terminal
 * lifecycle record. The runner writes the terminal fact to the batch
 * assignment ledger, so the record projects from there when the trial
 * lifecycle holds no terminal event of its own.
 */
export function assignmentsOf(
  subject: RunOrBatch,
  trials: readonly LoadedTrial[]
): {
  readonly views: readonly {
    readonly trial: LoadedTrial;
    readonly assignmentId: string | null;
    readonly replacementOf: string | null;
    readonly terminal: LifecycleEvent | null;
  }[];
  readonly fromLedger: number;
} {
  const ledger = assignmentEventsOf(subject);
  const views = trials.map((trial) => {
    const view = assignmentViewOf(ledger, trial.runId);
    const lifecycleTerminal = trial.lifecycle.some(
      (event) => event.type === "run.finished"
    );
    const terminal = lifecycleTerminal
      ? null
      : assignmentFinishedOf(ledger, trial.runId);
    return {
      trial,
      assignmentId: view.assignmentId,
      replacementOf: view.replacementOf,
      terminal
    };
  });
  return {
    views,
    fromLedger: views.filter((view) => view.terminal !== null).length
  };
}

/** The recorded participant-report status of one trial. */
function readReportStatus(trial: LoadedTrial): ParticipantReportStatus | null {
  const holder =
    trial.completed === null
      ? null
      : isJsonObject(trial.completed["participant_report"])
        ? trial.completed["participant_report"]
        : null;
  const status = holder === null ? null : stringOf(holder, "status");
  if (
    status === "absent" ||
    status === "malformed" ||
    status === "schema_invalid" ||
    status === "valid" ||
    status === "unavailable_due_to_infrastructure"
  ) {
    return status;
  }
  return null;
}

/** The eval identifier one run started under, when recorded. */
function evalIdOf(trial: LoadedTrial): string | null {
  const extensions = trial.started["extensions"];
  if (isJsonObject(extensions)) {
    const evalId = stringOf(extensions, "eval_id");
    if (evalId !== null) {
      return evalId;
    }
  }
  return null;
}

/**
 * Frozen batch inputs that carry implementation identity. Each digest
 * enters the report provenance under its key.
 */
const IMPLEMENTATION_INPUTS: readonly {
  readonly file: string;
  readonly key: string;
}[] = [
  { file: "pack.frozen.yaml", key: "pack_manifest" },
  { file: "contract.ir.json", key: "contract_ir" },
  { file: "capability-report.json", key: "capability_report" },
  { file: "run-profile.frozen.yaml", key: "run_profile" },
  { file: "rubric.frozen.yaml", key: "eval_document" },
  { file: "result-schema.frozen.json", key: "result_schema" },
  { file: "participant-surface-template.json", key: "participant_surface" },
  { file: "instructions.frozen.md", key: "instructions" },
  { file: "task.frozen.md", key: "task" },
  { file: "prompt.frozen.txt", key: "prompt" }
];

/**
 * Digest every frozen implementation input of one batch. A plain batch
 * carries no study cell, so its compatibility keys stay empty and the
 * provenance records what the tree can prove: the implementation bytes.
 */
export async function implementationOf(
  inputsDir: string | null
): Promise<Record<string, string>> {
  const implementation: Record<string, string> = {};
  if (inputsDir === null) {
    return implementation;
  }
  for (const entry of IMPLEMENTATION_INPUTS) {
    const bytes = await readFile(path.join(inputsDir, entry.file)).catch(
      () => null
    );
    if (bytes !== null) {
      implementation[entry.key] = sha256HexBytes(new Uint8Array(bytes));
    }
  }
  return implementation;
}

/** The frozen inputs directory of one resolved run-or-batch argument. */
export async function inputsDirOf(
  subject: RunOrBatch,
  root: string
): Promise<string | null> {
  if (subject.kind === "batch") {
    return subject.batch.inputsDir;
  }
  const batchRoot = await batchRootOf(root);
  return batchRoot === null ? null : path.join(batchRoot, "inputs");
}

/** Build the batch report over one resolved run-or-batch argument. */
export function reportOf(
  subject: RunOrBatch,
  trials: readonly {
    readonly trial: LoadedTrial;
    readonly evaluation: Evaluation | null;
  }[],
  options: {
    readonly lineage?: "derived";
    readonly extensions?: Record<string, Json>;
    readonly implementation?: Record<string, string>;
  } = {}
): Report {
  const scope = scopeOf(subject);
  const views = new Map(
    assignmentsOf(
      subject,
      trials.map((entry) => entry.trial)
    ).views.map((view) => [view.trial.runId, view])
  );
  return buildReport({
    scope: {
      level: "batch",
      id: scope.id,
      ...(options.lineage === undefined ? {} : { lineage: options.lineage })
    },
    trials: trials.map((entry) => {
      const view = views.get(entry.trial.runId);
      return trialInputOf(entry.trial, entry.evaluation, {
        assignmentId: view?.assignmentId ?? null,
        replacementOf: view?.replacementOf ?? null,
        terminal: view?.terminal ?? null
      });
    }),
    ...(options.implementation === undefined ||
    Object.keys(options.implementation).length === 0
      ? {}
      : { provenance: { implementation: options.implementation } }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions })
  });
}

/** Re-grade one trial with a loaded rubric over its recorded evidence. */
export function regradeTrial(
  trial: LoadedTrial,
  rubric: Rubric,
  schemas: ReadonlyMap<string, Json>
): Evaluation {
  const result = evaluateRubric({
    rubric,
    runId: trial.runId,
    run: runMetadataOf(trial),
    events: trial.trace,
    state: (trial.stateFinal ?? {}) as Json,
    report: participantReportOf(trial.participantText),
    resolveSchema: (reference): Json | undefined => schemas.get(reference),
    evaluatedAt: formatRfc3339(Date.now())
  });
  return toEvaluation(result);
}

/** Render the terminal projection of one report. */
export function terminalLinesOf(report: Report): readonly string[] {
  const lines: string[] = [];
  lines.push(`report: ${report.scope.level} ${report.scope.id}`);
  if (report.scope.lineage !== undefined) {
    lines.push(`lineage: ${report.scope.lineage}`);
  }
  lines.push(`sha256: ${reportSha256(report)}`);
  const counts = report.counts;
  lines.push(`trials: ${counts.launched_trials}`);
  const dispositions = Object.entries(counts.dispositions)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  lines.push(`dispositions: ${dispositions.length === 0 ? "-" : dispositions}`);
  const outcomes = Object.entries(counts.task_outcomes)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  lines.push(`task outcomes: ${outcomes.length === 0 ? "-" : outcomes}`);
  for (const metric of report.metrics) {
    lines.push(
      `metric: ${metric.id} ${metric.numerator}/${metric.denominator}`
    );
  }
  lines.push(`requests: ${report.behavior.api.request_total}`);
  lines.push(`warnings: ${report.warnings.length}`);
  return lines;
}

/** Render the markdown projection of one report. */
export function markdownOf(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Report ${report.scope.id}`);
  lines.push("");
  lines.push(`- Scope: ${report.scope.level} ${report.scope.id}`);
  if (report.scope.lineage !== undefined) {
    lines.push(`- Lineage: ${report.scope.lineage}`);
  }
  lines.push(`- Digest: ${reportSha256(report)}`);
  lines.push(`- Trials: ${report.counts.launched_trials}`);
  lines.push(`- Requests: ${report.behavior.api.request_total}`);
  lines.push(`- Warnings: ${report.warnings.length}`);
  lines.push("");
  lines.push("| Metric | Numerator | Denominator |");
  lines.push("| --- | ---: | ---: |");
  for (const metric of report.metrics) {
    lines.push(
      `| ${metric.id} | ${metric.numerator} | ${metric.denominator} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `oal report <run-or-batch>` (specification section 23.10). */
export const reportCommand: CommandHandler = async (args, io) => {
  const target = args.positionals[0];
  if (target === undefined) {
    throw missingArgument(args.command.name, "run-or-batch");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format === "html") {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "report",
        code: ReportCliCode.HtmlUnsupported,
        message:
          "The HTML projection is not implemented in this build. Use " +
          "--format json, terminal, or markdown."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  const root = path.resolve(args.context.cwd, target);
  const subject = await loadRunOrBatch(root);
  const trials = trialsOf(subject);

  const drift: Diagnostic[] = [];
  for (const trial of trials) {
    for (const finding of await verifyTrialArtifacts(trial)) {
      drift.push(
        diagnostic({
          severity: "error",
          phase: "report",
          code: ReportCliCode.EvidenceDrift,
          message: `Artifact verification failed for ${finding.path}: ${finding.detail}`,
          details: { run_id: trial.runId, path: finding.path }
        })
      );
    }
  }
  if (drift.length > 0) {
    emitDiagnostics(io, args.context, drift);
    return EXIT_INVALID;
  }

  const regrade = args.flags.has("regrade");
  const rubricFlag = args.flags.string("rubric");
  let rubric: Rubric | null = null;
  let rubricSha: string | null = null;
  let rubricSchemas: ReadonlyMap<string, Json> = new Map();
  let evaluatorIdentity: { name: string; version: string } | null = null;
  if (regrade) {
    if (rubricFlag === undefined) {
      emitDiagnostics(io, args.context, [
        diagnostic({
          severity: "error",
          phase: "report",
          code: ReportCliCode.RegradeNeedsRubric,
          message:
            "--regrade needs --rubric: the run tree freezes the eval " +
            "document that points at the rubric, not the rubric bytes."
        })
      ]);
      return EXIT_INVALID;
    }
    const rubricPath = path.resolve(args.context.cwd, rubricFlag);
    const read = await readRubricDocument(rubricPath);
    const loaded = loadRubric(read.document, { documentUri: rubricPath });
    if (loaded.rubric === null) {
      emitDiagnostics(io, args.context, loaded.diagnostics);
      return EXIT_INVALID;
    }
    rubric = loaded.rubric;
    rubricSha = read.sha256;
    rubricSchemas = await preloadRubricSchemas(rubricPath, rubric, {
      emit: (entry): void => {
        emitDiagnostics(io, args.context, [entry]);
      }
    });
  }

  const entries: { trial: LoadedTrial; evaluation: Evaluation | null }[] = [];
  const derived: string[] = [];
  for (const trial of trials) {
    let evaluation = trial.evaluation;
    if (regrade && rubric !== null && rubricSha !== null) {
      const regenerated = regradeTrial(trial, rubric, rubricSchemas);
      evaluatorIdentity = regenerated.evaluator ?? null;
      evaluation = regenerated;
      const artifact = await writeDerivedEvaluation(
        trial.root,
        rubricSha,
        regenerated
      );
      derived.push(artifact);
    }
    entries.push({ trial, evaluation });
  }

  const extensions: Record<string, Json> = {};
  if (regrade && rubricSha !== null) {
    extensions["regrade"] = {
      rubric_sha256: rubricSha,
      ...(evaluatorIdentity === null
        ? {}
        : {
            evaluator: `${evaluatorIdentity.name} ${evaluatorIdentity.version}`
          }),
      derived_evaluations: derived
    };
  }
  const implementation = await implementationOf(
    await inputsDirOf(subject, root)
  );
  const ledgerTerminals = assignmentsOf(
    subject,
    trials.map((trial) => trial)
  ).fromLedger;
  if (ledgerTerminals > 0) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "warning",
        phase: "report",
        code: ReportCliCode.TerminalFromLedger,
        message:
          `${ledgerTerminals} trial(s) hold no run.finished lifecycle event; ` +
          "their terminal disposition projects from the batch assignment " +
          "ledger, which the runner writes instead."
      })
    ]);
  }
  const report = reportOf(subject, entries, {
    ...(regrade ? { lineage: "derived" } : {}),
    ...(Object.keys(implementation).length === 0 ? {} : { implementation }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions })
  });

  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(report as unknown as Json));
  } else if (args.context.format === "markdown") {
    io.stdout(markdownOf(report));
  } else {
    for (const line of terminalLinesOf(report)) {
      io.stdout(line);
    }
    for (const artifact of derived) {
      io.stderr(`derived evaluation: ${artifact}`);
    }
  }
  const outPath = args.context.outPath;
  if (outPath !== null) {
    const text =
      args.context.format === "markdown"
        ? markdownOf(report)
        : `${stableJsonStringify(report as unknown as Json)}\n`;
    await writeFile(outPath, text);
  }
  return EXIT_OK;
};

/** Read one report document from disk. */
export async function readReport(target: string): Promise<Report> {
  const text = await readFile(target, "utf8").catch(() => null);
  if (text === null) {
    throw invalidOptionValue("report", target, "one readable Report file");
  }
  let parsed: Json | undefined;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    throw invalidOptionValue(
      "report",
      target,
      `valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const record = isJsonObject(parsed) ? parsed : null;
  if (record === null || record["kind"] !== "Report") {
    throw invalidOptionValue("report", target, "one Report document");
  }
  return parsed as unknown as Report;
}
