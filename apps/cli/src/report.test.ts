import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_INVALID,
  EXIT_INFRASTRUCTURE,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  sha256HexBytes,
  type ExitCode
} from "@oal/core";

import { main } from "./cli.ts";
import { ReportCliCode } from "./handlers/report.ts";
import { CompareCliCode } from "./handlers/compare.ts";
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
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-report-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** Record one real one-trial batch with the mock agent. */
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
  return { cwd, batchDir: path.join(cwd, ".oal", "runs", batchId) };
}

/**
 * Rewrite one file of a recorded batch, then re-hash the manifest
 * chain so the mutation reads as intact evidence. Only test fixtures
 * call this; the commands never mutate recorded evidence.
 */
async function rewriteBatchFile(
  batchDir: string,
  relativePath: string,
  text: string
): Promise<void> {
  await writeFile(path.join(batchDir, relativePath), text);
  const manifestPath = path.join(batchDir, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    entries: { path: string; bytes: number; sha256: string }[];
  };
  for (const entry of manifest.entries) {
    if (entry.path === relativePath) {
      entry.bytes = Buffer.byteLength(text);
      entry.sha256 = sha256HexBytes(new TextEncoder().encode(text));
    }
  }
  const manifestText = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestPath, manifestText);
  const pointerPath = path.join(batchDir, "batch.completed.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    manifest_sha256: string;
  };
  pointer.manifest_sha256 = sha256HexBytes(
    new TextEncoder().encode(manifestText)
  );
  await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);
}

