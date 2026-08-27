import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";

import {
  discoverExternalRefs,
  normalizeRelativePath,
  splitRef
} from "../src/refs.ts";

describe("reference splitting", () => {
  it("keeps same-document pointers", () => {
    expect(splitRef("openapi.yaml", "#")).toEqual({
      uri: "openapi.yaml",
      pointer: "#"
    });
    expect(splitRef("openapi.yaml", "#/components/schemas/Pet")).toEqual({
      uri: "openapi.yaml",
      pointer: "#/components/schemas/Pet"
    });
    expect(splitRef("openapi.yaml", "#/paths/~1pets~1{id}")).toEqual({
      uri: "openapi.yaml",
      pointer: "#/paths/~1pets~1{id}"
    });
  });

  it("resolves sibling and nested document references", () => {
    expect(
      splitRef("entry.yaml", "shared.yaml#/components/schemas/Pet")
    ).toEqual({
      uri: "shared.yaml",
      pointer: "#/components/schemas/Pet"
    });
    expect(splitRef("a/b/entry.yaml", "../c/shared.yaml")).toEqual({
      uri: "a/c/shared.yaml",
      pointer: "#"
    });
    expect(splitRef("a/b/entry.yaml", "./nested.json#/info")).toEqual({
      uri: "a/b/nested.json",
      pointer: "#/info"
    });
    expect(normalizeRelativePath("a/b/c.yaml", "../../d.yaml")).toBe("d.yaml");
  });

  it("rejects remote and root-escaping references", () => {
    expect(() =>
      splitRef("entry.yaml", "https://example.test/pet.json")
    ).toThrow(OalError);
    expect(() => splitRef("entry.yaml", "//example.test/pet.json")).toThrow(
      OalError
    );
    expect(() => splitRef("entry.yaml", "/etc/passwd")).toThrow(OalError);
    expect(() => splitRef("a/b.yaml", "../../escape.yaml")).toThrow(OalError);
    expect(() => splitRef("entry.yaml", "a\\b.yaml")).toThrow(OalError);
  });

  it("discovers external targets from raw text", () => {
    const text = [
      '{"a": {"$ref": "shared.yaml#/x"},',
      ' "b": {"$ref": "#/local"},',
      ' "c": {"$ref": "https://remote.test/x.json"},',
      ' "d": {"$ref": "../up.json#/y"}}'
    ].join(" ");
    expect(discoverExternalRefs("dir/entry.json", text)).toEqual([
      "dir/shared.yaml",
      "up.json"
    ]);
    expect(
      discoverExternalRefs("entry.yaml", 'schema:\n  $ref: "shared.yaml#/x"\n')
    ).toEqual(["shared.yaml"]);
  });
});
