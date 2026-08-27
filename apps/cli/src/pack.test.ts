import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK } from "@oal/core";
import { scaffoldPack, validatePack } from "@oal/pack";

import { main } from "./cli.ts";
import { MemoryIo } from "./io.ts";
import {
  baseFiles,
  cleanupPacks,
  writePack
} from "../../../packages/pack/src/testkit.ts";

const OPENAPI_FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../tests/fixtures/openapi/minimal.json"
);

const scratchDirectories: string[] = [];

afterEach(async () => {
  await cleanupPacks();
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<{ cwd: string; pack: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-pack-cli-"));
  scratchDirectories.push(cwd);
  return { cwd, pack: path.join(cwd, "widget-pack") };
}

describe("oal pack init", () => {
  it("scaffolds a pack that validates cleanly", async () => {
    const { cwd, pack } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["pack", "init", "widget-pack", "--openapi", OPENAPI_FIXTURE],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.join("\n")).toContain("widget-pack");

    const manifest = await readFile(path.join(pack, "pack.yaml"), "utf8");
    expect(manifest).toContain("id: widget-pack");
    for (const name of ["contract", "prompts", "tasks", "schemas", "evals"]) {
      const stats = await stat(path.join(pack, name));
      expect(stats.isDirectory()).toBe(true);
    }
    const result = await validatePack(pack);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("refuses to run without --openapi", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["pack", "init", "widget-pack"], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stdoutChunks).toEqual([]);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-OPENAPI-MISSING");
  });

  it("refuses a non-empty target directory and keeps it intact", async () => {
    const { cwd, pack } = await newWorkspace();
    await main(
      ["pack", "init", "widget-pack", "--openapi", OPENAPI_FIXTURE],
      new MemoryIo(),
      { cwd }
    );
    const before = (await readdir(pack)).sort();

    const io = new MemoryIo();
    const code = await main(
      ["pack", "init", "widget-pack", "--openapi", OPENAPI_FIXTURE],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-TARGET-NOT-EMPTY");
    expect((await readdir(pack)).sort()).toEqual(before);
  });

  it("prints one JSON object under --format json", async () => {
    const { cwd } = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      [
        "pack",
        "init",
        "widget-pack",
        "--openapi",
        OPENAPI_FIXTURE,
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_OK);
    const record = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record["id"]).toBe("widget-pack");
    expect(record["root"]).toBe(path.join(cwd, "widget-pack"));
  });
});

describe("oal pack validate", () => {
  it("prints a summary and exits 0 for a valid pack", async () => {
    const root = await writePack(baseFiles());
    const io = new MemoryIo();
    const code = await main(["pack", "validate", root], io);
    expect(code).toBe(EXIT_OK);
    const summary = io.stdoutChunks.join("\n");
    expect(summary).toContain("pack: test-pack");
    expect(summary).toContain("manifest: pack.json");
    expect(summary).toContain("operations: 2");
  });

  it("resolves a relative pack path against the working directory", async () => {
    const root = await writePack(baseFiles());
    const io = new MemoryIo();
    const code = await main(["pack", "validate", path.basename(root)], io, {
      cwd: path.dirname(root)
    });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.join("\n")).toContain("pack: test-pack");
  });

  it("exits 2 and prints the diagnostic for a broken pack", async () => {
    const files = baseFiles();
    files["pack.json"] = (files["pack.json"] ?? "").replace(
      '"prompt_set": "smoke"',
      '"prompt_set": "ghost"'
    );
    const root = await writePack(files);
    const io = new MemoryIo();
    const code = await main(["pack", "validate", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-PROMPT-SET-UNKNOWN");
  });

  it("exits 2 for a pack directory without a manifest", async () => {
    const files = baseFiles();
    delete files["pack.json"];
    const root = await writePack(files);
    const io = new MemoryIo();
    const code = await main(["pack", "validate", root], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-PACK-MANIFEST-MISSING");
  });

  it("exits 2 when the pack argument is missing", async () => {
    const io = new MemoryIo();
    const code = await main(["pack", "validate"], io);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-CLI-MISSING-ARGUMENT");
  });

  it("escalates warnings to a failure under --strict", async () => {
    const files = baseFiles();
    files["schemas/result.schema.json"] = `${JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object"
    })}\n`;
    const root = await writePack(files);

    const plain = new MemoryIo();
    expect(await main(["pack", "validate", root], plain)).toBe(EXIT_OK);
    expect(plain.stderrChunks.join("\n")).toContain("OAL-PACK-SCHEMA-DRAFT");

    const strict = new MemoryIo();
    expect(await main(["pack", "validate", root, "--strict"], strict)).toBe(
      EXIT_INVALID
    );
  });

  it("prints the PackIR as one JSON document under --format json", async () => {
    const root = await writePack(baseFiles());
    const io = new MemoryIo();
    const code = await main(["pack", "validate", root, "--format", "json"], io);
    expect(code).toBe(EXIT_OK);
    const ir = JSON.parse(io.stdoutChunks[0] ?? "") as Record<string, unknown>;
    expect(ir["kind"]).toBe("PackIR");
    expect(ir["schema_version"]).toBe(1);
  });
});

describe("scaffoldPack helper", () => {
  it("derives a safe pack id from the directory name", async () => {
    const { cwd } = await newWorkspace();
    const result = await scaffoldPack("Odd Name.dir", {
      openapi: OPENAPI_FIXTURE,
      cwd
    });
    expect(result.id).toBe("odd-name.dir");
  });
});
