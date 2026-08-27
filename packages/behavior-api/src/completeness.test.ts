import { describe, expect, it } from "vitest";

import {
  checkBehaviorCompleteness,
  diffBehaviorCompleteness
} from "./completeness.ts";
import type { BackendDescription } from "./types.ts";

function description(
  operations: Array<{ key: string; support: "implemented" }> = []
): Pick<BackendDescription, "operations"> {
  return { operations };
}

describe("checkBehaviorCompleteness", () => {
  it("passes when every scope operation is declared and implemented", () => {
    const scope = [
      "path:GET /v1/computers",
      "path:POST /v1/computers",
      "path:DELETE /v1/computers/{id}"
    ];
    const operations: BackendDescription["operations"] = [
      { key: "path:DELETE /v1/computers/{id}", support: "implemented" },
      { key: "path:GET /v1/computers", support: "implemented" },
      { key: "path:POST /v1/computers", support: "implemented" }
    ];
    const declared = { operations };
    expect(checkBehaviorCompleteness(declared, scope)).toEqual([]);
    expect(diffBehaviorCompleteness(declared, scope)).toEqual({
      missing: [],
      unimplemented: [],
      extra: [],
      duplicated: []
    });
  });

  it("fails on one missing operation declaration", () => {
    const scope = ["path:GET /widgets", "path:POST /widgets"];
    const diagnostics = checkBehaviorCompleteness(
      description([{ key: "path:GET /widgets", support: "implemented" }]),
      scope
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      phase: "preflight",
      code: "OAL-BEHAVIOR-OPERATION-MISSING",
      operation_key: "path:POST /widgets"
    });
    expect(diagnostics[0]?.message).toContain("does not declare");
  });

  it("fails on one extra operation declaration", () => {
    const scope = ["path:GET /widgets"];
    const diagnostics = checkBehaviorCompleteness(
      description([
        { key: "path:GET /widgets", support: "implemented" },
        { key: "path:DELETE /widgets/{id}", support: "implemented" }
      ]),
      scope
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      phase: "preflight",
      code: "OAL-BEHAVIOR-OPERATION-EXTRA",
      operation_key: "path:DELETE /widgets/{id}"
    });
    expect(diagnostics[0]?.message).toContain("outside the resolved scope");
  });

  it("fails when a scoped operation is declared without implementation", () => {
    const scope = ["path:GET /widgets"];
    const diagnostics = checkBehaviorCompleteness(
      {
        operations: [{ key: "path:GET /widgets", support: "unsupported" }]
      },
      scope
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "OAL-BEHAVIOR-OPERATION-MISSING",
      operation_key: "path:GET /widgets"
    });
    expect(diagnostics[0]?.message).toContain("implemented");
    expect(
      diffBehaviorCompleteness(
        { operations: [{ key: "path:GET /widgets", support: "passthrough" }] },
        scope
      ).unimplemented
    ).toEqual(["path:GET /widgets"]);
  });

  it("fails when one operation is declared more than once", () => {
    const scope = ["path:GET /widgets"];
    const diagnostics = checkBehaviorCompleteness(
      {
        operations: [
          { key: "path:GET /widgets", support: "implemented" },
          { key: "path:GET /widgets", support: "implemented" }
        ]
      },
      scope
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "OAL-BEHAVIOR-OPERATION-EXTRA",
      operation_key: "path:GET /widgets"
    });
    expect(diagnostics[0]?.message).toContain("more than once");
  });

  it("reports every mismatch in a deterministic order", () => {
    const scope = ["path:GET /a", "path:GET /b", "path:GET /c"];
    const diagnostics = checkBehaviorCompleteness(
      description([{ key: "path:GET /c", support: "implemented" }]),
      scope
    );
    expect(diagnostics.map((entry) => entry.operation_key)).toEqual([
      "path:GET /a",
      "path:GET /b"
    ]);
    expect(
      diffBehaviorCompleteness(description(), ["path:GET /a", "path:GET /a"])
        .missing
    ).toEqual(["path:GET /a"]);
  });

  it("flags every declaration when the scope is empty", () => {
    const diagnostics = checkBehaviorCompleteness(
      description([{ key: "path:GET /widgets", support: "implemented" }]),
      []
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("OAL-BEHAVIOR-OPERATION-EXTRA");
  });
});
