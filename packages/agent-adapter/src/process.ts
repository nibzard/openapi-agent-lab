/**
 * Shared child process management (specification sections 21.2 and 31).
 *
 * Every adapter spawns through this module. It spawns with an argv array and
 * never a shell string, puts the child in its own process group, escalates
 * from graceful to forced termination, and keeps raw capture bounded.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import type { AgentRunContext } from "./types.ts";

/** Default grace interval between graceful and forced termination. */
export const DEFAULT_GRACE_MS = 2000;

/** Default per-stream capture bound in bytes. */
export const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;

/** Default time allowed for stream drain after process exit. */
export const DEFAULT_DRAIN_MS = 1000;

/** Default bound on one final-output read in bytes. */
export const DEFAULT_MAX_FINAL_OUTPUT_BYTES = 1024 * 1024;

export interface SpawnEnvironment {
  /** Environment handed to the driver process. */
  readonly env: Record<string, string>;
  /** Launcher names copied into that environment. */
  readonly appliedLauncherNames: string[];
}

/**
 * Build the driver environment. The tool environment is copied whole and the
 * launcher environment contributes only the declared names, so the two are
 * never merged.
 */
export function buildSpawnEnvironment(
  context: AgentRunContext,
  launcherNames: readonly string[]
): SpawnEnvironment {
  const env: Record<string, string> = { ...context.toolEnvironment };
  const appliedLauncherNames: string[] = [];
  for (const name of launcherNames) {
    const value = context.launcherEnvironment[name];
    if (value !== undefined) {
      env[name] = value;
      appliedLauncherNames.push(name);
    }
  }
  return { env, appliedLauncherNames };
}

export interface BoundedFileRead {
  readonly text: string;
  readonly truncated: boolean;
}

/** Read at most `maxBytes` from the start of a file. */
export async function readBoundedFile(
  path: string,
  maxBytes: number
): Promise<BoundedFileRead> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: bytesRead > maxBytes
    };
  } finally {
    await handle.close();
  }
}

/** Upper bound on the descendant walk, so a deep tree cannot loop forever. */
const MAX_DESCENDANT_DEPTH = 8;

const IS_POSIX = process.platform !== "win32";

/**
 * Ring buffer over raw capture. It keeps the newest bytes and reports how
 * much text was seen in total, so raw capture stays bounded in memory.
 */
