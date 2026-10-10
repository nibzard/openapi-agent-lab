/**
 * External authoring template tests (specification section 48.8,
 * plan SE-P6-02). The template pack under tests/fixtures/external-demo
 * carries one transition, semantic events, a corpus with a reset, an
 * eval with a rubric, and a fidelity declaration. These checks drive
 * the full public path: validate, corpus, serve with checkpoint and
 * fork, the scripted participant, and the detection of a broken
 * transition through the corpus.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { JsonObject } from "@oal/core";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../tests/fixtures/external-demo"
);

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

/** One authorized JSON request against a world. */
async function call(
  world: { readonly baseUrl: string; readonly bearer: string },
  method: string,
  target: string,
  body?: unknown
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

describe("the external authoring template", () => {
  it("validates as a pack", async () => {
    const io = new MemoryIo();
    const code = await main(["pack", "validate", fixtureRoot], io, {
      cwd: await newWorkspace("oal-demo-validate-")
    });
    expect(code).toBe(0);
    expect(io.stdoutChunks.join("")).toContain("pack: external-demo");
  }, 60_000);

  it("executes its corpus, including the reset control", async () => {
    const cwd = await newWorkspace("oal-demo-corpus-");
    const out = path.join(cwd, "report.json");
    const io = new MemoryIo();
    const code = await main(
      ["corpus", "run", fixtureRoot, "--corpus", "demo-core", "--out", out],
      io,
      { cwd }
    );
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(out, "utf8")) as JsonObject;
    expect(report["summary"]).toEqual({
      passed: 4,
      failed: 0,
      skipped: 0,
      error: 0
    });
  }, 180_000);

  it("serves, checkpoints, and forks the template world", async () => {
    const cwd = await newWorkspace("oal-demo-fork-");
    const runId = "demo-source";
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending = main(
      [
        "serve",
        fixtureRoot,
        "--mode",
        "scenario",
        "--port",
        "0",
        "--run-id",
        runId,
        "--run-seed",
        "a".repeat(64)
      ],
      io,
      { cwd, guard }
    );
    const readiness = await awaitReadiness(io);
    const worldDir = path.join(cwd, ".oal", "control", "serve", runId);
    const source = {
      baseUrl: readiness.baseUrl,
      bearer: await bearerOf(worldDir)
    };

    // Advance the world: one counter, one transition.
    const created = await call(source, "POST", "/counters", { name: "alpha" });
    expect(created.status).toBe(201);
    const incremented = await call(source, "POST", "/counters/alpha/increment");
    expect(incremented.status).toBe(200);
    expect(((await incremented.json()) as { value: number }).value).toBe(1);

    const checkpointDir = path.join(cwd, "checkpoint-1");
    const checkpointIo = new MemoryIo();
    const checkpointCode = await main(
      ["world", "checkpoint", "--world", worldDir, "--out", checkpointDir],
      checkpointIo,
      { cwd }
    );
    expect(checkpointCode).toBe(0);

    // Stop the source; the fork must stand alone.
    guard.handle("SIGINT");
    await pending;

    const forkDir = path.join(cwd, "fork-1");
    const forkIo = new MemoryIo();
    const forkGuard = new TerminationGuard();
    const forkPending = main(
      ["world", "fork", checkpointDir, "--out", forkDir, "--port", "0"],
      forkIo,
      { cwd, guard: forkGuard }
    );
    const forkReadiness = await awaitReadiness(forkIo);
    expect(forkReadiness["mode"]).toBe("fork");
    const fork = {
      baseUrl: forkReadiness.baseUrl,
      bearer: await bearerOf(forkDir)
    };

    // The fork restored the transition: alpha reads one, and the
    // transition continues from there.
    const read = await call(fork, "GET", "/counters/alpha");
    expect(read.status).toBe(200);
    expect(((await read.json()) as { value: number }).value).toBe(1);
    const again = await call(fork, "POST", "/counters/alpha/increment");
    expect(((await again.json()) as { value: number }).value).toBe(2);

    forkGuard.handle("SIGINT");
    await forkPending;
  }, 180_000);

  it("runs the scripted participant through the template eval", async () => {
    const cwd = await newWorkspace("oal-demo-run-");
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        fixtureRoot,
        "--eval",
        "smoke",
        "--agent",
        "mock-agent",
        "--agent-script",
        path.join(fixtureRoot, "evals", "smoke", "mock-participant.json"),
        "--batch",
        "demo-smoke",
        "--format",
        "json"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(0);
    const summary = JSON.parse(io.stdoutChunks.join("\n")) as JsonObject;
    expect(summary["status"]).not.toBe("failed");
  }, 180_000);

  it("fails the corpus when the transition is broken", async () => {
    const cwd = await newWorkspace("oal-demo-broken-");
    const packDir = path.join(cwd, "broken-pack");
    await cp(fixtureRoot, packDir, { recursive: true });
    // The copy lives outside the workspace, so the public packages
    // resolve through node_modules links, exactly as an external
    // author's installed dependencies would.
    const scoped = path.join(packDir, "node_modules", "@oal");
    await mkdir(scoped, { recursive: true });
    for (const name of ["behavior-runtime", "behavior-api"]) {
      await symlink(
        path.resolve(fixtureRoot, "..", "..", "..", "packages", name),
        path.join(scoped, name),
        "dir"
      );
    }
    const behaviorPath = path.join(packDir, "behavior", "index.ts");
    const behavior = await readFile(behaviorPath, "utf8");
    // Break the one transition: the value never moves.
    const broken = behavior.replace(
      "const next = counter.value + 1;",
      "const next = counter.value;"
    );
    expect(broken).not.toBe(behavior);
    await writeFile(behaviorPath, broken);

    const out = path.join(cwd, "report.json");
    const io = new MemoryIo();
    const code = await main(
      ["corpus", "run", packDir, "--corpus", "demo-core", "--out", out],
      io,
      { cwd }
    );
    expect(code).toBe(2);
    const report = JSON.parse(await readFile(out, "utf8")) as JsonObject;
    expect(report["summary"]).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
      error: 0
    });
    const cases = report["cases"] as JsonObject[];
    const failed = cases.find(
      (entry) => entry["id"] === "increment-transition"
    );
    expect(failed?.["status"]).toBe("failed");
    expect(failed?.["failure_class"]).toBe("assertion_failure");
  }, 180_000);
});
