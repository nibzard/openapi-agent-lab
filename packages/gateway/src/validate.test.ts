import { describe, expect, it } from "vitest";

import { SchemaValidator, type Json } from "@oal/core";
import type { OperationIR, RequestBodyIR, SchemaIR } from "@oal/contract-ir";
import {
  createContractSchemaLookup,
  stripProperties,
  validateBody,
  type ParsedRequest
} from "./validate.ts";

function schemaIr(
  uid: string,
  body: Json,
  pointer = "",
  document = ""
): SchemaIR {
  return { uid, schema: body, source_pointer: pointer, document_uri: document };
}

function requestBody(schemaRef: string, mediaType: string): RequestBodyIR {
  return {
    required: true,
    description: null,
    content: [
      {
        media_type: mediaType,
        schema_ref: schemaRef,
        examples: [],
        support: "supported",
        support_reason_codes: []
      }
    ],
    source_pointer: ""
  };
}

function bodyOperation(schemaRef: string, mediaType: string): OperationIR {
  return {
    key: "path:POST /things",
    uid: "op_body",
    surface: "path",
    method: "POST",
    path_template: "/things",
    route_segments: [{ kind: "literal", value: "things" }],
    operation_id: null,
    tool_name: "create_thing",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    request_body: requestBody(schemaRef, mediaType),
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function parsed(
  body: Json | undefined,
  contentType: string | null
): ParsedRequest {
  return {
    pathParameters: {},
    query: {},
    headers: {},
    cookies: {},
    body,
    contentType
  };
}

const NODE_POINTER = "#/components/schemas/Node";
const nodeSchema = {
  type: "object",
  required: ["name", "children"],
  properties: {
    name: { type: "string" },
    children: { type: "array", items: { $ref: NODE_POINTER } }
  }
};

describe("contract schema lookup", () => {
  it("resolves schema UIDs and binds document-relative references", () => {
    const lookup = createContractSchemaLookup({
      sch_node: schemaIr("sch_node", nodeSchema, NODE_POINTER, "openapi.yaml")
    });
    const bound = lookup("sch_node") as Record<string, Json>;
    expect(bound).toBeDefined();
    const children = bound.properties as Record<string, Json>;
    const items = (children.children as Record<string, Json>).items as Record<
      string,
      Json
    >;
    // The recursive pointer is bound to its document so the shared
    // validator can resolve it through resolveRef.
    expect(items.$ref).toBe(`oal-schema:openapi.yaml${NODE_POINTER}`);
    expect(lookup(items.$ref as string)).toEqual(bound);
  });

  it("resolves cross-file and unique bare pointer references", () => {
    const lookup = createContractSchemaLookup({
      sch_shared: schemaIr(
        "sch_shared",
        { type: "object" },
        "#/components/schemas/Shared",
        "shared.yaml"
      )
    });
    expect(lookup("shared.yaml#/components/schemas/Shared")).toBeDefined();
    expect(lookup("#/components/schemas/Shared")).toBeDefined();
    expect(lookup("sch_missing")).toBeUndefined();
  });

  it("leaves an ambiguous bare pointer unresolved", () => {
    const lookup = createContractSchemaLookup({
      sch_a: schemaIr(
        "sch_a",
        { type: "object" },
        "#/components/schemas/Shared",
        "a.yaml"
      ),
      sch_b: schemaIr(
        "sch_b",
        { type: "string" },
        "#/components/schemas/Shared",
        "b.yaml"
      )
    });
    expect(lookup("#/components/schemas/Shared")).toBeUndefined();
  });

  it("resolves a cross-file reference to a deduplicated document (V2C)", () => {
    // The compiler's registry is content-addressed: when two documents
    // declare the same schema, one UID survives with only the first
    // document's pointer. A preserved cross-file reference that still
    // names the duplicate document must resolve anyway.
    const lookup = createContractSchemaLookup({
      sch_wrapper: schemaIr(
        "sch_wrapper",
        {
          type: "object",
          required: ["shared"],
          properties: {
            shared: { $ref: "duplicate.yaml#/components/schemas/Shared" }
          }
        },
        "#/components/schemas/Wrapper",
        "a.yaml"
      ),
      sch_shared: schemaIr(
        "sch_shared",
        {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } }
        },
        "#/components/schemas/Shared",
        "a.yaml"
      )
    });
    expect(lookup("a.yaml#/components/schemas/Shared")).toBeDefined();
    expect(lookup("duplicate.yaml#/components/schemas/Shared")).toBeDefined();
  });

  it("validates a body whose schema reaches the duplicate through a ref", () => {
    const lookup = createContractSchemaLookup({
      sch_wrapper: schemaIr(
        "sch_wrapper",
        {
          type: "object",
          required: ["shared"],
          properties: {
            shared: { $ref: "duplicate.yaml#/components/schemas/Shared" }
          }
        },
        "#/components/schemas/Wrapper",
        "a.yaml"
      ),
      sch_shared: schemaIr(
        "sch_shared",
        {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } }
        },
        "#/components/schemas/Shared",
        "a.yaml"
      )
    });
    const result = validateBody(
      bodyOperation("sch_wrapper", "application/json"),
      parsed({ shared: { name: "n" } }, "application/json"),
      lookup
    );
    expect(result.violations).toEqual([]);
  });

  it("keeps a pointer declared in two documents unresolved cross-file", () => {
    const lookup = createContractSchemaLookup({
      sch_a: schemaIr(
        "sch_a",
        { type: "object" },
        "#/components/schemas/Shared",
        "a.yaml"
      ),
      sch_b: schemaIr(
        "sch_b",
        { type: "string" },
        "#/components/schemas/Shared",
        "b.yaml"
      )
    });
    expect(lookup("zz.yaml#/components/schemas/Shared")).toBeUndefined();
  });

  it("breaks a pointer-key collision by the smallest registry key", () => {
    const lookup = createContractSchemaLookup({
      sch_b: schemaIr(
        "sch_b",
        { type: "string" },
        "#/components/schemas/Shared",
        "a.yaml"
      ),
      sch_a: schemaIr(
        "sch_a",
        { type: "object" },
        "#/components/schemas/Shared",
        "a.yaml"
      )
    });
    const found = lookup("#/components/schemas/Shared") as Record<string, Json>;
    expect(found.type).toBe("object");
  });
});

