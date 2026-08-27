import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Json, JsonObject } from "../packages/core/src/json.ts";
import { isJsonObject } from "../packages/core/src/json.ts";
import { SchemaValidator } from "../packages/core/src/schema/validator.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SCHEMA_DIR = path.join(REPO_ROOT, "schemas");
const GOLDEN_DIR = path.join(REPO_ROOT, "tests", "golden", "schemas");
const SPEC_PATH = path.join(REPO_ROOT, "SPEC.md");

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const ID_PREFIX = "https://agentlab.dev/schemas/";

function readJsonFile(filePath: string): Json {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(text) as Json;
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** Strips the ".schema" infix: "pack.v1.schema.json" -> "pack.v1.json". */
function goldenNameForSchema(schemaFile: string): string {
  return schemaFile.replace(/\.schema\.json$/, ".json");
}

/** Strips ".json": "pack.v1.schema.json" -> "pack.v1". */
function schemaBasename(schemaFile: string): string {
  return schemaFile.replace(/\.json$/, "");
}

/**
 * Parses the `schemas/` entry list out of the section 10.4 repository tree in
 * SPEC.md and returns the declared schema file names.
 */
function specListedSchemaFiles(): string[] {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "  schemas/");
  expect(
    start,
    "SPEC.md must contain a '  schemas/' tree entry"
  ).toBeGreaterThanOrEqual(0);
  const files: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("    ")) {
      if (line.trim() === "") {
        continue;
      }
      break;
    }
    const name = line.trim();
    if (name.endsWith(".schema.json")) {
      files.push(name);
    }
  }
  expect(files.length).toBeGreaterThan(0);
  return files.sort();
}

const schemaFiles = listJsonFiles(SCHEMA_DIR);
const specFiles = specListedSchemaFiles();
const goldenFiles = listJsonFiles(GOLDEN_DIR);

describe("schemas directory", () => {
  it("matches the SPEC.md section 10.4 listing exactly", () => {
    expect(schemaFiles).toEqual(specFiles);
  });

  it("contains the expected number of schemas", () => {
    expect(schemaFiles.length).toBe(55);
  });
});

describe.each(schemaFiles)("schema %s", (file) => {
  const schema = readJsonFile(path.join(SCHEMA_DIR, file));

  it("parses as a JSON object", () => {
    expect(isJsonObject(schema)).toBe(true);
  });

  it("declares draft 2020-12", () => {
    expect(isJsonObject(schema) && schema.$schema).toBe(DRAFT_2020_12);
  });

  it("declares the expected $id", () => {
    const expectedId = `${ID_PREFIX}${goldenNameForSchema(file)}`;
    expect(isJsonObject(schema) && schema.$id).toBe(expectedId);
  });

  it("has a root object type and closed properties", () => {
    expect(isJsonObject(schema)).toBe(true);
    const root = schema as JsonObject;
    expect(root.type).toBe("object");
    expect(root.additionalProperties).toBe(false);
    expect(Array.isArray(root.required)).toBe(true);
    expect((root.required as string[]).length).toBeGreaterThan(0);
    expect(isJsonObject(root.properties)).toBe(true);
  });
});

describe("golden examples", () => {
  it("has one valid golden per schema", () => {
    const expected = schemaFiles.map(goldenNameForSchema).sort();
    const validGoldens = goldenFiles
      .filter((name) => !name.endsWith(".invalid.json"))
      .sort();
    expect(validGoldens).toEqual(expected);
  });

  it("has at least ten invalid goldens", () => {
    const invalidGoldens = goldenFiles.filter((name) =>
      name.endsWith(".invalid.json")
    );
    expect(invalidGoldens.length).toBeGreaterThanOrEqual(10);
  });
});

describe.each(schemaFiles)("golden validation for %s", (file) => {
  const schema = readJsonFile(path.join(SCHEMA_DIR, file)) as JsonObject;
  const validator = new SchemaValidator(schema);
  const goldenPath = path.join(GOLDEN_DIR, goldenNameForSchema(file));

  it("accepts its valid golden example", () => {
    const instance = readJsonFile(goldenPath);
    const violations = validator.errors(instance);
    expect(violations).toEqual([]);
  });

  it("rejects a non-object instance", () => {
    const violations = validator.errors("not-an-object");
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe.each(goldenFiles.filter((name) => name.endsWith(".invalid.json")))(
  "invalid golden %s",
  (file) => {
    it("is rejected by its schema", () => {
      const schemaFile = `${schemaBasename(file).replace(/\.invalid$/, "")}.schema.json`;
      const schema = readJsonFile(
        path.join(SCHEMA_DIR, schemaFile)
      ) as JsonObject;
      const instance = readJsonFile(path.join(GOLDEN_DIR, file));
      const violations = new SchemaValidator(schema).errors(instance);
      expect(violations.length).toBeGreaterThan(0);
    });
  }
);
