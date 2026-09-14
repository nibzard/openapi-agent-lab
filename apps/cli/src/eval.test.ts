import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRubric } from "@oal/evaluator";
import { parsePackDocument } from "@oal/pack";
import { EXIT_INVALID, EXIT_OK, type Json } from "@oal/core";

import { main } from "./cli.ts";
import { scaffoldEval } from "./handlers/eval.ts";
import { MemoryIo } from "./io.ts";
import {
  baseFiles,
  cleanupPacks,
  REPO_ROOT,
  writePack
} from "../../../packages/pack/src/testkit.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await cleanupPacks();
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-eval-cli-"));
  scratchDirectories.push(cwd);
  return { cwd };
}

/** Scaffold one eval directory through the same helper the command uses. */
async function scaffoldedEval(cwd: string, id = "review"): Promise<string> {
  const root = path.join(cwd, id);
  await scaffoldEval(root, { cwd, id });
  return root;
}

describe("oal eval init", () => {
  it("scaffolds an eval directory that validates cleanly", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["eval", "init", "widget-review"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.join("\n")).toContain("widget-review");

    const root = path.join(cwd, "widget-review");
    const document = await readFile(path.join(root, "eval.yaml"), "utf8");
    expect(document).toContain("id: widget-review");
    for (const name of [
      "task.md",
      "eval.yaml",
      "result.schema.json",
      "rubric.yaml",
      "cases/case.schema.json",
      "cases/cases.jsonl"
    ]) {
      const text = await readFile(path.join(root, name), "utf8");
      expect(text.length).toBeGreaterThan(0);
    }

    const validate = new MemoryIo();
    const validated = await main(["eval", "validate", root], validate);
    expect(validated).toBe(EXIT_OK);
    expect(validate.stderrChunks).toEqual([]);
  });

  it("compiles the scaffolded rubric with zero diagnostics", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd, "widget-review");
    const rubricPath = "rubric.yaml";
    const text = await readFile(path.join(root, rubricPath), "utf8");
    const parsed = parsePackDocument(text, rubricPath);
    expect(parsed.value).not.toBeNull();
    const schema = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "schemas", "rubric.v1.schema.json"),
        "utf8"
      )
    ) as Json;
    const loaded = loadRubric(parsed.value, {
      schema,
      documentUri: rubricPath
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.rubric).not.toBeNull();
  });

  it("derives a safe eval id from the directory name", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["eval", "init", "Odd Name.dir"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.join("\n")).toContain("eval id: odd-name.dir");
  });

  it("refuses a non-empty target directory and keeps it intact", async () => {
    const { cwd } = await newWorkspace();
    const root = path.join(cwd, "busy");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "keep.txt"), "keep\n");
    const before = (await readdir(root)).sort();

    const io = new MemoryIo();
    const code = await main(["eval", "init", "busy"], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-TARGET-NOT-EMPTY");
    expect((await readdir(root)).sort()).toEqual(before);
  });

  it("refuses an unsafe explicit identifier", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["eval", "init", "review", "--id", "../escape"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-ID-UNSAFE");
  });

  it("prints one JSON object under --format json", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["eval", "init", "widget-review", "--format", "json"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const record = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record["id"]).toBe("widget-review");
    expect(record["root"]).toBe(path.join(cwd, "widget-review"));
    expect(record["files"]).toEqual([
      "task.md",
      "eval.yaml",
      "result.schema.json",
      "rubric.yaml",
      "cases/case.schema.json",
      "cases/cases.jsonl"
    ]);
  });
});

