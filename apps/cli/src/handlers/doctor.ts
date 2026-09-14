import { readFileSync } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT_INFRASTRUCTURE,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  stableJsonStringify,
  type ExitCode,
  type Json
} from "@oal/core";
import type { AgentProbe } from "@oal/agent-adapter";
import { LIMIT_CEILINGS, LIMIT_DEFAULTS } from "@oal/config";
import {
  aggregateDoctorReport,
  runDoctor,
  type DoctorAdapterResult,
  type DoctorCapabilityResult,
  type DoctorCheck,
  type DoctorDiskArtifact,
  type DoctorInput,
  type DoctorReport,
  type DoctorSchemaFile
} from "@oal/report";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { invalidOptionValue } from "../usage.ts";
import { selectAdapter } from "./run.ts";

/** Schema files doctor loads, keyed by their check id suffix. */
const SCHEMA_FILES: readonly { readonly id: string; readonly file: string }[] =
  [
    { id: "pack", file: "pack.v1.schema.json" },
    { id: "eval", file: "eval.v1.schema.json" },
    { id: "study-protocol", file: "study-protocol.v1.schema.json" }
  ];

/** Anchor file used to locate the repository schema directory. */
const SCHEMA_ANCHOR = "pack.v1.schema.json";

/** Milliseconds the loopback probe waits before it gives up. */
const LOOPBACK_TIMEOUT_MS = 2_000;

/** How far above this module the repository root may sit. */
const MAX_ROOT_LEVELS = 6;

/** Width of the status column of the terminal report. */
const STATUS_WIDTH = 7;

/** Nearest ancestor directory that holds one relative entry. */
async function ancestorWith(
  from: string,
  relative: string
): Promise<string | null> {
  let current = from;
  for (let level = 0; level < MAX_ROOT_LEVELS; level += 1) {
    const info = await stat(path.join(current, relative)).catch(() => null);
    if (info !== null) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/** Workspace package versions, read from the installed @oal links. */
export async function workspacePackageVersions(): Promise<
  Readonly<Record<string, string>>
> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = await ancestorWith(here, path.join("node_modules", "@oal"));
  if (root === null) {
    return {};
  }
  const versions: Record<string, string> = {};
  const entries = await readdir(path.join(root, "node_modules", "@oal"), {
    withFileTypes: true
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const manifest = path.join(
      root,
      "node_modules",
      "@oal",
      entry.name,
      "package.json"
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const name = (parsed as { name?: unknown }).name;
    const version = (parsed as { version?: unknown }).version;
    if (typeof name === "string" && typeof version === "string") {
      versions[name] = version;
    }
  }
  return versions;
}

/** Pack, eval, and study schema files of the repository schema set. */
export async function schemaFilesOf(): Promise<DoctorSchemaFile[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = await ancestorWith(here, path.join("schemas", SCHEMA_ANCHOR));
  if (root === null) {
    return [];
  }
  return SCHEMA_FILES.map((schema): DoctorSchemaFile => {
    return {
      id: schema.id,
      load: (): unknown =>
        JSON.parse(
          readFileSync(path.join(root, "schemas", schema.file), "utf8")
        )
    };
  });
}

/**
 * Probe the loopback interface for an ephemeral port. Doctor owns this
 * socket; the engine itself opens none.
 */
export function probeLoopback(): Promise<DoctorCapabilityResult> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (result: DoctorCapabilityResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      server.close();
      finish({
        supported: null,
        detail: "the loopback bind did not answer within the probe timeout"
      });
    }, LOOPBACK_TIMEOUT_MS);
    server.once("error", (error) => {
      finish({
        supported: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        finish({
          supported: port > 0,
          detail: port > 0 ? `bound 127.0.0.1:${port}` : "no port assigned"
        });
      });
    });
  });
}

