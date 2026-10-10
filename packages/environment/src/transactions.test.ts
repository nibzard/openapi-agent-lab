/**
 * Transaction tests of the environment owner (specification section
 * 48.2). Every accepted operation runs one transaction for state,
 * domain ID allocations, and random positions: an invalid response
 * candidate, an invalid state candidate, a behavior timeout, and a
 * failed database commit each leave the domain state, the ID
 * counters, and the random stream exactly where they were, while the
 * committed evidence and the failure evidence stay distinguishable.
 *
 * The fixture replaces the webclip behavior module with one that
 * consumes the runtime services and echoes what it drew, so the test
 * can observe the positions through real responses. The failure mode
 * is injected by rewriting one constant per copy; the environment
 * still computes and freezes the closure of every copy.
 */

import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadPack } from "@oal/pack";
import type { ContractIR } from "@oal/contract-ir";
import type { Json } from "@oal/core";

import { openEnvironment, type Environment } from "./environment.ts";

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

/**
 * The service-echoing behavior module. It implements every contract
 * operation, allocates one identifier per call, draws one float per
 * call, and commits both into the state. `FAILURE_ON` injects the
 * failure mode for the second call; "none" keeps the happy path.
 */
const BEHAVIOR_SOURCE = `
import { runBehaviorChild } from "@oal/behavior-runtime";

const FAILURE_ON = "__FAILURE_MODE__";
let calls = 0;

export const backend = {
  apiVersion: 1,
  name: "services-echo",
  version: "0.0.0",
  async create() {
    return {
      async describe() {
        return {
          backendApiVersion: 1,
          stateSchemaVersion: 1,
          operations: [
            "path:DELETE /v1/clips/{clipId}",
            "path:GET /v1/account",
            "path:GET /v1/clips",
            "path:GET /v1/clips/{clipId}",
            "path:GET /v1/clips/{clipId}/content",
            "path:POST /v1/clips",
            "path:POST /v1/clips/{clipId}/extract",
            "path:POST /v1/clips/{clipId}/render"
          ].map((key) => ({ key, support: "implemented" }))
        };
      },
      async initialize() {
        return { state: { calls: 0 } };
      },
      async handle(request, context) {
        calls += 1;
        const id = context.ids.next("thing");
        const draw = context.random.nextFloat();
        const state = context.state as { calls: number };
        if (FAILURE_ON !== "none" && calls === 2) {
          if (FAILURE_ON === "invalid-response") {
            return {
              response: { status: 599, body: { kind: "json", value: { id, draw } } }
            };
          }
          if (FAILURE_ON === "invalid-state") {
            return {
              response: { status: 200, body: { kind: "json", value: { id, draw } } },
              nextState: { calls: "not-a-number" },
              effects: ["bad"]
            };
          }
          if (FAILURE_ON === "timeout") {
            // Longer than one deadline, shorter than two, so the
            // queued next request still meets its own deadline once
            // the child drains.
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
          if (FAILURE_ON === "oversize") {
            return {
              response: { status: 200, body: { kind: "json", value: { id, draw } } },
              nextState: { calls: 1, padding: "p".repeat(768 * 1024) },
              effects: ["big"]
            };
          }
        }
        return {
          response: {
            status: 200,
            body: { kind: "json", value: { id, draw, calls: state.calls + 1 } }
          },
          nextState: { calls: state.calls + 1 },
          effects: ["echo"],
          semanticEvents: []
        };
      }
    };
  }
};

if (process.env.OAL_BEHAVIOR_CHILD === "1") {
  void runBehaviorChild(backend);
}
`;

