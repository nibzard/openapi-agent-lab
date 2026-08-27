import { describe, expect, it } from "vitest";

import { OalError, type Diagnostic } from "@oal/core";

import { compileOpenApi } from "../src/index.ts";
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

  it("skips targets that reference resolution rejects as out-of-root", () => {
    const text = [
      '{"a": {"$ref": "/etc/passwd"},',
      ' "b": {"$ref": "a\\\\b.yaml"},',
      ' "c": {"$ref": "shared.yaml#/x"}}'
    ].join(" ");
    expect(discoverExternalRefs("entry.json", text)).toEqual(["shared.yaml"]);
  });
});

describe("reference failure pointers (AC-006)", () => {
  const ENTRYPOINT = "entry.json";
  const DECLARING_POINTER =
    "#/paths/~1widgets/get/responses/200/content/application~1json/schema";

  function documentWithRef(ref: string): string {
    return JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Reference probe", version: "1.0.0" },
      paths: {
        "/widgets": {
          get: {
            operationId: "listWidgets",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: ref } }
                }
              }
            }
          }
        }
      }
    });
  }

  function failureOf(ref: string): OalError {
    try {
      compileOpenApi({
        documents: { [ENTRYPOINT]: documentWithRef(ref) },
        entrypoint: ENTRYPOINT
      });
    } catch (error) {
      if (error instanceof OalError) {
        return error;
      }
      throw error;
    }
    throw new Error("Expected compilation to fail");
  }

  function diagnosticWith(error: OalError, code: string): Diagnostic {
    const details = error.details as { diagnostics?: Diagnostic[] };
    const found = (details.diagnostics ?? []).find(
      (entry) => entry.code === code
    );
    expect(found, code).toBeDefined();
    return found as Diagnostic;
  }

  it("points an unresolved approved reference at the declaring node", () => {
    const error = failureOf("#/components/schemas/Absent");
    expect(error.code).toBe("OAL-REF-NOT-FOUND");
    expect(error.exitCode).toBe(2);
    const diagnostic = diagnosticWith(error, "OAL-REF-NOT-FOUND");
    expect(diagnostic.json_pointer).toBe(DECLARING_POINTER);
    expect(diagnostic.document_uri).toBe(ENTRYPOINT);
  });

  it("points every out-of-root reference at the declaring node", () => {
    for (const ref of [
      "../outside.yaml",
      "nested/../../../outside-too.yaml",
      "/etc/passwd",
      "a\\b.yaml"
    ]) {
      const error = failureOf(ref);
      expect(error.code, ref).toBe("OAL-REF-OUTSIDE-ROOT");
      expect(error.exitCode, ref).toBe(2);
      const diagnostic = diagnosticWith(error, "OAL-REF-OUTSIDE-ROOT");
      expect(diagnostic.json_pointer, ref).toBe(DECLARING_POINTER);
      expect(diagnostic.document_uri, ref).toBe(ENTRYPOINT);
    }
  });

  it("points a denied remote reference at the declaring node", () => {
    const error = failureOf("https://schemas.example.test/widget.json");
    expect(error.code).toBe("OAL-REF-REMOTE-DISABLED");
    expect(error.exitCode).toBe(4);
    const diagnostic = diagnosticWith(error, "OAL-REF-REMOTE-DISABLED");
    expect(diagnostic.json_pointer).toBe(DECLARING_POINTER);
    expect(diagnostic.document_uri).toBe(ENTRYPOINT);
  });
});
