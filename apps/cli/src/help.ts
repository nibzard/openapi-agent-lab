import { GLOBAL_OPTIONS, type OptionSpec } from "./argv.ts";
import type { CommandRegistry, CommandSpec } from "./commands.ts";
import { CLI_NAME, VERSION } from "./version.ts";

const TAGLINE =
  "Deterministic OpenAPI mock, agent test harness, and evaluation system.";

function bold(text: string, color: boolean): string {
  return color ? `\x1b[1m${text}\x1b[22m` : text;
}

function optionSpelling(option: OptionSpec): string {
  const placeholder = option.kind === "value" ? " <value>" : "";
  return `--${option.name}${placeholder}`;
}

function optionColumnWidth(options: readonly OptionSpec[]): number {
  let width = 0;
  for (const option of options) {
    width = Math.max(width, optionSpelling(option).length);
  }
  return width;
}

function renderOptions(
  options: readonly OptionSpec[],
  indent: string
): string[] {
  const width = optionColumnWidth(options);
  const lines: string[] = [];
  for (const option of options) {
    const spelling = optionSpelling(option).padEnd(width);
    lines.push(`${indent}${spelling}  ${option.description}`);
  }
  return lines;
}

function renderCommandList(registry: CommandRegistry): string[] {
  const width =
    registry.commands.reduce(
      (maximum, command) => Math.max(maximum, command.name.length),
      0
    ) + 2;
  const lines: string[] = [];
  for (const command of registry.commands) {
    lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
  }
  return lines;
}

/** Help shown by "oal help", "oal --help", and "oal help help". */
export function renderTopHelp(
  registry: CommandRegistry,
  color = false
): string {
  const lines: string[] = [
    `${CLI_NAME} ${VERSION}`,
    TAGLINE,
    "",
    bold("Usage:", color),
    `  ${CLI_NAME} <command> [arguments] [options]`,
    "",
    bold("Commands:", color),
    ...renderCommandList(registry),
    "",
    bold("Global options:", color),
    ...renderOptions(GLOBAL_OPTIONS, "  "),
    "",
    `Use "${CLI_NAME} help <command>" for command details.`
  ];
  return lines.join("\n");
}

/** Help shown by "oal help <command>" and "oal <command> --help". */
export function renderCommandHelp(command: CommandSpec, color = false): string {
  const usageArguments = command.arguments
    .map((argument) => `<${argument.name}>`)
    .join(" ");
  const usageSuffix = usageArguments.length === 0 ? "" : ` ${usageArguments}`;
  const lines: string[] = [
    `${CLI_NAME} ${command.name} — ${command.summary}`,
    "",
    bold("Usage:", color),
    `  ${CLI_NAME} ${command.name}${usageSuffix} [options]`
  ];
  if (command.arguments.length > 0) {
    const width =
      command.arguments.reduce(
        (maximum, argument) => Math.max(maximum, argument.name.length + 2),
        0
      ) + 2;
    lines.push("", bold("Arguments:", color));
    for (const argument of command.arguments) {
      const spelling = `<${argument.name}>`.padEnd(width);
      lines.push(`  ${spelling}  ${argument.description}`);
    }
  }
  if (command.options.length > 0) {
    lines.push("", bold("Options:", color));
    lines.push(...renderOptions(command.options, "  "));
  }
  lines.push("", bold("Global options:", color));
  lines.push(...renderOptions(GLOBAL_OPTIONS, "  "));
  lines.push("");
  return lines.join("\n");
}

/** Short stderr text printed when argv names no command. */
export function renderMissingCommand(registry: CommandRegistry): string {
  const names = registry.commands.map((command) => command.name).join(", ");
  return [
    `${CLI_NAME} ${VERSION}`,
    `Usage: ${CLI_NAME} <command> [arguments] [options]`,
    `Run "${CLI_NAME} help" to list commands: ${names}`
  ].join("\n");
}
