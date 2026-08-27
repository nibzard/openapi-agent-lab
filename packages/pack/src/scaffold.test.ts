import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { invalidInput } from "@oal/core";

import { PackCode } from "./codes.ts";
import { PACK_DIRECTORIES, safePackId, scaffoldPack } from "./scaffold.ts";
import { validatePack } from "./validate.ts";
import { cleanupPacks, CONTRACT_DOCUMENT, REPO_ROOT } from "./testkit.ts";

const OPENAPI_FIXTURE = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "openapi",
  "minimal.json"
);

const workspaces: string[] = [];

afterEach(async () => {
  await cleanupPacks();
  await Promise.all(
    workspaces
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-pack-scaffold-"));
  workspaces.push(cwd);
  return cwd;
}

describe("scaffoldPack", () => {
  it("writes a pack that loads and validates without errors", async () => {
    const cwd = await workspace();
    const result = await scaffoldPack("widget-pack", {
      openapi: OPENAPI_FIXTURE,
      cwd
    });
    expect(result.id).toBe("widget-pack");
    expect(result.contractEntrypoint).toBe("contract/openapi.json");
    expect(result.files).toContain("pack.yaml");

    const entries = await readdir(result.root, { recursive: true });
    for (const directory of PACK_DIRECTORIES) {
      expect(entries).toContain(directory);
    }

    const validation = await validatePack(result.root);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
    expect(validation.packIr).not.toBeNull();
  });

  it("names the contract copy after the source media type", async () => {
    const cwd = await workspace();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(cwd, "local-openapi.yaml"),
      'openapi: 3.1.0\ninfo:\n  title: Minimal\n  version: 1.0.0\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    );
    const result = await scaffoldPack("yaml-pack", {
      openapi: "local-openapi.yaml",
      cwd
    });
    expect(result.contractEntrypoint).toBe("contract/openapi.yaml");
    const copied = await readFile(
      path.join(result.root, result.contractEntrypoint),
      "utf8"
    );
    expect(copied).toContain("openapi: 3.1.0");
  });

  it("refuses an empty option value", async () => {
    const cwd = await workspace();
    await expect(
      scaffoldPack("widget-pack", { openapi: "", cwd })
    ).rejects.toMatchObject({ code: PackCode.OpenApiMissing });
  });

  it("refuses a missing OpenAPI document", async () => {
    const cwd = await workspace();
    await expect(
      scaffoldPack("widget-pack", { openapi: "missing.json", cwd })
    ).rejects.toMatchObject({ code: PackCode.OpenApiMissing });
  });

  it("refuses a non-empty target directory", async () => {
    const cwd = await workspace();
    await scaffoldPack("widget-pack", { openapi: OPENAPI_FIXTURE, cwd });
    await expect(
      scaffoldPack("widget-pack", { openapi: OPENAPI_FIXTURE, cwd })
    ).rejects.toMatchObject({ code: PackCode.TargetNotEmpty });
  });

  it("refuses an unusable identifier", async () => {
    const cwd = await workspace();
    await expect(
      scaffoldPack("widget-pack", {
        openapi: OPENAPI_FIXTURE,
        cwd,
        id: "has spaces"
      })
    ).rejects.toMatchObject({ code: PackCode.IdUnsafe });
  });

  it("states no mutation or persistence claim in the scaffolded task", async () => {
    const cwd = await workspace();
    const result = await scaffoldPack("widget-pack", {
      openapi: OPENAPI_FIXTURE,
      cwd
    });
    const task = await readFile(
      path.join(result.root, "tasks/smoke/task.md"),
      "utf8"
    );
    expect(task).toContain("Send no requests");
    expect(task).toContain("no claim");
  });
});

describe("safePackId", () => {
  it("normalizes directory names into safe identifiers", () => {
    expect(safePackId("Widget Pack")).toBe("widget-pack");
    expect(safePackId("My Pack 2.1")).toBe("my-pack-2.1");
    expect(safePackId("  .hidden#dir  ")).toBe("hidden-dir");
  });

  it("rejects names that clean to nothing usable", () => {
    expect(safePackId("...")).toBeNull();
    expect(safePackId("***")).toBeNull();
  });

  it("keeps the invalidInput category for unsafe identifiers", () => {
    const error = invalidInput(PackCode.IdUnsafe, "bad id");
    expect(error.exitCode).toBe(2);
    expect(error.category).toBe("input");
  });
});

describe("fixture contract document", () => {
  it("declares the operations the tests rely on", () => {
    const paths = CONTRACT_DOCUMENT["paths"] as Record<string, unknown>;
    expect(Object.keys(paths)).toEqual(["/widgets"]);
    const item = paths["/widgets"] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(["get", "post"]);
  });
});
