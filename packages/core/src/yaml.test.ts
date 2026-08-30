import { describe, expect, it } from "vitest";

import {
  parseBlockYaml,
  parseSafeYaml,
  type BlockYamlDialect,
  type BlockYamlFailure,
  type BlockYamlSituation
} from "./yaml.ts";
import type { Json } from "./json.ts";

/** Failure the test dialects throw; carries the raw engine situation. */
class DialectError extends Error {
  readonly situation: BlockYamlSituation;
  readonly line: number;

  constructor(failure: BlockYamlFailure) {
    super(failure.situation);
    this.name = "DialectError";
    this.situation = failure.situation;
    this.line = failure.line;
  }
}

/** Dialect that mirrors the pack manifest parser. */
const PACK_LIKE_DIALECT: BlockYamlDialect = {
  fail(failure) {
    throw new DialectError(failure);
  },
  skipDirectives: true,
  tabCheck: "split",
  flow: true,
  limits: null,
  extendedEscapes: true,
  blankIsContent: false,
  chompFormulation: "text",
  flowSkipsBreaks: true,
  flowKeyBreaksOnBracket: true
};

/** Dialect that mirrors the Arazzo workflow parser. */
const ARZZO_LIKE_DIALECT: BlockYamlDialect = {
  fail(failure) {
    throw new DialectError(failure);
  },
  skipDirectives: false,
  tabCheck: "read",
  flow: true,
  limits: { maxNodes: 50_000, maxDepth: 32 },
  extendedEscapes: false,
  blankIsContent: true,
  chompFormulation: "body",
  flowSkipsBreaks: false,
  flowKeyBreaksOnBracket: false
};

function parseWith(dialect: BlockYamlDialect, text: string): Json {
  return parseBlockYaml(text, dialect);
}

function situationOf(dialect: BlockYamlDialect, text: string): DialectError {
  try {
    parseWith(dialect, text);
  } catch (caught) {
    if (caught instanceof DialectError) {
      return caught;
    }
    throw caught;
  }
  throw new Error(`Expected a failure for: ${text}`);
}

describe("flow-collection separators in the pack dialect", () => {
  it("skips spaces between a trailing separator and the closer", () => {
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1, 2, ]")).toEqual({ a: [1, 2] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1, 2, 3, ]")).toEqual({
      a: [1, 2, 3]
    });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {x: 1, }")).toEqual({
      a: { x: 1 }
    });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {p: 1, q: 2, r: 3, }")).toEqual({
      a: { p: 1, q: 2, r: 3 }
    });
  });

  it("skips CR between a trailing separator and the closer", () => {
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1,\r]")).toEqual({ a: [1] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1 ,\r]")).toEqual({ a: [1] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {x: 1,\r}")).toEqual({
      a: { x: 1 }
    });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {x: 1 ,\r}")).toEqual({
      a: { x: 1 }
    });
  });

  it("skips CR around separators inside the collection", () => {
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1,\r 2,\r ]")).toEqual({
      a: [1, 2]
    });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1,\r2,\r]")).toEqual({
      a: [1, 2]
    });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {x: 1,\r y: 2,\r}")).toEqual({
      a: { x: 1, y: 2 }
    });
    expect(parseWith(PACK_LIKE_DIALECT, 'a: ["x",\r"y"]')).toEqual({
      a: ["x", "y"]
    });
  });

  it("keeps the historical degenerate-flow results", () => {
    expect(parseWith(PACK_LIKE_DIALECT, "a: []")).toEqual({ a: [] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: {}")).toEqual({ a: {} });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [,]")).toEqual({ a: [null] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [ , ]")).toEqual({ a: [null] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1,,2]")).toEqual({
      a: [1, null, 2]
    });
    expect(situationOf(PACK_LIKE_DIALECT, "a: {,}").situation).toBe(
      "flow-empty-key"
    );
    expect(situationOf(PACK_LIKE_DIALECT, "a: {x: 1,, y: 2}").situation).toBe(
      "flow-empty-key"
    );
  });

  it("parses nested flow collections with separators", () => {
    expect(
      parseWith(PACK_LIKE_DIALECT, "a: [1, [2, {b: [3]}], {c: {d: 4}}]")
    ).toEqual({ a: [1, [2, { b: [3] }], { c: { d: 4 } }] });
    expect(
      parseWith(PACK_LIKE_DIALECT, "a: [{x: 1, y: [2, 3]}, {z: 4 }]")
    ).toEqual({ a: [{ x: 1, y: [2, 3] }, { z: 4 }] });
    expect(parseWith(PACK_LIKE_DIALECT, "a: [1, 2] # c")).toEqual({
      a: [1, 2]
    });
  });
});

