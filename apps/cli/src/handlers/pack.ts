import path from "node:path";

import {
  EXIT_INVALID,
  EXIT_OK,
  invalidInput,
  stableJsonStringify,
  type Json,
  type JsonObject
} from "@oal/core";
import { scaffoldPack, validatePack } from "@oal/pack";

import type { CommandArgs, CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

function requireSinglePositional(args: CommandArgs, name: string): string {
  const value = args.positionals[0];
  if (value === undefined) {
    throw missingArgument(args.command.name, name);
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  return value;
}

/** `oal pack init <directory> --openapi <path>` (specification section 23.5). */
export const packInitCommand: CommandHandler = async (args, io) => {
  const directory = requireSinglePositional(args, "directory");
  const openapi = args.flags.string("openapi");
  if (openapi === undefined) {
    throw invalidInput(
      "OAL-PACK-OPENAPI-MISSING",
      'Command "pack init" requires an "--openapi <path>" option.'
    );
  }
  const result = await scaffoldPack(directory, {
    openapi,
    cwd: args.context.cwd
  });
  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        root: result.root,
        id: result.id,
        contract_entrypoint: result.contractEntrypoint,
        directories: [...result.directories],
        files: [...result.files]
      } as Json)
    );
  } else {
    io.stdout(`created: ${result.root}`);
    io.stdout(`pack id: ${result.id}`);
    for (const file of result.files) {
      io.stdout(`file: ${file}`);
    }
  }
  return EXIT_OK;
};

/** `oal pack validate <pack> [--strict]` (specification section 23.6). */
export const packValidateCommand: CommandHandler = async (args, io) => {
  const directory = requireSinglePositional(args, "pack");
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const result = await validatePack(path.resolve(args.context.cwd, directory));
  emitDiagnostics(io, args.context, result.diagnostics);
  if (result.errors.length > 0) {
    return EXIT_INVALID;
  }
  if (args.flags.has("strict") && result.warnings.length > 0) {
    return EXIT_INVALID;
  }
  const ir = result.packIr;
  if (ir === null) {
    return EXIT_INVALID;
  }
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(ir));
  } else {
    const summary: Record<string, string | number> = {
      pack: sectionString(ir, "pack", "id"),
      manifest: result.manifestName,
      manifest_sha256: result.manifestSha256,
      behavior_mode: sectionString(ir, "behavior", "mode"),
      operations: result.index.operations.length,
      evals: arrayLength(ir, "evals"),
      scenarios: arrayLength(ir, "scenarios")
    };
    for (const [key, value] of Object.entries(summary)) {
      io.stdout(`${key}: ${value}`);
    }
  }
  return EXIT_OK;
};

function sectionString(ir: JsonObject, section: string, key: string): string {
  const holder = ir[section];
  if (typeof holder === "object" && holder !== null && !Array.isArray(holder)) {
    const value = (holder as JsonObject)[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function arrayLength(ir: JsonObject, key: string): number {
  const value = ir[key];
  return Array.isArray(value) ? value.length : 0;
}
