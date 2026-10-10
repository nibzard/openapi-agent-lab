/**
 * Runtime corpus checks for the idem-runtime pack (specification
 * sections 17.3 and 48.6). The pack declares one idempotency policy;
 * these tests drive the real environment - gateway, sealed store,
 * virtual clock, and wired faults - through the public request
 * pipeline and pin every observable behavior: same-key replay,
 * same-key conflict, principal separation, expiry on virtual time,
 * lost-response retry, and the fault sequence plus replay store
 * continuing after restart and in both forks of one checkpoint.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Json, JsonObject } from "@oal/core";
import {
  openEnvironment,
  openRestoredEnvironment,
  readCheckpointDirectory,
  idempotencyPoliciesOf,
  type Environment
} from "@oal/environment";
import type { FaultRule } from "@oal/behavior-api";
import { handleGatewayRequest, mintRunCredentials } from "@oal/gateway";

import {
  compilePackContract,
  loadIdemRuntimePack,
  type PackForTest
} from "./index.ts";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function newScratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-idem-"));
  scratch.push(dir);
  return dir;
}

const RUN_SEED = "b".repeat(64);

/** The limits the pipeline reads, generous for tests. */
const LIMITS = {
  maxRequestTargetBytes: 16 * 1024,
  maxRequestHeaderBytes: 32 * 1024,
  maxRequestBodyBytes: 5 * 1024 * 1024,
  maxMultipartParts: 100,
  maxGeneratedResponseBodyBytes: 10 * 1024 * 1024
} as never;

type ContractInputs = Parameters<typeof openEnvironment>[0]["contract"];

let cached: {
  readonly pack: PackForTest["loaded"];
  readonly contract: ContractInputs;
} | null = null;

/** Load the pack once; the frozen inputs are identical every time. */
async function packInputs(): Promise<{
  readonly pack: PackForTest["loaded"];
  readonly contract: ContractInputs;
}> {
  if (cached === null) {
    const pack = (await loadIdemRuntimePack()).loaded;
    const compiled = await compilePackContract(pack);
    cached = {
      pack,
      contract: {
        ir: compiled.contract,
        semanticSha256: compiled.contract.source.semantic_sha256,
        executionSha256: compiled.contract.source.execution_sha256
      }
    };
  }
  return { pack: cached.pack, contract: cached.contract };
}

/** Open one idem-runtime world, optionally with declared faults. */
async function openWorld(
  faultRules?: readonly FaultRule[],
  databasePath?: string
): Promise<Environment> {
  const { pack, contract } = await packInputs();
  return openEnvironment({
    pack,
    contract,
    scenarioId: "baseline",
    seed: RUN_SEED,
    worldId: "idem-world",
    databasePath: databasePath ?? path.join(await newScratch(), "state.sqlite"),
    records: {
      batchId: "idem-tests",
      packSha256: "0".repeat(64),
      implementationSha256: contract.executionSha256
    },
    now: () => Date.UTC(2026, 9, 10),
    ...(faultRules === undefined ? {} : { faultRules })
  });
}

/** One authorized request through the full pipeline. */
async function request(
  environment: Environment,
  sequence: number,
  init: {
    readonly method?: "POST" | "GET";
    readonly target?: string;
    readonly idempotencyKey?: string;
    readonly input?: string;
    readonly auth?: "bearer" | "basic";
  } = {}
): Promise<{
  status: number;
  body: Json | null;
  headers: Record<string, string>;
  disconnectAfterBytes?: number;
}> {
  const method = init.method ?? "POST";
  const minted = mintRunCredentials(environment.contract.ir, RUN_SEED);
  const authorization =
    init.auth === "basic"
      ? `Basic ${Buffer.from(
          `${minted.basic.username}:${minted.basic.password}`,
          "utf8"
        ).toString("base64")}`
      : `Bearer ${minted.bearer}`;
  const headers: Record<string, string> = {
    authorization,
    "content-type": "application/json"
  };
  if (init.idempotencyKey !== undefined) {
    headers["idempotency-key"] = init.idempotencyKey;
  }
  const target = init.target ?? "/v1/jobs";
  const body =
    init.input === undefined
      ? new Uint8Array(0)
      : new TextEncoder().encode(JSON.stringify({ text: init.input }));
  const response = await handleGatewayRequest(
    {
      contract: environment.contract.ir,
      limits: LIMITS,
      runSeed: RUN_SEED,
      state: environment.state,
      backend: environment.backend,
      faults: environment.faults ?? undefined,
      idempotency: environment.idempotency ?? undefined
    } as Parameters<typeof handleGatewayRequest>[0],
    sequence,
    { method, target, headers, body }
  );
  return {
    status: response.status,
    body:
      response.body === undefined
        ? null
        : ((JSON.parse(response.body) as Json) ?? null),
    headers: response.headers,
    ...(response.disconnectAfterBytes === undefined
      ? {}
      : { disconnectAfterBytes: response.disconnectAfterBytes })
  };
}

