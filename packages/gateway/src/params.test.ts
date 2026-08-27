import { describe, expect, it } from "vitest";
import type { Json } from "@oal/core";

import type { ParameterIR } from "@oal/contract-ir";
import {
  defaultExplodeFor,
  defaultStyleFor,
  deserializeParameter,
  parseScalar
} from "./params.ts";
import { FRAMEWORK_ERRORS, problemDocument } from "./problem.ts";
import { matchRoute } from "./router.ts";
import {
  stripProperties,
  validateBody,
  validateParameters
} from "./validate.ts";
import type { OperationIR } from "@oal/contract-ir";

function parameter(init: Partial<ParameterIR>): ParameterIR {
  return {
    name: init.name ?? "id",
    location: init.location ?? "path",
    style: init.style ?? defaultStyleFor(init.location ?? "path"),
    explode: init.explode ?? defaultExplodeFor(init.location ?? "path"),
    allow_reserved: false,
    required: init.required ?? true,
    deprecated: false,
    description: null,
    schema_ref: init.schema_ref ?? null,
    content: null,
    examples: [],
    default_value: undefined,
    support: "supported",
    support_reason_codes: [],
    source_pointer: ""
  };
}

function parseOk(
  parameter: ParameterIR,
  wire: string | string[],
  typeHint?: "object" | "array" | null
): Json {
  const outcome = deserializeParameter(parameter, wire, typeHint);
  if (!outcome.ok) {
    throw new Error(`parse failed: ${outcome.message}`);
  }
  return outcome.value;
}

describe("style defaults", () => {
  it("uses the OpenAPI defaults per location", () => {
    expect(defaultStyleFor("path")).toBe("simple");
    expect(defaultStyleFor("query")).toBe("form");
    expect(defaultStyleFor("header")).toBe("simple");
    expect(defaultStyleFor("cookie")).toBe("form");
    expect(defaultExplodeFor("query")).toBe(true);
    expect(defaultExplodeFor("path")).toBe(false);
  });
});

describe("path parameter deserialization", () => {
  it("parses simple primitives, arrays, and exploded objects", () => {
    expect(parseOk(parameter({}), "5")).toBe(5);
    expect(parseOk(parameter({}), "3,4,5")).toEqual([3, 4, 5]);
    expect(parseOk(parameter({ explode: true }), "id=3,name=alex")).toEqual({
      id: 3,
      name: "alex"
    });
    expect(parseOk(parameter({}), "id,3,name,alex", "object")).toEqual({
      id: 3,
      name: "alex"
    });
    expect(parseOk(parameter({}), "id,3,name,alex", "array")).toEqual([
      "id",
      3,
      "name",
      "alex"
    ]);
  });

  it("parses label style", () => {
    expect(parseOk(parameter({ style: "label" }), ".5")).toBe(5);
    expect(parseOk(parameter({ style: "label" }), ".3.4.5")).toEqual([3, 4, 5]);
    expect(
      parseOk(parameter({ style: "label", explode: true }), ".id=3.name=x")
    ).toEqual({ id: 3, name: "x" });
  });

  it("parses matrix style", () => {
    expect(parseOk(parameter({ style: "matrix" }), ";id=5")).toBe(5);
    expect(parseOk(parameter({ style: "matrix" }), ";id=3,4")).toEqual([3, 4]);
    expect(
      parseOk(parameter({ style: "matrix", explode: true }), ";id=3;id=4")
    ).toEqual([3, 4]);
    expect(
      parseOk(
        parameter({ style: "matrix", explode: true }),
        ";role=admin;name=x"
      )
    ).toEqual({ role: "admin", name: "x" });
  });

  it("rejects malformed label and matrix segments", () => {
    expect(deserializeParameter(parameter({ style: "label" }), "5").ok).toBe(
      false
    );
    expect(
      deserializeParameter(parameter({ style: "matrix" }), ";other=1").ok
    ).toBe(false);
  });
});

