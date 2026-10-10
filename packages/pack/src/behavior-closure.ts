/**
 * The complete behavior dependency closure of one pack (specification
 * section 48.8). Before its child starts, every file the behavior
 * entrypoint can reach is hashed and copied into a frozen tree the
 * child executes from, so later edits to the sources cannot change a
 * running world's behavior identity.
 *
 * Version 1 resolves static imports only: relative imports of files
 * inside the pack root, and imports of declared public OAL packages
 * resolved through the pack's own `node_modules` or the workspace
 * package directory. Dynamic imports, ambient package resolution, and
 * files outside the allowed closure are refused with explicit codes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

import { isWithin } from "@oal/core";

/** Stable refusal codes of the closure analysis. */
export const BehaviorClosureCode = {
  DynamicImport: "OAL-PACK-BEHAVIOR-DYNAMIC-IMPORT",
  EscapingImport: "OAL-PACK-BEHAVIOR-ESCAPING-IMPORT",
  UnresolvedImport: "OAL-PACK-BEHAVIOR-UNRESOLVED-IMPORT",
  AmbientImport: "OAL-PACK-BEHAVIOR-AMBIENT-IMPORT",
  ReadFailed: "OAL-PACK-BEHAVIOR-READ-FAILED"
} as const;

/** A closure analysis refusal. */
export class BehaviorClosureError extends Error {
  readonly code: string;
  /** Pack-relative or resolved path of the offending file. */
  readonly sourcePath: string;

  constructor(code: string, sourcePath: string, message: string) {
    super(message);
    this.code = code;
    this.sourcePath = sourcePath;
    this.name = "BehaviorClosureError";
  }
}

/** One hashed file of the closure. */
export interface BehaviorClosureFile {
  readonly origin: "pack" | "package";
  /** Path relative to the pack root or to the package root. */
  readonly path: string;
  readonly sha256: string;
  /** Present on package files: the resolved workspace package name. */
  readonly packageName?: string;
  /** Present on package files: the version the closure froze. */
  readonly packageVersion?: string;
}

/** One resolved package the closure froze. */
export interface BehaviorClosurePackage {
  readonly name: string;
  readonly version: string;
  /** Absolute, symlink-resolved package root the freezer copies from. */
  readonly rootPath: string;
}

/** The analyzed closure of one behavior entrypoint. */
export interface BehaviorClosure {
  /** Pack-relative path of the entrypoint. */
  readonly entryPath: string;
  readonly files: readonly BehaviorClosureFile[];
  /** Every package the graph reached, with its resolved source root. */
  readonly packages: readonly BehaviorClosurePackage[];
  /**
   * Digest over the resolved graph: file paths, byte digests, package
   * identities, and the runtime that freezes. A helper edit changes
   * this identity; byte-identical graphs keep it.
   */
  readonly identity: string;
}

/** Specifiers a pack behavior module may import beyond its own files. */
const PUBLIC_BEHAVIOR_PACKAGES: ReadonlySet<string> = new Set([
  "@oal/behavior-api",
  "@oal/behavior-runtime"
]);

/** The runtime identity that participates in the closure digest. */
export const BEHAVIOR_CLOSURE_RUNTIME = "@oal/pack behavior closure v1";

interface PackageRecord {
  readonly version: string;
  readonly rootPath: string;
}

/**
 * Extract the static import specifiers of one module: `import ... from`,
 * `export ... from`, and bare `import "..."` forms.
 */
function staticImportsOf(source: string): string[] {
  const found: string[] = [];
  const push = (specifier: string | undefined): void => {
    if (specifier !== undefined) {
      found.push(specifier);
    }
  };
  for (const match of source.matchAll(
    /(?:^|[\s;}])import\s+[^;]*?from\s*["']([^"']+)["']/gu
  )) {
    push(match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s;}])export\s+[^;]*?from\s*["']([^"']+)["']/gu
  )) {
    push(match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s;}])import\s+["']([^"']+)["']/gu
  )) {
    push(match[1]);
  }
  return found;
}

/** Does the module text contain a dynamic import or require call? */
function dynamicCallsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bimport\s*\(/gu)) {
    found.push(match[0]);
  }
  for (const match of source.matchAll(/\brequire\s*\(/gu)) {
    found.push(match[0]);
  }
  return found;
}

/**
 * Resolve a workspace package the way Node would from one directory:
 * walk up through `node_modules` links, then through sibling
 * `packages/<name>` directories for repository packs. Realpath the
 * link so a package's own dependencies resolve beside it.
 */