export class BoundedCapture {
  private chunks: Buffer[] = [];
  private held = 0;
  private seen = 0;

  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer.");
    }
    this.maxBytes = maxBytes;
  }

  /** Append one chunk and drop the oldest bytes above the cap. */
  append(chunk: Buffer): void {
    this.seen += chunk.byteLength;
    this.chunks.push(chunk);
    this.held += chunk.byteLength;
    while (this.held > this.maxBytes && this.chunks.length > 1) {
      const first = this.chunks[0];
      if (first === undefined) {
        break;
      }
      this.chunks.shift();
      this.held -= first.byteLength;
    }
    if (this.held > this.maxBytes) {
      const only = this.chunks[0];
      if (only !== undefined) {
        const keep = only.subarray(only.byteLength - this.maxBytes);
        this.chunks = [Buffer.from(keep)];
        this.held = keep.byteLength;
      }
    }
  }

  /** True when any byte was dropped. */
  get truncated(): boolean {
    return this.held < this.seen;
  }

  /** Total bytes seen, including dropped bytes. */
  get bytesSeen(): number {
    return this.seen;
  }

  /** Retained text. Invalid UTF-8 at the cut becomes a replacement char. */
  text(): string {
    if (this.chunks.length === 0) {
      return "";
    }
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Splits a decoded stream into lines without buffering the whole stream. */
export class LineAssembler {
  private pending = "";

  /** Consume text and return every complete line it terminated. */
  push(text: string): string[] {
    this.pending += text;
    const lines: string[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      lines.push(stripCarriageReturn(this.pending.slice(0, newline)));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    return lines;
  }

  /** Return the trailing partial line, when one is buffered. */
  flush(): string | null {
    if (this.pending === "") {
      return null;
    }
    const rest = stripCarriageReturn(this.pending);
    this.pending = "";
    return rest;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export interface ProcessGroupOptions {
  /** Executable path. Never a shell string. */
  executable: string;
  /** Argument vector. Each element stays one argument. */
  args: readonly string[];
  /** Working directory for the child. */
  cwd: string;
  /** Exact environment for the child. Nothing is inherited. */
  env: Readonly<Record<string, string>>;
  /** Text written to stdin before the stream closes. */
  stdinText?: string | undefined;
  /** Wall-time limit in milliseconds. */
  timeoutMs: number;
  /** Grace interval before forced termination. */
  graceMs?: number | undefined;
  /** Time allowed for stream drain after exit. */
  drainMs?: number | undefined;
  /** Per-stream capture bound in bytes. */
  maxCaptureBytes?: number | undefined;
  /** Cancellation signal. Aborting sends SIGINT, then SIGKILL. */
  signal?: AbortSignal | undefined;
  /** Called with decoded stdout text as it arrives. */
  onStdoutText?: ((text: string) => void) | undefined;
  /** Called with decoded stderr text as it arrives. */
  onStderrText?: ((text: string) => void) | undefined;
  /**
   * Best-effort termination of the whole group after the leader exits.
   * Enabled by default because the tree must not outlive the run.
   */
  killGroupOnExit?: boolean | undefined;
}

export interface ProcessGroupResult {
  /** False when the process could not be spawned at all. */
  spawned: boolean;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** True when the first graceful signal ended the process. */
  graceful: boolean;
  /** True when the escalation to SIGKILL was needed. */
  forced: boolean;
  /** Failure reason when the process was never spawned. */
  spawnError: string | null;
  /** Bounded stdout capture, newest bytes retained. */
  stdout: string;
  /** Bounded stderr capture, newest bytes retained. */
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  captureTruncated: boolean;
}

/**
 * Spawn one process group and run it to completion. The returned promise
 * resolves for every outcome, including spawn failure, timeout, and
 * cancellation. It never rejects.
 */
export async function runProcessGroup(
  options: ProcessGroupOptions
): Promise<ProcessGroupResult> {
  const startedAt = Date.now();
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const stdoutCapture = new BoundedCapture(maxCaptureBytes);
  const stderrCapture = new BoundedCapture(maxCaptureBytes);
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: IS_POSIX,
      windowsHide: true
    });
  } catch (error) {
    return finished({
      spawned: false,
      pid: null,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      cancelled: false,
      graceful: false,
      forced: false,
      spawnError: error instanceof Error ? error.message : "spawn failed",
      stdoutCapture,
      stderrCapture
    });
  }

  return await new Promise<ProcessGroupResult>((resolve) => {
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;

    const state = {
      exitCode: null as number | null,
      signal: null as string | null,
      timedOut: false,
      cancelled: false,
      graceful: true,
      forced: false,
      stopping: false,
      settled: false
    };
    let escalateTimer: NodeJS.Timeout | null = null;
    const limitTimers: NodeJS.Timeout[] = [];

    const stop = (reason: "timeout" | "abort"): void => {
      const pid = child.pid;
      if (state.stopping || state.settled || pid === undefined) {
        return;
      }
      state.stopping = true;
      if (reason === "timeout") {
        state.timedOut = true;
      } else {
        state.cancelled = true;
      }
      // Cancellation is interactive, so it starts with SIGINT. A timeout
      // starts with SIGTERM. Both escalate to SIGKILL after the grace
      // interval.
      signalTree(pid, reason === "abort" ? "SIGINT" : "SIGTERM");
      escalateTimer = setTimeout(() => {
        state.graceful = false;
        state.forced = true;
        signalTree(pid, "SIGKILL");
      }, graceMs);
    };

    const onAbort = (): void => {
      stop("abort");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        stop("abort");
      } else {
        options.signal.addEventListener("abort", onAbort);
      }
    }
    if (options.timeoutMs > 0) {
      limitTimers.push(
        setTimeout(() => {
          stop("timeout");
        }, options.timeoutMs)
      );
    }

    if (stdoutStream !== null) {
      stdoutStream.on("data", (chunk: Buffer) => {
        stdoutCapture.append(chunk);
        const text = stdoutDecoder.write(chunk);
        if (options.onStdoutText !== undefined && text !== "") {
          options.onStdoutText(text);
        }
      });
    }
    if (stderrStream !== null) {
      stderrStream.on("data", (chunk: Buffer) => {
        stderrCapture.append(chunk);
        const text = stderrDecoder.write(chunk);
        if (options.onStderrText !== undefined && text !== "") {
          options.onStderrText(text);
        }
      });
    }
    if (stdinStream !== null) {
      if (options.stdinText !== undefined) {
        stdinStream.write(options.stdinText);
      }
      stdinStream.end();
    }

    const settle = (spawnError: string | null): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (escalateTimer !== null) {
        clearTimeout(escalateTimer);
      }
      for (const timer of limitTimers) {
        clearTimeout(timer);
      }
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onAbort);
      }
      const pid = child.pid;
      if (options.killGroupOnExit !== false && pid !== undefined && IS_POSIX) {
        // The leader is gone. Remove anything it left in the group.
        signalTree(pid, "SIGKILL");
      }
      const drains: Promise<void>[] = [];
      if (stdoutStream !== null) {
        drains.push(drainStream(stdoutStream, drainMs));
      }
      if (stderrStream !== null) {
        drains.push(drainStream(stderrStream, drainMs));
      }
      void Promise.all(drains).then(() => {
        if (stdoutStream !== null) {
          stdoutStream.destroy();
        }
        if (stderrStream !== null) {
          stderrStream.destroy();
        }
        if (spawnError !== null) {
          state.exitCode = null;
          state.signal = null;
          state.graceful = false;
        }
        resolve(
          finished({
            spawned: spawnError === null,
            pid: pid ?? null,
            exitCode: state.exitCode,
            signal: state.signal,
            durationMs: Date.now() - startedAt,
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            graceful: state.graceful,
            forced: state.forced,
            spawnError,
            stdoutCapture,
            stderrCapture
          })
        );
      });
    };

    child.on("error", (error: Error) => {
      if (state.stopping) {
        state.graceful = false;
      }
      settle(error.message);
    });

    child.on("exit", (code: number | null, signal: string | null) => {
      state.exitCode = code;
      state.signal = signal;
      settle(null);
    });
  });
}

