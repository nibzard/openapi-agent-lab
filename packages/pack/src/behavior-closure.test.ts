/**
 * Behavior dependency closure tests (specification section 48.8). The
 * closure must hash the complete graph a behavior entrypoint reaches,
 * change identity when any reachable file changes, execute frozen
 * copies that ignore later source edits, and refuse dynamic, ambient,
 * escaping, and unresolved imports.
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  BehaviorClosureCode,
  BehaviorClosureError,
  computeBehaviorClosure,
  freezeBehaviorClosure
} from "./behavior-closure.ts";

const webclipRoot = path.resolve(import.meta.dirname, "../../../packs/webclip");
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** A fresh pack-shaped directory with one behavior entry. */
async function newPack(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oal-closure-"));
  scratch.push(root);
  await writeFile(
    path.join(root, "behavior", "index.ts"),
    'import { word } from "./helper.ts";\n\nexport const value = word;\n',
    { flag: "wx" }
  ).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "behavior"), { recursive: true });
    await writeFile(
      path.join(root, "behavior", "index.ts"),
      'import { word } from "./helper.ts";\n\nexport const value = word;\n'
    );
  });
  await writeFile(
    path.join(root, "behavior", "helper.ts"),
    'export const word = "one";\n'
  );
  return root;
}

async function writeEntry(root: string, source: string): Promise<string> {
  const entry = path.join(root, "behavior", "index.ts");
  await writeFile(entry, source);
  return entry;
}

const entryOf = (root: string): { absolutePath: string; sha256: string } => ({
  absolutePath: path.join(root, "behavior", "index.ts"),
  sha256: "0".repeat(64)
});