describe("recursive schema references (R02)", () => {
  const lookup = createContractSchemaLookup({
    sch_node: schemaIr("sch_node", nodeSchema, NODE_POINTER, "openapi.yaml")
  });

  it("accepts a valid recursive body the compiler's pointers describe", () => {
    const body = {
      name: "a",
      children: [{ name: "b", children: [{ name: "c", children: [] }] }]
    };
    const result = validateBody(
      bodyOperation("sch_node", "application/json"),
      parsed(body, "application/json"),
      lookup
    );
    expect(result.violations).toEqual([]);
  });

  it("reports violations inside the referenced schema", () => {
    const body = {
      name: "a",
      children: [{ name: 5, children: [] }]
    };
    const result = validateBody(
      bodyOperation("sch_node", "application/json"),
      parsed(body, "application/json"),
      lookup
    );
    expect(result.violations).toEqual([
      {
        location: "body",
        pointer: "/children/0/name",
        code: "type",
        message: 'Expected type "string".'
      }
    ]);
  });
});

describe("body value coverage (R09)", () => {
  const uidLookup = (schemas: Record<string, Json>) => {
    const registry: Record<string, SchemaIR> = {};
    for (const [uid, schema] of Object.entries(schemas)) {
      registry[uid] = schemaIr(uid, schema);
    }
    return createContractSchemaLookup(registry);
  };

  it("validates an array body against an array schema", () => {
    const lookup = uidLookup({
      sch_tags: {
        type: "array",
        maxItems: 2,
        items: { type: "string", maxLength: 3 }
      }
    });
    const result = validateBody(
      bodyOperation("sch_tags", "application/json"),
      parsed(["toolong1", "toolong2", "toolong3"], "application/json"),
      lookup
    );
    expect(result.violations.map((entry) => entry.code)).toEqual([
      "maxLength",
      "maxLength",
      "maxLength",
      "maxItems"
    ]);
  });

  it("validates scalar and null JSON bodies", () => {
    const lookup = uidLookup({
      sch_count: { type: "integer", maximum: 10 },
      sch_nullable: { type: ["string", "null"] }
    });
    const over = validateBody(
      bodyOperation("sch_count", "application/json"),
      parsed(11, "application/json"),
      lookup
    );
    expect(over.violations.map((entry) => entry.code)).toEqual(["maximum"]);

    const nulled = validateBody(
      bodyOperation("sch_nullable", "application/json"),
      parsed(null, "application/json"),
      lookup
    );
    expect(nulled.violations).toEqual([]);
  });

  it("validates text bodies only when the schema declares strings", () => {
    const lookup = uidLookup({
      sch_text: { type: "string", maxLength: 4 },
      sch_json: { type: "object", required: ["name"] }
    });
    const text = validateBody(
      bodyOperation("sch_text", "text/plain"),
      parsed("toolong", "text/plain"),
      lookup
    );
    expect(text.violations.map((entry) => entry.code)).toEqual(["maxLength"]);

    const passthrough = validateBody(
      bodyOperation("sch_json", "text/plain"),
      parsed("not-an-object", "text/plain"),
      lookup
    );
    expect(passthrough.violations).toEqual([]);
  });

  it("validates URL-encoded form bodies parsed into objects (V2A)", () => {
    // The server parses `id=5` into { id: 5 } through form coercion.
    const lookup = uidLookup({
      sch_form: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } }
      }
    });
    const invalid = validateBody(
      bodyOperation("sch_form", "application/x-www-form-urlencoded"),
      parsed({ id: 5 }, "application/x-www-form-urlencoded"),
      lookup
    );
    expect(invalid.violations).toEqual([
      {
        location: "body",
        pointer: "/id",
        code: "type",
        message: 'Expected type "string".'
      }
    ]);

    const valid = validateBody(
      bodyOperation("sch_form", "application/x-www-form-urlencoded"),
      parsed({ id: "thing_1" }, "application/x-www-form-urlencoded"),
      lookup
    );
    expect(valid.violations).toEqual([]);
  });
});

