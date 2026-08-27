import {
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "@oal/config";
import { OalError, sha256HexBytes } from "@oal/core";

import {
  readStreamBytes,
  resolvePackSource,
  resolveSourceArgument,
  sniffMediaType
} from "./source.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "oal-source-test-"));
}

async function writeDocument(
  dir: string,
  name: string,
  contents: string
): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, contents);
  return target;
}

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof OalError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

describe("media type sniffing", () => {
  it("selects JSON for documents starting with { or [", () => {
    expect(sniffMediaType(Buffer.from('{"a":1}'))).toBe("application/json");
    expect(sniffMediaType(Buffer.from("[1,2]"))).toBe("application/json");
  });

  it("selects YAML otherwise", () => {
    expect(sniffMediaType(Buffer.from("openapi: 3.1.0"))).toBe(
      "application/yaml"
    );
    expect(sniffMediaType(Buffer.from(""))).toBe("application/yaml");
  });

  it("skips leading whitespace and a byte order mark", () => {
    expect(sniffMediaType(Buffer.from('  \n\t {"a":1}'))).toBe(
      "application/json"
    );
    expect(sniffMediaType(Buffer.from("  \n\t openapi: x"))).toBe(
      "application/yaml"
    );
    expect(sniffMediaType(Buffer.from([0xef, 0xbb, 0xbf, 0x7b]))).toBe(
      "application/json"
    );
  });
});

describe("resolveSourceArgument", () => {
  it("resolves a file source with digest, size, and absolute path", async () => {
    const dir = await makeTempDir();
    const contents = '{"openapi":"3.1.0"}';
    const file = await writeDocument(dir, "openapi.json", contents);
    const resolved = await resolveSourceArgument(file);
    expect(path.isAbsolute(resolved.entrypoint)).toBe(true);
    expect(resolved.entrypoint).toBe(file);
    expect(resolved.media_type).toBe("application/json");
    expect(resolved.bytes).toBe(contents.length);
    expect(resolved.sha256).toBe(sha256HexBytes(Buffer.from(contents)));
  });

  it("resolves a relative source against the working directory", async () => {
    const dir = await makeTempDir();
    await writeDocument(dir, "openapi.yaml", "openapi: 3.0.0\n");
    const resolved = await resolveSourceArgument("openapi.yaml", {
      cwd: dir
    });
    expect(resolved.entrypoint).toBe(path.join(dir, "openapi.yaml"));
    expect(resolved.media_type).toBe("application/yaml");
  });

  it("fails with OAL-INPUT-MISSING for a missing file", async () => {
    const dir = await makeTempDir();
    await expect(
      errorCode(() => resolveSourceArgument(path.join(dir, "absent.json")))
    ).resolves.toBe("OAL-INPUT-MISSING");
  });

  it("fails with OAL-INPUT-MISSING for a plain directory", async () => {
    const dir = await makeTempDir();
    await expect(errorCode(() => resolveSourceArgument(dir))).resolves.toBe(
      "OAL-INPUT-MISSING"
    );
  });

  it("fails with OAL-NOT-IMPLEMENTED for a pack directory", async () => {
    const dir = await makeTempDir();
    await writeDocument(dir, "pack.yaml", "apiVersion: agentlab.dev/v1\n");
    await expect(errorCode(() => resolveSourceArgument(dir))).resolves.toBe(
      "OAL-NOT-IMPLEMENTED"
    );
  });

  it("fails with OAL-INPUT-TOO-LARGE above the byte cap", async () => {
    const dir = await makeTempDir();
    const file = await writeDocument(dir, "big.json", "x".repeat(32));
    await expect(
      errorCode(() => resolveSourceArgument(file, { maxBytes: 16 }))
    ).resolves.toBe("OAL-INPUT-TOO-LARGE");
    expect(LIMIT_DEFAULTS.maxSourceOpenapiBytes).toBe(10 * 1024 * 1024);
  });

  it("reads standard input to EOF and spools it to a real file", async () => {
    const contents = '   {"openapi":"3.1.0"}\n';
    const stdin = Readable.from([Buffer.from(contents)]);
    const resolved = await resolveSourceArgument("-", { stdin });
    expect(path.isAbsolute(resolved.entrypoint)).toBe(true);
    expect(await readFile(resolved.entrypoint, "utf8")).toBe(contents);
    expect(resolved.media_type).toBe("application/json");
    expect(resolved.sha256).toBe(sha256HexBytes(Buffer.from(contents)));
    expect(resolved.bytes).toBe(contents.length);
  });

  it("refuses standard input larger than the byte cap", async () => {
    const stdin = Readable.from([
      Buffer.from("a".repeat(20)),
      Buffer.from("b".repeat(20))
    ]);
    await expect(
      errorCode(() => resolveSourceArgument("-", { stdin, maxBytes: 24 }))
    ).resolves.toBe("OAL-INPUT-TOO-LARGE");
  });

  it("reports stream errors as typed failures", async () => {
    const broken = new Readable({
      read(): void {
        /* Hold the stream open until it is destroyed. */
      }
    });
    const failure = new Error("socket hang up");
    queueMicrotask(() => {
      broken.destroy(failure);
    });
    await expect(
      errorCode(() => resolveSourceArgument("-", { stdin: broken }))
    ).resolves.toBe("OAL-INTERNAL");
  });

  it("reads a bounded stream without error", async () => {
    const stream = Readable.from([Buffer.from("openapi: 3.0.0")]);
    const bytes = await readStreamBytes(stream, 1024);
    expect(bytes.byteLength).toBe(14);
  });
});