/** The committed domain state of one world. */
function stateOf(environment: Environment): JsonObject | null {
  return environment.finalState()?.state ?? null;
}

/** The disconnect fault that cuts the first create only. */
const CUT_FIRST_CREATE: FaultRule = {
  id: "cut-first-create",
  operation: "path:POST /v1/jobs",
  phase: "after_commit",
  match: { occurrence: 1 },
  action: { kind: "disconnect", after_bytes: 0 }
};

describe("the wired idempotency runtime", () => {
  it("replays the sealed response without running behavior again", async () => {
    const environment = await openWorld();
    try {
      const first = await request(environment, 1, {
        idempotencyKey: "replay-key",
        input: "same input"
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        id: "job_00000001",
        text: "same input"
      });

      // The same key, body, and principal replays the sealed response:
      // byte-identical body, no second job, no revision move, and the
      // cache still holds exactly one entry.
      const revision = environment.finalState()?.revision ?? 0;
      const second = await request(environment, 2, {
        idempotencyKey: "replay-key",
        input: "same input"
      });
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers["content-type"]).toContain("application/json");
      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001"]
      });
      expect(environment.finalState()?.revision).toBe(revision);
      expect(environment.idempotency?.count()).toBe(1);

      // The replayed job reads back through the normal path.
      const read = await request(environment, 3, {
        method: "GET",
        target: "/v1/jobs/job_00000001"
      });
      expect(read.status).toBe(200);
      expect(read.body).toEqual(first.body);
    } finally {
      await environment.close();
    }
  }, 60_000);

  it("answers a reused key with a different body as a conflict", async () => {
    const environment = await openWorld();
    try {
      const first = await request(environment, 1, {
        idempotencyKey: "conflict-key",
        input: "original input"
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ id: "job_00000001" });

      const second = await request(environment, 2, {
        idempotencyKey: "conflict-key",
        input: "a different input"
      });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: "idempotency_conflict" });

      // The conflict created nothing: the domain keeps one job.
      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001"]
      });
    } finally {
      await environment.close();
    }
  }, 60_000);

  it("separates the caches of two verified principals", async () => {
    const environment = await openWorld();
    try {
      const bearer = await request(environment, 1, {
        idempotencyKey: "shared-key",
        input: "same input",
        auth: "bearer"
      });
      expect(bearer.status).toBe(201);
      expect(bearer.body).toMatchObject({ id: "job_00000001" });

      // The same key under the basic credential is a different
      // principal: a new job, not a replay and not a conflict.
      const basic = await request(environment, 2, {
        idempotencyKey: "shared-key",
        input: "same input",
        auth: "basic"
      });
      expect(basic.status).toBe(201);
      expect(basic.body).toMatchObject({ id: "job_00000002" });

      // Each principal replays its own entry.
      const bearerAgain = await request(environment, 3, {
        idempotencyKey: "shared-key",
        input: "same input",
        auth: "bearer"
      });
      expect(bearerAgain.body).toEqual(bearer.body);
      const basicAgain = await request(environment, 4, {
        idempotencyKey: "shared-key",
        input: "same input",
        auth: "basic"
      });
      expect(basicAgain.body).toEqual(basic.body);

      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001", "job_00000002"]
      });
      expect(environment.idempotency?.count()).toBe(2);
    } finally {
      await environment.close();
    }
  }, 60_000);

  it("expires entries on virtual time without sleeping", async () => {
    const environment = await openWorld();
    try {
      const first = await request(environment, 1, {
        idempotencyKey: "expiry-key",
        input: "before expiry"
      });
      expect(first.body).toMatchObject({ id: "job_00000001" });

      // The policy declares one hour. Advancing the clock past it -
      // no sleeping - retires the entry, so the same key creates a
      // new job instead of replaying.
      await environment.advanceTime(3_600_001);
      const second = await request(environment, 2, {
        idempotencyKey: "expiry-key",
        input: "before expiry"
      });
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ id: "job_00000002" });
      expect(second.body).not.toEqual(first.body);
      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001", "job_00000002"]
      });
      expect(environment.idempotency?.count()).toBe(1);

      // Inside the window the fresh entry still replays.
      const third = await request(environment, 3, {
        idempotencyKey: "expiry-key",
        input: "before expiry"
      });
      expect(third.body).toEqual(second.body);
    } finally {
      await environment.close();
    }
  }, 60_000);

  it("replays a response the transport already lost", async () => {
    const environment = await openWorld([CUT_FIRST_CREATE]);
    try {
      const first = await request(environment, 1, {
        idempotencyKey: "lost-key",
        input: "lost then retried"
      });
      // The transport cut after zero bytes, but everything committed:
      // the job, the state, the sealed response.
      expect(first.disconnectAfterBytes).toBe(0);
      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001"]
      });
      environment.state.deliver?.("lost");
      expect(environment.deliveries()[0]).toEqual({
        sequence: 1,
        outcome: "lost"
      });

      // The retry replays the committed response: same job, no new
      // state, and the fault occurrence gate stays open because the
      // rule fired once already.
      const retry = await request(environment, 2, {
        idempotencyKey: "lost-key",
        input: "lost then retried"
      });
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({ id: "job_00000001" });
      expect(retry.disconnectAfterBytes).toBeUndefined();
      expect(stateOf(environment)).toMatchObject({
        order: ["job_00000001"]
      });
      expect(environment.idempotency?.count()).toBe(1);
    } finally {
      await environment.close();
    }
  }, 60_000);

  it("continues the fault sequence and the replay store after restart and in both forks", async () => {
    const { pack } = await packInputs();
    const policies = idempotencyPoliciesOf(pack.manifest);
    expect(policies).toHaveLength(1);

    // One world: the first create commits and cuts, the retry replays.
    const environment = await openWorld([CUT_FIRST_CREATE]);
    let checkpointDir: string;
    try {
      const cut = await request(environment, 1, {
        idempotencyKey: "fork-key",
        input: "carried across the checkpoint"
      });
      expect(cut.disconnectAfterBytes).toBe(0);
      environment.state.deliver?.("lost");
      checkpointDir = path.join(await newScratch(), "checkpoint");
      await environment.checkpoint(checkpointDir);
    } finally {
      await environment.close();
    }

    // Both forks of the same checkpoint continue the durable
    // position: the replay store serves the stored response, the fault
    // occurrence stays consumed, and new keys draw the next job id.
    for (const forkId of ["fork-a", "fork-b"]) {
      const fork = await openRestoredEnvironment({
        checkpoint: await readCheckpointDirectory(checkpointDir),
        worldId: forkId,
        databasePath: path.join(await newScratch(), `${forkId}.sqlite`),
        batchId: "idem-tests",
        now: () => Date.UTC(2026, 9, 10),
        faultRules: [CUT_FIRST_CREATE],
        idempotencyPolicies: policies
      });
      try {
        const replayed = await request(fork, 1, {
          idempotencyKey: "fork-key",
          input: "carried across the checkpoint"
        });
        expect(replayed.status).toBe(201);
        expect(replayed.body).toMatchObject({ id: "job_00000001" });
        expect(replayed.disconnectAfterBytes).toBeUndefined();
        expect(fork.idempotency?.count()).toBe(1);

        // A new key creates the next job; the disconnect rule fired
        // for occurrence one only, so nothing cuts here.
        const fresh = await request(fork, 2, {
          idempotencyKey: `${forkId}-new-key`,
          input: "a new job in the fork"
        });
        expect(fresh.status).toBe(201);
        expect(fresh.body).toMatchObject({ id: "job_00000002" });
        expect(stateOf(fork)).toMatchObject({
          order: ["job_00000001", "job_00000002"]
        });
        expect(fork.faults?.consumptions()).toHaveLength(0);
        // The occurrence numbering continued: the fork's consult moved
        // the counter to 2, past the consumed occurrence, instead of
        // restarting at 1 and firing the disconnect again.
        expect(fork.faults?.state().counters).toEqual({
          "cut-first-create": 2
        });
      } finally {
        await fork.close();
      }
    }
  }, 120_000);
});
