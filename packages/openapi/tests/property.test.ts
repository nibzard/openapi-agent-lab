/**
 * Property tests for the compiler's critical parser paths (specification
 * sections 13 and 31.1). A seeded sfc32 PRNG written in this file drives
 * bounded random documents. Every property asserts that the compiler
 * either succeeds or fails with a documented OAL-* diagnostic: never an
 * uncaught crash, a hang, or runaway memory use. The seeds are fixed
 * constants, so any failure reproduces on every run.
 */

import { describe, expect, it } from "vitest";

import { OalError, isToolName } from "@oal/core";

import { compileOpenApi } from "../src/index.ts";
import type { CompilerLimits } from "../src/limits.ts";

const ITERATIONS = 300;
/** No single compile may take longer than this; limits must not hang. */
const PER_ITERATION_BUDGET_MS = 2000;

/** Deterministic sfc32 generator built from four fixed seed words. */
function sfc32(
  seedA: number,
  seedB: number,
  seedC: number,
  seedD: number
): () => number {
  let a = seedA >>> 0;
  let b = seedB >>> 0;
  let c = seedC >>> 0;
  let d = seedD >>> 0;
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const sum = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + ((c << 3) | 0)) | 0;
    c = (c << 21) | (c >>> 11) | 0;
    c = (c + sum) | 0;
    return (sum >>> 0) / 4294967296;
  };
}

/** Derives an independent PRNG stream from a fixed property label. */
class Random {
  private readonly nextFloat: () => number;

  constructor(label: string) {
    let hash = 0x811c9dc5;
    for (const character of label) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    }
    this.nextFloat = sfc32(
      0x1a2b3c4d ^ hash,
      0x9e3779b9,
      0x243f6a88,
      0xb7e15162
    );
    // Discard the first values so nearby labels stay independent.
    for (let index = 0; index < 16; index += 1) {
      this.nextFloat();
    }
  }

  float(): number {
    return this.nextFloat();
  }

  int(minimum: number, maximum: number): number {
    return minimum + Math.floor(this.float() * (maximum - minimum + 1));
  }

  below(count: number): number {
    return Math.floor(this.float() * count);
  }

  bool(): boolean {
    return this.float() < 0.5;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)] as T;
  }
}

interface Outcome {
  compiled: boolean;
  /** Diagnostic code of the OalError, or null. */
  code: string | null;
  exitCode: number | null;
  /** A thrown value that is not an OalError; every property forbids it. */
  unexpected: unknown;
  elapsedMs: number;
}

function tryCompile(
  documents: Record<string, string>,
  entrypoint: string,
  limits?: Partial<CompilerLimits>
): Outcome {
  const began = Date.now();
  try {
    compileOpenApi(
      { documents, entrypoint },
      limits === undefined ? undefined : { limits }
    );
    return {
      compiled: true,
      code: null,
      exitCode: null,
      unexpected: null,
      elapsedMs: Date.now() - began
    };
  } catch (error) {
    const elapsedMs = Date.now() - began;
    if (error instanceof OalError) {
      return {
        compiled: false,
        code: error.code,
        exitCode: error.exitCode,
        unexpected: null,
        elapsedMs
      };
    }
    return {
      compiled: false,
      code: null,
      exitCode: null,
      unexpected: error,
      elapsedMs
    };
  }
}

/** Every rejection must carry a documented diagnostic code and exit. */
function expectDocumentedOutcome(outcome: Outcome): void {
  expect(outcome.unexpected).toBeNull();
  expect(outcome.elapsedMs).toBeLessThan(PER_ITERATION_BUDGET_MS);
  if (!outcome.compiled) {
    expect(outcome.code).toMatch(/^OAL-/);
    expect(outcome.exitCode === 2 || outcome.exitCode === 4).toBe(true);
  }
}

const BASE_DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Property probe", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thing" }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Thing: { type: "object", properties: { name: { type: "string" } } },
      Other: { type: "string" }
    }
  }
};

const BASE_JSON = JSON.stringify(BASE_DOCUMENT);
const BASE_YAML = [
  "openapi: 3.1.0",
  "info:",
  "  title: Property probe",
  '  version: "1.0.0"',
  "paths:",
  "  /things:",
  "    get:",
  "      operationId: listThings",
  "      responses:",
  '        "200":',
  "          description: ok",
  "          content:",
  "            application/json:",
  "              schema:",
  '                $ref: "#/components/schemas/Thing"',
  "components:",
  "  schemas:",
  "    Thing:",
  "      type: object",
  "    Other:",
  "      type: string",
  ""
].join("\n");

