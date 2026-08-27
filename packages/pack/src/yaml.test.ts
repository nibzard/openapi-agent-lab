import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";

import { PackYamlError, parsePackYaml } from "./yaml.ts";

function parse(text: string, options = {}): Json {
  return parsePackYaml(text, options);
}

function errorOf(text: string): PackYamlError {
  try {
    parsePackYaml(text);
  } catch (cause) {
    expect(cause).toBeInstanceOf(PackYamlError);
    return cause as PackYamlError;
  }
  throw new Error("the parser accepted invalid input");
}

describe("block mappings", () => {
  it("parses nested mappings with scalars of every supported kind", () => {
    const value = parse(`apiVersion: agentlab.dev/v1
kind: Pack
count: 3
ratio: 0.25
host: 127.0.0.1
version: 1.0.0
enabled: true
disabled: false
empty: null
label: 'single'
quoted: "double"
plain: some plain text
`);
    expect(value).toEqual({
      apiVersion: "agentlab.dev/v1",
      kind: "Pack",
      count: 3,
      ratio: 0.25,
      host: "127.0.0.1",
      version: "1.0.0",
      enabled: true,
      disabled: false,
      empty: null,
      label: "single",
      quoted: "double",
      plain: "some plain text"
    });
  });

  it("parses a manifest of the shape in specification section 12.2", () => {
    const value = parse(`metadata:
  id: steel-computer
  version: 1.0.0
requires:
  agentlab: ">=0.1.0 <0.2.0"
  backend_api: 1
server:
  host: 127.0.0.1
  port: 0
prompt_sets:
  - id: diagnostic
    purpose_disclosure: diagnostic
    instructions:
      source: prompts/diagnostic/instructions.md
      engine: mustache-strict
evals:
  - id: checkpoint-recovery
    prompt_set: diagnostic
    scenario: baseline
scenarios:
  - id: baseline
    fixtures:
      - fixtures/baseline.json
extensions: {}
`);
    expect(value).toEqual({
      metadata: { id: "steel-computer", version: "1.0.0" },
      requires: { agentlab: ">=0.1.0 <0.2.0", backend_api: 1 },
      server: { host: "127.0.0.1", port: 0 },
      prompt_sets: [
        {
          id: "diagnostic",
          purpose_disclosure: "diagnostic",
          instructions: {
            source: "prompts/diagnostic/instructions.md",
            engine: "mustache-strict"
          }
        }
      ],
      evals: [
        {
          id: "checkpoint-recovery",
          prompt_set: "diagnostic",
          scenario: "baseline"
        }
      ],
      scenarios: [{ id: "baseline", fixtures: ["fixtures/baseline.json"] }],
      extensions: {}
    });
  });

  it("rejects a duplicate key with its line number", () => {
    const error = errorOf("id: one\nid: two\n");
    expect(error.code).toBe("duplicate-key");
    expect(error.line).toBe(2);
  });

  it("rejects a mapping line without a key", () => {
    expect(errorOf("metadata:\n  broken\n").code).toBe("invalid");
  });

  it("rejects inconsistent indentation", () => {
    const error = errorOf("a:\n  b: 1\n c: 2\n");
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("indentation");
  });
});

describe("block sequences", () => {
  it("parses sequences of scalars", () => {
    expect(parse("items:\n  - one\n  - two\n")).toEqual({
      items: ["one", "two"]
    });
  });

  it("parses compact mappings that start on the dash line", () => {
    const value = parse(`policies:
  - id: create
    operations:
      - "path:POST /v1/widgets"
    ttl:
      kind: none
`);
    expect(value).toEqual({
      policies: [
        {
          id: "create",
          operations: ["path:POST /v1/widgets"],
          ttl: { kind: "none" }
        }
      ]
    });
  });

  it("parses an empty sequence item as null", () => {
    expect(parse("items:\n  -\n  - two\n")).toEqual({ items: [null, "two"] });
  });

  it("rejects a compact nested sequence", () => {
    const error = errorOf("nested:\n  - - a\n    - b\n");
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("Compact nested sequences");
  });
});

describe("flow collections", () => {
  it("parses single-line flow sequences and mappings", () => {
    const value = parse('names: [one, "two", 3]\nmap: { a: 1, b: two }\n');
    expect(value).toEqual({
      names: ["one", "two", 3],
      map: { a: 1, b: "two" }
    });
  });

  it("parses a flow collection nested in a block sequence", () => {
    expect(parse("- [1, 2]\n- { k: v }\n")).toEqual([[1, 2], { k: "v" }]);
  });

  it("rejects an unterminated flow collection", () => {
    expect(errorOf("names: [one, two\n").code).toBe("invalid");
  });
});

describe("scalars", () => {
  it("strips comments outside quotes", () => {
    const value = parse(`# leading comment
key: value # trailing comment
text: "a # hash inside quotes"
`);
    expect(value).toEqual({ key: "value", text: "a # hash inside quotes" });
  });

  it("decodes escape sequences in double-quoted scalars", () => {
    expect(parse('text: "a\\tb\\nc\\\\d\\"e"\n')).toEqual({
      text: 'a\tb\nc\\d"e'
    });
  });

  it("keeps single-quoted scalars literal and doubles quotes to escape", () => {
    expect(parse("text: 'it''s #1'\n")).toEqual({ text: "it's #1" });
  });

  it("parses a literal block scalar with strip chomping", () => {
    expect(parse("text: |-\n  one\n  two\nother: value\n")).toEqual({
      text: "one\ntwo",
      other: "value"
    });
  });

  it("parses a folded block scalar with clip chomping", () => {
    expect(parse("text: >\n  one\n  two\n")).toEqual({ text: "one two\n" });
  });

  it("parses a literal block scalar with keep chomping", () => {
    expect(parse("text: |+\n  one\n")).toEqual({ text: "one\n" });
  });
});

describe("documents and limits", () => {
  it("accepts one optional document start marker", () => {
    expect(parse("---\nkey: value\n")).toEqual({ key: "value" });
    expect(parse("%YAML 1.2\n---\nkey: value\n")).toEqual({ key: "value" });
  });

  it("returns null for an empty document", () => {
    expect(parse("# only a comment\n")).toBeNull();
  });

  it("rejects a second document", () => {
    const error = errorOf("- one\n---\n- two\n");
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("Multiple YAML documents");
  });

  it("rejects anchors, aliases, and tags", () => {
    expect(errorOf("a: &anchor value\n").code).toBe("invalid");
    expect(errorOf("a: *alias\n").code).toBe("invalid");
    expect(errorOf("a: !!str value\n").code).toBe("invalid");
  });

  it("rejects tab indentation", () => {
    expect(errorOf("a:\n\tb: 1\n").code).toBe("invalid");
  });

  it("enforces the configurable depth, node, and size limits", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      lines.push(`${" ".repeat(i)}k${i}:`);
    }
    lines.push(`${" ".repeat(60)}leaf: 1`);
    const deep = `${lines.join("\n")}\n`;
    expect(errorOf(deep).code).toBe("depth-limit");
    let expected: Json = { leaf: 1 };
    for (let i = 59; i >= 0; i -= 1) {
      expected = { [`k${i}`]: expected };
    }
    expect(parsePackYaml(deep, { maxDepth: 100 })).toEqual(expected);
    expect(() => parsePackYaml("a: 1\nb: 2\nc: 3\n", { maxNodes: 2 })).toThrow(
      /node limit/
    );
    expect(() => parsePackYaml("a: 1\n", { maxBytes: 2 })).toThrow(
      /byte limit/
    );
  });
});