describe("resolvePackSource", () => {
  it("resolves a member inside the pack root", async () => {
    const root = await makeTempDir();
    await writeDocument(root, "openapi.yaml", "openapi: 3.0.0\n");
    const resolved = await resolvePackSource(root, "openapi.yaml");
    expect(resolved.entrypoint).toBe(
      await realpath(path.join(root, "openapi.yaml"))
    );
    expect(resolved.media_type).toBe("application/yaml");
  });

  it("rejects parent traversal with OAL-REF-OUTSIDE-ROOT", async () => {
    const root = await makeTempDir();
    await expect(
      errorCode(() => resolvePackSource(root, "../outside.json"))
    ).resolves.toBe("OAL-REF-OUTSIDE-ROOT");
    await expect(
      errorCode(() => resolvePackSource(root, "a/../../outside.json"))
    ).resolves.toBe("OAL-REF-OUTSIDE-ROOT");
  });

  it("rejects absolute and dot segments as unsafe relative paths", async () => {
    const root = await makeTempDir();
    await expect(
      errorCode(() => resolvePackSource(root, "/etc/passwd"))
    ).resolves.toBe("OAL-REF-OUTSIDE-ROOT");
    await expect(errorCode(() => resolvePackSource(root, "."))).resolves.toBe(
      "OAL-REF-OUTSIDE-ROOT"
    );
  });

  it("rejects a symlink that escapes the pack root", async () => {
    const root = await makeTempDir();
    const outsideRoot = await makeTempDir();
    const outside = await writeDocument(outsideRoot, "secret.json", "{}");
    await symlink(outside, path.join(root, "escape.json"));
    await expect(
      errorCode(() => resolvePackSource(root, "escape.json"))
    ).resolves.toBe("OAL-REF-OUTSIDE-ROOT");
  });

  it("accepts a symlink that stays inside the pack root", async () => {
    const root = await makeTempDir();
    await writeDocument(root, "openapi.json", '{"openapi":"3.1.0"}');
    await symlink(
      path.join(root, "openapi.json"),
      path.join(root, "alias.json")
    );
    const resolved = await resolvePackSource(root, "alias.json");
    expect(resolved.media_type).toBe("application/json");
  });

  it("reports a missing member as OAL-REF-NOT-FOUND", async () => {
    const root = await makeTempDir();
    await expect(
      errorCode(() => resolvePackSource(root, "absent.json"))
    ).resolves.toBe("OAL-REF-NOT-FOUND");
  });
});
