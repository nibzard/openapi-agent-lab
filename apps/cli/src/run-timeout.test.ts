/**
 * `--timeout` zero handling (review finding B07). A zero duration is
 * parseable, but the command rejects it when it parses the flag, so the
 * operator sees the reason instead of a downstream preflight code.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INVALID } from "@oal/core";

import { main } from "./cli.ts";
import { parseDurationMs } from "./handlers/run.ts";
import { MemoryIo } from "./io.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("--timeout zero", () => {
  it("still parses zero as zero milliseconds", () => {
    expect(parseDurationMs("0")).toBe(0);
    expect(parseDurationMs("0s")).toBe(0);
  });

  it("refuses a zero timeout at parse time", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "oal-run-timeout-"));
    scratchDirectories.push(cwd);
    const io = new MemoryIo();
    const code = await main(
      [
        "run",
        "packs/steel-computer",
        "--eval",
        "basic-lifecycle",
        "--timeout",
        "0"
      ],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain("greater than zero");
  });
});
