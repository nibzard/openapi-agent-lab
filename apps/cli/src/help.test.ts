import { describe, expect, it } from "vitest";

import { COMMANDS, COMMAND_REGISTRY, type CommandSpec } from "./commands.ts";
import {
  renderCommandHelp,
  renderMissingCommand,
  renderTopHelp
} from "./help.ts";
import { levenshtein, suggestName } from "./similar.ts";

function requireCommand(name: string): CommandSpec {
  const command = COMMAND_REGISTRY.resolve(name);
  if (command === null) {
    throw new Error(`Test setup: command "${name}" is not registered.`);
  }
  return command;
}

describe("command registry and help", () => {
  it("lists every command in the top-level help", () => {
    const help = renderTopHelp(COMMAND_REGISTRY);
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
  });

  it("renders per-command help with usage, arguments, and globals", () => {
    const help = renderCommandHelp(requireCommand("serve"));
    expect(help).toContain("oal serve <source> [options]");
    expect(help).toContain("--run-seed");
    expect(help).toContain("--format <value>");
  });

  it("renders arguments for multi-positional commands", () => {
    const help = renderCommandHelp(requireCommand("compare"));
    expect(help).toContain("<batch-a>");
    expect(help).toContain("<batch-b>");
  });

  it("derives namespaces from two-word commands", () => {
    expect(COMMAND_REGISTRY.namespaces).toContain("pack");
    expect(COMMAND_REGISTRY.namespaces).toContain("eval");
    expect(COMMAND_REGISTRY.namespaces).toContain("study");
    expect(COMMAND_REGISTRY.namespaces).toContain("workflow");
    expect(COMMAND_REGISTRY.subcommandsOf("pack").map((c) => c.name)).toEqual([
      "pack init",
      "pack validate"
    ]);
  });

  it("names every registered command without duplicates", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(COMMAND_REGISTRY.resolve(command.name)).toBe(command);
    }
    expect(COMMAND_REGISTRY.resolve("nope")).toBeNull();
  });

  it("suggests a missing-command hint listing commands", () => {
    const text = renderMissingCommand(COMMAND_REGISTRY);
    expect(text).toContain("Usage: oal <command>");
    expect(text).toContain("inspect");
  });
});

describe("did-you-mean suggestions", () => {
  it("computes edit distance", () => {
    expect(levenshtein("inspect", "inspect")).toBe(0);
    expect(levenshtein("inspct", "inspect")).toBe(1);
    expect(levenshtein("pack", "back")).toBe(1);
    expect(levenshtein("", "ab")).toBe(2);
  });

  it("suggests within two edits and refuses beyond", () => {
    const names = ["inspect", "report", "replay", "pack init"];
    expect(suggestName(names, "inspct")).toBe("inspect");
    expect(suggestName(names, "repot")).toBe("report");
    expect(suggestName(names, "packinit")).toBe("pack init");
    expect(suggestName(names, "zzzzzz")).toBeNull();
  });

  it("breaks ties in candidate order", () => {
    expect(suggestName(["reportx", "reporty"], "report")).toBe("reportx");
  });
});
