import { describe, expect, it } from "vitest";

import { GLOBAL_OPTIONS, parseCommandLine } from "./argv.ts";
import { COMMAND_REGISTRY } from "./commands.ts";
import { OalError } from "@oal/core";

function parse(argv: readonly string[]): ReturnType<typeof parseCommandLine> {
  return parseCommandLine(argv, COMMAND_REGISTRY);
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof OalError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected parseCommandLine to throw.");
}

describe("argv parser", () => {
  it("parses a boolean flag after the command", () => {
    const parsed = parse(["inspect", "doc.json", "--strict"]);
    expect(parsed.command?.name).toBe("inspect");
    expect(parsed.flags.has("strict")).toBe(true);
    expect(parsed.positionals).toEqual(["doc.json"]);
  });

  it("parses --key=value", () => {
    const parsed = parse(["inspect", "doc.json", "--format=json"]);
    expect(parsed.flags.string("format")).toBe("json");
  });

  it("parses --key value", () => {
    const parsed = parse(["inspect", "--format", "json", "doc.json"]);
    expect(parsed.flags.string("format")).toBe("json");
    expect(parsed.positionals).toEqual(["doc.json"]);
  });

  it("keeps the last occurrence of a repeated option", () => {
    const parsed = parse([
      "inspect",
      "--operation",
      "a",
      "--operation",
      "b",
      "doc.json"
    ]);
    expect(parsed.flags.string("operation")).toBe("b");
  });

  it("accepts global flags before the command name", () => {
    const parsed = parse(["--format", "json", "inspect", "doc.json"]);
    expect(parsed.command?.name).toBe("inspect");
    expect(parsed.flags.string("format")).toBe("json");
  });

  it("resolves two-word commands by consuming the subcommand token", () => {
    const parsed = parse(["pack", "init", "--openapi", "doc.json", "target"]);
    expect(parsed.command?.name).toBe("pack init");
    expect(parsed.positionals).toEqual(["target"]);
    expect(parsed.flags.string("openapi")).toBe("doc.json");
  });

  it("treats everything after -- as positional", () => {
    const parsed = parse(["inspect", "--", "--not-a-flag", "-"]);
    expect(parsed.positionals).toEqual(["--not-a-flag", "-"]);
  });

  it("keeps a lone dash as a positional for stdin", () => {
    const parsed = parse(["inspect", "-"]);
    expect(parsed.positionals).toEqual(["-"]);
  });

  it("accepts short aliases for declared options only", () => {
    const parsed = parse(["inspect", "doc.json", "-o", "out.json"]);
    expect(parsed.flags.string("out")).toBe("out.json");
    expect(() => parse(["inspect", "-x", "doc.json"])).toThrow(OalError);
    expect(codeOf(() => parse(["inspect", "-x", "doc.json"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
  });

  it("rejects unknown long options with exit category input", () => {
    expect(codeOf(() => parse(["inspect", "--bogus", "doc.json"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
  });

  it("rejects a command option that appears before the command", () => {
    expect(codeOf(() => parse(["--strict", "inspect", "doc.json"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
  });

  it("rejects non-kebab-case option spellings", () => {
    expect(codeOf(() => parse(["inspect", "--Verbose", "doc.json"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
    expect(codeOf(() => parse(["inspect", "--with_underscore", "x"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
    expect(codeOf(() => parse(["inspect", "---triple", "x"]))).toBe(
      "OAL-CLI-UNKNOWN-OPTION"
    );
  });

  it("rejects a value option without a value", () => {
    expect(codeOf(() => parse(["inspect", "doc.json", "--format"]))).toBe(
      "OAL-CLI-MISSING-OPTION-VALUE"
    );
  });

  it("rejects an inline value on a boolean option", () => {
    expect(codeOf(() => parse(["inspect", "--strict=1", "doc.json"]))).toBe(
      "OAL-CLI-INVALID-OPTION-VALUE"
    );
  });

  it("rejects unknown commands and namespaces without subcommands", () => {
    expect(codeOf(() => parse(["bogus", "x"]))).toBe("OAL-CLI-UNKNOWN-COMMAND");
    expect(codeOf(() => parse(["pack"]))).toBe("OAL-CLI-MISSING-SUBCOMMAND");
    expect(codeOf(() => parse(["pack", "bogus"]))).toBe(
      "OAL-CLI-UNKNOWN-COMMAND"
    );
  });

  it("returns a null command for empty argv", () => {
    const parsed = parse([]);
    expect(parsed.command).toBeNull();
    expect(parsed.positionals).toEqual([]);
  });

  it("exposes typed integer and enumeration readers", () => {
    const parsed = parse([
      "run",
      "pack",
      "--count",
      "3",
      "--exposure",
      "direct-tools"
    ]);
    expect(parsed.flags.integer("count", { minimum: 1, maximum: 64 })).toBe(3);
    expect(() =>
      parsed.flags.integer("count", { minimum: 4, maximum: 64 })
    ).toThrow(OalError);
    expect(() =>
      parsed.flags.enumeration("exposure", ["raw-http"] as const, "raw-http")
    ).toThrow(OalError);
  });

  it("declares global options as kebab-case", () => {
    for (const option of GLOBAL_OPTIONS) {
      expect(option.name).toMatch(/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/);
    }
  });
});
