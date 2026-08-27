import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";

import {
  allowlistCovers,
  allowlistsOverlap,
  applyJsonPatch,
  checkPatchAllowlist,
  classifyPointerLayer,
  formatJsonPointer,
  parseJsonPointer,
  PatchCode,
  pointerWithin,
  type JsonPatchOperation
} from "./patch.ts";

const doc: Json = {
  a: 1,
  b: { c: [1, 2, 3], d: "x" },
  "e/f": { "~g": true },
  list: [{ id: "one" }, { id: "two" }]
};

function ops(...patch: JsonPatchOperation[]): JsonPatchOperation[] {
  return patch;
}

describe("JSON Pointer handling", () => {
  it("parses and formats pointers with escapes", () => {
    expect(parseJsonPointer("")).toEqual([]);
    expect(parseJsonPointer("/b/c/1")).toEqual(["b", "c", "1"]);
    expect(parseJsonPointer("/e~1f/~0g")).toEqual(["e/f", "~g"]);
    expect(formatJsonPointer(["e/f", "~g"])).toBe("/e~1f/~0g");
  });

  it("rejects pointers that are not valid RFC 6901", () => {
    expect(parseJsonPointer("b/c")).toBeNull();
    expect(parseJsonPointer("/b/~2c")).toBeNull();
    expect(parseJsonPointer("/b/c/01")).not.toBeNull();
  });

  it("matches allowlist entries only on token boundaries", () => {
    expect(pointerWithin("/a/b/c", "/a/b")).toBe(true);
    expect(pointerWithin("/a/b", "/a/b")).toBe(true);
    expect(pointerWithin("/a/bb", "/a/b")).toBe(false);
    expect(pointerWithin("", "")).toBe(true);
    expect(pointerWithin("/x", "")).toBe(true);
    expect(allowlistCovers("/a/b/c", ["/a", "/z"])).toBe(true);
    expect(allowlistCovers("/a/bb", ["/a/b"])).toBe(false);
  });

  it("detects allowlist overlap in both directions", () => {
    expect(allowlistsOverlap(["/a/b"], ["/a/b/c"])).toBe(true);
    expect(allowlistsOverlap(["/a/b/c"], ["/a/b"])).toBe(true);
    expect(allowlistsOverlap(["/a/b"], ["/a/bb"])).toBe(false);
  });

  it("classifies a pointer into its layer", () => {
    expect(
      classifyPointerLayer("/info/description", ["/info"], ["/paths"])
    ).toBe("common-projection");
    expect(classifyPointerLayer("/paths/~1tasks/get", null, ["/paths"])).toBe(
      "variant"
    );
    expect(classifyPointerLayer("/components", ["/info"], ["/paths"])).toBe(
      "unrelated"
    );
    expect(classifyPointerLayer("/components", null, ["/paths"])).toBe(
      "unrelated"
    );
  });
});

describe("patch allowlist enforcement", () => {
  it("accepts operations inside the declared layer", () => {
    const patch = ops({
      op: "replace",
      path: "/b/d",
      value: "y"
    });
    expect(checkPatchAllowlist(patch, ["/b"], "variant")).toEqual([]);
  });

  it("rejects an operation outside the declared layer", () => {
    const patch = ops({
      op: "replace",
      path: "/a",
      value: 2
    });
    const issues = checkPatchAllowlist(patch, ["/b"], "variant");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(PatchCode.AllowlistViolation);
    expect(issues[0]?.index).toBe(0);
  });

  it("checks the source pointer of copy and move too", () => {
    const issues = checkPatchAllowlist(
      ops({ op: "copy", from: "/a", path: "/b/e" }),
      ["/b"],
      "variant"
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.pointer).toBe("/a");
  });

  it("reports every offending operation index", () => {
    const issues = checkPatchAllowlist(
      ops({ op: "remove", path: "/b/d" }, { op: "remove", path: "/zzz" }),
      ["/b"],
      "common projection"
    );
    expect(issues.map((entry) => entry.index)).toEqual([1]);
  });
});

