import { describe, expect, it } from "vitest";

import { parseSafeYaml, SafeYamlError } from "../src/yaml.ts";

function parse(text: string, options = {}): unknown {
  return parseSafeYaml(text, options);
}

function failure(text: string, code: string): SafeYamlError {
  try {
    parse(text);
  } catch (error) {
    if (error instanceof SafeYamlError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error(`Expected a SafeYamlError with code ${code}`);
}

describe("safe yaml parsing", () => {
  it("parses plain, quoted, and typed scalars", () => {
    expect(parse("hello")).toBe("hello");
    expect(parse("'it''s'")).toBe("it's");
    expect(parse(`"tab\\there"`)).toBe("tab\there");
    expect(parse("42")).toBe(42);
    expect(parse("3.5")).toBe(3.5);
    expect(parse("true")).toBe(true);
    expect(parse("false")).toBe(false);
    expect(parse("null")).toBe(null);
    expect(parse("~")).toBe(null);
    expect(parse("")).toBe(null);
  });

  it("keeps unknown words as strings", () => {
    expect(parse("3.1.0")).toBe("3.1.0");
    expect(parse("on")).toBe("on");
    expect(parse("0042")).toBe("0042");
  });

  it("parses nested block mappings and sequences", () => {
    const value = parse(
      [
        "openapi: 3.1.0",
        "info:",
        "  title: Petstore",
        "  version: 1.0.0",
        "tags:",
        "  - name: pets",
        "    description: Pet operations",
        "  - name: store",
        "paths:",
        "  /pets:",
        "    get:",
        "      responses:",
        '        "200":',
        "          description: ok"
      ].join("\n")
    );
    expect(value).toEqual({
      openapi: "3.1.0",
      info: { title: "Petstore", version: "1.0.0" },
      tags: [
        { name: "pets", description: "Pet operations" },
        { name: "store" }
      ],
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": { description: "ok" }
            }
          }
        }
      }
    });
  });

  it("accepts a sequence at the document root and a leading document marker", () => {
    expect(parse("---\n- one\n- two\n")).toEqual(["one", "two"]);
    expect(parse("%YAML 1.2\n---\na: 1\n")).toEqual({ a: 1 });
  });

  it("parses flow collections and quoted keys", () => {
    expect(parse("a: [1, two, 'three']")).toEqual({
      a: [1, "two", "three"]
    });
    expect(parse('a: {b: 1, "c d": 2}')).toEqual({ a: { b: 1, "c d": 2 } });
    expect(parse("[{a: 1}, {a: 2}]")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parse("a: []")).toEqual({ a: [] });
    expect(parse("a: {}")).toEqual({ a: {} });
  });

  it("parses literal and folded block scalars with chomping", () => {
    expect(parse("text: |\n  one\n  two\n")).toEqual({
      text: "one\ntwo\n"
    });
    expect(parse("text: |-\n  one\n  two\n")).toEqual({
      text: "one\ntwo"
    });
    expect(parse("text: |+\n  one\n\n")).toEqual({ text: "one\n\n" });
    expect(parse("text: >\n  one\n  two\n")).toEqual({ text: "one two\n" });
    expect(parse("text: >-\n  one\n  two\n")).toEqual({ text: "one two" });
  });

  it("ignores comments and blank lines", () => {
    expect(parse("# leading\na: 1 # trailing\n\n# between\nb: 2\n")).toEqual({
      a: 1,
      b: 2
    });
  });

  it("resolves anchors and aliases within limits", () => {
    const value = parse("base: &base\n  x: 1\ncopy: *base\n") as Record<
      string,
      unknown
    >;
    expect(value.copy).toEqual({ x: 1 });
  });

  it("rejects duplicate keys with a pointer", () => {
    const error = failure("a: 1\na: 2\n", "duplicate-key");
    expect(error.nodePointer).toBe("#/a");
  });

  it("rejects duplicate keys inside flow mappings", () => {
    failure("a: {b: 1, b: 2}\n", "duplicate-key");
  });

  it("rejects tab indentation", () => {
    failure("a:\n\tb: 1\n", "invalid");
  });

  it("rejects malformed documents", () => {
    failure("a: [1, 2\n", "invalid");
    failure("a: 'unterminated\n", "invalid");
    failure("- 1\n nested: 2\n", "invalid");
    failure("a: *missing\n", "invalid");
  });

  it("fails closed on alias expansion bombs", () => {
    const bomb = [
      "a: &a [1,1,1,1,1,1,1,1,1]",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
      "f: [*e,*e,*e,*e,*e,*e,*e,*e,*e]"
    ].join("\n");
    const error = failure(bomb, "node-limit");
    expect(error.line).toBeGreaterThan(0);
  });

  it("enforces explicit node, depth, alias, and byte limits", () => {
    expect(() => parse("a: [1, 2, 3]\n", { maxNodes: 2 })).toThrowError(
      SafeYamlError
    );
    expect(() => parse("a: {b: {c: {d: 1}}}\n", { maxDepth: 3 })).toThrowError(
      SafeYamlError
    );
    expect(() =>
      parse("a: &x 1\nb: *x\nc: *x\n", { maxAliasExpansions: 1 })
    ).toThrowError(SafeYamlError);
    expect(() => parse("a: 1\n", { maxBytes: 2 })).toThrowError(SafeYamlError);
  });

  it("never evaluates dynamic constructs", () => {
    expect(parse("a: !!str 7")).toEqual({ a: "7" });
    expect(parse("a: !!int 7")).toEqual({ a: 7 });
    expect(parse("a: !!seq [1, 2]")).toEqual({ a: [1, 2] });
    failure("a: !Custom {b: 1}\n", "invalid");
    failure("a: !!python/object:os.system {}\n", "invalid");
  });
});
