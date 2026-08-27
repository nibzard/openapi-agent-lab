import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BoundedCapture,
  LineAssembler,
  runProcessGroup,
  signalTree
} from "./process.ts";

const NODE = process.execPath;

/** Wait until a file exists and holds content, or fail after a bound. */
async function readWhenReady(path: string, attempts = 50): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const text = await readFile(path, "utf8");
      if (text !== "") {
        return text;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`fixture file never became readable: ${path}`);
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/tmp"
  };
}

describe("runProcessGroup", () => {
  it("captures exit code, duration, and both streams", async () => {
    const result = await runProcessGroup({
      executable: NODE,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 20000
    });
    expect(result.spawned).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(20000);
  });

  it("writes the declared stdin text and the child reads it", async () => {
    const result = await runProcessGroup({
      executable: NODE,
      args: [
        "-e",
        "let text='';process.stdin.setEncoding('utf8');" +
          "process.stdin.on('data',(c)=>{text+=c;});" +
          "process.stdin.on('end',()=>{process.stdout.write(text.trim());});"
      ],
      cwd: tmpdir(),
      env: baseEnv(),
      stdinText: "  launch text  ",
      timeoutMs: 20000
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("launch text");
  });

  it("reports a spawn failure instead of rejecting", async () => {
    const result = await runProcessGroup({
      executable: join(tmpdir(), "definitely-missing-executable"),
      args: [],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 20000
    });
    expect(result.spawned).toBe(false);
    expect(result.spawnError).not.toBeNull();
    expect(result.exitCode).toBeNull();
  });

  it("times out, escalates past an ignored SIGTERM, and reports SIGKILL", async () => {
    const result = await runProcessGroup({
      executable: NODE,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{process.stderr.write('ignored\\n');});" +
          "setInterval(()=>{},50);"
      ],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 250,
      graceMs: 150,
      drainMs: 200
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(result.graceful).toBe(false);
    expect(result.forced).toBe(true);
  });

  it("ends a child that honours SIGTERM without forcing", async () => {
    const result = await runProcessGroup({
      executable: NODE,
      args: ["-e", "setInterval(()=>{},50);"],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 250,
      graceMs: 2000
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(result.forced).toBe(false);
    expect(result.graceful).toBe(true);
  });

  it("cancels through an AbortSignal with SIGINT", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 150);
    const result = await runProcessGroup({
      executable: NODE,
      args: ["-e", "setInterval(()=>{},50);"],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 20000,
      graceMs: 2000,
      signal: controller.signal
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGINT");
  });

  it("terminates a descendant that outlives its parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oal-tree-"));
    const heartbeat = join(dir, "heartbeat.txt");
    const pidFile = join(dir, "pid.txt");
    try {
      const parent = [
        `const { spawn } = require("node:child_process");`,
        `const child = spawn(${JSON.stringify(NODE)}, ["-e", ${JSON.stringify(
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
            `let ticks = 0;`,
            `setInterval(() => {`,
            `  ticks += 1;`,
            `  fs.appendFileSync(${JSON.stringify(heartbeat)}, ticks + "\\n");`,
            `}, 25);`
          ].join("")
        )}], { stdio: "ignore" });`,
        `child.unref();`,
        `setTimeout(() => {`,
        `  process.stdout.write(String(child.pid));`,
        `}, 600);`
      ].join("");
      const result = await runProcessGroup({
        executable: NODE,
        args: ["-e", parent],
        cwd: dir,
        env: baseEnv(),
        timeoutMs: 20000,
        drainMs: 200
      });
      expect(result.exitCode).toBe(0);
      const grandchildPid = Number.parseInt(await readWhenReady(pidFile), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      // Give the descendant time to prove it is alive, then confirm the
      // group kill stopped it.
      const before = (await readFile(heartbeat, "utf8")).split("\n").length;
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      const after = (await readFile(heartbeat, "utf8")).split("\n").length;
      expect(before).toBeGreaterThan(1);
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps capture bounded and reports truncation", async () => {
    const result = await runProcessGroup({
      executable: NODE,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(20000));" +
          "process.stderr.write('y'.repeat(20000));"
      ],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 20000,
      maxCaptureBytes: 512
    });
    expect(result.stdoutBytes).toBe(20000);
    expect(result.stderrBytes).toBe(20000);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(512);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBe(512);
    expect(result.captureTruncated).toBe(true);
    expect(result.stdout).toMatch(/^x+$/);
  });

  it("forwards decoded stream text incrementally", async () => {
    const seen: string[] = [];
    const result = await runProcessGroup({
      executable: NODE,
      args: ["-e", "process.stdout.write('one\\ntwo\\n');"],
      cwd: tmpdir(),
      env: baseEnv(),
      timeoutMs: 20000,
      onStdoutText: (text) => {
        seen.push(text);
      }
    });
    expect(result.exitCode).toBe(0);
    expect(seen.join("")).toBe("one\ntwo\n");
  });
});

describe("signalTree", () => {
  it("ignores an unusable process id", () => {
    expect(() => {
      signalTree(-1, "SIGKILL");
    }).not.toThrow();
  });
});

describe("BoundedCapture", () => {
  it("keeps the newest bytes and reports the dropped total", () => {
    const buffer = new BoundedCapture(8);
    buffer.append(Buffer.from("abcdefgh", "utf8"));
    buffer.append(Buffer.from("ijklmnop", "utf8"));
    expect(buffer.text()).toBe("ijklmnop");
    expect(buffer.bytesSeen).toBe(16);
    expect(buffer.truncated).toBe(true);
  });

  it("keeps the tail of one oversized chunk", () => {
    const buffer = new BoundedCapture(4);
    buffer.append(Buffer.from("0123456789", "utf8"));
    expect(buffer.text()).toBe("6789");
    expect(buffer.bytesSeen).toBe(10);
  });
});

describe("LineAssembler", () => {
  it("splits complete lines and flushes the tail", () => {
    const assembler = new LineAssembler();
    expect(assembler.push("one\ntw")).toEqual(["one"]);
    expect(assembler.push("o\nthree\r\n")).toEqual(["two", "three"]);
    expect(assembler.flush()).toBeNull();
    assembler.push("tail");
    expect(assembler.flush()).toBe("tail");
  });
});
