import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";
import { canonicalJson, sha256Hex, type Json } from "@oal/core";
import { compileOpenApi } from "@oal/openapi";
import { MockAgentAdapter } from "@oal/mock-adapter";
import { findRepoRoot, loadSteelPack } from "@oal/testkit";

import {
  SetupCode,
  TrialSetupError,
  credentialEnvironmentName,
  credentialEnvironmentNames,
  sanitizeParticipantContract,
  setupTrial,
  type ExposureFactory,
  type ExposureHandle,
  type ExposureRequest
} from "./setup.ts";
import { assertPreflightClean, runPreflight } from "./preflight.ts";
import { stageRecordsOf, type LifecycleEvent } from "./lifecycle.ts";

const SCHEMA_DIR = path.join(findRepoRoot(), "schemas");
const CLOCK = (): number => 1_700_000_000_000;

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** A fake treatment: one record of the request plus a fixed handle. */
class FakeExposure implements ExposureHandle {
  public requests: ExposureRequest[] = [];
  public closeCount = 0;

  readonly baseUrl = "http://127.0.0.1:9";
  readonly credentialNames: readonly string[] = [];
  readonly documentationUrl = null;
  readonly mcpUrl = null;
  readonly serverRecord = { kind: "FakeExposure", base_url: this.baseUrl };

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  get factory(): ExposureFactory {
    return (request) => {
      this.requests.push(request);
      return Promise.resolve(this);
    };
  }
}

/** A factory that always fails, for the failure path. */
const failingFactory: ExposureFactory = () =>
  Promise.reject(new Error("no socket for you"));

