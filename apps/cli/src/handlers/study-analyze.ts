/**
 * `oal study analyze` (specification section 23.17). The command loads a
 * StudyRun directory, verifies the recorded digests of the protocol
 * lock, the phase plan, and the assignment schedule, verifies the
 * child-batch artifact manifests and anchors each manifest to the
 * digest its completion pointer recorded, then executes exactly the
 * frozen plan through the registered analyzer. `--analysis-plan` is refused:
 * this build reads no analysis-plan file. A corrected built-in
 * analysis runs through the derived-result path and never overwrites
 * the original result. Aggregating a second StudyRun is refused: no
 * engine in this build accepts more than one StudyRun header, and
 * cross-key pooling is forbidden anyway.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  DiagnosticCode,
  diagnostic,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  invalidInput,
  isJsonObject,
  isSafeId,
  isSha256Hex,
  sha256Hex,
  stableJsonStringify,
  validateSchemaInstance,
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
  studyAnalysisSha256,
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
import type { TrialInput } from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { tooManyArguments } from "../usage.ts";
import {
  loadRunOrBatch,
  trialsOf,
  verifyArtifactsOf,
  type ArtifactDrift
} from "./run-tree.ts";
import { assignmentsOf, trialInputOf } from "./report.ts";
import { readSchema, StudyCliCode } from "./study-tree.ts";

/** Stable diagnostic codes of the analyze command. */
export const AnalyzeCode = {
  NotStudyRun: "OAL-STUDY-ANALYZE-NOT-A-STUDY-RUN",
  InputMissing: "OAL-STUDY-ANALYZE-INPUT-MISSING",
  HashMismatch: "OAL-STUDY-ANALYZE-HASH-MISMATCH",
  AggregationUnsupported: "OAL-STUDY-ANALYZE-AGGREGATION-UNSUPPORTED",
  AnalysisPlanUnsupported: "OAL-STUDY-ANALYZE-ANALYSIS-PLAN-UNSUPPORTED",
  EvidenceDrift: "OAL-STUDY-ANALYZE-EVIDENCE-DRIFT",
  ParentInvalid: "OAL-STUDY-ANALYZE-PARENT-INVALID",
  ArtifactExists: DiagnosticCode.ArtifactExists
} as const;

/** Directory of derived analysis documents inside a StudyRun root. */
const DERIVED_ANALYSIS_DIR = "derived";

/** Digest-prefix length of derived analysis file names. */
const DERIVED_ANALYSIS_PREFIX_LENGTH = 12;

/** Lineage reason of every derived study analysis this build writes. */
const DERIVED_REASON = "corrected built-in analysis";

/**
 * Path of one derived analysis document. The name carries a digest prefix
 * of the derived bytes, so a corrected analysis never collides with an
 * earlier one and byte-identical re-runs refuse to duplicate themselves.
 */
function derivedAnalysisPath(root: string, sha256: string): string {
  return path.join(
    root,
    DERIVED_ANALYSIS_DIR,
    `study-analysis-${sha256.slice(0, DERIVED_ANALYSIS_PREFIX_LENGTH)}.json`
  );
}

/**
 * Write one analysis document exclusively. Returns false when the target
 * already exists: analysis artifacts are write-once, so an existing file
 * is never overwritten.
 */