describe("folded block scalars in the line-based engine", () => {
  it("keeps the characters of a more-indented continuation line", () => {
    // A continuation indented past the first content line keeps its
    // extra indent as content; nothing is sliced away.
    const text = [
      "postconditions:",
      "  - id: check",
      "    expression: >-",
      "      report.evidence_captured == true &&",
      '      (report.evidence_kind == "screenshot" ||',
      '       report.evidence_kind == "scrape")'
    ].join("\n");
    const value = parseWith(PACK_LIKE_DIALECT, text) as {
      postconditions: Array<{ expression: string }>;
    };
    expect(value.postconditions[0]?.expression).toBe(
      "report.evidence_captured == true && " +
        '(report.evidence_kind == "screenshot" ||  ' +
        'report.evidence_kind == "scrape")'
    );
  });
});

describe("multi-line plain scalars in the document engine", () => {
  it("folds a value that starts on the line after its key", () => {
    // Shape of examples/e2b.yaml: the key sits at one indent and every
    // continuation line of the plain scalar sits at the next indent.
    const text = [
      "properties:",
      "  snapshotID:",
      "    type: string",
      "    description:",
      "      Identifier of the snapshot template including the tag. Uses",
      "      namespace/alias when a name was provided, otherwise falls",
      "      back to the raw template ID."
    ].join("\n");
    expect(parseSafeYaml(text)).toEqual({
      properties: {
        snapshotID: {
          type: "string",
          description:
            "Identifier of the snapshot template including the tag. Uses " +
            "namespace/alias when a name was provided, otherwise falls " +
            "back to the raw template ID."
        }
      }
    });
  });

  it("stops the fold at a line indented like an outer key", () => {
    const text = [
      "schema:",
      "  description:",
      "    first continued",
      "    second continued",
      "  type: string"
    ].join("\n");
    expect(parseSafeYaml(text)).toEqual({
      schema: {
        description: "first continued second continued",
        type: "string"
      }
    });
  });

  it("keeps a deeper-indented continuation inside the scalar", () => {
    const text = ["a:", "  one two", "    three four"].join("\n");
    expect(parseSafeYaml(text)).toEqual({ a: "one two three four" });
  });
});

describe("flow-collection separators in the arazzo dialect", () => {
  it("skips spaces between a trailing separator and the closer", () => {
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [1, 2, ]")).toEqual({
      a: [1, 2]
    });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [1, 2, 3, ]")).toEqual({
      a: [1, 2, 3]
    });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: {x: 1, }")).toEqual({
      a: { x: 1 }
    });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: {p: 1, q: 2, r: 3, }")).toEqual({
      a: { p: 1, q: 2, r: 3 }
    });
  });

  it("keeps CR significant after a trailing separator", () => {
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [1,\r]")).toEqual({
      a: [1, null]
    });
    expect(situationOf(ARZZO_LIKE_DIALECT, "a: {x: 1,\r}").situation).toBe(
      "flow-empty-key"
    );
  });

  it("keeps CR significant between flow items", () => {
    expect(parseWith(ARZZO_LIKE_DIALECT, 'a: ["x",\r"y"]')).toEqual({
      a: ["x", '"y"']
    });
  });

  it("keeps the historical degenerate-flow results", () => {
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: []")).toEqual({ a: [] });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: {}")).toEqual({ a: {} });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [,]")).toEqual({ a: [null] });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [ , ]")).toEqual({ a: [null] });
    expect(parseWith(ARZZO_LIKE_DIALECT, "a: [1,,2]")).toEqual({
      a: [1, null, 2]
    });
    expect(situationOf(ARZZO_LIKE_DIALECT, "a: {,}").situation).toBe(
      "flow-empty-key"
    );
    expect(situationOf(ARZZO_LIKE_DIALECT, "a: {x: 1,, y: 2}").situation).toBe(
      "flow-empty-key"
    );
  });
});
