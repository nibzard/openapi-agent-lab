import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "@oal/evidence";
import { canonicalJson } from "@oal/core";
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
});
