import { describe, expect, it } from "vitest";

import { LIMIT_DEFAULTS } from "@oal/config";

import { MemoryIo } from "./io.ts";
import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("termination guard", () => {
  it("maps SIGINT and SIGTERM to exit codes 130 and 143", () => {
    const guard = new TerminationGuard();
    expect(guard.exitCode()).toBeNull();
    expect(guard.receivedSignal).toBeNull();
    guard.handle("SIGINT");
    expect(guard.exitCode()).toBe(130);
    expect(guard.receivedSignal).toBe("SIGINT");
    const second = new TerminationGuard();
    second.handle("SIGTERM");
    expect(second.exitCode()).toBe(143);
  });

  it("aborts the run-wide signal on first interruption", () => {
    const guard = new TerminationGuard();
    expect(guard.abortSignal.aborted).toBe(false);
    guard.handle("SIGTERM");
    expect(guard.abortSignal.aborted).toBe(true);
  });

  it("forces exit only after the graceful budget expires", async () => {
    const exits: number[] = [];
    const guard = new TerminationGuard(30);
    guard.bindForcedExit((code) => exits.push(code));
    guard.handle("SIGINT");
    expect(exits).toEqual([]);
    await sleep(60);
    expect(exits).toEqual([130]);
  });

  it("forces exit immediately on a second signal", () => {
    const exits: number[] = [];
    const guard = new TerminationGuard(5_000);
    guard.bindForcedExit((code) => exits.push(code));
    guard.handle("SIGINT");
    guard.handle("SIGINT");
    expect(exits).toEqual([130]);
  });

  it("uses the specification graceful budget by default", () => {
    expect(LIMIT_DEFAULTS.gracefulTerminationMs).toBe(5_000);
  });
});

describe("interruption precedence in main", () => {
  it("overrides a successful handler result with the signal code", async () => {
    const io = new MemoryIo();
    const guard = new TerminationGuard(60_000);
    guard.handle("SIGINT");
    const code = await main(["version"], io, { guard });
    expect(code).toBe(130);
  });

  it("overrides a failure result with the signal code", async () => {
    const io = new MemoryIo();
    const guard = new TerminationGuard(60_000);
    guard.handle("SIGTERM");
    const code = await main(["inspect", "/nonexistent-source.json"], io, {
      guard
    });
    expect(code).toBe(143);
  });
});
