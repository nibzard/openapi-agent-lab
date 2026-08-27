import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { canonicalJson, OalError, sha256HexBytes, type Json } from "@oal/core";

import { computerContract } from "./contract.fixture.ts";
import {
  applyResultTruncation,
  decodeBinaryBody,
  DEFAULT_ENVELOPE_LIMITS,
  emptyParameters,
  encodeBinaryBody,
  isBinaryBody,
  PROTECTED_AUTH_PARAMETER,
  protectedParameterNames,
  rejectProtectedParameters,
  TRUNCATION_POLICY,
  validateInvocationEnvelope,
  validateInvocationResult,
  type InvocationEnvelope,
  type InvocationResult
} from "./envelope.ts";

const CONTRACT = computerContract();

function envelope(
  overrides: Partial<InvocationEnvelope> = {}
): InvocationEnvelope {
  return {
    operation: "path:POST /v1/computers",
    parameters: emptyParameters(),
    contentType: "application/json",
    accept: ["application/json"],
    body: { label: "rack-1-node-4" },
    ...overrides
  };
}

function result(overrides: Partial<InvocationResult> = {}): InvocationResult {
  return {
    status: 201,
    headers: [{ name: "content-type", values: ["application/json"] }],
    body: { id: 1 },
    contentType: "application/json",
    requestId: "req_00000001",
    ...overrides
  };
}

function oal(attempt: () => void): OalError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof OalError) {
      return error;
    }
  }
  throw new Error("Expected an OalError.");
}

function operation(key: string): void {
  const found = CONTRACT.operations.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`The fixture is missing ${key}.`);
  }
}

describe("protected authentication parameters", () => {
  it("collects the api-key wire name for api-key operations", () => {
    operation("path:POST /v1/computers");
    const create = CONTRACT.operations[0];
    if (create === undefined) {
      throw new Error("The fixture is missing an operation.");
    }
    expect(protectedParameterNames(CONTRACT, create)).toEqual({
      headers: ["x-api-key"],
      query: [],
      cookies: []
    });
  });

  it("collects the authorization header for bearer operations", () => {
    operation("path:PUT /v1/computers/{computer_id}");
    const replace = CONTRACT.operations.find(
      (candidate) => candidate.key === "path:PUT /v1/computers/{computer_id}"
    );
    if (replace === undefined) {
      throw new Error("The fixture is missing the replace operation.");
    }
    expect(protectedParameterNames(CONTRACT, replace)).toEqual({
      headers: ["authorization"],
      query: [],
      cookies: []
    });
  });

  it("collects nothing for anonymous operations", () => {
    operation("path:GET /health");
    const health = CONTRACT.operations.find(
      (candidate) => candidate.key === "path:GET /health"
    );
    if (health === undefined) {
      throw new Error("The fixture is missing the health operation.");
    }
    expect(protectedParameterNames(CONTRACT, health)).toEqual({
      headers: [],
      query: [],
      cookies: []
    });
  });

  it("rejects a supplied credential without recording its value", () => {
    const error = oal(() => {
      rejectProtectedParameters(
        envelope({
          parameters: {
            ...emptyParameters(),
            headers: { "x-api-key": "oal_secret_value" }
          }
        }),
        { headers: ["x-api-key"], query: [], cookies: [] }
      );
    });
    expect(error.code).toBe(PROTECTED_AUTH_PARAMETER);
    expect(error.category).toBe("input");
    expect(JSON.stringify(error.details)).not.toContain("oal_secret_value");
    expect(error.details).toEqual({
      parameters: [{ group: "headers", name: "x-api-key" }]
    });
  });

  it("sorts multiple rejections by group then name", () => {
    const attempt = (): void => {
      rejectProtectedParameters(
        envelope({
          parameters: {
            ...emptyParameters(),
            headers: { authorization: "Bearer x" },
            query: { api_key: "y" },
            cookies: { session: "z" }
          }
        }),
        {
          headers: ["authorization"],
          query: ["api_key"],
          cookies: ["session"]
        }
      );
    };
    expect(attempt).toThrowError(
      /parameter that implements a declared security scheme/
    );
    expect(oal(attempt).details).toEqual({
      parameters: [
        { group: "cookies", name: "session" },
        { group: "headers", name: "authorization" },
        { group: "query", name: "api_key" }
      ]
    });
  });
});

describe("binary transport", () => {
  it("round-trips bytes with content type and digest", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128]);
    const body = encodeBinaryBody(bytes, "application/octet-stream");
    expect(body.byteCount).toBe(6);
    expect(body.contentType).toBe("application/octet-stream");
    expect(body.sha256).toBe(sha256HexBytes(bytes));
    const decoded = decodeBinaryBody(body);
    expect([...decoded.bytes]).toEqual([...bytes]);
    expect(decoded.contentType).toBe("application/octet-stream");
  });

  it("rejects a body above the transport bound", () => {
    const bytes = new Uint8Array(11).fill(7);
    expect(() =>
      encodeBinaryBody(bytes, "application/octet-stream", {
        maxBinaryBodyBytes: 10
      })
    ).toThrowError(/exceeds the transport bound/);
    const within = encodeBinaryBody(
      bytes.subarray(0, 10),
      "application/octet-stream",
      { maxBinaryBodyBytes: 10 }
    );
    expect(() =>
      decodeBinaryBody({ ...within, byteCount: 11 }, { maxBinaryBodyBytes: 10 })
    ).toThrowError(/exceeds the transport bound/);
  });

  it("rejects a digest or byte-count mismatch", () => {
    const body = encodeBinaryBody(new Uint8Array([9, 9]), "text/csv");
    expect(() =>
      decodeBinaryBody({ ...body, sha256: "0".repeat(64) })
    ).toThrowError(/does not match the declared digest/);
    expect(() => decodeBinaryBody({ ...body, byteCount: 3 })).toThrowError(
      /does not match the base64 payload/
    );
  });

  it("recognizes binary records structurally", () => {
    expect(
      isBinaryBody(encodeBinaryBody(new Uint8Array(1), "text/plain"))
    ).toBe(true);
    expect(isBinaryBody({ base64: "AA==" })).toBe(false);
    expect(isBinaryBody(null)).toBe(false);
    expect(DEFAULT_ENVELOPE_LIMITS.maxBinaryBodyBytes).toBe(262_144);
  });
});

