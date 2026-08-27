/**
 * ContractIR golden tests (specification sections 13 and 14). Compiling
 * the representative fixture set must produce a canonical ContractIR
 * that is byte-identical across runs, matches the checked-in golden
 * exactly, and validates against schemas/contract-ir.v1.schema.json.
 * Regenerate the golden files with UPDATE_GOLDEN=1, then run
 * `pnpm exec prettier --write packages/openapi/tests/golden` so the
 * repository format check stays green.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SchemaValidator,
  canonicalJson,
  stableJsonStringify,
  type Json
} from "@oal/core";

import { compileOpenApi } from "../src/index.ts";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/", import.meta.url)
);
const GOLDEN_ROOT = fileURLToPath(new URL("./golden/", import.meta.url));
const CONTRACT_SCHEMA = fileURLToPath(
  new URL("../../../schemas/contract-ir.v1.schema.json", import.meta.url)
);

interface GoldenCase {
  /** Golden file name under tests/golden, without the extension. */
  name: string;
  /** Fixture documents keyed by pack-relative path. */
  documents: string[];
  entrypoint: string;
}

const CASES: GoldenCase[] = [
  {
    name: "minimal",
    documents: ["openapi/minimal.json"],
    entrypoint: "openapi/minimal.json"
  },
  {
    name: "petstore-expanded",
    documents: ["openapi/petstore-expanded.yaml"],
    entrypoint: "openapi/petstore-expanded.yaml"
  },
  {
    name: "refs-entry",
    documents: ["openapi/refs/entry.yaml", "openapi/refs/shared.yaml"],
    entrypoint: "openapi/refs/entry.yaml"
  },
  {
    name: "webhooks",
    documents: ["openapi/webhooks.json"],
    entrypoint: "openapi/webhooks.json"
  }
];

function compileGolden(testCase: GoldenCase): Json {
  const documents: Record<string, string> = {};
  for (const document of testCase.documents) {
    documents[document] = readFileSync(join(FIXTURE_ROOT, document), "utf8");
  }
  return compileOpenApi({
    documents,
    entrypoint: testCase.entrypoint
  }).contract as unknown as Json;
}

const contractSchema = JSON.parse(
  readFileSync(CONTRACT_SCHEMA, "utf8")
) as Json;
const validator = new SchemaValidator(contractSchema);

describe("ContractIR goldens", () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it("compiles byte-identically on a second run", () => {
        const first = canonicalJson(compileGolden(testCase));
        const second = canonicalJson(compileGolden(testCase));
        expect(second).toBe(first);
      });

      it("matches the checked-in golden", () => {
        const contract = compileGolden(testCase);
        const goldenPath = join(GOLDEN_ROOT, `${testCase.name}.json`);
        if (process.env.UPDATE_GOLDEN === "1") {
          mkdirSync(GOLDEN_ROOT, { recursive: true });
          writeFileSync(
            goldenPath,
            `${stableJsonStringify(contract)}\n`,
            "utf8"
          );
          return;
        }
        expect(
          existsSync(goldenPath),
          `${testCase.name} golden is checked in; regenerate with UPDATE_GOLDEN=1`
        ).toBe(true);
        const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Json;
        expect(canonicalJson(golden)).toBe(canonicalJson(contract));
      });

      it("validates against the contract-ir schema", () => {
        const contract = compileGolden(testCase);
        expect(validator.errors(contract)).toEqual([]);
      });

      it("stores the golden as pretty-printed JSON", () => {
        const goldenPath = join(GOLDEN_ROOT, `${testCase.name}.json`);
        if (!existsSync(goldenPath)) {
          return;
        }
        const text = readFileSync(goldenPath, "utf8");
        expect(text.endsWith("\n"), "file ends with a newline").toBe(true);
        expect(text.endsWith("}\n"), "file closes the root object").toBe(true);
        const lines = text.split("\n");
        expect(
          /^ {2}"/.test(lines[1] ?? ""),
          "properties are indented two spaces"
        ).toBe(true);
        expect(canonicalJson(JSON.parse(text) as Json)).toBe(
          canonicalJson(compileGolden(testCase))
        );
      });
    });
  }
});
