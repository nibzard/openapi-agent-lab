/**
 * Digest equivalence over formatting and ordering (acceptance criteria
 * AC-002 and AC-097). One document expressed as JSON and as YAML must agree
 * on every digest that excludes source identity, and reordering the maps,
 * media types, named examples, and enum members that validation treats as
 * sets must leave the semantic and execution digests unchanged.
 */

import { describe, expect, it } from "vitest";

import type { Json, JsonObject } from "@oal/core";

import { compileOpenApi } from "../src/index.ts";

const DOCUMENT: JsonObject = {
  openapi: "3.1.0",
  info: { title: "Digest probe", version: "1.0.0" },
  servers: [
    {
      url: "https://{region}.example.test/v1",
      variables: {
        region: {
          enum: ["us-east", "eu-west"],
          default: "us-east",
          description: "Deployment region"
        }
      }
    }
  ],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { $ref: "#/components/schemas/Limit" }
          }
        ],
        responses: {
          "200": {
            description: "A page of pets",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
                examples: {
                  dog: { value: { name: "Rex", kind: "dog" } },
                  cat: { summary: "A cat", value: { name: "Tom", kind: "cat" } }
                }
              },
              "application/xml": {
                schema: { $ref: "#/components/schemas/Pet" }
              }
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
        responses: {
          "200": {
            description: "One pet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["dog", "cat"] }
        }
      },
      Limit: { type: "integer", minimum: 1, default: 20 }
    }
  }
};

/** The same document as YAML, with every mapping declared in another order. */
const DOCUMENT_AS_YAML = [
  "components:",
  "  schemas:",
  "    Limit:",
  "      type: integer",
  "      minimum: 1",
  "      default: 20",
  "    Pet:",
  "      type: object",
  "      required: [name]",
  "      properties:",
  "        kind:",
  "          type: string",
  "          enum: [cat, dog]",
  "        name:",
  "          type: string",
  "paths:",
  "  /pets/{petId}:",
  "    get:",
  "      operationId: showPetById",
  "      parameters:",
  "        - name: petId",
  "          in: path",
  "          required: true",
  "          schema:",
  "            type: string",
  "      responses:",
  '        "200":',
  "          description: One pet",
  "          content:",
  "            application/json:",
  "              schema:",
  '                $ref: "#/components/schemas/Pet"',
  "  /pets:",
  "    get:",
  "      operationId: listPets",
  "      parameters:",
  "        - name: limit",
  "          in: query",
  "          schema:",
  '            $ref: "#/components/schemas/Limit"',
  "      responses:",
  '        "200":',
  "          description: A page of pets",
  "          content:",
  "            application/xml:",
  "              schema:",
  '                $ref: "#/components/schemas/Pet"',
  "            application/json:",
  "              schema:",
  '                $ref: "#/components/schemas/Pet"',
  "              examples:",
  "                cat:",
  "                  summary: A cat",
  "                  value:",
  "                    name: Tom",
  "                    kind: cat",
  "                dog:",
  "                  value:",
  "                    name: Rex",
  "                    kind: dog",
  "servers:",
  '  - url: "https://{region}.example.test/v1"',
  "    variables:",
  "      region:",
  "        enum: [us-east, eu-west]",
  "        default: us-east",
  "        description: Deployment region",
  "info:",
  "  title: Digest probe",
  "  version: 1.0.0",
  "openapi: 3.1.0",
  ""
].join("\n");

/**
 * Reverse every mapping and every `enum` member list. Mappings are
 * semantically unordered, and `enum` selects a set of allowed values, so
 * the reordering must not move any digest that covers behavior.
 */
function reorderSemanticallyUnordered(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => reorderSemanticallyUnordered(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value).reverse()) {
    out[key] =
      key === "enum" && Array.isArray(entry)
        ? [...entry].reverse()
        : reorderSemanticallyUnordered(entry);
  }
  return out;
}

describe("equivalent JSON and YAML sources (AC-002)", () => {
  // The entrypoint name carries no format: section 13.2 detects JSON or
  // YAML from the content, so one name serves both texts.
  const entrypoint = "digest-probe.yaml";
  const asJson = compileOpenApi({
    documents: { [entrypoint]: JSON.stringify(DOCUMENT, null, 2) },
    entrypoint
  });
  const asYaml = compileOpenApi({
    documents: { [entrypoint]: DOCUMENT_AS_YAML },
    entrypoint
  });

  it("records a distinct source digest and media type per format", () => {
    expect(asJson.contract.source.media_type).toBe("application/json");
    expect(asYaml.contract.source.media_type).toBe("application/yaml");
    expect(asJson.contract.source.sha256).not.toBe(
      asYaml.contract.source.sha256
    );
    expect(asJson.contract.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asYaml.contract.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives one semantic digest for both formats", () => {
    expect(asYaml.contract.source.semantic_sha256).toBe(
      asJson.contract.source.semantic_sha256
    );
    expect(asYaml.contract.source.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives one execution digest for both formats", () => {
    expect(asYaml.contract.source.execution_sha256).toBe(
      asJson.contract.source.execution_sha256
    );
    expect(asYaml.contract.source.execution_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compiles equal schemas and operations", () => {
    expect(asYaml.contract.schemas).toEqual(asJson.contract.schemas);
    expect(asYaml.contract.operations).toEqual(asJson.contract.operations);
    expect(asYaml.contract.api).toEqual(asJson.contract.api);
  });
});

describe("reordered unordered collections (AC-097)", () => {
  const entrypoint = "digest-probe.json";
  const original = compileOpenApi({
    documents: { [entrypoint]: JSON.stringify(DOCUMENT) },
    entrypoint
  });
  const reordered = compileOpenApi({
    documents: {
      [entrypoint]: JSON.stringify(reorderSemanticallyUnordered(DOCUMENT))
    },
    entrypoint
  });

  it("keeps the execution digest identical", () => {
    expect(reordered.contract.source.execution_sha256).toBe(
      original.contract.source.execution_sha256
    );
  });

  it("keeps the semantic digest identical", () => {
    expect(reordered.contract.source.semantic_sha256).toBe(
      original.contract.source.semantic_sha256
    );
  });

  it("keeps the schema registry and operations identical", () => {
    expect(reordered.contract.schemas).toEqual(original.contract.schemas);
    expect(reordered.contract.operations).toEqual(original.contract.operations);
  });

  it("keeps named examples and media types in canonical order", () => {
    const content =
      reordered.contract.operations[0]?.responses[0]?.content ?? [];
    expect(content.map((entry) => entry.media_type)).toEqual([
      "application/json",
      "application/xml"
    ]);
    expect(content[0]?.examples.map((example) => example.name)).toEqual([
      "cat",
      "dog"
    ]);
  });

  it("still records the reordered source bytes as a distinct source digest", () => {
    expect(reordered.contract.source.sha256).not.toBe(
      original.contract.source.sha256
    );
    expect(reordered.contract.source.semantic_sha256).not.toBe("");
  });
});
