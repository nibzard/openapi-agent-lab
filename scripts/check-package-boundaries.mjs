// Package-boundary check for the CI gate (specification sections 36.1
// and 48.2). Verifies workspace layout rules that eslint cannot
// express, including the import directions of the environment owner:
// `@oal/environment` may import only the declared owner packages,
// never the runner, agent adapters, evaluator, or CLI, and nothing
// below the runner may import it.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");
const appsDir = join(root, "apps");

const problems = [];

/** Packages the environment owner may depend on (section 48.2). */
const ENVIRONMENT_ALLOWED_IMPORTS = new Set([
  "@oal/behavior-api",
  "@oal/behavior-runtime",
  "@oal/contract-ir",
  "@oal/core",
  "@oal/evidence",
  "@oal/gateway",
  "@oal/pack",
  "@oal/state-store"
]);

/** Specifiers the environment owner must never import. */
const ENVIRONMENT_FORBIDDEN_PATTERN =
  /^@oal\/(?:runner|agent-adapter|agent-codex|agent-generic|evaluator|mock-adapter|study|study-ir|scheduler|tools|report|statistics|cli)$/u;

/** The packages allowed to import the environment owner. */
const ENVIRONMENT_CONSUMERS = new Set(["packages/runner", "apps/cli"]);

/** Collect every workspace specifier imported by the files of one tree. */
async function importedWorkspaceSpecifiers(sourceDir) {
  const specifiers = new Set();
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(
    () => []
  );
  for (const entry of entries) {
    const target = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      for (const found of await importedWorkspaceSpecifiers(target)) {
        specifiers.add(found);
      }
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }
    const text = await readFile(target, "utf8").catch(() => "");
    for (const match of text.matchAll(/["'](@oal\/[a-z-]+)["']/gu)) {
      specifiers.add(match[1]);
    }
  }
  return specifiers;
}

async function directoryExists(target) {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

async function loadManifests(dir, kind) {
  const names = await readdir(dir, { withFileTypes: true });
  const manifests = [];
  for (const entry of names) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(dir, entry.name, "package.json");
    try {
      const raw = await readFile(path, "utf8");
      manifests.push({
        kind,
        name: entry.name,
        path,
        manifest: JSON.parse(raw)
      });
    } catch {
      problems.push(`${kind}/${entry.name} has no readable package.json`);
    }
  }
  return manifests;
}

const manifests = [
  ...(await loadManifests(packagesDir, "packages")),
  ...(await loadManifests(appsDir, "apps"))
];

const workspaceNames = new Set(manifests.map((m) => m.manifest.name));
const allowedScopes = /^@oal\//;

for (const { kind, name, manifest } of manifests) {
  const label = `${kind}/${name}`;
  if (!allowedScopes.test(manifest.name ?? "")) {
    problems.push(`${label}: package name ${manifest.name} is outside @oal/*`);
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies"
  ]) {
    const deps = manifest[field] ?? {};
    for (const [dep, range] of Object.entries(deps)) {
      if (range.startsWith("workspace:")) {
        if (!workspaceNames.has(dep)) {
          problems.push(`${label}: workspace dependency ${dep} does not exist`);
        }
        if (field !== "dependencies") {
          problems.push(
            `${label}: workspace dependency ${dep} sits in ${field}`
          );
        }
        continue;
      }
      if (field === "dependencies") {
        problems.push(
          `${label}: runtime dependency ${dep}@${range} is forbidden`
        );
      }
    }
  }
  const exports = manifest.exports ?? {};
  const mainExport = exports["."] ?? {};
  if (
    typeof mainExport !== "string" &&
    mainExport.default !== "./src/index.ts"
  ) {
    problems.push(`${label}: exports["."] must point at ./src/index.ts`);
  }
}

// Environment owner directions (section 48.2).
const environmentSourceDir = join(packagesDir, "environment", "src");
if (await directoryExists(environmentSourceDir)) {
  const imported = await importedWorkspaceSpecifiers(environmentSourceDir);
  for (const specifier of imported) {
    if (specifier === "@oal/environment") {
      // The owner names itself in its runtime identity; that is not a
      // dependency.
      continue;
    }
    if (ENVIRONMENT_FORBIDDEN_PATTERN.test(specifier)) {
      problems.push(
        `packages/environment imports ${specifier}, which the environment owner must never depend on.`
      );
    }
    if (
      !ENVIRONMENT_ALLOWED_IMPORTS.has(specifier) &&
      !ENVIRONMENT_FORBIDDEN_PATTERN.test(specifier)
    ) {
      problems.push(
        `packages/environment imports ${specifier}, which is outside the declared owner dependencies.`
      );
    }
  }
  // Nothing below the runner may import the environment owner.
  for (const { kind, name } of manifests) {
    const label = `${kind}/${name}`;
    if (label === "packages/environment" || ENVIRONMENT_CONSUMERS.has(label)) {
      continue;
    }
    const specifiers = await importedWorkspaceSpecifiers(
      join(kind === "packages" ? packagesDir : appsDir, name, "src")
    );
    if (specifiers.has("@oal/environment")) {
      problems.push(
        `${label} imports @oal/environment; only the runner and apps may consume the environment owner.`
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`package-boundary check failed (${problems.length} problems):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(`package-boundary check passed for ${manifests.length} workspaces`);
