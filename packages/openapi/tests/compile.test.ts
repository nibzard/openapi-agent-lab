import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";

import { CAP_LINK_DESCRIBED, compileOpenApi } from "../src/index.ts";

const fixtures = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);

function load(paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    out[path] = readFileSync(`${fixtures}${path}`, "utf8");
  }
  return out;
}

function compile(
  documents: Record<string, string>,
  entrypoint: string,
  limits = {}
) {
  return compileOpenApi({ documents, entrypoint }, { limits });
}

function failureOf(
  documents: Record<string, string>,
  entrypoint: string,
  limits = {}
): OalError {
  try {
    compile(documents, entrypoint, limits);
  } catch (error) {
    if (error instanceof OalError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected compilation to fail");
}

const petstore = load([
  "openapi/petstore-expanded.yaml",
  "openapi/minimal.json",
  "openapi/nullable-3.0.yaml",
  "openapi/nullable-3.1.json",
  "openapi/webhooks.json",
  "openapi/refs/entry.yaml",
  "openapi/refs/shared.yaml"
]);

describe("compiling a rich contract", () => {
  it("produces deterministic operations in canonical order", () => {
    const first = compile(petstore, "openapi/petstore-expanded.yaml");
    const second = compile(petstore, "openapi/petstore-expanded.yaml");
    expect(JSON.stringify(second.contract)).toBe(
      JSON.stringify(first.contract)
    );
    expect(first.contract.operations.map((operation) => operation.key)).toEqual(
      [
        "path:DELETE /pets/{id}",
        "path:GET /pets",
        "path:GET /pets/label/{id}",
        "path:GET /pets/matrix/{id}",
        "path:GET /pets/{id}",
        "path:GET /store/inventory",
        "path:POST /pets"
      ]
    );
  });

  it("records source identity and semantic digests", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    expect(contract.source.openapi_version).toBe("3.0.3");
    expect(contract.source.media_type).toBe("application/yaml");
    expect(contract.source.sha256).toHaveLength(64);
    expect(contract.source.semantic_sha256).not.toBe("");
    expect(contract.source.execution_sha256).not.toBe("");
    expect(contract.compiler).toEqual({
      name: "@oal/openapi",
      version: "0.1.0"
    });
    expect(contract.api.servers[0]?.variables.region?.default).toBe("us-east");
  });

  it("normalizes parameter styles and defaults per location", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const list = contract.operations.find(
      (operation) => operation.key === "path:GET /pets"
    );
    expect(list).toBeDefined();
    const parameters = list?.parameters ?? [];
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter])
    );
    expect(byName.get("limit")).toMatchObject({
      location: "query",
      style: "form",
      explode: true,
      required: false
    });
    expect(byName.get("ids")).toMatchObject({
      style: "pipeDelimited",
      explode: true
    });
    expect(byName.get("x-request-token")).toMatchObject({
      location: "header",
      style: "simple",
      explode: false
    });
    expect(byName.get("session")).toMatchObject({
      location: "cookie",
      style: "form",
      explode: true
    });
    expect(byName.get("limit")?.default_value).toBe(20);
  });

  it("marks unsupported parameter shapes with stable reason codes", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const list = contract.operations.find(
      (operation) => operation.key === "path:GET /pets"
    );
    const metadata = list?.parameters.find(
      (parameter) => parameter.name === "metadata"
    );
    expect(metadata?.support).toBe("supported");
    expect(metadata?.support_reason_codes).toEqual([]);
    expect(list?.support.level).toBe("approximated");
  });

  it("registers media support and retains examples", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const create = contract.operations.find(
      (operation) => operation.key === "path:POST /pets"
    );
    const content = create?.request_body?.content ?? [];
    expect(content.map((entry) => entry.media_type)).toEqual([
      "application/json",
      "application/xml"
    ]);
    expect(content[1]?.support).toBe("approximated");
    expect(content[1]?.support_reason_codes).toEqual(["media:application/xml"]);
    const json = content[0];
    expect(json?.examples.map((example) => example.name)).toEqual(["dog"]);
    expect(json?.examples[0]?.value).toEqual({ name: "Rex", tag: "friendly" });
  });

  it("compiles security schemes with support levels", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    expect(contract.security_schemes.petstore_auth?.support).toBe(
      "approximated"
    );
    expect(
      contract.security_schemes.petstore_auth?.support_reason_codes
    ).toEqual(["security:oauth2"]);
    expect(contract.security_schemes.basic_auth?.support).toBe("supported");
    expect(contract.security_schemes.api_key?.wire_name).toBe("api_key");
    const create = contract.operations.find(
      (operation) => operation.key === "path:POST /pets"
    );
    expect(create?.security?.alternatives).toEqual([
      { schemes: [{ name: "petstore_auth", scopes: ["write:pets"] }] },
      { schemes: [{ name: "basic_auth", scopes: [] }] }
    ]);
  });

  it("preserves callbacks as data and marks them approximated", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const create = contract.operations.find(
      (operation) => operation.key === "path:POST /pets"
    );
    expect(create?.callbacks[0]?.name).toBe("onPetCreated");
    expect(create?.callbacks[0]?.expressions[0]?.method).toBe("POST");
    expect(
      create?.support.diagnostic_codes.includes("OAL-CAP-CALLBACK-UNSUPPORTED")
    ).toBe(true);
  });

  it("preserves response links as described-only data with an outcome", () => {
    const documents = {
      "links.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Links", version: "1.0.0" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" }
                    }
                  },
                  links: {
                    addressed: {
                      operationId: "showPetById",
                      description: "Address one pet of the page.",
                      parameters: { petId: "$response.body#/items/0/id" },
                      requestBody: "Pet fields"
                    },
                    packed: { $ref: "#/components/links/packed" }
                  }
                }
              }
            }
          },
          "/pets/{petId}": {
            get: {
              operationId: "showPetById",
              parameters: [
                {
                  name: "petId",
                  in: "path",
                  required: true,
                  schema: { type: "string" }
                }
              ],
              responses: { "200": { description: "ok" } }
            }
          }
        },
        components: {
          schemas: {
            Pet: { type: "object", properties: { id: { type: "string" } } }
          },
          links: {
            packed: {
              operationRef: "#/paths/~1pets~1{petId}/get",
              description: "Follow one pet by reference."
            }
          }
        }
      })
    };
    const { contract, report } = compile(documents, "links.json");
    const list = contract.operations.find(
      (operation) => operation.key === "path:GET /pets"
    );
    expect(list?.support.level).toBe("approximated");
    expect(list?.support.diagnostic_codes).toContain(CAP_LINK_DESCRIBED);

    const described = contract.diagnostics.filter(
      (entry) => entry.code === CAP_LINK_DESCRIBED
    );
    expect(described.map((entry) => entry.json_pointer)).toEqual([
      "#/components/links/packed",
      "#/paths/~1pets/get/responses/200/links/addressed"
    ]);
    const addressed = described.find((entry) =>
      entry.json_pointer?.endsWith("/links/addressed")
    );
    expect(addressed?.operation_key).toBe("path:GET /pets");
    const preserved = addressed?.details as {
      link?: {
        name?: string;
        operation_id?: string | null;
        parameters?: Record<string, unknown>;
        request_body?: unknown;
      };
    };
    expect(preserved.link).toMatchObject({
      name: "addressed",
      operation_id: "showPetById",
      parameters: { petId: "$response.body#/items/0/id" },
      request_body: "Pet fields"
    });

    const feature = report.features.find(
      (entry) => entry.kind === "link" && entry.name === "addressed"
    );
    expect(feature).toMatchObject({
      level: "approximated",
      reason_codes: ["link:addressed"],
      operation_keys: ["path:GET /pets"]
    });
    expect(
      report.recommendations.scenario_requirements.some((requirement) =>
        requirement.includes("'addressed' link")
      )
    ).toBe(true);

    const show = contract.operations.find(
      (operation) => operation.key === "path:GET /pets/{petId}"
    );
    expect(show?.support.level).toBe("supported");
    expect(show?.support.diagnostic_codes).toEqual([]);
  });

  it("derives tool names and breaks collisions", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const names = contract.operations.map((operation) => operation.tool_name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("listPets");
    expect(names).toContain("createPet");
    expect(names).toContain("showPetById");
    expect(names).toContain("delete_pets_by_id");
  });

  it("keeps route segments and detects path parameter problems", () => {
    const { contract } = compile(petstore, "openapi/petstore-expanded.yaml");
    const show = contract.operations.find(
      (operation) => operation.key === "path:GET /pets/{id}"
    );
    expect(show?.route_segments).toEqual([
      { kind: "literal", value: "pets" },
      { kind: "parameter", value: "id" }
    ]);
  });
});

