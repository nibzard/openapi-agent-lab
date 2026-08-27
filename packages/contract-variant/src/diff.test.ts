import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type Json } from "@oal/core";

import type { ContractVariant, ContractVariantSet } from "./model.ts";
import { loadContractVariantDiff } from "./model.ts";
import {
  buildContractVariantDiff,
  diffJson,
  operationKeysOfDocument
} from "./diff.ts";
import { applyJsonPatch, type JsonPatchOperation } from "./patch.ts";
import { loadSet, loadSchemas } from "./testkit.ts";

const schemas = loadSchemas();

describe("diffJson", () => {
  it("returns no differences for identical documents", () => {
    const document: Json = { a: 1, b: [1, 2, { c: "x" }] };
    expect(diffJson(document, document)).toEqual([]);
  });

  it("reports added, replaced, and removed members at the deepest pointer", () => {
    const base: Json = {
      info: { title: "Task Service" },
      paths: { "/tasks": { get: { summary: "List tasks" } } }
    };
    const effective: Json = {
      info: { title: "Renamed", contact: { name: "Support" } },
      paths: {
        "/tasks": { get: { summary: "List tasks", description: "Every task." } }
      }
    };
    expect(diffJson(base, effective)).toEqual([
      { pointer: "/info/contact", op: "add", after: { name: "Support" } },
      {
        pointer: "/info/title",
        op: "replace",
        before: "Task Service",
        after: "Renamed"
      },
      {
        pointer: "/paths/~1tasks/get/description",
        op: "add",
        after: "Every task."
      }
    ]);
  });

  it("escapes tokens the way RFC 6901 requires", () => {
    const base: Json = { "e/f": { "~g": 1 }, kept: true };
    const effective: Json = { "e/f": {}, kept: true };
    expect(diffJson(base, effective)).toEqual([
      { pointer: "/e~1f/~0g", op: "remove", before: 1 }
    ]);
  });

  it("diffs arrays by index and reports tail changes", () => {
    const base: Json = { list: [{ id: 1 }, { id: 2 }] };
    const effective: Json = { list: [{ id: 1 }, { id: 9 }, { id: 3 }] };
    expect(diffJson(base, effective)).toEqual([
      { pointer: "/list/1/id", op: "replace", before: 2, after: 9 },
      { pointer: "/list/2", op: "add", after: { id: 3 } }
    ]);
  });

  it("reports a container that changes kind as one replacement", () => {
    const base: Json = { x: { a: 1 } };
    const effective: Json = { x: [1, 2] };
    expect(diffJson(base, effective)).toEqual([
      { pointer: "/x", op: "replace", before: { a: 1 }, after: [1, 2] }
    ]);
  });
});

describe("operationKeysOfDocument", () => {
  it("collects path and webhook operations in canonical order", () => {
    const document: Json = {
      paths: {
        "/tasks": { post: {}, get: {}, parameters: [] },
        "/tasks/{id}": { delete: {} }
      },
      webhooks: { taskCreated: { post: {} } }
    };
    // A webhook operation carries the webhook name in place of the template.
    expect(operationKeysOfDocument(document)).toEqual([
      "path:DELETE /tasks/{id}",
      "path:GET /tasks",
      "path:POST /tasks",
      "path:POST taskCreated"
    ]);
  });

  it("returns nothing for a document without operations", () => {
    expect(operationKeysOfDocument({ paths: {} })).toEqual([]);
    expect(operationKeysOfDocument("not an object")).toEqual([]);
  });
});

