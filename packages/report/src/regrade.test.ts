import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SchemaValidator,
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
  type Json,
  type JsonObject
} from "@oal/core";
import { ArtifactStore } from "@oal/evidence";
import {
  evaluateRubric,
  loadRubric,
  toEvaluation,
  type Rubric
} from "@oal/evaluator";
import { traceEvent } from "./fixtures.ts";
import {
  RegradeCode,
  derivedEvaluationPath,
  regradeRun,
  type DerivedEvaluationArtifact,
  type RegradeEvidence
} from "./regrade.ts";

const EVALUATION_SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "evaluation.v1.schema.json"
);

const RUN_ID = "run-1";
const SCOPE_DIR = "runs/bat-0001/trials/run-1";
const DERIVED_AT = "2026-08-27T13:00:00.000Z";

function rubricOf(id: string, expression: string): Rubric {
  const document: Json = {
    rubric_version: 1,
    id,
    scoring: { method: "weighted_binary", pass_threshold: 1 },
    checks: [
      {
        id: "state_ready",
        kind: "predicate",
        weight: 1,
        required: true,
        evidence_class: "participant_observable",
        expression
      }
    ],
    signals: []
  };
  const result = loadRubric(document);
  if (result.rubric === null) {
    throw new Error(`The ${id} fixture did not load.`);
  }
  return result.rubric;
}

/** The stored rubric passes on the recorded state; the variant fails. */
const STORED_RUBRIC = rubricOf("regrade-original", "state.ready == true");
const VARIANT_RUBRIC = rubricOf("regrade-variant", "state.ready == false");

const EVIDENCE: RegradeEvidence = {
  runId: RUN_ID,
  run: { run_id: RUN_ID, mode: "record" } as JsonObject,
  events: [traceEvent({ sequence: 1, runId: RUN_ID, status: 200 })],
  state: { ready: true, revision: 1 },
  report: null
};

/** Serialize one evaluation the way the runner finalizes it. */
function evaluationText(evaluation: object): string {
  return `${canonicalJson(evaluation as unknown as Json)}\n`;
}

/** The preregistered evaluation.json of a finalized run. */
function storedEvaluation(): string {
  return evaluationText(
    toEvaluation(
      evaluateRubric({
        rubric: STORED_RUBRIC,
        runId: EVIDENCE.runId,
        run: EVIDENCE.run,
        events: EVIDENCE.events,
        state: EVIDENCE.state,
        report: EVIDENCE.report
      })
    )
  );
}

async function evaluationSchema(): Promise<Json> {
  return JSON.parse(await readFile(EVALUATION_SCHEMA_PATH, "utf8")) as Json;
}

