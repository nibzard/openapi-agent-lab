import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, sha256Hex, type ExitCode } from "@oal/core";

import { main } from "./cli.ts";
import {
  EvaluateCliCode,
  evaluationMatches,
  evaluationFactsOf,
  participantReportOf,
  runMetadataOf
} from "./handlers/evaluate.ts";
import {
  RunTreeCode,
  loadRunOrBatch,
  trialsOf,
  verifyArtifactsOf
} from "./handlers/run-tree.ts";
import { MemoryIo } from "./io.ts";
import { loadSteelPack } from "../../../packages/testkit/src/index.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-evaluate-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Run one real one-trial batch with the mock agent and return its batch. */
async function recordedBatch(
  batchId: string
): Promise<{ cwd: string; batchDir: string }> {
  const pack = await loadSteelPack();
  const cwd = await newWorkspace();
  const io = new MemoryIo();
  const code: ExitCode = await main(
    [
      "run",
      pack.root,
      "--eval",
      "basic-lifecycle",
      "--batch",
      batchId,
      "--no-fail-on-eval",
      "--format",
      "json"
    ],
    io,
    { cwd }
  );
  expect(code).toBe(EXIT_OK);
  const batchDir = path.join(cwd, ".oal", "runs", batchId);
  return { cwd, batchDir };
}

async function runDirOf(batchDir: string): Promise<string> {
  const trials = path.join(batchDir, "trials");
  const first = (await readdir(trials))[0];
  if (first === undefined) {
    throw new Error("The batch recorded no trial.");
  }
  return path.join(trials, first);
}

describe("evaluation fact helpers", () => {
  it("reads the facts of one recorded evaluation", () => {
    const facts = evaluationFactsOf({
      schema_version: 1,
      rubric_id: "steel-basic-lifecycle",
      run_id: "run_x",
      status: "failed",
      score: 0.25,
      passed_weight: 1,
      total_weight: 4,
      checks: [
        {
          id: "a",
          status: "passed",
          required: true,
          weight: 1,
          message: ""
        },
        {
          id: "b",
          status: "failed",
          required: true,
          weight: 3,
          message: ""
        }
      ],
      signals: {},
      infrastructure_errors: []
    });
    expect(facts?.status).toBe("failed");
    expect(facts?.passed_checks).toBe(1);
    expect(facts?.failed_checks).toBe(1);
  });

  it("treats a null record as no match", () => {
    const facts = {
      status: "passed",
      score: 1,
      passed_weight: 1,
      total_weight: 1,
      passed_checks: 0,
      failed_checks: 0,
      rubric_sha256: null
    };
    expect(evaluationMatches(null, facts)).toBe(false);
  });

  it("parses JSON participant text only", () => {
    expect(participantReportOf(null)).toBeNull();
    expect(participantReportOf("not json")).toBeNull();
    expect(participantReportOf('{"ok":true}')).toEqual({ ok: true });
  });

  it("rebuilds run metadata from the start record", async () => {
    const { batchDir } = await recordedBatch("cli-eval-meta");
    const subject = await loadRunOrBatch(await runDirOf(batchDir));
    const trial = trialsOf(subject)[0];
    if (trial === undefined) {
      throw new Error("The batch must record one trial.");
    }
    const metadata = runMetadataOf(trial);
    expect(metadata["run_id"]).toBe(trial.runId);
    expect(metadata["batch_id"]).toBe("cli-eval-meta");
    expect(metadata["adapter"]).toBe("mock-agent");
    expect(metadata["exposure_mode"]).toBe("raw-http");
  });
});

describe("verifyArtifactsOf", () => {
  /**
   * One scratch batch directory below `cwd/nest/batch` that holds a
   * crafted manifest, so `../..` resolves outside the batch root.
   */
  async function craftedManifest(
    cwd: string,
    entries: unknown[]
  ): Promise<string> {
    const root = path.join(cwd, "nest", "batch");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "artifact-manifest.json"),
      `${JSON.stringify({ schema_version: 1, kind: "ArtifactManifest", entries })}\n`
    );
    return root;
  }

  it("refuses a manifest entry that escapes the batch root", async () => {
    const cwd = await newWorkspace();
    const secret = "operator-secret-token";
    const outside = path.join(cwd, "secret", "token.txt");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, secret);
    const digest = sha256Hex(secret);
    const root = await craftedManifest(cwd, [
      { path: "../../secret/token.txt", sha256: "0".repeat(64) }
    ]);

    const findings = await verifyArtifactsOf(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("not a safe relative path");
    // The outside file was never hashed, so its digest appears nowhere.
    expect(JSON.stringify(findings)).not.toContain(digest);
  });

  it("refuses an in-tree symlink without reading its target", async () => {
    const cwd = await newWorkspace();
    const secret = "operator-secret-token";
    const outside = path.join(cwd, "outside.txt");
    await writeFile(outside, secret);
    const digest = sha256Hex(secret);
    const root = await craftedManifest(cwd, [
      { path: "link.txt", sha256: "0".repeat(64) }
    ]);
    await symlink(outside, path.join(root, "link.txt"));

    const findings = await verifyArtifactsOf(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("not a regular file");
    // The link target was never read, so its digest appears nowhere.
    expect(JSON.stringify(findings)).not.toContain(digest);
  });

  it("refuses an absolute manifest path", async () => {
    const cwd = await newWorkspace();
    const root = await craftedManifest(cwd, [
      { path: "/etc/passwd", sha256: "0".repeat(64) }
    ]);

    const findings = await verifyArtifactsOf(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("not a safe relative path");
  });

  it("reports one finding per malformed manifest entry", async () => {
    const cwd = await newWorkspace();
    const root = await craftedManifest(cwd, [
      42,
      { sha256: "0".repeat(64) },
      { path: "evaluation.json" }
    ]);

    const findings = await verifyArtifactsOf(root);
    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      expect(finding.detail).toContain("malformed");
    }
  });
});