describe("buildContractVariantDiff", () => {
  const set = loadSet({
    common: {
      patch: [{ op: "add", path: "/info/contact", value: { name: "Support" } }],
      allowlist: ["/info/contact"]
    },
    variants: [
      {
        id: "verbose",
        allowlist: ["/paths/~1tasks/get/responses/200"],
        patch: [
          {
            op: "replace",
            path: "/paths/~1tasks/get/responses/200/description",
            value: "The task list with every field."
          }
        ]
      }
    ]
  });
  const base = JSON.parse(set.base.source) as Json;

  function diffOver(
    effective: Json,
    commonAllowlist: readonly string[] | null
  ): ReturnType<typeof buildContractVariantDiff> {
    return buildContractVariantDiff({
      variant: variantOf(set, "verbose"),
      baseSha256: set.base.sha256,
      effectiveSha256: sha256Hex(canonicalJson(effective)),
      base,
      effective,
      commonAllowlist
    });
  }

  it("classifies every difference into its declared layer", () => {
    const diff = diffOver(
      mustApply(base, [
        { op: "add", path: "/info/contact", value: { name: "Support" } },
        {
          op: "replace",
          path: "/paths/~1tasks/get/responses/200/description",
          value: "The task list with every field."
        }
      ]),
      set.common_projection?.allowlist ?? null
    );
    expect(diff.differences.map((entry) => entry.pointer)).toEqual([
      "/info/contact",
      "/paths/~1tasks/get/responses/200/description"
    ]);
    expect(diff.differences.map((entry) => entry.layer)).toEqual([
      "common-projection",
      "variant"
    ]);
    expect(diff.differences.every((entry) => entry.allowlisted)).toBe(true);
    expect(diff.violations).toEqual([]);
    expect(diff.verified).toBe(true);
  });

  it("marks an undeclared change as a violation and fails verification", () => {
    const diff = diffOver(
      mustApply(base, [
        { op: "add", path: "/info/contact", value: { name: "Support" } },
        {
          op: "replace",
          path: "/paths/~1tasks/get/responses/200/description",
          value: "The task list with every field."
        },
        { op: "replace", path: "/paths/~1tasks/get/summary", value: "Drifted" }
      ]),
      set.common_projection?.allowlist ?? null
    );
    expect(
      diff.differences.map((entry) => [entry.pointer, entry.layer])
    ).toEqual([
      ["/info/contact", "common-projection"],
      ["/paths/~1tasks/get/responses/200/description", "variant"],
      ["/paths/~1tasks/get/summary", "unrelated"]
    ]);
    expect(diff.differences.map((entry) => entry.allowlisted)).toEqual([
      true,
      true,
      false
    ]);
    expect(diff.violations.map((entry) => entry.pointer)).toEqual([
      "/paths/~1tasks/get/summary"
    ]);
    expect(diff.verified).toBe(false);
  });

  it("reports the operation inventory of the effective document", () => {
    const diff = diffOver(
      mustApply(base, [
        { op: "remove", path: "/paths/~1tasks/post" },
        {
          op: "add",
          path: "/paths/~1tasks~1{id}",
          value: { get: { responses: { 200: { description: "One task." } } } }
        }
      ]),
      null
    );
    expect(diff.operation_inventory).toEqual({
      added: ["path:GET /tasks/{id}"],
      removed: ["path:POST /tasks"],
      unchanged_count: 1
    });
    expect(diff.variant_id).toBe("verbose");
    expect(diff.base_sha256).toBe(set.base.sha256);
  });

  it("produces a document the diff schema accepts", () => {
    const diff = diffOver(
      mustApply(base, [
        {
          op: "replace",
          path: "/paths/~1tasks/get/responses/200/description",
          value: "The task list with every field."
        }
      ]),
      null
    );
    const loaded = loadContractVariantDiff(
      JSON.parse(JSON.stringify(diff)) as Json,
      schemas
    );
    expect(loaded.ok).toBe(true);
  });
});

function variantOf(set: ContractVariantSet, id: string): ContractVariant {
  const found = set.variants.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`The fixture set declares no variant '${id}'.`);
  }
  return found;
}

function mustApply(document: Json, patch: readonly JsonPatchOperation[]): Json {
  const result = applyJsonPatch(document, patch);
  if (!result.ok) {
    throw new Error(
      `The fixture patch does not apply: ${result.issues[0]?.message}`
    );
  }
  return result.document;
}
