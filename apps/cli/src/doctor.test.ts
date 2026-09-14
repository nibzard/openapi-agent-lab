import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProbe } from "@oal/agent-adapter";

import { EXIT_INFRASTRUCTURE, EXIT_OK, EXIT_UNSUPPORTED } from "@oal/core";
import type { DoctorReport } from "@oal/report";

import { main } from "./cli.ts";
import {
  adapterResultOf,
  artifactProbe,
  checkCodexCredential,
  doctorExitCode,
  doctorLines,
  featuresOfProbe,
  probeLoopback,
  schemaFilesOf,
  workspacePackageVersions
} from "./handlers/doctor.ts";
import { MemoryIo } from "./io.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-doctor-cli-"));
  scratchDirectories.push(cwd);
  return cwd;
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

/** Terminal check line of one stable check id. */
function lineOf(text: string, id: string): string {
  const found = text
    .split("\n")
    .find((entry) => entry.includes(` ${id} `) || entry.endsWith(` ${id}`));
  if (found === undefined) {
    throw new Error(`Test setup: no doctor line for "${id}".`);
  }
  return found;
}

/** One adapter probe result with every capability declared present. */
function fakeProbe(overrides: Partial<AgentProbe> = {}): AgentProbe {
  return {
    status: "available",
    version: "1.2.3",
    capabilities: {
      nativeSystemPrompt: true,
      nativeOutputSchema: false,
      mcp: true,
      machineReadableTranscript: false,
      usageReporting: true,
      separateToolEnvironment: false,
      enforceableToolNetworkPolicy: true,
      sandboxModes: ["read-only"]
    },
    launcherEnvironmentNames: [],
    environmentSeparation: "enforced",
    toolNetworkPolicy: "enforced",
    ...overrides
  };
}

describe("doctor helpers", () => {
  it("lists the present adapter capabilities as features", () => {
    expect(featuresOfProbe(fakeProbe())).toEqual([
      "nativeSystemPrompt",
      "mcp",
      "usageReporting",
      "enforceableToolNetworkPolicy",
      "sandbox:read-only"
    ]);
  });

  it("maps a probe result onto the doctor adapter result", () => {
    const ok = adapterResultOf(fakeProbe());
    expect(ok.ok).toBe(true);
    expect(ok.detail).toBe("1.2.3");
    expect(ok.features).toContain("mcp");
    expect(ok.features).toContain("sandbox:read-only");
    const failed = adapterResultOf(
      fakeProbe({
        status: "unavailable",
        version: null,
        error: "executable missing"
      })
    );
    expect(failed.ok).toBe(false);
    expect(failed.detail).toBe("executable missing");
  });

  it("renders one aligned line per check plus a summary", () => {
    const report: DoctorReport = {
      schema_version: 1,
      kind: "DoctorReport",
      status: "warn",
      counts: { pass: 1, warn: 1, fail: 0 },
      checks: [
        { id: "runtime.node", status: "pass", message: "Node matches." },
        { id: "store.sqlite", status: "warn", message: "Store is missing." }
      ]
    };
    expect(doctorLines(report)).toEqual([
      "pass   runtime.node  Node matches.",
      "warn   store.sqlite  Store is missing.",
      "doctor: 1 pass, 1 warn, 0 fail"
    ]);
  });

  it("maps only a failed report to the infrastructure status", () => {
    const report: DoctorReport = {
      schema_version: 1,
      kind: "DoctorReport",
      status: "fail",
      counts: { pass: 0, warn: 0, fail: 1 },
      checks: []
    };
    expect(doctorExitCode(report)).toBe(EXIT_INFRASTRUCTURE);
    expect(doctorExitCode({ ...report, status: "warn" })).toBe(EXIT_OK);
  });

  it("binds a loopback ephemeral port", async () => {
    const result = await probeLoopback();
    expect(result.supported).toBe(true);
    expect(result.detail).toMatch(/^bound 127\.0\.0\.1:[1-9][0-9]*$/);
  });

  it("reads the workspace package versions of the installed links", async () => {
    const versions = await workspacePackageVersions();
    expect(versions["@oal/core"]).toBeDefined();
    expect(versions["@oal/report"]).toBeDefined();
  });

  it("loads the pack, eval, and study schema files", async () => {
    const files = await schemaFilesOf();
    expect(files.map((file) => file.id)).toEqual([
      "pack",
      "eval",
      "study-protocol"
    ]);
    for (const file of files) {
      expect(file.load()).toBeInstanceOf(Object);
    }
  });

  it("cleans the artifact probe file and the directory it created", async () => {
    const cwd = await newWorkspace();
    const directory = path.join(cwd, "fresh", ".oal");
    const result = await artifactProbe(directory).write();
    expect(result).toEqual({ ok: true, error: null });
    expect(await exists(directory)).toBe(false);
  });
});

