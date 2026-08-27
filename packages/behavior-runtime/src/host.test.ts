import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractIR, OperationIR } from "@oal/contract-ir";
import { createNamespacePrng, VirtualClock } from "@oal/state-store";
import {
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "./adapters.ts";
import { BehaviorModuleHost } from "./host.ts";

const RUN_SEED_A = "a".repeat(64);
const RUN_SEED_B = "b".repeat(64);

const fixtureEntry = fileURLToPath(
  new URL("./child.fixture.ts", import.meta.url)
);

function operation(): OperationIR {
  return {
    key: "path:POST /count",
    uid: "op_count1",
    surface: "path",
    method: "POST",
    path_template: "/count",
    route_segments: [{ kind: "literal", value: "count" }],
    operation_id: null,
    tool_name: "count",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    request_body: null,
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function contract(): ContractIR {
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal", version: "0.1.0" },
    source: {
      entrypoint: "openapi.yaml",
      media_type: "application/yaml",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {},
    schemas: {},
    operations: [],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

describe("BehaviorModuleHost", () => {
  it("describes, initializes, handles serially, and closes", async () => {
    const packRoot = await mkdtemp(join(tmpdir(), "oal-pack-"));
    const blobs = fileBlobStore(join(packRoot, ".oal", "blobs"));
    const host = new BehaviorModuleHost({
      entry: fixtureEntry,
      context: { contract: contract(), packRoot, config: {} },
      runSeed: RUN_SEED_A,
      timeoutMs: 30_000
    });
    await host.start();
    try {
      const description = await host.describe();
      expect(description.backendApiVersion).toBe(1);
      expect(description.operations[0]?.key).toBe("path:POST /count");

      const clock = new VirtualClock({ initialMs: 0 });
      const initialized = await host.initialize({
        runId: "run_host",
        fixtures: [],
        clock: clockAdapter(clock),
        ids: idsAdapter(),
        random: randomAdapter(createNamespacePrng(RUN_SEED_A, "host-test")),
        blobs
      });
      expect(initialized.state).toEqual({ count: 0 });

      let state = initialized.state;
      for (const expected of [1, 2, 3]) {
        const result = await host.handle(
          {
            operation: operation(),
            principal: null,
            parameters: { path: {}, query: {}, header: {}, cookie: {} },
            body: { kind: "none" },
            selectedRequestMediaType: null,
            acceptedResponseMediaTypes: []
          },
          {
            runId: "run_host",
            requestId: `req_${expected.toString(10).padStart(8, "0")}`,
            state,
            clock: clockAdapter(clock),
            ids: idsAdapter(),
            random: randomAdapter(createNamespacePrng(RUN_SEED_A, "host-test")),
            blobs
          }
        );
        expect(result.response.status).toBe(200);
        expect(result.response.body).toEqual({
          kind: "json",
          value: { count: expected }
        });
        state = result.nextState ?? state;
        expect(state).toEqual({ count: expected });
      }
    } finally {
      await host.close();
      await rm(packRoot, { recursive: true, force: true });
    }
  });

  it("propagates a declared HTTP error from the child", async () => {
    const packRoot = await mkdtemp(join(tmpdir(), "oal-pack-"));
    const blobs = fileBlobStore(join(packRoot, ".oal", "blobs"));
    const host = new BehaviorModuleHost({
      entry: fixtureEntry,
      context: { contract: contract(), packRoot, config: {} },
      runSeed: RUN_SEED_B,
      timeoutMs: 30_000
    });
    await host.start();
    try {
      const clock = clockAdapter(new VirtualClock({ initialMs: 0 }));
      const initialized = await host.initialize({
        runId: "run_host",
        fixtures: [],
        clock,
        ids: idsAdapter(),
        random: randomAdapter(createNamespacePrng(RUN_SEED_B, "host-test")),
        blobs
      });
      const caught = await host
        .handle(
          {
            operation: operation(),
            principal: null,
            parameters: { path: {}, query: {}, header: {}, cookie: {} },
            body: { kind: "json", value: { fail: true } },
            selectedRequestMediaType: "application/json",
            acceptedResponseMediaTypes: []
          },
          {
            runId: "run_host",
            requestId: "req_00000002",
            state: initialized.state,
            clock,
            ids: idsAdapter(),
            random: randomAdapter(createNamespacePrng(RUN_SEED_B, "host-test")),
            blobs
          }
        )
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toMatchObject({
        name: "BehaviorHttpError",
        status: 400,
        code: "fixture_refused"
      });
    } finally {
      await host.close();
      await rm(packRoot, { recursive: true, force: true });
    }
  });
});
