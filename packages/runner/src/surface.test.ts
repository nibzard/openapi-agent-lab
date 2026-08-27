import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  parseJsonStrict,
  SchemaValidator,
  type JsonObject
} from "@oal/core";

import {
  cleanupRunnerFixtures,
  fixtureContext,
  loadFixturePack,
  newTempDir
} from "./prompts.test.ts";
import { materializePrompts, type WorkspaceFilePlan } from "./prompts.ts";
import {
  compileSurfaceManifest,
  CONTRACT_TRANSFORMATION,
  SurfaceCode,
  verifySurface
} from "./surface.ts";
import { materializeWorkspace } from "./workspace.ts";

const SCHEMA_PATH = join(
  process.cwd(),
  "schemas",
  "participant-surface-manifest.v1.schema.json"
);

const SANITIZED_CONTRACT = `${JSON.stringify(
  {
    openapi: "3.1.0",
    info: { title: "Widget API", version: "1.0.0" },
    paths: {}
  },
  null,
  2
)}\n`;

const SECRET_VALUE = "oal_run_secret_1";

afterEach(async () => {
  await cleanupRunnerFixtures();
});

async function fixtureSurface() {
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
  return { prompts, materialized, workspace };
}

function options(files: readonly WorkspaceFilePlan[]) {
  return {
    cellId: "cell-file-diagnostic",
    runId: "r-7f3a91",
    isTemplate: false,
    files,
    contractRoutes: [
      {
        method: "GET",
        path: "/openapi.json",
        catalogSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        maxBytes: 65536
      }
    ],
    responseCatalogs: [
      {
        id: "widgets",
        operationKey: "path:GET /widgets",
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        maxBytes: 4096
      }
    ],
    environmentNames: [
      { name: "OAL_BASE_URL", source: "participant.environment" },
      { name: "PATH", source: "participant.environment" }
    ],
    credentialShapes: [
      {
        id: "widget-key",
        scheme: "apiKey",
        location: "header",
        environmentName: "OAL_WIDGET_KEY"
      }
    ],
    tools: [{ name: "list_widgets", catalogSha256: null, maxBytes: 2048 }],
    messageKinds: [
      { kind: "sandbox_denial", source: "adapter-generic", maxBytes: 512 }
    ]
  };
}

