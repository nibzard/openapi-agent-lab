import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type Json } from "@oal/core";

import {
  loadContractVariantDiff,
  loadContractVariantManifest,
  loadContractVariantSet
} from "./model.ts";
import {
  materializeContractVariantSet,
  type MaterializeSuccess
} from "./generate.ts";
import { buildSet, fixturePack, loadSet, loadSchemas } from "./testkit.ts";
import type { SetFixture, VariantFixture } from "./testkit.ts";

const schemas = loadSchemas();
const pack = fixturePack();

/** Both variants share this projection, so both carry a contact block. */
const COMMON: NonNullable<SetFixture["common"]> = {
  patch: [{ op: "add", path: "/info/contact", value: { name: "Support" } }],
  allowlist: ["/info/contact"]
};

const VERBOSE: VariantFixture = {
  id: "verbose",
  allowlist: ["/paths/~1tasks/get/responses/200"],
  patch: [
    {
      op: "replace",
      path: "/paths/~1tasks/get/responses/200/description",
      value: "The task list with every field."
    }
  ]
};

const TERSE: VariantFixture = {
  id: "terse",
  allowlist: [
    "/paths/~1tasks/get/responses/200",
    "/paths/~1tasks/get/responses/429"
  ],
  patch: [
    {
      op: "replace",
      path: "/paths/~1tasks/get/responses/200/description",
      value: "Tasks."
    },
    {
      op: "add",
      path: "/paths/~1tasks/get/responses/429",
      value: { description: "Rate limited." }
    }
  ]
};

const set = await loadSet({ common: COMMON, variants: [VERBOSE, TERSE] });
const result = materializeContractVariantSet(set, pack);

function success(): readonly MaterializeSuccess[] {
  if (!result.ok) {
    throw new Error(
      result.diagnostics.map((entry) => entry.message).join("; ")
    );
  }
  return result.value;
}

function byId(id: string): MaterializeSuccess {
  const found = success().find((entry) => entry.variant.id === id);
  if (found === undefined) {
    throw new Error(`The set materialized no variant '${id}'.`);
  }
  return found;
}

function digestOf(id: string, surfaceId: string): string | undefined {
  return byId(id).surfaces.find((surface) => surface.id === surfaceId)?.sha256;
}

describe("end-to-end set over the hand-built base contract", () => {
  it("materializes both variants", () => {
    expect(success().map((entry) => entry.variant.id)).toEqual([
      "verbose",
      "terse"
    ]);
  });

  it("verifies both diffs and pins the base digest in each", () => {
    for (const entry of success()) {
      expect(entry.diff.violations).toEqual([]);
      expect(entry.diff.verified).toBe(true);
      expect(entry.diff.base_sha256).toBe(sha256Hex(set.base.source));
    }
  });

  it("applies the common projection to both variants", () => {
    for (const entry of success()) {
      expect(entry.effectiveText).toContain('"Support"');
      const contact = entry.diff.differences.find(
        (difference) => difference.pointer === "/info/contact"
      );
      expect(contact?.layer).toBe("common-projection");
      expect(contact?.allowlisted).toBe(true);
    }
  });

  it("classifies the variant changes in the variant layer", () => {
    const verbose = byId("verbose").diff.differences;
    expect(verbose.map((difference) => difference.pointer)).toEqual([
      "/info/contact",
      "/paths/~1tasks/get/responses/200/description"
    ]);
    const terse = byId("terse").diff.differences;
    expect(terse.map((difference) => difference.pointer)).toEqual([
      "/info/contact",
      "/paths/~1tasks/get/responses/200/description",
      "/paths/~1tasks/get/responses/429"
    ]);
    expect(terse.every((difference) => difference.allowlisted)).toBe(true);
    expect(new Set(terse.map((difference) => difference.layer))).toEqual(
      new Set(["common-projection", "variant"])
    );
  });

  it("adds the rate limit response only where it is declared", () => {
    expect(byId("terse").diff.operation_inventory).toEqual({
      added: [],
      removed: [],
      unchanged_count: 2
    });
    expect(byId("terse").surfaces.map((surface) => surface.id)).toContain(
      "response_selector:path:GET /tasks|429"
    );
    expect(byId("verbose").surfaces.map((surface) => surface.id)).not.toContain(
      "response_selector:path:GET /tasks|429"
    );
  });

  it("keeps declared constant surfaces identical", () => {
    for (const surfaceId of [
      "api:title",
      "api:version",
      "operation:path:POST /tasks",
      "parameter:path:GET /tasks|query:limit",
      "request_media_type:path:POST /tasks|application/json",
      "response_media_type:path:GET /tasks|200|application/json",
      "response_selector:path:POST /tasks|201",
      "tool_name:listTasks"
    ]) {
      expect(digestOf("verbose", surfaceId)).toBe(digestOf("terse", surfaceId));
    }
  });

  it("lets only the declared variable surfaces differ", () => {
    expect(digestOf("verbose", "operation:path:GET /tasks")).not.toBe(
      digestOf("terse", "operation:path:GET /tasks")
    );
    expect(
      digestOf("verbose", "response_selector:path:GET /tasks|200")
    ).not.toBe(digestOf("terse", "response_selector:path:GET /tasks|200"));
  });

  it("produces manifests and diffs the schemas accept", async () => {
    for (const entry of success()) {
      const manifest = await loadContractVariantManifest(
        JSON.parse(JSON.stringify(entry.manifest)) as Json,
        schemas
      );
      expect(manifest.ok).toBe(true);
      const diff = await loadContractVariantDiff(
        JSON.parse(JSON.stringify(entry.diff)) as Json,
        schemas
      );
      expect(diff.ok).toBe(true);
    }
  });

  it("materializes the same set bytes byte-identically twice", async () => {
    const text = canonicalJson(
      buildSet({ common: COMMON, variants: [VERBOSE, TERSE] })
    );
    const runs: string[][] = [];
    for (let i = 0; i < 2; i += 1) {
      const loaded = await loadContractVariantSet(text, schemas);
      if (!loaded.ok) {
        throw new Error(
          loaded.diagnostics.map((entry) => entry.message).join("; ")
        );
      }
      const again = materializeContractVariantSet(loaded.value, pack);
      if (!again.ok) {
        throw new Error(
          again.diagnostics.map((entry) => entry.message).join("; ")
        );
      }
      runs.push(again.value.map((entry) => entry.effectiveText));
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]?.[0]).not.toBe(runs[0]?.[1]);
  });
});