describe("the behavior dependency closure", () => {
  it("changes identity when a helper edit changes semantics", async () => {
    const root = await newPack();
    const first = await computeBehaviorClosure(entryOf(root), root);
    // The same graph recomputed keeps the identity: no digest churn.
    const again = await computeBehaviorClosure(entryOf(root), root);
    expect(again.identity).toBe(first.identity);

    const helper = path.join(root, "behavior", "helper.ts");
    await writeFile(helper, 'export const word = "two";\n');
    const second = await computeBehaviorClosure(entryOf(root), root);
    expect(second.identity).not.toBe(first.identity);
    // The helper file itself carries the changed digest, so no old
    // digest is silently reused for the new semantics.
    const helperFile = second.files.find(
      (file) => file.path === "behavior/helper.ts"
    );
    const oldHelperFile = first.files.find(
      (file) => file.path === "behavior/helper.ts"
    );
    expect(helperFile?.sha256).not.toBe(oldHelperFile?.sha256);
  });

  it("executes frozen copies that ignore edits after freezing", async () => {
    const root = await newPack();
    const closure = await computeBehaviorClosure(entryOf(root), root);
    const frozen = await freezeBehaviorClosure(
      closure,
      root,
      path.join(root, ".oal", "frozen", closure.identity)
    );
    // The frozen entry runs and reports the frozen helper.
    const first = (await import(pathToFileURL(frozen.entryPath).href)) as {
      value: string;
    };
    expect(first.value).toBe("one");

    // Edit the source after freezing; the frozen copy still serves the
    // bytes the identity hashed.
    await writeFile(
      path.join(root, "behavior", "helper.ts"),
      'export const word = "two";\n'
    );
    const second = (await import(
      `${pathToFileURL(frozen.entryPath).href}?after-edit`
    )) as { value: string };
    expect(second.value).toBe("one");
  });

  it("refuses a dynamic import", async () => {
    const root = await newPack();
    await writeEntry(
      root,
      'const late = import("./helper.ts");\n\nexport const value = late;\n'
    );
    await expect(
      computeBehaviorClosure(entryOf(root), root)
    ).rejects.toMatchObject({ code: BehaviorClosureCode.DynamicImport });
  });

  it("refuses a require call", async () => {
    const root = await newPack();
    await writeEntry(
      root,
      'const late = require("./helper.ts");\n\nexport const value = late;\n'
    );
    await expect(
      computeBehaviorClosure(entryOf(root), root)
    ).rejects.toMatchObject({ code: BehaviorClosureCode.DynamicImport });
  });

  it("refuses an import that escapes the pack root", async () => {
    const root = await newPack();
    const outside = path.join(path.dirname(root), "outside-helper.ts");
    await writeFile(outside, 'export const word = "outside";\n');
    scratch.push(outside);
    await writeEntry(
      root,
      'import { word } from "../../outside-helper.ts";\n\nexport const value = word;\n'
    );
    await expect(
      computeBehaviorClosure(entryOf(root), root)
    ).rejects.toMatchObject({ code: BehaviorClosureCode.EscapingImport });
  });

  it("refuses ambient dependency resolution", async () => {
    const root = await newPack();
    await writeEntry(
      root,
      'import leftPad from "left-pad";\n\nexport const value = leftPad;\n'
    );
    await expect(
      computeBehaviorClosure(entryOf(root), root)
    ).rejects.toMatchObject({ code: BehaviorClosureCode.AmbientImport });
  });

  it("refuses an import that resolves to no file", async () => {
    const root = await newPack();
    await writeEntry(
      root,
      'import { word } from "./missing.ts";\n\nexport const value = word;\n'
    );
    await expect(
      computeBehaviorClosure(entryOf(root), root)
    ).rejects.toMatchObject({ code: BehaviorClosureCode.UnresolvedImport });
  });

  it("freezes declared public packages with their manifests", async () => {
    const root = await newPack();
    // Link the webclip package links so the public imports resolve
    // exactly as a declared pack resolves them.
    await symlink(
      path.join(webclipRoot, "node_modules"),
      path.join(root, "node_modules"),
      "dir"
    );
    await writeEntry(
      root,
      [
        'import { BehaviorHttpError } from "@oal/behavior-api";',
        'import { word } from "./helper.ts";',
        "",
        "export const value = word;",
        "export const error = new BehaviorHttpError({",
        "  status: 404,",
        '  code: "not_found",',
        "  message: word",
        "});",
        ""
      ].join("\n")
    );
    const closure = await computeBehaviorClosure(entryOf(root), root);
    // The declared package, its manifest, and its transitive graph
    // joined the closure.
    const names = closure.packages.map((pkg) => pkg.name);
    expect(names).toContain("@oal/behavior-api");
    expect(names).toContain("@oal/core");
    const manifest = closure.files.find(
      (file) =>
        file.origin === "package" &&
        file.packageName === "@oal/behavior-api" &&
        file.path === "package.json"
    );
    expect(manifest).toBeDefined();

    const frozen = await freezeBehaviorClosure(
      closure,
      root,
      path.join(root, ".oal", "frozen", closure.identity)
    );
    const frozenSource = await readFile(frozen.entryPath, "utf8");
    // The frozen entry pins the package to a relative path; no bare
    // specifier survives and no node_modules layout is required.
    expect(frozenSource).not.toContain('"@oal/behavior-api"');
    expect(frozenSource).toContain("./packages/@oal/behavior-api/");
    const loaded = (await import(
      `${pathToFileURL(frozen.entryPath).href}?pkg`
    )) as { value: string; error: { status: number } };
    expect(loaded.value).toBe("one");
    expect(loaded.error.status).toBe(404);
  });

  it("reports the refusing file and refuses nothing else silently", async () => {
    const root = await newPack();
    await writeEntry(
      root,
      'import { word } from "./missing.ts";\n\nexport const value = word;\n'
    );
    const error = await computeBehaviorClosure(entryOf(root), root).catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(BehaviorClosureError);
    expect((error as BehaviorClosureError).sourcePath).toBe(
      "behavior/index.ts"
    );
  });
});
