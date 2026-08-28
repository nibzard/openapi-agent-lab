import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OalError } from "../packages/core/src/index.ts";
import { compileOpenApi } from "../packages/openapi/src/index.ts";
import {
  parsePathTemplate,
  templatesConflict
} from "../packages/openapi/src/routes.ts";
import { matchRoute } from "../packages/gateway/src/router.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SPEC_PATH = path.join(REPO_ROOT, "SPEC.md");

/** Returns the section 13.4 body from SPEC.md. */
function section134(): string {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const start = spec.indexOf("### 13.4 Route rules");
  expect(start, "SPEC.md must contain section 13.4").toBeGreaterThanOrEqual(0);
  const end = spec.indexOf("### 13.5", start);
  expect(end, "SPEC.md must delimit section 13.4").toBeGreaterThan(start);
  return spec.slice(start, end);
}

/** Builds one OpenAPI 3.1 document with one GET operation per template. */
function documentWith(templates: readonly string[]): string {
  const items = templates.map((template, index) => {
    const parameters = [...template.matchAll(/\{([^{}/]+)\}/g)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" }
      })
    );
    return `${JSON.stringify(template)}:${JSON.stringify({
      get: {
        operationId: `op${index + 1}`,
        ...(parameters.length > 0 ? { parameters } : {}),
        responses: { "200": { description: "ok" } }
      }
    })}`;
  });
  return `{"openapi":"3.1.0","info":{"title":"Routes","version":"1.0.0"},"paths":{${items.join(
    ","
  )}}}`;
}

function compile(templates: readonly string[]) {
  return compileOpenApi({
    documents: { "routes.json": documentWith(templates) },
    entrypoint: "routes.json"
  });
}

function conflict(left: string, right: string): boolean {
  return templatesConflict(parsePathTemplate(left), parsePathTemplate(right));
}

describe("SPEC.md section 13.4 ambiguity wording", () => {
  it("states the all-literal exemption", () => {
    expect(section134()).toMatch(/all[- ]literal/);
  });

  it("names the exempt pair /a/{x} and /a/b", () => {
    expect(section134()).toContain("/a/{x} and /a/b");
  });

  it("says matching prefers the literal route for the exemption", () => {
    expect(section134()).toMatch(/literal route/);
    expect(section134()).toMatch(/prefers the literal route/);
  });
});

describe("section 13.4 ambiguity rule against the compiler", () => {
  it("rejects the ambiguous pairs the section names", () => {
    expect(() => compile(["/pets/{id}", "/pets/{name}"])).toThrow(OalError);
    expect(() => compile(["/a/{x}/c", "/a/b/{y}"])).toThrow(OalError);
  });

  it("compiles the exempt pairs the section names", () => {
    expect(() => compile(["/a/{x}", "/a/b"])).not.toThrow();
    expect(() => compile(["/a/{x}/c", "/a/b/d"])).not.toThrow();
  });

  it("prefers the literal route when the exempt pair matches", () => {
    const { contract } = compile(["/a/{x}", "/a/b"]);
    const result = matchRoute(contract.operations, "GET", "/a/b");
    expect(result.match?.operation.key).toBe("path:GET /a/b");
  });
});

describe("section 13.4 rule against the routes test case list", () => {
  it("conflicts only for same-depth pairs without an all-literal side", () => {
    expect(conflict("/a/{x}/c", "/a/b/{y}")).toBe(true);
    expect(conflict("/a/{x}/{z}", "/a/b/{y}")).toBe(true);
    expect(conflict("/pets/{id}", "/pets/{petId}")).toBe(true);
    expect(conflict("/a/{x}/c", "/a/b/d")).toBe(false);
    expect(conflict("/a/{x}", "/a/b")).toBe(false);
    expect(conflict("/params/literal/{id}", "/params/literal/fixed")).toBe(
      false
    );
    expect(conflict("/a/{x}", "/a/{x}/b")).toBe(false);
  });
});
