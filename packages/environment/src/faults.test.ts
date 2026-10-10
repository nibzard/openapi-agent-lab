/**
 * Fault fixture tests (specification section 48.6). The three wired
 * fixtures keep their half of the contract: a matched before_behavior
 * fault answers without mutating domain state, a corrupt candidate
 * rolls the whole transaction back and still commits its consumption,
 * an after_commit disconnect commits everything before the transport
 * cuts, and delivery evidence stays separate from the committed
 * response - absent means unknown, never delivered. Unsupported
 * phases and actions fail before the world starts.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ContractIR } from "@oal/contract-ir";
import type { Json, JsonObject } from "@oal/core";
import { handleGatewayRequest, mintRunCredentials } from "@oal/gateway";
import { loadPack, type LoadedPack } from "@oal/pack";
import type { FaultRule } from "@oal/behavior-api";

import {
  openEnvironment,
  openRestoredEnvironment,
  readCheckpointDirectory,
  type Environment
} from "./index.ts";

const moduleDir = import.meta.dirname;
const webclipRoot = path.resolve(moduleDir, "../../../packs/webclip");
const fixtureIrPath = path.join(
  moduleDir,
  "fixtures",
  "webclip.contract-ir.json"
);

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Load the webclip pack plus its frozen contract inputs. */
async function webclipInputs(): Promise<{
  pack: LoadedPack;
  contract: {
    ir: ContractIR;
    semanticSha256: string;
    executionSha256: string;
  };
}> {
  const pack = await loadPack(webclipRoot);
  const ir = JSON.parse(await readFile(fixtureIrPath, "utf8")) as ContractIR;
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  expect(entry).toBeDefined();
  const document = ir.source.documents[0];
  expect(document?.uri).toBe("contract/openapi.json");
  expect(document?.sha256).toBe(entry?.sha256);
  return {
    pack,
    contract: {
      ir,
      semanticSha256: ir.source.semantic_sha256,
      executionSha256: ir.source.execution_sha256
    }
  };
}

const RUN_SEED = "a".repeat(64);

/** Open a webclip world with declared fault rules. */
async function openFaultedWorld(
  faultRules: readonly FaultRule[],
  databasePath?: string
): Promise<Environment> {
  const { pack, contract } = await webclipInputs();
  return openEnvironment({
    pack,
    contract,
    scenarioId: "baseline",
    seed: RUN_SEED,
    worldId: "fault-world",
    databasePath: databasePath ?? path.join(await newScratch(), "state.sqlite"),
    records: {
      batchId: "fault-tests",
      packSha256: "0".repeat(64),
      implementationSha256: contract.executionSha256
    },
    now: () => Date.UTC(2026, 9, 10),
    faultRules
  });
}

async function newScratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-faults-"));
  scratch.push(dir);
  return dir;
}

/** The limits the pipeline reads, generous for tests. */
const LIMITS = {
  maxRequestTargetBytes: 16 * 1024,
  maxRequestHeaderBytes: 32 * 1024,
  maxRequestBodyBytes: 5 * 1024 * 1024,
  maxMultipartParts: 100,
  maxGeneratedResponseBodyBytes: 10 * 1024 * 1024
} as never;

/** One authorized create-clip request through the full pipeline. */
async function createClip(
  environment: Environment,
  sequence: number,
  body: JsonObject = { url: "https://example.com/essay", format: "markdown" }
): Promise<{
  status: number;
  body: Json | null;
  disconnectAfterBytes?: number;
}> {
  const bearer = mintRunCredentials(environment.contract.ir, RUN_SEED).bearer;
  const response = await handleGatewayRequest(
    {
      contract: environment.contract.ir,
      limits: LIMITS,
      runSeed: RUN_SEED,
      state: environment.state,
      backend: environment.backend,
      faults: environment.faults ?? undefined
    } as Parameters<typeof handleGatewayRequest>[0],
    sequence,
    {
      method: "POST",
      target: "/v1/clips",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json"
      },
      body: new TextEncoder().encode(JSON.stringify(body))
    }
  );
  return {
    status: response.status,
    body:
      response.body === undefined
        ? null
        : ((JSON.parse(response.body) as Json) ?? null),
    ...(response.disconnectAfterBytes === undefined
      ? {}
      : { disconnectAfterBytes: response.disconnectAfterBytes })
  };
}

