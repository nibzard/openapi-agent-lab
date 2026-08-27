import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  type ExitCode
} from "@oal/core";

import { main } from "./cli.ts";
import {
  buildManualCredentials,
  compileServeSource,
  credentialInstructionsOf,
  DEFAULT_SERVE_PORT,
  defaultServeRunId,
  deriveServeRunSeed,
  finalizeServeControl,
  serveRunIdentity,
  ServeCliCode,
  startServe
} from "./handlers/serve.ts";
import { MemoryIo } from "./io.ts";
import { TerminationGuard } from "./signals.ts";
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
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-serve-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

async function exists(target: string): Promise<boolean> {
  const stats = await stat(target).catch(() => null);
  return stats !== null;
}

/** A minimal unauthenticated contract with one supported operation. */
const BARE_CONTRACT = {
  openapi: "3.1.0",
  info: { title: "things", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

/** The same operation behind one required API key scheme. */
const SECURED_CONTRACT = {
  ...BARE_CONTRACT,
  info: { title: "secured things", version: "1.0.0" },
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", name: "x-things-key", in: "header" }
    }
  }
} as const;

/** Wait until the readiness record appears on stdout. */
async function awaitReadiness(
  io: MemoryIo,
  timeoutMs = 10_000
): Promise<Record<string, unknown> & { readonly baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunk = io.stdoutChunks[0];
    if (chunk !== undefined) {
      try {
        return JSON.parse(chunk) as Record<string, unknown> & {
          readonly baseUrl: string;
        };
      } catch {
        // The record is not complete yet; keep waiting.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `serve printed no readiness record: ${io.stdoutChunks.join("")}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

describe("defaultServeRunId", () => {
  it("derives a sortable identifier from one instant", () => {
    const at = new Date(Date.UTC(2026, 7, 27, 1, 2, 3));
    expect(defaultServeRunId(at)).toBe("manual-20260827-010203");
  });
});

describe("compileServeSource", () => {
  it("compiles a bare OpenAPI document", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(BARE_CONTRACT));
    const compiled = await compileServeSource(document, cwd, 10 * 1024 * 1024);
    expect(compiled.pack).toBeNull();
    expect(compiled.contract.operations).toHaveLength(1);
    expect(compiled.contract.operations[0]?.key).toBe("path:GET /things");
  });

  it("compiles the contract entrypoint of a pack", async () => {
    const pack = await loadSteelPack();
    const compiled = await compileServeSource(
      pack.root,
      pack.root,
      10 * 1024 * 1024
    );
    expect(compiled.pack?.root).toBe(pack.root);
    expect(compiled.contract.operations.length).toBeGreaterThan(0);
  });

  it("derives one run seed per contract and run identity", async () => {
    const pack = await loadSteelPack();
    const compiled = await compileServeSource(
      pack.root,
      pack.root,
      10 * 1024 * 1024
    );
    const first = deriveServeRunSeed(compiled.contract, "run-a");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveServeRunSeed(compiled.contract, "run-b")).not.toBe(first);
  });
});

describe("manual credentials", () => {
  it("builds one alternative per declared scheme, values excluded from help", async () => {
    const pack = await loadSteelPack();
    const compiled = await compileServeSource(
      pack.root,
      pack.root,
      10 * 1024 * 1024
    );
    const credentials = buildManualCredentials(
      compiled.contract,
      "run-auth",
      "http://127.0.0.1:4010",
      "a".repeat(64)
    );
    expect(credentials.run_id).toBe("run-auth");
    expect(credentials.base_url).toBe("http://127.0.0.1:4010");
    expect(credentials.alternatives.length).toBeGreaterThan(0);
    const alternative = credentials.alternatives[0];
    if (alternative === undefined) {
      throw new Error("The steel contract must declare one alternative.");
    }
    const scheme = alternative.schemes[0];
    if (scheme === undefined) {
      throw new Error("The alternative must name one scheme.");
    }
    expect(scheme.scheme).toBe("apiKey");
    expect(scheme.wire_name).toBe("steel-api-key");
    expect(scheme.environment).toBe("OAL_AUTH_APIKEY");
    expect(scheme.value).toMatch(/^[A-Za-z0-9_-]+$/);
    const instructions = credentialInstructionsOf(credentials).join("\n");
    expect(instructions).toContain("OAL_AUTH_APIKEY");
    expect(instructions).not.toContain(scheme.value);
  });
});