describe("RFC 6902 application", () => {
  it("applies add, replace, remove, move, copy, and test", () => {
    const result = applyJsonPatch(doc, [
      { op: "test", path: "/a", value: 1 },
      { op: "add", path: "/b/e", value: [1] },
      { op: "replace", path: "/b/d", value: "y" },
      { op: "copy", from: "/b/d", path: "/b/f" },
      { op: "move", from: "/b/c/1", path: "/b/c/-" },
      { op: "remove", path: "/e~1f" }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toEqual({
        a: 1,
        b: { c: [1, 3, 2], d: "y", e: [1], f: "y" },
        list: [{ id: "one" }, { id: "two" }]
      });
    }
  });

  it("appends to arrays with the dash index", () => {
    const result = applyJsonPatch(doc, [
      { op: "add", path: "/b/c/-", value: 4 }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.document as { b: { c: number[] } }).b.c).toEqual([
        1, 2, 3, 4
      ]);
    }
  });

  it("replaces the whole document through the empty pointer", () => {
    const result = applyJsonPatch(doc, [
      { op: "replace", path: "", value: { replaced: true } }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toEqual({ replaced: true });
    }
  });

  it("never mutates the input document", () => {
    const before = JSON.stringify(doc);
    applyJsonPatch(doc, [
      { op: "add", path: "/b/e", value: 1 },
      { op: "remove", path: "/a" }
    ]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("applies nothing when one operation fails", () => {
    const result = applyJsonPatch(doc, [
      { op: "add", path: "/b/e", value: 1 },
      { op: "remove", path: "/missing" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.PointerMissing);
    }
  });
});

describe("strict pointer rejection", () => {
  it("rejects a member that does not exist", () => {
    const result = applyJsonPatch(doc, [
      { op: "replace", path: "/b/missing", value: 1 }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.PointerMissing);
    }
  });

  it("rejects traversal through a scalar", () => {
    const result = applyJsonPatch(doc, [
      { op: "add", path: "/a/deep", value: 1 }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.ParentNotContainer);
    }
  });

  it("rejects an array index with a leading zero", () => {
    const result = applyJsonPatch(doc, [{ op: "remove", path: "/b/c/01" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.PointerMissing);
    }
  });

  it("rejects an add index beyond the array length", () => {
    const result = applyJsonPatch(doc, [
      { op: "add", path: "/b/c/9", value: 1 }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.IndexOutOfRange);
    }
  });

  it("rejects removing the whole document", () => {
    const result = applyJsonPatch(doc, [{ op: "remove", path: "" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.RootRemove);
    }
  });

  it("rejects a move whose source is a prefix of the destination", () => {
    const result = applyJsonPatch(doc, [
      { op: "move", from: "/b/c", path: "/b/c/0" }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.FromPrefixOfPath);
    }
  });

  it("rejects a failing test operation", () => {
    const result = applyJsonPatch(doc, [{ op: "test", path: "/a", value: 2 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.TestFailed);
    }
  });

  it("rejects operations that lack their required members", () => {
    const missingValue = applyJsonPatch(doc, [{ op: "add", path: "/b/e" }]);
    expect(missingValue.ok).toBe(false);
    if (!missingValue.ok) {
      expect(missingValue.issues[0]?.code).toBe(PatchCode.ValueMissing);
    }
    const missingFrom = applyJsonPatch(doc, [
      { op: "move", path: "/b/e", value: 1 }
    ]);
    expect(missingFrom.ok).toBe(false);
    if (!missingFrom.ok) {
      expect(missingFrom.issues[0]?.code).toBe(PatchCode.FromMissing);
    }
  });

  it("rejects a pointer with an invalid escape", () => {
    const result = applyJsonPatch(doc, [
      { op: "add", path: "/b/~2c", value: 1 }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.PointerInvalid);
    }
  });

  it("rejects a dash index where the array must exist", () => {
    const result = applyJsonPatch(doc, [
      { op: "replace", path: "/b/c/-", value: 1 }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(PatchCode.IndexInvalid);
    }
  });
});
