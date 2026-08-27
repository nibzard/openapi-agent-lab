/**
 * Gate 8 of specification section 36.1: isolation.
 *
 * One batch runs four trials with a parallel bound of two through the real
 * loopback exposure. The trials must share nothing a participant could
 * observe: no shared server port, no reused credential, no shared
 * workspace or control tree, and no evidence that names another run.
 *
 * A second batch drives a spawned probing participant: from inside its own
 * process it tries to read host files, dial foreign loopback ports, reach
 * the metadata address, and read a sibling trial's evidence.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

import { mintRunCredentials, type RunCredentials } from "@oal/gateway";
import {
  buildSpawnEnvironment,
  SessionEventRecorder,
  type AgentAdapter,
  type AgentConfig,
  type AgentEventSink,
  type AgentProbe,
  type AgentRunContext,
  type AgentRunResult,
  type PreparedAgent
} from "@oal/agent-adapter";

import { runBatch } from "./index.ts";
import {
  ExposureRecorder,
  fixedClock,
  parseJsonl,
  prepareTrial,
  readJsonObject,
  steelAdapter,
  steelPackRoot,
  trialRootOf,
  writeSmokePack
} from "./integration-fixtures.ts";

/** Trials of the isolation batch. */
const COUNT = 4;

/** Parallel bound of the isolation batch. */
const PARALLEL = 2;

/** Adapter wrapper that records the run context of every trial. */
class ContextRecordingAdapter implements AgentAdapter {
  readonly id: string;
  readonly contexts = new Map<string, AgentRunContext>();

  constructor(private readonly inner: AgentAdapter) {
    this.id = inner.id;
  }

  probe(config: AgentConfig): Promise<AgentProbe> {
    return this.inner.probe(config);
  }

  async prepare(context: AgentRunContext): Promise<PreparedAgent> {
    this.contexts.set(context.runId, context);
    return this.inner.prepare(context);
  }

  run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    return this.inner.run(prepared, sink, signal);
  }

  async cleanup(prepared: PreparedAgent): Promise<void> {
    await this.inner.cleanup?.(prepared);
  }
}

/** Every secret value one trial mints. */
function tokensOf(credentials: RunCredentials): readonly string[] {
  return [
    ...Object.values(credentials.apiKeys),
    credentials.basic.username,
    credentials.basic.password,
    credentials.bearer
  ].filter((token) => token.length > 0);
}

/** Read one JSON field that must hold a string. */
function stringField(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("The field is not a string.");
  }
  return value;
}

