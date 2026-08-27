import { EXIT_OK, stableJsonStringify, type ExitCode } from "@oal/core";

import type { CommandArgs } from "../commands.ts";
import type { Io } from "../io.ts";
import { renderCommandHelp, renderTopHelp } from "../help.ts";
import { unknownCommand } from "../usage.ts";
import { suggestName } from "../similar.ts";
import { CLI_NAME, VERSION, versionLine } from "../version.ts";

/** oal version and the --version flag. */
export function printVersion(io: Io, format: "terminal" | "json"): void {
  if (format === "json") {
    io.stdout(stableJsonStringify({ name: CLI_NAME, version: VERSION }));
    return;
  }
  io.stdout(versionLine());
}

export function versionCommand(args: CommandArgs, io: Io): Promise<ExitCode> {
  printVersion(io, args.context.format === "json" ? "json" : "terminal");
  return Promise.resolve(EXIT_OK);
}

/** oal help [command...] */
export function helpCommand(args: CommandArgs, io: Io): Promise<ExitCode> {
  const registry = args.registry;
  const requested = args.positionals.join(" ").trim();
  if (requested.length === 0) {
    io.stdout(renderTopHelp(registry));
    return Promise.resolve(EXIT_OK);
  }
  const command = registry.resolve(requested);
  if (command === null) {
    const suggestion = suggestName(
      registry.commands.map((entry) => entry.name),
      requested
    );
    throw unknownCommand(requested, suggestion);
  }
  io.stdout(renderCommandHelp(command));
  return Promise.resolve(EXIT_OK);
}
