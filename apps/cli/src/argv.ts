import { invalidInput } from "@oal/core";

import type { CommandRegistry, CommandSpec } from "./commands.ts";
import { suggestName } from "./similar.ts";
import {
  invalidOptionValue,
  missingOptionValue,
  missingSubcommand,
  unknownCommand
} from "./usage.ts";

/** Option kinds the hand-rolled parser understands. */
export type OptionKind = "boolean" | "value";

/** One declarative option; used for parsing and for help rendering. */
export interface OptionSpec {
  /** Long name without leading dashes; kebab-case. */
  readonly name: string;
  readonly kind: OptionKind;
  readonly description: string;
  /** Extra long spellings accepted for the same option. */
  readonly aliases?: readonly string[];
  /** One-letter short alias accepted with a single dash. */
  readonly short?: string;
}

const LONG_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const SHORT_NAME_PATTERN = /^[a-z]$/;

/** Global options accepted before and after the command name. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "format",
    kind: "value",
    description: "Output format: terminal, json, markdown, or html."
  },
  {
    name: "json",
    kind: "boolean",
    description: "Select JSON output; same as --format json."
  },
  {
    name: "out",
    kind: "value",
    aliases: ["output"],
    short: "o",
    description: "Write the command artifact to this exact path."
  },
  {
    name: "verbose",
    kind: "boolean",
    description: "Also show informational diagnostics."
  },
  {
    name: "quiet",
    kind: "boolean",
    description: "Show error diagnostics only."
  },
  {
    name: "no-color",
    kind: "boolean",
    description: "Disable ANSI colors."
  },
  {
    name: "version",
    kind: "boolean",
    description: "Print the CLI name and version."
  },
  {
    name: "help",
    kind: "boolean",
    short: "h",
    description: "Show command help."
  }
];

function assertSpellable(option: OptionSpec): void {
  const names = [option.name, ...(option.aliases ?? [])];
  for (const name of names) {
    if (!LONG_NAME_PATTERN.test(name)) {
      throw new Error(
        `Option name "${name}" is not kebab-case; this is a programming error.`
      );
    }
  }
  if (option.short !== undefined && !SHORT_NAME_PATTERN.test(option.short)) {
    throw new Error(`Short option "${option.short}" must be one letter.`);
  }
}

/** Typed read access to parsed options. */
export class FlagView {
  private readonly values: ReadonlyMap<string, readonly string[]>;
  private readonly booleans: ReadonlySet<string>;

  constructor(
    values: ReadonlyMap<string, readonly string[]>,
    booleans: ReadonlySet<string>
  ) {
    this.values = values;
    this.booleans = booleans;
  }

  has(name: string): boolean {
    return this.booleans.has(name) || this.values.has(name);
  }

  /** Last occurrence of a value option. */
  string(name: string): string | undefined {
    const occurrences = this.values.get(name);
    if (occurrences === undefined || occurrences.length === 0) {
      return undefined;
    }
    return occurrences[occurrences.length - 1];
  }

  requireString(name: string): string {
    const value = this.string(name);
    if (value === undefined) {
      throw missingOptionValue(`--${name}`);
    }
    return value;
  }

  /**
   * Validate an option against an allowed set of values. Falls back to the
   * declared default when the option is absent.
   */
  enumeration<T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T
  ): T {
    const value = this.string(name);
    if (value === undefined) {
      return fallback;
    }
    for (const candidate of allowed) {
      if (value === candidate) {
        return candidate;
      }
    }
    throw invalidOptionValue(
      `--${name}`,
      value,
      `one of: ${allowed.join(", ")}`
    );
  }

  /** Parse an integer option with inclusive bounds. */
  integer(
    name: string,
    bounds: { minimum: number; maximum: number }
  ): number | undefined {
    const raw = this.string(name);
    if (raw === undefined) {
      return undefined;
    }
    if (!/^-?[0-9]+$/.test(raw)) {
      throw invalidOptionValue(`--${name}`, raw, "an integer");
    }
    const parsed = Number.parseInt(raw, 10);
    if (parsed < bounds.minimum || parsed > bounds.maximum) {
      throw invalidOptionValue(
        `--${name}`,
        raw,
        `an integer between ${bounds.minimum} and ${bounds.maximum}`
      );
    }
    return parsed;
  }
}

export interface ParsedCommandLine {
  /** Resolved command, or null when argv contained no command name. */
  readonly command: CommandSpec | null;
  readonly flags: FlagView;
  readonly positionals: readonly string[];
}

interface OptionTable {
  readonly byLongName: Map<string, OptionSpec>;
  readonly byShortName: Map<string, OptionSpec>;
  readonly longNames: readonly string[];
}

