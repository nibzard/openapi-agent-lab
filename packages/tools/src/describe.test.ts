import { describe, expect, it } from "vitest";

import { canonicalJson, OalError, schemaUid, type JsonObject } from "@oal/core";
import type { ContractIR } from "@oal/contract-ir";

import { computerContract } from "./contract.fixture.ts";
import {
  DESCRIBE_DETAIL_LEVELS,
  describeOperation,
  isDescribeDetail,
  resolveOperation
} from "./describe.ts";

const CONTRACT = computerContract();

const COMPUTER_CREATE: JsonObject = {
  type: "object",
  required: ["label"],
  properties: {
    label: { type: "string" },
    rack_id: { type: "integer", nullable: true }
  }
};
const COMPUTER_CREATE_REF = schemaUid(canonicalJson(COMPUTER_CREATE));
const STRING_REF = schemaUid(canonicalJson({ type: "string" }));

/** A second contract with a duplicated operationId. */
function ambiguousContract(): ContractIR {
  const base = computerContract();
  const first = base.operations[0];
  const second = base.operations[1];
  if (first === undefined || second === undefined) {
    throw new Error("The fixture is missing operations.");
  }
  return {
    ...base,
    operations: [
      { ...first, key: "path:GET /one", operation_id: "same", uid: "op_one" },
      { ...second, key: "path:GET /two", operation_id: "same", uid: "op_two" }
    ]
  };
}

describe("resolveOperation", () => {
  it("resolves a canonical key, a UID, and a unique operationId", () => {
    const create = CONTRACT.operations[0];
    if (create === undefined) {
      throw new Error("The fixture is missing an operation.");
    }
    expect(resolveOperation(CONTRACT, "path:POST /v1/computers").key).toBe(
      create.key
    );
    expect(resolveOperation(CONTRACT, create.uid).key).toBe(create.key);
    expect(resolveOperation(CONTRACT, "createComputer").key).toBe(create.key);
  });

  it("rejects an unknown reference", () => {
    expect(() => resolveOperation(CONTRACT, "path:POST /nope")).toThrowError(
      /No operation matches/
    );
  });

  it("rejects a duplicated operationId", () => {
    const attempt = (): unknown =>
      resolveOperation(ambiguousContract(), "same");
    expect(attempt).toThrowError(/not unique/);
    try {
      attempt();
    } catch (error) {
      if (!(error instanceof OalError)) {
        throw new Error("Expected an OalError.");
      }
      expect(error.code).toBe("operation_ambiguous");
      expect(error.details).toEqual({
        operationId: "same",
        keys: ["path:GET /one", "path:GET /two"]
      });
    }
  });
});

describe("isDescribeDetail", () => {
  it("accepts the four declared levels only", () => {
    expect(DESCRIBE_DETAIL_LEVELS).toEqual([
      "summary",
      "schemas",
      "examples",
      "full"
    ]);
    expect(isDescribeDetail("full")).toBe(true);
    expect(isDescribeDetail("everything")).toBe(false);
    expect(isDescribeDetail(3)).toBe(false);
  });
});

