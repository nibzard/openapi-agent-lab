/**
 * `oal workflow run` (specification sections 20.3 and 20.4). The
 * command compiles the Arazzo documents of a pack and aligns one
 * workflow against the recorded trace of a run. The scripted
 * control-run executor of section 20.4 does not exist in this build,
 * so the command refuses to launch anything and reports the closest
 * honest behavior: hidden alignment over evidence that already exists.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_EVAL_THRESHOLD,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  diagnostic,
  invalidInput,
  isSafeId,
  stableJsonStringify,
  type Diagnostic,
  type Json
} from "@oal/core";
import {
  alignWorkflow,
  compileArazzo,
  parseArazzo,
  type AlignmentEvent,
  type CompiledWorkflow,
  type WorkflowAlignment,
  type WorkflowIR
} from "@oal/arazzo";
import type { TraceBody, TraceEvent } from "@oal/evidence";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { missingArgument, tooManyArguments } from "../usage.ts";
import { loadTrial } from "./run-tree.ts";
import { compileServeSource } from "./serve.ts";

/** Stable diagnostic codes of the workflow command. */
export const WorkflowCliCode = {
  NoExecutor: "OAL-WORKFLOW-NO-EXECUTOR",
  NoDocuments: "OAL-WORKFLOW-NO-DOCUMENTS",
  WorkflowUnknown: "OAL-WORKFLOW-UNKNOWN",
  AlignmentFailed: "OAL-WORKFLOW-ALIGNMENT-FAILED"
} as const;

/** File names the workflow loader accepts below `workflows/`. */
const WORKFLOW_EXTENSIONS: ReadonlySet<string> = new Set([
  ".yaml",
  ".yml",
  ".json"
]);

/** One compiled Arazzo document with its origin. */
export interface CompiledWorkflowSource {
  readonly documentPath: string;
  readonly ir: WorkflowIR;
}

/**
 * Compile every workflow document below `<pack>/workflows`. The pack
 * manifest declares no workflow reference role, so the loader reads the
 * directory directly and keeps the diagnostics of every file.
 */
export async function compileWorkflowDocuments(
  packRoot: string,
  contract: Parameters<typeof compileArazzo>[1]
): Promise<CompiledWorkflowSource[]> {
  const directory = path.join(packRoot, "workflows");
  const names = await readdir(directory)
    .catch(() => [])
    .then((found) => found.sort());
  const compiled: CompiledWorkflowSource[] = [];
  for (const name of names) {
    if (!WORKFLOW_EXTENSIONS.has(path.extname(name))) {
      continue;
    }
    const documentPath = path.join(directory, name);
    if ((await stat(documentPath).catch(() => null))?.isDirectory()) {
      continue;
    }
    const text = await readFile(documentPath, "utf8");
    const parsed = parseArazzo(text, { documentUri: documentPath });
    if (parsed.document === null) {
      compiled.push({
        documentPath,
        ir: emptyIr(documentPath, parsed.diagnostics)
      });
      continue;
    }
    compiled.push({
      documentPath,
      ir: compileArazzo(parsed.document, contract, {
        documentUri: documentPath
      })
    });
  }
  return compiled;
}

/** Placeholder IR carrying only parse diagnostics. */
function emptyIr(
  documentPath: string,
  diagnostics: readonly Diagnostic[]
): WorkflowIR {
  return {
    schema_version: 1,
    kind: "WorkflowIR",
    compiler: { name: "oal-arazzo", version: "0.0.0" },
    source: {
      document_uri: documentPath,
      arazzo_version: "0",
      source_descriptions: []
    },
    workflows: [],
    diagnostics: [...diagnostics]
  } as unknown as WorkflowIR;
}

/** The JSON value one recorded body carries, or null when opaque. */
export function bodyValueOf(body: TraceBody): Json | null {
  if (body.kind === "json") {
    return body.value;
  }
  if (body.kind === "text") {
    return body.text;
  }
  return null;
}

/** Adapt the recorded trace of one run to the alignment event shape. */
export function alignmentEventsOf(
  trace: readonly TraceEvent[]
): AlignmentEvent[] {
  return trace
    .filter((event) => event.actor === "participant")
    .map((event) => ({
      sequence: event.sequence,
      operationKey: event.operation.key,
      request:
        event.request === null
          ? null
          : { body: bodyValueOf(event.request.body) },
      response:
        event.response === null
          ? null
          : {
              status: event.response.status,
              body: bodyValueOf(event.response.body)
            }
    }));
}

/** Counts of each step outcome of one alignment. */
export function outcomeCountsOf(
  alignment: WorkflowAlignment
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of alignment.steps) {
    counts[step.outcome] = (counts[step.outcome] ?? 0) + 1;
  }
  return counts;
}

/** Serialize one alignment for the JSON document. */
function alignmentJson(
  runId: string,
  documentPath: string,
  alignment: WorkflowAlignment
): Json {
  return {
    workflow_id: alignment.workflow_id,
    run_id: runId,
    document: documentPath,
    matched: alignment.matched,
    ambiguous: alignment.ambiguous,
    truncated: alignment.truncated,
    candidates_tried: alignment.candidates_tried,
    assignment_count: alignment.assignment_count,
    outcomes: outcomeCountsOf(alignment),
    steps: alignment.steps.map(
      (step): Json => ({
        step_id: step.step_id,
        outcome: step.outcome,
        reason: step.reason,
        event_sequences: [...step.event_sequences],
        alternative_sequences: [...step.alternative_sequences],
        resolved_outputs: step.resolved_outputs,
        criteria: step.criteria.map(
          (criterion): Json => ({
            condition: criterion.condition,
            passed: criterion.passed,
            error: criterion.error
          })
        )
      })
    )
  };
}