async function writeAnalysisOnce(
  target: string,
  text: string
): Promise<boolean> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "wx").catch(() => null);
  if (handle === null) {
    return false;
  }
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

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
  // Study documents are untrusted: their evaluation runs inside the
  // bounded schema-worker boundary.
  return (await validateSchemaInstance(schema, document)).map(
    (entry) => `${entry.code}: ${entry.message}`
  );
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
      const protocolLoaded = await loadProtocol(protocolDocument.value, {
        schema: await readSchema("study-protocol.v1.schema.json"),
        documentUri: path.join(root, RUN_INPUTS.protocol)
      });
      diagnostics.push(...protocolLoaded.diagnostics);
      if (protocolLoaded.protocol !== null) {
        const phaseLoaded = await loadPhasePlan(phaseDocument.value, {
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
      const lock = await protocolLockFromJson(
        JSON.parse(lockRead.text) as Json,
        {
          schema: await readSchema("protocol-lock.v1.schema.json"),
          documentUri: path.join(root, RUN_INPUTS.lock)
        }
      );
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

/**
 * Anchor one child-batch manifest to its write-once completion pointer.
 * The pointer contributes only its recorded manifest digest: the
 * manifest beside it is hashed, so a relocated batch tree still
 * anchors. A manifest that was regenerated after completion no longer
 * matches the pointer, so tampered evidence cannot be laundered by
 * rewriting the manifest.
 */
async function anchorBatchManifest(
  batchDir: string
): Promise<readonly ArtifactDrift[]> {
  const pointerPath = path.join(batchDir, "batch.completed.json");
  const pointerText = await readFile(pointerPath, "utf8").catch(() => null);
  if (pointerText === null) {
    return [
      {
        root: batchDir,
        path: "batch.completed.json",
        detail: "the batch holds no completion pointer for its manifest"
      }
    ];
  }
  let pointer: {
    manifest_sha256?: unknown;
    artifact_manifest_sha256?: unknown;
  };
  try {
    pointer = JSON.parse(pointerText) as typeof pointer;
  } catch {
    return [
      {
        root: batchDir,
        path: "batch.completed.json",
        detail: "the completion pointer is not valid JSON"
      }
    ];
  }
  const manifestText = await readFile(
    path.join(batchDir, "artifact-manifest.json"),
    "utf8"
  ).catch(() => null);
  if (manifestText === null) {
    // The manifest verifier already reported the missing manifest.
    return [];
  }
  const recorded =
    typeof pointer.manifest_sha256 === "string"
      ? pointer.manifest_sha256
      : pointer.artifact_manifest_sha256;
  if (typeof recorded !== "string" || !isSha256Hex(recorded)) {
    return [
      {
        root: batchDir,
        path: "batch.completed.json",
        detail: "the completion pointer records no manifest digest"
      }
    ];
  }
  const observed = sha256Hex(manifestText);
  if (observed !== recorded) {
    return [
      {
        root: batchDir,
        path: "artifact-manifest.json",
        detail:
          `manifest digest does not match the completion pointer: ` +
          `recorded ${recorded}, found ${observed}`
      }
    ];
  }
  return [];
}

/** Collect the trial evidence of every child batch of a StudyRun. */
async function cellEvidenceOf(
  root: string,
  header: StudyRunHeader
): Promise<{
  readonly cells: readonly CellEvidence[];
  readonly drift: readonly ArtifactDrift[];
}> {
  const drift: ArtifactDrift[] = [];
  // Verify every child-batch manifest before any evidence is read: all
  // drift is refused before a single trial loads. The entry paths are
  // manifest-relative, so a relocated batch tree still verifies, and
  // each manifest is anchored to the digest its completion pointer
  // recorded.
  for (const batch of header.child_batches) {
    const batchDir = path.resolve(root, batch.relative_path);
    drift.push(...(await verifyArtifactsOf(batchDir)));
    drift.push(...(await anchorBatchManifest(batchDir)));
  }
  if (drift.length > 0) {
    return { cells: [], drift };
  }
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
  return { cells, drift };
}

/** The identifying fields of one parent analysis document. */
interface ParentAnalysis {
  readonly analysis_id: string;
  readonly study_run_id: string;
}

/** Load and schema-check one parent analysis document. */
async function loadParentAnalysis(target: string): Promise<{
  readonly parent: ParentAnalysis | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const diagnostics: Diagnostic[] = [];
  const refuse = (message: string): void => {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.ParentInvalid,
        message
      })
    );
  };
  const text = await readFile(target, "utf8").catch(() => null);
  if (text === null) {
    refuse(`Parent analysis document is unreadable: ${target}`);
    return { parent: null, diagnostics };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    refuse(`Parent analysis document is not valid JSON: ${reason}`);
    return { parent: null, diagnostics };
  }
  for (const violation of await schemaErrors(
    "study-analysis.v1.schema.json",
    parsed
  )) {
    refuse(`Parent analysis document fails study-analysis.v1: ${violation}`);
  }
  const analysisId = (parsed as { analysis_id?: unknown }).analysis_id;
  const studyRunId = (parsed as { study_run_id?: unknown }).study_run_id;
  if (
    diagnostics.length === 0 &&
    typeof analysisId === "string" &&
    typeof studyRunId === "string"
  ) {
    return {
      parent: { analysis_id: analysisId, study_run_id: studyRunId },
      diagnostics
    };
  }
  return { parent: null, diagnostics };
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
  const derivedFrom = args.flags.string("derived-from");
  if (planFlag !== undefined) {
    // The flag never executed the file it reads: the frozen phase plan
    // is what runs. Reject it instead of recording a derived lineage
    // no calculation backs. Corrected built-in analysis uses the
    // explicit derived-result path.
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.AnalysisPlanUnsupported,
        message:
          "--analysis-plan is refused: this build reads no analysis-plan " +
          "file, so the flag cannot change the executed calculation. The " +
          "frozen phase plan runs. Use --derived-from for a corrected " +
          "built-in analysis, which records a derived lineage without " +
          "overwriting the original result."
      })
    ]);
    return EXIT_UNSUPPORTED;
  }

  let lineage: AnalysisLineage = { kind: "preregistered" };
  let parentAnalysisId: string | null = null;
  if (derivedFrom !== undefined) {
    const parentPath = path.resolve(args.context.cwd, derivedFrom);
    const parentLoad = await loadParentAnalysis(parentPath);
    diagnostics.push(...parentLoad.diagnostics);
    const parent = parentLoad.parent;
    if (parent !== null && parent.study_run_id !== header.study_run_id) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.ParentInvalid,
          message:
            `Parent analysis ${JSON.stringify(parent.analysis_id)} belongs ` +
            `to StudyRun ${JSON.stringify(parent.study_run_id)}, not to ` +
            `${JSON.stringify(header.study_run_id)}.`
        })
      );
    }
    if (parent === null || parent.study_run_id !== header.study_run_id) {
      emitDiagnostics(io, args.context, diagnostics);
      return EXIT_INVALID;
    }
    parentAnalysisId = parent.analysis_id;
    lineage = {
      kind: "derived",
      parent_analysis_id: parent.analysis_id,
      reason: DERIVED_REASON
    };
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
      const protocol = await loadProtocol(document.value, {
        schema: await readSchema("study-protocol.v1.schema.json"),
        documentUri: path.join(root, RUN_INPUTS.protocol)
      });
      if (protocol.protocol !== null) {
        metrics = protocol.protocol.metrics.primary;
      }
    }
  }

  const evidence = await cellEvidenceOf(root, header);
  if (evidence.drift.length > 0) {
    // Evidence drift is an infrastructure failure, not a study finding:
    // refuse the whole command before any estimate is computed.
    emitDiagnostics(io, args.context, [
      ...diagnostics,
      ...evidence.drift.map((finding) =>
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: AnalyzeCode.EvidenceDrift,
          message: `Artifact verification failed for ${finding.path}: ${finding.detail}`,
          details: { path: finding.path }
        })
      )
    ]);
    return EXIT_INFRASTRUCTURE;
  }
  const baseAnalysisId = isSafeId(`${header.study_run_id}-analysis`)
    ? `${header.study_run_id}-analysis`
    : "study-analysis";
  const derivedBase = `${parentAnalysisId ?? baseAnalysisId}-derived`;
  const analysisId =
    parentAnalysisId === null
      ? baseAnalysisId
      : isSafeId(derivedBase)
        ? derivedBase
        : "study-analysis-derived";
  const result = analyzeStudyRun({
    analysis_id: analysisId,
    lineage,
    header,
    phasePlan: loaded.phasePlan,
    metrics,
    schedule: loaded.schedule,
    ledger: loaded.ledger,
    cells: evidence.cells,
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
  const analysis = result.analysis;
  if (errors.length > 0 || analysis === null) {
    emitDiagnostics(io, args.context, diagnostics);
    return EXIT_INVALID;
  }

  const analysisJson = studyAnalysisJson(analysis);
  // The preregistered result lands once at the StudyRun root; a derived
  // correction lands under derived/ beside it, named by a digest prefix.
  const analysisPath =
    parentAnalysisId === null
      ? path.join(root, "study-analysis.json")
      : derivedAnalysisPath(root, studyAnalysisSha256(analysis));
  const written = await writeAnalysisOnce(
    analysisPath,
    `${stableJsonStringify(analysisJson)}\n`
  );
  if (!written) {
    emitDiagnostics(io, args.context, [
      ...diagnostics,
      diagnostic({
        severity: "error",
        phase: "evaluate",
        code: AnalyzeCode.ArtifactExists,
        message:
          `Analysis artifact already exists: ${analysisPath}. Analysis ` +
          "documents are write-once, so a recorded result never " +
          "changes. Record a corrected built-in analysis as a new " +
          "derived document with --derived-from."
      })
    ]);
    return EXIT_INVALID;
  }
  emitDiagnostics(io, args.context, diagnostics);

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
