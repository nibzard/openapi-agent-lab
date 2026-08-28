import {
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  toOalError,
  type ExitCode
} from "@oal/core";

import { parseCommandLine } from "./argv.ts";
import {
  COMMAND_REGISTRY,
  type CommandArgs,
  type CommandRegistry
} from "./commands.ts";
import type { OutputFormat } from "./context.ts";
import { deriveContext } from "./context.ts";
import { emitOalError } from "./diagnostics.ts";
import { printVersion } from "./handlers/misc.ts";
import {
  renderCommandHelp,
  renderMissingCommand,
  renderTopHelp
} from "./help.ts";
import { createProcessIo, type Io } from "./io.ts";
import { installSignalHandlers, TerminationGuard } from "./signals.ts";

export interface MainOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxSourceBytes?: number;
  readonly guard?: TerminationGuard;
  readonly registry?: CommandRegistry;
}

interface EmissionSettings {
  readonly format: OutputFormat;
  readonly verbose: boolean;
  readonly quiet: boolean;
}

const TERMINAL_ONLY: EmissionSettings = {
  format: "terminal",
  verbose: false,
  quiet: false
};

/**
 * Run one CLI invocation and return its exit code. Diagnostics go to
 * stderr; machine output goes to stdout. A received interruption always
 * wins over the handler result (specification section 23.18).
 */
export async function main(
  argv: readonly string[],
  io: Io = createProcessIo(),
  options: MainOptions = {}
): Promise<ExitCode> {
  const registry = options.registry ?? COMMAND_REGISTRY;
  const finalize = (code: ExitCode): ExitCode =>
    options.guard?.exitCode() ?? code;
  let emission: EmissionSettings = TERMINAL_ONLY;
  try {
    const parsed = parseCommandLine(argv, registry);
    const context = deriveContext(parsed.flags, io, options);
    emission = {
      format: context.format,
      verbose: context.verbose,
      quiet: context.quiet
    };
    if (parsed.flags.has("version")) {
      printVersion(io, context.format === "json" ? "json" : "terminal");
      return finalize(EXIT_OK);
    }
    if (parsed.flags.has("help")) {
      io.stdout(
        parsed.command === null
          ? renderTopHelp(registry, context.color)
          : renderCommandHelp(parsed.command, context.color)
      );
      return finalize(EXIT_OK);
    }
    if (parsed.command === null) {
      io.stderr(renderMissingCommand(registry));
      return finalize(EXIT_INVALID);
    }
    const args: CommandArgs = {
      command: parsed.command,
      registry,
      positionals: parsed.positionals,
      flags: parsed.flags,
      context
    };
    const code = await parsed.command.handler(args, io);
    return finalize(code);
  } catch (error) {
    const typed = toOalError(error);
    emitOalError(io, emission, typed);
    return finalize(typed.exitCode);
  }
}

/**
 * Minimum stream surface the drain wait depends on. Any buffered writable
 * stream satisfies it, including the process standard streams.
 */
export interface DrainableStream {
  /** Bytes written but not yet handed to the destination. */
  readonly writableLength: number;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/**
 * Resolve once one stream reported every queued byte flushed, or once
 * the destination went away. A pipe that closes while bytes are still
 * queued never reports `drain`, so `close` and `error` (EPIPE) also
 * release the wait and the exit path always terminates.
 */
export function drained(stream: DrainableStream): Promise<void> {
  if (stream.writableLength === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    stream.once("drain", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

/**
 * Wait for piped stdout and stderr to flush, then exit. `process.exit`
 * truncates queued writes, so piped JSON output would lose its tail; the
 * streams drain first and one more turn lets the final write callbacks
 * run before the exit.
 */
export async function exitWhenDrained(
  code: ExitCode,
  streams: readonly DrainableStream[] = [process.stdout, process.stderr]
): Promise<void> {
  process.exitCode = code;
  await Promise.all(streams.map((stream) => drained(stream)));
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  process.exit(code);
}

/** Binary entry point: wires process IO and signal handling, then exits. */
export function runCli(argv: readonly string[] = process.argv.slice(2)): void {
  const io = createProcessIo();
  const guard = new TerminationGuard();
  installSignalHandlers(guard);
  void main(argv, io, { guard })
    .then((code: ExitCode) => {
      void exitWhenDrained(code);
    })
    .catch(() => {
      void exitWhenDrained(EXIT_INFRASTRUCTURE);
    });
}
