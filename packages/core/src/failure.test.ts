import { describe, expect, it } from "vitest";

import {
  FAILURE_REGISTRY,
  HTTP_BEHAVIOR_CODES,
  failureClassOf,
  failuresByCategory,
  invalidatesEvidence,
  isHarnessFailure,
  retryPolicyOf
} from "./failure.ts";

describe("FAILURE_REGISTRY", () => {
  it("covers every category from section 32.2", () => {
    const categories = new Set(
      [...FAILURE_REGISTRY.values()].map((f) => f.category)
    );
    expect([...categories].sort()).toEqual([
      "adapter_provider",
      "agent_execution",
      "capability",
      "evaluation",
      "http_behavior",
      "input_config",
      "mock",
      "openapi",
      "pack",
      "parse",
      "persistence",
      "reference",
      "sandbox",
      "startup",
      "study"
    ]);
  });

  it("holds unique codes only", () => {
    const codes = [...FAILURE_REGISTRY.keys()];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("classifies a compile failure", () => {
    const failure = failureClassOf("OAL-REF-NOT-FOUND");
    expect(failure?.category).toBe("reference");
    expect(failure?.effect).toBe("compile_failed_or_capability");
    expect(failure?.severity).toBe("error");
    expect(failure?.retryable).toBe(false);
  });

  it("returns null for an unknown code", () => {
    expect(failureClassOf("OAL-NOT-A-CODE")).toBeNull();
  });

  it("marks every HTTP behavior code as info-level trace evidence", () => {
    for (const code of HTTP_BEHAVIOR_CODES) {
      const failure = failureClassOf(code);
      expect(failure?.category).toBe("http_behavior");
      expect(failure?.severity).toBe("info");
      expect(failure?.effect).toBe("normal_trace_evidence");
    }
  });
});

describe("isHarnessFailure", () => {
  it("treats participant-caused HTTP failures as evidence, not harness failures", () => {
    expect(isHarnessFailure("authentication_failed")).toBe(false);
    expect(isHarnessFailure("fault_injected")).toBe(false);
    expect(isHarnessFailure("OAL-MOCK-INTERNAL")).toBe(true);
    expect(isHarnessFailure("OAL-NOT-A-CODE")).toBe(false);
  });
});

describe("retryPolicyOf", () => {
  it("allows safe startup retries only", () => {
    expect(retryPolicyOf("OAL-PORT-BIND-FAILED")).toBe("startup_only");
    expect(retryPolicyOf("OAL-MOCK-NOT-READY")).toBe("startup_only");
    expect(retryPolicyOf("OAL-PROVIDER-UNAVAILABLE")).toBe("startup_only");
    expect(retryPolicyOf("OAL-AGENT-TIMEOUT")).toBe("never");
    expect(retryPolicyOf("OAL-AGENT-EXIT-NONZERO")).toBe("never");
    expect(retryPolicyOf("OAL-NOT-A-CODE")).toBe("never");
  });
});

describe("invalidatesEvidence", () => {
  it("invalidates for persistence and study preflight failures", () => {
    expect(invalidatesEvidence("OAL-HASH-MISMATCH")).toBe(true);
    expect(invalidatesEvidence("OAL-INVALID-EVIDENCE")).toBe(true);
    expect(invalidatesEvidence("OAL-CELL-DRIFT")).toBe(true);
    expect(invalidatesEvidence("OAL-AGENT-EXIT-NONZERO")).toBe(false);
    expect(invalidatesEvidence("OAL-NOT-A-CODE")).toBe(false);
  });
});

describe("failuresByCategory", () => {
  it("lists the agent execution codes", () => {
    expect(failuresByCategory("agent_execution").map((f) => f.code)).toEqual([
      "OAL-AGENT-EXIT-NONZERO",
      "OAL-AGENT-TIMEOUT",
      "OAL-AGENT-CANCELLED",
      "OAL-AGENT-BUDGET-EXHAUSTED"
    ]);
  });

  it("returns an empty list for a category with no codes", () => {
    expect(failuresByCategory("input_config")).toHaveLength(4);
  });
});