describe("oal report", () => {
  it("renders the canonical JSON report of one batch", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-json");
    const io = new MemoryIo();
    const code = await main(["report", batchDir, "--format", "json"], io, {
      cwd
    });
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutChunks.join("")) as {
      kind: string;
      scope: { level: string; id: string };
      counts: {
        launched_trials: number;
        dispositions: Record<string, number>;
        evidence_integrity: { intact: number };
      };
      metrics: Array<{ id: string; numerator: number; denominator: number }>;
    };
    expect(report.kind).toBe("Report");
    expect(report.scope.level).toBe("batch");
    expect(report.scope.id).toBe("cli-report-json");
    expect(report.counts.launched_trials).toBe(1);
    expect(Object.values(report.counts.dispositions)).toEqual([1]);
    expect(report.counts.evidence_integrity.intact).toBe(1);
    expect(report.metrics.length).toBeGreaterThan(0);
    expect(report.metrics.some((metric) => metric.denominator === 1)).toBe(
      true
    );
  });

  it("projects the report to the terminal and to markdown", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-term");
    const terminal = new MemoryIo();
    expect(await main(["report", batchDir], terminal, { cwd })).toBe(EXIT_OK);
    const text = terminal.stdoutChunks.join("\n");
    expect(text).toContain("report: batch cli-report-term");
    expect(text).toContain("trials: 1");
    expect(text).toContain("metric: task_pass");
    // The runner records the terminal fact in the assignment ledger.
    // The projection agrees with the completion record, so the healthy
    // batch stays quiet on the terminal.
    expect(terminal.stderrText()).not.toContain(
      ReportCliCode.TerminalFromLedger
    );

    const markdown = new MemoryIo();
    expect(
      await main(["report", batchDir, "--format", "markdown"], markdown, {
        cwd
      })
    ).toBe(EXIT_OK);
    const md = markdown.stdoutChunks.join("");
    expect(md).toContain("# Report cli-report-term");
    expect(md).toContain("| Metric | Numerator | Denominator |");
  });

  it("stays quiet on healthy batches and keeps an informational JSON diagnostic", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-agree");
    const terminal = new MemoryIo();
    expect(await main(["report", batchDir], terminal, { cwd })).toBe(EXIT_OK);
    // Both terminal sources agree, so the terminal projection is quiet.
    expect(terminal.stderrText()).not.toContain(
      ReportCliCode.TerminalFromLedger
    );
    // --verbose surfaces the informational projection fact as text.
    const verbose = new MemoryIo();
    expect(
      await main(["report", batchDir, "--verbose"], verbose, { cwd })
    ).toBe(EXIT_OK);
    expect(verbose.stderrText()).toContain(ReportCliCode.TerminalFromLedger);
    // The JSON stream keeps the projection fact at informational
    // severity for machine consumers.
    const json = new MemoryIo();
    expect(
      await main(["report", batchDir, "--format", "json"], json, { cwd })
    ).toBe(EXIT_OK);
    const entries = json
      .stderrText()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { code: string; severity: string });
    const projection = entries.find(
      (entry) => entry.code === ReportCliCode.TerminalFromLedger
    );
    expect(projection?.severity).toBe("info");
  });

  it("warns when the ledger terminal contradicts the completion record", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-conflict");
    const trialsRoot = path.join(batchDir, "trials");
    const entries = await readdir(trialsRoot);
    const first = entries[0];
    if (first === undefined) {
      throw new Error("The batch must record one trial.");
    }
    // Flip the recorded disposition so it contradicts the ledger
    // terminal record of the same run.
    const relative = `trials/${first}/run.completed.json`;
    const completed = JSON.parse(
      await readFile(path.join(batchDir, relative), "utf8")
    ) as { disposition: string };
    completed.disposition =
      completed.disposition === "harness_aborted"
        ? "completed"
        : "harness_aborted";
    await rewriteBatchFile(
      batchDir,
      relative,
      `${JSON.stringify(completed)}\n`
    );
    const io = new MemoryIo();
    expect(await main(["report", batchDir], io, { cwd })).toBe(EXIT_OK);
    const stderr = io.stderrText();
    expect(stderr).toContain(ReportCliCode.TerminalFromLedger);
    expect(stderr).toContain("disposition");
  });

  it("warns when a trial holds no terminal record anywhere", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-missing");
    const ledgerPath = path.join(batchDir, "assignment-events.jsonl");
    const records = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind?: string });
    const kept = records.filter((record) => record.kind !== "terminal");
    await rewriteBatchFile(
      batchDir,
      "assignment-events.jsonl",
      `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
    const io = new MemoryIo();
    expect(await main(["report", batchDir], io, { cwd })).toBe(EXIT_OK);
    expect(io.stderrText()).toContain(ReportCliCode.TerminalFromLedger);
  });

  it("writes the report document to --out", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-out");
    const out = path.join(cwd, "report.json");
    const io = new MemoryIo();
    const code = await main(
      ["report", batchDir, "--format", "json", "--out", out],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const written = JSON.parse(await readFile(out, "utf8")) as {
      kind: string;
    };
    expect(written.kind).toBe("Report");
  });

  it("refuses the HTML projection with exit 4", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-html");
    const io = new MemoryIo();
    const code = await main(["report", batchDir, "--format", "html"], io, {
      cwd
    });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ReportCliCode.HtmlUnsupported);
  });

  it("refuses --regrade without --rubric", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-regrade");
    const io = new MemoryIo();
    const code = await main(["report", batchDir, "--regrade"], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ReportCliCode.RegradeNeedsRubric);
  });

  it("re-grades with --rubric and records the derived lineage", async () => {
    const pack = await loadSteelPack();
    const { cwd, batchDir } = await recordedBatch("cli-report-derived");
    const rubric = path.join(
      pack.root,
      "evals",
      "basic-lifecycle",
      "rubric.yaml"
    );
    const io = new MemoryIo();
    const code = await main(
      ["report", batchDir, "--regrade", "--rubric", rubric, "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutChunks.join("")) as {
      scope: { lineage?: string };
      extensions: {
        regrade?: {
          rubric_sha256: string;
          derived_evaluations: string[];
        };
      };
    };
    expect(report.scope.lineage).toBe("derived");
    expect(report.extensions.regrade?.rubric_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.extensions.regrade?.derived_evaluations).toHaveLength(1);
    for (const artifact of report.extensions.regrade?.derived_evaluations ??
      []) {
      const derived = JSON.parse(await readFile(artifact, "utf8")) as {
        run_id: string;
      };
      expect(derived.run_id).toContain("cli-report-derived");
    }
  });

  it("refuses a run tree whose artifact hashes drifted", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-drift");
    const runDir = path.join(batchDir, "trials");
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(runDir)
    );
    const first = entries[0];
    if (first === undefined) {
      throw new Error("The batch must record one trial.");
    }
    await writeFile(path.join(runDir, first, "state.summary.json"), "{}\n");
    const io = new MemoryIo();
    const code = await main(["report", batchDir], io, { cwd });
    expect(code).toBe(EXIT_INFRASTRUCTURE);
    expect(io.stderrText()).toContain(ReportCliCode.EvidenceDrift);
  });

  it("refuses drift in a frozen batch input", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-report-input-drift");
    await writeFile(
      path.join(batchDir, "inputs", "rubric.frozen.yaml"),
      "tampered: true\n"
    );
    const io = new MemoryIo();
    const code = await main(["report", batchDir], io, { cwd });
    expect(code).toBe(EXIT_INFRASTRUCTURE);
    expect(io.stderrText()).toContain(ReportCliCode.EvidenceDrift);
  });
});

describe("oal compare", () => {
  it("compares two recorded batches descriptively", async () => {
    const first = await recordedBatch("cli-compare-a");
    const second = await recordedBatch("cli-compare-b");
    const io = new MemoryIo();
    const code = await main(
      ["compare", first.batchDir, second.batchDir, "--format", "json"],
      io,
      { cwd: first.cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      kind: string;
      compatible: boolean;
      compatibility_differences: string[];
      comparison: {
        kind: string;
        interpretation: string;
        metrics: Array<{ metric_id: string; verdict: string }>;
      };
    };
    expect(document.kind).toBe("CompareCli");
    expect(document.comparison.kind).toBe("ReportComparison");
    // A plain batch carries no study compatibility keys, so section 27.5
    // refuses pooling and the comparison stays side by side.
    expect(document.compatible).toBe(false);
    expect(document.compatibility_differences).toContain(
      "neither report carries compatibility keys"
    );
    expect(document.comparison.interpretation).toBe("incompatible");
    expect(document.comparison.metrics.length).toBeGreaterThan(0);
    expect(document.comparison.metrics[0]?.verdict).toBe(
      "not_compared_incompatible"
    );
  });

  it("accepts saved report documents as targets", async () => {
    const first = await recordedBatch("cli-compare-file-a");
    const second = await recordedBatch("cli-compare-file-b");
    const reportA = path.join(first.cwd, "a.json");
    const reportB = path.join(first.cwd, "b.json");
    for (const [source, target] of [
      [first.batchDir, reportA],
      [second.batchDir, reportB]
    ] as const) {
      const io = new MemoryIo();
      expect(
        await main(
          ["report", source, "--format", "json", "--out", target],
          io,
          { cwd: first.cwd }
        )
      ).toBe(EXIT_OK);
    }
    const io = new MemoryIo();
    const code = await main(
      ["compare", reportA, reportB, "--format", "json"],
      io,
      { cwd: first.cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      comparison: { kind: string };
    };
    expect(document.comparison.kind).toBe("ReportComparison");
  });

  it("renders the markdown and terminal projections", async () => {
    const first = await recordedBatch("cli-compare-md-a");
    const second = await recordedBatch("cli-compare-md-b");
    const markdown = new MemoryIo();
    expect(
      await main(
        ["compare", first.batchDir, second.batchDir, "--format", "markdown"],
        markdown,
        { cwd: first.cwd }
      )
    ).toBe(EXIT_OK);
    expect(markdown.stdoutChunks.join("")).toContain("# Comparison");
    const terminal = new MemoryIo();
    expect(
      await main(["compare", first.batchDir, second.batchDir], terminal, {
        cwd: first.cwd
      })
    ).toBe(EXIT_OK);
    const text = terminal.stdoutChunks.join("\n");
    expect(text).toContain("baseline: batch cli-compare-md-a");
    expect(text).toContain("interpretation: incompatible");
    expect(text).toContain(
      "difference: neither report carries compatibility keys"
    );
  });

  it("refuses comparing one target with itself", async () => {
    const { cwd, batchDir } = await recordedBatch("cli-compare-same");
    const io = new MemoryIo();
    const code = await main(["compare", batchDir, batchDir], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(CompareCliCode.SameTarget);
  });

  it("refuses the HTML format", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["compare", cwd, cwd, "--format", "html"], io, {
      cwd
    });
    expect(code).toBe(EXIT_INVALID);
  });
});
