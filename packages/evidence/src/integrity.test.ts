import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { ArtifactStore, MANIFEST_NAME } from "./artifacts.ts";
import { LifecycleStream, lifecycleStage } from "./lifecycle.ts";
import {
  classifyEvidenceIntegrity,
  integrityFlag,
  tailHealth
} from "./integrity.ts";

let dir: string;
let store: ArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-integrity-"));
  store = new ArtifactStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BATCH = "batch-01";
const RUN = "run-01";
const TRIAL = `runs/${BATCH}/trials/${RUN}`;

/** Build one finalized trial and return its completion pointer path. */
async function finalizedTrial(): Promise<string> {
  await store.initTrial(BATCH, RUN);
  await store.writeOnce(`${TRIAL}/run.started.json`, '{"started":true}\n');
  const stream = LifecycleStream.open(
    await store.openSink(`${TRIAL}/lifecycle.jsonl`),
    { batch_id: BATCH, run_id: RUN }
  );
  await stream.emit(
    lifecycleStage({
      stage: "scheduled",
      recorded_at: "2026-08-27T12:00:00.000Z",
      evidence_source: "runner",
      details: { launch_order: 0 },
      observed_at: "2026-08-27T12:00:00.000Z"
    })
  );
  await store.writeManifest({
    scopeDir: TRIAL,
    level: "trial",
    id: RUN,
    runId: RUN,
    batchId: BATCH,
    createdAt: "2026-08-27T12:00:01.000Z"
  });
  return writePointer();
}

async function writePointer(): Promise<string> {
  const manifestPath = `${TRIAL}/${MANIFEST_NAME}`;
  const digest = createHash("sha256")
    .update(await store.read(manifestPath))
    .digest("hex");
  await store.atomicWrite(
    `${TRIAL}/run.completed.json`,
    `{"manifest_path":"${manifestPath}","manifest_sha256":"${digest}"}\n`
  );
  return `${TRIAL}/run.completed.json`;
}

describe("classifyEvidenceIntegrity", () => {
  it("classifies a verified trial as valid", async () => {
    const pointer = await finalizedTrial();
    const verification = await store.verify(pointer);
    expect(verification).toEqual({ ok: true, problems: [] });
    expect(
      classifyEvidenceIntegrity({ problems: verification.problems })
    ).toEqual({ classification: "valid", reason_codes: [] });
  });

  it("classifies input mutation as invalid evidence", async () => {
    const pointer = await finalizedTrial();
    await writeFile(store.resolve(`${TRIAL}/run.started.json`), "tampered\n");
    const verification = await store.verify(pointer);
    const result = classifyEvidenceIntegrity({
      problems: verification.problems
    });
    expect(result.classification).toBe("invalid_evidence");
    expect(result.reason_codes).toEqual(["digest_mismatch", "size_mismatch"]);
  });

  it("classifies a deleted artifact as incomplete", async () => {
    const pointer = await finalizedTrial();
    await rm(store.resolve(`${TRIAL}/run.started.json`));
    const verification = await store.verify(pointer);
    expect(verification.ok).toBe(false);
    expect(
      classifyEvidenceIntegrity({ problems: verification.problems })
    ).toEqual({
      classification: "incomplete",
      reason_codes: ["artifact_missing"]
    });
  });

  it("classifies a missing manifest as invalid evidence", async () => {
    await finalizedTrial();
    await rm(store.resolve(`${TRIAL}/${MANIFEST_NAME}`));
    const verification = await store.verify(`${TRIAL}/run.completed.json`);
    const result = classifyEvidenceIntegrity({
      problems: verification.problems
    });
    expect(result.classification).toBe("invalid_evidence");
    expect(result.reason_codes).toEqual(["manifest_missing"]);
  });

  it("classifies every contradiction signal as invalid evidence", () => {
    const result = classifyEvidenceIntegrity({
      problems: [],
      contradictions: [
        "undeclared_participant_surface_change",
        "schedule_mutation",
        "compatibility_drift",
        "state_contradiction",
        "semantic_contradiction",
        "parent_exchange_contradiction"
      ]
    });
    expect(result.classification).toBe("invalid_evidence");
    expect(result.reason_codes).toEqual([
      "compatibility_drift",
      "parent_exchange_contradiction",
      "participant_surface_undeclared_change",
      "schedule_mutation",
      "semantic_contradiction",
      "state_contradiction"
    ]);
  });

  it("fails closed on an unrecognized verification problem", () => {
    expect(
      classifyEvidenceIntegrity({ problems: ["something unexpected"] })
    ).toEqual({
      classification: "invalid_evidence",
      reason_codes: ["verification_problem_unclassified"]
    });
  });

  it("maps each classification onto the section 22.4 flag", () => {
    expect(integrityFlag("valid")).toBe("intact");
    expect(integrityFlag("incomplete")).toBe("missing");
    expect(integrityFlag("invalid_evidence")).toBe("corrupt");
  });
});

describe("tailHealth", () => {
  it("reports a healthy stream", async () => {
    await finalizedTrial();
    const health = await tailHealth(store.resolve(`${TRIAL}/lifecycle.jsonl`));
    expect(health).toEqual({
      total_lines: 1,
      valid_records: 1,
      corrupt_lines: [],
      last_corrupt_line: null,
      valid_records_before_corruption: 1,
      final_line_valid: true,
      newline_terminated: true
    });
  });

  it("keeps the valid records before one corrupt trailing line", async () => {
    const path = join(dir, "trace.jsonl");
    for (let index = 1; index <= 3; index += 1) {
      await appendFile(path, `{"sequence":${index}}\n`, "utf8");
    }
    await appendFile(path, '{"sequence":4,"brok', "utf8");
    const health = await tailHealth(path);
    expect(health).toEqual({
      total_lines: 4,
      valid_records: 3,
      corrupt_lines: [4],
      last_corrupt_line: 4,
      valid_records_before_corruption: 3,
      final_line_valid: false,
      newline_terminated: false
    });
    const result = classifyEvidenceIntegrity({
      problems: [],
      streamHealth: [health]
    });
    expect(result).toEqual({
      classification: "invalid_evidence",
      reason_codes: ["corrupt_trailing_line"]
    });
  });

  it("reports an empty file as healthy and newline terminated", async () => {
    const path = join(dir, "empty.jsonl");
    await appendFile(path, "", "utf8");
    expect(await tailHealth(path)).toEqual({
      total_lines: 0,
      valid_records: 0,
      corrupt_lines: [],
      last_corrupt_line: null,
      valid_records_before_corruption: 0,
      final_line_valid: true,
      newline_terminated: true
    });
  });

  it("marks every blank or invalid line as corrupt", async () => {
    const path = join(dir, "mixed.jsonl");
    await appendFile(path, '{"a":1}\n\nnot json\n{"b":2}\n', "utf8");
    const health = await tailHealth(path);
    expect(health.total_lines).toBe(4);
    expect(health.valid_records).toBe(2);
    expect(health.corrupt_lines).toEqual([2, 3]);
    expect(health.last_corrupt_line).toBe(3);
    expect(health.valid_records_before_corruption).toBe(1);
    expect(health.final_line_valid).toBe(true);
  });
});
