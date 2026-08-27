import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_EVAL_THRESHOLD, EXIT_OK, EXIT_UNSUPPORTED } from "@oal/core";

import { main } from "./cli.ts";
import { WorkflowCliCode } from "./handlers/workflow.ts";
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
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-workflow-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

const SCRAPE_WORKFLOW = `arazzo: "1.1.0"
info:
  title: Scrape control run
  version: "1.0.0"
sourceDescriptions:
  - name: steel
    url: contract/openapi.json
    type: openapi
workflows:
  - workflowId: scrape-once
    summary: One scrape call.
    steps:
      - stepId: scrape
        operationId: $sourceDescriptions.steel.scrape
        successCriteria:
          - condition: $statusCode == 200
`;

/** Copy the steel pack and add one workflow document below workflows/. */
async function packWithWorkflow(
  cwd: string,
  document: string
): Promise<string> {
  const steel = await loadSteelPack();
  const packRoot = path.join(cwd, "pack");
  await cp(steel.root, packRoot, { recursive: true });
  await mkdir(path.join(packRoot, "workflows"), { recursive: true });
  await writeFile(path.join(packRoot, "workflows", "scrape.yaml"), document);
  return packRoot;
}

/** One api.exchange record of a successful scrape call. */
function scrapeExchange(sequence: number): string {
  return JSON.stringify({
    schema_version: 1,
    type: "api.exchange",
    event_id: `evt${sequence.toString(10).padStart(6, "0")}`,
    sequence,
    participant_ingress_sequence: sequence,
    observed_at: "2026-08-27T12:00:00.000Z",
    logical_time: null,
    batch_id: "wf-batch",
    run_id: "wf-batch-run-01",
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: true,
      key: "path:POST /v1/scrape",
      uid: null,
      operation_id: "scrape",
      method: "POST",
      path_template: "/v1/scrape",
      support: "supported"
    },
    request: {
      received_at: "2026-08-27T12:00:00.000Z",
      method: "POST",
      path: "/v1/scrape",
      query_string: "",
      query: [],
      path_parameters: {},
      headers: [],
      credential_present: true,
      content_type: "application/json",
      body: {
        kind: "json",
        size_bytes: 2,
        value: { url: "https://x.test" },
        truncated: false
      }
    },
    authentication: {
      status: "authenticated",
      alternative_index: 0,
      schemes: ["apiKey"],
      principal_ref: null
    },
    validation: {
      request: { outcome: "valid", issues: [] },
      response: { outcome: "valid", issues: [] }
    },
    backend: null,
    response: {
      completed_at: "2026-08-27T12:00:00.100Z",
      status: 200,
      headers: [],
      content_type: "application/json",
      body: {
        kind: "json",
        size_bytes: 9,
        value: { sessionId: "s1" },
        truncated: false
      }
    },
    state: null,
    idempotency: { status: "not_requested", request_key_fingerprint: null }
  });
}