describe("describeOperation", () => {
  it("returns the summary level by default", () => {
    const described = describeOperation(CONTRACT, {
      operation: "path:POST /v1/computers"
    });
    expect(described.detail).toBe("summary");
    expect(described.key).toBe("path:POST /v1/computers");
    expect(described.operationId).toBe("createComputer");
    expect(described.toolName).toBe("createComputer");
    expect(described.method).toBe("POST");
    expect(described.pathTemplate).toBe("/v1/computers");
    expect(described.summary).toBe("Create a computer");
    expect(described.description).toBe(
      "Create a computer Create a new computer record."
    );
    expect(described.descriptionTruncated).toBe(false);
    expect(described.tags).toEqual(["Computers"]);
    expect(described.deprecated).toBe(false);
    expect(described.support).toBe("supported");
    expect(described.parameters).toEqual({
      path: [],
      query: [],
      header: [],
      cookie: []
    });
    expect(described.requestBody?.required).toBe(true);
    expect(described.requestBody?.mediaTypes).toEqual([
      {
        mediaType: "application/json",
        schemaRef: COMPUTER_CREATE_REF,
        support: "supported",
        reasonCodes: []
      }
    ]);
    expect(described.responses).toHaveLength(1);
    expect(described.responses[0]?.selector).toBe("201");
    expect(described.responses[0]?.status).toBe(201);
    expect(described.security).toEqual({
      anonymous: false,
      alternatives: [
        {
          schemes: [
            {
              name: "ApiKeyAuth",
              type: "apiKey",
              location: "header",
              wireName: "X-API-Key",
              scopes: [],
              support: "supported"
            }
          ]
        }
      ]
    });
    expect(described.limitations).toEqual([]);
    expect("examples" in described).toBe(false);
  });

  it("groups parameters by location", () => {
    const described = describeOperation(CONTRACT, {
      operation: "path:GET /v1/computers"
    });
    expect(described.parameters.query.map((entry) => entry.name)).toEqual([
      "limit",
      "page"
    ]);
    expect(described.parameters.path).toEqual([]);
    expect(described.parameters.query[0]).toEqual({
      name: "limit",
      location: "query",
      required: false,
      deprecated: false,
      style: "form",
      explode: true,
      description: null,
      schemaRef: STRING_REF,
      mediaType: null,
      support: "supported",
      reasonCodes: []
    });
    expect(described.requestBody).toBe(null);

    const read = describeOperation(CONTRACT, {
      operation: "path:GET /v1/computers/{computer_id}"
    });
    expect(read.parameters.path.map((entry) => entry.name)).toEqual([
      "computer_id"
    ]);
    expect(read.parameters.path[0]?.required).toBe(true);
  });

  it("adds inline schemas from the schemas level", () => {
    const summary = describeOperation(CONTRACT, {
      operation: "createComputer",
      detail: "summary"
    });
    const request = summary.requestBody?.mediaTypes[0];
    expect(request?.schemaRef).toMatch(/^sch_[0-9a-f]{12}$/);
    expect(request?.schema).toBeUndefined();

    const withSchemas = describeOperation(CONTRACT, {
      operation: "createComputer",
      detail: "schemas"
    });
    const schema = withSchemas.requestBody?.mediaTypes[0]?.schema;
    expect(schema).toEqual({
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string" },
        rack_id: { type: "integer", nullable: true }
      }
    });
    expect(withSchemas.responses[0]?.mediaTypes[0]?.schema).toEqual({
      $ref: "#/components/schemas/Computer"
    });
    expect("examples" in withSchemas).toBe(false);
  });

  it("adds examples from the examples level", () => {
    const described = describeOperation(CONTRACT, {
      operation: "path:POST /v1/computers",
      detail: "examples"
    });
    expect(described.examples).toEqual([
      {
        source: "request:application/json",
        name: "minimal",
        summary: "One labelled computer",
        value: { label: "rack-1-node-4" }
      }
    ]);
    expect(described.requestBody?.mediaTypes[0]?.schema).toBeUndefined();
  });

  it("returns everything at the full level", () => {
    const described = describeOperation(CONTRACT, {
      operation: "path:POST /v1/computers",
      detail: "full"
    });
    expect(described.requestBody?.mediaTypes[0]?.schema).toBeDefined();
    expect(described.examples).toHaveLength(1);
  });

  it("reports deprecation and capability limitations", () => {
    const removed = describeOperation(CONTRACT, {
      operation: "path:DELETE /v1/computers/{computer_id}"
    });
    expect(removed.deprecated).toBe(true);

    const health = describeOperation(CONTRACT, {
      operation: "path:GET /health"
    });
    expect(health.support).toBe("unsupported");
    expect(health.security).toEqual({ anonymous: true, alternatives: [] });
    expect(health.limitations).toEqual([
      "Parameter 'trace' (query) is unsupported: parameter:style-deep-object.",
      "Operation diagnostic: OAL-CAP-PARAMETER-UNSUPPORTED.",
      "The operation is unsupported by the capability report."
    ]);
  });

  it("bounds and normalizes the source description", () => {
    const contract = computerContract();
    const first = contract.operations[0];
    if (first === undefined) {
      throw new Error("The fixture is missing an operation.");
    }
    first.description = "  Spaces\tand\nnewlines   collapsed.  ";
    const described = describeOperation(contract, {
      operation: "path:POST /v1/computers"
    });
    expect(described.description).toBe(
      "Create a computer Spaces and newlines collapsed."
    );
  });
});
