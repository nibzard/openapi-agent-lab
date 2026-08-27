import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isToolName } from "@oal/core";

import { buildCapabilityReport, compileOpenApi } from "../src/index.ts";

const fixtures = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);

function compile(path: string, documents?: Record<string, string>) {
  const set =
    documents === undefined
      ? { [path]: readFileSync(`${fixtures}${path}`, "utf8") }
      : documents;
  return compileOpenApi({ documents: set, entrypoint: path });
}

const petstore = compile("openapi/petstore-expanded.yaml");

describe("capability reporting", () => {
  it("counts operations and security schemes per level", () => {
    const report = petstore.report;
    const total =
      report.counts.operations.supported +
      report.counts.operations.approximated +
      report.counts.operations.requires_scenario +
      report.counts.operations.unsupported;
    expect(total).toBe(petstore.contract.operations.length);
    expect(report.counts.operations.approximated).toBeGreaterThan(0);
    expect(report.counts.security_schemes).toEqual({
      supported: 3,
      approximated: 1,
      requires_scenario: 0,
      unsupported: 0
    });
  });

  it("describes every operation with its surfaces and reason codes", () => {
    const list = petstore.report.operations.find(
      (operation) =>
        operation.path_template === "/pets" && operation.method === "GET"
    );
    expect(list).toBeDefined();
    expect(list?.level).toBe("approximated");
    expect(list?.reason_codes).toContain("media:application/xml");
    expect(
      list?.surfaces.map((surface) => `${surface.kind}:${surface.name}`)
    ).toEqual(
      expect.arrayContaining([
        "parameter:query:limit",
        "response_media_type:application/json",
        "response_media_type:application/xml",
        "response_selector:200",
        "security_alternative:api_key"
      ])
    );
    for (const capability of petstore.report.operations) {
      expect(capability.reason_codes).toEqual(
        [...capability.reason_codes].sort()
      );
    }
  });

  it("aggregates features across operations deterministically", () => {
    const features = petstore.report.features;
    const xml = features.find(
      (feature) =>
        feature.kind === "media_type" && feature.name === "application/xml"
    );
    expect(xml?.level).toBe("approximated");
    expect(xml?.reason_codes).toEqual(["media:application/xml"]);
    expect(xml?.operation_keys).toContain("path:GET /pets");
    expect(xml?.operation_keys).toContain("path:POST /pets");
    const oauth = features.find(
      (feature) =>
        feature.kind === "security_flow" && feature.name === "petstore_auth"
    );
    expect(oauth?.level).toBe("approximated");
    expect(oauth?.reason_codes).toEqual(["security:oauth2"]);
    const callback = features.find(
      (feature) =>
        feature.kind === "callback" && feature.name === "onPetCreated"
    );
    expect(callback?.level).toBe("approximated");
  });

  it("reports identity findings for tool generation", () => {
    const report = petstore.report;
    expect(report.missing_operation_ids).toBe(1);
    expect(report.duplicate_operation_ids).toEqual([]);
    expect(report.tool_name_collisions).toEqual([]);
    for (const operation of petstore.contract.operations) {
      expect(isToolName(operation.tool_name)).toBe(true);
    }
  });

  it("reports duplicate operation ids and name collisions", () => {
    const documents = {
      "dup.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Duplicates", version: "1.0.0" },
        paths: {
          "/a": {
            get: {
              operationId: "same",
              responses: { "200": { description: "ok" } }
            },
            post: {
              operationId: "same",
              responses: { "200": { description: "ok" } }
            }
          },
          "/b": {
            get: { responses: { "200": { description: "ok" } } },
            head: { responses: { "200": { description: "ok" } } }
          }
        },
        webhooks: {
          b: {
            get: { responses: { "200": { description: "ok" } } }
          }
        }
      })
    };
    const { report } = compile("dup.json", documents);
    expect(report.duplicate_operation_ids).toEqual(["same"]);
    expect(report.tool_name_collisions).toContain("get_b");
    expect(
      report.operations.map((operation) => operation.operation_id)
    ).toEqual(expect.arrayContaining(["same", "same", null, null, null]));
  });

  it("recommends an exposure treatment from the thresholds", () => {
    const recommendations = petstore.report.recommendations;
    expect(recommendations.contract_mode_viability).toBe("viable");
    expect(recommendations.recommended_exposure).toBe("direct-tools");
    expect(recommendations.direct_tools.viable).toBe(true);
    expect(recommendations.direct_tools.operation_count).toBe(7);
    expect(
      recommendations.direct_tools.serialized_schema_bytes
    ).toBeGreaterThan(0);
    expect(recommendations.catalog_tools.viable).toBe(true);
    expect(recommendations.scenario_requirements.length).toBeGreaterThan(0);
    for (const requirement of recommendations.scenario_requirements) {
      expect(requirement.length).toBeGreaterThan(0);
    }
  });

  it("demotes direct tools when the operation threshold is exceeded", () => {
    const report = buildCapabilityReport(petstore.contract, {
      toolExposure: { maxOperations: 3, maxSchemaBytes: 256 * 1024 }
    });
    expect(report.recommendations.direct_tools.viable).toBe(false);
    expect(report.recommendations.direct_tools.reason_codes).toEqual([
      "tool:operation-count"
    ]);
    expect(report.recommendations.recommended_exposure).toBe("catalog-tools");
  });

  it("lists strict blockers from unsupported surfaces", () => {
    const documents = {
      "strict.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Strict blockers", version: "1.0.0" },
        paths: {
          "/x": {
            get: {
              parameters: [
                {
                  name: "nested",
                  in: "query",
                  style: "form",
                  schema: {
                    type: "object",
                    properties: {
                      inner: { type: "object" }
                    }
                  }
                }
              ],
              responses: { "200": { description: "ok" } }
            }
          }
        }
      })
    };
    const { report } = compile("strict.json", documents);
    expect(report.counts.operations.unsupported).toBe(1);
    expect(report.recommendations.strict_blockers).toEqual(
      expect.arrayContaining(["schema:nested-object", "style:form"])
    );
    expect(report.recommendations.recommended_exposure).toBe("raw-http");
    expect(report.recommendations.contract_mode_viability).toBe("not_viable");
  });

  it("carries contract identity and diagnostics", () => {
    const report = petstore.report;
    expect(report.schema_version).toBe(1);
    expect(report.kind).toBe("CapabilityReport");
    expect(report.contract_semantic_sha256).toBe(
      petstore.contract.source.semantic_sha256
    );
    expect(report.source).toEqual({
      openapi_version: "3.0.3",
      media_type: "application/yaml",
      entrypoint: "openapi/petstore-expanded.yaml"
    });
    expect(report.diagnostics).toBe(petstore.contract.diagnostics);
  });

  it("is a pure function of the contract", () => {
    const again = buildCapabilityReport(petstore.contract);
    expect(JSON.stringify(again)).toBe(JSON.stringify(petstore.report));
  });
});
