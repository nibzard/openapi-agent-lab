import { canonicalJson, schemaUid, sha256Hex } from "@oal/core";
import type { Json, JsonObject } from "@oal/core";
import type { SchemaIR } from "@oal/contract-ir";

/**
 * Content-addressed registry of normalized schemas. Identical normalized
 * schemas share one UID, so the registry stays minimal and deterministic.
 */
export class SchemaRegistry {
  private readonly entries = new Map<string, SchemaIR>();
  private readonly byPointer = new Map<string, string>();
  private bytes = 0;

  /**
   * Register a normalized schema and return its UID. Registration is
   * idempotent for equal normalized content.
   */
  register(schema: Json, sourcePointer: string, documentUri: string): string {
    const canonical = canonicalJson(schema);
    const uid = schemaUid(canonical);
    const existing = this.entries.get(uid);
    if (existing === undefined) {
      this.entries.set(uid, {
        uid,
        schema,
        source_pointer: sourcePointer,
        document_uri: documentUri
      });
      this.bytes += canonical.length;
    } else {
      // Prefer the first registration, but remember every source pointer so
      // preserved references stay resolvable.
      const pointerKey = `${documentUri}${sourcePointer}`;
      if (!this.byPointer.has(pointerKey)) {
        this.byPointer.set(pointerKey, uid);
      }
    }
    const pointerKey = `${documentUri}${sourcePointer}`;
    if (!this.byPointer.has(pointerKey)) {
      this.byPointer.set(pointerKey, uid);
    }
    return uid;
  }

  /** UID registered for a document pointer, when that schema was compiled. */
  uidForPointer(
    documentUri: string,
    sourcePointer: string
  ): string | undefined {
    return this.byPointer.get(`${documentUri}${sourcePointer}`);
  }

  get(uid: string): SchemaIR | undefined {
    return this.entries.get(uid);
  }

  /** Canonical JSON serialization of the registry, in UID order. */
  toJson(): Record<string, SchemaIR> {
    const out: Record<string, SchemaIR> = {};
    for (const uid of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(uid);
      if (entry !== undefined) {
        out[uid] = entry;
      }
    }
    return out;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Approximate serialized size of every registered schema. */
  get serializedBytes(): number {
    return this.bytes;
  }

  /** Stable digest over the registry contents. */
  digest(): string {
    return sha256Hex(canonicalJson(this.toJson() as unknown as Json));
  }

  /** True when `schema` is an empty object with no constraining keyword. */
  static isEmptySchema(schema: Json): boolean {
    if (
      schema === null ||
      typeof schema !== "object" ||
      Array.isArray(schema)
    ) {
      return false;
    }
    return Object.keys(schema as JsonObject).length === 0;
  }
}
