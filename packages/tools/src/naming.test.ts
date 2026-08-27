import { describe, expect, it } from "vitest";

import { OalError, operationUid } from "@oal/core";

import { computerContract } from "./contract.fixture.ts";
import {
  assertNamingConstraints,
  buildDirectToolMap,
  DEFAULT_NAMING_CONSTRAINTS,
  generateToolName,
  namingCandidates
} from "./naming.ts";

const CONTRACT = computerContract();

function candidate(input: {
  template: string;
  method: string;
  operationId?: string | null;
}): ReturnType<typeof namingCandidates>[number] {
  const key = `path:${input.method} ${input.template}`;
  return {
    key,
    uid: operationUid(key),
    operationId: input.operationId ?? null,
    method: input.method,
    pathTemplate: input.template
  };
}

function constraintFailure(attempt: () => void): OalError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof OalError) {
      return error;
    }
  }
  throw new Error("Expected an OalError.");
}

describe("generateToolName", () => {
  it("derives a method and path name", () => {
    expect(generateToolName("GET", "/v1/computers")).toBe("get_v1_computers");
    expect(
      generateToolName("POST", "/v1/computers/{computer_id}/restore")
    ).toBe("post_v1_computers_by_computer_id_restore");
    expect(generateToolName("GET", "/")).toBe("get");
    expect(generateToolName("DELETE", "/a.b")).toBe("delete_a_b");
  });

  it("collapses runs of separators", () => {
    expect(generateToolName("GET", "//health--check//")).toBe(
      "get_health--check"
    );
    expect(generateToolName("GET", "/123/labels")).toBe("get_123_labels");
  });
});

