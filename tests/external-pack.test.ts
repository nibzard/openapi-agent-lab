/**
 * Installable archive tests (specification section 48.8, plan
 * SE-P6-01). The archives carry compiled JavaScript because Node
 * refuses to strip types under node_modules. These checks build the
 * archives, install them into a scratch directory outside the
 * workspace, and drive the installed CLI end to end: it must run,
 * author a pack, and validate it while resolving only public
 * imports. The compatibility checks themselves are pinned by unit
 * level cases on the builder's classifier.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import {
  ArchiveCode,
  buildArchives,
  checkImport,
  compileSource,
  dynamicCallsOf,
  staticImportsOf
} from "../scripts/build-archives.mjs";

const run = promisify(execFile);

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** A minimal OpenAPI document the scaffolded pack validates against. */
const OPENAPI_DOCUMENT = `openapi: 3.1.0
info:
  title: Demo API
  version: 1.0.0
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        "200":
          description: The widget list
`;

const unit = {
  name: "@oal/cli",
  isCli: true
};

describe("the archive builder", () => {
  it("classifies imports for public resolution only", () => {
    const archived = new Set(["@oal/core", "@oal/pack"]);
    const codeOf = (specifier: string): string | null => {
      try {
        checkImport(specifier, unit, "/x/src/a.ts", "/x/src", archived);
        return null;
      } catch (cause) {
        return (cause as { readonly code: string }).code;
      }
    };
    expect(codeOf("vitest")).toBe(ArchiveCode.ExternalImport);
    expect(codeOf("../../core/src/id.ts")).toBe(ArchiveCode.EscapingImport);
    expect(codeOf("@oal/core/src/id.ts")).toBe(ArchiveCode.SubpathImport);
    expect(codeOf("@oal/nothing")).toBe(ArchiveCode.UnresolvedImport);
    // Public names, node builtins, and inside-package relatives pass.
    expect(codeOf("@oal/core")).toBeNull();
    expect(codeOf("node:path")).toBeNull();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const relativeCode = (specifier: string): string | null => {
      try {
        checkImport(specifier, unit, path.join(here, "a.ts"), here, archived);
        return null;
      } catch (cause) {
        return (cause as { readonly code: string }).code;
      }
    };
    expect(relativeCode("./stateful-acceptance.map.json")).toBeNull();
  });

  it("detects dynamic calls and rewrites specifiers on compile", () => {
    expect(dynamicCallsOf('const x = await import("./late.ts");')).toEqual([
      "import("
    ]);
    expect(dynamicCallsOf('const r = require("fs");')).toEqual(["require("]);
    expect(staticImportsOf('import { a } from "./b.ts";')).toEqual(["./b.ts"]);
    // A used import survives compilation with a rewritten specifier.
    const compiled = compileSource(
      '#!/usr/bin/env node\nimport { a } from "./b.ts";\nconsole.log(a);\nimport { c } from "../c/d.ts";\nconsole.log(c);\n'
    );
    expect(compiled.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(compiled).toContain('"./b.js"');
    expect(compiled).toContain('"../c/d.js"');
    expect(compiled).not.toContain('.ts"');
  });
});

describe("the installable archives", () => {
  it("packs the CLI, its packages, their schemas, and worker entries", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "oal-archives-"));
    scratch.push(out);
    const { units, tarballs } = await buildArchives(out);
    expect(units.length).toBeGreaterThanOrEqual(30);
    const names = tarballs.map((tarball) => path.basename(tarball));
    expect(names).toContain("oal-cli-0.0.0.tgz");
    expect(names).toContain("oal-pack-0.0.0.tgz");
    expect(names).toContain("oal-core-0.0.0.tgz");
    // The schema set ships beside the compiled code, and the worker
    // entry rides the archive even though imports never reach it.
    expect(
      existsSync(
        path.join(out, "stage", "@oal/pack", "schemas", "pack.v1.schema.json")
      )
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          out,
          "stage",
          "@oal/core",
          "dist",
          "schema",
          "worker-entry.js"
        )
      )
    ).toBe(true);
  }, 120_000);

  it("installs outside the workspace and runs on public imports only", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "oal-archives-"));
    scratch.push(out);
    const { tarballs } = await buildArchives(out);
    const app = await mkdtemp(path.join(tmpdir(), "oal-archive-app-"));
    scratch.push(app);
    await writeFile(
      path.join(app, "package.json"),
      `${JSON.stringify(
        { name: "archive-app", private: true, type: "module" },
        null,
        2
      )}\n`
    );
    await writeFile(path.join(app, "openapi.yaml"), OPENAPI_DOCUMENT);
    // Offline: the archive set is self-contained, and continuous
    // integration touches no registry.
    await run(
      "npm",
      [
        "install",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...tarballs
      ],
      { cwd: app }
    );
    const bin = path.join(app, "node_modules", ".bin", "oal");
    expect(existsSync(bin)).toBe(true);

    // The installed executable answers from its own version command.
    const version = await run(bin, ["version"], { cwd: app });
    expect(version.stdout.trim()).toMatch(/^oal [0-9]/u);

    // It authors a pack and validates it: schema loading, the schema
    // worker, and pack parsing all resolve through public imports.
    await run(
      bin,
      ["pack", "init", "./demo-pack", "--openapi", "openapi.yaml"],
      {
        cwd: app
      }
    );
    const validate = await run(bin, ["pack", "validate", "./demo-pack"], {
      cwd: app
    });
    expect(validate.stdout).toContain("pack: demo-pack");
    expect(validate.stdout).toContain("manifest_sha256:");
    const manifest = await readFile(
      path.join(app, "demo-pack", "pack.yaml"),
      "utf8"
    );
    expect(manifest).toContain("id: demo-pack");
  }, 240_000);

  it("runs the external template end to end through the installed executable", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "oal-archives-"));
    scratch.push(out);
    const { tarballs } = await buildArchives(out);
    const app = await mkdtemp(path.join(tmpdir(), "oal-archive-app-"));
    scratch.push(app);
    await writeFile(
      path.join(app, "package.json"),
      `${JSON.stringify(
        { name: "archive-template-app", private: true, type: "module" },
        null,
        2
      )}\n`
    );
    await run(
      "npm",
      [
        "install",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...tarballs
      ],
      { cwd: app }
    );
    const bin = path.join(app, "node_modules", ".bin", "oal");
    // The tutorial's first step: copy the template beside the
    // install. Its behavior resolves the public packages through the
    // installed node_modules, never through this workspace.
    const packDir = path.join(app, "external-demo");
    await cp(
      path.resolve(import.meta.dirname, "fixtures/external-demo"),
      packDir,
      { recursive: true }
    );

    const validate = await run(bin, ["pack", "validate", packDir], {
      cwd: app
    });
    expect(validate.stdout).toContain("pack: external-demo");

    const reportPath = path.join(app, "corpus-report.json");
    const corpus = await run(
      bin,
      ["corpus", "run", packDir, "--corpus", "demo-core", "--out", reportPath],
      { cwd: app }
    );
    expect(corpus.stdout).toContain("Corpus report written");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      summary: Record<string, number>;
    };
    expect(report.summary).toEqual({
      passed: 4,
      failed: 0,
      skipped: 0,
      error: 0
    });
  }, 300_000);
});
