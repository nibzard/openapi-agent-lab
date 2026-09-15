import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  isJsonObject,
  jsonClone,
  jsonEquals,
  stableJsonStringify
} from "./json.ts";
import {
  canonicalJsonSha256,
  digestEquals,
  isSha256Hex,
  sha256Hex
} from "./digest.ts";
import {
  assertSafeId,
  isSafeId,
  isToolName,
  operationUid,
  schemaUid,
  sequenceId
} from "./id.ts";
import { parseJsonStrict, StrictJsonError } from "./jsonparse.ts";
import {
  appendIndex,
  appendPointer,
  resolveJsonPointer
} from "./jsonpointer.ts";
import {
  assertSafeRelativePath,
  decodePathSegment,
  isWithin
} from "./safepath.ts";
import { SchemaValidator } from "./schema/validator.ts";
import { formatRfc3339, parseRfc3339 } from "./time.ts";
import { diagnostic, errorDiagnostics } from "./diagnostic.ts";
import { EXIT_INVALID, EXIT_OK, invalidInput, toOalError } from "./errors.ts";

describe("canonical JSON", () => {
  it("sorts object keys lexicographically at every depth", () => {
    const value = { z: 1, a: { d: [3, { y: 1, b: 2 }], c: true } };
    expect(canonicalJson(value)).toBe(
      '{"a":{"c":true,"d":[3,{"b":2,"y":1}]},"z":1}'
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("produces identical text for differently ordered objects", () => {
    const a = { one: 1, two: 2, three: { four: 4, five: 5 } };
    const b = { three: { five: 5, four: 4 }, two: 2, one: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("round-trips equality and clone", () => {
    const value = { a: [1, "two", false, null], b: { c: 3 } };
    expect(jsonEquals(value, jsonClone(value))).toBe(true);
    expect(jsonClone(value)).not.toBe(value);
  });

  it("serializes stably with indentation", () => {
    expect(stableJsonStringify({ b: 1, a: 2 })).toBe(
      '{\n  "a": 2,\n  "b": 1\n}'
    );
  });

  it("recognizes objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });
});

describe("digests", () => {
  it("matches reference vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("hashes canonical JSON deterministically regardless of key order", () => {
    const left = canonicalJsonSha256({ a: 1, b: 2 });
    const right = canonicalJsonSha256({ b: 2, a: 1 });
    expect(left).toBe(right);
    expect(left).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
  });

  it("validates hex shape and compares digests", () => {
    expect(isSha256Hex(sha256Hex("x"))).toBe(true);
    expect(isSha256Hex("zz")).toBe(false);
    expect(digestEquals(sha256Hex("x"), sha256Hex("x"))).toBe(true);
    expect(digestEquals(sha256Hex("x"), sha256Hex("y"))).toBe(false);
  });
});

describe("identifiers", () => {
  it("derives a stable operation UID from the canonical key", () => {
    const uid = operationUid("path:GET /v1/computers");
    expect(uid).toBe("op_998df9e6a65c");
    expect(operationUid("path:GET /v1/computers")).toBe(uid);
  });

  it("derives schema UIDs from canonical schema text", () => {
    const a = schemaUid('{"type":"string"}');
    const b = schemaUriShifted();
    expect(a).toBe(b);
    expect(a.startsWith("sch_")).toBe(true);
  });

  function schemaUriShifted(): string {
    return schemaUid(canonicalJson({ type: "string" }));
  }

  it("enforces safe IDs and tool names", () => {
    expect(isSafeId("abc-123")).toBe(true);
    expect(isSafeId("")).toBe(false);
    expect(isSafeId("-nope")).toBe(false);
    expect(isSafeId("a".repeat(128))).toBe(true);
    expect(isSafeId("a".repeat(129))).toBe(false);
    expect(() => assertSafeId("bad id", "test id")).toThrow();
    expect(isToolName("get_user")).toBe(true);
    expect(isToolName("1get")).toBe(false);
    expect(isToolName("a".repeat(65))).toBe(false);
  });

  it("formats sequence IDs with zero padding", () => {
    expect(sequenceId("req", 1)).toBe("req_00000001");
    expect(sequenceId("req", 123456789)).toBe("req_123456789");
  });
});

describe("strict JSON parser", () => {
  it("parses ordinary documents", () => {
    expect(parseJsonStrict('{"a":[1,2,{"b":null}]}')).toEqual({
      a: [1, 2, { b: null }]
    });
  });

  it("rejects duplicate keys", () => {
    expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow(StrictJsonError);
  });

  it("rejects trailing content", () => {
    expect(() => parseJsonStrict('{"a":1} junk')).toThrow(StrictJsonError);
  });

  it("rejects unescaped control characters", () => {
    expect(() => parseJsonStrict('{"a":"line\nbreak"}')).toThrow(
      StrictJsonError
    );
  });

  it("rejects NaN and Infinity", () => {
    expect(() => parseJsonStrict('{"a":NaN}')).toThrow(StrictJsonError);
    expect(() => parseJsonStrict('{"a":Infinity}')).toThrow(StrictJsonError);
  });

  it("enforces the node budget", () => {
    const many = `[${"1,".repeat(50)}1]`;
    expect(() => parseJsonStrict(many, { maxNodes: 10 })).toThrow(
      StrictJsonError
    );
  });

  it("enforces the byte budget", () => {
    expect(() =>
      parseJsonStrict('{"a":"xxxxxxxxxxxxxxxx"}', { maxBytes: 4 })
    ).toThrow(StrictJsonError);
  });
});

describe("JSON Pointer", () => {
  const doc = { a: [1, 2], "b/c": { "d~e": 3 } };

  it("resolves pointers with escapes", () => {
    expect(resolveJsonPointer(doc, "/a/1")).toBe(2);
    expect(resolveJsonPointer(doc, "/b~1c/d~0e")).toBe(3);
    expect(resolveJsonPointer(doc, "")).toBe(doc);
  });

  it("returns undefined for missing targets", () => {
    expect(resolveJsonPointer(doc, "/a/9")).toBeUndefined();
    expect(resolveJsonPointer(doc, "/z")).toBeUndefined();
  });

  it("appends tokens and indices", () => {
    expect(appendPointer("/a", "b/c")).toBe("/a/b~1c");
    expect(appendIndex("/a", 3)).toBe("/a/3");
  });
});

describe("safe paths", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => assertSafeRelativePath("../escape", "pack asset")).toThrow();
    expect(() => assertSafeRelativePath("/abs", "pack asset")).toThrow();
    expect(() => assertSafeRelativePath("a/../../b", "pack asset")).toThrow();
    expect(() => assertSafeRelativePath("a/./b", "pack asset")).toThrow();
    expect(() => assertSafeRelativePath("", "pack asset")).toThrow();
  });

  it("accepts ordinary relative paths", () => {
    expect(() =>
      assertSafeRelativePath("contract/openapi.json", "pack asset")
    ).not.toThrow();
  });

  it("checks containment", () => {
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });

  it("decodes valid path segments and rejects malformed ones", () => {
    expect(decodePathSegment("users%7Cx")).toBe("users|x");
    expect(decodePathSegment("plain")).toBe("plain");
    expect(decodePathSegment("%zz")).toBeNull();
    expect(decodePathSegment("a%2")).toBeNull();
    expect(decodePathSegment("sp%20ace")).toBe("sp ace");
  });
});

describe("schema validator", () => {
  it("validates type, required, and additionalProperties", () => {
    const validator = new SchemaValidator({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    });
    expect(validator.errors({ name: "x" })).toHaveLength(0);
    const bad = validator.errors({ name: 3, extra: true });
    expect(bad.map((v) => v.code)).toContain("type");
    expect(bad.map((v) => v.code)).toContain("additionalProperties");
    expect(validator.errors({})).toEqual([
      expect.objectContaining({ code: "required" })
    ]);
  });

  it("validates numeric bounds and enums", () => {
    const validator = new SchemaValidator({
      type: "number",
      minimum: 2,
      maximum: 10,
      multipleOf: 2,
      enum: [2, 4, 6]
    });
    expect(validator.errors(4)).toHaveLength(0);
    expect(validator.errors(5).map((v) => v.code)).toContain("multipleOf");
    expect(validator.errors(12).map((v) => v.code)).toContain("maximum");
  });

  it("resolves local references", () => {
    const validator = new SchemaValidator({
      $defs: { name: { type: "string", minLength: 2 } },
      $ref: "#/$defs/name"
    });
    expect(validator.errors("ok")).toHaveLength(0);
    expect(validator.errors("x")).toHaveLength(1);
    expect(validator.errors(5).map((v) => v.code)).toContain("type");
  });

  it("measures string length in Unicode code points", () => {
    const validator = new SchemaValidator({
      type: "string",
      minLength: 2,
      maxLength: 2
    });
    // Two supplementary-plane characters are two code points but four
    // UTF-16 code units.
    expect(validator.errors("😀😀")).toHaveLength(0);
    expect(validator.errors("😀").map((v) => v.code)).toContain("minLength");
    expect(validator.errors("😀😀😀").map((v) => v.code)).toContain(
      "maxLength"
    );
  });

  it("applies sibling keywords beside a reference", () => {
    const validator = new SchemaValidator({
      $defs: { tags: { type: "array" } },
      $ref: "#/$defs/tags",
      maxItems: 2
    });
    expect(validator.errors(["a", "b"])).toHaveLength(0);
    expect(validator.errors(["a", "b", "c"]).map((v) => v.code)).toContain(
      "maxItems"
    );
    expect(validator.errors("nope").map((v) => v.code)).toContain("type");
  });

  it("reports unresolved references", () => {
    const validator = new SchemaValidator({ $ref: "#/$defs/missing" });
    expect(validator.errors("x").map((v) => v.code)).toContain("ref_not_found");
  });

  it("decodes escaped reference fragments", () => {
    const validator = new SchemaValidator({
      $defs: {
        "tilde~field": { type: "integer" },
        "slash/field": { type: "integer" },
        "percent%field": { type: "integer" },
        'foo"bar': { type: "number" }
      },
      properties: {
        tilde: { $ref: "#/$defs/tilde~0field" },
        slash: { $ref: "#/$defs/slash~1field" },
        percent: { $ref: "#/$defs/percent%25field" },
        quote: { $ref: "#/$defs/foo%22bar" }
      }
    });
    expect(
      validator.errors({ tilde: 1, slash: 2, percent: 3, quote: 4 })
    ).toHaveLength(0);
    expect(
      validator
        .errors({ tilde: "x", slash: "x", percent: "x", quote: "x" })
        .map((v) => v.code)
    ).toEqual(["type", "type", "type", "type"]);
  });

  it("compiles patterns in unicode mode first", () => {
    const validator = new SchemaValidator({
      type: "string",
      pattern: "^\\p{L}+$"
    });
    expect(validator.errors("wordé")).toHaveLength(0);
    expect(validator.errors("word1").map((v) => v.code)).toContain("pattern");
    // A pattern that unicode mode rejects still compiles without the flag.
    const lenient = new SchemaValidator({ type: "string", pattern: "a\\-b" });
    expect(lenient.errors("a-b")).toHaveLength(0);
  });

  it("treats objects with reordered keys as equal", () => {
    const validator = new SchemaValidator({ uniqueItems: true });
    expect(
      validator
        .errors([
          { a: 1, b: 2 },
          { b: 2, a: 1 }
        ])
        .map((v) => v.code)
    ).toContain("uniqueItems");
    expect(
      validator.errors([
        { a: 1, b: 2 },
        { a: 1, b: 3 }
      ])
    ).toHaveLength(0);
  });

  it("rejects a multipleOf quotient that overflows to infinity", () => {
    const validator = new SchemaValidator({ multipleOf: 1e-308 });
    expect(validator.errors(1e308).map((v) => v.code)).toContain("multipleOf");
  });

  it("enforces unevaluated keywords set to false", () => {
    const items = new SchemaValidator({
      type: "array",
      prefixItems: [{ type: "number" }],
      unevaluatedItems: false
    });
    expect(items.errors([1])).toHaveLength(0);
    expect(items.errors([1, "x"]).map((v) => v.code)).toContain(
      "unevaluatedItems"
    );
    const props = new SchemaValidator({
      type: "object",
      properties: { a: { type: "number" } },
      unevaluatedProperties: false
    });
    expect(props.errors({ a: 1 })).toHaveLength(0);
    expect(props.errors({ a: 1, b: "x" }).map((v) => v.code)).toContain(
      "unevaluatedProperties"
    );
  });

  it("counts contains matches as evaluated items", () => {
    const validator = new SchemaValidator({
      type: "array",
      contains: { type: "number" },
      unevaluatedItems: false
    });
    expect(validator.errors([1, 2])).toHaveLength(0);
    expect(validator.errors([1, "x", true]).map((v) => v.code)).toContain(
      "unevaluatedItems"
    );
  });

  it("validates string formats only when assertion is requested", () => {
    const validator = new SchemaValidator({ type: "string", format: "uuid" });
    expect(validator.errors("not-a-uuid")).toHaveLength(0);
    const asserting = new SchemaValidator(
      { type: "string", format: "uuid" },
      { assertFormats: ["uuid"] }
    );
    expect(asserting.errors("not-a-uuid").map((v) => v.code)).toContain(
      "format"
    );
    expect(
      asserting.errors("123e4567-e89b-42d3-a456-426614174000")
    ).toHaveLength(0);
  });

  it("validates array and combinators", () => {
    const tuple = new SchemaValidator({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
      minItems: 2,
      uniqueItems: true
    });
    expect(tuple.errors(["a", 1])).toHaveLength(0);
    expect(tuple.errors(["a", 1, "b"]).map((v) => v.code)).toContain("items");
    expect(tuple.errors(["a"]).map((v) => v.code)).toContain("minItems");

    const oneOf = new SchemaValidator({
      oneOf: [{ type: "string" }, { type: "number" }]
    });
    expect(oneOf.errors(3)).toHaveLength(0);
    expect(oneOf.errors(true).map((v) => v.code)).toContain("oneOf");
  });
});

describe("time", () => {
  it("round-trips RFC 3339 timestamps", () => {
    const iso = "2000-01-01T00:00:00.000Z";
    expect(formatRfc3339(parseRfc3339(iso))).toBe(iso);
    expect(() => parseRfc3339("garbage")).toThrow();
  });
});

describe("diagnostics and errors", () => {
  it("builds diagnostics with stable fields", () => {
    const d = diagnostic({
      code: "OAL-TEST-1",
      severity: "error",
      phase: "compile",
      message: "Broken.",
      json_pointer: "/paths"
    });
    expect(d.severity).toBe("error");
    expect(errorDiagnostics([d])).toHaveLength(1);
  });

  it("maps errors to exit codes", () => {
    const err = invalidInput("OAL-TEST-2", "Bad.");
    expect(err.exitCode).toBe(EXIT_INVALID);
    expect(toOalError(new Error("boom")).exitCode).toBe(EXIT_OK + 3);
    expect(EXIT_OK).toBe(0);
  });
});
