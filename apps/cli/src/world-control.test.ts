/**
 * World reset and advance-time tests (specification sections 48.3
 * and 48.4). A queued data request finishes before a reset; the
 * reset recreates the declared baseline state, clock, counters, and
 * random stream while evidence and control results survive; a
 * retried control id replays instead of resetting twice; time
 * advances monotonically without touching the revision and rejects
 * overflow; a stale generation refuses.
 */

import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
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

async function awaitReadiness(
  io: MemoryIo,
  timeoutMs = 30_000
): Promise<JsonObject & { readonly baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunk = io.stdoutChunks[0];
    if (chunk !== undefined) {
      try {
        return JSON.parse(chunk) as JsonObject & {
          readonly baseUrl: string;
        };
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
  readonly control: (
    method: string,
    target: string,
    body?: Json
  ) => Promise<{
    status: number;
    body: JsonObject;
  }>;
  readonly stop: () => Promise<number>;
}

/** Serve the webclip scenario with an operator control client. */
async function startWorld(cwd: string, seed: string): Promise<StartedWorld> {
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
  const runId = "control-world";
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
  const operatorCredential = (
    await readFile(
      path.join(worldDir, "operator", "operator-credential"),
      "utf8"
    )
  ).trim();
  const socketPath = path.join(worldDir, "operator", "control.sock");
  const control = (
    method: string,
    target: string,
    body?: Json
  ): Promise<{ status: number; body: JsonObject }> =>
    new Promise((resolve, reject) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const outgoing = request(
        {
          socketPath,
          path: target,
          method,
          headers: {
            authorization: `Bearer ${operatorCredential}`,
            ...(text.length === 0
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(text).toString(10)
                })
          }
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(
                Buffer.concat(chunks).toString("utf8")
              ) as JsonObject
            });
          });
        }
      );
      outgoing.on("error", reject);
      if (text.length > 0) {
        outgoing.write(text);
      }
      outgoing.end();
    });
  return {
    baseUrl: readiness.baseUrl,
    bearer: await bearerOf(worldDir),
    worldDir,
    evidenceDir,
    control,
    stop: async (): Promise<number> => {
      guard.handle("SIGINT");
      return pending;
    }
  };
}

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

const SEED = "e".repeat(64);

/** The draw sequence the render operation consumes, one per render. */
function drawAt(index: number): number {
  const prng = createNamespacePrng(SEED, "world:services");
  let value = 0;
  for (let i = 0; i <= index; i += 1) {
    value = 100 + prng.nextInt(900);
  }
  return value;
}

/** The generation and revision one world reports. */
async function generationOf(
  world: StartedWorld
): Promise<{ generation: number; revision: number; requests: number }> {
  const view = await world.control("GET", "/v1/world");
  const result = view.body["result"] as JsonObject;
  return {
    generation: Number(result["generation"]),
    revision: Number(result["revision"]),
    requests: Number(result["request_count"])
  };
}

