import { describe, expect, it } from "vitest";

import { sha256Hex, type JsonObject } from "@oal/core";

import { loadBlindingReview, loadEquivalenceReview } from "./review.ts";
import {
  baseBlindingReviewDoc,
  baseEquivalenceReviewDoc,
  loadSchema
} from "./fixtures.ts";

const blindingSchema = loadSchema("blinding-review.v1.schema.json");
const equivalenceSchema = loadSchema("equivalence-review.v1.schema.json");

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

describe("loadBlindingReview", () => {
  it("loads a schema-valid review without diagnostics", () => {
    const result = loadBlindingReview(baseBlindingReviewDoc(), {
      schema: blindingSchema
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.review?.approved).toBe(true);
    expect(result.review?.reviewed_surfaces.length).toBe(6);
  });

  it("rejects a document that misses the cue audit digest", () => {
    const doc = baseBlindingReviewDoc();
    delete doc["cue_audit_sha256"];
    const result = loadBlindingReview(doc, { schema: blindingSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects an approval that contradicts a blocking finding", () => {
    const doc = baseBlindingReviewDoc();
    doc["findings"] = [
      {
        severity: "blocking",
        description: "A cell filename reveals its treatment arm."
      }
    ];
    const result = loadBlindingReview(doc, { schema: blindingSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-STRUCTURE-INVALID"
    );
  });

  it("rejects a review that covers no cell", () => {
    const doc: JsonObject = {
      ...baseBlindingReviewDoc(),
      reviewed_surfaces: []
    };
    const result = loadBlindingReview(doc, { schema: blindingSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-STRUCTURE-INVALID"
    );
  });
});

describe("loadEquivalenceReview", () => {
  it("loads a schema-valid review without diagnostics", () => {
    const result = loadEquivalenceReview(baseEquivalenceReviewDoc(), {
      schema: equivalenceSchema
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.review?.reviewers.length).toBe(2);
    expect(result.review?.reviewed.map((entry) => entry.sha256)).toEqual([
      sha256Hex("shape a"),
      sha256Hex("shape b")
    ]);
  });

  it("rejects a single reviewer", () => {
    const doc = baseEquivalenceReviewDoc();
    (doc as { reviewers: unknown[] }).reviewers = [
      { name: "Ada Reviewer", role: "contract" }
    ];
    const result = loadEquivalenceReview(doc, { schema: equivalenceSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects a review that names no reviewed digest", () => {
    const doc = baseEquivalenceReviewDoc();
    (doc as { reviewed: unknown[] }).reviewed = [];
    const result = loadEquivalenceReview(doc, { schema: equivalenceSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });

  it("rejects an approval that contradicts a blocking finding", () => {
    const doc = baseEquivalenceReviewDoc();
    doc["findings"] = [
      {
        severity: "blocking",
        description: "The variants differ in validation strictness."
      }
    ];
    const result = loadEquivalenceReview(doc, { schema: equivalenceSchema });
    expect(result.review).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-STRUCTURE-INVALID"
    );
  });
});
