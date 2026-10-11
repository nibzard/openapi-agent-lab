/**
 * World checkpoint and fork tests (specification sections 48.3 and
 * 48.4). A checkpoint taken from a live serve restores after the
 * source process closes and its working directory is gone: the forks
 * continue the identifier counter, the random stream, and the
 * logical time, replay a synthetic idempotency entry, and stay
 * isolated from each other. Corrupt metadata, missing keys, missing
 * blobs, and interrupted writes fail before any listener starts.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Json, JsonObject } from "@oal/core";
import { createNamespacePrng } from "@oal/state-store";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";

const webclipRoot = path.resolve(import.meta.dirname, "../../../packs/webclip");

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function newWorkspace(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), prefix));
  scratch.push(cwd);
  return cwd;
}

/** Wait until the readiness record appears on stdout. */
async function awaitReadiness(
  io: MemoryIo,
  timeoutMs = 30_000
): Promise<JsonObject & { readonly baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunk = io.stdoutChunks[0];
    if (chunk !== undefined) {
      try {
        return JSON.parse(chunk) as JsonObject & { readonly baseUrl: string };
      } catch {
        // The record is not complete yet; keep waiting.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No readiness record: ${io.stdoutChunks.join("")} stderr: ${io.stderrText()}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** The bearer credential one world wrote for its first alternative. */
async function bearerOf(worldDir: string): Promise<string> {
  const credentials = JSON.parse(
    await readFile(path.join(worldDir, "credentials.json"), "utf8")
  ) as {
    alternatives: Array<{ schemes: Array<{ value: string }> }>;
  };
  const value = credentials.alternatives[0]?.schemes[0]?.value;
  if (typeof value !== "string") {
    throw new Error("The world wrote no bearer credential.");
  }
  return value;
}

interface StartedWorld {
  readonly baseUrl: string;
  readonly bearer: string;
  readonly worldDir: string;
  readonly evidenceDir: string;
  readonly packDir: string;
  readonly stop: () => Promise<number>;
}

/** Serve the webclip scenario from a disposable copy of the pack. */
async function startSourceWorld(
  cwd: string,
  seed: string
): Promise<StartedWorld> {
  const packDir = path.join(cwd, "pack");
  await cp(webclipRoot, packDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`)
  });
  await symlink(
    path.join(webclipRoot, "node_modules"),
    path.join(packDir, "node_modules"),
    "dir"
  );
  const runId = "source-world";
  const io = new MemoryIo();
  const guard = new TerminationGuard();
  const pending = main(
    [
      "serve",
      packDir,
      "--mode",
      "scenario",
      "--port",
      "0",
      "--run-id",
      runId,
      "--run-seed",
      seed
    ],
    io,
    { cwd, guard }
  );
  const readiness = await awaitReadiness(io);
  const worldDir = path.join(cwd, ".oal", "control", "serve", runId);
  const evidenceDir = path.join(cwd, ".oal", "runs", runId);
  return {
    baseUrl: readiness.baseUrl,
    bearer: await bearerOf(worldDir),
    worldDir,
    evidenceDir,
    packDir,
    stop: async (): Promise<number> => {
      guard.handle("SIGINT");
      return pending;
    }
  };
}

/** Start one forked world from a checkpoint directory. */
async function startFork(
  cwd: string,
  checkpointDir: string,
  outDir: string
): Promise<StartedWorld & { readonly pending: Promise<number> }> {
  const io = new MemoryIo();
  const guard = new TerminationGuard();
  const pending = main(
    ["world", "fork", checkpointDir, "--out", outDir, "--port", "0"],
    io,
    { cwd, guard }
  );
  const readiness = await awaitReadiness(io);
  expect(readiness["mode"]).toBe("fork");
  return {
    baseUrl: readiness.baseUrl,
    bearer: await bearerOf(outDir),
    worldDir: outDir,
    evidenceDir: path.join(outDir, "evidence"),
    packDir: checkpointDir,
    pending,
    stop: async (): Promise<number> => {
      guard.handle("SIGINT");
      return pending;
    }
  };
}

/** One authorized JSON request against a world. */
async function call(
  world: { readonly baseUrl: string; readonly bearer: string },
  method: string,
  target: string,
  body?: Json
): Promise<Response> {
  return fetch(`${world.baseUrl}${target}`, {
    method,
    headers: {
      authorization: `Bearer ${world.bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

const SEED = "d".repeat(64);

/** The draw sequence the render operation consumes, one per render. */
function drawAt(index: number): number {
  const prng = createNamespacePrng(SEED, "world:services");
  let value = 0;
  for (let i = 0; i <= index; i += 1) {
    value = 100 + prng.nextInt(900);
  }
  return value;
}

describe("oal world checkpoint and fork", () => {
  it("restores positions, replay, and isolation after the source is gone", async () => {
    const cwd = await newWorkspace("oal-world-fork-");
    const source = await startSourceWorld(cwd, SEED);
    const checkpointDir = path.join(cwd, "checkpoint-1");

    // Advance the world: one clip, one render. The render consumes
    // the first draw of the services stream.
    const created = await call(source, "POST", "/v1/clips", {
      url: "https://example.com/essay",
      format: "markdown"
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { id: string }).id).toBe("clip_00000001");
    const rendered = await call(
      source,
      "POST",
      "/v1/clips/clip_00000001/render"
    );
    expect(rendered.status).toBe(200);
    expect(
      ((await rendered.json()) as { duration_ms: number }).duration_ms
    ).toBe(drawAt(0));

    const checkpointIo = new MemoryIo();
    const checkpointCode = await main(
      [
        "world",
        "checkpoint",
        "--world",
        source.worldDir,
        "--out",
        checkpointDir
      ],
      checkpointIo,
      { cwd }
    );
    expect(checkpointCode).toBe(0);
    const checkpointAnswer = JSON.parse(
      checkpointIo.stdoutChunks.join("\n")
    ) as { status: string; result: { checkpoint_id: string } };
    expect(checkpointAnswer.status).toBe("ok");
    expect(checkpointAnswer.result.checkpoint_id).toBe("chk_00000001");

    // A synthetic replay entry rides the checkpoint payload: decrypt
    // with the checkpoint key, add the entry, reseal, and restate the
    // manifest digests. The fork must re-tag it under its own key.
    const keyBytes = Buffer.from(
      (
        await readFile(path.join(checkpointDir, "private", "key"), "utf8")
      ).trim(),
      "hex"
    );
    const sealedBody = await readFile(path.join(checkpointDir, "payload.bin"));
    const oldNonce = await readFile(path.join(checkpointDir, "payload.nonce"));
    const tag = sealedBody.subarray(sealedBody.length - 16);
    const body = sealedBody.subarray(0, sealedBody.length - 16);
    const opener = createDecipheriv("aes-256-gcm", keyBytes, oldNonce);
    opener.setAuthTag(tag);
    const checkpointDoc = JSON.parse(
      Buffer.concat([opener.update(body), opener.final()]).toString("utf8")
    ) as {
      idempotency: { entries: unknown[] };
      clock: { now_ms: number };
    };
    checkpointDoc.idempotency.entries.push({
      operation_key: "path:POST /v1/clips",
      principal_key: "participant-1",
      normalized_path: "/v1/clips",
      idempotency_key: "create-once",
      request_fingerprint: '{"url":"https://example.com/essay"}',
      created_sequence: 3,
      response: {
        status: 201,
        headers: {},
        body: { id: "clip_00000001" },
        logical_time: "2000-01-01T00:00:02.000Z"
      }
    });
    const newNonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyBytes, newNonce);
    const resealed = Buffer.concat([
      cipher.update(JSON.stringify(checkpointDoc), "utf8"),
      cipher.final(),
      cipher.getAuthTag()
    ]);
    await writeFile(path.join(checkpointDir, "payload.bin"), resealed);
    await writeFile(path.join(checkpointDir, "payload.nonce"), newNonce);
    const manifestPath = path.join(checkpointDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      payload_sha256: string;
      payload_bytes: number;
    };
    manifest.payload_sha256 = createHash("sha256")
      .update(resealed)
      .digest("hex");
    manifest.payload_bytes = resealed.length;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const checkpointClockMs = checkpointDoc.clock.now_ms;
    const sourceExit = await source.stop();
    expect(sourceExit).toBe(130);

    // The source process is closed and its working directory is gone;
    // the checkpoint carries everything the forks need.
    await rm(source.packDir, { recursive: true, force: true });

    // Fork one: the stream, the counter, and the clock continue, and
    // the replay entry answers under the new key.
    const fork1 = await startFork(cwd, checkpointDir, path.join(cwd, "fork-1"));
    try {
      const origin = JSON.parse(
        await readFile(path.join(fork1.evidenceDir, "origin.json"), "utf8")
      ) as JsonObject;
      expect(origin["parent_checkpoint_id"]).toBe("chk_00000001");
      expect(origin["virtual_time"]).toBe(
        new Date(checkpointClockMs).toISOString()
      );

      const renderedAgain = await call(
        fork1,
        "POST",
        "/v1/clips/clip_00000001/render"
      );
      expect(renderedAgain.status).toBe(200);
      expect(
        ((await renderedAgain.json()) as { duration_ms: number }).duration_ms
      ).toBe(drawAt(1));

      const next = await call(fork1, "POST", "/v1/clips", {
        url: "https://example.com/second",
        format: "markdown"
      });
      expect(((await next.json()) as { id: string }).id).toBe("clip_00000002");

      const removed = await call(fork1, "DELETE", "/v1/clips/clip_00000001");
      expect(removed.status).toBe(204);
    } finally {
      expect(await fork1.stop()).toBe(130);
    }
    const fork1State = JSON.parse(
      await readFile(path.join(fork1.evidenceDir, "state.final.json"), "utf8")
    ) as { state: { clips: Record<string, unknown> } };
    expect(Object.keys(fork1State.state.clips)).toEqual(["clip_00000002"]);

    // The replay entry rode the checkpoint into the fork: the row and
    // its plaintext identity sit in the fork's own database, sealed
    // and tagged under the fork's key.
    const fork1Db = new DatabaseSync(
      path.join(fork1.worldDir, "world.sqlite"),
      { readOnly: true }
    );
    try {
      const rows = fork1Db
        .prepare(
          `SELECT i.created_sequence AS created_sequence,
                  s.normalized_path AS normalized_path,
                  s.idempotency_key AS idempotency_key,
                  LENGTH(i.response_ciphertext) AS sealed_bytes
             FROM idempotency i
             JOIN idempotency_identity s
               ON s.operation_key = i.operation_key
              AND s.principal_key = i.principal_key
              AND s.normalized_path_sha256 = i.normalized_path_sha256
              AND s.idempotency_key_hmac = i.idempotency_key_hmac`
        )
        .all();
      expect(rows.length).toBe(1);
      const entry = rows[0] as {
        created_sequence: number;
        normalized_path: string;
        idempotency_key: string;
        sealed_bytes: number;
      };
      expect(entry.created_sequence).toBe(3);
      expect(entry.normalized_path).toBe("/v1/clips");
      expect(entry.idempotency_key).toBe("create-once");
      expect(entry.sealed_bytes).toBeGreaterThan(0);
    } finally {
      fork1Db.close();
    }

    // Fork two: independent of fork one. The deleted clip survives
    // here, and the same continuation applies.
    const fork2 = await startFork(cwd, checkpointDir, path.join(cwd, "fork-2"));
    try {
      const stillThere = await call(fork2, "GET", "/v1/clips/clip_00000001");
      expect(stillThere.status).toBe(200);
      const renderedTwice = await call(
        fork2,
        "POST",
        "/v1/clips/clip_00000001/render"
      );
      expect(
        ((await renderedTwice.json()) as { duration_ms: number }).duration_ms
      ).toBe(drawAt(1));
    } finally {
      expect(await fork2.stop()).toBe(130);
    }
  }, 180_000);

  it("refuses corrupt metadata before the listener starts", async () => {
    const cwd = await newWorkspace("oal-world-corrupt-");
    const source = await startSourceWorld(cwd, SEED);
    await call(source, "POST", "/v1/clips", {
      url: "https://example.com/a",
      format: "markdown"
    });
    const checkpointDir = path.join(cwd, "checkpoint-corrupt");
    const io = new MemoryIo();
    await main(
      [
        "world",
        "checkpoint",
        "--world",
        source.worldDir,
        "--out",
        checkpointDir
      ],
      io,
      { cwd }
    );
    await source.stop();

    const manifestPath = path.join(checkpointDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      payload_sha256: string;
    };
    manifest.payload_sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const forkIo = new MemoryIo();
    const code = await main(
      [
        "world",
        "fork",
        checkpointDir,
        "--out",
        path.join(cwd, "fork-corrupt"),
        "--port",
        "0"
      ],
      forkIo,
      { cwd }
    );
    expect(code).toBe(4);
    expect(forkIo.stderrText()).toContain("OAL-CHECKPOINT-INTEGRITY");
  }, 120_000);

  it.each(["modified", "missing", "added", "symlink", "legacy"])(
    "refuses frozen tree damage (%s) before the listener starts",
    async (change) => {
      const cwd = await newWorkspace("oal-world-tree-");
      const source = await startSourceWorld(cwd, SEED);
      const checkpointDir = path.join(cwd, "checkpoint");
      try {
        expect(
          await main(
            [
              "world",
              "checkpoint",
              "--world",
              source.worldDir,
              "--out",
              checkpointDir
            ],
            new MemoryIo(),
            { cwd }
          )
        ).toBe(0);
      } finally {
        await source.stop();
      }
      const frozenRoot = path.join(checkpointDir, "frozen");
      const files = await readdir(path.join(frozenRoot, "packages"), {
        recursive: true
      });
      const helper = files.find((file) => file.endsWith(".ts"));
      expect(helper).toBeDefined();
      const dependency = path.join(frozenRoot, "packages", helper as string);
      if (change === "modified") {
        await writeFile(dependency, "throw new Error('changed dependency');\n");
      } else if (change === "missing") {
        await rm(dependency);
      } else if (change === "added") {
        await writeFile(
          path.join(frozenRoot, "extra.ts"),
          "export const changed = true;"
        );
      } else if (change === "symlink") {
        const replacement = path.join(cwd, "replacement.ts");
        await cp(dependency, replacement);
        await rm(dependency);
        await symlink(replacement, dependency);
      } else {
        const manifestPath = path.join(checkpointDir, "manifest.json");
        const manifest = JSON.parse(
          await readFile(manifestPath, "utf8")
        ) as JsonObject;
        manifest["schema_version"] = 1;
        delete manifest["frozen_tree_sha256"];
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
      const forkIo = new MemoryIo();
      expect(
        await main(
          [
            "world",
            "fork",
            checkpointDir,
            "--out",
            path.join(cwd, "fork"),
            "--port",
            "0"
          ],
          forkIo,
          { cwd }
        )
      ).toBe(4);
      expect(forkIo.stderrText()).toContain(
        change === "legacy"
          ? "OAL-CHECKPOINT-INCOMPATIBLE"
          : "OAL-CHECKPOINT-INTEGRITY"
      );
      expect(forkIo.stdoutChunks).toEqual([]);
    }
  );

  it("refuses a checkpoint without its private key", async () => {
    const cwd = await newWorkspace("oal-world-key-");
    const source = await startSourceWorld(cwd, SEED);
    const checkpointDir = path.join(cwd, "checkpoint-key");
    const io = new MemoryIo();
    await main(
      [
        "world",
        "checkpoint",
        "--world",
        source.worldDir,
        "--out",
        checkpointDir
      ],
      io,
      { cwd }
    );
    await source.stop();
    await rm(path.join(checkpointDir, "private", "key"), { force: true });

    const forkIo = new MemoryIo();
    const code = await main(
      [
        "world",
        "fork",
        checkpointDir,
        "--out",
        path.join(cwd, "fork-key"),
        "--port",
        "0"
      ],
      forkIo,
      { cwd }
    );
    expect(code).toBe(4);
    expect(forkIo.stderrText()).toContain("OAL-CHECKPOINT-INCOMPLETE");
  }, 120_000);

  it("refuses a checkpoint with a missing blob", async () => {
    const cwd = await newWorkspace("oal-world-blob-");
    // A synthetic checkpoint that references one blob: the reference
    // exists, the bytes do not.
    const checkpointDir = path.join(cwd, "checkpoint-blob");
    const { buildCheckpointDocument, DeterministicPrng } = await import(
      "@oal/state-store"
    );
    const document = buildCheckpointDocument({
      checkpoint_id: "chk_missing_blob",
      world: { world_id: "w", generation: 1, origin_checkpoint_id: null },
      state: {
        state_schema_version: 1,
        revision: 0,
        logical_time: "2000-01-01T00:00:00.000Z",
        state: {}
      },
      services: {
        clock: { now_ms: 0, tick_ms: 1 },
        ids: { positions: {} },
        random: [
          {
            namespace: "world:services",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        ],
        faults: {
          counters: {},
          random: {
            namespace: "faults",
            algorithm: DeterministicPrng.ALGORITHM,
            state: "0".repeat(16)
          }
        }
      },
      idempotency: [],
      blobs: [
        {
          blob_id: "blob_missing",
          sha256: "1".repeat(64),
          secret_hmac: null,
          bytes: 4,
          media_type: "text/plain",
          relative_path: "blob_missing"
        }
      ],
      frozen: {
        pack_id: "webclip",
        pack_sha256: "2".repeat(64),
        scenario_id: "baseline",
        seed: SEED,
        behavior_sha256: createHash("sha256")
          .update(
            await readFile(path.join(webclipRoot, "behavior", "index.ts"))
          )
          .digest("hex"),
        behavior_closure_identity: "4".repeat(64),
        runtime_name: "@oal/environment",
        contract_semantic_sha256: "5".repeat(64),
        contract_execution_sha256: "6".repeat(64)
      }
    });
    const blobSource = path.join(cwd, "blob-source");
    await mkdir(blobSource, { recursive: true });
    await writeFile(path.join(blobSource, "blob_missing"), "abcd");
    const frozenRoot = path.join(cwd, "frozen-fixture");
    await mkdir(path.join(frozenRoot, "behavior"), { recursive: true });
    await cp(
      path.join(webclipRoot, "behavior/index.ts"),
      path.join(frozenRoot, "behavior/index.ts")
    );
    const { writeCheckpointDirectory } = await import("@oal/environment");
    await writeCheckpointDirectory({
      directory: checkpointDir,
      document,
      contractIr: { schema_version: 1 } as Json,
      blobSourceRoot: blobSource,
      frozenSourceRoot: frozenRoot,
      frozenEntryPath: "behavior/index.ts",
      createdAt: "2026-10-10T00:00:00.000Z"
    });
    await rm(path.join(checkpointDir, "blobs", "blob_missing"), {
      force: true
    });

    const forkIo = new MemoryIo();
    const code = await main(
      [
        "world",
        "fork",
        checkpointDir,
        "--out",
        path.join(cwd, "fork-blob"),
        "--port",
        "0"
      ],
      forkIo,
      { cwd }
    );
    expect(code).toBe(4);
    expect(forkIo.stderrText()).toContain("OAL-CHECKPOINT-INCOMPLETE");
  }, 60_000);

  it("refuses an interrupted write with no final directory", async () => {
    const cwd = await newWorkspace("oal-world-staging-");
    const checkpointDir = path.join(cwd, "checkpoint-staged");
    await mkdir(`${checkpointDir}.staging-12345`, { recursive: true });
    await writeFile(
      path.join(`${checkpointDir}.staging-12345`, "manifest.json"),
      "{ partial"
    );
    const io = new MemoryIo();
    const code = await main(
      [
        "world",
        "fork",
        checkpointDir,
        "--out",
        path.join(cwd, "fork-staged"),
        "--port",
        "0"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(4);
    expect(io.stderrText()).toContain("OAL-CHECKPOINT-INCOMPLETE");
  }, 30_000);
});