/** Rewrite the artifact manifest after the trace of a run tree changes. */
async function refreshManifest(runDir: string): Promise<void> {
  const manifestPath = path.join(runDir, "artifact-manifest.json");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    entries: { path: string; sha256: string }[];
  };
  for (const entry of parsed.entries) {
    const bytes = await readFile(path.join(runDir, entry.path));
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Record one real batch, then return its first run directory. */
async function recordedRun(
  batchId: string
): Promise<{ cwd: string; runDir: string }> {
  const pack = await loadSteelPack();
  const cwd = await newWorkspace();
  const io = new MemoryIo();
  expect(
    await main(
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
    )
  ).toBe(EXIT_OK);
  const batchDir = path.join(cwd, ".oal", "runs", batchId);
  const fs = await import("node:fs/promises");
  const trials = await fs.readdir(path.join(batchDir, "trials"));
  return { cwd, runDir: path.join(batchDir, "trials", trials[0] ?? "") };
}

describe("oal workflow run", () => {
  it("refuses to launch a control run; no executor exists", async () => {
    const cwd = await newWorkspace();
    const packRoot = await packWithWorkflow(cwd, SCRAPE_WORKFLOW);
    const io = new MemoryIo();
    const code = await main(["workflow", "run", packRoot], io, { cwd });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(WorkflowCliCode.NoExecutor);
    expect(io.stdoutChunks).toHaveLength(0);
  });

  it("reports a pack that declares no workflow document", async () => {
    const steel = await loadSteelPack();
    const cwd = await newWorkspace();
    const { runDir } = await recordedRun("wf-empty");
    const io = new MemoryIo();
    const code = await main(
      ["workflow", "run", steel.root, "--run", runDir],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(WorkflowCliCode.NoDocuments);
  });

  it("reports an unknown workflow identifier", async () => {
    const cwd = await newWorkspace();
    const packRoot = await packWithWorkflow(cwd, SCRAPE_WORKFLOW);
    const { runDir } = await recordedRun("wf-unknown");
    const io = new MemoryIo();
    const code = await main(
      ["workflow", "run", packRoot, "--workflow", "missing", "--run", runDir],
      io,
      { cwd }
    );
    expect(code).toBe(2);
    expect(io.stderrText()).toContain(WorkflowCliCode.WorkflowUnknown);
    expect(io.stderrText()).toContain("scrape-once");
  });

  it("aligns a workflow against a trace that holds no matching call", async () => {
    const cwd = await newWorkspace();
    const packRoot = await packWithWorkflow(cwd, SCRAPE_WORKFLOW);
    const { runDir } = await recordedRun("wf-unmatched");
    const io = new MemoryIo();
    const code = await main(
      [
        "workflow",
        "run",
        packRoot,
        "--workflow",
        "scrape-once",
        "--run",
        runDir,
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_EVAL_THRESHOLD);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      alignment: {
        matched: boolean;
        outcomes: Record<string, number>;
        steps: Array<{
          step_id: string;
          outcome: string;
          reason: string | null;
        }>;
      };
    };
    expect(document.alignment.matched).toBe(false);
    expect(document.alignment.steps[0]?.outcome).toBe("unmatched");
    expect(io.stderrText()).toContain(WorkflowCliCode.AlignmentFailed);
  });

  it("aligns a workflow against a recorded scrape call", async () => {
    const cwd = await newWorkspace();
    const packRoot = await packWithWorkflow(cwd, SCRAPE_WORKFLOW);
    const { runDir } = await recordedRun("wf-matched");
    await writeFile(path.join(runDir, "trace.jsonl"), `${scrapeExchange(1)}\n`);
    await refreshManifest(runDir);
    const io = new MemoryIo();
    const code = await main(
      [
        "workflow",
        "run",
        packRoot,
        "--workflow",
        "scrape-once",
        "--run",
        runDir,
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const document = JSON.parse(io.stdoutChunks.join("")) as {
      kind: string;
      alignment: {
        workflow_id: string;
        matched: boolean;
        ambiguous: boolean;
        outcomes: Record<string, number>;
        steps: Array<{
          step_id: string;
          outcome: string;
          event_sequences: number[];
          criteria: Array<{ condition: string; passed: boolean }>;
        }>;
      };
    };
    expect(document.kind).toBe("WorkflowCli");
    expect(document.alignment.workflow_id).toBe("scrape-once");
    expect(document.alignment.matched).toBe(true);
    expect(document.alignment.outcomes["matched"]).toBe(1);
    expect(document.alignment.steps[0]?.event_sequences).toEqual([1]);
    expect(document.alignment.steps[0]?.criteria[0]?.passed).toBe(true);
  });

  it("prints the terminal projection of one alignment", async () => {
    const cwd = await newWorkspace();
    const packRoot = await packWithWorkflow(cwd, SCRAPE_WORKFLOW);
    const { runDir } = await recordedRun("wf-terminal");
    await writeFile(path.join(runDir, "trace.jsonl"), `${scrapeExchange(1)}\n`);
    await refreshManifest(runDir);
    const io = new MemoryIo();
    const code = await main(
      ["workflow", "run", packRoot, "--run", runDir],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const text = io.stdoutChunks.join("\n");
    expect(text).toContain("workflow: scrape-once");
    expect(text).toContain("matched: true");
    expect(text).toContain("steps: 1 matched=1");
    expect(text).toContain("step: scrape matched events=1");
    expect(text).toContain("criterion: passed $statusCode == 200");
  });
});
