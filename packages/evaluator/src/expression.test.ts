import { describe, expect, it } from "vitest";

import type { Json, JsonObject } from "@oal/core";
import {
  DEFAULT_EXPRESSION_LIMITS,
  ExpressionError,
  compileExpression,
  evaluateExpression,
  evaluatePredicate,
  parseExpression
} from "./expression.ts";

function errorOf(source: string): ExpressionError {
  return errorOfLimits(source, {});
}

function errorOfLimits(
  source: string,
  limits: Partial<typeof DEFAULT_EXPRESSION_LIMITS>
): ExpressionError {
  try {
    compileExpression(source, { ...DEFAULT_EXPRESSION_LIMITS, ...limits });
  } catch (error: unknown) {
    if (error instanceof ExpressionError) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expression ${source} compiled without an error.`);
}

function thrownCode(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ExpressionError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The action completed without an error.");
}

/** Compile and evaluate, then return the typed failure. */
function evalErrorOf(
  source: string,
  scope: JsonObject = SCOPE
): ExpressionError {
  try {
    evaluateExpression(source, scope);
  } catch (error: unknown) {
    if (error instanceof ExpressionError) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expression ${source} evaluated without an error.`);
}

const SCOPE: JsonObject = {
  a: { b: { c: 7 }, k: "v", list: [10, 20, 30] },
  n: 4,
  text: "steel",
  flag: true,
  empty: {}
};

describe("expression literals and operators", () => {
  it("evaluates arithmetic with multiplication precedence", () => {
    expect(evaluateExpression("1 + 2 * 3", {})).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3", {})).toBe(9);
    expect(evaluateExpression("10 / 4", {})).toBe(2.5);
    expect(evaluateExpression("2.5 * 2", {})).toBe(5);
    expect(evaluateExpression("1e2 + 1", {})).toBe(101);
    expect(evaluateExpression("-5 + 3", {})).toBe(-2);
    expect(evaluateExpression("2 - -2", {})).toBe(4);
  });

  it("concatenates strings and compares them", () => {
    expect(evaluateExpression('"a" + "b"', {})).toBe("ab");
    expect(evaluateExpression('"steel" == "steel"', {})).toBe(true);
    expect(evaluateExpression('"a" < "b"', {})).toBe(true);
    expect(evaluateExpression('"b" >= "c"', {})).toBe(false);
  });

  it("compares numbers with every relation operator", () => {
    expect(evaluateExpression("1 < 2", {})).toBe(true);
    expect(evaluateExpression("2 <= 2", {})).toBe(true);
    expect(evaluateExpression("3 > 2", {})).toBe(true);
    expect(evaluateExpression("2 >= 3", {})).toBe(false);
    expect(evaluateExpression("1 + 2 < 4 == true", {})).toBe(true);
  });

  it("applies boolean precedence and short-circuiting", () => {
    expect(evaluateExpression("!false && true", {})).toBe(true);
    expect(evaluateExpression("true || false && false", {})).toBe(true);
    expect(evaluateExpression("(true || false) && false", {})).toBe(false);
    expect(evaluateExpression("false && 1 / 0 > 0", {})).toBe(false);
    expect(evaluateExpression("true || 1 / 0 > 0", {})).toBe(true);
  });

  it("compares values deeply for equality", () => {
    expect(evaluateExpression("[1, 2] == [1, 2]", {})).toBe(true);
    expect(evaluateExpression("[1, 2] != [1, 3]", {})).toBe(true);
    expect(evaluateExpression('1 == "1"', {})).toBe(false);
    expect(evaluateExpression("null == null", {})).toBe(true);
    expect(evaluateExpression("null != 0", {})).toBe(true);
  });

  it("supports membership in arrays and objects", () => {
    expect(evaluateExpression("2 in [1, 2, 3]", {})).toBe(true);
    expect(evaluateExpression("5 in [1, 2, 3]", {})).toBe(false);
    expect(evaluateExpression('"k" in a', SCOPE)).toBe(true);
    expect(evaluateExpression('"z" in a', SCOPE)).toBe(false);
    expect(evaluateExpression("n in [4, 5]", SCOPE)).toBe(true);
  });

  it("evaluates string escape sequences", () => {
    expect(evaluateExpression('"a\\nb"', {})).toBe("a\nb");
    expect(evaluateExpression('"a\\tb"', {})).toBe("a\tb");
    expect(evaluateExpression('"a\\\\b"', {})).toBe("a\\b");
    expect(evaluateExpression('"\\u0041"', {})).toBe("A");
    expect(evaluateExpression("'single'", {})).toBe("single");
  });
});

describe("expression paths and missing values", () => {
  it("reads nested properties", () => {
    expect(evaluateExpression("a.b.c", SCOPE)).toBe(7);
    expect(evaluateExpression("a.k", SCOPE)).toBe("v");
    expect(evaluateExpression("n + a.b.c", SCOPE)).toBe(11);
  });

  it("treats a missing property as null", () => {
    expect(evaluateExpression("a.missing", SCOPE)).toBe(null);
    expect(evaluateExpression("a.b.missing.deeper", SCOPE)).toBe(null);
    expect(evaluateExpression("missing == null", SCOPE)).toBe(true);
    expect(evaluateExpression('a.missing != "v"', SCOPE)).toBe(true);
  });

  it("reads array and object indexes", () => {
    expect(evaluateExpression("a.list[0]", SCOPE)).toBe(10);
    expect(evaluateExpression("a.list[2]", SCOPE)).toBe(30);
    expect(evaluateExpression('a["k"]', SCOPE)).toBe("v");
    expect(evaluateExpression("a.list[a.b.c - 6]", SCOPE)).toBe(20);
  });

  it("treats an out-of-range or wrong-type index as null", () => {
    expect(evaluateExpression("a.list[3]", SCOPE)).toBe(null);
    expect(evaluateExpression("a.list[-1]", SCOPE)).toBe(null);
    expect(evaluateExpression("a.list[1.5]", SCOPE)).toBe(null);
    expect(evaluateExpression('a.list["0"]', SCOPE)).toBe(null);
    expect(evaluateExpression("a[0]", SCOPE)).toBe(null);
    expect(evaluateExpression("empty[0]", SCOPE)).toBe(null);
  });
});

