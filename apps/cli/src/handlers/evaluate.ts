/**
 * `oal evaluate` (specification section 23.9). Artifact hashes verify
 * first. The default reports the evaluation the runner recorded; a
 * supplied rubric re-grades the recorded evidence and writes one derived
 * evaluation artifact with a new identifier, never overwriting the
 * original.
 */

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_INVALID,
  EXIT_OK,
  diagnostic,
  formatRfc3339,
  invalidInput,
  isJsonObject,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  loadRubric,
  toEvaluation,
  evaluateRubric,
  type Evaluation,
  type Rubric
} from "@oal/evaluator";
import { defaultSchemaDir, parsePackDocument } from "@oal/pack";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";
import {
  batchRootOf,
  loadRunOrBatch,
  trialsOf,
  verifyTrialArtifacts,
  type LoadedTrial
} from "./run-tree.ts";

/** Stable diagnostic codes of the evaluate command. */
export const EvaluateCliCode = {
  EvidenceDrift: "OAL-EVALUATE-EVIDENCE-DRIFT",
  RubricInvalid: "OAL-EVALUATE-RUBRIC-INVALID",
  FrozenRubricUnavailable: "OAL-EVALUATE-FROZEN-RUBRIC-UNAVAILABLE",
  DerivedExists: "OAL-EVALUATE-DERIVED-EXISTS",
  SchemaUnresolved: "OAL-EVALUATE-SCHEMA-UNRESOLVED"
} as const;

/** The rubric identity one evaluation summary carries. */
export interface RubricSource {
  readonly kind: "recorded" | "override";
  readonly sha256: string | null;
  readonly path: string | null;
}

/** One evaluation status line, persisted or freshly graded. */
export interface EvaluationFacts {
  readonly status: string;
  readonly score: number;
  readonly passed_weight: number;
  readonly total_weight: number;
  readonly passed_checks: number;
  readonly failed_checks: number;
  readonly rubric_sha256: string | null;
}

/** Read the status facts of one recorded evaluation document. */
export function evaluationFactsOf(
  evaluation: Evaluation | null
): EvaluationFacts | null {
  if (evaluation === null) {
    return null;
  }
  const passed = evaluation.checks.filter(
    (check) => check.status === "passed"
  ).length;
  const failed = evaluation.checks.filter(
    (check) => check.status === "failed"
  ).length;
  return {
    status: evaluation.status,
    score: evaluation.score,
    passed_weight: evaluation.passed_weight,
    total_weight: evaluation.total_weight,
    passed_checks: passed,
    failed_checks: failed,
    rubric_sha256:
      evaluation.rubric_sha256 === undefined ? null : evaluation.rubric_sha256
  };
}

/**
 * Compare one re-graded evaluation with the recorded one. Scores are
 * compared exactly; the evaluated-at stamp and evaluator identity are
 * ignored because they are not evidence.
 */
export function evaluationMatches(
  recorded: EvaluationFacts | null,
  regraded: EvaluationFacts
): boolean {
  if (recorded === null) {
    return false;
  }
  return (
    recorded.status === regraded.status &&
    recorded.score === regraded.score &&
    recorded.passed_weight === regraded.passed_weight &&
    recorded.total_weight === regraded.total_weight &&
    recorded.passed_checks === regraded.passed_checks &&
    recorded.failed_checks === regraded.failed_checks
  );
}

/** Read and parse one JSON or YAML rubric document from disk. */
export async function readRubricDocument(
  target: string
): Promise<{ document: Json; sha256: string }> {
  const bytes = await readFile(target).catch(() => null);
  if (bytes === null) {
    throw invalidInput(
      EvaluateCliCode.RubricInvalid,
      `Rubric document could not be read: ${target}`
    );
  }
  const text = bytes.toString("utf8");
  const parsed = parsePackDocument(text, target);
  if (parsed.value === null) {
    const found = parsed.diagnostic;
    throw invalidInput(
      EvaluateCliCode.RubricInvalid,
      found === null
        ? `Rubric document is not JSON or YAML: ${target}`
        : `Rubric document is not valid: ${found.message}`
    );
  }
  return { document: parsed.value, sha256: sha256Hex(text) };
}

/** Load the rubric.v1 schema the loader validates against. */
async function loadRubricSchema(): Promise<Json> {
  const file = path.join(defaultSchemaDir(), "rubric.v1.schema.json");
  const text = await readFile(file, "utf8");
  return JSON.parse(text) as Json;
}

/**
 * Resolve one pack-relative reference by walking the ancestors of the
 * rubric document, so a rubric used inside its pack finds its schemas.
 */