describe("property: arbitrary bytes never crash the compiler", () => {
  const NOISE = [
    '"',
    "'",
    "{",
    "}",
    "[",
    "]",
    ":",
    ",",
    "\\",
    "\n",
    "\t",
    "\r",
    " ",
    "0",
    "-",
    "é",
    "😀",
    "%"
  ];

  function flipBits(random: Random, text: string): string {
    const at = random.below(text.length);
    const flipped = String.fromCharCode(
      text.charCodeAt(at) ^ (1 << random.int(0, 7))
    );
    return text.slice(0, at) + flipped + text.slice(at + 1);
  }

  function truncate(random: Random, text: string): string {
    return text.slice(0, random.below(text.length + 1));
  }

  function spliceNoise(random: Random, text: string): string {
    let mutated = text;
    for (let round = 0; round < random.int(1, 8); round += 1) {
      const at = random.below(mutated.length + 1);
      if (random.bool()) {
        mutated = mutated.slice(0, at) + random.pick(NOISE) + mutated.slice(at);
      } else {
        const removed = random.int(1, 12);
        mutated = mutated.slice(0, at) + mutated.slice(at + removed);
      }
    }
    return mutated;
  }

  /** A deeply nested value at or beyond the traversal limit. */
  function deeplyNested(random: Random): { entrypoint: string; text: string } {
    const depth = random.int(1, 1500);
    const asJson = random.bool();
    let nested = "";
    for (let level = 0; level < depth; level += 1) {
      nested += asJson ? '{"a":' : "{a: ";
    }
    nested += `1${"}".repeat(depth)}`;
    if (asJson) {
      const key = random.bool() ? "x-deep" : "components";
      const text =
        key === "x-deep"
          ? `{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{},"x-deep":${nested}}`
          : `{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{},"components":{"schemas":{"Deep":${nested}}}}`;
      return { entrypoint: "entry.json", text };
    }
    const text = `openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\nw: ${nested}\n`;
    return { entrypoint: "entry.yaml", text };
  }

  it("compiles or documents every mutation", () => {
    const random = new Random("parse-arbitrary-bytes");
    let compiled = 0;
    let rejected = 0;
    for (let index = 0; index < ITERATIONS; index += 1) {
      const kind = index % 5;
      let entrypoint = "entry.json";
      let text: string;
      if (kind === 4) {
        const nested = deeplyNested(random);
        entrypoint = nested.entrypoint;
        text = nested.text;
      } else {
        const base = random.bool() ? BASE_JSON : BASE_YAML;
        entrypoint = base === BASE_JSON ? "entry.json" : "entry.yaml";
        text =
          kind === 0
            ? flipBits(random, base)
            : kind === 1
              ? truncate(random, base)
              : spliceNoise(random, base);
      }
      const outcome = tryCompile({ [entrypoint]: text }, entrypoint);
      expectDocumentedOutcome(outcome);
      if (outcome.compiled) {
        compiled += 1;
      } else {
        rejected += 1;
      }
    }
    // The generators must exercise both sides of the property.
    expect(compiled).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe("property: references resolve safely or reject with a diagnostic", () => {
  const LOCAL_REFS = [
    "#/components/schemas/Thing",
    "#/components/schemas/Other",
    "#/components/schemas/Missing",
    "#/paths/~1things/get",
    "#/info/title"
  ];

  const REMOTE_REFS = [
    "http://example.invalid/pet.json",
    "https://cdn.example.invalid/pet.yaml#/x",
    "//cdn.example.invalid/pet.json",
    "urn:example:thing"
  ];

  const ESCAPING_REFS = [
    "../outside.yaml",
    "../../outside.yaml",
    "nested/../../outside.yaml",
    "..\\windows-escape.yaml",
    "%2e%2e/outside.json",
    "sub/../../../outside.yaml"
  ];

  const PACK_REFS = [
    "pack.yaml",
    "pack.yaml#/components/schemas/Thing",
    "pack.yaml#/components/schemas/Missing"
  ];

  function documentWithRef(ref: string): string {
    return JSON.stringify({
      ...BASE_DOCUMENT,
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
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

  const PACK_DOCUMENT = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Pack companion", version: "1.0.0" },
    paths: {},
    components: { schemas: { Thing: { type: "object" } } }
  });

  /** A chain of component schemas that ends somewhere chosen by family. */
  function chainDocument(
    length: number,
    ending: "target" | "missing" | "loop"
  ): string {
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < length; index += 1) {
      schemas[`Link${index}`] = {
        $ref: `#/components/schemas/Link${index + 1}`
      };
    }
    if (ending === "target") {
      schemas[`Link${length}`] = { type: "object" };
    } else if (ending === "missing") {
      schemas[`Link${length}`] = { $ref: "#/components/schemas/Absent" };
    } else {
      schemas[`Link${length}`] = { $ref: "#/components/schemas/Link0" };
    }
    return JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Chain probe", version: "1.0.0" },
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Link0" }
                  }
                }
              }
            }
          }
        }
      },
      components: { schemas }
    });
  }

  it("resolves or documents local, pack, and chained references", () => {
    const random = new Random("reference-resolution");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const family = index % 3;
      if (family === 0) {
        const ref = random.pick(LOCAL_REFS);
        const outcome = tryCompile(
          { "entry.json": documentWithRef(ref) },
          "entry.json"
        );
        expectDocumentedOutcome(outcome);
        if (!outcome.compiled) {
          expect(outcome.code).toBe("OAL-REF-NOT-FOUND");
        }
      } else if (family === 1) {
        const ref = random.pick(PACK_REFS);
        const includePack = random.bool();
        const documents: Record<string, string> = {
          "entry.json": documentWithRef(ref)
        };
        if (includePack) {
          documents["pack.yaml"] = PACK_DOCUMENT;
        }
        const outcome = tryCompile(documents, "entry.json");
        expectDocumentedOutcome(outcome);
        if (!outcome.compiled) {
          expect(outcome.code).toBe("OAL-REF-NOT-FOUND");
        }
      } else {
        const ending = random.pick(["target", "missing", "loop"] as const);
        const length = random.int(1, 80);
        const outcome = tryCompile(
          { "entry.json": chainDocument(length, ending) },
          "entry.json"
        );
        expectDocumentedOutcome(outcome);
        if (!outcome.compiled) {
          expect([
            "OAL-REF-NOT-FOUND",
            "OAL-REF-CYCLE-UNSUPPORTED",
            "OAL-REF-LIMIT"
          ]).toContain(outcome.code);
        }
      }
    }
  });

  it("always rejects remote references", () => {
    const random = new Random("remote-references");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const ref = random.pick(REMOTE_REFS);
      const outcome = tryCompile(
        { "entry.json": documentWithRef(ref) },
        "entry.json"
      );
      expectDocumentedOutcome(outcome);
      expect(outcome.compiled).toBe(false);
      expect(outcome.code).toBe("OAL-REF-REMOTE-DISABLED");
    }
  });

  it("always rejects references that escape the pack root", () => {
    const random = new Random("escaping-references");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const ref = random.pick(ESCAPING_REFS);
      const outcome = tryCompile(
        { "entry.json": documentWithRef(ref) },
        "entry.json"
      );
      expectDocumentedOutcome(outcome);
      expect(outcome.compiled).toBe(false);
      expect(["OAL-REF-OUTSIDE-ROOT", "OAL-REF-NOT-FOUND"]).toContain(
        outcome.code
      );
    }
  });
});

