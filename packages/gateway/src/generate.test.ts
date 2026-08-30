import { describe, expect, it } from "vitest";

import { SchemaValidator, type Json } from "@oal/core";
import type { ResponseIR, SchemaIR } from "@oal/contract-ir";
import { generateValue, GenerationUnsupportedError } from "./generate.ts";
import {
  chooseSuccessResponse,
  findResponseForStatus,
  selectExampleValue,
  selectResponse
} from "./select.ts";
import { createContractSchemaLookup } from "./validate.ts";

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

  it("applies the section 15.5 order: example, const, default, enum", () => {
    expect(
      generateValue(
        {
          examples: ["from-examples"],
          example: "from-example",
          const: "pinned",
          default: "fallback",
          enum: ["member"]
        },
        options
      )
    ).toBe("from-examples");
    expect(
      generateValue({ example: "from-example", const: "pinned" }, options)
    ).toBe("from-example");
    expect(generateValue({ const: "pinned", default: 41 }, options)).toBe(
      "pinned"
    );
    expect(generateValue({ default: 41, enum: [7, 41] }, options)).toBe(41);
  });

  it("honors numeric exclusive bounds for integers and numbers", () => {
    const cases: Json[] = [
      { type: "integer", exclusiveMinimum: 1 },
      { type: "integer", exclusiveMaximum: 0 },
      { type: "integer", minimum: 5, exclusiveMinimum: true },
      { type: "number", exclusiveMinimum: 0, maximum: 10 },
      { type: "number", exclusiveMinimum: 0.5, exclusiveMaximum: 1.5 },
      { type: "integer", exclusiveMinimum: 0, maximum: 10, multipleOf: 4 },
      { type: "number", minimum: 0.3, multipleOf: 0.1 }
    ];
    for (const schema of cases) {
      const value = generateValue(schema, options);
      expect(
        new SchemaValidator(schema).errors(value),
        JSON.stringify(schema)
      ).toEqual([]);
    }
    expect(
      generateValue({ type: "integer", exclusiveMinimum: 1 }, options)
    ).toBe(2);
    expect(
      generateValue(
        { type: "integer", minimum: 5, exclusiveMinimum: true },
        options
      )
    ).toBe(6);
    expect(
      generateValue(
        { type: "integer", exclusiveMinimum: 0, maximum: 10, multipleOf: 4 },
        options
      )
    ).toBe(4);
  });

  it("fails closed when the numeric bounds admit no value", () => {
    expect(() =>
      generateValue(
        { type: "integer", exclusiveMinimum: 1, exclusiveMaximum: 2 },
        options
      )
    ).toThrow(GenerationUnsupportedError);
    expect(() =>
      generateValue(
        { type: "integer", minimum: 3, maximum: 3, exclusiveMinimum: 3 },
        options
      )
    ).toThrow(GenerationUnsupportedError);
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

  it("generates a schema of only additionalProperties as a map", () => {
    // Shape of the e2b metrics response: no type word, no properties,
    // one value schema under additionalProperties.
    const template = {
      type: "object",
      required: ["cpuUsedPct"],
      properties: { cpuUsedPct: { type: "number" } }
    };
    const value = generateValue(
      {
        required: ["sandboxes"],
        properties: {
          sandboxes: { additionalProperties: template }
        }
      },
      options
    ) as { sandboxes: Record<string, { cpuUsedPct: number }> };
    const entries = Object.entries(value.sandboxes);
    expect(entries).toHaveLength(1);
    const [key, metric] = entries[0] as [string, { cpuUsedPct: number }];
    expect(key).toMatch(/^gen_/);
    expect(typeof metric.cpuUsedPct).toBe("number");
    expect(
      new SchemaValidator({ additionalProperties: template }).errors(
        value.sandboxes
      )
    ).toEqual([]);
  });

  it("keeps a boolean additionalProperties a free-form object", () => {
    expect(generateValue({ additionalProperties: true }, options)).toEqual({});
    expect(generateValue({ additionalProperties: false }, options)).toEqual({});
  });

  it("generates a tuple that fits the count bound from prefixItems", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false
    };
    const value = generateValue(schema, options) as Json[];
    expect(value).toHaveLength(2);
    expect(typeof value[0]).toBe("string");
    expect(typeof value[1]).toBe("number");
    expect(new SchemaValidator(schema).errors(value)).toHaveLength(0);
  });

  it("fails closed when a closed tuple exceeds the count bound", () => {
    // The V2U normalization maps a 3.0 tuple with `additionalItems:
    // false` to `prefixItems` plus `items: false`.
    const schema = {
      type: "array",
      minItems: 3,
      prefixItems: [
        { type: "string" },
        { type: "integer" },
        { type: "string" }
      ],
      items: false
    };
    expect(() => generateValue(schema, options)).toThrow(
      GenerationUnsupportedError
    );
  });

  it("extends a tuple past its prefix from the rest schema", () => {
    const schema = {
      type: "array",
      minItems: 5,
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: { type: "boolean" }
    };
    const value = generateValue(schema, {
      seed: "op_test",
      arrayBound: 8
    }) as Json[];
    expect(value).toHaveLength(5);
    expect(typeof value[0]).toBe("string");
    expect(typeof value[1]).toBe("number");
    expect(value.slice(2)).toEqual([false, false, false]);
    expect(new SchemaValidator(schema).errors(value)).toHaveLength(0);
  });

  it("fails closed when a declared minimum exceeds the closed prefix", () => {
    const schema = {
      type: "array",
      minItems: 4,
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false
    };
    expect(() =>
      generateValue(schema, { seed: "op_test", arrayBound: 8 })
    ).toThrow(GenerationUnsupportedError);
  });

  it("fails closed when maxItems undercuts the prefix length", () => {
    const schema = {
      type: "array",
      maxItems: 2,
      prefixItems: [{ type: "string" }, { type: "integer" }, { type: "string" }]
    };
    expect(() => generateValue(schema, options)).toThrow(
      GenerationUnsupportedError
    );
  });

  it("keeps the count cap for plain item arrays", () => {
    const capped = generateValue(
      { type: "array", items: { type: "integer" }, minItems: 3 },
      options
    ) as Json[];
    expect(capped).toHaveLength(2);
    const bounded = generateValue(
      { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 5 },
      options
    ) as Json[];
    expect(bounded).toHaveLength(3);
    const single = generateValue(
      { type: "array", items: { type: "integer" } },
      options
    ) as Json[];
    expect(single).toHaveLength(1);
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

  it("accepts a format value that satisfies a strict vendor pattern", () => {
    // The Steel v1 contract narrows uuid and date-time with full regexes
    // that no bounded pattern producer covers; the format shape must be
    // accepted when it satisfies the pattern.
    const uuidPattern =
      "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
    const dateTimePattern =
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";
    expect(
      generateValue(
        { type: "string", format: "uuid", pattern: uuidPattern },
        options
      )
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(
      generateValue(
        { type: "string", format: "date-time", pattern: dateTimePattern },
        options
      )
    ).toBe("2000-01-01T00:00:00.000Z");
  });

  it("rejects a format value the pattern refuses", () => {
    expect(() =>
      generateValue(
        { type: "string", format: "uuid", pattern: "^[A-Z]+$" },
        options
      )
    ).toThrow(GenerationUnsupportedError);
  });

  it("namespaces seeds so unrelated paths differ", () => {
    const schema = { type: "string" };
    const left = generateValue(schema, { seed: "op_a" });
    const right = generateValue(schema, { seed: "op_b" });
    expect(left).not.toEqual(right);
  });

  it("generates a finite valid value for a recursive schema", () => {
    const nodePointer = "#/components/schemas/Node";
    const nodeSchema = {
      type: "object",
      required: ["name", "children"],
      properties: {
        name: { type: "string" },
        children: { type: "array", items: { $ref: nodePointer } }
      }
    };
    const registry: Record<string, SchemaIR> = {
      sch_node: {
        uid: "sch_node",
        schema: nodeSchema,
        source_pointer: nodePointer,
        document_uri: "openapi.yaml"
      }
    };
    const lookup = createContractSchemaLookup(registry);
    const generationOptions = { seed: "op_recursive", lookup };

    const value = generateValue({ $ref: "sch_node" }, generationOptions);
    expect(generateValue({ $ref: "sch_node" }, generationOptions)).toEqual(
      value
    );
    expect(
      new SchemaValidator(lookup("sch_node") as Json, {
        resolveRef: lookup
      }).errors(value)
    ).toEqual([]);

    // The recursion descends and terminates in an empty children array.
    let node = value as { children?: Json[] };
    let depth = 0;
    while (Array.isArray(node.children) && node.children.length > 0) {
      node = node.children[0] as { children?: Json[] };
      depth += 1;
    }
    expect(depth).toBeGreaterThan(1);
    expect(depth).toBeLessThan(24);
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
