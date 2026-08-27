import { describe, expect, it } from "vitest";
import {
  diagnostic,
  EXIT_EVAL_THRESHOLD,
  EXIT_INFRASTRUCTURE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  EXIT_SIGINT,
  infrastructure,
  invalidInput,
  OalError,
  unsupported
} from "@oal/core";

import { main, type MainOptions } from "./cli.ts";
import { emitDiagnostics } from "./diagnostics.ts";
import {
  COMMAND_REGISTRY,
  createCommandRegistry,
  type CommandHandler,
  type CommandSpec
} from "./commands.ts";
import { MemoryIo } from "./io.ts";
import { TerminationGuard } from "./signals.ts";

function failingCommand(action: () => unknown): CommandSpec[] {
  const handler: CommandHandler = () => {
    action();
    return Promise.resolve(EXIT_OK);
  };
  return [
    {
      name: "probe",
      summary: "Probe command used by tests.",
      arguments: [],
      options: [],
      handler
    }
  ];
}

const PROBE_REGISTRY = createCommandRegistry(failingCommand(() => undefined));

describe("exit code mapping", () => {
  it("returns 0 on success", async () => {
    const io = new MemoryIo();
    const code = await main(["version"], io);
    expect(code).toBe(EXIT_OK);
  });

  it("maps invalid input to 2", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw invalidInput("OAL-CONFIG-INVALID", "Broken input.");
        })
      )
    };
    const io = new MemoryIo();
    const code = await main(["probe"], io, options);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrChunks[0]).toContain("OAL-CONFIG-INVALID");
  });

  it("maps unsupported capability to 4", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw unsupported(
            "OAL-CAP-CALLBACK-UNSUPPORTED",
            "Callbacks are unsupported."
          );
        })
      )
    };
    const io = new MemoryIo();
    await expect(main(["probe"], io, options)).resolves.toBe(EXIT_UNSUPPORTED);
  });

  it("maps infrastructure failure to 3", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw infrastructure("OAL-PORT-BIND-FAILED", "Port busy.");
        })
      )
    };
    const io = new MemoryIo();
    await expect(main(["probe"], io, options)).resolves.toBe(
      EXIT_INFRASTRUCTURE
    );
  });

  it("maps evaluation threshold failure to 5", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw new OalError({
            code: "OAL-CHECK-FAILED",
            message: "Required check failed.",
            category: "evaluation",
            exitCode: EXIT_EVAL_THRESHOLD
          });
        })
      )
    };
    const io = new MemoryIo();
    await expect(main(["probe"], io, options)).resolves.toBe(
      EXIT_EVAL_THRESHOLD
    );
  });

  it("maps unknown exceptions to 3 with OAL-INTERNAL", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw new Error("unexpected boom");
        })
      )
    };
    const io = new MemoryIo();
    const code = await main(["probe"], io, options);
    expect(code).toBe(EXIT_INFRASTRUCTURE);
    expect(io.stderrChunks[0]).toContain("OAL-INTERNAL");
    expect(io.stderrChunks[0]).toContain("unexpected boom");
  });

  it("gives interruption precedence over a failed handler", async () => {
    const options: MainOptions = {
      registry: createCommandRegistry(
        failingCommand(() => {
          throw invalidInput("OAL-CONFIG-INVALID", "Broken input.");
        })
      ),
      guard: new TerminationGuard(60_000)
    };
    options.guard?.handle("SIGINT");
    const io = new MemoryIo();
    const code = await main(["probe"], io, options);
    expect(code).toBe(EXIT_SIGINT);
  });
});

