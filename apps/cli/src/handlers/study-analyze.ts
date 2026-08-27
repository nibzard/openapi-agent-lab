/**
 * `oal study analyze` (specification section 23.17). The command loads a
 * StudyRun directory, verifies the recorded digests of the protocol
 * lock, the phase plan, and the assignment schedule, then executes
 * exactly the frozen plan through the registered analyzer. A derived
 * analysis plan creates a derived lineage. Aggregating a second
 * StudyRun is refused: no engine in this build accepts more than one
 * StudyRun header, and cross-key pooling is forbidden anyway.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  invalidInput,
  isJsonObject,
  isSafeId,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json
} from "@oal/core";
import {
  assignmentScheduleSha256,
  type AssignmentEvent,
  type AssignmentLedger,
  type AssignmentSchedule
} from "@oal/scheduler";
import {
  analyzeStudyRun,
  studyAnalysisJson,
  type AnalysisLineage,
  type CellEvidence,
  type VerificationEntry
} from "@oal/study";
import {
  loadPhasePlan,
  loadProtocol,
  protocolLockFromJson,
  protocolLockSha256,
  type PhasePlan,
  type ProtocolMetric
} from "@oal/study-ir";
import type { StudyRunHeader } from "@oal/scheduler";
import { parsePackDocument } from "@oal/pack";
import { SchemaValidator } from "@oal/core";
import type { TrialInput } from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { tooManyArguments } from "../usage.ts";
import { loadRunOrBatch, trialsOf } from "./run-tree.ts";
import { assignmentsOf, trialInputOf } from "./report.ts";
import { readSchema, StudyCliCode } from "./study-tree.ts";

/** Stable diagnostic codes of the analyze command. */
export const AnalyzeCode = {
  NotStudyRun: "OAL-STUDY-ANALYZE-NOT-A-STUDY-RUN",
  InputMissing: "OAL-STUDY-ANALYZE-INPUT-MISSING",
  HashMismatch: "OAL-STUDY-ANALYZE-HASH-MISMATCH",
  AggregationUnsupported: "OAL-STUDY-ANALYZE-AGGREGATION-UNSUPPORTED"
} as const;

/** File names of the frozen StudyRun inputs (specification 23.19). */
const RUN_INPUTS = {
  header: "study-run.json",
  ledger: "assignment-events.jsonl",
  protocol: "inputs/study-protocol.frozen.yaml",
  phasePlan: "inputs/phase-plan.frozen.yaml",
  lock: "inputs/protocol.lock.json",
  schedule: "inputs/assignments.json",
  evidence: "inputs/evidence-requirements.json",
  compatibility: "inputs/compatibility.json"
} as const;

/** Read one required text below a study-run directory. */
async function readRequired(
  root: string,
  relative: string
): Promise<{ readonly text: string | null; readonly target: string }> {
  const target = path.join(root, relative);
  const text = await readFile(target, "utf8").catch(() => null);
  return { text, target };
}

/** Validate one JSON document against a repository schema. */
async function schemaErrors(
  name: string,
  document: Json
): Promise<readonly string[]> {
  const schema = await readSchema(name);
  return new SchemaValidator(schema)
    .errors(document)
    .map((entry) => `${entry.code}: ${entry.message}`);
}