describe("query parameter deserialization", () => {
  it("parses form arrays and objects", () => {
    expect(parseOk(parameter({ location: "query" }), ["3", "4"])).toEqual([
      3, 4
    ]);
    expect(
      parseOk(parameter({ location: "query", explode: false }), "id=3,name=x")
    ).toEqual({ id: 3, name: "x" });
    expect(
      parseOk(parameter({ location: "query", explode: false }), "3,4", "array")
    ).toEqual([3, 4]);
    expect(parseOk(parameter({ location: "query" }), "hello")).toBe("hello");
  });

  it("parses delimited and deep-object styles", () => {
    expect(
      parseOk(parameter({ location: "query", style: "spaceDelimited" }), [
        "a b"
      ])
    ).toEqual(["a", "b"]);
    expect(
      parseOk(parameter({ location: "query", style: "pipeDelimited" }), ["a|b"])
    ).toEqual(["a", "b"]);
    expect(
      parseOk(
        parameter({ location: "query", style: "deepObject", name: "obj" }),
        ["obj[id]=3", "obj[name]=x"]
      )
    ).toEqual({ id: 3, name: "x" });
  });

  it("parses cookie form values", () => {
    expect(parseOk(parameter({ location: "cookie" }), "session1")).toBe(
      "session1"
    );
    expect(
      parseOk(parameter({ location: "cookie", explode: false }), "id=3,name=x")
    ).toEqual({ id: 3, name: "x" });
  });

  it("keeps non-numeric strings intact", () => {
    expect(parseScalar("007")).toBe("007");
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("1.5e3")).toBe(1500);
  });
});

describe("framework errors", () => {
  it("maps every condition to its table status and code", () => {
    expect(FRAMEWORK_ERRORS.requestMalformed.status).toBe(400);
    expect(FRAMEWORK_ERRORS.authenticationFailed.status).toBe(401);
    expect(FRAMEWORK_ERRORS.authorizationFailed.status).toBe(403);
    expect(FRAMEWORK_ERRORS.routeNotFound.status).toBe(404);
    expect(FRAMEWORK_ERRORS.methodNotAllowed.status).toBe(405);
    expect(FRAMEWORK_ERRORS.requestBodyTooLarge.status).toBe(413);
    expect(FRAMEWORK_ERRORS.requestTargetTooLarge.status).toBe(414);
    expect(FRAMEWORK_ERRORS.mediaTypeUnsupported.status).toBe(415);
    expect(FRAMEWORK_ERRORS.requestSchemaInvalid.status).toBe(422);
    expect(FRAMEWORK_ERRORS.requestQuotaExceeded.status).toBe(429);
    expect(FRAMEWORK_ERRORS.mockBehaviorUnavailable.status).toBe(501);
    expect(FRAMEWORK_ERRORS.behaviorTimeout.status).toBe(504);
    expect(FRAMEWORK_ERRORS.mockResponseInvalid.status).toBe(500);
    expect(FRAMEWORK_ERRORS.internalError.status).toBe(500);
  });

  it("renders problem documents with the two extensions", () => {
    const document = problemDocument(
      FRAMEWORK_ERRORS.routeNotFound,
      "req_00000001",
      "No route."
    );
    expect(document.code).toBe("route_not_found");
    expect(document.request_id).toBe("req_00000001");
    expect(document.status).toBe(404);
    expect(document.type).toBe("https://agentlab.dev/problems/route_not_found");
  });
});