describe("property: route keys are unique and stably ordered", () => {
  const LITERALS = ["a", "b", "items", "v1", "x-y", "things"] as const;
  const PARAMETERS = ["id", "name", "code"] as const;
  const METHODS = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace"
  ] as const;

  interface GeneratedPath {
    template: string;
    method: string;
    parameterNames: string[];
  }

  function generatePaths(random: Random): GeneratedPath[] {
    const paths: GeneratedPath[] = [];
    const count = random.int(1, 6);
    for (let index = 0; index < count; index += 1) {
      const segments: string[] = [];
      const parameterNames: string[] = [];
      const width = random.int(1, 3);
      for (let position = 0; position < width; position += 1) {
        const name = random.pick(PARAMETERS);
        if (random.bool() && !parameterNames.includes(name)) {
          segments.push(`{${name}}`);
          parameterNames.push(name);
        } else {
          segments.push(random.pick(LITERALS));
        }
      }
      paths.push({
        template: `/${segments.join("/")}`,
        method: random.pick(METHODS),
        parameterNames
      });
    }
    return paths;
  }

  function buildDocument(
    paths: readonly GeneratedPath[],
    sharedOperationId: boolean
  ): { text: string; entrypoint: string; expectedKeys: string[] } {
    const pathItems: Record<string, Record<string, unknown>> = {};
    const expected = new Set<string>();
    for (const path of paths) {
      const parameters = path.parameterNames.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" }
      }));
      const item = pathItems[path.template] ?? {};
      pathItems[path.template] = item;
      if (item[path.method] === undefined) {
        expected.add(`path:${path.method.toUpperCase()} ${path.template}`);
      }
      item[path.method] = {
        operationId: sharedOperationId
          ? "doThing"
          : `op${path.template.length}${path.method}`,
        ...(parameters.length > 0 ? { parameters } : {}),
        responses: { "200": { description: "ok" } }
      };
    }
    return {
      entrypoint: "entry.json",
      expectedKeys: [...expected].sort(),
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Route probe", version: "1.0.0" },
        paths: pathItems
      })
    };
  }

  it("keeps canonical keys unique, ordered, and reproducible", () => {
    const random = new Random("route-keys");
    let compiled = 0;
    let ambiguous = 0;
    for (let index = 0; index < ITERATIONS; index += 1) {
      const paths = generatePaths(random);
      const document = buildDocument(paths, random.bool());
      const documents = { [document.entrypoint]: document.text };
      const first = tryCompile(documents, document.entrypoint);
      expectDocumentedOutcome(first);
      if (!first.compiled) {
        expect([
          "OAL-OAS-ROUTE-AMBIGUOUS",
          "OAL-OAS-PATH-PARAMETER-MISSING"
        ]).toContain(first.code);
        ambiguous += 1;
        continue;
      }
      compiled += 1;
      // Recompiling the same document set is byte-identical.
      const again = compileOpenApi({
        documents,
        entrypoint: document.entrypoint
      }).contract;
      const contract = compileOpenApi({
        documents,
        entrypoint: document.entrypoint
      }).contract;
      expect(JSON.stringify(again)).toBe(JSON.stringify(contract));

      const keys = contract.operations.map((operation) => operation.key);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
      expect([...keys].sort()).toEqual(keys);
      expect([...unique].sort()).toEqual(document.expectedKeys);
      for (const operation of contract.operations) {
        expect(operation.uid).toMatch(/^op_[0-9a-f]{12}$/);
      }
      // Tool names stay unique and inside the documented grammar;
      // collisions are broken by a six-character UID suffix.
      const toolNames = [
        ...contract.operations,
        ...contract.webhooks.flatMap((webhook) => webhook.operations)
      ].map((operation) => operation.tool_name);
      expect(new Set(toolNames).size).toBe(toolNames.length);
      for (const name of toolNames) {
        expect(isToolName(name)).toBe(true);
      }
      const suffixed = toolNames.filter((name) => /_[0-9a-f]{6}$/.test(name));
      for (const name of suffixed) {
        const stem = name.slice(0, -7);
        const sharing = toolNames.filter((other) => other.startsWith(stem));
        // A suffix only appears when the stem collided with another name.
        expect(sharing.length).toBeGreaterThan(1);
      }
    }
    expect(compiled).toBeGreaterThan(0);
    expect(ambiguous).toBeGreaterThan(0);
  });
});