/** Load and verify the StudyRun directory. */
export async function loadStudyRun(root: string): Promise<{
  readonly header: StudyRunHeader | null;
  readonly phasePlan: PhasePlan | null;
  readonly schedule: AssignmentSchedule | null;
  readonly ledger: AssignmentLedger | null;
  readonly evidenceRequirementsSha256: string | null;
  readonly verification: readonly VerificationEntry[];
  readonly compatibility: ReadonlyMap<string, string> | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const diagnostics: Diagnostic[] = [];
  const headerRead = await readRequired(root, RUN_INPUTS.header);
  if (headerRead.text === null) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.NotStudyRun,
        message:
          `Directory ${root} holds no ${RUN_INPUTS.header}, so it is not ` +
          "a StudyRun directory."
      })
    );
    return {
      header: null,
      phasePlan: null,
      schedule: null,
      ledger: null,
      evidenceRequirementsSha256: null,
      verification: [],
      compatibility: null,
      diagnostics
    };
  }
  let headerJson: Json;
  try {
    headerJson = JSON.parse(headerRead.text) as Json;
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.NotStudyRun,
        message: `StudyRun header is not valid JSON: ${reason}`
      })
    );
    return {
      header: null,
      phasePlan: null,
      schedule: null,
      ledger: null,
      evidenceRequirementsSha256: null,
      verification: [],
      compatibility: null,
      diagnostics
    };
  }
  for (const violation of await schemaErrors(
    "study-run.v1.schema.json",
    headerJson
  )) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.NotStudyRun,
        message: `StudyRun header fails study-run.v1: ${violation}`
      })
    );
  }
  const header = headerJson as unknown as StudyRunHeader;

  const protocolRead = await readRequired(root, RUN_INPUTS.protocol);
  const phaseRead = await readRequired(root, RUN_INPUTS.phasePlan);
  const lockRead = await readRequired(root, RUN_INPUTS.lock);
  const scheduleRead = await readRequired(root, RUN_INPUTS.schedule);
  const evidenceRead = await readRequired(root, RUN_INPUTS.evidence);
  const compatibilityRead = await readRequired(root, RUN_INPUTS.compatibility);
  for (const [label, read] of [
    ["protocol", protocolRead],
    ["phase plan", phaseRead],
    ["protocol lock", lockRead],
    ["assignment schedule", scheduleRead],
    ["evidence requirements", evidenceRead]
  ] as const) {
    if (read.text === null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.InputMissing,
          message: `Frozen ${label} of StudyRun ${root} is missing: ${read.target}`
        })
      );
    }
  }

  let phasePlan: PhasePlan | null = null;
  if (protocolRead.text !== null && phaseRead.text !== null) {
    const protocolDocument = parsePackDocument(
      protocolRead.text,
      RUN_INPUTS.protocol
    );
    const phaseDocument = parsePackDocument(
      phaseRead.text,
      RUN_INPUTS.phasePlan
    );
    if (protocolDocument.value === null || phaseDocument.value === null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.InputMissing,
          message:
            "A frozen protocol or phase plan of the StudyRun is unreadable."
        })
      );
    } else {
      const protocolLoaded = loadProtocol(protocolDocument.value, {
        schema: await readSchema("study-protocol.v1.schema.json"),
        documentUri: path.join(root, RUN_INPUTS.protocol)
      });
      diagnostics.push(...protocolLoaded.diagnostics);
      if (protocolLoaded.protocol !== null) {
        const phaseLoaded = loadPhasePlan(phaseDocument.value, {
          schema: await readSchema("phase-plan.v1.schema.json"),
          protocol: protocolLoaded.protocol,
          cellCount: header.child_batches.length,
          documentUri: path.join(root, RUN_INPUTS.phasePlan)
        });
        diagnostics.push(...phaseLoaded.diagnostics);
        phasePlan = phaseLoaded.phasePlan;
        if (phaseLoaded.phasePlan !== null) {
          const observed = sha256Hex(phaseRead.text);
          if (observed !== header.phase.phase_plan_sha256) {
            diagnostics.push(
              diagnostic({
                severity: "error",
                phase: "evaluate",
                code: AnalyzeCode.HashMismatch,
                message:
                  `Phase plan digest changed after freezing: header records ` +
                  `${header.phase.phase_plan_sha256}, bytes hash to ${observed}.`
              })
            );
          }
        }
      }
    }
  }

  let schedule: AssignmentSchedule | null = null;
  if (scheduleRead.text !== null) {
    try {
      const parsed = JSON.parse(scheduleRead.text) as Json;
      for (const violation of await schemaErrors(
        "assignment-schedule.v1.schema.json",
        parsed
      )) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "evaluate",
            code: AnalyzeCode.NotStudyRun,
            message: `Assignment schedule fails assignment-schedule.v1: ${violation}`
          })
        );
      }
      schedule = parsed as unknown as AssignmentSchedule;
      const observed = assignmentScheduleSha256(schedule);
      if (observed !== header.assignment_schedule.sha256) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "evaluate",
            code: AnalyzeCode.HashMismatch,
            message:
              `Schedule digest changed after freezing: header records ` +
              `${header.assignment_schedule.sha256}, document hashes to ` +
              `${observed}.`
          })
        );
      }
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.InputMissing,
          message: `Assignment schedule is not valid JSON: ${reason}`
        })
      );
    }
  }

  if (lockRead.text !== null) {
    try {
      const lock = protocolLockFromJson(JSON.parse(lockRead.text) as Json, {
        schema: await readSchema("protocol-lock.v1.schema.json"),
        documentUri: path.join(root, RUN_INPUTS.lock)
      });
      diagnostics.push(...lock.diagnostics);
      if (lock.lock !== null) {
        const observed = protocolLockSha256(lock.lock);
        if (observed !== header.protocol.protocol_lock_sha256) {
          diagnostics.push(
            diagnostic({
              severity: "error",
              phase: "evaluate",
              code: AnalyzeCode.HashMismatch,
              message:
                `Protocol lock digest changed after freezing: header records ` +
                `${header.protocol.protocol_lock_sha256}, document hashes ` +
                `to ${observed}.`
            })
          );
        }
      }
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.InputMissing,
          message: `Frozen protocol lock is not valid JSON: ${reason}`
        })
      );
    }
  }

  const ledgerRead = await readRequired(root, RUN_INPUTS.ledger);
  let ledger: AssignmentLedger | null = null;
  if (ledgerRead.text !== null) {
    const events: AssignmentEvent[] = [];
    const lines = ledgerRead.text.split("\n").filter((line) => line !== "");
    for (const line of lines) {
      const parsed = JSON.parse(line) as Json;
      for (const violation of await schemaErrors(
        "assignment-event.v1.schema.json",
        parsed
      )) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "evaluate",
            code: AnalyzeCode.NotStudyRun,
            message: `Assignment event fails assignment-event.v1: ${violation}`
          })
        );
      }
      events.push(parsed as unknown as AssignmentEvent);
    }
    ledger = { study_run_id: header.study_run_id, events };
  }

  let compatibility: ReadonlyMap<string, string> | null = null;
  if (compatibilityRead.text !== null) {
    try {
      const parsed = JSON.parse(compatibilityRead.text) as Json;
      const map = new Map<string, string>();
      if (
        isJsonObject(parsed) &&
        typeof parsed["study_compatibility_sha256"] === "string"
      ) {
        map.set("__study__", parsed["study_compatibility_sha256"]);
      }
      if (isJsonObject(parsed) && Array.isArray(parsed["cells"])) {
        for (const cell of parsed["cells"]) {
          if (
            isJsonObject(cell) &&
            typeof cell["cell_id"] === "string" &&
            typeof cell["cell_compatibility_sha256"] === "string"
          ) {
            map.set(cell["cell_id"], cell["cell_compatibility_sha256"]);
          }
        }
      }
      compatibility = map;
    } catch {
      compatibility = null;
    }
  }

  return {
    header,
    phasePlan,
    schedule,
    ledger,
    evidenceRequirementsSha256:
      evidenceRead.text === null ? null : sha256Hex(evidenceRead.text),
    verification: [
      {
        artifact: RUN_INPUTS.phasePlan,
        expected_sha256: header.phase.phase_plan_sha256,
        observed_sha256:
          phaseRead.text === null ? "" : sha256Hex(phaseRead.text)
      }
    ],
    compatibility,
    diagnostics
  };
}