function operation(init: Partial<OperationIR>): OperationIR {
  return {
    key: init.key ?? "path:GET /things/{id}",
    uid: "op_x",
    surface: "path",
    method: init.method ?? "GET",
    path_template: init.path_template ?? "/things/{id}",
    route_segments: init.route_segments ?? [
      { kind: "literal", value: "things" },
      { kind: "parameter", value: "id" }
    ],
    operation_id: null,
    tool_name: "get_thing",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: init.parameters ?? [],
    request_body: init.request_body ?? null,
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

describe("route matching", () => {
  const operations = [
    operation({ method: "GET" }),
    operation({
      method: "DELETE",
      key: "path:DELETE /things/{id}"
    }),
    operation({
      key: "path:GET /things/all",
      path_template: "/things/all",
      route_segments: [
        { kind: "literal", value: "things" },
        { kind: "literal", value: "all" }
      ],
      method: "GET"
    })
  ];

  it("matches literal and parameter segments", () => {
    const result = matchRoute(operations, "GET", "/things/42");
    expect(result.match?.pathParameters).toEqual({ id: "42" });
    expect(result.match?.operation.key).toBe("path:GET /things/{id}");
  });

  it("prefers literal segments over parameters", () => {
    const result = matchRoute(operations, "GET", "/things/all");
    expect(result.match?.operation.key).toBe("path:GET /things/all");
  });

  it("reports 405 shapes and 404 shapes", () => {
    const wrongMethod = matchRoute(operations, "POST", "/things/42");
    expect(wrongMethod.match).toBeNull();
    expect(wrongMethod.pathExists).toBe(true);
    expect(wrongMethod.allowedMethods).toContain("GET");
    expect(matchRoute(operations, "GET", "/nope").pathExists).toBe(false);
  });

  it("does not normalize dot segments and decodes percent once", () => {
    expect(matchRoute(operations, "GET", "/things/../other").match).toBeNull();
    const decoded = matchRoute(operations, "GET", "/things/a%20b");
    expect(decoded.match?.pathParameters).toEqual({ id: "a b" });
  });
});

describe("request validation", () => {
  const schemas: Record<string, Json> = {
    sch_id: { type: "integer", minimum: 1 },
    sch_body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        owner: { type: "string", readOnly: true }
      },
      additionalProperties: false
    }
  };
  const lookup = (ref: string): Json | undefined => schemas[ref];

  it("reports missing required parameters and schema violations", () => {
    const op = operation({
      parameters: [parameter({ name: "id", schema_ref: "sch_id" })]
    });
    const result = validateParameters(
      op,
      {
        pathParameters: {},
        query: {},
        headers: {},
        cookies: {},
        body: undefined,
        contentType: null
      },
      lookup
    );
    expect(result.violations.map((v) => v.code)).toContain("required");

    const invalid = validateParameters(
      op,
      {
        pathParameters: { id: "0" },
        query: {},
        headers: {},
        cookies: {},
        body: undefined,
        contentType: null
      },
      lookup
    );
    expect(invalid.violations[0]?.code).toBe("minimum");

    const valid = validateParameters(
      op,
      {
        pathParameters: { id: "7" },
        query: {},
        headers: {},
        cookies: {},
        body: undefined,
        contentType: null
      },
      lookup
    );
    expect(valid.violations).toHaveLength(0);
    expect(valid.parameters["id"]).toBe(7);
  });

  it("validates bodies with request-side readOnly handling", () => {
    const op = operation({
      request_body: {
        required: true,
        description: null,
        content: [
          {
            media_type: "application/json",
            schema_ref: "sch_body",
            examples: [],
            support: "supported",
            support_reason_codes: []
          }
        ],
        source_pointer: ""
      }
    });
    const good = validateBody(
      op,
      {
        pathParameters: {},
        query: {},
        headers: {},
        cookies: {},
        body: { name: "x" },
        contentType: "application/json"
      },
      lookup
    );
    expect(good.violations).toHaveLength(0);

    const withOwner = validateBody(
      op,
      {
        pathParameters: {},
        query: {},
        headers: {},
        cookies: {},
        body: { name: "x", owner: "me" },
        contentType: "application/json; charset=utf-8"
      },
      lookup
    );
    expect(withOwner.violations.map((v) => v.code)).toContain(
      "additionalProperties"
    );

    const missing = validateBody(
      op,
      {
        pathParameters: {},
        query: {},
        headers: {},
        cookies: {},
        body: {},
        contentType: "application/json"
      },
      lookup
    );
    expect(missing.violations.map((v) => v.code)).toContain("required");

    const wrongType = validateBody(
      op,
      {
        pathParameters: {},
        query: {},
        headers: {},
        cookies: {},
        body: { name: "x" },
        contentType: "text/plain"
      },
      lookup
    );
    expect(wrongType.violations[0]?.code).toBe("media_type_unsupported");
  });

  it("strips flagged properties without mutating the input schema", () => {
    const schema: Json = {
      type: "object",
      required: ["name", "owner"],
      properties: {
        name: { type: "string" },
        owner: { type: "string", readOnly: true }
      }
    };
    const stripped = stripProperties(schema, "readOnly");
    expect(stripped).not.toBe(schema);
    expect(stripped).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    });
    expect(schema.required).toEqual(["name", "owner"]);
  });
});