describe("oal evaluate", () => {
  it("refuses a directory that is neither a run nor a batch", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["evaluate", cwd], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(RunTreeCode.NotRunOrBatch);
  });

  it("refuses the markdown format", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["evaluate", cwd, "--format", "markdown"], io, {
      cwd
    });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain("OAL-CLI-INVALID-OPTION-VALUE");
  });

  it("reports the recorded evaluation and names the frozen rubric gap", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-eval-default");
    const io = new MemoryIo();
    const code = await main(["evaluate", batchDir, "--format", "json"], io, {
      cwd
    });
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      kind: string;
      rubric: { kind: string };
      runs: Array<{
        run_id: string;
        recorded: { status: string } | null;
        regraded: unknown;
        derived_artifact: unknown;
      }>;
    };
    expect(document.kind).toBe("EvaluateCli");
    expect(document.rubric.kind).toBe("recorded");
    expect(document.runs).toHaveLength(1);
    expect(document.runs[0]?.recorded?.status).toBe("failed");
    expect(document.runs[0]?.regraded).toBeNull();
    expect(document.runs[0]?.derived_artifact).toBeNull();
    expect(io.stderrText()).toContain(EvaluateCliCode.FrozenRubricUnavailable);
  });

  it("accepts a single run directory", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-eval-run");
    const runDir = await runDirOf(batchDir);
    const io = new MemoryIo();
    const code = await main(["evaluate", runDir], io, { cwd });
    expect(code).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("run: cli-eval-run-run-01");
    expect(text).toContain("recorded: failed");
  });

  it("refuses a batch whose recorded artifact drifted", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-eval-drift");
    const runDir = await runDirOf(batchDir);
    const evaluation = path.join(runDir, "evaluation.json");
    await writeFile(evaluation, '{"tampered":true}\n');
    const io = new MemoryIo();
    const code = await main(["evaluate", batchDir], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(EvaluateCliCode.EvidenceDrift);
  });

  it("re-grades with an explicit rubric and writes a derived artifact", async () => {
    const pack = await loadSteelPack();
    const { cwd, batchDir } = await recordedBatch("cli-eval-rubric");
    const io = new MemoryIo();
    const rubric = path.join(
      pack.root,
      "evals",
      "basic-lifecycle",
      "rubric.yaml"
    );
    const code = await main(
      ["evaluate", batchDir, "--rubric", rubric, "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      rubric: { kind: string; sha256: string };
      runs: Array<{
        recorded: unknown;
        regraded: { status: string } | null;
        matches: boolean | null;
        derived_artifact: string;
      }>;
    };
    expect(document.rubric.kind).toBe("override");
    expect(document.rubric.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(document.runs[0]?.regraded?.status).toBe("failed");
    expect(document.runs[0]?.matches).toBe(true);
    const artifact = document.runs[0]?.derived_artifact;
    expect(typeof artifact).toBe("string");
    const derived = JSON.parse(
      await readFile(artifact as string, "utf8")
    ) as Record<string, unknown>;
    expect(derived["run_id"]).toBe("cli-eval-rubric-run-01");
    const original = JSON.parse(
      await readFile(
        path.join(await runDirOf(batchDir), "evaluation.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(original["schema_version"]).toBe(1);

    // A second invocation refuses to overwrite the derived artifact.
    const again = new MemoryIo();
    const second = await main(
      ["evaluate", batchDir, "--rubric", rubric],
      again,
      { cwd }
    );
    expect(second).toBe(EXIT_INVALID);
    expect(again.stderrText()).toContain(EvaluateCliCode.DerivedExists);
  });

  it("refuses a rubric document that does not load", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-eval-bad-rubric");
    const rubric = path.join(cwd, "broken.yaml");
    await writeFile(rubric, "rubric_version: 9\nid: broken\n");
    const io = new MemoryIo();
    const code = await main(["evaluate", batchDir, "--rubric", rubric], io, {
      cwd
    });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).not.toBe("");
  });
});