describe("readOnly stripping recursion (R12)", () => {
  const nestedReadOnly = {
    type: "object",
    required: ["name", "nested"],
    properties: {
      name: { type: "string" },
      nested: {
        required: ["id"],
        properties: { id: { type: "string", readOnly: true } }
      }
    }
  };

  it("accepts a conforming request that omits nested readOnly fields", () => {
    const lookup = createContractSchemaLookup({
      sch_nested: schemaIr("sch_nested", nestedReadOnly)
    });
    const result = validateBody(
      bodyOperation("sch_nested", "application/json"),
      parsed({ name: "n", nested: {} }, "application/json"),
      lookup
    );
    expect(result.violations).toEqual([]);
  });

  it("strips flagged properties inside items and combinators", () => {
    const schema = {
      type: "object",
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          items: {
            allOf: [
              { required: ["id"], properties: { id: { readOnly: true } } },
              { properties: { label: { type: "string" } } }
            ]
          }
        },
        choice: {
          oneOf: [
            {
              type: "object",
              required: ["token"],
              properties: { token: { readOnly: true } }
            },
            { type: "null" }
          ]
        }
      }
    };
    const stripped = stripProperties(schema, "readOnly");
    expect(
      new SchemaValidator(stripped).errors({ rows: [{}], choice: null })
    ).toEqual([]);
    // The unstripped schema still rejects the same conforming value.
    expect(
      new SchemaValidator(schema as Json).errors({ rows: [{}], choice: null })
        .length
    ).toBeGreaterThan(0);
  });

  it("keeps required names that declare no property", () => {
    const stripped = stripProperties(
      { required: ["meta"], properties: {} },
      "readOnly"
    );
    expect(new SchemaValidator(stripped).errors({})).toEqual([
      {
        pointer: "",
        code: "required",
        message: 'Required property "meta" is missing.',
        schema_path: "/required"
      }
    ]);
  });

  it("mirrors the recursion for writeOnly on the response side", () => {
    const schema = {
      type: "object",
      required: ["nested"],
      properties: {
        nested: {
          required: ["secret"],
          properties: { secret: { type: "string", writeOnly: true } }
        }
      }
    };
    const stripped = stripProperties(schema, "writeOnly");
    expect(new SchemaValidator(stripped).errors({ nested: {} })).toEqual([]);
  });

  it("never mutates the input schema", () => {
    const before = JSON.stringify(nestedReadOnly);
    stripProperties(nestedReadOnly, "readOnly");
    expect(JSON.stringify(nestedReadOnly)).toBe(before);
  });
});

describe("flagged properties behind references (V2B)", () => {
  const refLookup = createContractSchemaLookup({
    sch_item: schemaIr("sch_item", {
      type: "object",
      required: ["id", "label"],
      properties: {
        id: { type: "string", readOnly: true },
        label: { type: "string" }
      }
    }),
    sch_cart: schemaIr("sch_cart", {
      type: "object",
      required: ["item"],
      properties: { item: { $ref: "sch_item" } }
    })
  });

  it("accepts a request that omits a required readOnly field behind a ref", () => {
    const result = validateBody(
      bodyOperation("sch_cart", "application/json"),
      parsed({ item: { label: "l" } }, "application/json"),
      refLookup
    );
    expect(result.violations).toEqual([]);
  });

  it("still enforces the unflagged required fields behind a ref", () => {
    const result = validateBody(
      bodyOperation("sch_cart", "application/json"),
      parsed({ item: {} }, "application/json"),
      refLookup
    );
    // A reference keeps its own pointer while the validator descends
    // into the stripped target, so the violation names the ref site.
    expect(result.violations).toEqual([
      {
        location: "body",
        pointer: "/item",
        code: "required",
        message: 'Required property "label" is missing.'
      }
    ]);
  });

  it("strips through a cyclic reference without hanging", () => {
    const CYCLIC_POINTER = "#/components/schemas/Cyclic";
    const cyclicLookup = createContractSchemaLookup({
      sch_cyclic: schemaIr(
        "sch_cyclic",
        {
          type: "object",
          required: ["name", "stamp", "children"],
          properties: {
            name: { type: "string" },
            stamp: { type: "string", readOnly: true },
            children: { type: "array", items: { $ref: CYCLIC_POINTER } }
          }
        },
        CYCLIC_POINTER,
        "openapi.yaml"
      )
    });
    const result = validateBody(
      bodyOperation("sch_cyclic", "application/json"),
      parsed(
        {
          name: "a",
          children: [{ name: "b", children: [{ name: "c", children: [] }] }]
        },
        "application/json"
      ),
      cyclicLookup
    );
    expect(result.violations).toEqual([]);
  });
});
