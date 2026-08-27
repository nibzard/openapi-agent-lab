import { describe, expect, it } from "vitest";

import { SchemaValidator, type Json } from "@oal/core";
import type { ResponseIR } from "@oal/contract-ir";
import { generateValue, GenerationUnsupportedError } from "./generate.ts";
import {
  chooseSuccessResponse,
  findResponseForStatus,
  selectExampleValue,
  selectResponse
} from "./select.ts";

function response(init: Partial<ResponseIR>): ResponseIR {
  return {
    selector: init.selector ?? "200",
    selector_kind: init.selector_kind ?? "exact",
    status: init.status ?? 200,
    description: null,
    headers: [],
    content: init.content ?? [],
    source_pointer: ""
  };
}

describe("deterministic generation", () => {
  const options = { seed: "op_test" };

  it("respects const, enum order, and default", () => {
    expect(generateValue({ const: "pinned" }, options)).toBe("pinned");
    expect(generateValue({ default: 41 }, options)).toBe(41);
    expect(generateValue({ enum: ["zebra", "apple", "apple"] }, options)).toBe(
      "apple"
    );
  });

  it("generates bounded strings and numbers within bounds", () => {
    const value = generateValue(
      { type: "string", minLength: 3, maxLength: 40 },
      options
    );
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeGreaterThanOrEqual(3);
    expect((value as string).length).toBeLessThanOrEqual(40);

    expect(
      generateValue({ type: "integer", minimum: 5, maximum: 9 }, options)
    ).toBe(7);
    expect(
      generateValue(
        { type: "integer", minimum: 0, maximum: 100, multipleOf: 10 },
        options
      )
    ).toBe(50);
    expect(
      generateValue(
        { type: "number", exclusiveMinimum: 0, minimum: 0, maximum: 10 },
        options
      )
    ).toBe(5);
  });

  it("generates objects with required properties in stable order", () => {
    const value = generateValue(
      {
        type: "object",
        required: ["beta", "alpha"],
        properties: {
          alpha: { type: "integer" },
          beta: { type: "string" }
        }
      },
      options
    );
    expect(Object.keys(value as object)).toEqual(["alpha", "beta"]);
    expect((value as { alpha: number }).alpha).toBeGreaterThanOrEqual(0);
  });

  it("fills minProperties and dedupes unique arrays", () => {
    const filled = generateValue(
      { type: "object", minProperties: 2 },
      options
    ) as Record<string, unknown>;
    expect(Object.keys(filled).length).toBeGreaterThanOrEqual(2);

    const unique = generateValue(
      {
        type: "array",
        items: { type: "integer" },
        minItems: 3,
        uniqueItems: true
      },
      options
    ) as Json[];
    const keys = unique.map((item) => JSON.stringify(item));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("produces reserved-domain values for formats", () => {
    expect(generateValue({ type: "string", format: "uri" }, options)).toMatch(
      /^https:\/\/example\.invalid\//
    );
    expect(
      generateValue({ type: "string", format: "date-time" }, options)
    ).toBe("2000-01-01T00:00:00.000Z");
    expect(generateValue({ type: "string", format: "email" }, options)).toMatch(
      /@example\.invalid$/
    );
  });

  it("produces values that validate against their schema", () => {
    const schema = {
      type: "object",
      required: ["name", "count"],
      properties: {
        name: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0, maximum: 1000 },
        tags: { type: "array", items: { type: "string" }, minItems: 1 }
      },
      additionalProperties: false
    };
    const value = generateValue(schema, options);
    expect(new SchemaValidator(schema).errors(value)).toHaveLength(0);
  });

  it("strips writeOnly properties on the response side", () => {
    const schema = {
      type: "object",
      required: ["name", "secret"],
      properties: {
        name: { type: "string" },
        secret: { type: "string", writeOnly: true }
      }
    };
    const value = generateValue(schema, options) as Record<string, unknown>;
    expect(value.name).toBeDefined();
    expect(value.secret).toBeUndefined();
  });

  it("picks oneOf branches deterministically and validly", () => {
    const schema = {
      oneOf: [{ type: "integer" }, { type: "string" }]
    };
    const first = generateValue(schema, options);
    const second = generateValue(schema, options);
    expect(first).toEqual(second);
    expect(new SchemaValidator(schema).errors(first)).toHaveLength(0);
  });

  it("merges allOf constraints", () => {
    const value = generateValue(
      {
        allOf: [
          {
            type: "object",
            required: ["a"],
            properties: { a: { type: "integer" } }
          },
          { required: ["b"], properties: { b: { type: "string" } } }
        ]
      },
      options
    );
    expect(Object.keys(value as object).sort()).toEqual(["a", "b"]);
  });

  it("fails closed on unproducible schemas", () => {
    expect(() =>
      generateValue({ type: "string", pattern: "^(?!x)(?=y).*$" }, options)
    ).toThrow(GenerationUnsupportedError);
    expect(() => generateValue(false, options)).toThrow(
      GenerationUnsupportedError
    );
  });

  it("namespaces seeds so unrelated paths differ", () => {
    const schema = { type: "string" };
    const left = generateValue(schema, { seed: "op_a" });
    const right = generateValue(schema, { seed: "op_b" });
    expect(left).not.toEqual(right);
  });
});

describe("response selection precedence", () => {
  it("prefers 200 then 201 then 202 then 204", () => {
    const responses = [
      response({ selector: "204", status: 204 }),
      response({ selector: "201", status: 201 }),
      response({ selector: "404", status: 404 })
    ];
    expect(chooseSuccessResponse(responses)?.status).toBe(201);
    expect(
      chooseSuccessResponse([
        response({ selector: "202", status: 202 }),
        response({ selector: "204", status: 204 })
      ])?.status
    ).toBe(202);
  });

  it("takes the lowest other 2xx and emits 2XX as concrete 200", () => {
    expect(
      chooseSuccessResponse([response({ selector: "206", status: 206 })])
        ?.status
    ).toBe(206);
    const range = chooseSuccessResponse([
      response({ selector: "2XX", selector_kind: "range", status: null })
    ]);
    expect(range?.selector_kind).toBe("range");
    const selected = selectResponse(
      "path:GET /x",
      [
        response({
          selector: "2XX",
          selector_kind: "range",
          status: null,
          content: [
            {
              media_type: "application/json",
              schema_ref: null,
              examples: [{ name: "ok", value: { fine: true }, summary: null }],
              support: "supported",
              support_reason_codes: []
            }
          ]
        })
      ],
      [],
      { seed: "s" }
    );
    expect(selected?.status).toBe(200);
    expect(selected?.provenance).toBe("example:ok");
  });

  it("never selects a default response as success", () => {
    expect(
      chooseSuccessResponse([
        response({
          selector: "default",
          selector_kind: "default",
          status: null
        })
      ])
    ).toBeNull();
  });

  it("finds exact, range-class, then default for a status", () => {
    const exact = response({ selector: "404", status: 404 });
    const range = response({
      selector: "4XX",
      selector_kind: "range",
      status: null
    });
    const fallback = response({
      selector: "default",
      selector_kind: "default",
      status: null
    });
    expect(findResponseForStatus([fallback, range, exact], 404)).toBe(exact);
    expect(findResponseForStatus([fallback, range], 404)).toBe(range);
    expect(findResponseForStatus([fallback], 404)).toBe(fallback);
  });

  it("lets fixtures win with recorded provenance", () => {
    const selected = selectResponse(
      "path:POST /v1/widgets",
      [response({ selector: "201", status: 201 })],
      [
        {
          id: "create-example",
          operation: "path:POST /v1/widgets",
          status: 201,
          headers: { location: "/v1/widgets/widget_0001" },
          body: { kind: "json_inline", value: { id: "widget_0001" } }
        }
      ],
      { seed: "s" }
    );
    expect(selected?.provenance).toBe("fixture:create-example");
    expect(selected?.headers.location).toBe("/v1/widgets/widget_0001");
    expect(selected?.body).toEqual({ id: "widget_0001" });
  });

  it("prefers the singular example then the first named example", () => {
    expect(
      selectExampleValue([
        { name: "beta", value: 2 },
        { name: "alpha", value: 1 }
      ])
    ).toEqual({ value: 1, provenance: "example:alpha" });
    expect(
      selectExampleValue([
        { name: null, value: 9 },
        { name: "alpha", value: 1 }
      ])
    ).toEqual({ value: 9, provenance: "example:singular" });
  });
});