/** Collect the trial evidence of every child batch of a StudyRun. */
async function cellEvidenceOf(
  root: string,
  header: StudyRunHeader
): Promise<readonly CellEvidence[]> {
  const cells: CellEvidence[] = [];
  for (const batch of header.child_batches) {
    const batchDir = path.resolve(root, batch.relative_path);
    const loaded = await loadRunOrBatch(batchDir).catch(() => null);
    if (loaded === null) {
      continue;
    }
    const views = assignmentsOf(loaded, trialsOf(loaded));
    const inputs: TrialInput[] = views.views.map((view) =>
      trialInputOf(view.trial, view.trial.evaluation, {
        assignmentId: view.assignmentId,
        replacementOf: view.replacementOf,
        terminal: view.terminal
      })
    );
    cells.push({
      cell_id: batch.cell_id,
      analytical: header.phase.analytical,
      study_compatibility_sha256: header.study_compatibility_sha256,
      cell_compatibility_sha256: batch.cell_compatibility_sha256,
      trials: inputs
    });
  }
  return cells;
}

/** `oal study analyze <study-run-dir> [options]`. */
export const studyAnalyzeCommand: CommandHandler = async (args, io) => {
  const directory = args.positionals[0];
  if (directory === undefined) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      'Command "study analyze" requires a StudyRun directory.'
    );
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const root = path.resolve(args.context.cwd, directory);
  const includeFlag = args.flags.string("include-study-run");
  if (includeFlag !== undefined) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.AggregationUnsupported,
        message:
          "Multi-StudyRun aggregation is not supported in this build: the " +
          "registered analyzer accepts exactly one StudyRun header, and " +
          "pooling across study compatibility keys is forbidden anyway. " +
          "Run the analyzer once per StudyRun and compare the reports " +
          "descriptively with oal compare."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  const loaded = await loadStudyRun(root);
  const diagnostics: Diagnostic[] = [...loaded.diagnostics];
  const header = loaded.header;
  if (
    header === null ||
    loaded.phasePlan === null ||
    loaded.schedule === null ||
    loaded.ledger === null ||
    loaded.evidenceRequirementsSha256 === null
  ) {
    if (header !== null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: StudyCliCode.AnalysisIncomplete,
          message:
            `StudyRun ${root} is incomplete, so no analysis can run. In ` +
            "this build no command can execute a study phase, so a real " +
            "StudyRun tree with cell evidence cannot exist here."
        })
      );
    }
    emitDiagnostics(io, args.context, diagnostics);
    return EXIT_INVALID;
  }

  const planFlag = args.flags.string("analysis-plan");
  let lineage: AnalysisLineage = { kind: "preregistered" };
  if (planFlag !== undefined) {
    const planPath = path.resolve(args.context.cwd, planFlag);
    const text = await readFile(planPath, "utf8").catch(() => null);
    if (text === null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.InputMissing,
          message: `Derived analysis plan not found: ${planPath}.`
        })
      );
    } else {
      lineage = {
        kind: "derived",
        reason: `analysis plan ${path.basename(planPath)}`
      };
    }
  }

  if (loaded.compatibility !== null) {
    const recorded = loaded.compatibility.get("__study__");
    if (
      recorded !== undefined &&
      recorded !== header.study_compatibility_sha256
    ) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.HashMismatch,
          message:
            `Compatibility document records study key ${recorded}, while ` +
            `the header records ${header.study_compatibility_sha256}.`
        })
      );
    }
    for (const batch of header.child_batches) {
      const cellKey = loaded.compatibility.get(batch.cell_id);
      if (
        cellKey !== undefined &&
        cellKey !== batch.cell_compatibility_sha256
      ) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "evaluate",
            code: AnalyzeCode.HashMismatch,
            message:
              `Compatibility document records cell key ${cellKey} for ` +
              `cell ${batch.cell_id}, while the header records ` +
              `${batch.cell_compatibility_sha256}.`
          })
        );
      }
    }
  }

  const protocolRead = await readRequired(root, RUN_INPUTS.protocol);
  let metrics: readonly ProtocolMetric[] = [];
  if (protocolRead.text !== null) {
    const document = parsePackDocument(protocolRead.text, RUN_INPUTS.protocol);
    if (document.value !== null) {
      const protocol = loadProtocol(document.value, {
        schema: await readSchema("study-protocol.v1.schema.json"),
        documentUri: path.join(root, RUN_INPUTS.protocol)
      });
      if (protocol.protocol !== null) {
        metrics = protocol.protocol.metrics.primary;
      }
    }
  }

  const cells = await cellEvidenceOf(root, header);
  const analysisId = isSafeId(`${header.study_run_id}-analysis`)
    ? `${header.study_run_id}-analysis`
    : "study-analysis";
  const result = analyzeStudyRun({
    analysis_id: analysisId,
    lineage,
    header,
    phasePlan: loaded.phasePlan,
    metrics,
    schedule: loaded.schedule,
    ledger: loaded.ledger,
    cells,
    verification: loaded.verification,
    evidence_requirements_sha256: loaded.evidenceRequirementsSha256
  });
  diagnostics.push(...result.diagnostics);
  if (!header.phase.analytical) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "evaluate",
        code: StudyCliCode.AnalysisIncomplete,
        message:
          `Phase ${header.phase.id} is not analytical, so its assignments ` +
          "appear here as operational diagnostics only and support no " +
          "treatment claim."
      })
    );
  }

  const errors = diagnostics.filter((entry) => entry.severity === "error");
  emitDiagnostics(io, args.context, diagnostics);
  const analysis = result.analysis;
  if (errors.length > 0 || analysis === null) {
    return EXIT_INVALID;
  }

  const analysisJson = studyAnalysisJson(analysis);
  const analysisPath = path.join(root, "study-analysis.json");
  await writeFile(analysisPath, `${stableJsonStringify(analysisJson)}\n`);

  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(analysisJson));
  } else {
    io.stdout(`study run: ${header.study_run_id}`);
    io.stdout(
      `phase: ${header.phase.id} analytical=${header.phase.analytical}`
    );
    io.stdout(`analysis: ${analysisId} lineage=${analysis.lineage.kind}`);
    for (const population of analysis.populations) {
      io.stdout(
        `population: ${population.id} ` +
          `${population.numerator}/${population.denominator}` +
          (population.unresolved_slots === undefined
            ? ""
            : ` unresolved=${population.unresolved_slots}`)
      );
    }
    io.stdout(`estimates: ${analysis.estimates.length}`);
    io.stdout(`warnings: ${analysis.warnings.length}`);
    io.stdout(`written: ${analysisPath}`);
  }
  return EXIT_OK;
};