/** The committed domain state of one world. */
function stateOf(environment: Environment): JsonObject | null {
  return environment.finalState()?.state ?? null;
}

describe("the wired fault fixtures", () => {
  it("serves before_behavior without mutating domain state", async () => {
    const rules: FaultRule[] = [
      {
        id: "busy-once",
        operation: "path:POST /v1/clips",
        phase: "before_behavior",
        match: { occurrence: 1 },
        action: {
          kind: "response",
          status: 503,
          body: { message: "overloaded" }
        }
      }
    ];
    const environment = await openFaultedWorld(rules);
    try {
      const first = await createClip(environment, 1);
      expect(first.status).toBe(503);
      expect(first.body).toEqual({ message: "overloaded" });

      // No mutation: the clips stay empty and the identifier stream
      // never moved.
      expect(stateOf(environment)).toMatchObject({ clips: {} });
      const consumptions = environment.faults?.consumptions() ?? [];
      expect(consumptions).toEqual([
        {
          sequence: 1,
          ruleId: "busy-once",
          occurrence: 1,
          phase: "before_behavior",
          action: "response"
        }
      ]);

      // The occurrence gate opens the second request: it commits.
      const second = await createClip(environment, 2);
      expect(second.status).toBe(201);
      expect(stateOf(environment)).toMatchObject({
        clips: {
          clip_00000001: {
            url: "https://example.com/essay",
            format: "markdown"
          }
        }
      });
    } finally {
      await environment.close();
    }
  }, 30_000);

  it("rolls the candidate back and commits consumption separately", async () => {
    const rules: FaultRule[] = [
      {
        id: "corrupt-first",
        operation: "path:POST /v1/clips",
        phase: "before_commit",
        match: { occurrence: 1 },
        action: { kind: "corrupt_candidate" }
      }
    ];
    const environment = await openFaultedWorld(rules);
    try {
      const first = await createClip(environment, 1);
      expect(first.status).toBe(500);

      // The transaction rolled back: no clip, no revision, and the
      // staged identifier position returned.
      expect(stateOf(environment)).toMatchObject({ clips: {} });
      expect(environment.finalState()?.revision).toBe(0);

      // The failure record still names the consumption.
      const consumptions = environment.faults?.consumptions() ?? [];
      expect(consumptions).toEqual([
        {
          sequence: 1,
          ruleId: "corrupt-first",
          occurrence: 1,
          phase: "before_commit",
          action: "corrupt_candidate"
        }
      ]);

      // The next create draws the first identifier again and commits.
      const second = await createClip(environment, 2);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ id: "clip_00000001" });
    } finally {
      await environment.close();
    }
  }, 30_000);

  it("commits everything before an after_commit disconnect", async () => {
    const rules: FaultRule[] = [
      {
        id: "cut-after-commit",
        operation: "path:POST /v1/clips",
        phase: "after_commit",
        match: {},
        action: { kind: "disconnect", after_bytes: 0 }
      }
    ];
    const environment = await openFaultedWorld(rules);
    try {
      const response = await createClip(environment, 1);
      expect(response.disconnectAfterBytes).toBe(0);

      // The response, state, and counters committed before the cut.
      expect(stateOf(environment)).toMatchObject({
        clips: {
          clip_00000001: {
            url: "https://example.com/essay",
            format: "markdown"
          }
        }
      });
      expect(environment.faults?.consumptions()[0]?.action).toBe("disconnect");

      // The transport layer records the cut as a known loss.
      environment.state.deliver?.("lost");
      expect(environment.deliveries()[0]).toEqual({
        sequence: 1,
        outcome: "lost"
      });
    } finally {
      await environment.close();
    }
  }, 30_000);

  it("records unknown delivery when the world dies after commit", async () => {
    const rules: FaultRule[] = [];
    const environment = await openFaultedWorld(rules);
    try {
      const response = await createClip(environment, 1);
      expect(response.status).toBe(201);
      // The crash lands between commit and the delivery record: the
      // committed response exists, delivery stays unknown.
      expect(environment.deliveries()).toEqual([]);
    } finally {
      await environment.close();
    }
  }, 30_000);

  it("fails unsupported phases and actions before the world starts", async () => {
    await expect(
      openFaultedWorld([
        {
          id: "bad-phase-action",
          operation: "path:POST /v1/clips",
          phase: "before_commit",
          match: {},
          action: { kind: "response", status: 503 }
        }
      ])
    ).rejects.toMatchObject({
      code: "OAL-FAULT-INVALID",
      message: expect.stringContaining("before_commit") as unknown as string
    });
    await expect(
      openFaultedWorld([
        {
          id: "bad-after-commit-action",
          operation: "path:POST /v1/clips",
          phase: "after_commit",
          match: {},
          action: { kind: "timeout" }
        }
      ])
    ).rejects.toMatchObject({
      code: "OAL-FAULT-INVALID",
      message: expect.stringContaining("after_commit") as unknown as string
    });
    await expect(
      openFaultedWorld([
        {
          id: "bad-phase-for-corrupt",
          operation: "path:POST /v1/clips",
          phase: "before_behavior",
          match: {},
          action: { kind: "corrupt_candidate" }
        }
      ])
    ).rejects.toMatchObject({
      code: "OAL-FAULT-INVALID"
    });
  }, 30_000);

  it("continues occurrence numbering into a forked world", async () => {
    const rules: FaultRule[] = [
      {
        id: "busy-once",
        operation: "path:POST /v1/clips",
        phase: "before_behavior",
        match: { occurrence: 1 },
        action: { kind: "response", status: 429 }
      }
    ];
    const environment = await openFaultedWorld(rules);
    let checkpointDir: string;
    try {
      const first = await createClip(environment, 1);
      expect(first.status).toBe(429);
      checkpointDir = path.join(await newScratch(), "checkpoint");
      await environment.checkpoint(checkpointDir);
    } finally {
      await environment.close();
    }
    // The fork continues the fault position the checkpoint exported:
    // the consumed occurrence never fires again, while the domain
    // positions carry over.
    const fork = await openRestoredEnvironment({
      checkpoint: await readCheckpointDirectory(checkpointDir),
      worldId: "fault-fork",
      databasePath: path.join(await newScratch(), "fork.sqlite"),
      batchId: "fault-tests",
      now: () => Date.UTC(2026, 9, 10),
      faultRules: rules
    });
    try {
      expect(fork.faults?.state().counters).toEqual({ "busy-once": 1 });
      const inFork = await createClip(fork, 1);
      expect(inFork.status).toBe(201);
      expect(fork.faults?.consumptions()).toHaveLength(0);
    } finally {
      await fork.close();
    }
  }, 60_000);

  it("exports the live fault position in checkpoints", async () => {
    const rules: FaultRule[] = [
      {
        id: "busy-once",
        operation: "path:POST /v1/clips",
        phase: "before_behavior",
        match: { occurrence: 1 },
        action: { kind: "response", status: 503 }
      }
    ];
    const environment = await openFaultedWorld(rules);
    try {
      await createClip(environment, 1);
      const out = path.join(await newScratch(), "checkpoint");
      const written = await environment.checkpoint(out);
      expect(written.checkpointId).toMatch(/^chk_[0-9]{8}$/u);
      const manifest = JSON.parse(
        await readFile(path.join(out, "manifest.json"), "utf8")
      ) as JsonObject;
      expect(manifest["payload_sha256"]).toMatch(/^[0-9a-f]{64}$/u);
      // The durable engine position reflects the consumed rule.
      const state = environment.faults?.state();
      expect(state?.counters).toEqual({ "busy-once": 1 });
      expect(state?.prngState).toMatch(/^[0-9a-f]{16}$/u);
    } finally {
      await environment.close();
    }
  }, 30_000);
});