describe("buildDirectToolMap", () => {
  it("passes a unique valid operationId through", () => {
    const map = buildDirectToolMap(namingCandidates(CONTRACT.operations));
    const create = map.assignments.find(
      (entry) => entry.key === "path:POST /v1/computers"
    );
    if (create === undefined) {
      throw new Error("The create assignment is missing.");
    }
    expect(create.toolName).toBe("createComputer");
    expect(create.fromOperationId).toBe(true);
    expect(create.generated).toBe(false);
    expect(create.suffixed).toBe(false);
  });

  it("derives a path name when no operationId exists", () => {
    const map = buildDirectToolMap(namingCandidates(CONTRACT.operations));
    const read = map.assignments.find(
      (entry) => entry.key === "path:GET /v1/computers/{computer_id}"
    );
    if (read === undefined) {
      throw new Error("The read assignment is missing.");
    }
    expect(read.toolName).toBe("get_v1_computers_by_computer_id");
    expect(read.fromOperationId).toBe(false);
    expect(read.generated).toBe(true);
    expect(read.suffixed).toBe(false);
  });

  it("keeps every name unique and dispatchable", () => {
    const map = buildDirectToolMap(namingCandidates(CONTRACT.operations));
    const names = map.assignments.map((entry) => entry.toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of map.assignments) {
      expect(map.toolToOperation.get(entry.toolName)).toBe(entry.key);
      expect(DEFAULT_NAMING_CONSTRAINTS.pattern.test(entry.toolName)).toBe(
        true
      );
      expect(entry.toolName.length).toBeLessThanOrEqual(
        DEFAULT_NAMING_CONSTRAINTS.maxLength
      );
    }
    expect(map.assignments.map((entry) => entry.key)).toEqual(
      [...map.assignments.map((entry) => entry.key)].sort()
    );
  });

  it("suffixes a generated name that collides with another one", () => {
    const dot = candidate({ template: "/a.b", method: "GET" });
    const underscore = candidate({ template: "/a_b", method: "GET" });
    const map = buildDirectToolMap([dot, underscore]);
    expect(map.assignments).toHaveLength(2);
    const first = map.assignments[0];
    const second = map.assignments[1];
    if (first === undefined || second === undefined) {
      throw new Error("Two assignments were expected.");
    }
    expect(first.key).toBe("path:GET /a.b");
    expect(first.toolName).toBe("get_a_b");
    expect(first.suffixed).toBe(false);
    const suffix = underscore.uid.replace(/^op_/, "").slice(0, 6);
    expect(second.toolName).toBe(`get_a_b_${suffix}`);
    expect(second.suffixed).toBe(true);
    expect(map.collisions).toEqual(["get_a_b"]);
    expect(map.toolToOperation.get(`get_a_b_${suffix}`)).toBe("path:GET /a_b");
  });

  it("suffixes a generated name that collides with an earned operationId", () => {
    const earned = candidate({
      template: "/health",
      method: "GET",
      operationId: "get_status"
    });
    const derived = candidate({ template: "/status", method: "GET" });
    const map = buildDirectToolMap([derived, earned]);
    const health = map.assignments.find(
      (entry) => entry.key === "path:GET /health"
    );
    const status = map.assignments.find(
      (entry) => entry.key === "path:GET /status"
    );
    if (health === undefined || status === undefined) {
      throw new Error("Both assignments were expected.");
    }
    expect(health.toolName).toBe("get_status");
    expect(health.fromOperationId).toBe(true);
    const suffix = derived.uid.replace(/^op_/, "").slice(0, 6);
    expect(status.toolName).toBe(`get_status_${suffix}`);
    expect(status.suffixed).toBe(true);
    expect(map.collisions).toEqual(["get_status"]);
  });

  it("produces the same frozen map and digest for any input order", () => {
    const candidates = namingCandidates(CONTRACT.operations);
    const forward = buildDirectToolMap(candidates);
    const backward = buildDirectToolMap([...candidates].reverse());
    expect(forward.digest).toBe(backward.digest);
    expect(forward.assignments).toEqual(backward.assignments);
    expect(forward.digest).toMatch(/^[0-9a-f]{64}$/);
    const repeated = buildDirectToolMap(candidates);
    expect(repeated.digest).toBe(forward.digest);
    expect(repeated.toolToOperation).toEqual(forward.toolToOperation);
  });

  it("fails when a duplicated operationId cannot earn the name", () => {
    const first = candidate({
      template: "/one",
      method: "GET",
      operationId: "same"
    });
    const second = candidate({
      template: "/two",
      method: "GET",
      operationId: "same"
    });
    const map = buildDirectToolMap([first, second]);
    const names = map.assignments.map((entry) => entry.toolName);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["get_one", "get_two"]);
  });
});

describe("naming constraints", () => {
  it("rejects a maximum length that leaves no stem room", () => {
    const error = constraintFailure(() =>
      assertNamingConstraints({
        maxLength: 6,
        pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
        suffixRoom: 7
      })
    );
    expect(error.code).toBe("OAL-TOOL-NAME-CONSTRAINT");
    expect(error.category).toBe("capability");
  });

  it("rejects a suffix room smaller than the UID suffix", () => {
    expect(() =>
      assertNamingConstraints({
        maxLength: 64,
        pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
        suffixRoom: 5
      })
    ).toThrowError(/UID suffix/);
  });

  it("rejects a pattern that refuses every usable stem", () => {
    expect(() =>
      assertNamingConstraints({
        maxLength: 64,
        pattern: /^[0-9]+$/,
        suffixRoom: 7
      })
    ).toThrowError(/rejects every name of usable length/);
  });

  it("rejects an out-of-range maximum length", () => {
    expect(() =>
      assertNamingConstraints({
        maxLength: 0,
        pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
        suffixRoom: 7
      })
    ).toThrowError(/maximum tool name length/);
  });

  it("fails a map build when a name cannot satisfy the pattern", () => {
    const error = constraintFailure(() =>
      buildDirectToolMap([candidate({ template: "/x", method: "GET" })], {
        maxLength: 64,
        pattern: /^[a-z]+$/,
        suffixRoom: 7
      })
    );
    expect(error.code).toBe("OAL-TOOL-NAME-CONSTRAINT");
    expect(error.message).toMatch(/generated tool name is not valid/);
  });
});