describe("oal eval validate", () => {
  it("summarizes a valid eval and exits 0", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const io = new MemoryIo();
    const code = await main(["eval", "validate", root], io);
    expect(code).toBe(EXIT_OK);
    const summary = io.stdoutChunks.join("\n");
    expect(summary).toContain("eval: review");
    expect(summary).toContain("task: task.md -> TASK.md");
    expect(summary).toContain("result: adapter_final result.schema.json");
    expect(summary).toContain("cases: 1");
    expect(summary).toContain("scenario: baseline");
  });

  it("accepts the eval document file itself", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const io = new MemoryIo();
    const code = await main(
      ["eval", "validate", path.join(root, "eval.yaml")],
      io
    );
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.join("\n")).toContain("eval: review");
  });

  it("exits 2 when the path argument is missing", async () => {
    const io = new MemoryIo();
    const code = await main(["eval", "validate"], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-CLI-MISSING-ARGUMENT");
  });

  it("exits 2 for a path that names no eval document", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["eval", "validate", path.join(cwd, "ghost")], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-DOCUMENT-MISSING");
  });

  it("exits 2 for a workspace_file result without a filename", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const documentPath = path.join(root, "eval.yaml");
    const document = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      document.replace("source: adapter_final", "source: workspace_file")
    );
    const io = new MemoryIo();
    const code = await main(["eval", "validate", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-INVALID");
    expect(io.stdoutChunks).toEqual([]);
  });

  it("exits 2 for a missing referenced rubric", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const documentPath = path.join(root, "eval.yaml");
    const document = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      document.replace("rubric: rubric.yaml", "rubric: ghost.yaml")
    );
    const io = new MemoryIo();
    const code = await main(["eval", "validate", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-INVALID");
  });

  it("exits 2 for a duplicate case id", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const line = await readFile(path.join(root, "cases/cases.jsonl"), "utf8");
    await writeFile(path.join(root, "cases/cases.jsonl"), `${line}${line}`);
    const io = new MemoryIo();
    const code = await main(["eval", "validate", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-EVAL-CASE-INVALID");
  });

  it("escalates a schema draft warning under --strict", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    await writeFile(
      path.join(root, "result.schema.json"),
      `${JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object"
      })}\n`
    );
    const plain = new MemoryIo();
    expect(await main(["eval", "validate", root], plain)).toBe(EXIT_OK);
    expect(plain.stderrChunks.join("\n")).toContain("OAL-EVAL-SCHEMA-DRAFT");

    const strict = new MemoryIo();
    expect(await main(["eval", "validate", root, "--strict"], strict)).toBe(
      EXIT_INVALID
    );
  });

  it("prints one JSON object under --format json", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const io = new MemoryIo();
    const code = await main(["eval", "validate", root, "--format", "json"], io);
    expect(code).toBe(EXIT_OK);
    const record = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record["id"]).toBe("review");
    expect(record["case_count"]).toBe(1);
    expect(record["rubric"]).toBe("rubric.yaml");
  });

  it("rejects an unsupported output format", async () => {
    const { cwd } = await newWorkspace();
    const root = await scaffoldedEval(cwd);
    const io = new MemoryIo();
    const code = await main(
      ["eval", "validate", root, "--format", "markdown"],
      io
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-CLI-INVALID-OPTION-VALUE");
  });
});

describe("oal eval list", () => {
  it("lists the evals a pack declares", async () => {
    const root = await writePack(baseFiles());
    const io = new MemoryIo();
    const code = await main(["eval", "list", root], io);
    expect(code).toBe(EXIT_OK);
    const line = io.stdoutChunks[0] ?? "";
    expect(line).toContain("smoke:");
    expect(line).toContain("task_target=TASK.md");
    expect(line).toContain("result_source=adapter_final");
    const digest = line.slice(
      line.indexOf("rubric_sha256=") + "rubric_sha256=".length
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prints one JSON array under --format json", async () => {
    const root = await writePack(baseFiles());
    const io = new MemoryIo();
    const code = await main(["eval", "list", root, "--format", "json"], io);
    expect(code).toBe(EXIT_OK);
    const record = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record["pack"]).toBe("test-pack");
    const evals = record["evals"] as Record<string, unknown>[];
    expect(evals.length).toBe(1);
    expect(evals[0]?.["id"]).toBe("smoke");
    expect(evals[0]?.["prompt_set"]).toBe("smoke");
    expect(evals[0]?.["task_target"]).toBe("TASK.md");
    expect(evals[0]?.["result_source"]).toBe("adapter_final");
    expect(evals[0]?.["scenario"]).toBe("baseline");
    expect(String(evals[0]?.["rubric_sha256"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 2 for a directory without a pack manifest", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["eval", "list", cwd], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-MANIFEST-MISSING");
  });

  it("exits 2 and prints no list for a broken pack", async () => {
    const files = baseFiles();
    delete files["evals/smoke/rubric.yaml"];
    const root = await writePack(files);
    const io = new MemoryIo();
    const code = await main(["eval", "list", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stdoutChunks).toEqual([]);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-ASSET");
  });
});