describe("oal world reset and advance-time", () => {
  it("finishes queued data before reset and restores the baseline", async () => {
    const cwd = await newWorkspace("oal-world-reset-");
    const world = await startWorld(cwd, SEED);

    // A data request queued before the reset finishes first: its
    // response and its evidence row survive the reset.
    const created = await call(world, "POST", "/v1/clips", {
      url: "https://example.com/essay",
      format: "markdown"
    });
    expect(created.status).toBe(201);
    const before = await generationOf(world);
    expect(before.generation).toBe(1);
    expect(before.requests).toBeGreaterThanOrEqual(1);

    const reset = await world.control("POST", "/v1/reset", {
      control_id: "reset-first",
      expect_generation: 1
    });
    expect(reset.status).toBe(200);
    expect((reset.body["result"] as JsonObject)["generation"]).toBe(2);

    // The baseline: no clips, the counters and the stream restart.
    const gone = await call(world, "GET", "/v1/clips/clip_00000001");
    expect(gone.status).toBe(404);
    const list = await call(world, "GET", "/v1/clips?limit=10");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);

    // Evidence and control results survive the generation change.
    const after = await generationOf(world);
    expect(after.generation).toBe(2);
    expect(after.requests).toBeGreaterThanOrEqual(before.requests);

    // A retried control id replays; it does not reset twice.
    const retried = await world.control("POST", "/v1/reset", {
      control_id: "reset-first",
      expect_generation: 1
    });
    expect(retried.status).toBe(200);
    expect((retried.body["result"] as JsonObject)["generation"]).toBe(2);
    expect((await generationOf(world)).generation).toBe(2);

    // A stale generation refuses; the current one resets again.
    const stale = await world.control("POST", "/v1/reset", {
      control_id: "reset-stale",
      expect_generation: 1
    });
    expect(stale.status).toBe(409);
    expect(
      ((stale.body["diagnostics"] as JsonObject[])[0] as JsonObject)["code"]
    ).toBe("OAL-WORLD-GENERATION-MISMATCH");
    const second = await world.control("POST", "/v1/reset", {
      control_id: "reset-second",
      expect_generation: 2
    });
    expect((second.body["result"] as JsonObject)["generation"]).toBe(3);

    // Baseline equivalence: the same operations after a reset draw
    // the same values a fresh world draws.
    const freshClip = await call(world, "POST", "/v1/clips", {
      url: "https://example.com/essay",
      format: "markdown"
    });
    expect(((await freshClip.json()) as { id: string }).id).toBe(
      "clip_00000001"
    );
    const freshRender = await call(
      world,
      "POST",
      "/v1/clips/clip_00000001/render"
    );
    expect(
      ((await freshRender.json()) as { duration_ms: number }).duration_ms
    ).toBe(drawAt(0));

    expect(await world.stop()).toBe(130);
    const resetState = JSON.parse(
      await readFile(path.join(world.evidenceDir, "state.final.json"), "utf8")
    ) as { state: JsonObject };

    // A fresh world with the same seed reaches the same domain state.
    const referenceDir = await newWorkspace("oal-world-reference-");
    const reference = await startWorld(referenceDir, SEED);
    await call(reference, "POST", "/v1/clips", {
      url: "https://example.com/essay",
      format: "markdown"
    });
    await call(reference, "POST", "/v1/clips/clip_00000001/render");
    expect(await reference.stop()).toBe(130);
    const referenceState = JSON.parse(
      await readFile(
        path.join(reference.evidenceDir, "state.final.json"),
        "utf8"
      )
    ) as { state: JsonObject };
    expect(resetState.state).toEqual(referenceState.state);
  }, 180_000);

  it("advances time monotonically without revision changes", async () => {
    const cwd = await newWorkspace("oal-world-advance-");
    const world = await startWorld(cwd, SEED);

    const before = await generationOf(world);
    const view = (await world.control("GET", "/v1/world")).body[
      "result"
    ] as JsonObject;

    // A zero advance keeps the time; a positive one moves it.
    const zero = await world.control("POST", "/v1/advance-time", {
      control_id: "advance-zero",
      expect_generation: 1,
      by_ms: 0
    });
    expect(zero.status).toBe(200);
    expect((zero.body["result"] as JsonObject)["virtual_time"]).toBe(
      view["virtual_time"]
    );

    const advanced = await world.control("POST", "/v1/advance-time", {
      control_id: "advance-five",
      expect_generation: 1,
      by_ms: 5
    });
    expect(advanced.status).toBe(200);
    const result = advanced.body["result"] as JsonObject;
    const moved = result["virtual_time"];
    const started = view["virtual_time"];
    if (typeof moved !== "string" || typeof started !== "string") {
      throw new Error("The advance result carries no virtual time.");
    }
    expect(moved).not.toBe(started);
    expect(new Date(moved).getTime()).toBe(new Date(started).getTime() + 5);

    // The revision does not move with the clock.
    const after = await generationOf(world);
    expect(after.revision).toBe(before.revision);

    // Overflow refuses, and the refusal replays for the same id.
    const overflow = await world.control("POST", "/v1/advance-time", {
      control_id: "advance-overflow",
      expect_generation: 1,
      by_ms: 253402300799999
    });
    expect(overflow.status).toBe(400);
    expect(
      ((overflow.body["diagnostics"] as JsonObject[])[0] as JsonObject)["code"]
    ).toBe("OAL-WORLD-TIME-OVERFLOW");
    const replayed = await world.control("POST", "/v1/advance-time", {
      control_id: "advance-overflow",
      expect_generation: 1,
      by_ms: 253402300799999
    });
    expect(replayed.status).toBe(400);
    expect((replayed.body["result"] as JsonObject)["order"]).toBe(
      (overflow.body["result"] as JsonObject)["order"]
    );

    // A stale generation still refuses after the advances.
    const stale = await world.control("POST", "/v1/advance-time", {
      control_id: "advance-stale",
      expect_generation: 2,
      by_ms: 1
    });
    expect(stale.status).toBe(409);

    expect(await world.stop()).toBe(130);
  }, 120_000);
});
