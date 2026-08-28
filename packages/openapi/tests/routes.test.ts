import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";

import { compileOpenApi } from "../src/index.ts";
import { parsePathTemplate, templatesConflict } from "../src/routes.ts";

const fixtures = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);

function conflict(left: string, right: string): boolean {
  return templatesConflict(parsePathTemplate(left), parsePathTemplate(right));
}

/** Build one OpenAPI 3.1 document with one operation per template. */
function documentWith(templates: readonly string[]): string {
  const items: string[] = [];
  let index = 0;
  for (const template of templates) {
    const parameters = [...template.matchAll(/\{([^{}/]+)\}/g)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" }
      })
    );
    items.push(
      `${JSON.stringify(template)}:${JSON.stringify({
        get: {
          operationId: `op${(index += 1)}`,
          ...(parameters.length > 0 ? { parameters } : {}),
          responses: { "200": { description: "ok" } }
        }
      })}`
    );
  }
  return `{"openapi":"3.1.0","info":{"title":"Routes","version":"1.0.0"},"paths":{${items.join(
    ","
  )}}}`;
}

function compile(templates: readonly string[]) {
  const documents = { "routes.json": documentWith(templates) };
  return compileOpenApi({ documents, entrypoint: "routes.json" });
}

function failureOf(templates: readonly string[]): OalError {
  try {
    compile(templates);
  } catch (error) {
    if (error instanceof OalError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected compilation to fail");
}

describe("template overlap detection", () => {
  it("flags overlapping literal and parameter positions", () => {
    expect(conflict("/a/{x}/c", "/a/b/{y}")).toBe(true);
  });

  it("flags a fully parameterized overlap at any depth", () => {
    expect(conflict("/a/{x}/{z}", "/a/b/{y}")).toBe(true);
    expect(conflict("/pets/{id}", "/pets/{petId}")).toBe(true);
  });

  it("accepts distinct literals at the same position", () => {
    expect(conflict("/a/{x}/c", "/a/b/d")).toBe(false);
  });

  it("accepts a literal template that a parameter template overlaps", () => {
    expect(conflict("/a/{x}", "/a/b")).toBe(false);
    expect(conflict("/params/literal/{id}", "/params/literal/fixed")).toBe(
      false
    );
  });

  it("accepts templates of different lengths", () => {
    expect(conflict("/a/{x}", "/a/{x}/b")).toBe(false);
  });
});

describe("ambiguous route compilation", () => {
  it("rejects overlapping literal and parameter templates", () => {
    const error = failureOf(["/a/{x}/c", "/a/b/{y}"]);
    expect(error.code).toBe("OAL-OAS-ROUTE-AMBIGUOUS");
    expect(error.message).toBe(
      "Templated routes /a/b/{y} and /a/{x}/c can match the same request path."
    );
    const diagnostics = (error.details as { diagnostics: unknown[] })
      .diagnostics;
    const ambiguity = diagnostics.find(
      (entry) => (entry as { code?: string }).code === "OAL-OAS-ROUTE-AMBIGUOUS"
    ) as { details?: { templates?: string[] } } | undefined;
    expect(ambiguity?.details?.templates).toEqual(["/a/b/{y}", "/a/{x}/c"]);
  });

  it("compiles distinct literals beside a parameter template", () => {
    const { contract } = compile(["/a/{x}/c", "/a/b/d"]);
    expect(contract.operations.map((operation) => operation.key)).toEqual([
      "path:GET /a/b/d",
      "path:GET /a/{x}/c"
    ]);
  });

  it("compiles a literal specialization beside a parameter template", () => {
    const { contract } = compile(["/a/{x}", "/a/b"]);
    expect(contract.operations.map((operation) => operation.key)).toEqual([
      "path:GET /a/b",
      "path:GET /a/{x}"
    ]);
  });

  it("keeps the literal-and-parameter fixture pair compiling", () => {
    const documents = {
      "matrix.json": readFileSync(
        `${fixtures}openapi/parameters-matrix.json`,
        "utf8"
      )
    };
    const { contract } = compileOpenApi({
      documents,
      entrypoint: "matrix.json"
    });
    const keys = contract.operations.map((operation) => operation.key);
    expect(keys).toContain("path:GET /params/literal/{id}");
    expect(keys).toContain("path:GET /params/literal/fixed");
  });
});
