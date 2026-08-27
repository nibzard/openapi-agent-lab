import { writeFile } from "node:fs/promises";

import {
  EXIT_OK,
  infrastructure,
  stableJsonStringify,
  type ExitCode
} from "@oal/core";

import type { CommandArgs } from "../commands.ts";
import type { Io } from "../io.ts";
import { resolveSourceArgument } from "../source.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

/** Documented inspect artifact keys, in report order. */
const REPORT_KEYS = ["entrypoint", "media_type", "sha256", "bytes"] as const;

/**
 * Minimal working inspect: source resolution only. The full capability
 * report lands with the compiler and capability tasks.
 */
export async function inspectCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const source = args.positionals[0];
  if (source === undefined) {
    throw missingArgument(args.command.name, "source");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const resolved = await resolveSourceArgument(source, {
    cwd: args.context.cwd,
    maxBytes: args.context.maxSourceBytes,
    ...(io.stdin === undefined ? {} : { stdin: io.stdin })
  });
  const artifact = {
    entrypoint: resolved.entrypoint,
    media_type: resolved.media_type,
    sha256: resolved.sha256,
    bytes: resolved.bytes
  };
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(artifact));
  } else {
    for (const key of REPORT_KEYS) {
      io.stdout(`${key}: ${artifact[key]}`);
    }
  }
  const outPath = args.context.outPath;
  if (outPath !== null) {
    await writeFile(outPath, `${stableJsonStringify(artifact)}\n`).catch(
      (error: unknown) => {
        throw infrastructure(
          "OAL-ARTIFACT-WRITE-FAILED",
          `Failed to write --out target ${outPath}: ${describe(error)}`
        );
      }
    );
  }
  return EXIT_OK;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