describe("expression type errors", () => {
  it("rejects arithmetic across types", () => {
    expect(evalErrorOf('1 + "a"').code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf('"a" - "b"').code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf('1 < "a"').code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf("true + true").code).toBe("OAL-EXPRESSION-TYPE");
  });

  it("rejects non-boolean logical operands", () => {
    expect(evalErrorOf("true && 1").code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf("1 || false").code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf("!1").code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf('-"a"').code).toBe("OAL-EXPRESSION-TYPE");
  });

  it("rejects division by zero and non-finite results", () => {
    expect(evalErrorOf("1 / 0").code).toBe("OAL-EXPRESSION-DIVISION");
    expect(evalErrorOf("1e308 * 1e308").code).toBe("OAL-EXPRESSION-TYPE");
  });

  it("rejects membership in a scalar", () => {
    expect(evalErrorOf("1 in 2").code).toBe("OAL-EXPRESSION-TYPE");
    expect(evalErrorOf('"a" in "abc"').code).toBe("OAL-EXPRESSION-TYPE");
  });

  it("rejects a predicate that does not return a boolean", () => {
    expect(thrownCode(() => evaluatePredicate("n + 1", SCOPE))).toBe(
      "OAL-EXPRESSION-NOT-BOOLEAN"
    );
    expect(() => evaluatePredicate("n + 1", SCOPE)).toThrow(ExpressionError);
    expect(evaluatePredicate("n < 5", SCOPE)).toBe(true);
  });
});

describe("expression forbidden syntax", () => {
  it("rejects host globals at the root of a path", () => {
    expect(errorOf("process.env.HOME").code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf("globalThis").code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf("Date.now()").code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf("Math.random()").code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf('require("fs")').code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf("this").code).toBe("OAL-EXPRESSION-FORBIDDEN");
  });

  it("rejects function calls", () => {
    expect(errorOf("size(a.list)").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a.list.size()").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("events.exists(e, true)").code).toBe(
      "OAL-EXPRESSION-SYNTAX"
    );
    expect(errorOf('eval("1 + 1")').code).toBe("OAL-EXPRESSION-FORBIDDEN");
  });

  it("rejects template literals, arrows, spread, and assignment", () => {
    expect(errorOf("`template`").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a => a").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("[...a.list]").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a = 1").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a += 1").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a?.b").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("typeof a").code).toBe("OAL-EXPRESSION-FORBIDDEN");
    expect(errorOf("new Date()").code).toBe("OAL-EXPRESSION-FORBIDDEN");
  });

  it("rejects unsupported operators and incomplete input", () => {
    expect(errorOf("5 % 2").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("1 ? 2 : 3").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("a.b.").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("(1 + 2").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("1 +").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("1 2").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf("").code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf('"unterminated').code).toBe("OAL-EXPRESSION-SYNTAX");
    expect(errorOf('"bad \\q escape"').code).toBe("OAL-EXPRESSION-SYNTAX");
  });
});

describe("expression resource limits", () => {
  it("rejects a source longer than the limit", () => {
    const source = "1 + ".repeat(2000) + "1";
    expect(source.length).toBeGreaterThan(
      DEFAULT_EXPRESSION_LIMITS.maxSourceLength
    );
    expect(errorOf(source).code).toBe("OAL-EXPRESSION-LENGTH");
  });

  it("rejects nesting deeper than the limit", () => {
    const source = `${"(".repeat(12)}1${")".repeat(12)}`;
    const error = errorOfLimits(source, { maxDepth: 8 });
    expect(error.code).toBe("OAL-EXPRESSION-DEPTH");
  });

  it("rejects evaluation that runs too many steps", () => {
    const compiled = compileExpression("1 + 1", {
      ...DEFAULT_EXPRESSION_LIMITS,
      maxSteps: 1
    });
    expect(() => compiled.evaluate({})).toThrow(ExpressionError);
    expect(thrownCode(() => compiled.evaluate({}))).toBe(
      "OAL-EXPRESSION-STEPS"
    );
  });
});

describe("expression compilation metadata", () => {
  it("reports the root identifiers of a parsed tree", () => {
    const compiled = compileExpression("a.b.c + n == flag");
    expect([...compiled.rootIdentifiers]).toEqual(["a", "flag", "n"]);
  });

  it("parses into a tree without evaluating", () => {
    const tree = parseExpression("a.b == 1");
    expect(tree).toEqual({
      node: "binary",
      operator: "==",
      left: {
        node: "member",
        target: { node: "identifier", name: "a" },
        property: "b"
      },
      right: { node: "literal", value: 1 }
    });
  });

  it("evaluates the same compiled expression against many scopes", () => {
    const compiled = compileExpression("value >= 2");
    expect(compiled.evaluatePredicate({ value: 2 })).toBe(true);
    expect(compiled.evaluatePredicate({ value: 1 })).toBe(false);
  });

  it("returns JSON values only", () => {
    const value: Json = evaluateExpression("a.list", SCOPE);
    expect(value).toEqual([10, 20, 30]);
  });
});
