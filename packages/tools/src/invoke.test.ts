import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";

import { computerContract } from "./contract.fixture.ts";
import {
  encodeBinaryBody,
  PROTECTED_AUTH_PARAMETER,
  type InvocationEnvelope,
  type InvocationResult,
  type TruncationPolicy
} from "./envelope.ts";
import {
  CatalogInvokeBridge,
  MCP_TRANSPORT_KINDS,
  toEnvelope,
  type CatalogInvokeInput,
  type InvocationContext,
  type InvocationTarget
} from "./invoke.ts";

const CONTRACT = computerContract();

/** Target that records what the bridge forwarded. */
class RecordingTarget implements InvocationTarget {
  readonly seen: Array<{
    envelope: InvocationEnvelope;
    context: InvocationContext;
  }> = [];
  private readonly reply: InvocationResult;

  constructor(reply: InvocationResult) {
    this.reply = reply;
  }

  execute(
    envelope: InvocationEnvelope,
    context: InvocationContext
  ): InvocationResult {
    this.seen.push({ envelope, context });
    return this.reply;
  }
}

function gatewayResult(): InvocationResult {
  return {
    status: 201,
    headers: [{ name: "content-type", values: ["application/json"] }],
    body: { id: 17, label: "rack-1-node-4", status: "ready" },
    contentType: "application/json",
    requestId: "req_00000042"
  };
}

const TIGHT_TRUNCATION: TruncationPolicy = {
  version: 1,
  maxOutputBytes: 32,
  strategy: "byte-prefix"
};

function bridge(
  target: InvocationTarget,
  truncation: TruncationPolicy | undefined = undefined
): CatalogInvokeBridge {
  return new CatalogInvokeBridge({
    contract: CONTRACT,
    target,
    ...(truncation === undefined ? {} : { truncation })
  });
}

function catalogInput(
  overrides: Partial<CatalogInvokeInput> = {}
): CatalogInvokeInput {
  return {
    operation: "path:POST /v1/computers",
    parameters: { path: {}, query: {}, headers: {}, cookies: {} },
    contentType: "application/json",
    accept: ["application/json"],
    body: { label: "rack-1-node-4" },
    ...overrides
  };
}

describe("transport kinds", () => {
  it("exports the two MCP lifecycle kinds", () => {
    expect(MCP_TRANSPORT_KINDS).toEqual(["mcp-direct", "mcp-catalog"]);
  });
});

describe("toEnvelope", () => {
  it("normalizes untyped catalog input", () => {
    const envelope = toEnvelope(catalogInput());
    expect(envelope).toEqual({
      operation: "path:POST /v1/computers",
      parameters: { path: {}, query: {}, headers: {}, cookies: {} },
      contentType: "application/json",
      accept: ["application/json"],
      body: { label: "rack-1-node-4" }
    });
  });

  it("defaults the missing groups, content type, and accept", () => {
    const envelope = toEnvelope({ operation: "path:GET /health" });
    expect(envelope.parameters).toEqual({
      path: {},
      query: {},
      headers: {},
      cookies: {}
    });
    expect(envelope.contentType).toBe(null);
    expect(envelope.accept).toEqual([]);
    expect(envelope.body).toBeUndefined();
    expect(
      toEnvelope({ operation: "path:GET /health", parameters: 7 }).parameters
    ).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });

  it("keeps a binary body record intact", () => {
    const body = encodeBinaryBody(new Uint8Array([4, 5, 6]), "text/csv");
    const envelope = toEnvelope({ ...catalogInput(), body });
    expect(envelope.body).toEqual(body);
  });

  it("rejects malformed input", () => {
    expect(() => toEnvelope({ operation: "" })).toThrowError(
      /must name one operation/
    );
    expect(() =>
      toEnvelope({
        operation: "path:GET /health",
        parameters: { path: "no" }
      })
    ).toThrowError(/must be a JSON object/);
    expect(() =>
      toEnvelope({
        operation: "path:GET /health",
        accept: ["application/json", 3]
      })
    ).toThrowError(/array of media type strings/);
    expect(() =>
      toEnvelope({ operation: "path:GET /health", contentType: 12 })
    ).toThrowError(/media type string/);
    expect(() =>
      toEnvelope({
        operation: "path:GET /health",
        body: { kind: "binary", base64: "AAA=" }
      })
    ).toThrowError(/needs base64, contentType, byteCount, and sha256/);
  });
});

