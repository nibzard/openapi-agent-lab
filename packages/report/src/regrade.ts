/**
 * Derived re-evaluation of recorded evidence (specification section
 * 27.7).
 *
 * Regrading re-runs the deterministic evaluator over one run's frozen
 * evidence under a changed rubric. The result is written as a derived
 * artifact at a new path below the run directory: the preregistered
 * evaluation.json and every other recorded artifact stay byte-identical,
 * and the derived document records its lineage explicitly.
 *
 * The engine writes through a caller-supplied store and never reads the
 * clock, so the same evidence, rubric, and timestamp produce the same
 * derived bytes.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  diagnostic,
  isSha256Hex,
  sha256Hex,
  DiagnosticCode,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type {
  DocumentationExchange,
  SemanticEvent,
  TraceEvent
} from "@oal/evidence";
import {
  evaluateRubric,
  toEvaluation,
  type ArtifactMetadata,
  type Evaluation,
  type EvaluatorLimits
} from "@oal/evaluator";
import type { Rubric } from "@oal/evaluator";

export const DERIVED_EVALUATION_SCHEMA_VERSION = 1;
export const DERIVED_EVALUATION_KIND = "DerivedEvaluation";

/** Stable diagnostic codes of the regrade engine. */
export const RegradeCode = {
  SourceEvaluationMissing: "regrade.source_evaluation_missing",
  RubricUnchanged: "regrade.rubric_unchanged",
  ArtifactExists: DiagnosticCode.ArtifactExists
} as const;

/** Directory below the run directory that holds derived evaluations. */
export const DERIVED_EVALUATION_DIR = "derived";

/** Length of the rubric digest prefix that names a derived artifact. */
const DIGEST_PREFIX_LENGTH = 12;

/**
 * Write-once artifact sink. ArtifactStore from @oal/evidence satisfies
 * it structurally, and tests may supply any object with the two
 * methods.
 */
export interface RegradeStore {
  /** Whether a relative artifact path already exists. */
  exists(relativePath: string): Promise<boolean>;
  /** Must refuse or fail when the target already exists. */
  writeOnce(relativePath: string, content: string): Promise<void>;
  /** Optional reader used to recover the stored evaluation digest. */
  read?(relativePath: string): Promise<string>;
}

/** One run's frozen recorded evidence, as the evaluator consumes it. */
export interface RegradeEvidence {
  readonly runId: string;
  /** Frozen run metadata, exposed to expressions as run. */
  readonly run: JsonObject;
  readonly events: readonly TraceEvent[];
  readonly documentationEvents?: readonly DocumentationExchange[] | undefined;
  readonly semanticEvents?: readonly SemanticEvent[] | undefined;
  readonly state: Json;
  readonly report: Json | null;
  readonly artifacts?: Readonly<Record<string, ArtifactMetadata>> | undefined;
}

export interface RegradeOptions {
  /** Resolves the reference named by a json_schema check. */
  readonly resolveSchema?:
    | ((reference: string) => Json | undefined)
    | undefined;
  /**
   * Digest of the rubric that produced the stored evaluation. When it
   * is omitted and the store can read, the digest is recovered from
   * the stored evaluation.json itself.
   */
  readonly sourceRubricSha256?: string | null | undefined;
  /** Timestamp recorded in the derived artifact. Omit for stable tests. */
  readonly derivedAt?: string | undefined;
  readonly limits?: Partial<EvaluatorLimits> | undefined;
}

export interface RegradeInput {
  readonly store: RegradeStore;
  /**
   * Run directory that holds the stored evaluation, relative to the
   * store root, for example runs/bat-1/trials/run-1.
   */
  readonly scopeDir: string;
  readonly evidence: RegradeEvidence;
  readonly rubric: Rubric;
  readonly options?: RegradeOptions | undefined;
}

/** Derived evaluation artifact with explicit lineage (section 27.7). */
export interface DerivedEvaluationArtifact {
  readonly schema_version: typeof DERIVED_EVALUATION_SCHEMA_VERSION;
  readonly kind: typeof DERIVED_EVALUATION_KIND;
  readonly lineage: "derived";
  readonly run_id: string;
  readonly scope_dir: string;
  readonly derived_at?: string | undefined;
  /** Digest of the rubric this artifact was evaluated under. */
  readonly rubric_sha256: string;
  /** Digest of the rubric of the stored evaluation, when known. */
  readonly source_rubric_sha256: string | null;
  /** False when the regrade repeated the stored rubric. */
  readonly rubric_changed: boolean | null;
  readonly evaluation: Evaluation;
}