describe("compileSurfaceManifest", () => {
  it("conforms to participant-surface-manifest.v1.schema.json", async () => {
    const { materialized } = await fixtureSurface();
    const { manifest } = compileSurfaceManifest(options(materialized.files));

    const schema = parseJsonStrict(await readFile(SCHEMA_PATH, "utf8"), {
      maxBytes: 1_048_576
    });
    const violations = new SchemaValidator(schema).errors(manifest);
    expect(violations).toEqual([]);

    expect(manifest["schema_version"]).toBe(1);
    expect(manifest["kind"]).toBe("ParticipantSurfaceManifest");
    expect(manifest["template"]).toBe(false);
    expect(manifest["rendered_sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records every channel exactly once with stable identifiers", async () => {
    const { materialized } = await fixtureSurface();
    const { manifest } = compileSurfaceManifest(options(materialized.files));
    const entries = manifest["entries"] as JsonObject[];

    expect(entries.map((entry) => entry["id"])).toEqual([
      "workspace-root",
      "file-AGENTS.md",
      "file-TASK.md",
      "file-result.schema.json",
      "file-openapi.json",
      "route-GET-openapi.json",
      "catalog-widgets",
      "env-OAL_BASE_URL",
      "env-PATH",
      "credential-widget-key",
      "tool-list_widgets",
      "message-sandbox_denial"
    ]);
    expect(entries.map((entry) => entry["channel"])).toEqual([
      "workspace",
      "file",
      "file",
      "file",
      "file",
      "http-route",
      "http-route",
      "environment",
      "environment",
      "credential",
      "tool",
      "message"
    ]);
    const contract = entries.find(
      (entry) => entry["id"] === "file-openapi.json"
    );
    expect(contract?.["provenance_class"]).toBe("contractual");
    expect(contract?.["transformation"]).toBe(CONTRACT_TRANSFORMATION);
    expect(contract?.["catalog_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    const task = entries.find((entry) => entry["id"] === "file-TASK.md");
    expect(task?.["provenance_class"]).toBe("task_essential");
    expect(task?.["transformation"]).toBe("render:mustache-strict");
    const schema = entries.find(
      (entry) => entry["id"] === "file-result.schema.json"
    );
    expect(schema?.["transformation"]).toBe("byte-copy");
  });

  it("records names and shapes but never a value", async () => {
    const { materialized } = await fixtureSurface();
    const { manifest } = compileSurfaceManifest(options(materialized.files));
    const text = canonicalJson(manifest);
    expect(text).not.toContain(SECRET_VALUE);
    const credential = (manifest["entries"] as JsonObject[]).find(
      (entry) => entry["channel"] === "credential"
    );
    expect(credential?.["bytes"]).toBeNull();
    expect(credential?.["catalog_sha256"]).toBeNull();
    expect(credential?.["transformation"]).toBe("shape:header");
  });

  it("leaves the digest null for the pre-localization template", async () => {
    const { materialized } = await fixtureSurface();
    const template = compileSurfaceManifest({
      ...options(materialized.files),
      isTemplate: true,
      runId: null
    });
    expect(template.manifest["template"]).toBe(true);
    expect(template.manifest["rendered_sha256"]).toBeNull();
    expect(template.manifest["run_id"]).toBeNull();
    const rendered = compileSurfaceManifest(options(materialized.files));
    expect(rendered.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a duplicate entry identifier and an unsafe one", async () => {
    const { materialized } = await fixtureSurface();
    const base = options(materialized.files);
    expect(() =>
      compileSurfaceManifest({
        ...base,
        tools: [
          { name: "list_widgets", catalogSha256: null, maxBytes: 1 },
          { name: "list_widgets", catalogSha256: null, maxBytes: 1 }
        ]
      })
    ).toThrowError(/identifier/);
    expect(() =>
      compileSurfaceManifest({
        ...base,
        contractRoutes: [
          {
            method: "GET",
            path: "/openapi.json",
            catalogSha256: null,
            maxBytes: 0
          }
        ]
      })
    ).toThrowError(/max_bytes/);
  });
});

describe("verifySurface", () => {
  it("accepts an archived workspace that matches the manifest", async () => {
    const { materialized, workspace } = await fixtureSurface();
    const { manifest } = compileSurfaceManifest(options(materialized.files));
    expect(await verifySurface(manifest, workspace)).toEqual([]);
  });

  it("tolerates a git directory in the archive", async () => {
    const { materialized, workspace } = await fixtureSurface();
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    const { manifest } = compileSurfaceManifest(options(materialized.files));
    expect(await verifySurface(manifest, workspace)).toEqual([]);
  });

  it("reports a missing, an extra, and a modified file", async () => {
    const { materialized, workspace } = await fixtureSurface();
    const { manifest } = compileSurfaceManifest(options(materialized.files));
    const original = await readFile(join(workspace, "TASK.md"), "utf8");

    await writeFile(join(workspace, "TASK.md"), "changed task", "utf8");
    let problems = await verifySurface(manifest, workspace);
    expect(problems.map((problem) => problem.code)).toEqual([
      SurfaceCode.FileModified
    ]);
    expect(problems[0]?.path).toBe("TASK.md");

    await writeFile(join(workspace, "TASK.md"), original, "utf8");
    await writeFile(join(workspace, "extra.txt"), "extra", "utf8");
    problems = await verifySurface(manifest, workspace);
    expect(problems.map((problem) => problem.code)).toEqual([
      SurfaceCode.FileUndeclared
    ]);
    expect(problems[0]?.path).toBe("extra.txt");

    await rm(join(workspace, "extra.txt"));
    await rm(join(workspace, "TASK.md"));
    problems = await verifySurface(manifest, workspace);
    expect(problems.map((problem) => problem.code)).toEqual([
      SurfaceCode.FileMissing
    ]);
    expect(problems[0]?.path).toBe("TASK.md");
  });
});