/** Whether the artifact directory keeps a newly written file private. */
async function probeFilePermissions(
  directory: string
): Promise<DoctorCapabilityResult> {
  return runInProbedDirectory(directory, async () => {
    const target = path.join(directory, "doctor-probe-mode.txt");
    try {
      await writeFile(target, "mode probe\n", { flag: "w", mode: 0o600 });
      const info = await stat(target);
      const mode = info.mode & 0o777;
      return {
        supported: mode === 0o600,
        detail: `new files carry mode ${mode.toString(8).padStart(3, "0")}`
      };
    } catch (error) {
      return {
        supported: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      await rm(target, { force: true });
    }
  });
}

/**
 * Run one probe inside the artifact directory. A directory the probe had
 * to create is removed again, so doctor leaves no empty artifact root.
 */
async function runInProbedDirectory<T>(
  directory: string,
  body: () => Promise<T>
): Promise<T> {
  const existed = await stat(directory)
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (!existed) {
    await mkdir(directory, { recursive: true }).catch(() => undefined);
  }
  try {
    return await body();
  } finally {
    if (!existed) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

/** Optional container runtime on the executable search path. */
async function probeContainerRuntime(): Promise<DoctorCapabilityResult> {
  const searchPath = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of ["docker", "podman"]) {
    for (const entry of searchPath) {
      if (entry.length === 0) {
        continue;
      }
      const candidate = path.join(entry, name);
      const reachable = await access(candidate).catch(() => null);
      if (reachable === null) {
        continue;
      }
      return { supported: true, detail: `${candidate} is executable` };
    }
  }
  return {
    supported: null,
    detail: "none on the executable search path; optional in this build"
  };
}

/** Write probe of the artifact root, cleaned up before it returns. */
export function artifactProbe(directory: string): DoctorDiskArtifact {
  return {
    directory,
    write: (): Promise<{ ok: boolean; error: string | null }> =>
      runInProbedDirectory(directory, async () => {
        let ok = true;
        let error: string | null = null;
        try {
          await writeFile(
            path.join(directory, "doctor-probe.json"),
            "probe\n",
            { flag: "w" }
          );
        } catch (cause) {
          ok = false;
          error = cause instanceof Error ? cause.message : String(cause);
        }
        await rm(path.join(directory, "doctor-probe.json"), { force: true });
        return { ok, error };
      })
  };
}

/** Feature names one adapter probe reports as present. */
export function featuresOfProbe(probe: AgentProbe): string[] {
  const features: string[] = [];
  for (const [name, present] of Object.entries(probe.capabilities)) {
    if (name !== "sandboxModes" && present === true) {
      features.push(name);
    }
  }
  for (const mode of probe.capabilities.sandboxModes) {
    features.push(`sandbox:${mode}`);
  }
  return features;
}

/** Doctor adapter result of one agent adapter probe. */
export function adapterResultOf(probe: AgentProbe): DoctorAdapterResult {
  return {
    ok: probe.status === "available",
    features: featuresOfProbe(probe),
    detail:
      probe.version ??
      probe.error ??
      probe.errorCode ??
      `status ${probe.status}`
  };
}

/** Stable check id of the codex credential check (section 23.13). */
export const CODEX_CREDENTIAL_CHECK_ID = "adapter.codex_credential";

/** Resolve the codex home the way codex does: CODEX_HOME, then ~/.codex. */
function codexHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string
): string {
  const declared = env["CODEX_HOME"];
  return declared !== undefined && declared !== ""
    ? declared
    : path.join(homeDir, ".codex");
}

/** Whether one environment name holds a non-empty value. */
function envHas(
  env: Readonly<Record<string, string | undefined>>,
  name: string
) {
  const value = env[name];
  return value !== undefined && value !== "";
}

/**
 * Which credential the host provides for codex-cli, by name and presence
 * only. Codex 0.154 authenticates non-interactive runs from CODEX_API_KEY
 * or an auth.json under CODEX_HOME; it ignores OPENAI_API_KEY. The check
 * never reads a value or a file content.
 */
export async function checkCodexCredential(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string
): Promise<DoctorCheck> {
  if (envHas(env, "CODEX_API_KEY")) {
    return {
      id: CODEX_CREDENTIAL_CHECK_ID,
      status: "pass",
      message:
        "CODEX_API_KEY is set, so codex-cli can authenticate a " +
        "non-interactive run.",
      detail: { credential: "CODEX_API_KEY" }
    };
  }
  const codexHome = codexHomeOf(env, homeDir);
  const authJson = path.join(codexHome, "auth.json");
  if ((await access(authJson).catch(() => null)) !== null) {
    return {
      id: CODEX_CREDENTIAL_CHECK_ID,
      status: "pass",
      message:
        "An auth.json under CODEX_HOME is present, so codex-cli can " +
        "authenticate a non-interactive run.",
      detail: { credential: "auth.json" }
    };
  }
  if (envHas(env, "OPENAI_API_KEY")) {
    return {
      id: CODEX_CREDENTIAL_CHECK_ID,
      status: "warn",
      message:
        "Only OPENAI_API_KEY is set. Codex 0.154 ignores it for " +
        "non-interactive runs, so set CODEX_API_KEY or place an auth.json " +
        "under CODEX_HOME.",
      detail: { credential: "OPENAI_API_KEY" }
    };
  }
  return {
    id: CODEX_CREDENTIAL_CHECK_ID,
    status: "fail",
    message:
      "No codex credential is present. Set CODEX_API_KEY or place an " +
      "auth.json under CODEX_HOME.",
    detail: { credential: "none" }
  };
}

const STATUS_COLORS: Readonly<Record<DoctorCheck["status"], string>> = {
  pass: "\x1b[32m",
  warn: "\x1b[33m",
  fail: "\x1b[31m"
};

function statusColumn(status: DoctorCheck["status"], color: boolean): string {
  const plain = status.padEnd(STATUS_WIDTH);
  return color ? `${STATUS_COLORS[status]}${plain}\x1b[0m` : plain;
}

/** Terminal check lines of one report, one line per stable check id. */
export function doctorLines(report: DoctorReport, color = false): string[] {
  const width = report.checks.reduce(
    (maximum, check) => Math.max(maximum, check.id.length),
    0
  );
  const lines = report.checks.map(
    (check) =>
      `${statusColumn(check.status, color)}${check.id.padEnd(width)}  ` +
      check.message
  );
  lines.push(
    `doctor: ${report.counts.pass} pass, ${report.counts.warn} warn, ` +
      `${report.counts.fail} fail`
  );
  return lines;
}

/** Status 3 only when a check failed outright (section 23.18). */
export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.status === "fail" ? EXIT_INFRASTRUCTURE : EXIT_OK;
}