/** Render the terminal projection of one alignment. */
export function alignmentLinesOf(alignment: WorkflowAlignment): string[] {
  const lines: string[] = [];
  lines.push(`workflow: ${alignment.workflow_id}`);
  lines.push(`matched: ${alignment.matched}`);
  lines.push(`ambiguous: ${alignment.ambiguous}`);
  if (alignment.truncated) {
    lines.push("truncated: true");
  }
  lines.push(`candidates tried: ${alignment.candidates_tried}`);
  const counts = outcomeCountsOf(alignment);
  lines.push(
    `steps: ${alignment.steps.length} ` +
      Object.entries(counts)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
  );
  for (const step of alignment.steps) {
    const sequences = step.event_sequences.join(",");
    lines.push(
      `step: ${step.step_id} ${step.outcome}` +
        (step.reason === null ? "" : ` (${step.reason})`) +
        (sequences.length === 0 ? "" : ` events=${sequences}`)
    );
    for (const criterion of step.criteria) {
      lines.push(
        `criterion: ${criterion.passed ? "passed" : "failed"} ${criterion.condition}`
      );
    }
  }
  return lines;
}

/** `oal workflow run <pack> --workflow <id> --run <run-dir>`. */
export const workflowCommand: CommandHandler = async (args, io) => {
  const source = args.positionals[0];
  if (source === undefined) {
    throw missingArgument(args.command.name, "pack");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const runFlag = args.flags.string("run");
  if (runFlag === undefined) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "run",
        code: WorkflowCliCode.NoExecutor,
        message:
          "This build has no scripted control-run executor, so it cannot " +
          "launch a workflow itself (specification section 20.4 marks " +
          "that executor as future work). Align an already recorded run " +
          "with --run <run-dir>."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidInput(
      "OAL-WORKFLOW-FORMAT-UNSUPPORTED",
      "workflow run writes terminal or JSON output only."
    );
  }

  const packRoot = path.resolve(args.context.cwd, source);
  const compiled = await compileServeSource(
    source,
    args.context.cwd,
    args.context.maxSourceBytes
  );
  if (compiled.pack === null) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "ingest",
        code: WorkflowCliCode.NoDocuments,
        message:
          `Source ${packRoot} is not a pack, so it declares no workflow ` +
          "documents."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  const documents = await compileWorkflowDocuments(packRoot, compiled.contract);
  const diagnostics: Diagnostic[] = [];
  for (const document of documents) {
    diagnostics.push(...document.ir.diagnostics);
  }
  const hasErrors = diagnostics.some((entry) => entry.severity === "error");
  const workflows: { documentPath: string; workflow: CompiledWorkflow }[] = [];
  for (const document of documents) {
    for (const workflow of document.ir.workflows) {
      workflows.push({ documentPath: document.documentPath, workflow });
    }
  }
  if (workflows.length === 0) {
    emitDiagnostics(io, args.context, [
      ...diagnostics,
      diagnostic({
        severity: "error",
        phase: "ingest",
        code: WorkflowCliCode.NoDocuments,
        message: hasErrors
          ? "No workflow compiled; every document below workflows/ reported errors."
          : `Pack ${packRoot} declares no workflow document below workflows/.`
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  const workflowFlag = args.flags.string("workflow");
  let selected: { documentPath: string; workflow: CompiledWorkflow } | null =
    null;
  if (workflowFlag === undefined) {
    if (workflows.length > 1) {
      throw invalidInput(
        WorkflowCliCode.WorkflowUnknown,
        "The pack declares more than one workflow; pass --workflow with " +
          `one of: ${workflows.map((entry) => entry.workflow.workflow_id).join(", ")}.`
      );
    }
    selected = workflows[0] ?? null;
  } else {
    if (!isSafeId(workflowFlag)) {
      throw invalidInput(
        WorkflowCliCode.WorkflowUnknown,
        `Workflow identifier "${workflowFlag}" is not a safe identifier.`
      );
    }
    selected =
      workflows.find((entry) => entry.workflow.workflow_id === workflowFlag) ??
      null;
  }
  if (selected === null) {
    throw invalidInput(
      WorkflowCliCode.WorkflowUnknown,
      `The pack declares no workflow "${workflowFlag}". Known workflows: ` +
        `${workflows.map((entry) => entry.workflow.workflow_id).join(", ")}.`
    );
  }

  const runDir = path.resolve(args.context.cwd, runFlag);
  const trial = await loadTrial(runDir);
  const events = alignmentEventsOf(trial.trace);
  const alignment = alignWorkflow(selected.workflow, events);

  if (diagnostics.length > 0) {
    emitDiagnostics(io, args.context, diagnostics);
  }
  if (!alignment.matched) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "warning",
        phase: "evaluate",
        code: WorkflowCliCode.AlignmentFailed,
        message:
          `Workflow ${alignment.workflow_id} does not match the recorded ` +
          `trace of ${trial.runId}; the failing step and every later step ` +
          "are listed in the alignment."
      })
    ]);
  }

  const document = {
    kind: "WorkflowCli",
    pack: packRoot,
    run: runDir,
    alignment: alignmentJson(trial.runId, selected.documentPath, alignment)
  } as unknown as Json;
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(document));
  } else {
    for (const line of alignmentLinesOf(alignment)) {
      io.stdout(line);
    }
  }
  return alignment.matched ? EXIT_OK : EXIT_EVAL_THRESHOLD;
};
