/**
 * Frozen response semantics for the Steel Computer pack (specification
 * section 39.5, migration sequence step 1 of section 39.7).
 *
 * The scripted request set replays every one of the 41 operations
 * through the pure gateway pipeline with the pack response fixtures.
 * The frozen status table is the golden trace of pack version 0.1.0:
 * every status is an exact expected value. Twenty-seven operations
 * serve a declared success response and fourteen serve the neutral
 * `mock_behavior_unavailable` framework problem, because their success
 * schemas carry a date-time pattern that deterministic generation
 * refuses. See packs/steel-computer/PARITY.md and migration notes
 * drift items 17 and 18.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { canonicalJson, type Json } from "@oal/core";
import type { OperationIR } from "@oal/contract-ir";
import type { GatewayResponse, RawRequest } from "@oal/gateway";
import type { CompileResult } from "@oal/openapi";
import {
  BuiltinMockAdapter,
  serializeMockResponse,
  verifyDeterminism
} from "@oal/mock-contract";

import {
  compilePackContract,
  loadSteelPack,
  type PackForTest
} from "./index.ts";
import {
  gatewayRecord,
  packResponseFixtures,
  parityApiKey,
  parityGatewayOptions,
  runScriptedSet,
  scriptedSteelRequests,
  STEEL_API_KEY_HEADER
} from "./steel-parity.ts";

/**
 * The golden status of every operation. The table records what the
 * contract pipeline serves, not an aspiration: 2xx values come from
 * the declared responses of the pack contract, and 501 marks the
 * neutral framework problem where contract mode has no response value.
 */
const GOLDEN_STATUSES: Readonly<Record<string, number>> = {
  "path:DELETE /v1/credentials": 200,
  "path:DELETE /v1/extensions": 200,
  "path:DELETE /v1/extensions/{extensionId}": 200,
  "path:DELETE /v1/files/{path}": 204,
  "path:DELETE /v1/sessions/{sessionId}/files": 204,
  "path:DELETE /v1/sessions/{sessionId}/files/{path}": 204,
  "path:GET /.well-known/jwks.json": 200,
  "path:GET /v1/credentials": 501,
  "path:GET /v1/extensions": 200,
  "path:GET /v1/extensions/{extensionId}": 200,
  "path:GET /v1/files": 501,
  "path:GET /v1/files/{path}": 200,
  "path:GET /v1/profiles": 501,
  "path:GET /v1/profiles/{id}": 501,
  "path:GET /v1/sessions": 200,
  "path:GET /v1/sessions/{id}": 501,
  "path:GET /v1/sessions/{id}/context": 200,
  "path:GET /v1/sessions/{id}/events": 501,
  "path:GET /v1/sessions/{id}/hls": 200,
  "path:GET /v1/sessions/{id}/live-details": 200,
  "path:GET /v1/sessions/{sessionId}/captchas/status": 200,
  "path:GET /v1/sessions/{sessionId}/files": 501,
  "path:GET /v1/sessions/{sessionId}/files.zip": 200,
  "path:GET /v1/sessions/{sessionId}/files/{path}": 200,
  "path:PATCH /v1/profiles/{id}": 501,
  "path:POST /v1/credentials": 501,
  "path:POST /v1/extensions": 201,
  "path:POST /v1/files": 501,
  "path:POST /v1/pdf": 200,
  "path:POST /v1/profiles": 501,
  "path:POST /v1/scrape": 200,
  "path:POST /v1/screenshot": 200,
  "path:POST /v1/sessions": 501,
  "path:POST /v1/sessions/release": 200,
  "path:POST /v1/sessions/{id}/release": 200,
  "path:POST /v1/sessions/{sessionId}/captchas/solve": 200,
  "path:POST /v1/sessions/{sessionId}/captchas/solve-image": 200,
  "path:POST /v1/sessions/{sessionId}/computer": 200,
  "path:POST /v1/sessions/{sessionId}/files": 501,
  "path:PUT /v1/credentials": 501,
  "path:PUT /v1/extensions/{extensionId}": 200
};

/** Operations whose success schema blocks deterministic generation. */
const GOLDEN_FRAMEWORK_OUTCOMES = 14;

/** The fixture-backed operations and their provenance of record. */
const GOLDEN_FIXTURES: Readonly<Record<string, string>> = {
  "path:GET /.well-known/jwks.json": "fixture:jwks-empty",
  "path:GET /v1/sessions": "fixture:sessions-list-empty",
  "path:GET /v1/sessions/{sessionId}/captchas/status":
    "fixture:captcha-status-idle"
};