describe("oal serve", () => {
  it("refuses scenario mode with exit 4", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["serve", cwd, "--mode", "scenario"], io, { cwd });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ServeCliCode.ModeUnsupported);
  });

  it("refuses a resume of a directory with no control state", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["serve", cwd, "--resume", path.join(cwd, "old-run")],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ServeCliCode.ResumeAbsent);
  });

  it("refuses --resume combined with --run-id", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(
      ["serve", cwd, "--resume", path.join(cwd, "old"), "--run-id", "r1"],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain("mutually exclusive");
  });

  it("refuses a non-loopback host without the opt-in", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["serve", cwd, "--host", "0.0.0.0"], io, { cwd });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ServeCliCode.HostRefused);
  });

  it("refuses an unsafe run identifier", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["serve", cwd, "--run-id", "../escape"], io, {
      cwd
    });
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(ServeCliCode.RunIdUnsafe);
  });

  it("refuses an existing run directory", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(BARE_CONTRACT));
    const runDir = path.join(cwd, "taken");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "keep"), "");
    const io = new MemoryIo();
    const code = await main(["serve", document, "--run-dir", "taken"], io, {
      cwd
    });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain("already exists");
  });

  it("serves a bare contract on an ephemeral port and answers fetches", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(BARE_CONTRACT));
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending: Promise<ExitCode> = main(
      [
        "serve",
        document,
        "--port",
        "0",
        "--run-id",
        "bare-serve",
        "--run-seed",
        "b".repeat(64),
        "--format",
        "json"
      ],
      io,
      { cwd, guard }
    );
    let readiness:
      | (Record<string, unknown> & { readonly baseUrl: string })
      | null = null;
    try {
      readiness = await awaitReadiness(io);
      expect(readiness.status).toBe("ready");
      expect(readiness.mode).toBe("contract");
      expect(readiness.runId).toBe("bare-serve");
      expect(readiness.operationCount).toBe(1);
      expect(readiness.credentialsPath).toBeNull();
      const response = await fetch(`${readiness.baseUrl}/things`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Array.isArray(body["items"])).toBe(true);
      const unknown = await fetch(`${readiness.baseUrl}/nope`);
      expect(unknown.status).toBe(404);
      const problem = (await unknown.json()) as Record<string, unknown>;
      expect(problem["code"]).toBe("route_not_found");
    } finally {
      guard.handle("SIGINT");
    }
    const code = await pending;
    expect(code).toBe(130);
    const controlDir = path.join(cwd, ".oal", "serve", "bare-serve");
    expect(await exists(path.join(controlDir, "capability-report.json"))).toBe(
      true
    );
    expect(await exists(path.join(controlDir, "credentials.json"))).toBe(false);
    expect(io.stdoutChunks).toHaveLength(1);
  });

  it("serves a secured contract and enforces the declared credential", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(SECURED_CONTRACT));
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending: Promise<ExitCode> = main(
      [
        "serve",
        document,
        "--port",
        "0",
        "--run-id",
        "secured-serve",
        "--run-seed",
        "c".repeat(64),
        "--format",
        "json"
      ],
      io,
      { cwd, guard }
    );
    try {
      const readiness = await awaitReadiness(io);
      const credentialsPath = readiness.credentialsPath;
      expect(typeof credentialsPath).toBe("string");
      const file = await readFile(credentialsPath as string, "utf8");
      const credentials = JSON.parse(file) as {
        alternatives: Array<{
          schemes: Array<{
            environment: string;
            value: string;
            wire_name: string | null;
          }>;
        }>;
      };
      const scheme = credentials.alternatives[0]?.schemes[0];
      if (scheme === undefined) {
        throw new Error("The credentials file must hold one scheme.");
      }
      expect(scheme.environment).toBe("OAL_AUTH_APIKEY");
      const denied = await fetch(`${readiness.baseUrl}/things`);
      expect(denied.status).toBe(401);
      const headers: Record<string, string> = {};
      if (scheme.wire_name !== null) {
        headers[scheme.wire_name] = scheme.value;
      }
      const allowed = await fetch(`${readiness.baseUrl}/things`, { headers });
      expect(allowed.status).toBe(200);
      // The private file disappears once the operator interrupts.
      guard.handle("SIGINT");
      await pending;
      expect(await exists(credentialsPath as string)).toBe(false);
    } catch (error) {
      guard.handle("SIGINT");
      await pending.catch(() => undefined);
      throw error;
    }
  });

  it("writes the readiness record to --ready and keeps the default port", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(BARE_CONTRACT));
    const ready = path.join(cwd, "ready.json");
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending: Promise<ExitCode> = main(
      [
        "serve",
        document,
        "--port",
        "0",
        "--run-id",
        "ready-serve",
        "--ready",
        ready,
        "--format",
        "json"
      ],
      io,
      { cwd, guard }
    );
    try {
      await awaitReadiness(io);
      const record = JSON.parse(await readFile(ready, "utf8")) as Record<
        string,
        unknown
      >;
      expect(record["status"]).toBe("ready");
      expect(DEFAULT_SERVE_PORT).toBe(4010);
    } finally {
      guard.handle("SIGINT");
    }
    expect(await pending).toBe(130);
    expect(io.stderrText()).toContain("no authentication");
  });

  it("refuses an existing --ready target", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(BARE_CONTRACT));
    const ready = path.join(cwd, "ready.json");
    await writeFile(ready, "{}\n");
    const io = new MemoryIo();
    const code = await main(["serve", document, "--ready", ready], io, { cwd });
    expect(code).not.toBe(EXIT_OK);
    expect(io.stderrText()).toContain(ServeCliCode.ReadyStale);
  });
});