describe("property: limits are enforced with documented codes", () => {
  const HEAD = `{"openapi":"3.1.0","info":{"title":"t","version":"1"},`;
  const TAIL = "}";

  function wideJsonDocument(properties: number): string {
    let body = "";
    for (let index = 0; index < properties; index += 1) {
      body += `"k${index}":${index},`;
    }
    return `${HEAD}"paths":{},"w":{${body}0}${TAIL}`;
  }

  function manyOperations(count: number): string {
    let items = "";
    for (let index = 0; index < count; index += 1) {
      items += `"/p${index}":{"get":{"responses":{"200":{"description":"ok"}}}},`;
    }
    return `${HEAD}"paths":{${items.slice(0, -1)}}${TAIL}`;
  }

  it("rejects oversized sources with OAL-INPUT-TOO-LARGE", () => {
    const random = new Random("limit-source-bytes");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const limit = random.int(64, 256);
      const pad = "x".repeat(random.int(1, 400));
      const outcome = tryCompile(
        { "entry.json": `${HEAD}"paths":{},"pad":"${pad}"${TAIL}` },
        "entry.json",
        { maxSourceOpenapiBytes: limit }
      );
      expectDocumentedOutcome(outcome);
      if (outcome.compiled) {
        expect(outcome.elapsedMs).toBeLessThan(PER_ITERATION_BUDGET_MS);
      } else {
        expect(outcome.code).toBe("OAL-INPUT-TOO-LARGE");
      }
    }
  });

  it("bounds parsed node counts in both formats", () => {
    const random = new Random("limit-parsed-nodes");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const limit = random.int(20, 120);
      const width = random.int(5, 400);
      if (random.bool()) {
        const outcome = tryCompile(
          { "entry.json": wideJsonDocument(width) },
          "entry.json",
          { maxParsedNodes: limit }
        );
        expectDocumentedOutcome(outcome);
        if (!outcome.compiled) {
          expect(["OAL-JSON-INVALID", "OAL-INPUT-TOO-LARGE"]).toContain(
            outcome.code
          );
        }
        continue;
      }
      let list = "";
      for (let item = 0; item < width; item += 1) {
        list += `${item},`;
      }
      const outcome = tryCompile(
        {
          "entry.yaml": `openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\nw: [${list}0]\n`
        },
        "entry.yaml",
        { maxParsedNodes: limit }
      );
      expectDocumentedOutcome(outcome);
      if (!outcome.compiled) {
        expect([
          "OAL-YAML-NODE-LIMIT",
          "OAL-YAML-ALIAS-LIMIT",
          "OAL-INPUT-TOO-LARGE"
        ]).toContain(outcome.code);
      }
    }
  });

  it("bounds YAML nesting depth", () => {
    const random = new Random("limit-yaml-depth");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const depth = random.int(1, 400);
      let nested = "";
      for (let level = 0; level < depth; level += 1) {
        nested += "{a: ";
      }
      nested += `1${"}".repeat(depth)}`;
      const outcome = tryCompile(
        {
          "entry.yaml": `openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\nw: ${nested}\n`
        },
        "entry.yaml",
        { maxTraversalDepth: random.int(4, 64) }
      );
      expectDocumentedOutcome(outcome);
      if (!outcome.compiled) {
        expect([
          "OAL-YAML-DEPTH-LIMIT",
          "OAL-YAML-NODE-LIMIT",
          "OAL-INPUT-TOO-LARGE"
        ]).toContain(outcome.code);
      }
    }
  });

  it("bounds the operation count with OAL-LIMIT-REACHED", () => {
    const random = new Random("limit-operations");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const limit = random.int(1, 4);
      const count = random.int(1, 8);
      const outcome = tryCompile(
        { "entry.json": manyOperations(count) },
        "entry.json",
        { maxOperations: limit }
      );
      expectDocumentedOutcome(outcome);
      if (!outcome.compiled) {
        expect(outcome.code).toBe("OAL-LIMIT-REACHED");
      }
    }
  });

  it("bounds single examples with OAL-INPUT-TOO-LARGE", () => {
    const random = new Random("limit-example-bytes");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const limit = random.int(16, 128);
      const size = random.int(4, 400);
      const example = `{"note":"${"e".repeat(size)}"}`;
      const document = `${HEAD}"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"examples":{"big":{"value":${example}}}}}}}}}}${TAIL}`;
      const outcome = tryCompile({ "entry.json": document }, "entry.json", {
        maxOneExampleBytes: limit
      });
      expectDocumentedOutcome(outcome);
      if (!outcome.compiled) {
        expect(outcome.code).toBe("OAL-INPUT-TOO-LARGE");
      }
    }
  });

  it("bounds reference traversal depth with OAL-REF-LIMIT", () => {
    const random = new Random("limit-ref-depth");
    for (let index = 0; index < ITERATIONS; index += 1) {
      const length = random.int(1, 200);
      const schemas: Record<string, unknown> = {};
      for (let link = 0; link < length; link += 1) {
        schemas[`Link${link}`] = {
          $ref: `#/components/schemas/Link${link + 1}`
        };
      }
      schemas[`Link${length}`] = { type: "object" };
      const document = `${HEAD}"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Link0"}}}}}}}},"components":{"schemas":${JSON.stringify(schemas)}}${TAIL}`;
      const outcome = tryCompile({ "entry.json": document }, "entry.json", {
        maxTraversalDepth: random.int(4, 64)
      });
      expectDocumentedOutcome(outcome);
      if (!outcome.compiled) {
        expect(outcome.code).toBe("OAL-REF-LIMIT");
      }
    }
  });
});