/** Every file below one directory, relative to that directory. */
async function filesBelow(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(
        ...(await filesBelow(join(root, entry.name), `${prefix}${entry.name}/`))
      );
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

describe("runner integration: isolation of parallel trials", () => {
  it(
    "shares no port, credential, workspace, or evidence between trials",
    { timeout: 120000 },
    async () => {
      const adapter = new ContextRecordingAdapter(
        steelAdapter("basic-lifecycle")
      );
      const harness = await prepareTrial({
        label: "oal-it-iso-",
        packDir: steelPackRoot(),
        evalId: "basic-lifecycle",
        batchId: "it-isolation",
        adapter,
        count: COUNT,
        parallel: PARALLEL,
        limitOverrides: {
          maxBatchTrials: COUNT,
          maxParallelTrials: PARALLEL
        }
      });
      const recorder = new ExposureRecorder();
      try {
        const batch = await runBatch({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          now: fixedClock(),
          exposure: recorder.factory
        });

        // Every trial finished clean.
        expect(batch.count).toBe(COUNT);
        expect(batch.parallel).toBe(PARALLEL);
        expect(batch.aborted).toBe(false);
        expect(batch.defectCode).toBeNull();
        expect(batch.notStartedRunIds).toEqual([]);
        expect(batch.outcomes.length).toBe(COUNT);
        for (const outcome of batch.outcomes) {
          expect(outcome.disposition).toBe("completed");
          expect(outcome.evidenceIntegrity).toBe("intact");
          expect(outcome.apiRequests).toBe(4);
        }
        const runIds = harness.plan.trialRunIds;
        expect(batch.outcomes.map((outcome) => outcome.runId)).toEqual([
          ...runIds
        ]);

        // The batch finalized its own evidence, and the completion
        // pointer verifies every leaf under the batch scope.
        const batchRoot = `runs/${harness.plan.batchId}`;
        for (const artifact of [
          "batch.json",
          "assignment-events.jsonl",
          "cohort-evaluation.json",
          "artifact-manifest.json",
          "batch.completed.json"
        ]) {
          expect(await harness.store.exists(`${batchRoot}/${artifact}`)).toBe(
            true
          );
        }
        const verification = await harness.store.verify(
          `${batchRoot}/batch.completed.json`
        );
        expect(verification.problems).toEqual([]);
        expect(verification.ok).toBe(true);

        // Ports: one distinct loopback port per trial.
        const ports = recorder.ports();
        expect(ports.length).toBe(COUNT);
        expect(new Set(ports).size).toBe(COUNT);
        for (const port of ports) {
          expect(port).toBeGreaterThan(0);
        }

        // Concurrency: trials overlapped, and never exceeded the bound.
        expect(recorder.peakConcurrency()).toBe(PARALLEL);

        // Credentials: every trial seed mints its own token set.
        expect(new Set(harness.plan.trialSeeds).size).toBe(COUNT);
        const tokenSets = harness.plan.trialSeeds.map((seed) =>
          tokensOf(mintRunCredentials(harness.plan.contract.ir, seed))
        );
        for (const set of tokenSets) {
          expect(set.length).toBeGreaterThan(0);
        }
        const seen = new Set<string>();
        for (const set of tokenSets) {
          for (const token of set) {
            expect(seen.has(token)).toBe(false);
            seen.add(token);
          }
        }

        // Evidence: no minted secret appears anywhere under the batch.
        const evidenceRoot = harness.store.resolve(batchRoot);
        const evidenceFiles = await filesBelow(evidenceRoot);
        expect(evidenceFiles.length).toBeGreaterThan(COUNT);
        for (const relative of evidenceFiles) {
          const text = await readFile(join(evidenceRoot, relative), "utf8");
          for (const token of seen) {
            expect(text.includes(token)).toBe(false);
          }
        }

        // Per trial: separate server record, control tree, and streams.
        const recorded = new Map(
          recorder.exposures().map((record) => [record.runId, record.baseUrl])
        );
        const baseUrls = new Set<string>();
        const controlUrls = new Set<string>();
        const workspaces = new Set<string>();
        const homes = new Set<string>();
        const temporaries = new Set<string>();
        const blobNamespaces = new Set<string>();
        const mcpPaths = new Set<string>();
        for (const runId of runIds) {
          const root = trialRootOf(harness.plan.batchId, runId);
          const layout = harness.store.trialLayout(harness.plan.batchId, runId);

          const server = await readJsonObject(
            harness.store,
            `${root}/server.json`
          );
          expect(server["run_id"]).toBe(runId);
          expect(recorded.get(runId)).toBe(server["base_url"]);
          baseUrls.add(stringField(server["base_url"]));

          // Workspaces, synthetic homes, and temp trees: the participant
          // received one of each, and no two trials share one.
          const context = adapter.contexts.get(runId);
          expect(context).toBeDefined();
          if (context === undefined) {
            continue;
          }
          expect(context.workspaceDir).toBe(layout.workspaceDir);
          // HOME and TMPDIR live in this run's private control tree.
          expect(context.syntheticHomeDir).toBe(
            harness.store.resolve(
              `control/${harness.plan.batchId}/${runId}/home`
            )
          );
          expect(context.temporaryDir).toBe(
            harness.store.resolve(
              `control/${harness.plan.batchId}/${runId}/tmp`
            )
          );
          workspaces.add(context.workspaceDir);
          homes.add(context.syntheticHomeDir);
          temporaries.add(context.temporaryDir);

          // Blob storage: one content-addressed namespace per trial.
          expect(layout.blobsDir).toBe(join(layout.root, "blobs", "sha256"));
          blobNamespaces.add(layout.blobsDir);

          // MCP: the loopback exposure declares no config path at all.
          const started = await readJsonObject(
            harness.store,
            `${root}/run.started.json`
          );
          const serverFact = started["server"] as Record<string, unknown>;
          expect(serverFact["mcp"]).toBe(null);
          mcpPaths.add(String(serverFact["mcp"]));

          // The private control tree holds this run's credentials only,
          // and they point at this run's exposure.
          const credentials = await readJsonObject(
            harness.store,
            `control/${harness.plan.batchId}/${runId}/credentials.json`
          );
          expect(credentials["run_id"]).toBe(runId);
          expect(credentials["base_url"]).toBe(server["base_url"]);
          controlUrls.add(stringField(credentials["base_url"]));

          // The logical streams name exactly this run.
          const trace = parseJsonl(
            await harness.store.read(`${root}/trace.jsonl`)
          );
          expect(trace.length).toBe(4);
          for (const event of trace) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
              expect(event).toHaveProperty("batch_id", harness.plan.batchId);
            }
          }
          const session = parseJsonl(
            await harness.store.read(`${root}/session/events.redacted.jsonl`)
          );
          expect(session.length).toBeGreaterThan(0);
          for (const event of session) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
            }
          }
          const ledger = parseJsonl(
            await harness.store.read(`${root}/lifecycle.jsonl`)
          );
          for (const event of ledger) {
            if (typeof event === "object" && event !== null) {
              expect(event).toHaveProperty("run_id", runId);
            }
          }

          // State stays per run.
          const state = await readJsonObject(
            harness.store,
            `${root}/state.final.json`
          );
          expect(state["run_id"]).toBe(runId);
          expect(state["state"]).toEqual({});
        }
        expect(baseUrls.size).toBe(COUNT);
        expect(controlUrls.size).toBe(COUNT);
        expect(workspaces.size).toBe(COUNT);
        expect(homes.size).toBe(COUNT);
        expect(temporaries.size).toBe(COUNT);
        expect(blobNamespaces.size).toBe(COUNT);
        expect(mcpPaths).toEqual(new Set(["null"]));
      } finally {
        await harness.clean();
      }
    }
  );

  it(
    "keeps a spawned probing participant inside its declared surface",
    { timeout: 15000 },
    async () => {
      // A closed loopback port: the probe must see its connection
      // refused, because nothing listens there.
      const closedPort = await reserveClosedPort();

      // A host sentinel outside every trial tree. The probe walks up from
      // its working directory to find it, so the path never travels
      // through the participant environment.
      const marker = `OAL-SENTINEL-${Date.now().toString(36)}`;
      const scratch = await mkdtemp(join(tmpdir(), "oal-it-probe-"));
      const packDir = await writeSmokePack(scratch);

      const adapter = new ProbingAgentAdapter(closedPort);
      const harness = await prepareTrial({
        label: "oal-it-probe-",
        packDir,
        evalId: "smoke",
        batchId: "it-probe-surface",
        adapter,
        count: 2,
        parallel: 1,
        limitOverrides: { maxBatchTrials: 2, maxParallelTrials: 1 }
      });
      try {
        // The sentinel sits above the store root of this harness, outside
        // every trial tree the runner creates below.
        await writeFile(
          join(harness.scratchRoot, "host-sentinel.txt"),
          `${marker}\n`,
          "utf8"
        );
        const batch = await runBatch({
          store: harness.store,
          plan: harness.plan,
          pack: harness.pack,
          adapter,
          now: fixedClock()
        });
        expect(batch.outcomes.length).toBe(2);
        for (const outcome of batch.outcomes) {
          expect(outcome.disposition).toBe("completed");
          expect(outcome.reportStatus).toBe("valid");
          expect(outcome.apiRequests).toBe(0);
        }

        expect(harness.plan.trialRunIds.length).toBe(2);
        const first = harness.plan.trialRunIds[0];
        const second = harness.plan.trialRunIds[1];
        if (first === undefined || second === undefined) {
          throw new Error("The probing batch declared no run ids.");
        }
        for (const runId of harness.plan.trialRunIds) {
          const attempts = adapter.attempts.get(runId);
          expect(attempts).toBeDefined();
          if (attempts === undefined) {
            continue;
          }

          // The unrelated loopback port refused the connection.
          expect(attempts["loopback"]?.startsWith("refused:")).toBe(true);
          // The metadata address failed or timed out; it never connected.
          expect(attempts["metadata"]?.startsWith("connected:")).toBe(false);

          // The spawn environment carries no host path: no sentinel, no
          // sibling evidence tree, no metadata address.
          const environment = adapter.environments.get(runId);
          expect(environment).toBeDefined();
          if (environment === undefined) {
            continue;
          }
          expect(Object.keys(environment).sort()).toEqual(["OAL_BASE_URL"]);
          for (const value of Object.values(environment)) {
            expect(value.includes(marker)).toBe(false);
            expect(value.includes("host-sentinel")).toBe(false);
            expect(value.includes("/trials/")).toBe(false);
            expect(value.includes("169.254.169.254")).toBe(false);
          }

          // The run record reports what the adapter probe declared.
          const root = trialRootOf(harness.plan.batchId, runId);
          const started = await readJsonObject(
            harness.store,
            `${root}/run.started.json`
          );
          const extensions = started["extensions"] as Record<string, unknown>;
          expect(extensions["environment_separation"]).toBe("advisory");
          expect(extensions["tool_network_policy"]).toBe("advisory");
        }

        // No trial artifact names the other trial or leaks the sentinel.
        const trialsRoot = harness.store.resolve(
          `runs/${harness.plan.batchId}/trials`
        );
        for (const runId of harness.plan.trialRunIds) {
          const other = runId === first ? second : first;
          for (const relative of await filesBelow(join(trialsRoot, runId))) {
            const text = await readFile(
              join(trialsRoot, runId, relative),
              "utf8"
            );
            expect(text.includes(other)).toBe(false);
            expect(text.includes(marker)).toBe(false);
            expect(text.includes("host-sentinel")).toBe(false);
          }
        }

        // The second probe did look for a sibling: its outcome is recorded,
        // and the sibling content never reached its evidence.
        const secondAttempts = adapter.attempts.get(second);
        expect(["readable", "absent"]).toContain(
          secondAttempts?.["sibling_evidence"]
        );
        for (const runId of harness.plan.trialRunIds) {
          expect(["readable", "absent", "error"]).toContain(
            adapter.attempts.get(runId)?.["sentinel"]
          );
        }
      } finally {
        await harness.clean();
      }
    }
  );
});

