import { describe, expect, it } from "vitest";

import {
  argvTokenSourceFromContext,
  expandArgument,
  expandArgv,
  listArgumentTokens,
  ARGV_TOKEN_UNKNOWN,
  ARGV_TOKEN_UNRESOLVED
} from "./argv.ts";
import type { AgentRunContext } from "./types.ts";

function source(): {
  instructions?: string | undefined;
  task: string;
  launch: string;
  workspaceDir: string;
  homeDir: string;
  temporaryDir: string;
  resultSchemaPath?: string | undefined;
  baseUrl?: string | undefined;
} {
  return {
    instructions: "Follow the contract.",
    task: "Create one computer and report its id.",
    launch: "seq 1",
    workspaceDir: "/run/ws",
    homeDir: "/run/home",
    temporaryDir: "/run/tmp",
    resultSchemaPath: "/run/tmp/result.schema.json",
    baseUrl: "http://127.0.0.1:8081/api"
  };
}

describe("expandArgv", () => {
  it("expands every declared token into the same element", () => {
    const result = expandArgv(
      [
        "run",
        "--prompt",
        "{task}",
        "--workspace",
        "{workspace}",
        "--home",
        "{home}",
        "--tmp",
        "{tmpdir}",
        "--schema",
        "{resultSchema}",
        "--api",
        "{baseUrl}",
        "--docs",
        "{documentationUrl}",
        "--instructions",
        "{instructions}",
        "--launch",
        "{launch}"
      ],
      { ...source(), documentationUrl: "http://127.0.0.1:8081/docs" }
    );
    expect(result.argv).toEqual([
      "run",
      "--prompt",
      "Create one computer and report its id.",
      "--workspace",
      "/run/ws",
      "--home",
      "/run/home",
      "--tmp",
      "/run/tmp",
      "--schema",
      "/run/tmp/result.schema.json",
      "--api",
      "http://127.0.0.1:8081/api",
      "--docs",
      "http://127.0.0.1:8081/docs",
      "--instructions",
      "Follow the contract.",
      "--launch",
      "seq 1"
    ]);
    expect(result.usedTokens).toEqual([
      "task",
      "workspace",
      "home",
      "tmpdir",
      "resultSchema",
      "baseUrl",
      "documentationUrl",
      "instructions",
      "launch"
    ]);
  });

  it("keeps a value with quotes and spaces as exactly one element", () => {
    const injection = 'task"; rm -rf /; echo "';
    const result = expandArgv(["--prompt", "{task}"], {
      ...source(),
      task: injection
    });
    expect(result.argv).toEqual(["--prompt", injection]);
    expect(result.argv).toHaveLength(2);
  });

  it("keeps a value that itself looks like a token unexpanded", () => {
    const result = expandArgv(["{task}"], {
      ...source(),
      task: "{workspace}"
    });
    expect(result.argv).toEqual(["{workspace}"]);
  });

  it("rejects an unknown placeholder", () => {
    expect(() => expandArgv(["{nope}"], source())).toThrowError(
      /Unknown argv placeholder/
    );
    try {
      expandArgv(["--x", "{nope}"], source());
      expect.unreachable("expandArgv must throw");
    } catch (error) {
      expect(error instanceof Error && "code" in error).toBe(true);
      const coded = error as { code: string };
      expect(coded.code).toBe(ARGV_TOKEN_UNKNOWN);
    }
  });

  it("rejects a declared token with no value", () => {
    expect(() =>
      expandArgv(["--schema", "{resultSchema}"], {
        ...source(),
        resultSchemaPath: undefined
      })
    ).toThrowError(/has no value in this run context/);
    try {
      expandArgv(["{resultSchema}"], { ...source(), resultSchemaPath: "" });
      expect.unreachable("expandArgv must throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe(ARGV_TOKEN_UNRESOLVED);
    }
  });

  it("leaves a plain argument unchanged", () => {
    const result = expandArgv(["--json", "-", ""], source());
    expect(result.argv).toEqual(["--json", "-", ""]);
    expect(result.usedTokens).toEqual([]);
  });
});

describe("expandArgument", () => {
  it("expands two tokens inside one element", () => {
    const result = expandArgument("{workspace}:{task}", source());
    expect(result.value).toBe("/run/ws:Create one computer and report its id.");
  });
});

describe("listArgumentTokens", () => {
  it("lists unique token names without resolving them", () => {
    expect(listArgumentTokens("{task} then {task} {home}")).toEqual([
      "task",
      "home"
    ]);
    expect(listArgumentTokens("plain")).toEqual([]);
  });
});

describe("argvTokenSourceFromContext", () => {
  it("maps the run context onto the token source", () => {
    const context = {
      runId: "run_1",
      workspaceDir: "/run/ws",
      syntheticHomeDir: "/run/home",
      temporaryDir: "/run/tmp",
      prompts: {
        instructions: "Follow the contract.",
        task: "Do the task.",
        launch: "seq 1"
      },
      resultSchemaPath: "/run/tmp/schema.json",
      exposure: {
        mode: "raw-http" as const,
        baseUrl: "http://127.0.0.1:9/api",
        documentationUrl: "http://127.0.0.1:9/docs"
      },
      launcherEnvironment: {},
      toolEnvironment: {},
      toolExecutionPolicy: {
        inheritEnvironment: "none" as const,
        allowedEnvironmentNames: [],
        network: "mock-only" as const,
        filesystem: "workspace-only" as const
      },
      timeoutMs: 1000
    } satisfies AgentRunContext;
    expect(argvTokenSourceFromContext(context)).toEqual({
      instructions: "Follow the contract.",
      task: "Do the task.",
      launch: "seq 1",
      workspaceDir: "/run/ws",
      homeDir: "/run/home",
      temporaryDir: "/run/tmp",
      resultSchemaPath: "/run/tmp/schema.json",
      baseUrl: "http://127.0.0.1:9/api",
      documentationUrl: "http://127.0.0.1:9/docs"
    });
  });
});
