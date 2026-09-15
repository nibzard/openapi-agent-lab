/**
 * Test-only fixture builders for the contract-variant suite. This module is
 * not part of the public surface: it reads the repository schema documents and
 * assembles valid variant sets so tests can mutate one field at a time.
 */

import { readFileSync } from "node:fs";

import { canonicalJson, sha256Hex, type JsonObject } from "@oal/core";

import { operationKeysOfDocument } from "./diff.ts";
import {
  loadContractVariantSet,
  packRegistrySnapshot,
  VariantSchemaSet,
  type ContractVariantSet,
  type LoadResult,
  type PackRegistrySnapshot
} from "./model.ts";
import { applyJsonPatch, type JsonPatchOperation } from "./patch.ts";

const SCHEMA_DIR = new URL("../../../schemas/", import.meta.url);

/** Load the three normative schema documents from the repository. */
export function loadSchemas(): VariantSchemaSet {
  return VariantSchemaSet.fromDocuments({
    set: readJson("contract-variant-set.v1.schema.json"),
    manifest: readJson("contract-variant-manifest.v1.schema.json"),
    diff: readJson("contract-variant-diff.v1.schema.json")
  });
}

function readJson(name: string): JsonObject {
  return JSON.parse(
    readFileSync(new URL(name, SCHEMA_DIR), "utf8")
  ) as JsonObject;
}

/** A small OpenAPI 3.1 base contract with two operations. */
export const BASE_CONTRACT = JSON.stringify(
  {
    openapi: "3.1.0",
    info: { title: "Task Service", version: "1.0.0" },
    paths: {
      "/tasks": {
        get: {
          operationId: "listTasks",
          summary: "List tasks",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100 }
            }
          ],
          responses: {
            200: {
              description: "The task list.",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Task" }
                  }
                }
              }
            }
          }
        },
        post: {
          operationId: "createTask",
          summary: "Create a task",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TaskInput" }
              }
            }
          },
          responses: {
            201: {
              description: "The created task.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Task" }
                }
              }
            },
            default: { description: "Unexpected failure." }
          }
        }
      }
    },
    components: {
      schemas: {
        Task: {
          type: "object",
          required: ["id", "title"],
          properties: {
            id: { type: "string" },
            title: { type: "string" }
          }
        },
        TaskInput: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } }
        }
      }
    }
  },
  null,
  2
);

/** One declarative variant patch plus the pointers it may touch. */
export interface VariantFixture {
  readonly id: string;
  readonly patch: readonly JsonPatchOperation[];
  readonly allowlist: readonly string[];
}

export interface SetFixture {
  readonly base?: string;
  readonly common?: {
    readonly patch: readonly JsonPatchOperation[];
    readonly allowlist: readonly string[];
  } | null;
  readonly variants: readonly VariantFixture[];
  readonly expectedConstant?: readonly string[];
  readonly expectedVariable?: readonly string[];
}

/** Assemble a schema-valid set from fixture parts, computing every digest. */
export function buildSet(fixture: SetFixture): JsonObject {
  const base = fixture.base ?? BASE_CONTRACT;
  const common =
    fixture.common === undefined
      ? { patch: [], allowlist: ["/info/contact"] }
      : fixture.common;
  const baseDocument = JSON.parse(base) as JsonObject;
  const projected = applyPatch(baseDocument, common?.patch ?? []);

  const variants = fixture.variants.map((variant) => {
    const effective = applyPatch(projected, variant.patch);
    return {
      id: variant.id,
      transform: { kind: "patch", patch: variant.patch },
      allowlist: variant.allowlist,
      expected_operations: operationKeysOfDocument(effective),
      effective_sha256: sha256Hex(canonicalJson(effective)),
      behavior_adapters: operationKeysOfDocument(effective).map((key) => ({
        operation: key,
        adapter_id: adapterFor(key),
        adapter_sha256: ADAPTER_DIGESTS[adapterFor(key)] ?? ""
      })),
      documentation: JSON.parse(JSON.stringify(DOCUMENTATION)) as JsonObject,
      semantic: JSON.parse(JSON.stringify(SEMANTIC)) as JsonObject
    };
  });

  const document = {
    schema_version: 1,
    kind: "ContractVariantSet",
    id: "tasks-counterfactual",
    base: { source: base, sha256: sha256Hex(base) },
    common_projection:
      common === null
        ? null
        : {
            patch: common.patch,
            allowlist: common.allowlist
          },
    variants,
    surfaces: {
      expected_constant: fixture.expectedConstant ?? [
        "api:title",
        "api:version",
        "operation:path:POST /tasks",
        "parameter:path:GET /tasks|query:limit",
        "request_media_type:path:POST /tasks|application/json",
        "response_media_type:path:GET /tasks|200|application/json",
        "response_selector:path:POST /tasks|201",
        "schema"
      ],
      expected_variable: fixture.expectedVariable ?? [
        "operation:path:GET /tasks",
        "response_selector:path:GET /tasks|200",
        "response_selector:path:GET /tasks|429"
      ]
    },
    extensions: {}
  };
  // The round trip leaves plain JSON, so no fixture object escapes by
  // reference and callers can mutate the result.
  return JSON.parse(JSON.stringify(document)) as JsonObject;
}