async function newStore(
  label: string
): Promise<{ store: ArtifactStore; clean: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), label));
  return {
    store: new ArtifactStore(path.join(dir, ".oal")),
    clean: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

interface Fixture {
  plan: ReturnType<typeof assertPreflightClean>;
  pack: Awaited<ReturnType<typeof loadSteelPack>>;
  store: ArtifactStore;
  clean: () => Promise<void>;
}

async function fixture(label: string): Promise<Fixture> {
  const pack = await loadSteelPack();
  const { store, clean } = await newStore(label);
  const plan = assertPreflightClean(
    await runPreflight({
      packDir: pack.root,
      evalId: "basic-lifecycle",
      batchId: "b-setup",
      store,
      adapter: new MockAgentAdapter(),
      paid: false,
      schemaDir: SCHEMA_DIR
    })
  );
  return { plan, pack, store, clean };
}

describe("setupTrial", () => {
  it("writes the run tree, surface, and start record", async () => {
    const { plan, pack, store, clean } = await fixture("oal-setup-1-");
    const exposure = new FakeExposure();
    try {
      const setup = await setupTrial({
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK
      });
      const root = `runs/${plan.batchId}/trials/${setup.runId}`;
      expect(await store.exists(`${root}/lifecycle.jsonl`)).toBe(true);
      expect(await store.exists(`${root}/run.started.json`)).toBe(true);
      expect(await store.exists(`${root}/server.json`)).toBe(true);
      expect(
        await store.exists(`${root}/participant-surface-manifest.json`)
      ).toBe(true);
      expect(
        await store.exists(`${root}/participant-surface-verification.json`)
      ).toBe(true);

      const startedText = await store.read(`${root}/run.started.json`);
      const started = JSON.parse(startedText) as Record<string, unknown>;
      const extensions = started.extensions as Record<string, unknown>;
      expect(started.run_id).toBe(plan.trialRunIds[0]);
      expect(extensions.exposure_mode).toBe("raw-http");
      expect(extensions.credential_names).toEqual([]);
      expect(startedText.includes(setup.credentials.bearer)).toBe(false);

      expect(setup.surfaceProblems).toEqual([]);
      expect(setup.prompts.files.length).toBeGreaterThan(0);
      for (const file of setup.workspace.files) {
        const target = path.join(setup.layout.workspaceDir, file.target);
        expect(await fileExists(target)).toBe(true);
      }
      expect(await fileExists(setup.control.credentialsPath)).toBe(true);
      expect(setup.control.credentialsPath.endsWith("credentials.json")).toBe(
        true
      );
      expect(exposure.requests.length).toBe(1);
      expect(exposure.requests[0]?.runId).toBe(setup.runId);
      expect(exposure.requests[0]?.trialSeed).toBe(setup.trialSeed);
    } finally {
      await clean();
    }
  });

  it("derives byte-identical start records for identical inputs", async () => {
    const { plan, pack, store, clean } = await fixture("oal-setup-2-");
    try {
      const first = await setupTrial({
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: new FakeExposure().factory,
        now: CLOCK
      });
      const root = `runs/${plan.batchId}/trials/${first.runId}`;
      const text = await store.read(`${root}/run.started.json`);
      expect(text.trim()).toBe(canonicalJson(first.runStarted));
    } finally {
      await clean();
    }
  });

  it("records the per-text prompt digests batch.json names", async () => {
    // batch.json freezes sha256 over each rendered role text of the
    // placeholder preview. The start record must name the same two
    // digests, so the records stay comparable, and must additionally pin
    // the live-rendered texts this trial actually used.
    const { plan, pack, store, clean } = await fixture("oal-setup-6-");
    const exposure = new FakeExposure();
    try {
      const setup = await setupTrial({
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: exposure.factory,
        now: CLOCK
      });
      const root = `runs/${plan.batchId}/trials/${setup.runId}`;
      const started = JSON.parse(
        await store.read(`${root}/run.started.json`)
      ) as {
        inputs: Record<string, string>;
      };
      expect(started.inputs["instructions_sha256"]).toBe(
        sha256Hex(plan.promptPreview.prompts.instructions.text)
      );
      expect(started.inputs["task_sha256"]).toBe(
        sha256Hex(plan.promptPreview.prompts.task.text)
      );
      expect(started.inputs["instructions_live_sha256"]).toBe(
        sha256Hex(setup.prompts.prompts.instructions.text)
      );
      expect(started.inputs["task_live_sha256"]).toBe(
        sha256Hex(setup.prompts.prompts.task.text)
      );
      // The pack interpolates the live base URL into the instructions, so
      // the live digest differs from the canonical preview digest there,
      // while the literal task text renders identically.
      expect(started.inputs["instructions_live_sha256"]).not.toBe(
        started.inputs["instructions_sha256"]
      );
      expect(started.inputs["task_live_sha256"]).toBe(
        started.inputs["task_sha256"]
      );
    } finally {
      await clean();
    }
  });

  it("refuses a second start of the same trial", async () => {
    const { plan, pack, store, clean } = await fixture("oal-setup-3-");
    try {
      const options = {
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: new FakeExposure().factory,
        now: CLOCK
      } as const;
      await setupTrial(options);
      await expect(setupTrial(options)).rejects.toThrowError(/never resumes/u);
    } finally {
      await clean();
    }
  });

  it("finalizes the ledger and closes the exposure on failure", async () => {
    const { plan, pack, store, clean } = await fixture("oal-setup-4-");
    try {
      const attempt = setupTrial({
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: failingFactory,
        now: CLOCK
      });
      await expect(attempt).rejects.toMatchObject({
        name: "TrialSetupError",
        code: SetupCode.ExposureFailed
      });
      const runId = plan.trialRunIds[0];
      if (runId === undefined) {
        throw new Error("frozen batch holds no run id");
      }
      const ledger = await store.read(
        `runs/${plan.batchId}/trials/${runId}/lifecycle.jsonl`
      );
      const events = ledger
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LifecycleEvent);
      const stages = stageRecordsOf(events).map((record) => record.stage);
      expect(stages).toContain("finalization_started");
      expect(stages).toContain("evidence_finalized");
      const last = events[events.length - 1];
      expect(last).toMatchObject({ type: "lifecycle.stage" });
    } finally {
      await clean();
    }
  });

  it("carries the TrialSetupError identity", async () => {
    const { plan, pack, store, clean } = await fixture("oal-setup-5-");
    try {
      const error = await setupTrial({
        store,
        plan,
        pack: pack.loaded,
        index: 0,
        exposure: failingFactory,
        now: CLOCK
      }).then(
        () => null,
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(TrialSetupError);
    } finally {
      await clean();
    }
  });
});

describe("credential environment names", () => {
  it("maps aliases to stable environment names", () => {
    expect(credentialEnvironmentName("sessionAuth")).toBe(
      "OAL_AUTH_SESSIONAUTH"
    );
    expect(credentialEnvironmentName("petstore_auth")).toBe(
      "OAL_AUTH_PETSTORE_AUTH"
    );
  });

  it("adds the bearer name and basic pair when declared", () => {
    const names = credentialEnvironmentNames({
      security_schemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        basicAuth: { type: "http", scheme: "basic" },
        keyAuth: { type: "apiKey" }
      }
    } as unknown as Parameters<typeof credentialEnvironmentNames>[0]);
    expect(names).toEqual([
      "OAL_AUTH_BASICAUTH",
      "OAL_AUTH_BASIC_PASSWORD",
      "OAL_AUTH_BASIC_USERNAME",
      "OAL_AUTH_BEARER",
      "OAL_AUTH_BEARERAUTH",
      "OAL_AUTH_KEYAUTH"
    ]);
  });
});

