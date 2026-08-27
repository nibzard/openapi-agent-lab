import { invalidInput } from "@oal/core";

/** Stable diagnostic codes for CLI-shell usage failures. */
export const UsageCode = {
  UnknownCommand: "OAL-CLI-UNKNOWN-COMMAND",
  MissingSubcommand: "OAL-CLI-MISSING-SUBCOMMAND",
  UnknownOption: "OAL-CLI-UNKNOWN-OPTION",
  MissingOptionValue: "OAL-CLI-MISSING-OPTION-VALUE",
  InvalidOptionValue: "OAL-CLI-INVALID-OPTION-VALUE",
  MissingArgument: "OAL-CLI-MISSING-ARGUMENT",
  TooManyArguments: "OAL-CLI-TOO-MANY-ARGUMENTS",
  NotImplemented: "OAL-NOT-IMPLEMENTED",
  StdinUnavailable: "OAL-STDIN-UNAVAILABLE"
} as const;

export function unknownCommand(
  input: string,
  suggestion: string | null
): Error {
  return invalidInput(
    UsageCode.UnknownCommand,
    suggestion === null
      ? `Unknown command "${input}".`
      : `Unknown command "${input}". Did you mean "${suggestion}"?`
  );
}

export function missingSubcommand(
  namespace: string,
  subcommands: readonly string[]
): Error {
  return invalidInput(
    UsageCode.MissingSubcommand,
    `Missing subcommand for "${namespace}". Available: ${subcommands.join(", ")}.`
  );
}

export function missingOptionValue(name: string): Error {
  return invalidInput(
    UsageCode.MissingOptionValue,
    `Option "${name}" requires a value.`
  );
}

export function invalidOptionValue(
  name: string,
  value: string,
  expected: string
): Error {
  return invalidInput(
    UsageCode.InvalidOptionValue,
    `Option "${name}" has value "${value}". Expected ${expected}.`
  );
}

export function missingArgument(command: string, argument: string): Error {
  return invalidInput(
    UsageCode.MissingArgument,
    `Command "${command}" requires a <${argument}> argument.`
  );
}

export function tooManyArguments(command: string, maximum: number): Error {
  return invalidInput(
    UsageCode.TooManyArguments,
    `Command "${command}" accepts at most ${maximum} positional argument${
      maximum === 1 ? "" : "s"
    }.`
  );
}
