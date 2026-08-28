import { describe, expect, it } from "vitest";

import { OalError, type Diagnostic } from "@oal/core";
import type { SchemaIR } from "@oal/contract-ir";

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

/**
 * Recursive schemas that are reachable only through another schema's
 * inlined copy must still land in the contract's schema registry under
 * their own pointer. The gateway resolves every preserved reference
 * (`#/components/schemas/Node`, `shared.yaml#/...`, and the
 * `oal-schema:` bound form) through `createContractSchemaLookup`, which
 * indexes `contract.schemas` by `<document-uri><source-pointer>`; a
 * missing entry makes the lookup return undefined, so validation of that
 * subtree is skipped and generation fails closed.
 */
describe("registry coverage of preserved reference targets (R02)", () => {
  const WRAPPED_POINTER = "#/components/schemas/Wrapped";
  const NODE_POINTER = "#/components/schemas/Node";

  function wrappedDocument(): string {
    return JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Wrapped recursion", version: "1.0.0" },
      paths: {
        "/wrapped": {
          post: {
            operationId: "createWrapped",
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: WRAPPED_POINTER } }
              }
            },
            responses: {
              "201": { description: "Created" }
            }
          }
        }
      },
      components: {
        schemas: {
          // `Node` has no top-level usage site: it is reachable only
          // through the copy inlined into `Wrapped`'s normalized form.
          Wrapped: {
            type: "object",
            required: ["node"],
            properties: { node: { $ref: NODE_POINTER } }
          },
          Node: {
            type: "object",
            required: ["name", "children"],
            properties: {
              name: { type: "string" },
              children: {
                type: "array",
                items: { $ref: NODE_POINTER }
              }
            }
          }
        }
      }
    });
  }

  function schemasOf(
    documents: Record<string, string>,
    entrypoint: string
  ): Record<string, SchemaIR> {
    return compileOpenApi({ documents, entrypoint }).contract.schemas;
  }

  function entryFor(
    schemas: Record<string, SchemaIR>,
    documentUri: string,
    pointer: string
  ): SchemaIR | undefined {
    return Object.values(schemas).find(
      (schema) =>
        schema.document_uri === documentUri && schema.source_pointer === pointer
    );
  }

  it("inlines one level of Node and keeps the recursion as a pointer", () => {
    const schemas = schemasOf(
      { "entry.json": wrappedDocument() },
      "entry.json"
    );
    const wrapped = entryFor(schemas, "entry.json", WRAPPED_POINTER);
    expect(wrapped).toBeDefined();
    // The inlining shape the gateway fix depends on stays unchanged.
    expect(JSON.stringify(wrapped?.schema)).toContain(
      `"$ref":"${NODE_POINTER}"`
    );
  });

  it("registers Node under its own pointer when no usage site names it", () => {
    const schemas = schemasOf(
      { "entry.json": wrappedDocument() },
      "entry.json"
    );
    const node = entryFor(schemas, "entry.json", NODE_POINTER);
    expect(node).toBeDefined();
    expect(JSON.stringify(node?.schema)).toContain(`"$ref":"${NODE_POINTER}"`);
  });

  it("keys the Node entry exactly as the gateway's pointer lookup does", () => {
    const schemas = schemasOf(
      { "entry.json": wrappedDocument() },
      "entry.json"
    );
    const byPointer = new Set(
      Object.values(schemas).map(
        (schema) => `${schema.document_uri}${schema.source_pointer}`
      )
    );
    // `createContractSchemaLookup` serves the bare pointer form only when
    // exactly one document declares it, so one key must carry it.
    expect(byPointer.has(`entry.json${NODE_POINTER}`)).toBe(true);
  });

  it("registers a cross-file preserved target under its own document", () => {
    const shared = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Shared", version: "1.0.0" },
      components: {
        schemas: {
          // `Bundle` is the only shared schema the entry document names,
          // so `Tree` reaches the contract only through `Bundle`'s
          // inlined copy.
          Bundle: {
            type: "object",
            required: ["tree"],
            properties: {
              tree: { $ref: "#/components/schemas/Tree" }
            }
          },
          Tree: {
            type: "object",
            required: ["leaf"],
            properties: {
              leaf: { type: "boolean" },
              branch: { $ref: "#/components/schemas/Tree" }
            }
          }
        }
      }
    });
    const entry = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Entry", version: "1.0.0" },
      paths: {
        "/tree": {
          get: {
            operationId: "showTree",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "shared.yaml#/components/schemas/Bundle" }
                  }
                }
              }
            }
          }
        }
      }
    });
    const schemas = schemasOf(
      { "entry.yaml": entry, "shared.yaml": shared },
      "entry.yaml"
    );
    const tree = entryFor(schemas, "shared.yaml", "#/components/schemas/Tree");
    expect(tree).toBeDefined();
    // The self-reference inside the shared document keeps its pointer
    // form, so the entry above is the one the lookup must find through
    // the cross-file key `shared.yaml#/components/schemas/Tree`.
    expect(JSON.stringify(tree?.schema)).toContain(
      '"$ref":"#/components/schemas/Tree"'
    );
  });

  it("keeps compilation deterministic across repeated runs", () => {
    const first = schemasOf({ "entry.json": wrappedDocument() }, "entry.json");
    const second = schemasOf({ "entry.json": wrappedDocument() }, "entry.json");
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(second).toEqual(first);
  });

  it("registers a target reached through one preserved hop, not only cycles", () => {
    // `Outer` embeds `Node`; the walk of `Outer` preserves only the ref
    // that closes the cycle. Registering `Node` then discovers `Mid`,
    // because `Node`'s own normalized form preserves a ref to `Mid`.
    const document = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Chain", version: "1.0.0" },
      paths: {
        "/chain": {
          post: {
            operationId: "createChain",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Outer" }
                }
              }
            },
            responses: { "202": { description: "ok" } }
          }
        }
      },
      components: {
        schemas: {
          Outer: {
            type: "object",
            properties: { node: { $ref: NODE_POINTER } }
          },
          Node: {
            type: "object",
            properties: {
              next: {
                allOf: [{ $ref: "#/components/schemas/Mid" }]
              }
            }
          },
          Mid: {
            type: "object",
            properties: { back: { $ref: NODE_POINTER } }
          }
        }
      }
    });
    const schemas = schemasOf({ "chain.json": document }, "chain.json");
    expect(entryFor(schemas, "chain.json", NODE_POINTER)).toBeDefined();
    expect(
      entryFor(schemas, "chain.json", "#/components/schemas/Mid")
    ).toBeDefined();
  });

  it("leaves the registry entry count unchanged for a non-recursive ref", () => {
    const document = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Flat", version: "1.0.0" },
      paths: {
        "/flat": {
          get: {
            operationId: "showFlat",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Flat" }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          Flat: {
            type: "object",
            properties: { leaf: { type: "string" } }
          }
        }
      }
    });
    const schemas = schemasOf({ "flat.json": document }, "flat.json");
    expect(Object.values(schemas)).toHaveLength(1);
    expect(
      entryFor(schemas, "flat.json", "#/components/schemas/Flat")
    ).toBeDefined();
  });
});