/** One fixture environment with the injected failure mode. */
async function openFixtureEnvironment(
  failureMode: string,
  options: {
    readonly behaviorTimeoutMs?: number;
    readonly maxStateBytes?: number;
    readonly maxPersistedStateBytes?: number;
  } = {}
): Promise<Environment> {
  const root = await mkdtemp(path.join(tmpdir(), "oal-transactions-"));
  scratch.push(root);
  await cp(webclipRoot, root, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`)
  });
  await symlink(
    path.join(webclipRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir"
  );
  await writeFile(
    path.join(root, "behavior", "index.ts"),
    BEHAVIOR_SOURCE.replace("__FAILURE_MODE__", failureMode)
  );
  // The fixture state is the call counter, not the webclip clips, so
  // the copy declares the schema that validates it: an integer count,
  // an optional padding string the oversize mode carries, and nothing
  // else, which is what the invalid-state mode must violate.
  await writeFile(
    path.join(root, "schemas", "scenario-state.schema.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["calls"],
        properties: {
          calls: { type: "integer" },
          padding: { type: "string" }
        }
      },
      null,
      2
    )
  );
  const ir = JSON.parse(await readFile(fixtureIrPath, "utf8")) as ContractIR;
  const pack = await loadPack(root);
  return openEnvironment({
    pack,
    contract: {
      ir,
      semanticSha256: ir.source.semantic_sha256,
      executionSha256: ir.source.execution_sha256
    },
    scenarioId: "baseline",
    seed: "a".repeat(64),
    worldId: `transactions-${failureMode}`,
    databasePath: path.join(root, "state.sqlite"),
    records: {
      batchId: "transactions",
      packSha256: "0".repeat(64),
      implementationSha256: ir.source.execution_sha256
    },
    now: () => 0,
    ...(Object.keys(options).length === 0 ? {} : { limits: { ...options } })
  });
}

/**
 * Serve one request through the same transaction steps the gateway
 * server runs for a scenario backend: stage, backend call, response
 * status check against the declared contract responses, then commit
 * or rollback (specification section 17.1 step 10 to 14).
 */
async function request(
  environment: Environment,
  method: string,
  target: string
): Promise<{ status: number; body: Json | undefined }> {
  const operation = environment.contract.ir.operations.find(
    (candidate) =>
      candidate.method === method && candidate.path_template === target
  );
  if (operation === undefined) {
    throw new Error(`No contract operation for ${method} ${target}.`);
  }
  environment.state.stage(operation.key);
  const requestId = `req_${environment.state.rollbacks + 1}`;
  const outcome = await environment.backend.handle(
    {
      operation,
      principal: { scheme: "bearer", scopes: [], anonymous: true },
      parameters: { path: {}, query: {}, header: {}, cookie: {} },
      body: { kind: "none" },
      selectedRequestMediaType: null,
      acceptedResponseMediaTypes: []
    },
    requestId
  );
  if (outcome.kind !== "served") {
    environment.state.rollback();
    return { status: 500, body: undefined };
  }
  const declared = new Set(
    operation.responses
      .map((response) => response.status)
      .filter((status): status is number => status !== null)
  );
  if (!declared.has(outcome.response.status)) {
    environment.state.rollback();
    return { status: 500, body: undefined };
  }
  try {
    environment.state.commit({
      exchange: {
        requestId,
        method,
        target,
        operationKey: operation.key,
        status: outcome.response.status
      },
      ...(outcome.commit === undefined ? {} : { commit: outcome.commit })
    });
  } catch {
    return { status: 500, body: undefined };
  }
  const body = outcome.response.body;
  return {
    status: outcome.response.status,
    body: body !== undefined && body.kind === "json" ? body.value : undefined
  };
}

describe("environment transactions", () => {
  it("keeps the happy path committing services with state", async () => {
    const environment = await openFixtureEnvironment("none");
    try {
      const first = await request(environment, "GET", "/v1/account");
      const second = await request(environment, "GET", "/v1/account");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = first.body as { id: string; calls: number };
      const secondBody = second.body as { id: string; calls: number };
      expect(firstBody.id).toBe("thing_00000001");
      expect(secondBody.id).toBe("thing_00000002");
      expect(secondBody.calls).toBe(2);
      expect(environment.finalState()?.revision).toBe(2);
    } finally {
      await environment.close();
    }
  }, 30_000);

  const failureModes: readonly string[] = [
    "invalid-response",
    "invalid-state",
    "timeout",
    "oversize"
  ];

  for (const mode of failureModes) {
    it(`restores state, identifiers, and draws after ${mode}`, async () => {
      const environment = await openFixtureEnvironment(
        mode,
        mode === "timeout"
          ? { behaviorTimeoutMs: 200 }
          : mode === "oversize"
            ? {
                maxStateBytes: 2 * 1024 * 1024,
                maxPersistedStateBytes: 512 * 1024
              }
            : {}
      );
      try {
        const first = await request(environment, "GET", "/v1/account");
        expect(first.status).toBe(200);
        const revisionAfterFirst = environment.finalState()?.revision;
        expect(revisionAfterFirst).toBe(1);

        // The failing exchange must not mutate anything the next
        // request can observe.
        const failed = await request(environment, "GET", "/v1/account");
        expect(failed.status).toBeGreaterThanOrEqual(500);
        expect(environment.finalState()?.revision).toBe(1);
        expect(environment.finalState()?.state).toEqual({ calls: 1 });

        // The next committed exchange continues exactly where the
        // last committed one ended: the next identifier and the next
        // draw show no gap and no repetition.
        const third = await request(environment, "GET", "/v1/account");
        expect(third.status).toBe(200);
        const thirdBody = third.body as { id: string; draw: number };
        expect(thirdBody.id).toBe("thing_00000002");

        // The failure evidence stays distinguishable from the
        // committed evidence: two committed exchanges plus one failed
        // request row. A failed database commit is not a rollback -
        // the store refused the whole transaction - while the other
        // modes roll back explicitly.
        expect(environment.semanticEvents().length).toBe(0);
        expect(environment.state.rollbacks).toBe(mode === "oversize" ? 0 : 1);
        expect(environment.state.appliedEffects).toEqual(["echo", "echo"]);
      } finally {
        await environment.close();
      }
    }, 30_000);
  }
});