function resolvePackageDirectory(fromDir: string, name: string): string | null {
  let current = resolve(fromDir);
  for (;;) {
    const linked = join(current, "node_modules", name);
    if (existsSync(join(linked, "package.json"))) {
      // Realpath: workspace links are symlinks into the package
      // directory, whose own node_modules carries its dependencies.
      return realpathSync(linked);
    }
    const sibling = join(current, "packages", name.slice("@oal/".length));
    if (existsSync(join(sibling, "package.json"))) {
      return sibling;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Resolve one relative TypeScript import to a file on disk. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = /\.(?:ts|json)$/u.test(specifier)
    ? [base]
    : [base, `${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Where a package's exports point: the single-source layout of this
 * workspace resolves to `./src/index.ts`. */
function packageEntryOf(packageDirectory: string): string {
  const manifest = existsSync(join(packageDirectory, "package.json"))
    ? (JSON.parse(
        readFileSync(join(packageDirectory, "package.json"), "utf8")
      ) as { exports?: Record<string, string | { default?: string }> })
    : {};
  const mainExport = manifest.exports?.["."];
  const target =
    typeof mainExport === "string" ? mainExport : mainExport?.default;
  const relativeEntry =
    target ??
    (existsSync(join(packageDirectory, "src", "index.ts"))
      ? "./src/index.ts"
      : "./index.ts");
  return join(packageDirectory, relativeEntry);
}

/**
 * Compute the closure of one behavior entrypoint. Throws
 * {@link BehaviorClosureError} on the first refusal; a pack with a
 * refused closure never starts a child.
 */
export async function computeBehaviorClosure(
  entry: { readonly absolutePath: string; readonly sha256: string },
  packRoot: string
): Promise<BehaviorClosure> {
  const files: BehaviorClosureFile[] = [];
  const seenFiles = new Set<string>();
  const packages = new Map<string, PackageRecord>();

  const walk = async (
    absolutePath: string,
    origin: "pack" | "package",
    packageName?: string
  ): Promise<void> => {
    if (seenFiles.has(absolutePath)) {
      return;
    }
    seenFiles.add(absolutePath);
    let source: string;
    try {
      source = await readFile(absolutePath, "utf8");
    } catch (cause) {
      throw new BehaviorClosureError(
        BehaviorClosureCode.ReadFailed,
        absolutePath,
        `The closure cannot read ${absolutePath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      );
    }
    const rootPath =
      origin === "pack"
        ? packRoot
        : (packages.get(packageName ?? "")?.rootPath as string);
    const relPath = relative(rootPath, absolutePath);
    const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
    files.push({
      origin,
      path: relPath,
      sha256,
      ...(packageName === undefined ? {} : { packageName })
    });

    for (const dynamic of dynamicCallsOf(source)) {
      throw new BehaviorClosureError(
        BehaviorClosureCode.DynamicImport,
        relPath,
        `${relPath} contains a dynamic ${dynamic} call; the closure resolves static imports only.`
      );
    }
    for (const specifier of staticImportsOf(source)) {
      if (specifier.startsWith("node:")) {
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = resolveRelative(absolutePath, specifier);
        if (resolved === null) {
          throw new BehaviorClosureError(
            BehaviorClosureCode.UnresolvedImport,
            relPath,
            `${relPath} imports ${specifier}, which does not resolve to a file.`
          );
        }
        if (origin === "pack" && !isWithin(packRoot, resolved)) {
          throw new BehaviorClosureError(
            BehaviorClosureCode.EscapingImport,
            relPath,
            `${relPath} imports ${specifier}, which leaves the pack root.`
          );
        }
        if (origin === "package" && !isWithin(rootPath, resolved)) {
          throw new BehaviorClosureError(
            BehaviorClosureCode.EscapingImport,
            relPath,
            `${relPath} imports ${specifier}, which leaves its package.`
          );
        }
        await walk(resolved, origin, packageName);
        continue;
      }
      if (specifier.startsWith("@oal/")) {
        const allowedFromPack = PUBLIC_BEHAVIOR_PACKAGES.has(specifier);
        if (!allowedFromPack && origin !== "package") {
          throw new BehaviorClosureError(
            BehaviorClosureCode.EscapingImport,
            relPath,
            `${relPath} imports ${specifier}, which is not a declared public behavior package.`
          );
        }
        const packageDirectory = resolvePackageDirectory(
          dirname(absolutePath),
          specifier
        );
        if (packageDirectory === null) {
          throw new BehaviorClosureError(
            BehaviorClosureCode.UnresolvedImport,
            relPath,
            `${relPath} imports ${specifier}, which resolves to no package.`
          );
        }
        if (!packages.has(specifier)) {
          const manifest = JSON.parse(
            await readFile(join(packageDirectory, "package.json"), "utf8")
          ) as { version?: string };
          packages.set(specifier, {
            version:
              typeof manifest.version === "string" ? manifest.version : "",
            rootPath: packageDirectory
          });
          // The manifest itself joins the closure: the frozen tree
          // cannot resolve a bare specifier without it.
          const manifestBytes = await readFile(
            join(packageDirectory, "package.json")
          );
          seenFiles.add(join(packageDirectory, "package.json"));
          files.push({
            origin: "package",
            path: "package.json",
            sha256: createHash("sha256").update(manifestBytes).digest("hex"),
            packageName: specifier
          });
        }
        await walk(packageEntryOf(packageDirectory), "package", specifier);
        continue;
      }
      throw new BehaviorClosureError(
        BehaviorClosureCode.AmbientImport,
        relPath,
        `${relPath} imports ${specifier}; ambient dependency resolution is refused.`
      );
    }
  };

  if (!isWithin(packRoot, entry.absolutePath)) {
    throw new BehaviorClosureError(
      BehaviorClosureCode.EscapingImport,
      entry.absolutePath,
      "The behavior entrypoint sits outside the pack root."
    );
  }
  await walk(entry.absolutePath, "pack");
  const versioned = files.map((file) => ({
    ...file,
    ...(file.packageName === undefined
      ? {}
      : {
          packageVersion: packages.get(file.packageName)?.version ?? ""
        })
  }));
  return {
    entryPath: relative(packRoot, entry.absolutePath),
    files: versioned,
    packages: [...packages.entries()].map(([name, record]) => ({
      name,
      version: record.version,
      rootPath: record.rootPath
    })),
    identity: closureIdentityOf(versioned)
  };
}

/** The digest of the resolved graph, including the freezing runtime. */
function closureIdentityOf(files: readonly BehaviorClosureFile[]): string {
  const canonical = JSON.stringify(
    files
      .map((file) => [
        file.origin,
        file.packageName ?? "",
        file.packageVersion ?? "",
        file.path,
        file.sha256
      ])
      .sort((a, b) => String(a[3]).localeCompare(String(b[3])))
  );
  return createHash("sha256")
    .update(BEHAVIOR_CLOSURE_RUNTIME)
    .update(canonical)
    .digest("hex");
}

/** Directory inside a frozen tree that carries the package sources. */
const FROZEN_PACKAGE_DIR = "packages";

/**
 * Rewrite every bare `@oal/...` import of one frozen file into a
 * relative path to the frozen package entry. Node refuses type
 * stripping under `node_modules`, so the frozen tree cannot use the
 * standard resolution layout and the imports are pinned instead.
 */
function rewriteBareImports(
  source: string,
  fileTarget: string,
  closure: BehaviorClosure,
  frozenRoot: string
): string {
  let rewritten = source;
  const packageNames = new Set(
    closure.files
      .map((file) => file.packageName)
      .filter((name): name is string => name !== undefined)
  );
  for (const name of packageNames) {
    if (!rewritten.includes(`"${name}"`)) {
      continue;
    }
    const packageRoot = closure.packages.find(
      (pkg) => pkg.name === name
    )?.rootPath;
    if (packageRoot === undefined) {
      continue;
    }
    const entryRelative = relative(packageRoot, packageEntryOf(packageRoot));
    const frozenEntry = join(
      frozenRoot,
      FROZEN_PACKAGE_DIR,
      name,
      entryRelative
    );
    let specifier = relative(dirname(fileTarget), frozenEntry)
      .split("\\")
      .join("/");
    if (!specifier.startsWith(".")) {
      specifier = `./${specifier}`;
    }
    rewritten = rewritten.split(`"${name}"`).join(`"${specifier}"`);
  }
  return rewritten;
}

/**
 * Write the frozen tree of one closure. Pack files land at their
 * pack-relative paths; package files under `packages/<name>/...` with
 * every bare package import rewritten to a relative path, so the
 * frozen entry resolves its whole graph without the original checkout
 * and without `node_modules` type-stripping limits. The write is
 * atomic: a staging directory renames into place, and an existing
 * directory with the same identity is reused.
 */
export async function freezeBehaviorClosure(
  closure: BehaviorClosure,
  packRoot: string,
  frozenRoot: string
): Promise<{ readonly entryPath: string }> {
  const entryFrozen = join(frozenRoot, closure.entryPath);
  if (existsSync(entryFrozen)) {
    return { entryPath: entryFrozen };
  }
  const staging = `${frozenRoot}.staging-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await rm(staging, { recursive: true, force: true });
  // The closure carries each package's resolved root; freezing copies
  // from exactly the files the analysis hashed.
  const packageRoots = new Map(
    closure.packages.map((pkg) => [pkg.name, pkg.rootPath])
  );
  try {
    for (const file of closure.files) {
      const packageRoot =
        file.origin === "pack"
          ? packRoot
          : packageRoots.get(file.packageName ?? "");
      if (packageRoot === undefined) {
        throw new BehaviorClosureError(
          BehaviorClosureCode.UnresolvedImport,
          file.packageName ?? "",
          `The package ${file.packageName ?? ""} resolves to no directory from ${packRoot}.`
        );
      }
      const source = join(packageRoot, file.path);
      const relativeTarget =
        file.origin === "pack"
          ? file.path
          : join(FROZEN_PACKAGE_DIR, file.packageName ?? "", file.path);
      const target = join(staging, relativeTarget);
      await mkdir(dirname(target), { recursive: true });
      let bytes = await readFile(source);
      if (file.path.endsWith(".ts")) {
        // The rewritten imports are relative to the final tree, which
        // mirrors the staging layout exactly.
        bytes = Buffer.from(
          rewriteBareImports(
            bytes.toString("utf8"),
            join(frozenRoot, relativeTarget),
            closure,
            frozenRoot
          ),
          "utf8"
        );
      }
      await writeFile(target, bytes);
    }
    await mkdir(dirname(frozenRoot), { recursive: true });
    await rename(staging, frozenRoot);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return { entryPath: entryFrozen };
}
