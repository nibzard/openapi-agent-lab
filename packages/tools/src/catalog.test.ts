/**
 * Integration test for the two exposure interfaces of specification section
 * 18. One hand-built ContractIR drives direct naming and the whole catalog
 * round trip: search finds an operation, describe explains it, invoke runs
 * it through the bridge.
 */

import { describe, expect, it } from "vitest";

import { operationUid } from "@oal/core";

import { computerContract } from "./contract.fixture.ts";
import { buildToolDescription } from "./description.ts";
import { describeOperation } from "./describe.ts";
import {
  encodeBinaryBody,
  type InvocationEnvelope,
  type InvocationResult
} from "./envelope.ts";
import { CatalogInvokeBridge, type InvocationTarget } from "./invoke.ts";
import { buildDirectToolMap, namingCandidates } from "./naming.ts";
import { searchOperations } from "./search.ts";

const CONTRACT = computerContract();

/** The direct map over the whole fixture contract. */
function directMap(): ReturnType<typeof buildDirectToolMap> {
  return buildDirectToolMap(namingCandidates(CONTRACT.operations));
}

/** Gateway stand-in: it records calls and answers from a script. */
class ScriptedGateway implements InvocationTarget {
  readonly envelopes: Array<{ operation: string; body: unknown }> = [];

  execute(envelope: InvocationEnvelope): InvocationResult {
    this.envelopes.push({ operation: envelope.operation, body: envelope.body });
    if (envelope.operation === "path:GET /v1/computers/{computer_id}") {
      const rawId: unknown = envelope.parameters.path.computer_id;
      const id = typeof rawId === "string" ? rawId : "";
      return {
        status: 200,
        headers: [{ name: "content-type", values: ["application/json"] }],
        body: { id, label: "rack-1-node-4", status: "ready" },
        contentType: "application/json",
        requestId: "req_00000011"
      };
    }
    if (envelope.operation === "path:POST /v1/computers") {
      return {
        status: 201,
        headers: [
          { name: "content-type", values: ["application/json"] },
          { name: "location", values: ["/v1/computers/17"] }
        ],
        body: { id: 17, label: "rack-1-node-4", status: "ready" },
        contentType: "application/json",
        requestId: "req_00000012"
      };
    }
    return {
      status: 204,
      headers: [],
      body: undefined,
      contentType: null,
      requestId: "req_00000013"
    };
  }
}

describe("direct tool exposure", () => {
  it("gives every operation one stable, grammar-valid tool name", () => {
    const map = directMap();
    expect(map.toolToOperation.size).toBe(CONTRACT.operations.length);
    expect(map.collisions).toEqual([]);
    for (const assignment of map.assignments) {
      expect(assignment.toolName).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    }
    expect(map.toolToOperation.get("createComputer")).toBe(
      "path:POST /v1/computers"
    );
    expect(map.toolToOperation.get("get_v1_computers_by_computer_id")).toBe(
      "path:GET /v1/computers/{computer_id}"
    );
    expect(map.digest).toBe(directMap().digest);
  });

  it("describes every direct tool without trusting contract prose", () => {
    const map = directMap();
    for (const candidate of namingCandidates(CONTRACT.operations)) {
      expect(
        map.assignments.filter((entry) => entry.key === candidate.key)
      ).toHaveLength(1);
      const described = buildToolDescription({
        method: candidate.method,
        pathTemplate: candidate.pathTemplate,
        operationId: candidate.operationId,
        summary:
          CONTRACT.operations.find((entry) => entry.key === candidate.key)
            ?.summary ?? null,
        description:
          CONTRACT.operations.find((entry) => entry.key === candidate.key)
            ?.description ?? null
      });
      expect(described.text.length).toBeLessThanOrEqual(1000);
      expect(described.text).toContain("Untrusted contract description: ");
      expect(described.text).toContain("never pass credentials");
    }
  });
});

describe("catalog round trip", () => {
  it("walks search, describe, and invoke over one contract", async () => {
    const found = searchOperations(CONTRACT, {
      query: "delete a computer",
      limit: 3
    });
    const top = found.results[0];
    if (top === undefined) {
      throw new Error("The search returned nothing.");
    }
    expect(top.key).toBe("path:DELETE /v1/computers/{computer_id}");

    const explained = describeOperation(CONTRACT, {
      operation: top.key,
      detail: "full"
    });
    expect(explained.deprecated).toBe(true);
    expect(explained.parameters.path.map((entry) => entry.name)).toEqual([
      "computer_id"
    ]);

    const gateway = new ScriptedGateway();
    const bridge = new CatalogInvokeBridge({
      contract: CONTRACT,
      target: gateway
    });
    const report = await bridge.invoke({
      operation: explained.key,
      parameters: { path: { computer_id: "17" } }
    });
    expect(report.result.status).toBe(204);
    expect(report.operation.uid).toBe(operationUid(explained.key));
    expect(gateway.envelopes).toHaveLength(1);
    expect(gateway.envelopes[0]?.operation).toBe(explained.key);
  });

  it("serves a direct tool name through the same envelope", async () => {
    const map = directMap();
    const createKey = map.toolToOperation.get("createComputer");
    if (createKey === undefined) {
      throw new Error("The direct map is missing createComputer.");
    }
    const gateway = new ScriptedGateway();
    const bridge = new CatalogInvokeBridge({
      contract: CONTRACT,
      target: gateway,
      transport: "mcp-direct"
    });
    const report = await bridge.invoke({
      operation: createKey,
      parameters: {},
      contentType: "application/json",
      accept: ["application/json"],
      body: { label: "rack-1-node-4" }
    });
    expect(report.transport).toBe("mcp-direct");
    expect(report.result.status).toBe(201);
    expect(gateway.envelopes[0]?.operation).toBe(createKey);
    expect(gateway.envelopes[0]?.body).toEqual({ label: "rack-1-node-4" });
  });

  it("carries a binary answer with its digest", async () => {
    const payload = encodeBinaryBody(
      new Uint8Array([104, 101, 97, 108, 116, 104]),
      "text/plain"
    );
    const gateway: InvocationTarget = {
      execute: () => ({
        status: 200,
        headers: [{ name: "content-type", values: ["text/plain"] }],
        body: payload,
        contentType: "text/plain",
        requestId: "req_00000014"
      })
    };
    const bridge = new CatalogInvokeBridge({
      contract: CONTRACT,
      target: gateway
    });
    const report = await bridge.invoke({ operation: "path:GET /health" });
    expect(report.result.body).toEqual(payload);
    expect(report.truncation).toBeUndefined();
  });
});
