import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { sha256HexBytes, stableJsonStringify } from "@oal/core";

import { main } from "./cli.ts";
import { MemoryIo } from "./io.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "oal-inspect-test-"));
}

describe("oal inspect end to end", () => {
  it("prints a stable-key JSON artifact with exactly the documented keys", async () => {
    const dir = await makeTempDir();
    const contents = '{"openapi":"3.1.0"}';
    const file = path.join(dir, "openapi.json");
    await writeFile(file, contents);
    const io = new MemoryIo();
    const code = await main(["inspect", file, "--format", "json"], io, {
      cwd: dir
    });
    expect(code).toBe(0);
    expect(io.stderrChunks).toEqual([]);
    const golden = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(Object.keys(golden).sort()).toEqual([
      "bytes",
      "entrypoint",
      "media_type",
      "sha256"
    ]);
    expect(golden["entrypoint"]).toBe(file);
    expect(golden["media_type"]).toBe("application/json");
    expect(golden["sha256"]).toBe(sha256HexBytes(Buffer.from(contents)));
    expect(golden["bytes"]).toBe(contents.length);
  });

  it("emits the same bytes for --json and --format json", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.yaml");
    await writeFile(file, "openapi: 3.0.0\n");
    const viaFlag = new MemoryIo();
    const viaShorthand = new MemoryIo();
    await main(["inspect", file, "--format", "json"], viaFlag, { cwd: dir });
    await main(["inspect", file, "--json"], viaShorthand, { cwd: dir });
    expect(viaShorthand.stdoutChunks).toEqual(viaFlag.stdoutChunks);
  });

  it("prints key/value lines in terminal format", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.yaml");
    await writeFile(file, "openapi: 3.0.0\n");
    const io = new MemoryIo();
    const code = await main(["inspect", file], io, { cwd: dir });
    expect(code).toBe(0);
    expect(io.stdoutChunks).toEqual([
      `entrypoint: ${file}`,
      "media_type: application/yaml",
      `sha256: ${sha256HexBytes(Buffer.from("openapi: 3.0.0\n"))}`,
      "bytes: 15"
    ]);
  });

  it("resolves a relative source against the working directory", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "openapi.json"), "{}");
    const io = new MemoryIo();
    const code = await main(["inspect", "openapi.json", "--json"], io, {
      cwd: dir
    });
    expect(code).toBe(0);
    const golden = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(golden["entrypoint"]).toBe(path.join(dir, "openapi.json"));
  });

  it("reads standard input when the source is -", async () => {
    const contents = ' {"openapi":"3.1.0"}';
    const io = new MemoryIo(Readable.from([Buffer.from(contents)]));
    const code = await main(["inspect", "-", "--json"], io);
    expect(code).toBe(0);
    const golden = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(golden["bytes"]).toBe(contents.length);
    expect(golden["media_type"]).toBe("application/json");
    expect(await readFile(String(golden["entrypoint"]), "utf8")).toBe(contents);
  });

  it("writes the artifact to --out with a trailing newline", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.json");
    await writeFile(file, '{"openapi":"3.1.0"}');
    const target = path.join(dir, "report.json");
    const io = new MemoryIo();
    const code = await main(["inspect", file, "--json", "--out", target], io, {
      cwd: dir
    });
    expect(code).toBe(0);
    const written = await readFile(target, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written.trim()).toBe(io.stdoutChunks[0] ?? "");
  });

  it("accepts the -o alias for --out", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.json");
    await writeFile(file, "{}");
    const target = path.join(dir, "alias.json");
    const io = new MemoryIo();
    const code = await main(["inspect", file, "--json", "-o", target], io, {
      cwd: dir
    });
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(target, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written["entrypoint"]).toBe(file);
  });

  it("exits 2 with a text diagnostic for a missing source", async () => {
    const io = new MemoryIo();
    const code = await main(["inspect", "/nonexistent/openapi.json"], io);
    expect(code).toBe(2);
    expect(io.stdoutChunks).toEqual([]);
    expect(io.stderrChunks.length).toBe(1);
    expect(io.stderrChunks[0]).toMatch(
      /^OAL-INPUT-MISSING: Source file not found: /
    );
  });

  it("exits 2 with one JSON diagnostic line when --format json", async () => {
    const io = new MemoryIo();
    const code = await main(
      ["inspect", "/nonexistent/openapi.json", "--json"],
      io
    );
    expect(code).toBe(2);
    expect(io.stdoutChunks).toEqual([]);
    const diagnostic = JSON.parse(io.stderrChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(diagnostic["code"]).toBe("OAL-INPUT-MISSING");
    expect(diagnostic["severity"]).toBe("error");
    expect(diagnostic["phase"]).toBe("preflight");
    expect(typeof diagnostic["message"]).toBe("string");
  });

  it("exits 2 for an oversized source with OAL-INPUT-TOO-LARGE", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "big.json");
    await writeFile(file, "x".repeat(64));
    const io = new MemoryIo();
    const code = await main(["inspect", file], io, {
      cwd: dir,
      maxSourceBytes: 32
    });
    expect(code).toBe(2);
    expect(io.stderrChunks[0]).toMatch(/^OAL-INPUT-TOO-LARGE: /);
  });

  it("rejects formats inspect does not support", async () => {
    const io = new MemoryIo();
    const code = await main(
      ["inspect", "doc.json", "--format", "markdown"],
      io
    );
    expect(code).toBe(2);
    expect(io.stderrChunks[0]).toContain("OAL-CLI-INVALID-OPTION-VALUE");
  });

  it("requires exactly one source argument", async () => {
    const missing = new MemoryIo();
    await expect(
      main(["inspect"], missing, { cwd: await makeTempDir() })
    ).resolves.toBe(2);
    expect(missing.stderrChunks[0]).toContain("OAL-CLI-MISSING-ARGUMENT");
    const extra = new MemoryIo();
    await expect(main(["inspect", "a.json", "b.json"], extra)).resolves.toBe(2);
    expect(extra.stderrChunks[0]).toContain("OAL-CLI-TOO-MANY-ARGUMENTS");
  });

  it("matches the golden serialization of the artifact", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.json");
    await writeFile(file, "{}");
    const io = new MemoryIo();
    await main(["inspect", file, "--json"], io, { cwd: dir });
    expect(io.stdoutChunks[0]).toBe(
      stableJsonStringify({
        bytes: 2,
        entrypoint: file,
        media_type: "application/json",
        sha256: sha256HexBytes(Buffer.from("{}"))
      })
    );
  });
});
