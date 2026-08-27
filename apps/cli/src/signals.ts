import { LIMIT_DEFAULTS } from "@oal/config";

import { EXIT_INFRASTRUCTURE, type ExitCode } from "@oal/core";

/**
 * Tracks operator interruption. The first signal aborts the run-wide
 * AbortController and starts the graceful-termination budget from
 * specification section 31; when the budget expires, or a second signal
 * arrives, the bound forced-exit callback runs with exit code 130 or 143.
 */
export class TerminationGuard {
  private readonly budgetMs: number;
  private readonly controller = new AbortController();
  private signalName: NodeJS.Signals | null = null;
  private forcedExit: ((code: ExitCode) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(budgetMs: number = LIMIT_DEFAULTS.gracefulTerminationMs) {
    this.budgetMs = budgetMs;
  }

  /** Bind the last-resort exit; production binds process.exit. */
  bindForcedExit(callback: (code: ExitCode) => void): void {
    this.forcedExit = callback;
  }

  get receivedSignal(): NodeJS.Signals | null {
    return this.signalName;
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  /** Interruption exit code, or null when no signal was received. */
  exitCode(): 130 | 143 | null {
    if (this.signalName === "SIGINT") {
      return 130;
    }
    if (this.signalName === "SIGTERM") {
      return 143;
    }
    return null;
  }

  handle(signal: NodeJS.Signals): void {
    const first = this.signalName === null;
    this.signalName = signal;
    if (first) {
      this.controller.abort(new Error(`Run interrupted by ${signal}.`));
      this.timer = setTimeout(() => {
        this.forceExit();
      }, this.budgetMs);
      this.timer.unref();
      return;
    }
    this.forceExit();
  }

  private forceExit(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const code = this.exitCode() ?? EXIT_INFRASTRUCTURE;
    this.forcedExit?.(code);
  }
}

/** Install process signal handlers bound to one guard. */
export function installSignalHandlers(guard: TerminationGuard): void {
  guard.bindForcedExit((code) => {
    process.exit(code);
  });
  const handler = (signal: NodeJS.Signals): void => {
    guard.handle(signal);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