let pack: PackForTest;
let compiled: CompileResult;
let requests: readonly { operation: OperationIR; raw: RawRequest }[];
let responses: readonly GatewayResponse[];

beforeAll(async () => {
  pack = await loadSteelPack();
  compiled = await compilePackContract(pack.loaded);
  const fixtures = await packResponseFixtures(
    pack.loaded.root,
    pack.loaded.manifest
  );
  const apiKey = parityApiKey(compiled.contract);
  requests = scriptedSteelRequests(compiled.contract, apiKey);
  responses = runScriptedSet(
    parityGatewayOptions(compiled.contract, fixtures),
    requests
  );
});

describe("the frozen Steel golden trace", () => {
  it("covers every one of the 41 operations", () => {
    expect(Object.keys(GOLDEN_STATUSES)).toHaveLength(41);
    expect([...pack.validation.coverage.contractOperations].sort()).toEqual(
      Object.keys(GOLDEN_STATUSES).sort()
    );
    expect(requests).toHaveLength(41);
    expect(responses).toHaveLength(41);
  });

  it("serves the frozen status for every operation", () => {
    let framework = 0;
    responses.forEach((response, index) => {
      const key = requests[index]?.operation.key ?? "<missing>";
      expect(response.status, key).toBe(GOLDEN_STATUSES[key]);
      if (response.frameworkCode !== null) {
        framework += 1;
        expect(response.frameworkCode, key).toBe("mock_behavior_unavailable");
        expect(response.headers["content-type"]).toBe(
          "application/problem+json"
        );
      } else {
        const declared = compiled.contract.operations
          .find((operation) => operation.key === key)
          ?.responses.filter((entry) => entry.status !== null)
          .map((entry) => entry.status);
        expect(declared, key).toContain(response.status);
      }
    });
    expect(framework).toBe(GOLDEN_FRAMEWORK_OUTCOMES);
  });

  it("is byte-identical across two runs", async () => {
    const fixtures = await packResponseFixtures(
      pack.loaded.root,
      pack.loaded.manifest
    );
    const apiKey = parityApiKey(compiled.contract);
    const second = runScriptedSet(
      parityGatewayOptions(compiled.contract, fixtures),
      scriptedSteelRequests(compiled.contract, apiKey)
    );
    expect(second.map(gatewayRecord)).toEqual(responses.map(gatewayRecord));
    expect(new Set(responses.map(gatewayRecord)).size).toBe(41);
  });

  it("answers the three fixture-backed operations from the fixtures", () => {
    for (const [key, provenance] of Object.entries(GOLDEN_FIXTURES)) {
      const index = requests.findIndex((entry) => entry.operation.key === key);
      const response = responses[index];
      expect(response, key).toBeDefined();
      expect(response?.provenance).toBe(provenance);
      expect(response?.frameworkCode).toBeNull();
      expect(response?.headers["content-type"]).toBe(
        "application/json; charset=utf-8"
      );
    }
  });

  it("serves the pack fixture bytes exactly as the file holds them", async () => {
    const source = JSON.parse(
      await readFile(
        path.join(pack.loaded.root, "fixtures", "sessions-list.json"),
        "utf8"
      )
    ) as Json;
    const index = requests.findIndex(
      (entry) => entry.operation.key === "path:GET /v1/sessions"
    );
    const body = responses[index]?.body;
    expect(body).toBe(canonicalJson(source));
  });

  it("stays deterministic through the built-in mock adapter", async () => {
    const fixtures = await packResponseFixtures(
      pack.loaded.root,
      pack.loaded.manifest
    );
    const adapter = new BuiltinMockAdapter(fixtures);
    const apiKey = parityApiKey(compiled.contract);
    const candidates = scriptedSteelRequests(compiled.contract, apiKey).map(
      ({ operation }) => ({
        contract: compiled.contract,
        seed: "steel-parity-adapter",
        request: {
          operationKey: operation.key,
          pathParameters: {},
          query: {},
          headers: { [STEEL_API_KEY_HEADER]: apiKey },
          cookies: {},
          body: undefined,
          contentType: null,
          accept: "application/json"
        }
      })
    );
    const result = verifyDeterminism(adapter, candidates);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(41);
    const served = candidates
      .map((candidate) => adapter.respond(candidate))
      .filter((response): response is NonNullable<typeof response> => {
        return response !== null;
      });
    expect(served).toHaveLength(41 - GOLDEN_FRAMEWORK_OUTCOMES);
    expect(served.map(serializeMockResponse)).toHaveLength(
      41 - GOLDEN_FRAMEWORK_OUTCOMES
    );
  });
});