/**
 * `oal doctor [--agent <adapter>] [--format terminal|json]`
 * (specification section 23.13). The command makes no paid model call.
 */
export const doctorCommand: CommandHandler = async (args, io) => {
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const selection = selectAdapter(args.flags.string("agent"));
  if ("error" in selection) {
    emitDiagnostics(io, args.context, [selection.error]);
    return EXIT_UNSUPPORTED;
  }

  const artifactRoot = path.resolve(args.context.cwd, ".oal");
  const agentProbe = await selection.adapter.probe({});
  const sandboxModes = agentProbe.capabilities.sandboxModes.join(", ");
  const input: DoctorInput = {
    nodeVersion: process.version,
    packageVersions: await workspacePackageVersions(),
    schemaFiles: await schemaFilesOf(),
    adapter: {
      name: selection.adapter.id,
      probe: (): DoctorAdapterResult => adapterResultOf(agentProbe)
    },
    diskArtifact: artifactProbe(artifactRoot),
    limits: { table: LIMIT_DEFAULTS, ceilings: LIMIT_CEILINGS },
    capabilities: {
      sandbox_mechanisms: (): DoctorCapabilityResult => ({
        supported: null,
        detail:
          "platform mechanisms were not assessed; the adapter declares " +
          (sandboxModes.length === 0 ? "none" : sandboxModes)
      }),
      loopback_ephemeral_ports: probeLoopback,
      process_group_termination: (): DoctorCapabilityResult => ({
        supported: null,
        detail: "assessment needs a child process; skipped in this build"
      }),
      network_isolation: (): DoctorCapabilityResult => ({
        supported: null,
        detail: "not assessed in this build"
      }),
      file_permissions: (): Promise<DoctorCapabilityResult> =>
        probeFilePermissions(artifactRoot),
      container_runtime: probeContainerRuntime
    }
  };

  const report = await runDoctor(input);
  // The credential check belongs to the codex-cli selection alone; a
  // mock-agent run grows no provider-credential check.
  const checks: DoctorCheck[] = [...report.checks];
  if (selection.adapter.id === "codex-cli") {
    checks.push(await checkCodexCredential(process.env, homedir()));
  }
  const full = aggregateDoctorReport(checks);
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(full as unknown as Json));
  } else {
    for (const line of doctorLines(full, args.context.color)) {
      io.stdout(line);
    }
  }
  return doctorExitCode(full);
};
