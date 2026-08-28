import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import type { ResponseIR, SchemaIR } from "@oal/contract-ir";
import { validateResponse } from "./response.ts";
import type { SelectedResponse } from "./select.ts";
import { createContractSchemaLookup } from "./validate.ts";

function schemaIr(
  uid: string,
  body: Json,
  pointer = "",
  document = ""
): SchemaIR {
  return { uid, schema: body, source_pointer: pointer, document_uri: document };
}

function jsonResponse(schemaRef: string): ResponseIR {
  return {
    selector: "200",
    selector_kind: "exact",
    status: 200,
    description: null,
    headers: [],
    content: [
      {
        media_type: "application/json",
        schema_ref: schemaRef,
        examples: [],
        support: "supported",
        support_reason_codes: []
      }
    ],
    source_pointer: ""
  };
}

function selected(
  response: ResponseIR,
  body: Json | undefined
): SelectedResponse {
  return {
    status: 200,
    response,
    mediaType: "application/json",
    headers: {},
    body,
    provenance: "schema_generation",
    approximation: null
  };
}

const NODE_POINTER = "#/components/schemas/Node";
const lookup = createContractSchemaLookup({
  sch_node: schemaIr(
    "sch_node",
    {
      type: "object",
      required: ["name", "children"],
      properties: {
        name: { type: "string" },
        children: { type: "array", items: { $ref: NODE_POINTER } }
      }
    },
    NODE_POINTER,
    "openapi.yaml"
  )
});

describe("response validation with recursive references (R02)", () => {
  const response = jsonResponse("sch_node");

  it("accepts a valid recursive body", () => {
    const body = {
      name: "a",
      children: [{ name: "b", children: [{ name: "c", children: [] }] }]
    };
    expect(
      validateResponse([response], selected(response, body), lookup).violations
    ).toEqual([]);
  });

  it("reports the violation inside the referenced schema", () => {
    const body = { name: "a", children: [{ name: 5, children: [] }] };
    const result = validateResponse(
      [response],
      selected(response, body),
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

describe("response validation with nested writeOnly (R12)", () => {
  const response = jsonResponse("sch_report");
  const reportLookup = (ref: string): Json | undefined =>
    ref === "sch_report"
      ? {
          type: "object",
          required: ["nested"],
          properties: {
            nested: {
              required: ["id", "secret"],
              properties: {
                secret: { type: "string", writeOnly: true },
                id: { type: "string" }
              }
            }
          }
        }
      : undefined;

  it("accepts a response that omits nested writeOnly fields", () => {
    const result = validateResponse(
      [response],
      selected(response, { nested: { id: "thing_1" } }),
      reportLookup
    );
    expect(result.violations).toEqual([]);
  });

  it("still requires a nested property that is not writeOnly", () => {
    const result = validateResponse(
      [response],
      selected(response, { nested: {} }),
      reportLookup
    );
    expect(result.violations.map((entry) => entry.code)).toEqual(["required"]);
  });
});

describe("writeOnly fields behind references on the response side (V2B)", () => {
  const refLookup = createContractSchemaLookup({
    sch_item: schemaIr("sch_item", {
      type: "object",
      required: ["label", "secret"],
      properties: {
        label: { type: "string" },
        secret: { type: "string", writeOnly: true }
      }
    }),
    sch_report: schemaIr("sch_report", {
      type: "object",
      required: ["item"],
      properties: { item: { $ref: "sch_item" } }
    })
  });
  const response = jsonResponse("sch_report");

  it("accepts a generated response that omits writeOnly behind a ref", () => {
    const result = validateResponse(
      [response],
      selected(response, { item: { label: "l" } }),
      refLookup
    );
    expect(result.violations).toEqual([]);
  });

  it("still requires the unflagged fields behind a ref", () => {
    const result = validateResponse(
      [response],
      selected(response, { item: {} }),
      refLookup
    );
    // A reference keeps its own pointer while the validator descends
    // into the stripped target, so the violation names the ref site.
    expect(result.violations.map((entry) => entry.pointer)).toEqual(["/item"]);
  });
});

describe("fixture bodies under the declared schema (V2D)", () => {
  const listLookup = createContractSchemaLookup({
    sch_thing: schemaIr("sch_thing", {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } }
    }),
    sch_thing_list: schemaIr("sch_thing_list", {
      type: "array",
      items: { $ref: "sch_thing" }
    })
  });
  const listResponse = jsonResponse("sch_thing_list");

  const fixtureSelected = (body: Json): SelectedResponse => ({
    status: 200,
    response: listResponse,
    mediaType: "application/json",
    headers: {},
    body,
    provenance: "fixture:fx_list",
    approximation: null
  });

  it("accepts a fixture body that satisfies the declared schema", () => {
    const result = validateResponse(
      [listResponse],
      fixtureSelected([{ id: "thing_1" }]),
      listLookup
    );
    expect(result.violations).toEqual([]);
  });

  it("rejects a fixture body that violates the declared schema", () => {
    const result = validateResponse(
      [listResponse],
      fixtureSelected({ id: "thing_1" }),
      listLookup
    );
    expect(result.violations).toEqual([
      {
        location: "body",
        pointer: "",
        code: "type",
        message: 'Fixture fx_list body: Expected type "array".'
      }
    ]);
  });
});