function applyPatch(
  document: JsonObject,
  patch: readonly JsonPatchOperation[]
): JsonObject {
  const result = applyJsonPatch(document, patch);
  if (!result.ok) {
    throw new Error(
      `Fixture patch does not apply: ${result.issues[0]?.message}`
    );
  }
  return result.document as JsonObject;
}

/** Adapter digests of the fixture pack, keyed by adapter id. */
export const ADAPTER_DIGESTS: Readonly<Record<string, string>> = {
  "tasks-read-adapter": sha256Hex("tasks-read-adapter v1"),
  "tasks-write-adapter": sha256Hex("tasks-write-adapter v1")
};

function adapterFor(operation: string): string {
  return operation.startsWith("path:GET ")
    ? "tasks-read-adapter"
    : "tasks-write-adapter";
}

/** Documentation inventory every fixture variant declares. */
export const DOCUMENTATION = {
  fact_ids: ["tasks.overview"],
  placement_classes: ["route-index"],
  examples: [
    { id: "tasks.list", sha256: sha256Hex("tasks.list example bytes") }
  ],
  facts_sha256: sha256Hex(
    canonicalJson({
      fact_ids: ["tasks.overview"],
      placement_classes: ["route-index"]
    })
  )
};

/** Semantic inventory every fixture variant declares. */
export const SEMANTIC = {
  action_ids: ["tasks.listed"],
  schemas: [
    {
      id: "tasks.listed",
      sha256: sha256Hex('{"type":"object","required":["count"]}')
    }
  ]
};

/** The pack registry snapshot the fixture set selects over. */
export function fixturePack(): PackRegistrySnapshot {
  return packRegistrySnapshot({
    packId: "tasks-pack",
    packVersion: "1.0.0",
    packSha256: sha256Hex("tasks-pack manifest bytes"),
    semanticEventRegistry: {
      schema_version: 1,
      kind: "SemanticEventRegistry",
      pack_id: "tasks-pack",
      events: [
        {
          name: "tasks.listed",
          event_version: 1,
          payload_schema: '{"type":"object","required":["count"]}',
          payload_schema_sha256: sha256Hex(
            '{"type":"object","required":["count"]}'
          )
        }
      ],
      extensions: {}
    },
    adapters: [
      {
        adapter_id: "tasks-read-adapter",
        adapter_sha256: ADAPTER_DIGESTS["tasks-read-adapter"] ?? "",
        capability: "supported",
        operations: ["path:GET /tasks"]
      },
      {
        adapter_id: "tasks-write-adapter",
        adapter_sha256: ADAPTER_DIGESTS["tasks-write-adapter"] ?? "",
        capability: "supported",
        operations: ["path:POST /tasks"]
      }
    ],
    documentation: {
      facts: [{ id: "tasks.overview", sha256: sha256Hex("tasks.overview") }],
      placement_classes: ["route-index"],
      examples: [
        { id: "tasks.list", sha256: sha256Hex("tasks.list example bytes") }
      ]
    }
  });
}

/** Load a fixture set through the loader, asserting success. */
export async function loadSet(
  fixture: SetFixture
): Promise<ContractVariantSet> {
  const schemas = loadSchemas();
  const result = await loadSetWith(fixture, schemas);
  if (!result.ok) {
    throw new Error(
      `Fixture set does not load: ${result.diagnostics
        .map((entry) => `${entry.code} ${entry.message}`)
        .join("; ")}`
    );
  }
  return result.value;
}

async function loadSetWith(
  fixture: SetFixture,
  schemas: VariantSchemaSet
): Promise<LoadResult<ContractVariantSet>> {
  return await loadContractVariantSet(buildSet(fixture), schemas);
}
