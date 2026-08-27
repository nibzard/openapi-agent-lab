import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";

import { compileOpenApi, loadDocumentSet } from "../src/index.ts";
import { COMPILER_LIMIT_DEFAULTS } from "../src/limits.ts";

const fixtures = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);

function read(path: string): string {
  return readFileSync(join(fixtures, path), "utf8");
}

function compileEntry(path: string, extra: Record<string, string> = {}) {
  return compileOpenApi({
    documents: { [path]: read(path), ...extra },
    entrypoint: path
  });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(fixtures, dir))) {
    if (entry.startsWith(".")) {
      continue;
    }
    const full = join(fixtures, dir, entry);
    if (statSync(full).isDirectory()) {
      for (const nested of readdirSync(full)) {
        out.push(`${dir}/${entry}/${nested}`);
      }
      continue;
    }
    out.push(`${dir}/${entry}`);
  }
  return out.sort();
}

describe("conformance corpus", () => {
  it("ships every expected fixture", () => {
    expect(listFiles("openapi")).toEqual([
      "openapi/minimal.json",
      "openapi/nullable-3.0.yaml",
      "openapi/nullable-3.1.json",
      "openapi/petstore-expanded.yaml",
      "openapi/refs/entry.yaml",
      "openapi/refs/shared.yaml",
      "openapi/webhooks.json"
    ]);
    expect(listFiles("adversarial")).toEqual([
      "adversarial/ambiguous-routes.json",
      "adversarial/bad-version.json",
      "adversarial/billion-laughs.yaml",
      "adversarial/cyclic-refs.yaml",
      "adversarial/duplicate-keys.yaml",
      "adversarial/high-confidence-secret.json",
      "adversarial/oversized-example.json",
      "adversarial/path-param-mismatch.json",
      "adversarial/remote-ref.yaml",
      "adversarial/tab-indent.yaml"
    ]);
  });

  it("compiles every conforming fixture", () => {
    const results = [
      "openapi/minimal.json",
      "openapi/nullable-3.0.yaml",
      "openapi/nullable-3.1.json",
      "openapi/webhooks.json"
    ].map((path) => {
      const { contract, report } = compileEntry(path);
      return {
        path,
        operations: contract.operations.length + contract.webhooks.length,
        level: report.recommendations.contract_mode_viability
      };
    });
    expect(results).toEqual([
      { path: "openapi/minimal.json", operations: 1, level: "viable" },
      { path: "openapi/nullable-3.0.yaml", operations: 1, level: "viable" },
      { path: "openapi/nullable-3.1.json", operations: 1, level: "viable" },
      { path: "openapi/webhooks.json", operations: 2, level: "viable" }
    ]);
  });

  it("compiles the expanded petstore contract end to end", () => {
    const { contract, report } = compileEntry("openapi/petstore-expanded.yaml");
    expect(contract.operations).toHaveLength(7);
    expect(report.counts.operations).toEqual({
      supported: 4,
      approximated: 3,
      requires_scenario: 0,
      unsupported: 0
    });
    expect(
      report.operations
        .filter((operation) => operation.level === "approximated")
        .map((operation) => operation.key)
    ).toEqual(["path:DELETE /pets/{id}", "path:GET /pets", "path:POST /pets"]);
    expect(Object.keys(contract.security_schemes)).toEqual([
      "api_key",
      "basic_auth",
      "bearer_auth",
      "petstore_auth"
    ]);
    const schemaValues = Object.values(contract.schemas);
    expect(schemaValues.length).toBeGreaterThan(4);
    for (const schema of schemaValues) {
      expect(schema.uid).toMatch(/^sch_[0-9a-f]{12}$/);
    }
  });

  it("preserves recursive schemas as reference graphs", () => {
    const { contract } = compileEntry("openapi/petstore-expanded.yaml");
    const pet = Object.values(contract.schemas).find(
      (schema) => schema.source_pointer === "#/components/schemas/Pet"
    );
    expect(pet).toBeDefined();
    const friends = (pet?.schema as { properties?: { friends?: unknown } })
      .properties?.friends;
    expect(friends).toMatchObject({ type: "array" });
    expect(JSON.stringify(friends)).toContain(
      '"$ref":"#/components/schemas/Pet"'
    );
  });

  it("loads a same-pack document set from disk", async () => {
    const root = join(fixtures, "openapi/refs");
    const set = await loadDocumentSet(
      root,
      "entry.yaml",
      COMPILER_LIMIT_DEFAULTS
    );
    expect([...set.documents.keys()].sort()).toEqual([
      "entry.yaml",
      "shared.yaml"
    ]);
    const { contract } = compileOpenApi({
      documents: Object.fromEntries(set.documents),
      entrypoint: set.entrypoint
    });
    expect(contract.operations.map((operation) => operation.key)).toEqual([
      "path:DELETE /widgets/{widgetId}",
      "path:GET /widgets",
      "path:GET /widgets/{widgetId}"
    ]);
  });

  it("rejects every adversarial fixture with a stable code", () => {
    const expectations: Array<[string, string, number]> = [
      ["adversarial/ambiguous-routes.json", "OAL-OAS-ROUTE-AMBIGUOUS", 2],
      ["adversarial/bad-version.json", "OAL-OAS-VERSION-UNSUPPORTED", 4],
      ["adversarial/billion-laughs.yaml", "OAL-YAML-NODE-LIMIT", 2],
      ["adversarial/cyclic-refs.yaml", "OAL-REF-CYCLE-UNSUPPORTED", 4],
      ["adversarial/duplicate-keys.yaml", "OAL-DUPLICATE-KEY", 2],
      [
        "adversarial/high-confidence-secret.json",
        "OAL-INPUT-SECRET-DETECTED",
        2
      ],
      [
        "adversarial/path-param-mismatch.json",
        "OAL-OAS-PATH-PARAMETER-MISSING",
        2
      ],
      ["adversarial/remote-ref.yaml", "OAL-REF-REMOTE-DISABLED", 4],
      ["adversarial/tab-indent.yaml", "OAL-YAML-INVALID", 2]
    ];
    for (const [path, code, exitCode] of expectations) {
      let caught: OalError | undefined;
      try {
        compileEntry(path);
      } catch (error) {
        if (error instanceof OalError) {
          caught = error;
        }
      }
      expect(caught, path).toBeDefined();
      expect(caught?.code, path).toBe(code);
      expect(caught?.exitCode, path).toBe(exitCode);
    }
  });

  it("rejects an oversized example only under a lowered limit", () => {
    const path = "adversarial/oversized-example.json";
    expect(() => compileEntry(path)).not.toThrow();
    let caught: OalError | undefined;
    try {
      compileOpenApi(
        { documents: { [path]: read(path) }, entrypoint: path },
        { limits: { maxOneExampleBytes: 32 } }
      );
    } catch (error) {
      if (error instanceof OalError) {
        caught = error;
      }
    }
    expect(caught?.code).toBe("OAL-INPUT-TOO-LARGE");
  });

  it("never echoes the sensitive value in a diagnostic", () => {
    const path = "adversarial/high-confidence-secret.json";
    let raw = "";
    try {
      compileEntry(path);
    } catch (error) {
      raw = JSON.stringify(error);
    }
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(raw).toContain("OAL-INPUT-SECRET-DETECTED");
  });
});
