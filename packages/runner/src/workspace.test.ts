import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "@oal/core";

import {
  cleanupRunnerFixtures,
  fixtureContext,
  fixtureFiles,
  loadFixturePack,
  newTempDir
} from "./prompts.test.ts";
import { materializePrompts, type WorkspaceFilePlan } from "./prompts.ts";
import {
  materializeWorkspace,
  verifyWorkspaceFiles,
  WorkspaceCode
} from "./workspace.ts";

afterEach(async () => {
  await cleanupRunnerFixtures();
});

async function expectCode(call: () => Promise<unknown>, code: string) {
  try {
    await call();
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected a failure with code ${code}.`);
}

const SANITIZED_CONTRACT = `${JSON.stringify(
  {
    openapi: "3.1.0",
    info: { title: "Widget API", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:8080" }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          responses: { "200": { description: "Widget list" } }
        }
      }
    }
  },
  null,
  2
)}\n`;

async function materializedPlan() {
  const pack = await loadFixturePack();
  return materializePrompts({
    pack,
    promptSetId: "diagnostic",
    evalId: "list-operations",
    context: fixtureContext()
  });
}

describe("materializeWorkspace", () => {
  it("writes only the declared materials for file visibility", async () => {
    const prompts = await materializedPlan();
    const workspace = await newTempDir();
    const result = await materializeWorkspace({
      workspaceDir: workspace,
      plan: prompts.files,
      contractVisibility: "file",
      sanitizedContract: SANITIZED_CONTRACT
    });

    expect(result.files.map((file) => file.target).sort()).toEqual([
      "AGENTS.md",
      "TASK.md",
      "openapi.json",
      "result.schema.json"
    ]);
    expect(result.gitInitialized).toBe(false);
    expect(result.verifiedSha256).toMatch(/^[a-f0-9]{64}$/);

    const instructions = await readFile(
      path.join(workspace, "AGENTS.md"),
      "utf8"
    );
    expect(instructions).toContain("The contract file is openapi.json.");
    expect(instructions).not.toContain("{{");

    const schemaBytes = await readFile(
      path.join(workspace, "result.schema.json"),
      "utf8"
    );
    expect(schemaBytes).toBe(fixtureFiles()["schemas/result.schema.json"]);

    const contract = await readFile(
      path.join(workspace, "openapi.json"),
      "utf8"
    );
    expect(contract).toBe(SANITIZED_CONTRACT);
  });

  it("skips the contract file for non-file visibility", async () => {
    const prompts = await materializedPlan();
    const workspace = await newTempDir();
    const result = await materializeWorkspace({
      workspaceDir: workspace,
      plan: prompts.files,
      contractVisibility: "tool-only",
      sanitizedContract: SANITIZED_CONTRACT
    });
    expect(result.files.map((file) => file.target)).not.toContain(
      "openapi.json"
    );
  });

  it("requires sanitized bytes when the visibility is file", async () => {
    const prompts = await materializedPlan();
    const workspace = await newTempDir();
    await expectCode(
      () =>
        materializeWorkspace({
          workspaceDir: workspace,
          plan: prompts.files,
          contractVisibility: "file",
          sanitizedContract: null
        }),
      WorkspaceCode.ContractBytesMissing
    );
  });

  it("refuses a non-empty workspace directory", async () => {
    const prompts = await materializedPlan();
    const workspace = await newTempDir();
    await writeFile(path.join(workspace, "stray.txt"), "stray", "utf8");
    await expectCode(
      () =>
        materializeWorkspace({
          workspaceDir: workspace,
          plan: prompts.files,
          contractVisibility: "file",
          sanitizedContract: SANITIZED_CONTRACT
        }),
      WorkspaceCode.NotEmpty
    );
  });

  it("rejects a duplicate target in the plan", async () => {
    const prompts = await materializedPlan();
    const doubled = [...prompts.files, prompts.files[0] as WorkspaceFilePlan];
    await expectCode(
      async () =>
        materializeWorkspace({
          workspaceDir: await newTempDir(),
          plan: doubled,
          contractVisibility: "tool-only",
          sanitizedContract: null
        }),
      WorkspaceCode.TargetDuplicate
    );
  });

  it("rejects a copy source that is not a regular file", async () => {
    const prompts = await materializedPlan();
    const directory = await newTempDir();
    const copy = prompts.files.find((file) => file.text === null);
    const plan: WorkspaceFilePlan[] = [
      {
        target: "copied.md",
        origin: "participant-file",
        source: copy?.source ?? null,
        sourcePath: directory,
        text: null,
        engine: null,
        bytes: 1,
        sha256: sha256Hex("1")
      }
    ];
    await expectCode(
      async () =>
        materializeWorkspace({
          workspaceDir: await newTempDir(),
          plan,
          contractVisibility: "tool-only",
          sanitizedContract: null
        }),
      WorkspaceCode.SourceNotRegular
    );
  });

  it("rejects an unsafe target path", async () => {
    const plan: WorkspaceFilePlan[] = [
      {
        target: "../escape.md",
        origin: "participant-file",
        source: null,
        sourcePath: null,
        text: "escaped",
        engine: "literal",
        bytes: 7,
        sha256: sha256Hex("escaped")
      }
    ];
    await expectCode(
      async () =>
        materializeWorkspace({
          workspaceDir: await newTempDir(),
          plan,
          contractVisibility: "tool-only",
          sanitizedContract: null
        }),
      WorkspaceCode.TargetUnsafe
    );
  });

  it("initializes a fresh git repository and tolerates its directory", async () => {
    const prompts = await materializedPlan();
    const workspace = await newTempDir();
    const result = await materializeWorkspace({
      workspaceDir: workspace,
      plan: prompts.files,
      contractVisibility: "file",
      sanitizedContract: SANITIZED_CONTRACT,
      gitInit: true
    });
    expect(result.gitInitialized).toBe(true);
    const gitDir = await readFile(path.join(workspace, ".git", "HEAD"), "utf8");
    expect(gitDir).toContain("ref:");
  });

  it("reports an undeclared file, a missing file, and a changed digest", async () => {
    const prompts = await materializedPlan();
    const materialize = async (workspace: string) =>
      materializeWorkspace({
        workspaceDir: workspace,
        plan: prompts.files,
        contractVisibility: "file",
        sanitizedContract: SANITIZED_CONTRACT
      });

    const withStray = await newTempDir();
    await materialize(withStray);
    await writeFile(path.join(withStray, "trace.jsonl"), "{}\n", "utf8");
    await expectCode(
      () => verifyWorkspaceFiles(withStray, prompts.files),
      WorkspaceCode.UndeclaredFile
    );

    const changed = await newTempDir();
    const changedResult = await materialize(changed);
    await writeFile(path.join(changed, "AGENTS.md"), "changed", "utf8");
    await expectCode(
      () => verifyWorkspaceFiles(changed, changedResult.files),
      WorkspaceCode.FileModified
    );

    const clean = await newTempDir();
    const cleanResult = await materialize(clean);
    const declared = cleanResult.files;
    const schemaFile = declared.find(
      (file) => file.target === "result.schema.json"
    );
    if (schemaFile === undefined) {
      throw new Error("The fixture plan has no result schema entry.");
    }
    const withoutSchema = declared.filter(
      (file) => file.target !== "result.schema.json"
    );
    const wrongDigest: WorkspaceFilePlan = {
      ...schemaFile,
      sha256: sha256Hex("abcd")
    };
    await expectCode(
      () => verifyWorkspaceFiles(clean, [...withoutSchema, wrongDigest]),
      WorkspaceCode.FileModified
    );
    await rm(path.join(clean, "result.schema.json"));
    await expectCode(
      () => verifyWorkspaceFiles(clean, declared),
      WorkspaceCode.FileMissing
    );
  });
});

describe("end to end participant material", () => {
  it("renders prompts, materializes the workspace, and verifies it", async () => {
    const pack = await loadFixturePack();
    const prompts = materializePrompts({
      pack,
      promptSetId: "diagnostic",
      evalId: "list-operations",
      context: fixtureContext()
    });
    const workspace = await newTempDir();
    const materialized = await materializeWorkspace({
      workspaceDir: workspace,
      plan: prompts.files,
      contractVisibility: "file",
      sanitizedContract: SANITIZED_CONTRACT
    });

    const manifestPlan = [...materialized.files];
    await expect(verifyWorkspaceFiles(workspace, manifestPlan)).resolves.toBe(
      undefined
    );

    const task = await readFile(path.join(workspace, "TASK.md"), "utf8");
    expect(task).toContain("Task list-operations for case widget-list");
    const contract = await readFile(
      path.join(workspace, "openapi.json"),
      "utf8"
    );
    expect(contract).toContain("listWidgets");
  });
});

describe("symlink policy", () => {
  it("rejects a symlink inside the workspace during verification", async () => {
    const workspace = await newTempDir();
    await writeFile(path.join(workspace, "TASK.md"), "task", "utf8");
    await symlink("TASK.md", path.join(workspace, "AGENTS.md"));
    const plan: WorkspaceFilePlan[] = [
      {
        target: "TASK.md",
        origin: "prompt",
        source: "tasks/list/task.md",
        sourcePath: null,
        text: "task",
        engine: "literal",
        bytes: 3,
        sha256: sha256Hex("task")
      }
    ];
    await expectCode(
      () => verifyWorkspaceFiles(workspace, plan),
      WorkspaceCode.UndeclaredSymlink
    );
  });

  it("rejects a symlinked copy source", async () => {
    const packRoot = await loadFixturePack();
    const outside = await newTempDir();
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const prompts = materializePrompts({
      pack: packRoot,
      promptSetId: "diagnostic",
      evalId: "list-operations",
      context: fixtureContext()
    });
    const copy = prompts.files.find((file) => file.text === null);
    expect(copy).toBeDefined();
    await mkdir(path.join(packRoot.root, "schemas"), { recursive: true });
    const linkPath = path.join(packRoot.root, "schemas", "link.json");
    await symlink(path.join(outside, "secret.txt"), linkPath);
    const plan: WorkspaceFilePlan[] = [
      {
        target: "link.json",
        origin: "participant-file",
        source: "schemas/link.json",
        sourcePath: linkPath,
        text: null,
        engine: null,
        bytes: 6,
        sha256: sha256Hex("secret")
      }
    ];
    await expectCode(
      async () =>
        materializeWorkspace({
          workspaceDir: await newTempDir(),
          plan,
          contractVisibility: "tool-only",
          sanitizedContract: null
        }),
      WorkspaceCode.SourceNotRegular
    );
  });
});
