#!/usr/bin/env node
/**
 * Build installable archives of the CLI and every package it
 * requires (specification section 48.8, plan SE-P6-01). Node refuses
 * to strip types under node_modules, so an installed archive must
 * carry compiled JavaScript: every source file is transpiled in
 * isolation and every relative `.ts` specifier becomes `.js`.
 *
 * The builder reuses the closure discipline of SE-P1-02: it walks
 * static imports only, refuses dynamic imports and require calls,
 * refuses relative imports that escape their package root, and
 * refuses every import that is not a relative path, a node builtin,
 * or the public name of an archived package. That is the
 * compatibility check: archives resolve only public imports.
 *
 * Usage: node scripts/build-archives.mjs [--out DIR]
 * Default output: dist/archives/*.tgz plus the staging tree.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = path.join(ROOT, "apps", "cli");
const PACKAGES_DIR = path.join(ROOT, "packages");

/** Refusal codes of the archive build. */
export const ArchiveCode = {
  DynamicImport: "OAL-ARCHIVE-DYNAMIC-IMPORT",
  EscapingImport: "OAL-ARCHIVE-ESCAPING-IMPORT",
  ExternalImport: "OAL-ARCHIVE-EXTERNAL-IMPORT",
  SubpathImport: "OAL-ARCHIVE-SUBPATH-IMPORT",
  UnresolvedImport: "OAL-ARCHIVE-UNRESOLVED-IMPORT",
  MissingEntry: "OAL-ARCHIVE-MISSING-ENTRY"
};

/**
 * One archive unit: a workspace package or the CLI application.
 *
 * @typedef {{name: string, version: string, directory: string, isCli: boolean}} ArchiveUnit
 */

/** A refusal raised by the compatibility checks. */
export class ArchiveBuildError extends Error {
  constructor(code, sourcePath, message) {
    super(message);
    this.code = code;
    this.sourcePath = sourcePath;
    this.name = "ArchiveBuildError";
  }
}

/** Every static import specifier of one module source. */
export function staticImportsOf(source) {
  const found = [];
  const push = (specifier) => {
    if (specifier !== undefined) {
      found.push(specifier);
    }
  };
  for (const match of source.matchAll(
    /(?:^|[\s;}])import\s+[^;]*?from\s*["']([^"'\n]+)["']/gu
  )) {
    push(match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s;}])export\s+[^;]*?from\s*["']([^"'\n]+)["']/gu
  )) {
    push(match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s;}])import\s*["']([^"'\n]+)["']/gu
  )) {
    push(match[1]);
  }
  return found;
}

/** The dynamic import and require call sites of one source, if any. */
export function dynamicCallsOf(source) {
  const found = [];
  for (const match of source.matchAll(/\bimport\s*\(/gu)) {
    found.push(match[0]);
  }
  for (const match of source.matchAll(/\brequire\s*\(/gu)) {
    found.push(match[0]);
  }
  return found;
}

/** Node builtins the sources may import without a node: prefix. */
const NODE_BUILTINS = new Set([
  "assert",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "string_decoder",
  "timers",
  "url",
  "util",
  "worker_threads"
]);

/**
 * Classify one import of one archived source. Relative imports must
 * stay inside their unit and resolve; everything else must be a node
 * builtin or the bare public name of an archived package.
 */
export function checkImport(specifier, unit, fromFile, srcRoot, archivedNames) {
  if (specifier.startsWith(".")) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    // The escape verdict comes first: an escaping path is escaping
    // whether or not it happens to resolve.
    const relative = path.relative(srcRoot, base);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ArchiveBuildError(
        ArchiveCode.EscapingImport,
        `${unit.name}/src/${path.relative(srcRoot, fromFile)}`,
        `${unit.name} imports ${JSON.stringify(specifier)}, which escapes the package root; import the public package name instead.`
      );
    }
    const resolved = /\.(?:ts|mjs|cjs|json)$/u.test(specifier)
      ? base
      : [base, `${base}.ts`, path.join(base, "index.ts")].find((candidate) =>
          existsSync(candidate)
        );
    if (resolved === undefined || !existsSync(resolved)) {
      throw new ArchiveBuildError(
        ArchiveCode.UnresolvedImport,
        `${unit.name}/src/${path.relative(srcRoot, fromFile)}`,
        `${unit.name} imports ${JSON.stringify(specifier)}, which resolves to no file.`
      );
    }
    return;
  }
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
    return;
  }
  if (specifier.startsWith("@oal/")) {
    if (specifier.includes("/", "@oal/".length)) {
      throw new ArchiveBuildError(
        ArchiveCode.SubpathImport,
        unit.name,
        `${unit.name} imports ${JSON.stringify(specifier)}; archives export only their public root.`
      );
    }
    if (!archivedNames.has(specifier)) {
      throw new ArchiveBuildError(
        ArchiveCode.UnresolvedImport,
        unit.name,
        `${unit.name} imports ${JSON.stringify(specifier)}, which the archive set does not include.`
      );
    }
    return;
  }
  throw new ArchiveBuildError(
    ArchiveCode.ExternalImport,
    unit.name,
    `${unit.name} imports ${JSON.stringify(specifier)}; archives resolve only public imports.`
  );
}