describe("sanitizeParticipantContract", () => {
  it("rewrites servers, strips docs, and warns on refs", () => {
    const document = {
      openapi: "3.1.0",
      externalDocs: { url: "https://example.test/docs" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/a": {
          get: {
            externalDocs: { url: "https://example.test/a" },
            responses: { 200: { $ref: "#/components/responses/ok" } }
          }
        }
      }
    };
    const result = sanitizeParticipantContract(
      document,
      {
        filename: "openapi.json",
        stripExternalDocs: true,
        replaceServers: true,
        bundleRefs: true
      },
      "http://127.0.0.1:9"
    );
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed.externalDocs).toBe(undefined);
    expect(parsed.servers).toEqual([{ url: "http://127.0.0.1:9" }]);
    const paths = parsed.paths as Record<string, Record<string, unknown>>;
    const get = paths["/a"]?.get as Record<string, unknown>;
    expect(get.externalDocs).toBe(undefined);
    expect(result.warnings.length).toBe(1);
  });

  it("keeps the document untouched when settings are off", () => {
    const document = {
      servers: [{ url: "https://api.example.test" }],
      externalDocs: { url: "https://example.test/docs" }
    };
    const result = sanitizeParticipantContract(
      document,
      {
        filename: "openapi.json",
        stripExternalDocs: false,
        replaceServers: false,
        bundleRefs: false
      },
      "http://127.0.0.1:9"
    );
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed.servers).toEqual([{ url: "https://api.example.test" }]);
    expect(result.warnings).toEqual([]);
  });

  it("rewrites servers declared at path-item and operation level", () => {
    // OpenAPI allows a servers array at the document root, on a path item,
    // and on one operation. Every level must land on the loopback base URL,
    // because the participant may only learn the live exposure.
    const document = {
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.test/root" }],
      paths: {
        "/a": {
          servers: [{ url: "https://api.example.test/path-a" }],
          get: {
            servers: [{ url: "https://api.example.test/op-get" }],
            responses: { 200: { description: "ok" } }
          },
          post: {
            responses: { 200: { description: "ok" } }
          }
        },
        "/b": {
          get: {
            servers: [{ url: "https://api.example.test/b-get" }],
            responses: { 200: { description: "ok" } }
          }
        }
      }
    };
    const result = sanitizeParticipantContract(
      document,
      {
        filename: "openapi.json",
        stripExternalDocs: true,
        replaceServers: true,
        bundleRefs: true
      },
      "http://127.0.0.1:9"
    );
    const parsed = JSON.parse(result.text) as {
      servers: unknown;
      paths: Record<string, Record<string, unknown>>;
    };
    const loopback = [{ url: "http://127.0.0.1:9" }];
    expect(parsed.servers).toEqual(loopback);
    const itemA = parsed.paths["/a"];
    const itemB = parsed.paths["/b"];
    expect(itemA?.["servers"]).toEqual(loopback);
    expect((itemA?.["get"] as Record<string, unknown>)["servers"]).toEqual(
      loopback
    );
    expect(itemA?.["post"]).not.toHaveProperty("servers");
    expect((itemB?.["get"] as Record<string, unknown>)["servers"]).toEqual(
      loopback
    );
    expect(itemB).not.toHaveProperty("servers");
    expect(result.warnings).toEqual([]);
  });

  it("bundles a two-file contract into a self-contained copy", () => {
    // The pack contract spans two files joined by a relative reference. The
    // participant copy must resolve every reference on its own and declare
    // the same operations as the scoped compile of the full set.
    const entry = {
      openapi: "3.1.0",
      info: { title: "two-file", version: "1.0.0" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/widgets": {
          get: {
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      $ref: "components.json#/components/schemas/Widget"
                    }
                  }
                }
              }
            }
          },
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "components.json#/components/schemas/WidgetInput"
                  }
                }
              }
            },
            responses: { 201: { description: "created" } }
          }
        }
      }
    };
    const components = {
      components: {
        schemas: {
          Widget: {
            type: "object",
            properties: {
              input: { $ref: "#/components/schemas/WidgetInput" },
              peer: { $ref: "#/components/schemas/Peer" }
            }
          },
          WidgetInput: { type: "object" },
          Peer: { type: "string" }
        }
      }
    };
    const result = sanitizeParticipantContract(
      entry,
      {
        filename: "openapi.json",
        stripExternalDocs: true,
        replaceServers: true,
        bundleRefs: true
      },
      "http://127.0.0.1:9",
      {
        entrypoint: "contract/openapi.json",
        documents: {
          "contract/openapi.json": entry,
          "contract/components.json": components
        }
      }
    );
    expect(result.warnings).toEqual([]);

    const parsed = JSON.parse(result.text) as Json;
    const refs = collectRefs(parsed);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/")).toBe(true);
      expect(refPointerExists(parsed, ref)).toBe(true);
    }
    // The bundled component tree carries every hoisted schema.
    const bundledComponents = (
      parsed as { components?: { schemas?: Record<string, unknown> } }
    ).components?.schemas;
    expect(Object.keys(bundledComponents ?? {}).sort()).toEqual([
      "Peer",
      "Widget",
      "WidgetInput"
    ]);

    // The copy compiles alone, with the same operation set as the scoped
    // compile of the original two-file set.
    const scoped = compileOpenApi({
      documents: {
        "contract/openapi.json": canonicalJson(entry),
        "contract/components.json": canonicalJson(components)
      },
      entrypoint: "contract/openapi.json"
    });
    const alone = compileOpenApi({
      documents: { "openapi.json": result.text },
      entrypoint: "openapi.json"
    });
    expect(alone.contract.operations.map((operation) => operation.key)).toEqual(
      scoped.contract.operations.map((operation) => operation.key)
    );
    expect(alone.contract.operations.length).toBe(2);
  });
});

/** Every `$ref` value in the document, in canonical traversal order. */
function collectRefs(value: Json, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (value === null || typeof value !== "object") {
    return refs;
  }
  const ref = (value as Record<string, Json>)["$ref"];
  if (typeof ref === "string") {
    refs.push(ref);
  }
  for (const item of Object.values(value)) {
    collectRefs(item, refs);
  }
  return refs;
}

/** True when one internal reference resolves inside the document. */
function refPointerExists(document: Json, ref: string): boolean {
  let current: Json = document;
  for (const token of ref.slice(2).split("/")) {
    if (Array.isArray(current)) {
      const index = Number(token);
      const next = current[index];
      if (next === undefined) {
        return false;
      }
      current = next;
      continue;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    const next = (current as Record<string, Json | undefined>)[token];
    if (next === undefined) {
      return false;
    }
    current = next;
  }
  return true;
}