export async function resolvePackRelative(
  from: string,
  reference: string
): Promise<Json | null> {
  let directory = path.dirname(path.resolve(from));
  for (let depth = 0; depth < 6; depth += 1) {
    const target = path.join(directory, reference);
    const text = await readFile(target, "utf8").catch(() => null);
    if (text !== null) {
      return parsePackDocument(text, target).value;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return null;
}

/**
 * Preload every schema a rubric's json_schema checks reference. The
 * evaluate engine resolves synchronously, so the bytes load first.
 */
export async function preloadRubricSchemas(
  rubricPath: string,
  rubric: Rubric,
  io: { emit: (entry: Diagnostic) => void }
): Promise<Map<string, Json>> {
  const references = new Set<string>();
  for (const check of rubric.checks) {
    if (check.kind === "json_schema") {
      references.add(check.schema);
    }
  }
  const loaded = new Map<string, Json>();
  for (const reference of references) {
    const found = await resolvePackRelative(rubricPath, reference);
    if (found === null) {
      io.emit(
        diagnostic({
          severity: "warning",
          phase: "evaluate",
          code: EvaluateCliCode.SchemaUnresolved,
          message:
            `The rubric references ${reference}, which no directory from ` +
            `${rubricPath} upward contains. Its checks report an error.`
        })
      );
      continue;
    }
    loaded.set(reference, found);
  }
  return loaded;
}

/** Rebuild the frozen run metadata a rubric expression reads as `run`. */
export function runMetadataOf(trial: LoadedTrial): JsonObject {
  const extensions = isJsonObject(trial.started["extensions"])
    ? trial.started["extensions"]
    : {};
  const value = (key: string): Json => {
    const found = extensions[key];
    return found === undefined ? null : found;
  };
  return {
    run_id: trial.runId,
    batch_id: trial.batchId,
    repetition_index:
      typeof trial.started["repetition_index"] === "number"
        ? trial.started["repetition_index"]
        : null,
    trial_seed_id: value("trial_seed_id"),
    started_at:
      typeof trial.started["started_at"] === "string"
        ? trial.started["started_at"]
        : null,
    adapter: value("adapter_id"),
    exposure_mode: value("exposure_mode"),
    contract_visibility: value("contract_visibility"),
    data_plane_scope: value("data_plane_scope")
  };
}

/** Parse the participant report text, or null when it is not JSON. */
export function participantReportOf(text: string | null): Json | null {
  if (text === null || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** Derive one exclusive-create derived evaluation artifact path. */
export function derivedEvaluationPath(
  runDir: string,
  rubricSha256: string
): string {
  const suffix = sha256Hex(`${rubricSha256}:${path.basename(runDir)}`).slice(
    0,
    8
  );
  return path.join(runDir, `evaluation.derived-${suffix}.json`);
}

/**
 * Write one derived evaluation artifact. The path derives from the rubric
 * digest and the run directory, and the file is created exclusively, so
 * the original evaluation and any earlier derived artifact stay intact.
 */
export async function writeDerivedEvaluation(
  runDir: string,
  rubricSha256: string,
  evaluation: Evaluation
): Promise<string> {
  const target = derivedEvaluationPath(runDir, rubricSha256);
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "wx").catch(() => null);
  if (handle === null) {
    throw invalidInput(
      EvaluateCliCode.DerivedExists,
      `Derived evaluation already exists: ${target}.`
    );
  }
  try {
    await handle.writeFile(
      `${stableJsonStringify(evaluation as unknown as Json)}\n`
    );
  } finally {
    await handle.close();
  }
  return target;
}

/** One run's evaluate summary. */
export interface RunSummary {
  readonly runId: string;
  readonly recorded: EvaluationFacts | null;
  readonly regraded: EvaluationFacts | null;
  readonly matches: boolean | null;
  readonly derivedArtifact: string | null;
}

/** Serialize one facts record for the JSON document. */
function factsJson(facts: EvaluationFacts | null): Json {
  if (facts === null) {
    return null;
  }
  return {
    status: facts.status,
    score: facts.score,
    passed_weight: facts.passed_weight,
    total_weight: facts.total_weight,
    passed_checks: facts.passed_checks,
    failed_checks: facts.failed_checks,
    rubric_sha256: facts.rubric_sha256
  };
}

/** Build the EvaluateCli JSON document. */
export function evaluateDocumentOf(
  root: string,
  rubricSha: string | null,
  rubricPath: string | null,
  summaries: readonly RunSummary[]
): Json {
  return {
    kind: "EvaluateCli",
    target: root,
    rubric: {
      kind: rubricSha === null ? "recorded" : "override",
      sha256: rubricSha,
      path: rubricPath
    },
    runs: summaries.map((summary): Json => {
      return {
        run_id: summary.runId,
        recorded: factsJson(summary.recorded),
        regraded: factsJson(summary.regraded),
        matches: summary.matches,
        derived_artifact: summary.derivedArtifact
      };
    })
  };
}

/** `oal evaluate <run-or-batch> [--rubric <path>]` (section 23.9). */
export const evaluateCommand: CommandHandler = async (args, io) => {
  const target = args.positionals[0];
  if (target === undefined) {
    throw missingArgument(args.command.name, "run-or-batch");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const root = path.resolve(args.context.cwd, target);
  const subject = await loadRunOrBatch(root);
  const trials = trialsOf(subject);

  // Step 1: verify the artifact hashes before touching any evaluation.
  const drift: Diagnostic[] = [];
  for (const trial of trials) {
    for (const finding of await verifyTrialArtifacts(trial)) {
      drift.push(
        diagnostic({
          severity: "error",
          phase: "evaluate",
          code: EvaluateCliCode.EvidenceDrift,
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

  const rubricFlag = args.flags.string("rubric");
  let rubric: Rubric | null = null;
  let rubricSha: string | null = null;
  let rubricSchemas: ReadonlyMap<string, Json> = new Map();
  if (rubricFlag !== undefined) {
    const rubricPath = path.resolve(args.context.cwd, rubricFlag);
    const read = await readRubricDocument(rubricPath);
    const loaded = await loadRubric(read.document, {
      schema: await loadRubricSchema(),
      documentUri: rubricPath
    });
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
  } else {
    // The tree freezes the eval document, not the compiled rubric bytes,
    // so the default cannot re-grade; it reports the recorded result.
    const batchInputs =
      subject.kind === "batch"
        ? subject.batch.inputsDir
        : await batchRootOf(root).then((found) =>
            found === null ? null : path.join(found, "inputs")
          );
    const frozen =
      batchInputs === null
        ? null
        : await readFile(
            path.join(batchInputs, "rubric.frozen.yaml"),
            "utf8"
          ).catch(() => null);
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "warning",
        phase: "evaluate",
        code: EvaluateCliCode.FrozenRubricUnavailable,
        message:
          frozen === null
            ? "The run tree holds no frozen eval document, so no rubric identity is recorded."
            : "The run tree freezes the eval document that points at the rubric, not the rubric bytes. Re-grading needs --rubric; this run reports the evaluation the runner recorded."
      })
    ]);
  }

  const summaries: RunSummary[] = [];
  for (const trial of trials) {
    const recorded = evaluationFactsOf(trial.evaluation);
    let regraded: EvaluationFacts | null = null;
    let derivedArtifact: string | null = null;
    if (rubric !== null && rubricSha !== null) {
      const result = await evaluateRubric({
        rubric,
        runId: trial.runId,
        run: runMetadataOf(trial),
        events: trial.trace,
        state: (trial.stateFinal ?? {}) as Json,
        report: participantReportOf(trial.participantText),
        resolveSchema: (reference): Json | undefined =>
          rubricSchemas.get(reference),
        evaluatedAt: formatRfc3339(Date.now())
      });
      const evaluation = toEvaluation(result);
      regraded = evaluationFactsOf(evaluation);
      derivedArtifact = await writeDerivedEvaluation(
        trial.root,
        rubricSha,
        evaluation
      );
    }
    summaries.push({
      runId: trial.runId,
      recorded,
      regraded,
      matches: regraded === null ? null : evaluationMatches(recorded, regraded),
      derivedArtifact
    });
  }

  const document = evaluateDocumentOf(
    root,
    rubricSha,
    rubricFlag ?? null,
    summaries
  );
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(document));
  } else {
    io.stdout(`target: ${root}`);
    io.stdout(
      `rubric: ${rubricSha === null ? "recorded" : `override ${rubricSha}`}`
    );
    for (const summary of summaries) {
      io.stdout(`run: ${summary.runId}`);
      if (summary.recorded === null) {
        io.stdout("recorded: no evaluation.json in the run directory");
      } else {
        io.stdout(terminalLine("recorded", summary.recorded));
      }
      if (summary.regraded !== null) {
        io.stdout(terminalLine("regraded", summary.regraded));
        io.stdout(`matches recorded: ${summary.matches}`);
        io.stdout(`derived artifact: ${summary.derivedArtifact}`);
      }
    }
  }
  const outPath = args.context.outPath;
  if (outPath !== null) {
    await writeFile(outPath, `${stableJsonStringify(document)}\n`);
  }
  return EXIT_OK;
};

/** One terminal status line of an evaluation. */
function terminalLine(label: string, facts: EvaluationFacts): string {
  return (
    `${label}: ${facts.status} score=${facts.score.toFixed(4)} ` +
    `weight=${facts.passed_weight}/${facts.total_weight} ` +
    `checks=${facts.passed_checks} passed, ${facts.failed_checks} failed`
  );
}