/** Read a unit manifest. */
function manifestOf(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

/**
 * The transitive closure of archive units, starting from the CLI:
 * every @oal package its manifests reach, in stable dependency order.
 */
export async function archiveUnits() {
  const units = new Map();
  const queue = [CLI_DIR];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (units.has(directory)) {
      continue;
    }
    const manifest = manifestOf(directory);
    units.set(directory, {
      name: manifest.name,
      version: manifest.version,
      directory,
      isCli: directory === CLI_DIR
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@oal/")) {
        continue;
      }
      const candidate = path.join(
        PACKAGES_DIR,
        dependency.slice("@oal/".length)
      );
      if (!existsSync(path.join(candidate, "package.json"))) {
        throw new ArchiveBuildError(
          ArchiveCode.UnresolvedImport,
          manifest.name,
          `The workspace holds no package ${JSON.stringify(dependency)}.`
        );
      }
      queue.push(candidate);
    }
  }
  return [...units.values()];
}

/**
 * Transpile one source into JavaScript with `.js` specifiers. Only
 * strings that are actual import or export specifiers are rewritten:
 * a prose string that merely looks like a relative TypeScript path,
 * or a URL literal loaded outside the import system, keeps its text.
 */
export function compileSource(source) {
  const shebang = source.startsWith("#!")
    ? source.slice(0, source.indexOf("\n"))
    : "";
  const body = shebang === "" ? source : source.slice(source.indexOf("\n") + 1);
  const specifiers = new Set(
    staticImportsOf(body).filter(
      (specifier) => specifier.startsWith(".") && specifier.endsWith(".ts")
    )
  );
  const rewritten = body.replace(
    /(["'])(\.\.?\/[^"'\n]+)\1/gu,
    (whole, quote, value) =>
      specifiers.has(value)
        ? `${quote}${value.replace(/\.ts$/u, ".js")}${quote}`
        : whole
  );
  const result = ts.transpileModule(rewritten, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  });
  return shebang === ""
    ? result.outputText
    : `${shebang}\n${result.outputText}`;
}

/**
 * Resolve one relative import of one unit file to its file path, or
 * null when it resolves to nothing on disk.
 */
function resolveRelativeTs(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (/\.(?:ts|mjs|cjs|json)$/u.test(specifier)) {
    return existsSync(base) ? base : null;
  }
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Stage one unit: the reachable closure of its entry, compiled, plus
 * an installable manifest. Every file the entry cannot reach stays
 * out of the archive, so test helpers never ship.
 */
async function stageUnit(unit, units, stageRoot) {
  const names = new Set(units.map((entry) => entry.name));
  const srcDir = path.join(unit.directory, "src");
  const entryFile = path.join(srcDir, "index.ts");
  const unitRoot = path.join(stageRoot, unit.name);
  await rm(unitRoot, { recursive: true, force: true });
  const sources = new Map();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    const relative = path.relative(srcDir, file);
    if (sources.has(relative)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    sources.set(relative, source);
    for (const call of dynamicCallsOf(source)) {
      throw new ArchiveBuildError(
        ArchiveCode.DynamicImport,
        `${unit.name}/src/${relative}`,
        `${unit.name}/src/${relative} uses ${JSON.stringify(call)}; archives walk static imports only.`
      );
    }
    for (const specifier of staticImportsOf(source)) {
      checkImport(specifier, unit, file, srcDir, names);
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeTs(file, specifier);
      if (
        resolved !== null &&
        resolved.endsWith(".ts") &&
        !resolved.endsWith(".d.ts")
      ) {
        queue.push(resolved);
      }
    }
    // Files loaded by URL, not by import: the schema worker entry.
    // The runtime resolves the same dual layout the build emits, so
    // these files must ride the archive too.
    for (const match of source.matchAll(
      /new\s+URL\(\s*["'](\.[^"']*\.ts)["']\s*,\s*import\.meta\.url\s*\)/gu
    )) {
      const resolved = resolveRelativeTs(file, match[1]);
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  for (const [relative, source] of sources) {
    const compiled = compileSource(source);
    const target = path.join(
      unitRoot,
      "dist",
      relative.replace(/\.ts$/u, ".js")
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, compiled);
  }
  const entry = path.join(unitRoot, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new ArchiveBuildError(
      ArchiveCode.MissingEntry,
      unit.name,
      `${unit.name} stages no dist/index.js entry.`
    );
  }
  // The pack loader resolves its schema set beside `dist/` in an
  // archive, so the schema directory ships inside @oal/pack.
  if (unit.name === "@oal/pack") {
    const schemaFiles = (await readdir(path.join(ROOT, "schemas"))).filter(
      (entry) => typeof entry === "string" && entry.endsWith(".schema.json")
    );
    for (const file of schemaFiles) {
      const target = path.join(unitRoot, "schemas", file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(ROOT, "schemas", file)));
    }
  }
  const manifest = manifestOf(unit.directory);
  const dependencies = {};
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith("@oal/")) {
      continue;
    }
    const provider = units.find((candidate) => candidate.name === name);
    dependencies[name] = provider === undefined ? range : provider.version;
  }
  const staged = {
    name: unit.name,
    version: unit.version,
    description: manifest.description ?? "",
    type: "module",
    license: manifest.license ?? "UNLICENSED",
    main: "./dist/index.js",
    exports: { ".": "./dist/index.js" },
    dependencies
  };
  if (unit.isCli) {
    staged.bin = { oal: "./dist/index.js" };
  }
  await writeFile(
    path.join(unitRoot, "package.json"),
    `${JSON.stringify(staged, null, 2)}\n`
  );
  return unitRoot;
}

/**
 * Build every archive. Returns the staged directories and the packed
 * tarball names.
 */
export async function buildArchives(outDir) {
  const units = await archiveUnits();
  const stageRoot = path.join(outDir, "stage");
  const archivesRoot = path.join(outDir, "archives");
  await mkdir(stageRoot, { recursive: true });
  await mkdir(archivesRoot, { recursive: true });
  const staged = [];
  for (const unit of units) {
    staged.push(await stageUnit(unit, units, stageRoot));
  }
  const tarballs = [];
  for (const directory of staged) {
    const { stdout } = await run(
      "npm",
      ["pack", "--json", "--pack-destination", archivesRoot, directory],
      { cwd: ROOT }
    );
    for (const entry of JSON.parse(stdout)) {
      tarballs.push(path.join(archivesRoot, path.basename(entry.filename)));
    }
  }
  return { units, staged, tarballs };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outDir =
    outIndex !== -1 && process.argv[outIndex + 1] !== undefined
      ? path.resolve(process.argv[outIndex + 1])
      : path.join(ROOT, "dist", "archives");
  const { units, tarballs } = await buildArchives(outDir);
  process.stdout.write(
    `${JSON.stringify(
      {
        units: units.length,
        archives: tarballs.map((tarball) => path.basename(tarball))
      },
      null,
      2
    )}\n`
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
