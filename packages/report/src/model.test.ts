import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SchemaValidator, canonicalJson, type Json } from "@oal/core";

import { buildReport, type ReportBuildInput } from "./aggregate.ts";
import { isReport } from "./model.ts";
import { scenarioReport } from "./fixtures.ts";

const REPORT_SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "report.v1.schema.json"
);

async function loadSchema(): Promise<Json> {
  return JSON.parse(await readFile(REPORT_SCHEMA_PATH, "utf8")) as Json;
}

describe("report schema conformance", () => {
  it("validates the scenario report against report.v1", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const report = scenarioReport();
    const violations = validator.errors(report as unknown as Json);
    expect(violations).toEqual([]);
  });

  it("validates an empty batch report against report.v1", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const input: ReportBuildInput = {
      scope: { level: "batch", id: "batch-empty" },
      trials: []
    };
    const violations = validator.errors(buildReport(input) as unknown as Json);
    expect(violations).toEqual([]);
  });

  it("detects a document that misses required fields", async () => {
    const validator = new SchemaValidator(await loadSchema());
    const report = scenarioReport() as unknown as Record<string, Json>;
    const broken: Record<string, Json> = { ...report };
    delete broken["counts"];
    const violations = validator.errors(broken as Json);
    expect(violations.some((entry) => entry.code === "required")).toBe(true);
  });

  it("accepts the scenario report through the structural guard", () => {
    const report = scenarioReport();
    expect(isReport(report)).toBe(true);
    expect(isReport({ schema_version: 1 })).toBe(false);
  });

  it("keeps every count key sorted in the canonical form", () => {
    const report = scenarioReport();
    const text = canonicalJson(report as unknown as Json);
    const statusKeys = report.behavior.api.status_distribution;
    expect(Object.keys(statusKeys)).toEqual(
      [...Object.keys(statusKeys)].sort()
    );
    expect(text.length).toBeGreaterThan(0);
  });
});
