import type { Readable } from "node:stream";

/**
 * Output abstraction. Handlers write one text chunk per call; the process
 * implementation appends a newline and maps EPIPE to a clean exit so
 * `oal inspect x | head -1` never reports a pipe failure.
 */
export interface Io {
  /** Write one text chunk to stdout followed by a newline. */
  stdout(text: string): void;
  /** Write one diagnostic line to stderr followed by a newline. */
  stderr(text: string): void;
  /** Byte source used when a source argument is "-". */
  readonly stdin: Readable | undefined;
  /** True when stdout is an interactive terminal. */
  readonly stdoutIsTTY: boolean;
}

function isEpipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  );
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  try {
    stream.write(line);
  } catch (error) {
    if (!isEpipe(error)) {
      throw error;
    }
  }
}

let pipeGuardsInstalled = false;

function installPipeGuards(): void {
  if (pipeGuardsInstalled) {
    return;
  }
  pipeGuardsInstalled = true;
  const exitClean = (error: unknown): void => {
    if (isEpipe(error)) {
      // The reader closed the pipe: flush happened, so exit successfully.
      process.exit(0);
    }
    throw error;
  };
  process.stdout.on("error", exitClean);
  process.stderr.on("error", exitClean);
}

/** Io bound to the real process streams. */
export function createProcessIo(): Io {
  installPipeGuards();
  return {
    stdout: (text: string): void => {
      writeLine(process.stdout, text);
    },
    stderr: (text: string): void => {
      writeLine(process.stderr, text);
    },
    stdin: process.stdin,
    stdoutIsTTY: process.stdout.isTTY
  };
}

/** In-memory Io for tests: every written chunk is captured verbatim. */
export class MemoryIo implements Io {
  readonly stdoutChunks: string[] = [];
  readonly stderrChunks: string[] = [];
  readonly stdin: Readable | undefined;
  readonly stdoutIsTTY = false;

  constructor(stdin?: Readable) {
    this.stdin = stdin;
  }

  stdout(text: string): void {
    this.stdoutChunks.push(text);
  }

  stderr(text: string): void {
    this.stderrChunks.push(text);
  }

  stdoutText(): string {
    return this.stdoutChunks.join("");
  }

  stderrText(): string {
    return this.stderrChunks.join("");
  }
}
