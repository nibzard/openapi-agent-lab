import { afterEach, describe, expect, it } from "vitest";

import { closeSchemaWorker, type Diagnostic } from "@oal/core";

import { hostilePatternDiagnostics, HOSTILE_PATTERN_CODE } from "./patterns.ts";
import type { ContractIR, SchemaIR } from "@oal/contract-ir";

function schemaWith(uid: string, pattern: string): SchemaIR {
  return {
    uid,
    schema: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", pattern } }
    },
    source_pointer: `#/components/schemas/${uid}`,
    document_uri: ""
  };
}

function contractWith(schemas: SchemaIR[]): ContractIR {
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
    schemas: Object.fromEntries(
      schemas.map((entry) => [entry.uid, entry])
    ) as Record<string, SchemaIR>,
    operations: [],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

afterEach(() => {
  closeSchemaWorker();
});

describe("hostilePatternDiagnostics", () => {
  it("flags a nested-quantifier pattern that misses the probe deadline", async () => {
    const findings = await hostilePatternDiagnostics(
      contractWith([schemaWith("sch_evil", "^(a+)+$")])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(HOSTILE_PATTERN_CODE);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.json_pointer).toBe("#/components/schemas/sch_evil");
  });

  it("escalates to an error under strict mode", async () => {
    const findings: Diagnostic[] = await hostilePatternDiagnostics(
      contractWith([schemaWith("sch_evil", "^(a+)+$")]),
      { strict: true }
    );
    expect(findings[0]?.severity).toBe("error");
  });

  it("passes patterns that answer the battery quickly", async () => {
    const findings = await hostilePatternDiagnostics(
      contractWith([
        schemaWith("sch_ok", "^[a-z][a-z0-9_]{2,31}$"),
        schemaWith("sch_plain", "^\\d{4}-\\d{2}-\\d{2}$")
      ])
    );
    expect(findings).toEqual([]);
  });

  it("does not charge worker start-up to the probe budget", async () => {
    // A cold boundary must start a worker thread before any probe can
    // answer. That start-up is infrastructure cost, not regex cost, so
    // it may not count against the probe deadline: a benign pattern
    // answers a warm boundary in well under a millisecond, while the
    // start-up alone runs tens of milliseconds.
    closeSchemaWorker();
    const findings = await hostilePatternDiagnostics(
      contractWith([
        schemaWith("sch_ok", "^[a-z][a-z0-9_]{2,31}$"),
        schemaWith("sch_plain", "^\\d{4}-\\d{2}-\\d{2}$")
      ]),
      { deadlineMs: 10 }
    );
    expect(findings).toEqual([]);
  });

  it("probes a repeated pattern once", async () => {
    const one = schemaWith("sch_first", "^(a+)+$");
    const two = schemaWith("sch_second", "^(a+)+$");
    const findings = await hostilePatternDiagnostics(contractWith([one, two]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.json_pointer).toBe("#/components/schemas/sch_first");
  });
});