describe("codex credential check", () => {
  const CODEX_CHECK_ID = "adapter.codex_credential";

  it("passes on CODEX_API_KEY without printing its value", async () => {
    const check = await checkCodexCredential(
      { CODEX_API_KEY: "sk-codex-secret-0001" },
      "/nonexistent-home"
    );
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("pass");
    expect(check.message).toContain("CODEX_API_KEY");
    expect(JSON.stringify(check)).not.toContain("sk-codex-secret-0001");
  });

  it("passes on auth.json under CODEX_HOME without printing its bytes", async () => {
    const root = await newWorkspace();
    const codexHome = path.join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "auth.json"),
      '{"token":"auth-json-secret-0002"}'
    );
    const check = await checkCodexCredential(
      { CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-openai-secret-0003" },
      path.join(root, "fallback-home")
    );
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("pass");
    expect(check.message).toContain("auth.json");
    expect(JSON.stringify(check)).not.toContain("auth-json-secret-0002");
    expect(JSON.stringify(check)).not.toContain("sk-openai-secret-0003");
  });

  it("resolves the default codex home under the home directory", async () => {
    const root = await newWorkspace();
    await mkdir(path.join(root, "home", ".codex"), { recursive: true });
    await writeFile(
      path.join(root, "home", ".codex", "auth.json"),
      '{"token":"auth-json-secret-0004"}'
    );
    const check = await checkCodexCredential({}, path.join(root, "home"));
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("pass");
    expect(JSON.stringify(check)).not.toContain("auth-json-secret-0004");
  });

  it("warns when only OPENAI_API_KEY is present", async () => {
    const check = await checkCodexCredential(
      { OPENAI_API_KEY: "sk-openai-secret-0005" },
      "/nonexistent-home"
    );
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("0.154");
    expect(JSON.stringify(check)).not.toContain("sk-openai-secret-0005");
  });

  it("fails when no credential is present", async () => {
    const check = await checkCodexCredential({}, "/nonexistent-home");
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("fail");
    expect(check.message).toContain("CODEX_API_KEY");
    expect(check.message).toContain("auth.json");
  });

  it("ignores an empty CODEX_API_KEY value", async () => {
    const check = await checkCodexCredential(
      { CODEX_API_KEY: "" },
      "/nonexistent-home"
    );
    expect(check.id).toBe(CODEX_CHECK_ID);
    expect(check.status).toBe("fail");
  });
});

describe("oal doctor", () => {
  it("prints terminal check lines with the stable ids", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["doctor"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutChunks.length).toBeGreaterThan(5);
    for (const id of [
      "runtime.node",
      "runtime.packages",
      "store.sqlite",
      "schemas.pack",
      "schemas.eval",
      "schemas.study-protocol",
      "adapter.probe",
      "gateway.determinism",
      "disk.artifacts",
      "limits.table",
      "capability.sandbox_mechanisms",
      "capability.loopback_ephemeral_ports",
      "capability.process_group_termination",
      "capability.network_isolation",
      "capability.file_permissions",
      "capability.container_runtime"
    ]) {
      expect(lineOf(io.stdoutText(), id)).toContain(id);
    }
    expect(lineOf(io.stdoutText(), "runtime.node")).toMatch(/^pass\s{2}/);
    expect(lineOf(io.stdoutText(), "store.sqlite")).toMatch(/^pass\s{2}/);
    expect(io.stdoutText()).toContain("doctor: ");
    expect(await exists(path.join(cwd, ".oal"))).toBe(false);
  });

  it("probes the adapter named by --agent", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["doctor", "--agent", "mock-agent"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(lineOf(io.stdoutText(), "adapter.probe")).toContain("mock-agent");
    expect(lineOf(io.stdoutText(), "adapter.probe")).toMatch(/^pass\s{2}/);
  });

  it("reports the codex credential for --agent codex-cli", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    await main(["doctor", "--agent", "codex-cli"], io, { cwd });
    const line = lineOf(io.stdoutText(), "adapter.codex_credential");
    expect(line).toMatch(/^(pass|warn|fail)/);
    expect(line).not.toContain(process.env.CODEX_API_KEY ?? "no-host-key");
  });

  it("adds no codex credential check for the mock agent", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["doctor"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).not.toContain("adapter.codex_credential");
  });

  it("refuses an unknown adapter selector", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["doctor", "--agent", "bogus-agent"], io, { cwd });
    expect(code).toBe(EXIT_UNSUPPORTED);
    expect(io.stdoutChunks).toEqual([]);
    expect(io.stderrText()).toContain("OAL-RUN-AGENT-UNSUPPORTED");
  });

  it("prints the DoctorReport document with --format json", async () => {
    const cwd = await newWorkspace();
    const io = new MemoryIo();
    const code = await main(["doctor", "--format", "json"], io, { cwd });
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutText()) as Record<string, unknown>;
    expect(report["kind"]).toBe("DoctorReport");
    expect(report["schema_version"]).toBe(1);
    const counts = report["counts"] as Record<string, number>;
    expect(counts["fail"]).toBe(0);
    const checks = report["checks"] as readonly Record<string, unknown>[];
    const ids = checks.map((check) => check["id"]);
    expect(ids).toContain("runtime.node");
    expect(ids).toContain("store.sqlite");
    expect(ids).toContain("gateway.determinism");
    expect(ids).toContain("limits.table");
    const node = checks.find((check) => check["id"] === "runtime.node");
    expect(node?.["status"]).toBe("pass");
  });
});