/**
 * Bind one loopback port, then close the listener. The port stays unused,
 * so a later connection attempt is refused by the operating system.
 */
async function reserveClosedPort(): Promise<number> {
  const server = net.createServer(() => undefined);
  await new Promise<void>((resolve) => {
    server.once("listening", () => {
      resolve();
    });
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The reserved port could not be read.");
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}

/**
 * A generic-style adapter that spawns a real participant process. The
 * process runs outside any enforced sandbox, which the probe declares
 * honestly as advisory.
 */
class ProbingAgentAdapter implements AgentAdapter {
  readonly id = "generic-probe";
  readonly environments = new Map<string, Record<string, string>>();
  readonly attempts = new Map<string, Record<string, string>>();

  constructor(private readonly closedPort: number) {}

  probe(): Promise<AgentProbe> {
    return Promise.resolve({
      status: "available",
      version: "probe-0",
      capabilities: {
        nativeSystemPrompt: true,
        nativeOutputSchema: true,
        mcp: false,
        machineReadableTranscript: true,
        usageReporting: false,
        separateToolEnvironment: true,
        enforceableToolNetworkPolicy: false,
        sandboxModes: []
      },
      launcherEnvironmentNames: [],
      environmentSeparation: "advisory",
      toolNetworkPolicy: "advisory"
    });
  }

  prepare(context: AgentRunContext): Promise<PreparedAgent> {
    const spawnEnvironment = buildSpawnEnvironment(context, []);
    this.environments.set(context.runId, spawnEnvironment.env);
    return Promise.resolve({
      runId: context.runId,
      adapter: this.id,
      executable: process.execPath,
      argv: ["-e", probeScript(this.closedPort)],
      workingDirectory: context.workspaceDir,
      environment: spawnEnvironment.env,
      launcherEnvironmentApplied: []
    });
  }

  async run(
    prepared: PreparedAgent,
    sink: AgentEventSink
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const recorder = new SessionEventRecorder({
      runId: prepared.runId,
      adapter: this.id,
      sink
    });
    recorder.started({ model: "probe-model", cliVersion: "probe-0" });

    const child = spawn(prepared.executable, prepared.argv, {
      cwd: prepared.workingDirectory,
      env: prepared.environment
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      child.on("error", () => {
        resolve({ code: 1, signal: null });
      });
      child.on("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Reduce the probe line to outcome categories. Host file content never
    // enters the recorded evidence.
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("OAL_PROBE ")) {
        continue;
      }
      const parsed = JSON.parse(line.slice("OAL_PROBE ".length)) as Record<
        string,
        unknown
      >;
      const attempts: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        attempts[key] = String(value);
      }
      this.attempts.set(prepared.runId, attempts);
      recorder.adapterEvent("probe.attempted", { ...attempts });
    }

    const report = JSON.stringify({ pinged: false, status: "isolated" });
    recorder.text("stdout", report, "turn.completed");
    recorder.exited({
      exitCode: exit.code,
      signal: exit.signal,
      graceful: exit.code === 0
    });
    return {
      status: exit.code === 0 ? "completed" : "failed",
      exitCode: exit.code,
      signal: exit.signal,
      durationMs: Date.now() - startedAt,
      ...(exit.code === 0 ? { finalText: report } : {})
    };
  }
}

/**
 * The probe script of the spawned participant. It receives only the closed
 * port number; every path target it must discover by walking out of its
 * workspace.
 */
function probeScript(closedPort: number): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const net = require('node:net');",
    "const results = {};",
    // Attempt 1: read a host file that lives outside the workspace.
    "let sentinel = 'absent';",
    "try {",
    "  let dir = process.cwd();",
    "  for (let i = 0; i < 8; i += 1) {",
    "    const candidate = path.join(dir, 'host-sentinel.txt');",
    "    if (fs.existsSync(candidate)) {",
    "      sentinel = 'readable';",
    "      break;",
    "    }",
    "    const parent = path.dirname(dir);",
    "    if (parent === dir) {",
    "      break;",
    "    }",
    "    dir = parent;",
    "  }",
    "} catch (error) {",
    "  sentinel = 'error';",
    "}",
    "results.sentinel = sentinel;",
    // Attempt 2: read a sibling trial's evidence directory.
    "let sibling = 'absent';",
    "try {",
    "  const runRoot = path.dirname(process.cwd());",
    "  const trialsRoot = path.dirname(runRoot);",
    "  for (const entry of fs.readdirSync(trialsRoot)) {",
    "    if (entry === path.basename(runRoot)) {",
    "      continue;",
    "    }",
    "    const trace = path.join(trialsRoot, entry, 'trace.jsonl');",
    "    if (fs.existsSync(trace)) {",
    "      sibling = 'readable';",
    "      break;",
    "    }",
    "  }",
    "} catch (error) {",
    "  sibling = 'error';",
    "}",
    "results.sibling_evidence = sibling;",
    // Attempts 3 and 4: dial a closed loopback port and the metadata
    // address, both with a bounded timeout.
    "const targets = [",
    `  ['loopback', '127.0.0.1', ${closedPort}],`,
    "  ['metadata', '169.254.169.254', 80]",
    "];",
    "let pending = targets.length;",
    "for (const [name, host, port] of targets) {",
    "  const socket = net.connect({ host, port });",
    "  let settled = false;",
    "  const finish = (outcome) => {",
    "    if (settled) {",
    "      return;",
    "    }",
    "    settled = true;",
    "    results[name] = outcome;",
    "    socket.destroy();",
    "    pending -= 1;",
    "    if (pending === 0) {",
    "      console.log('OAL_PROBE ' + JSON.stringify(results));",
    "    }",
    "  };",
    "  socket.setTimeout(1200, () => finish('timeout'));",
    "  socket.on('connect', () => finish('connected:' + host));",
    "  socket.on('error', (error) => finish('refused:' + (error.code || 'error')));",
    "}"
  ].join("\n");
}