describe("dialect normalization", () => {
  it("treats 3.0 nullable and 3.1 type arrays as equivalent", () => {
    const left = compile(petstore, "openapi/nullable-3.0.yaml");
    const right = compile(petstore, "openapi/nullable-3.1.json");
    const normalize = (schemas: typeof left.contract.schemas): unknown => {
      const byPointer = new Map(
        Object.values(schemas).map((schema) => [
          schema.source_pointer,
          schema.schema
        ])
      );
      return [...byPointer.entries()].sort();
    };
    expect(normalize(left.contract.schemas)).toEqual(
      normalize(right.contract.schemas)
    );
  });

  it("normalizes 3.0 tuple items arrays to prefixItems", () => {
    const tuple = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Tuples", version: "1.0.0" },
      paths: {
        "/pairs": {
          get: {
            operationId: "listPairs",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pair" }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          Pair: {
            type: "array",
            items: [
              { type: "string", minLength: 2 },
              { type: "integer", minimum: 5 }
            ],
            additionalItems: { type: "string", maxLength: 3 }
          }
        }
      }
    });
    const { contract } = compile({ "tuple.json": tuple }, "tuple.json");
    const pair = Object.values(contract.schemas).find(
      (schema) => schema.source_pointer === "#/components/schemas/Pair"
    );
    expect(pair?.schema).toEqual({
      type: "array",
      prefixItems: [
        { type: "string", minLength: 2 },
        { type: "integer", minimum: 5 }
      ],
      items: { type: "string", maxLength: 3 }
    });
  });

  it("normalizes 3.0 additionalItems false and leaves plain items alone", () => {
    const response = (ref: string): unknown => ({
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${ref}` }
          }
        }
      }
    });
    const closed = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Closed tuple", version: "1.0.0" },
      paths: {
        "/cells": {
          get: { operationId: "listCells", responses: response("Cell") }
        },
        "/tags": {
          get: { operationId: "listTags", responses: response("Tags") }
        }
      },
      components: {
        schemas: {
          Cell: {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: false
          },
          Tags: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    });
    const { contract } = compile({ "closed.json": closed }, "closed.json");
    const byPointer = new Map(
      Object.values(contract.schemas).map((schema) => [
        schema.source_pointer,
        schema.schema
      ])
    );
    expect(byPointer.get("#/components/schemas/Cell")).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false
    });
    expect(byPointer.get("#/components/schemas/Tags")).toEqual({
      type: "array",
      items: { type: "string" }
    });
  });

  it("treats 3.0 tuples and 3.1 prefixItems as equivalent", () => {
    const build = (openapi: string, tuple: Record<string, unknown>): string =>
      JSON.stringify({
        openapi,
        info: { title: "Tuple dialects", version: "1.0.0" },
        paths: {
          "/readings": {
            get: {
              operationId: "listReadings",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Reading" }
                    }
                  }
                }
              }
            }
          }
        },
        components: {
          schemas: {
            Reading: { type: "array", ...tuple }
          }
        }
      });
    const left = compile(
      {
        "tuple30.json": build("3.0.3", {
          items: [{ type: "string" }],
          additionalItems: { type: "integer" }
        })
      },
      "tuple30.json"
    );
    const right = compile(
      {
        "tuple31.json": build("3.1.0", {
          prefixItems: [{ type: "string" }],
          items: { type: "integer" }
        })
      },
      "tuple31.json"
    );
    const normalize = (schemas: typeof left.contract.schemas): unknown => {
      const byPointer = new Map(
        Object.values(schemas).map((schema) => [
          schema.source_pointer,
          schema.schema
        ])
      );
      return [...byPointer.entries()].sort();
    };
    expect(normalize(left.contract.schemas)).toEqual(
      normalize(right.contract.schemas)
    );
  });

  it("compiles webhooks as data-only surfaces", () => {
    const { contract, report } = compile(petstore, "openapi/webhooks.json");
    expect(contract.operations).toEqual([]);
    expect(contract.webhooks.map((hook) => hook.name)).toEqual([
      "newPet",
      "petDeleted"
    ]);
    const hook = contract.webhooks[0]?.operations[0];
    expect(hook?.tool_name).toBe("receiveNewPet");
    expect(hook?.support.level).toBe("approximated");
    expect(report.counts.operations.approximated).toBe(2);
  });

  it("resolves references across files inside the pack", () => {
    const { contract } = compile(petstore, "openapi/refs/entry.yaml");
    expect(contract.source.documents.map((document) => document.uri)).toEqual([
      "openapi/refs/entry.yaml",
      "openapi/refs/shared.yaml"
    ]);
    for (const document of contract.source.documents) {
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const widget = contract.operations.find(
      (operation) => operation.key === "path:GET /widgets"
    );
    const schemaUid = widget?.responses[0]?.content[0]?.schema_ref ?? null;
    expect(schemaUid).not.toBeNull();
    const schema = schemaUid === null ? undefined : contract.schemas[schemaUid];
    expect(schema?.document_uri).toBe("openapi/refs/entry.yaml");
    expect(schema?.source_pointer).toBe(
      "#/paths/~1widgets/get/responses/200/content/application~1json/schema"
    );
    const shared = Object.values(contract.schemas).find(
      (entry) =>
        entry.document_uri === "openapi/refs/shared.yaml" &&
        entry.source_pointer === "#/components/schemas/Widget"
    );
    expect(shared).toBeDefined();
    expect(Object.keys(contract.schemas)).toContain(
      Object.values(contract.schemas).find(
        (entry) =>
          entry.source_pointer === "#/components/schemas/WidgetId" &&
          entry.document_uri === "openapi/refs/shared.yaml"
      )?.uid ?? ""
    );
  });
});

describe("ingestion failures", () => {
  it("rejects unsupported OpenAPI versions", () => {
    const error = failureOf(
      {
        "bad.json": readFileSync(
          `${fixtures}adversarial/bad-version.json`,
          "utf8"
        )
      },
      "bad.json"
    );
    expect(error.code).toBe("OAL-OAS-VERSION-UNSUPPORTED");
    expect(error.exitCode).toBe(4);
  });

  it("rejects duplicate mapping keys", () => {
    const error = failureOf(
      {
        "dup.yaml": readFileSync(
          `${fixtures}adversarial/duplicate-keys.yaml`,
          "utf8"
        )
      },
      "dup.yaml"
    );
    expect(error.code).toBe("OAL-DUPLICATE-KEY");
    expect(error.exitCode).toBe(2);
  });

  it("rejects tab indentation", () => {
    const error = failureOf(
      {
        "tab.yaml": readFileSync(
          `${fixtures}adversarial/tab-indent.yaml`,
          "utf8"
        )
      },
      "tab.yaml"
    );
    expect(error.code).toBe("OAL-YAML-INVALID");
  });

  it("fails closed on alias expansion bombs", () => {
    const error = failureOf(
      {
        "bomb.yaml": readFileSync(
          `${fixtures}adversarial/billion-laughs.yaml`,
          "utf8"
        )
      },
      "bomb.yaml"
    );
    expect(["OAL-YAML-NODE-LIMIT", "OAL-YAML-ALIAS-LIMIT"]).toContain(
      error.code
    );
  });

  it("denies remote references by policy", () => {
    const error = failureOf(
      {
        "remote.yaml": readFileSync(
          `${fixtures}adversarial/remote-ref.yaml`,
          "utf8"
        )
      },
      "remote.yaml"
    );
    expect(error.code).toBe("OAL-REF-REMOTE-DISABLED");
    expect(error.exitCode).toBe(4);
  });

  it("rejects ambiguous templated routes", () => {
    const error = failureOf(
      {
        "amb.json": readFileSync(
          `${fixtures}adversarial/ambiguous-routes.json`,
          "utf8"
        )
      },
      "amb.json"
    );
    expect(error.code).toBe("OAL-OAS-ROUTE-AMBIGUOUS");
  });

  it("reports path parameter mismatches", () => {
    const error = failureOf(
      {
        "ppm.json": readFileSync(
          `${fixtures}adversarial/path-param-mismatch.json`,
          "utf8"
        )
      },
      "ppm.json"
    );
    expect(error.code).toBe("OAL-OAS-PATH-PARAMETER-MISSING");
    const diagnostics = (error.details as { diagnostics: unknown[] })
      .diagnostics;
    expect(diagnostics).toHaveLength(2);
  });

  it("fails when a high-confidence secret is retained", () => {
    const error = failureOf(
      {
        "secret.json": readFileSync(
          `${fixtures}adversarial/high-confidence-secret.json`,
          "utf8"
        )
      },
      "secret.json"
    );
    expect(error.code).toBe("OAL-INPUT-SECRET-DETECTED");
  });

  it("enforces the per-example byte limit", () => {
    const documents = {
      "big.json": readFileSync(
        `${fixtures}adversarial/oversized-example.json`,
        "utf8"
      )
    };
    const error = failureOf(documents, "big.json", { maxOneExampleBytes: 64 });
    expect(error.code).toBe("OAL-INPUT-TOO-LARGE");
    expect(compile(documents, "big.json").contract.operations).toHaveLength(1);
  });

  it("enforces the operation limit", () => {
    const error = failureOf(petstore, "openapi/petstore-expanded.yaml", {
      maxOperations: 2
    });
    expect(error.code).toBe("OAL-LIMIT-REACHED");
  });
});