function finished(init: {
  spawned: boolean;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  graceful: boolean;
  forced: boolean;
  spawnError: string | null;
  stdoutCapture: BoundedCapture;
  stderrCapture: BoundedCapture;
}): ProcessGroupResult {
  return {
    spawned: init.spawned,
    pid: init.pid,
    exitCode: init.exitCode,
    signal: init.signal,
    durationMs: init.durationMs,
    timedOut: init.timedOut,
    cancelled: init.cancelled,
    graceful: init.graceful,
    forced: init.forced,
    spawnError: init.spawnError,
    stdout: init.stdoutCapture.text(),
    stderr: init.stderrCapture.text(),
    stdoutBytes: init.stdoutCapture.bytesSeen,
    stderrBytes: init.stderrCapture.bytesSeen,
    captureTruncated:
      init.stdoutCapture.truncated || init.stderrCapture.truncated
  };
}

/** Wait until a stream ends, closes, fails, or the drain window expires. */
async function drainStream(stream: Readable, drainMs: number): Promise<void> {
  // A short-lived child can end its streams before it exits, so check the
  // terminal states first instead of waiting out the drain window.
  if (stream.readableEnded || stream.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      stream.removeListener("end", finish);
      stream.removeListener("close", finish);
      stream.removeListener("error", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, drainMs);
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

/**
 * Signal the whole descendant tree. The process group is the primary
 * mechanism: one call reaches every member. The explicit walk covers
 * descendants that left the group.
 */
export function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (IS_POSIX) {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is empty or already gone.
    }
  }
  const targets = [pid, ...descendantPids(pid)];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {
      // The process is already gone.
    }
  }
}

/**
 * Walk the Linux process tree below one process. Returns an empty list
 * anywhere else, where the process group already covers the tree.
 */
export function descendantPids(pid: number): number[] {
  if (process.platform !== "linux") {
    return [];
  }
  const found: number[] = [];
  const seen = new Set<number>([pid]);
  let frontier = [pid];
  for (let depth = 0; depth < MAX_DESCENDANT_DEPTH; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const child of readChildren(current)) {
        if (!seen.has(child)) {
          seen.add(child);
          found.push(child);
          next.push(child);
        }
      }
    }
    if (next.length === 0) {
      break;
    }
    frontier = next;
  }
  return found;
}

function readChildren(pid: number): number[] {
  let raw: string;
  try {
    raw = readFileSync(
      `/proc/${pid.toString(10)}/task/${pid.toString(10)}/children`,
      "utf8"
    );
  } catch {
    return [];
  }
  const children: number[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token === "") {
      continue;
    }
    const value = Number.parseInt(token, 10);
    if (Number.isInteger(value) && value > 0) {
      children.push(value);
    }
  }
  return children;
}