describe("regradeRun (section 27.7)", () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "oal-regrade-"));
    store = new ArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeStoredEvaluation(): Promise<string> {
    const text = storedEvaluation();
    await store.writeOnce(`${SCOPE_DIR}/evaluation.json`, text);
    return text;
  }

  it("writes a derived artifact and leaves the original byte-identical", async () => {
    const original = await writeStoredEvaluation();
    expect(await store.read(`${SCOPE_DIR}/evaluation.json`)).toBe(original);

    const result = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });

    expect(result.written).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const variantSha = canonicalJsonSha256(VARIANT_RUBRIC as unknown as Json);
    expect(result.path).toBe(derivedEvaluationPath(SCOPE_DIR, variantSha));
    expect(result.path).not.toBe(`${SCOPE_DIR}/evaluation.json`);
    expect(result.path.startsWith(`${SCOPE_DIR}/derived/`)).toBe(true);

    // The stored evaluation keeps its exact bytes.
    expect(await store.read(`${SCOPE_DIR}/evaluation.json`)).toBe(original);

    const artifact = result.artifact as DerivedEvaluationArtifact;
    expect(artifact.kind).toBe("DerivedEvaluation");
    expect(artifact.lineage).toBe("derived");
    expect(artifact.run_id).toBe(RUN_ID);
    expect(artifact.scope_dir).toBe(SCOPE_DIR);
    expect(artifact.derived_at).toBe(DERIVED_AT);
    expect(artifact.rubric_sha256).toBe(variantSha);
    expect(artifact.source_rubric_sha256).toBe(
      canonicalJsonSha256(STORED_RUBRIC as unknown as Json)
    );
    expect(artifact.rubric_changed).toBe(true);

    // The changed rubric flips the outcome on the same evidence.
    expect(artifact.evaluation.rubric_id).toBe("regrade-variant");
    expect(artifact.evaluation.status).toBe("failed");
    const stored = JSON.parse(original) as { status: string };
    expect(stored.status).toBe("passed");

    const text = await store.read(result.path);
    expect(text).toBe(evaluationText(artifact));
    expect(result.artifact_sha256).toBe(sha256Hex(text));
  });

  it("validates the derived evaluation against the evaluation schema", async () => {
    await writeStoredEvaluation();
    const result = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });
    const validator = new SchemaValidator(await evaluationSchema());
    const artifact = result.artifact as DerivedEvaluationArtifact;
    expect(validator.errors(artifact.evaluation as unknown as Json)).toEqual(
      []
    );
  });

  it("never overwrites an existing derived artifact", async () => {
    await writeStoredEvaluation();
    const first = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });
    const firstBytes = await store.read(first.path);

    const second = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: "2027-01-01T00:00:00.000Z" }
    });

    expect(second.written).toBe(false);
    expect(second.artifact).toBeNull();
    expect(second.path).toBe(first.path);
    const codes = second.diagnostics.map((entry) => entry.code);
    expect(codes).toContain(RegradeCode.ArtifactExists);
    expect(
      second.diagnostics.every((entry) => entry.severity === "error")
    ).toBe(true);
    expect(await store.read(first.path)).toBe(firstBytes);
    expect(await store.read(`${SCOPE_DIR}/evaluation.json`)).toBe(
      storedEvaluation()
    );
  });

  it("warns and records null lineage without a stored evaluation", async () => {
    const result = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });
    expect(result.written).toBe(true);
    const artifact = result.artifact as DerivedEvaluationArtifact;
    expect(artifact.source_rubric_sha256).toBeNull();
    expect(artifact.rubric_changed).toBeNull();
    const warning = result.diagnostics[0];
    expect(warning?.code).toBe(RegradeCode.SourceEvaluationMissing);
    expect(warning?.severity).toBe("warning");
  });

  it("warns when the regrade repeats the stored rubric", async () => {
    await writeStoredEvaluation();
    const result = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: STORED_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });
    expect(result.written).toBe(true);
    const artifact = result.artifact as DerivedEvaluationArtifact;
    expect(artifact.rubric_changed).toBe(false);
    expect(artifact.rubric_sha256).toBe(artifact.source_rubric_sha256);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      RegradeCode.RubricUnchanged
    ]);
    // A distinct path per rubric, so the repeat never collides.
    const variantSha = canonicalJsonSha256(VARIANT_RUBRIC as unknown as Json);
    expect(result.path).not.toBe(derivedEvaluationPath(SCOPE_DIR, variantSha));
    expect(artifact.evaluation.status).toBe("passed");
  });

  it("produces identical derived bytes for identical inputs", async () => {
    await writeStoredEvaluation();
    const first = await regradeRun({
      store,
      scopeDir: SCOPE_DIR,
      evidence: EVIDENCE,
      rubric: VARIANT_RUBRIC,
      options: { derivedAt: DERIVED_AT }
    });

    const otherRoot = await mkdtemp(join(tmpdir(), "oal-regrade-"));
    try {
      const otherStore = new ArtifactStore(otherRoot);
      await otherStore.writeOnce(
        `${SCOPE_DIR}/evaluation.json`,
        storedEvaluation()
      );
      const second = await regradeRun({
        store: otherStore,
        scopeDir: SCOPE_DIR,
        evidence: EVIDENCE,
        rubric: VARIANT_RUBRIC,
        options: { derivedAt: DERIVED_AT }
      });
      expect(second.path).toBe(first.path);
      expect(await otherStore.read(second.path)).toBe(
        await store.read(first.path)
      );
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