function buildOptionTable(options: readonly OptionSpec[]): OptionTable {
  const byLongName = new Map<string, OptionSpec>();
  const byShortName = new Map<string, OptionSpec>();
  const longNames: string[] = [];
  for (const option of options) {
    assertSpellable(option);
    byLongName.set(option.name, option);
    longNames.push(option.name);
    for (const alias of option.aliases ?? []) {
      byLongName.set(alias, option);
    }
    if (option.short !== undefined) {
      byShortName.set(option.short, option);
    }
  }
  return { byLongName, byShortName, longNames };
}

function looksLikeFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/** Command options first, then globals; a collision is a programming error. */
function combineOptions(command: CommandSpec): readonly OptionSpec[] {
  const commandNames = new Set(
    command.options.flatMap((option) => [
      option.name,
      ...(option.aliases ?? [])
    ])
  );
  for (const global of GLOBAL_OPTIONS) {
    const names = [global.name, ...(global.aliases ?? [])];
    for (const name of names) {
      if (commandNames.has(name)) {
        throw new Error(
          `Command "${command.name}" redeclares the global option "${name}".`
        );
      }
    }
  }
  return [...command.options, ...GLOBAL_OPTIONS];
}

/**
 * Parse one argv array. Global options are recognized everywhere; command
 * options are recognized once the command name has been consumed. The first
 * bare token selects the command; namespaces such as "pack" consume a second
 * bare token as their subcommand. After "--" every token is positional.
 */
export function parseCommandLine(
  argv: readonly string[],
  registry: CommandRegistry
): ParsedCommandLine {
  const globalTable = buildOptionTable(GLOBAL_OPTIONS);
  let activeTable = globalTable;
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  let command: CommandSpec | null = null;
  let positionalOnly = false;

  const readValueToken = (): string | undefined => {
    const next = argv[index + 1];
    index += 1;
    return next;
  };

  const applyOption = (
    option: OptionSpec,
    spelling: string,
    inlineValue: string | undefined
  ): void => {
    if (option.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw invalidInput(
          "OAL-CLI-INVALID-OPTION-VALUE",
          `Option "${spelling}" does not accept a value.`
        );
      }
      booleans.add(option.name);
      return;
    }
    let value = inlineValue;
    if (value === undefined) {
      value = readValueToken();
      if (value === undefined) {
        throw missingOptionValue(spelling);
      }
    }
    const existing = values.get(option.name);
    if (existing === undefined) {
      values.set(option.name, [value]);
    } else {
      existing.push(value);
    }
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (positionalOnly) {
      positionals.push(token);
      index += 1;
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : body.slice(equals + 1);
      const spellings = activeTable.longNames;
      if (!LONG_NAME_PATTERN.test(name)) {
        throw invalidInput(
          "OAL-CLI-UNKNOWN-OPTION",
          `Unknown option "--${name}". Option names are kebab-case.`
        );
      }
      const option = activeTable.byLongName.get(name);
      if (option === undefined) {
        const suggestion = suggestName(spellings, name);
        throw invalidInput(
          "OAL-CLI-UNKNOWN-OPTION",
          suggestion === null
            ? `Unknown option "--${name}" in this position.`
            : `Unknown option "--${name}". Did you mean "--${suggestion}"?`
        );
      }
      applyOption(option, `--${name}`, inlineValue);
      index += 1;
      continue;
    }
    if (looksLikeFlag(token)) {
      const letter = token.slice(1);
      const option =
        letter.length === 1 ? activeTable.byShortName.get(letter) : undefined;
      if (option === undefined) {
        throw invalidInput(
          "OAL-CLI-UNKNOWN-OPTION",
          `Unknown option "${token}".`
        );
      }
      applyOption(option, token, undefined);
      index += 1;
      continue;
    }
    if (command === null) {
      const resolved = resolveCommand(registry, argv, index);
      command = resolved.command;
      activeTable = buildOptionTable(combineOptions(resolved.command));
      index += resolved.skip;
      continue;
    }
    positionals.push(token);
    index += 1;
  }

  return {
    command,
    flags: new FlagView(values, booleans),
    positionals
  };
}

function resolveCommand(
  registry: CommandRegistry,
  argv: readonly string[],
  index: number
): { command: CommandSpec; skip: number } {
  const token = argv[index];
  if (token === undefined) {
    throw new Error("Command resolution requires a token.");
  }
  const direct = registry.resolve(token);
  if (direct !== null) {
    return { command: direct, skip: 1 };
  }
  if (registry.namespaces.includes(token)) {
    const subcommands = registry
      .subcommandsOf(token)
      .map((command) => command.name);
    const next = argv[index + 1];
    if (next === undefined || looksLikeFlag(next)) {
      throw missingSubcommand(token, subcommands);
    }
    const nested = registry.resolve(`${token} ${next}`);
    if (nested === null) {
      const suggestion = suggestName(subcommands, next);
      throw unknownCommand(`${token} ${next}`, suggestion);
    }
    return { command: nested, skip: 2 };
  }
  const suggestion = suggestName(
    registry.commands.map((command) => command.name),
    token
  );
  throw unknownCommand(token, suggestion);
}
