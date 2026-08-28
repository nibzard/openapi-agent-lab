import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "@oal/core";

import { main } from "./cli.ts";
import { MemoryIo } from "./io.ts";
import { loadSteelPack } from "../../../packages/testkit/src/index.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "oal-inspect-test-"));
}

const VALID_JSON = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Inspect", version: "1.0.0" },
  paths: {}
});

const VALID_YAML =
  "openapi: 3.0.0\ninfo:\n  title: Inspect\n  version: 1.0.0\npaths: {}\n";

describe("oal inspect end to end", () => {
  it("prints the documented semantic and capability fields", async () => {
    const dir = await makeTempDir();
    const contents = VALID_JSON;
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
    expect(golden["kind"]).toBe("InspectReport");
    expect(golden["entrypoint"]).toBe(file);
    expect(golden["source_format"]).toBe("application/json");
    expect(golden["openapi_version"]).toBe("3.1.0");
    expect(golden["source_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(golden["semantic_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(golden["operation_count"]).toBe(0);
    expect(golden["recommendations"]).toBeTypeOf("object");
  });

  it("emits the same bytes for --json and --format json", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.yaml");
    await writeFile(file, VALID_YAML);
    const viaFlag = new MemoryIo();
    const viaShorthand = new MemoryIo();
    await main(["inspect", file, "--format", "json"], viaFlag, { cwd: dir });
    await main(["inspect", file, "--json"], viaShorthand, { cwd: dir });
    expect(viaShorthand.stdoutChunks).toEqual(viaFlag.stdoutChunks);
  });

  it("prints key/value lines in terminal format", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.yaml");
    await writeFile(file, VALID_YAML);
    const io = new MemoryIo();
    const code = await main(["inspect", file], io, { cwd: dir });
    expect(code).toBe(0);
    expect(io.stdoutChunks).toEqual([
      "OpenAPI version: 3.0.0",
      `Source: ${file}`,
      expect.stringMatching(/^Source SHA-256: [a-f0-9]{64}$/),
      expect.stringMatching(/^Semantic SHA-256: [a-f0-9]{64}$/),
      "Operations: 0",
      "Recommended exposure: raw-http"
    ]);
  });

  it("resolves a relative source against the working directory", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "openapi.json"), VALID_JSON);
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
    const contents = VALID_JSON;
    const io = new MemoryIo(Readable.from([Buffer.from(contents)]));
    const code = await main(["inspect", "-", "--json"], io);
    expect(code).toBe(0);
    const golden = JSON.parse(io.stdoutChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(golden["source_format"]).toBe("application/json");
    expect(await readFile(String(golden["entrypoint"]), "utf8")).toBe(contents);
  });

  it("writes the artifact to --out with a trailing newline", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.json");
    await writeFile(file, VALID_JSON);
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
    await writeFile(file, VALID_JSON);
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

  it("uses stable JSON serialization", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "openapi.json");
    await writeFile(file, VALID_JSON);
    const io = new MemoryIo();
    await main(["inspect", file, "--json"], io, { cwd: dir });
    const parsed = JSON.parse(io.stdoutChunks[0] ?? "null") as never;
    expect(io.stdoutChunks[0]).toBe(stableJsonStringify(parsed));
  });

  it("loads a pack and reports its eval compatibility", async () => {
    const pack = await loadSteelPack();
    const io = new MemoryIo();
    expect(await main(["inspect", pack.root, "--json"], io)).toBe(0);
    const report = JSON.parse(io.stdoutChunks[0] ?? "{}") as {
      operation_count: number;
      pack_eval_compatibility: { eval_ids: string[] };
    };
    expect(report.operation_count).toBeGreaterThan(0);
    expect(report.pack_eval_compatibility.eval_ids).toContain(
      "basic-lifecycle"
    );
  });

  it("loads referenced sibling documents and filters one operation", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Refs", version: "1.0.0" },
        paths: {
          "/things": {
            get: {
              operationId: "listThings",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "shared.json#/$defs/Things" }
                    }
                  }
                }
              }
            }
          }
        }
      })
    );
    await writeFile(
      path.join(dir, "shared.json"),
      JSON.stringify({ $defs: { Things: { type: "array", items: {} } } })
    );
    const io = new MemoryIo();
    expect(
      await main(
        ["inspect", "openapi.json", "--operation", "listThings", "--json"],
        io,
        { cwd: dir }
      )
    ).toBe(0);
    const report = JSON.parse(io.stdoutChunks[0] ?? "{}") as {
      operation_count: number;
      referenced_documents: unknown[];
    };
    expect(report.operation_count).toBe(1);
    expect(report.referenced_documents).toHaveLength(2);
  });
});
