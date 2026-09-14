import { describe, expect, it } from "vitest";

import type {
  ContractIR,
  OperationIR,
  ParameterIR,
  SchemaIR
} from "@oal/contract-ir";
import {
  compilePathParameterPatterns,
  pathFamilyKey
} from "./path-patterns.ts";

function schema(uid: string, body: unknown): SchemaIR {
  return {
    uid,
    schema: body as SchemaIR["schema"],
    source_pointer: "",
    document_uri: ""
  };
}

function pathOperation(
  template: string,
  parameters: ParameterIR[],
  method = "GET"
): OperationIR {
  return {
    key: `path:${method} ${template}`,
    uid: `op_${method}_${template}`,
    surface: "path",
    method,
    path_template: template,
    route_segments:
      template === "/"
        ? []
        : template
            .slice(1)
            .split("/")
            .map((segment) =>
              segment.startsWith("{")
                ? { kind: "parameter", value: segment.slice(1, -1) }
                : { kind: "literal", value: segment }
            ),
    operation_id: null,
    tool_name: "",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters,
    request_body: null,
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

function pathId(schemaRef: string | null): ParameterIR {
  return {
    name: "id",
    location: "path",
    style: "simple",
    explode: false,
    allow_reserved: false,
    required: true,
    deprecated: false,
    description: null,
    schema_ref: schemaRef,
    content: null,
    examples: [],
    default_value: undefined,
    support: "supported",
    support_reason_codes: [],
    source_pointer: ""
  };
}

function contract(
  operations: OperationIR[],
  schemas: Record<string, SchemaIR>
): ContractIR {
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
    schemas,
    operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

describe("path family keys", () => {
  it("groups a collection with its item template", () => {
    expect(pathFamilyKey(pathOperation("/computers", []))).toBe("computers");
    expect(
      pathFamilyKey(pathOperation("/computers/{id}", [pathId("sch_id")]))
    ).toBe("computers");
    expect(
      pathFamilyKey(pathOperation("/v1/computers/{id}", [pathId("sch_id")]))
    ).toBe("v1/computers");
  });

  it("keeps a sub-resource in its own family", () => {
    expect(
      pathFamilyKey(
        pathOperation("/computers/{id}/executions", [pathId("sch_id")])
      )
    ).toBe("computers/executions");
  });
});

describe("path parameter pattern collection", () => {
  const schemas = (): Record<string, SchemaIR> => ({
    sch_long: schema("sch_long", {
      type: "string",
      pattern: "^cmp_[a-z0-9]{29}$"
    }),
    sch_short: schema("sch_short", { type: "string", pattern: "^c_[0-9]{2}$" }),
    sch_plain: schema("sch_plain", { type: "string" }),
    sch_empty: schema("sch_empty", { type: "string", pattern: "" })
  });

  it("collects the declared pattern of a path parameter", () => {
    const table = compilePathParameterPatterns(
      contract(
        [pathOperation("/computers/{id}", [pathId("sch_long")])],
        schemas()
      )
    );
    expect(table.get("computers")).toEqual({ id: "^cmp_[a-z0-9]{29}$" });
  });

  it("applies the longest pattern when operations disagree", () => {
    const table = compilePathParameterPatterns(
      contract(
        [
          pathOperation("/computers/{id}", [pathId("sch_long")]),
          pathOperation("/computers/{id}", [pathId("sch_short")], "DELETE")
        ],
        schemas()
      )
    );
    expect(table.get("computers")).toEqual({ id: "^cmp_[a-z0-9]{29}$" });
  });

  it("breaks equal-length ties lexicographically", () => {
    const equalSchemas = (): Record<string, SchemaIR> => ({
      sch_a: schema("sch_a", { type: "string", pattern: "^a-$" }),
      sch_b: schema("sch_b", { type: "string", pattern: "^b-$" })
    });
    const table = compilePathParameterPatterns(
      contract(
        [
          pathOperation("/things/{id}", [pathId("sch_b")]),
          pathOperation("/things/{id}", [pathId("sch_a")], "DELETE")
        ],
        equalSchemas()
      )
    );
    expect(table.get("things")).toEqual({ id: "^a-$" });
  });

  it("skips unpatterned parameters and empty patterns", () => {
    const table = compilePathParameterPatterns(
      contract(
        [
          pathOperation("/things/{id}", [pathId("sch_plain")]),
          pathOperation("/plain/{id}", [pathId("sch_empty")])
        ],
        schemas()
      )
    );
    expect(table.size).toBe(0);
  });

  it("reads a content media-type schema when no schema is declared", () => {
    const withContent = pathId(null);
    withContent.content = {
      media_type: "application/json",
      schema_ref: "sch_long",
      examples: []
    };
    const table = compilePathParameterPatterns(
      contract([pathOperation("/computers/{id}", [withContent])], schemas())
    );
    expect(table.get("computers")).toEqual({ id: "^cmp_[a-z0-9]{29}$" });
  });

  it("ignores query and header parameters of the same name", () => {
    const query = pathId("sch_long");
    query.location = "query";
    const table = compilePathParameterPatterns(
      contract([pathOperation("/things", [query])], schemas())
    );
    expect(table.size).toBe(0);
  });

  it("keeps neighboring resource families separate", () => {
    const table = compilePathParameterPatterns(
      contract(
        [
          pathOperation("/computers/{id}", [pathId("sch_long")]),
          pathOperation("/printers/{id}", [pathId("sch_short")])
        ],
        schemas()
      )
    );
    expect(table.get("computers")).toEqual({ id: "^cmp_[a-z0-9]{29}$" });
    expect(table.get("printers")).toEqual({ id: "^c_[0-9]{2}$" });
  });

  it("is deterministic under operation order", () => {
    const operations = [
      pathOperation("/computers/{id}", [pathId("sch_long")]),
      pathOperation("/computers/{id}", [pathId("sch_short")], "DELETE")
    ];
    const forward = compilePathParameterPatterns(
      contract([...operations], schemas())
    );
    const reversed = compilePathParameterPatterns(
      contract(
        [operations[1] as OperationIR, operations[0] as OperationIR],
        schemas()
      )
    );
    expect(reversed).toEqual(forward);
  });
});