describe("shell behavior", () => {
  it("prints name and version for --version and oal version", async () => {
    const flag = new MemoryIo();
    await expect(main(["--version"], flag)).resolves.toBe(0);
    expect(flag.stdoutChunks).toEqual(["oal 0.1.0"]);
    const command = new MemoryIo();
    await expect(main(["version"], command)).resolves.toBe(0);
    expect(command.stdoutChunks).toEqual(["oal 0.1.0"]);
  });

  it("prints a JSON version object with --format json", async () => {
    const io = new MemoryIo();
    await main(["version", "--format", "json"], io);
    expect(JSON.parse(io.stdoutChunks[0] ?? "")).toEqual({
      name: "oal",
      version: "0.1.0"
    });
  });

  it("shows top-level help for --help, -h, and oal help", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const io = new MemoryIo();
      await expect(main(argv, io)).resolves.toBe(0);
      expect(io.stdoutChunks.length).toBe(1);
      expect(io.stdoutChunks[0]).toContain("Usage:");
    }
  });

  it("shows command help for oal help <command> and <command> --help", async () => {
    const viaHelp = new MemoryIo();
    await main(["help", "pack", "init"], viaHelp);
    expect(viaHelp.stdoutChunks[0]).toContain("oal pack init <directory>");
    const viaFlag = new MemoryIo();
    await main(["inspect", "--help"], viaFlag);
    expect(viaFlag.stdoutChunks[0]).toContain("oal inspect <source>");
  });

  it("exits 2 with a suggestion for an unknown command", async () => {
    const io = new MemoryIo();
    await expect(main(["inspct", "doc.json"], io)).resolves.toBe(2);
    expect(io.stderrChunks[0]).toContain("OAL-CLI-UNKNOWN-COMMAND");
    expect(io.stderrChunks[0]).toContain('Did you mean "inspect"');
  });

  it("exits 2 for a bare invocation with usage on stderr", async () => {
    const io = new MemoryIo();
    await expect(main([], io)).resolves.toBe(2);
    expect(io.stdoutChunks).toEqual([]);
    expect(io.stderrChunks[0]).toContain("Usage: oal <command>");
  });

  it("exits 3 with a clear diagnostic for stub commands", async () => {
    for (const argv of [
      ["serve", "doc.json"],
      ["eval", "init", "."],
      ["study", "run", "."],
      ["workflow", "run", "."]
    ]) {
      const io = new MemoryIo();
      await expect(main(argv, io)).resolves.toBe(3);
      expect(io.stderrChunks[0]).toContain("OAL-NOT-IMPLEMENTED");
      expect(io.stderrChunks[0]).toContain("not implemented in this build");
    }
  });

  it("emits stub diagnostics as one JSON line under --format json", async () => {
    const io = new MemoryIo();
    await main(["doctor", "--format", "json"], io);
    expect(io.stderrChunks.length).toBe(1);
    const record = JSON.parse(io.stderrChunks[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record["code"]).toBe("OAL-NOT-IMPLEMENTED");
    expect(record["severity"]).toBe("error");
  });

  it("keeps stdout empty for every failure path", async () => {
    const cases: readonly string[][] = [
      ["bogus"],
      ["inspect", "--bogus"],
      ["inspect"],
      ["serve", "doc.json"]
    ];
    for (const argv of cases) {
      const io = new MemoryIo();
      await main(argv, io);
      expect(io.stdoutChunks).toEqual([]);
    }
  });

  it("parses flags declared only on later-milestone commands", async () => {
    const io = new MemoryIo();
    await main(
      [
        "run",
        "pack",
        "--eval",
        "create-issue",
        "--count",
        "2",
        "--dry-run",
        "--no-fail-on-eval"
      ],
      io
    );
    expect(io.stderrChunks[0]).toContain("oal run is not implemented");
  });

  it("uses the shared command registry by default", () => {
    expect(PROBE_REGISTRY).not.toBe(COMMAND_REGISTRY);
    expect(COMMAND_REGISTRY.resolve("inspect")?.name).toBe("inspect");
  });
});

describe("diagnostic emission", () => {
  const entries = [
    diagnostic({
      severity: "info",
      phase: "preflight",
      code: "OAL-INFO",
      message: "Progress note."
    }),
    diagnostic({
      severity: "warning",
      phase: "compile",
      code: "OAL-CAP-SCHEMA-APPROXIMATED",
      message: "Schema approximated.",
      json_pointer: "#/paths/~1widgets/get"
    }),
    diagnostic({
      severity: "error",
      phase: "ingest",
      code: "OAL-INPUT-MISSING",
      message: "Source file not found."
    })
  ];

  it("shows warnings and errors by default", () => {
    const io = new MemoryIo();
    emitDiagnostics(
      io,
      { format: "terminal", verbose: false, quiet: false },
      entries
    );
    expect(io.stderrChunks).toEqual([
      "OAL-CAP-SCHEMA-APPROXIMATED: Schema approximated. (#/paths/~1widgets/get)",
      "OAL-INPUT-MISSING: Source file not found."
    ]);
  });

  it("shows every entry with --verbose and errors only with --quiet", () => {
    const verbose = new MemoryIo();
    emitDiagnostics(
      verbose,
      { format: "terminal", verbose: true, quiet: false },
      entries
    );
    expect(verbose.stderrChunks.length).toBe(3);
    const quiet = new MemoryIo();
    emitDiagnostics(
      quiet,
      { format: "terminal", verbose: false, quiet: true },
      entries
    );
    expect(quiet.stderrChunks).toEqual([
      "OAL-INPUT-MISSING: Source file not found."
    ]);
  });

  it("serializes one JSON line per entry in JSON format", () => {
    const io = new MemoryIo();
    emitDiagnostics(
      io,
      { format: "json", verbose: true, quiet: false },
      entries
    );
    expect(io.stderrChunks.length).toBe(3);
    for (const line of io.stderrChunks) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeDefined();
    }
    expect(JSON.parse(io.stderrChunks[1] ?? "")).toMatchObject({
      severity: "warning",
      phase: "compile",
      code: "OAL-CAP-SCHEMA-APPROXIMATED",
      json_pointer: "#/paths/~1widgets/get",
      document_uri: null,
      operation_key: null
    });
  });
});