export interface RegradeResult {
  /** True when the derived artifact was written. */
  readonly written: boolean;
  /** Relative path of the derived artifact inside the store. */
  readonly path: string;
  /** Digest of the written artifact bytes, when written. */
  readonly artifact_sha256: string | null;
  readonly artifact: DerivedEvaluationArtifact | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Deterministic path of the derived artifact for one rubric digest. */
export function derivedEvaluationPath(
  scopeDir: string,
  rubricSha256: string
): string {
  const base = scopeDir.endsWith("/") ? scopeDir.slice(0, -1) : scopeDir;
  return `${base}/${DERIVED_EVALUATION_DIR}/evaluation-${rubricSha256.slice(
    0,
    DIGEST_PREFIX_LENGTH
  )}.json`;
}

/** Digest of the stored evaluation, read from the run directory. */
async function storedRubricSha256(
  store: RegradeStore,
  scopeDir: string
): Promise<string | null> {
  if (store.read === undefined) {
    return null;
  }
  let text: string;
  try {
    text = await store.read(`${scopeDir}/evaluation.json`);
  } catch {
    return null;
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const digest = (parsed as JsonObject)["rubric_sha256"];
  return typeof digest === "string" && isSha256Hex(digest) ? digest : null;
}

/**
 * Re-evaluate recorded evidence under the supplied rubric and write the
 * result as a derived artifact. The stored evaluation is never opened
 * for writing, and an existing derived artifact is never overwritten.
 */
export async function regradeRun(input: RegradeInput): Promise<RegradeResult> {
  const diagnostics: Diagnostic[] = [];
  const scopeDir = input.scopeDir.endsWith("/")
    ? input.scopeDir.slice(0, -1)
    : input.scopeDir;
  const rubricSha256 = canonicalJsonSha256(input.rubric as unknown as Json);
  const path = derivedEvaluationPath(scopeDir, rubricSha256);

  const declaredSource = input.options?.sourceRubricSha256 ?? null;
  const sourceSha =
    declaredSource !== null
      ? declaredSource
      : await storedRubricSha256(input.store, scopeDir);
  if (sourceSha === null) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "report",
        code: RegradeCode.SourceEvaluationMissing,
        message:
          "No stored evaluation digest could be recovered; lineage is recorded without a source rubric.",
        json_pointer: `${scopeDir}/evaluation.json`
      })
    );
  }
  const rubricChanged = sourceSha === null ? null : sourceSha !== rubricSha256;
  if (rubricChanged === false) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "report",
        code: RegradeCode.RubricUnchanged,
        message:
          "The regrade repeats the rubric of the stored evaluation; the derived artifact duplicates it.",
        json_pointer: `${scopeDir}/evaluation.json`
      })
    );
  }

  const evaluation = toEvaluation(
    evaluateRubric({
      rubric: input.rubric,
      runId: input.evidence.runId,
      run: input.evidence.run,
      events: input.evidence.events,
      documentationEvents: input.evidence.documentationEvents,
      semanticEvents: input.evidence.semanticEvents,
      state: input.evidence.state,
      report: input.evidence.report,
      artifacts: input.evidence.artifacts,
      resolveSchema: input.options?.resolveSchema,
      evaluatedAt: input.options?.derivedAt,
      limits: input.options?.limits
    })
  );

  if (await input.store.exists(path)) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "report",
        code: RegradeCode.ArtifactExists,
        message: `A derived evaluation already exists at ${JSON.stringify(
          path
        )}; regrading never overwrites it.`,
        json_pointer: path
      })
    );
    return {
      written: false,
      path,
      artifact_sha256: null,
      artifact: null,
      diagnostics
    };
  }

  const artifact: DerivedEvaluationArtifact = {
    schema_version: DERIVED_EVALUATION_SCHEMA_VERSION,
    kind: DERIVED_EVALUATION_KIND,
    lineage: "derived",
    run_id: input.evidence.runId,
    scope_dir: scopeDir,
    ...(input.options?.derivedAt === undefined
      ? {}
      : { derived_at: input.options.derivedAt }),
    rubric_sha256: rubricSha256,
    source_rubric_sha256: sourceSha,
    rubric_changed: rubricChanged,
    evaluation
  };
  const text = `${canonicalJson(artifact as unknown as Json)}\n`;
  await input.store.writeOnce(path, text);
  return {
    written: true,
    path,
    artifact_sha256: sha256Hex(text),
    artifact,
    diagnostics
  };
}
