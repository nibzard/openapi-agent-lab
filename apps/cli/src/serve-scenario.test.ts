/**
 * Scenario serving tests (specification sections 48.2 and 48.5). The
 * serve command serves a pack's scenario behavior over standalone
 * HTTP through the shared environment owner: a normal client
 * completes the clip lifecycle, the same seeded sequence through
 * serve and run leaves equivalent domain responses and state, and a
 * signal shutdown exports the lifecycle evidence and releases the
 * port and the behavior child.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Json, JsonObject } from "@oal/core";
import { deriveTrialSeed } from "@oal/state-store";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";
import { loadWebclipPack } from "../../../packages/testkit/src/index.ts";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-serve-scenario-"));
  scratch.push(cwd);
  return cwd;
}

/** Wait until the readiness record appears on stdout. */
async function awaitReadiness(
  io: MemoryIo,
  timeoutMs = 20_000
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
        `serve printed no readiness record: ${io.stdoutChunks.join(
          ""
        )} stderr: ${io.stderrText()}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** The bearer credential a serve wrote for its first alternative. */
async function bearerOf(controlDir: string): Promise<string> {
  const credentials = JSON.parse(
    await readFile(path.join(controlDir, "credentials.json"), "utf8")
  ) as {
    alternatives: Array<{
      schemes: Array<{ value: string }>;
    }>;
  };
  const value = credentials.alternatives[0]?.schemes[0]?.value;
  if (typeof value !== "string") {
    throw new Error("The serve wrote no bearer credential.");
  }
  return value;
}

interface StartedServe {
  readonly baseUrl: string;
  readonly bearer: string;
  readonly evidenceDir: string;
  readonly controlDir: string;
  readonly stop: () => Promise<number>;
}

/** Start one scenario serve and resolve when it is ready. */
async function startScenarioServe(
  cwd: string,
  options: { readonly port?: number; readonly runSeed?: string } = {}
): Promise<StartedServe> {
  const runId = "serve-scenario-test";
  const io = new MemoryIo();
  const guard = new TerminationGuard();
  const pending = main(
    [
      "serve",
      (await loadWebclipPack()).root,
      "--mode",
      "scenario",
      "--port",
      (options.port ?? 0).toString(10),
      "--run-id",
      runId,
      ...(options.runSeed === undefined ? [] : ["--run-seed", options.runSeed])
    ],
    io,
    { cwd, guard }
  );
  const readiness = await awaitReadiness(io);
  const controlDir = path.join(cwd, ".oal", "control", "serve", runId);
  const evidenceDir = path.join(cwd, ".oal", "runs", runId);
  return {
    baseUrl: readiness.baseUrl,
    bearer: await bearerOf(controlDir),
    evidenceDir,
    controlDir,
    stop: async (): Promise<number> => {
      guard.handle("SIGINT");
      return pending;
    }
  };
}

/** One authorized JSON request against the served world. */
async function call(
  serve: StartedServe,
  method: string,
  target: string,
  body?: Json
): Promise<Response> {
  return fetch(`${serve.baseUrl}${target}`, {
    method,
    headers: {
      authorization: `Bearer ${serve.bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("oal serve --mode scenario", () => {
  it("serves the clip lifecycle to a normal HTTP client", async () => {
    const cwd = await newWorkspace();
    const serve = await startScenarioServe(cwd);
    let code = -1;
    try {
      const first = await call(serve, "POST", "/v1/clips", {
        url: "https://example.com/essay",
        format: "markdown"
      });
      expect(first.status).toBe(201);
      const firstClip = (await first.json()) as { id: string };
      expect(firstClip.id).toBe("clip_00000001");

      const second = await call(serve, "POST", "/v1/clips", {
        url: "https://example.com/dashboard",
        format: "image"
      });
      const secondClip = (await second.json()) as { id: string };
      expect(secondClip.id).toBe("clip_00000002");

      const list = await call(serve, "GET", "/v1/clips?limit=10");
      const listed = (await list.json()) as {
        items: Array<{ id: string }>;
      };
      expect(list.status).toBe(200);
      expect(listed.items.map((item) => item.id).sort()).toEqual([
        "clip_00000001",
        "clip_00000002"
      ]);

      const render = await call(
        serve,
        "POST",
        "/v1/clips/clip_00000001/render"
      );
      expect(render.status).toBe(200);

      const extract = await call(
        serve,
        "POST",
        "/v1/clips/clip_00000001/extract"
      );
      const extracted = (await extract.json()) as { word_count: number };
      expect(extract.status).toBe(200);
      expect(extracted.word_count).toBeGreaterThan(0);

      const deleted = await call(serve, "DELETE", "/v1/clips/clip_00000001");
      expect(deleted.status).toBe(204);

      // A deleted clip answers the domain 404 on every later read,
      // not a framework refusal.
      const reread = await call(serve, "GET", "/v1/clips/clip_00000001");
      expect(reread.status).toBe(404);
    } finally {
      code = await serve.stop();
    }
    expect(code).toBe(130);
  }, 60_000);

  it("matches the run path on the same seeded sequence", async () => {
    const serveCwd = await newWorkspace();
    const runCwd = await newWorkspace();
    // One seed for both paths: the run derives its trial seed from
    // the cohort seed this test pins, and the serve takes that
    // derived seed verbatim, so both worlds run identical streams
    // (section 48.5 equivalence).
    const batchId = "serve-run-equivalence";
    const runSeed = "c".repeat(64);
    const trialSeed = deriveTrialSeed(runSeed, {
      index: 0,
      id: `${batchId}-run-01`
    });

    const serve = await startScenarioServe(serveCwd, {
      runSeed: trialSeed
    });
    try {
      await call(serve, "POST", "/v1/clips", {
        url: "https://example.com/essay",
        format: "markdown"
      });
      await call(serve, "POST", "/v1/clips", {
        url: "https://example.com/dashboard",
        format: "image"
      });
      await call(serve, "GET", "/v1/clips?limit=10");
      await call(serve, "POST", "/v1/clips/clip_00000001/render");
      await call(serve, "POST", "/v1/clips/clip_00000001/extract");
      await call(serve, "DELETE", "/v1/clips/clip_00000001");
      await call(serve, "GET", "/v1/clips/clip_00000001");
    } finally {
      await serve.stop();
    }

    // The same sequence through the run path, driven by a script with
    // the same requests in the same order.
    const pack = await loadWebclipPack();
    const script = {
      requests: [
        {
          path: "/v1/clips",
          method: "POST",
          body: { url: "https://example.com/essay", format: "markdown" },
          expectStatus: 201,
          capture: { body: { markdownId: "id" } },
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips",
          method: "POST",
          body: { url: "https://example.com/dashboard", format: "image" },
          expectStatus: 201,
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips?limit=10",
          method: "GET",
          expectStatus: 200,
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips/{{markdownId}}/render",
          method: "POST",
          expectStatus: 200,
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips/{{markdownId}}/extract",
          method: "POST",
          expectStatus: 200,
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips/{{markdownId}}",
          method: "DELETE",
          expectStatus: 204,
          credentialName: "OAL_AUTH_BEARER"
        },
        {
          path: "/v1/clips/{{markdownId}}",
          method: "GET",
          expectStatus: 404,
          credentialName: "OAL_AUTH_BEARER"
        }
      ],
      finalReport: { done: true }
    };
    const scriptPath = path.join(runCwd, "sequence.json");
    await writeFile(scriptPath, JSON.stringify(script), "utf8");
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        pack.root,
        "--eval",
        "site-errand",
        "--agent",
        "mock-agent",
        "--agent-script",
        scriptPath,
        "--batch",
        batchId,
        "--cohort-seed",
        runSeed,
        "--format",
        "json"
      ],
      io,
      { cwd: runCwd }
    );
    expect(code).toBe(5);
    const summary = JSON.parse(io.stdoutChunks.join("\n")) as {
      dispositions: Record<string, number>;
    };
    // The script finished its requests and the trial completed; the
    // evaluation threshold still fails it because the script's report
    // is not the errand's scored result. The domain trail is what
    // must match.
    expect(summary.dispositions).toMatchObject({ completed: 1 });

    const servedState = JSON.parse(
      await readFile(path.join(serve.evidenceDir, "state.final.json"), "utf8")
    ) as { state: JsonObject; revision: number };
    const runState = JSON.parse(
      await readFile(
        path.join(
          runCwd,
          ".oal",
          "runs",
          batchId,
          "trials",
          `${batchId}-run-01`,
          "state.final.json"
        ),
        "utf8"
      )
    ) as { state: JsonObject; revision: number };
    expect(servedState.revision).toBe(runState.revision);
    expect(servedState.state).toEqual(runState.state);

    const servedEvents = (
      await readFile(
        path.join(serve.evidenceDir, "semantic-events.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; payload: Json });
    const runEvents = (
      await readFile(
        path.join(
          runCwd,
          ".oal",
          "runs",
          batchId,
          "trials",
          `${batchId}-run-01`,
          "semantic-events.redacted.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; payload: Json });
    expect(servedEvents.map((event) => event.name)).toEqual(
      runEvents.map((event) => event.name)
    );
    expect(servedEvents.map((event) => event.payload)).toEqual(
      runEvents.map((event) => event.payload)
    );
  }, 90_000);

  it("releases the port and the child on shutdown", async () => {
    const cwd = await newWorkspace();
    const port = 4579;
    const serve = await startScenarioServe(cwd, { port });
    const code = await serve.stop();
    expect(code).toBe(130);

    // Lifecycle evidence: the environment manifest, the final state,
    // and the committed semantic events outlive the process.
    const manifest = JSON.parse(
      await readFile(path.join(serve.evidenceDir, "environment.json"), "utf8")
    ) as JsonObject;
    expect(manifest["mode"] ?? manifest["kind"]).toBeDefined();
    expect(manifest["world_id"]).toBe("serve-scenario-test");
    await expect(
      readFile(path.join(serve.evidenceDir, "state.final.json"), "utf8")
    ).resolves.toContain("revision");

    // The port is free again.
    const rebound = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => {
        resolve(false);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
    expect(rebound).toBe(true);

    // The finalized control directory refuses a resume.
    const io = new MemoryIo();
    const resumeCode = await main(
      [
        "serve",
        (await loadWebclipPack()).root,
        "--mode",
        "scenario",
        "--resume",
        serve.controlDir
      ],
      io,
      { cwd }
    );
    expect(resumeCode).toBe(4);
    expect(io.stderrText()).toContain("OAL-SERVE-RESUME-FINALIZED");
  }, 60_000);
});
