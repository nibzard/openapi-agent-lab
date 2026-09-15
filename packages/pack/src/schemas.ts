import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invalidInput, parseJsonStrict, type JsonObject } from "@oal/core";

/** Schema documents the pack loader validates against, by short name. */
export const PACK_SCHEMA_FILES = {
  pack: "pack.v1.schema.json",
  "pack-ir": "pack-ir.v1.schema.json",
  "pack-ref": "pack-ref.v1.schema.json",
  eval: "eval.v1.schema.json",
  "prompt-set": "prompt-set.v1.schema.json",
  "contract-response-fixture": "contract-response-fixture.v1.schema.json",
  "semantic-event-registry": "semantic-event-registry.v1.schema.json"
} as const;

export type PackSchemaName = keyof typeof PACK_SCHEMA_FILES;

/**
 * The schema directory that ships with the repository, derived from this
 * module's location so callers do not have to know the layout.
 */
export function defaultSchemaDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "schemas");
}

/** Loaded, immutable set of JSON schemas used during pack validation. */
export class PackSchemaSet {
  private readonly documents: ReadonlyMap<PackSchemaName, JsonObject>;

  private constructor(documents: ReadonlyMap<PackSchemaName, JsonObject>) {
    this.documents = documents;
  }

  static async load(schemaDir: string): Promise<PackSchemaSet> {
    const entries = await Promise.all(
      (Object.keys(PACK_SCHEMA_FILES) as PackSchemaName[]).map(
        async (name): Promise<[PackSchemaName, JsonObject]> => {
          const file = PACK_SCHEMA_FILES[name];
          const target = path.join(schemaDir, file);
          const text = await readFile(target, "utf8").catch(() => {
            throw invalidInput(
              "OAL-PACK-SCHEMA-MISSING",
              `Required schema document is missing: ${target}`
            );
          });
          return [name, parseDocument(text, target)];
        }
      )
    );
    return new PackSchemaSet(new Map(entries));
  }

  /** The raw schema document for one name. */
  document(name: PackSchemaName): JsonObject {
    const found = this.documents.get(name);
    if (found === undefined) {
      throw new Error(`Schema ${name} was not loaded.`);
    }
    return found;
  }
}

function parseDocument(text: string, target: string): JsonObject {
  const parsed = parseJsonStrict(text, { maxNodes: 200_000 });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidInput(
      "OAL-PACK-SCHEMA-MISSING",
      `Schema document is not a JSON object: ${target}`
    );
  }
  return parsed;
}