describe("CatalogInvokeBridge", () => {
  it("forwards a validated envelope and the resolved operation", async () => {
    const target = new RecordingTarget(gatewayResult());
    const report = await bridge(target).invoke(catalogInput());
    expect(target.seen).toHaveLength(1);
    const forwarded = target.seen[0];
    if (forwarded === undefined) {
      throw new Error("Nothing was forwarded.");
    }
    expect(forwarded.envelope.operation).toBe("path:POST /v1/computers");
    expect(forwarded.envelope.body).toEqual({ label: "rack-1-node-4" });
    expect(forwarded.context.operation.key).toBe("path:POST /v1/computers");
    expect(forwarded.context.transport).toBe("mcp-catalog");
    expect(report.transport).toBe("mcp-catalog");
    expect(report.operation.key).toBe("path:POST /v1/computers");
    expect(report.result.status).toBe(201);
    expect(report.result.requestId).toBe("req_00000042");
    expect(report.truncation).toBeUndefined();
  });

  it("accepts an operationId or a UID in place of the canonical key", async () => {
    const target = new RecordingTarget(gatewayResult());
    const report = await bridge(target).invoke(
      catalogInput({ operation: "createComputer" })
    );
    expect(report.operation.key).toBe("path:POST /v1/computers");
    expect(target.seen[0]?.envelope.operation).toBe("path:POST /v1/computers");

    const byUid = await bridge(target).invoke(
      catalogInput({ operation: report.operation.uid })
    );
    expect(byUid.operation.key).toBe("path:POST /v1/computers");
  });

  it("rejects a reference no operation matches", async () => {
    const target = new RecordingTarget(gatewayResult());
    await expect(
      bridge(target).invoke(catalogInput({ operation: "path:POST /nope" }))
    ).rejects.toThrowError(/No operation matches/);
    expect(target.seen).toHaveLength(0);
  });

  it("reports the direct transport when configured", async () => {
    const target = new RecordingTarget(gatewayResult());
    const direct = new CatalogInvokeBridge({
      contract: CONTRACT,
      target,
      transport: "mcp-direct"
    });
    const report = await direct.invoke(catalogInput());
    expect(report.transport).toBe("mcp-direct");
    expect(target.seen[0]?.context.transport).toBe("mcp-direct");
  });

  it("rejects a credential before the target runs", async () => {
    const target = new RecordingTarget(gatewayResult());
    await expect(
      bridge(target).invoke(
        catalogInput({
          parameters: {
            path: {},
            query: {},
            headers: { "X-API-Key": "oal_secret" },
            cookies: {}
          }
        })
      )
    ).rejects.toThrowError(/security scheme/);
    expect(target.seen).toHaveLength(0);
  });

  it("exposes the typed rejection code without the value", async () => {
    const target = new RecordingTarget(gatewayResult());
    const attempt = bridge(target).invoke(
      catalogInput({
        operation: "replaceComputer",
        parameters: {
          path: { computer_id: "17" },
          query: {},
          headers: { Authorization: "Bearer oal_secret" },
          cookies: {}
        }
      })
    );
    const failure = await attempt.then(
      () => null,
      (error: unknown): OalError => {
        if (!(error instanceof OalError)) {
          throw new Error("Expected an OalError.");
        }
        return error;
      }
    );
    if (failure === null) {
      throw new Error("Expected the invocation to fail.");
    }
    expect(failure.code).toBe(PROTECTED_AUTH_PARAMETER);
    expect(JSON.stringify(failure.details)).not.toContain("oal_secret");
    expect(target.seen).toHaveLength(0);
  });

  it("rejects a binary body whose digest does not match", async () => {
    const target = new RecordingTarget(gatewayResult());
    const body = encodeBinaryBody(new Uint8Array([1, 2, 3]), "text/csv");
    const attempt = bridge(target).invoke({
      ...catalogInput(),
      body: { ...body, sha256: "0".repeat(64) }
    });
    await expect(attempt).rejects.toThrowError(/does not match/);
    expect(target.seen).toHaveLength(0);
  });

  it("truncates a large gateway result before returning it", async () => {
    const large: InvocationResult = {
      ...gatewayResult(),
      body: { pad: "y".repeat(500) }
    };
    const target = new RecordingTarget(large);
    const report = await bridge(target, TIGHT_TRUNCATION).invoke(
      catalogInput()
    );
    const record = report.truncation;
    if (record === undefined) {
      throw new Error("Expected a truncation record.");
    }
    expect(record.maxOutputBytes).toBe(32);
    expect(record.retainedBytes).toBe(32);
    expect(record.completeBytes).toBeGreaterThan(32);
    expect(record.completeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof report.result.body).toBe("string");
    expect(report.result.truncation).toEqual(record);
  });

  it("rejects a result that does not match the shared shape", async () => {
    const broken = new RecordingTarget({
      ...gatewayResult(),
      requestId: "not-a-request-id"
    });
    await expect(bridge(broken).invoke(catalogInput())).rejects.toThrowError(
      /requestId/
    );
  });
});
