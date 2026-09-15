import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Json } from "../packages/core/src/json.ts";
import { SchemaValidator } from "../packages/core/src/schema/validator.ts";

/**
 * Independent conformance corpus: the official JSON Schema Test Suite,
 * draft 2020-12, vendored at the revision recorded in manifest.json.
 * Every case either passes or appears in the manifest as an explicit,
 * justified skip. A skip that stops failing makes the "keeps every skip
 * justified" test fail, so exclusions cannot silently rot.
 */
const SUITE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "conformance",
  "json-schema-suite"
);
const DRAFT_DIR = path.join(SUITE_DIR, "draft2020-12");

interface ManifestFileSpec {
  enabled: boolean;
  reason?: string;
}

interface Manifest {
  source: string;
  revision: string;
  retrieved_at: string;
  license: string;
  draft: string;
  files: Record<string, ManifestFileSpec>;
  group_skips: { file: string; group: string; reason: string }[];
}

interface SuiteTest {
  description: string;
  data: Json;
  valid: boolean;
}

interface SuiteGroup {
  description: string;
  schema: Json;
  tests: SuiteTest[];
}

const manifest = JSON.parse(
  readFileSync(path.join(SUITE_DIR, "manifest.json"), "utf8")
) as Manifest;

const skipByGroup = new Map<string, string>();
for (const skip of manifest.group_skips) {
  skipByGroup.set(`${skip.file}::${skip.group}`, skip.reason);
}

function loadGroups(name: string): SuiteGroup[] {
  return JSON.parse(
    readFileSync(path.join(DRAFT_DIR, name), "utf8")
  ) as SuiteGroup[];
}

function outcome(group: SuiteGroup, test: SuiteTest): boolean {
  return new SchemaValidator(group.schema).isValid(group.schema, test.data);
}

describe("JSON Schema Test Suite conformance (draft 2020-12 subset)", () => {
  it("keeps the vendored corpus size", () => {
    let cases = 0;
    let groups = 0;
    for (const name of Object.keys(manifest.files)) {
      for (const group of loadGroups(name)) {
        groups += 1;
        cases += group.tests.length;
      }
    }
    expect(groups).toBeGreaterThanOrEqual(380);
    expect(cases).toBeGreaterThanOrEqual(1301);
  });

  it("keeps every skip justified", () => {
    const stale: string[] = [];
    for (const skip of manifest.group_skips) {
      const matches = loadGroups(skip.file).filter(
        (g) => g.description === skip.group
      );
      expect(
        matches,
        `${skip.file}::${skip.group} names exactly one group`
      ).toHaveLength(1);
      const group = matches[0] as SuiteGroup;
      const stillFails = group.tests.some((t) => outcome(group, t) !== t.valid);
      if (!stillFails) {
        stale.push(`group skip no longer needed: ${skip.file}::${skip.group}`);
      }
    }
    for (const [name, spec] of Object.entries(manifest.files)) {
      if (spec.enabled) {
        continue;
      }
      const stillFails = loadGroups(name).some((g) =>
        g.tests.some((t) => outcome(g, t) !== t.valid)
      );
      if (!stillFails) {
        stale.push(`file disable no longer needed: ${name}`);
      }
    }
    expect(stale).toEqual([]);
  });

  for (const [name, spec] of Object.entries(manifest.files)) {
    if (!spec.enabled) {
      it.skip(`${name} — ${spec.reason ?? "disabled"}`, () => {});
      continue;
    }
    for (const group of loadGroups(name)) {
      const skipReason = skipByGroup.get(`${name}::${group.description}`);
      if (skipReason !== undefined) {
        it.skip(`${name} > ${group.description} — ${skipReason}`, () => {});
        continue;
      }
      for (const test of group.tests) {
        it(`${name} > ${group.description} > ${test.description}`, () => {
          expect(outcome(group, test)).toBe(test.valid);
        });
      }
    }
  }
});
