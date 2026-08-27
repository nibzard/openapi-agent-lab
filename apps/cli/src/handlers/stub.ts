import {
  EXIT_INFRASTRUCTURE,
  diagnostic,
  type Diagnostic,
  type ExitCode
} from "@oal/core";

import type { CommandArgs, CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import type { Io } from "../io.ts";
import { UsageCode } from "../usage.ts";

/** Diagnostic emitted by every command not yet implemented in this build. */
export function notImplementedDiagnostic(command: string): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "preflight",
    code: UsageCode.NotImplemented,
    message: `oal ${command} is not implemented in this build.`
  });
}

/**
 * Typed stub for subsystems delivered by later tasks: one clear diagnostic
 * on stderr and infrastructure exit status 3.
 */
export function stubCommand(command: string): CommandHandler {
  return (args: CommandArgs, io: Io): Promise<ExitCode> => {
    emitDiagnostics(io, args.context, [notImplementedDiagnostic(command)]);
    return Promise.resolve(EXIT_INFRASTRUCTURE);
  };
}
