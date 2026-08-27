import path from "node:path";

import { LIMIT_DEFAULTS } from "@oal/config";

import type { FlagView } from "./argv.ts";
import type { TerminationGuard } from "./signals.ts";

/** Output formats named by specification section 23. */
export type OutputFormat = "terminal" | "json" | "markdown" | "html";

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  "terminal",
  "json",
  "markdown",
  "html"
];

/** Resolved run-wide settings handed to every command handler. */
export interface RunContext {
  readonly format: OutputFormat;
  /** Absolute target for --out, or null. */
  readonly outPath: string | null;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
  readonly cwd: string;
  readonly maxSourceBytes: number;
  readonly abortSignal: AbortSignal;
}

/** NO_COLOR is honored when present and not an empty string. */
export function noColorRequested(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const value = env["NO_COLOR"];
  return value !== undefined && value !== "";
}

/** Color needs an interactive stdout, no NO_COLOR, and no --no-color. */
export function colorEnabled(input: {
  noColorFlag: boolean;
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
}): boolean {
  if (input.noColorFlag) {
    return false;
  }
  if (noColorRequested(input.env)) {
    return false;
  }
  return input.stdoutIsTTY;
}

export function resolveOutputFormat(flags: FlagView): OutputFormat {
  return flags.enumeration("format", OUTPUT_FORMATS, "terminal");
}

export function deriveContext(
  flags: FlagView,
  io: { readonly stdoutIsTTY: boolean },
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxSourceBytes?: number;
    readonly guard?: TerminationGuard;
  }
): RunContext {
  const explicit = resolveOutputFormat(flags);
  const format = flags.has("json") && !flags.has("format") ? "json" : explicit;
  const out = flags.string("out");
  const env = options.env ?? process.env;
  return {
    format,
    outPath:
      out === undefined
        ? null
        : path.resolve(options.cwd ?? process.cwd(), out),
    verbose: flags.has("verbose"),
    quiet: flags.has("quiet"),
    color: colorEnabled({
      noColorFlag: flags.has("no-color"),
      env,
      stdoutIsTTY: io.stdoutIsTTY
    }),
    cwd: options.cwd ?? process.cwd(),
    maxSourceBytes:
      options.maxSourceBytes ?? LIMIT_DEFAULTS.maxSourceOpenapiBytes,
    abortSignal: options.guard?.abortSignal ?? new AbortController().signal
  };
}
