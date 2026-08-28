import { describe, expect, it } from "vitest";

import { canonicalJson, SchemaValidator, type Json } from "@oal/core";

import { compileOpenApi } from "../src/index.ts";

/**
 * Compile one document that exposes a single named schema, and return
 * that schema's normalized Draft 2020-12 form.
 */
function normalizedSchema(
  openapi: string,
  body: Record<string, unknown>
): Json {
  const document = JSON.stringify({
    openapi,
    info: { title: "Items", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Thing" }
                }
              }
            }
          }
        }
      }
    },
    components: { schemas: { Thing: body } }
  });
  const { contract } = compileOpenApi(
    { documents: { "items.json": document }, entrypoint: "items.json" },
    {}
  );
  const schema = Object.values(contract.schemas).find(
    (entry) => entry.source_pointer === "#/components/schemas/Thing"
  )?.schema;
  if (schema === undefined) {
    throw new Error("normalization did not register the Thing schema");
  }
  return schema;
}

describe("tuple-form items across dialects (V2U)", () => {
  it("converts a 3.1 items array into prefixItems", () => {
    expect(
      normalizedSchema("3.1.0", {
        type: "array",
        items: [
          { type: "string", minLength: 2 },
          { type: "integer", minimum: 5 }
        ]
      })
    ).toEqual({
      type: "array",
      prefixItems: [
        { type: "string", minLength: 2 },
        { type: "integer", minimum: 5 }
      ]
    });
  });

  it("moves a 3.1 additionalItems rest schema into items", () => {
    expect(
      normalizedSchema("3.1.0", {
        type: "array",
        items: [{ type: "string" }],
        additionalItems: { type: "integer" }
      })
    ).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "integer" }
    });
  });

  it("enforces per-item constraints from a lenient 3.1 tuple", () => {
    const schema = normalizedSchema("3.1.0", {
      type: "array",
      items: [{ type: "string", minLength: 2 }, { type: "integer" }]
    });
    const validator = new SchemaValidator(schema);
    expect(validator.errors(["ab", 7])).toEqual([]);
    expect(
      validator.errors(["a", 7]).map((violation) => violation.code)
    ).toContain("minLength");
    expect(
      validator.errors(["ab", "x"]).map((violation) => violation.code)
    ).toContain("type");
  });

  it("treats a 3.1 tuple as equivalent to the 3.0 form", () => {
    const left = normalizedSchema("3.0.3", {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "integer" }
    });
    const right = normalizedSchema("3.1.0", {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "integer" }
    });
    expect(canonicalJson(right)).toBe(canonicalJson(left));
  });
});

describe("single-schema items with additionalItems (V2V)", () => {
  it("drops the inert additionalItems schema beside single-schema items", () => {
    expect(
      normalizedSchema("3.0.3", {
        type: "array",
        items: { type: "string" },
        additionalItems: { type: "integer" }
      })
    ).toEqual({
      type: "array",
      items: { type: "string" }
    });
  });

  it("drops the inert additionalItems boolean beside single-schema items", () => {
    expect(
      normalizedSchema("3.0.3", {
        type: "array",
        items: { type: "string" },
        additionalItems: false
      })
    ).toEqual({
      type: "array",
      items: { type: "string" }
    });
  });

  it("keeps single-schema items untouched without additionalItems", () => {
    const items = { type: "string" };
    expect(normalizedSchema("3.0.3", { type: "array", items })).toEqual({
      type: "array",
      items: { type: "string" }
    });
    expect(normalizedSchema("3.1.0", { type: "array", items })).toEqual({
      type: "array",
      items: { type: "string" }
    });
  });

  it("treats 3.0 single items plus additionalItems as equivalent to 3.1", () => {
    const left = normalizedSchema("3.0.3", {
      type: "array",
      items: { type: "string" },
      additionalItems: { type: "integer" }
    });
    const right = normalizedSchema("3.1.0", {
      type: "array",
      items: { type: "string" }
    });
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });
});
