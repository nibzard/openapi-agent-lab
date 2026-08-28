import { describe, expect, it } from "vitest";

import {
  parseBlockYaml,
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