describe("envelope validation", () => {
  it("resolves the operation for a valid envelope", () => {
    const resolved = validateInvocationEnvelope(envelope(), CONTRACT);
    expect(resolved.key).toBe("path:POST /v1/computers");
    expect(resolved.operation_id).toBe("createComputer");
  });

  it("rejects a malformed canonical key", () => {
    expect(() =>
      validateInvocationEnvelope(
        envelope({ operation: "POST /v1/computers" }),
        CONTRACT
      )
    ).toThrowError(/not a canonical key/);
    expect(() =>
      validateInvocationEnvelope(envelope({ operation: "" }), CONTRACT)
    ).toThrowError(/not a canonical key/);
  });

  it("rejects an operation the contract does not declare", () => {
    expect(() =>
      validateInvocationEnvelope(
        envelope({ operation: "path:POST /v1/unknown" }),
        CONTRACT
      )
    ).toThrowError(/does not declare/);
  });

  it("rejects a parameter group that is not an object", () => {
    expect(() =>
      validateInvocationEnvelope(
        envelope({
          parameters: {
            path: {},
            query: [1, 2] as unknown as Record<string, never>,
            headers: {},
            cookies: {}
          }
        }),
        CONTRACT
      )
    ).toThrowError(/must be a JSON object/);
  });

  it("rejects a binary body with a broken digest before forwarding", () => {
    const body = encodeBinaryBody(new Uint8Array([1]), "text/plain");
    expect(() =>
      validateInvocationEnvelope(
        envelope({ body: { ...body, sha256: "0".repeat(64) } }),
        CONTRACT
      )
    ).toThrowError(/does not match the declared digest/);
  });

  it("rejects a credential supplied through the envelope", () => {
    expect(() =>
      validateInvocationEnvelope(
        envelope({
          parameters: {
            ...emptyParameters(),
            headers: { "X-API-Key": "x" }
          }
        }),
        CONTRACT
      )
    ).toThrowError(/security scheme/);
  });
});

describe("large-output truncation", () => {
  it("leaves small results untouched", () => {
    const small = result();
    expect(applyResultTruncation(small)).toBe(small);
    expect(TRUNCATION_POLICY.maxOutputBytes).toBe(65_536);
  });

  it("truncates a JSON body and records the complete-byte digest", () => {
    const policy = {
      version: 1,
      maxOutputBytes: 24,
      strategy: "byte-prefix"
    } as const;
    const large = result({ body: { pad: "x".repeat(200) } });
    const complete = Buffer.from(canonicalJson(large.body as Json), "utf8");
    expect(complete.length).toBe(210);
    const truncated = applyResultTruncation(large, policy);
    const record = truncated.truncation;
    if (record === undefined) {
      throw new Error("Expected a truncation record.");
    }
    expect(typeof truncated.body).toBe("string");
    expect((truncated.body as string).length).toBe(record.retainedBytes);
    expect(record.retainedBytes).toBe(24);
    expect(record.completeBytes).toBe(210);
    expect(record.completeSha256).toBe(sha256HexBytes(complete));
  });

  it("truncates a binary body at the byte bound", () => {
    const policy = {
      version: 1,
      maxOutputBytes: 4,
      strategy: "byte-prefix"
    } as const;
    const body = encodeBinaryBody(new Uint8Array(9).fill(255), "image/png");
    const truncated = applyResultTruncation(result({ body }), policy);
    const record = truncated.truncation;
    if (record === undefined) {
      throw new Error("Expected a truncation record.");
    }
    expect(record.completeBytes).toBe(9);
    expect(record.retainedBytes).toBe(4);
    expect(record.completeSha256).toBe(body.sha256);
    expect(isBinaryBody(truncated.body)).toBe(true);
  });
});

describe("result validation", () => {
  it("accepts a normalized result", () => {
    expect(() => {
      validateInvocationResult(result());
    }).not.toThrow();
  });

  it("rejects a non-integer status", () => {
    expect(() => {
      validateInvocationResult({ ...result(), status: 20.5 });
    }).toThrowError(/status/);
  });

  it("rejects a malformed request ID and header list", () => {
    expect(() => {
      validateInvocationResult({ ...result(), requestId: "req-1" });
    }).toThrowError(/requestId/);
    expect(() => {
      validateInvocationResult({
        ...result(),
        headers: undefined
      } as unknown as InvocationResult);
    }).toThrowError(/headers/);
  });
});