describe("oal serve --resume", () => {
  /**
   * Build the control state of one interrupted serve with the real
   * production path, then simulate the crash: the listener and the
   * state store close without the terminal marker, and the recorded
   * server pid names a process that already exited.
   */
  async function crashedServe(
    cwd: string,
    contract: unknown,
    runId: string
  ): Promise<{ readonly controlDir: string; readonly runSeed: string }> {
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(contract));
    const compiled = await compileServeSource(document, cwd, 10 * 1024 * 1024);
    const runSeed = "d".repeat(64);
    const controlDir = path.join(cwd, ".oal", "serve", runId);
    const session = await startServe({
      contract: compiled.contract,
      capabilityReport: compiled.capabilityReport,
      host: "127.0.0.1",
      port: 0,
      runId,
      runSeed,
      controlDir,
      credentialsOut: null,
      identity: serveRunIdentity(compiled.contract, runSeed),
      resumed: false
    });
    await session.handle.close();
    session.store.close();
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    await new Promise<void>((resolve) => {
      dead.on("exit", () => {
        resolve();
      });
    });
    await writeFile(
      path.join(controlDir, "SERVER.pid"),
      `${deadPid?.toString(10) ?? "1"}\n`
    );
    return { controlDir, runSeed };
  }

  it("resumes an interrupted serve with the same identity", async () => {
    const cwd = await newWorkspace();
    const { controlDir } = await crashedServe(cwd, BARE_CONTRACT, "resume-ok");
    const document = path.join(cwd, "openapi.json");
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending: Promise<ExitCode> = main(
      ["serve", document, "--resume", controlDir, "--port", "0"],
      io,
      { cwd, guard }
    );
    try {
      const readiness = await awaitReadiness(io);
      expect(readiness.runId).toBe("resume-ok");
      const response = await fetch(`${readiness.baseUrl}/things`);
      expect(response.status).toBe(200);
    } finally {
      guard.handle("SIGINT");
    }
    expect(await pending).toBe(130);
    expect(await exists(path.join(controlDir, "FINALIZED"))).toBe(true);
    expect(await exists(path.join(controlDir, "SERVER.pid"))).toBe(false);
  });

  it("refuses a resume after the contract changed", async () => {
    const cwd = await newWorkspace();
    const { controlDir } = await crashedServe(cwd, BARE_CONTRACT, "resume-mm");
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(SECURED_CONTRACT));
    const io = new MemoryIo();
    const code = await main(["serve", document, "--resume", controlDir], io, {
      cwd
    });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ServeCliCode.ResumeMismatch);
  });

  it("refuses a resume of a finalized serve", async () => {
    const cwd = await newWorkspace();
    const { controlDir } = await crashedServe(cwd, BARE_CONTRACT, "resume-fin");
    await finalizeServeControl(controlDir);
    const document = path.join(cwd, "openapi.json");
    const io = new MemoryIo();
    const code = await main(["serve", document, "--resume", controlDir], io, {
      cwd
    });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ServeCliCode.ResumeFinalized);
  });

  it("refuses a resume while the recorded server still runs", async () => {
    const cwd = await newWorkspace();
    const { controlDir } = await crashedServe(cwd, BARE_CONTRACT, "resume-use");
    await writeFile(
      path.join(controlDir, "SERVER.pid"),
      `${process.pid.toString(10)}\n`
    );
    const document = path.join(cwd, "openapi.json");
    const io = new MemoryIo();
    const code = await main(["serve", document, "--resume", controlDir], io, {
      cwd
    });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stderrText()).toContain(ServeCliCode.ResumeInUse);
  });

  it("writes the private control files with mode 0600", async () => {
    const cwd = await newWorkspace();
    const document = path.join(cwd, "openapi.json");
    await writeFile(document, JSON.stringify(SECURED_CONTRACT));
    const compiled = await compileServeSource(document, cwd, 10 * 1024 * 1024);
    const runSeed = "e".repeat(64);
    const controlDir = path.join(cwd, ".oal", "serve", "resume-mode");
    const session = await startServe({
      contract: compiled.contract,
      capabilityReport: compiled.capabilityReport,
      host: "127.0.0.1",
      port: 0,
      runId: "resume-mode",
      runSeed,
      controlDir,
      credentialsOut: null,
      identity: serveRunIdentity(compiled.contract, runSeed),
      resumed: false
    });
    try {
      const mode = (await stat(session.credentialsPath as string)).mode;
      expect(mode & 0o777).toBe(0o600);
      for (const marker of ["RUN_ID", "SERVER.pid"]) {
        const markerMode = (await stat(path.join(controlDir, marker))).mode;
        expect(markerMode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(session.credentialsPath as string, { force: true }).catch(
        () => undefined
      );
      await session.handle.close();
      session.store.close();
    }
  });
});
