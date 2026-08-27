// Package-boundary check for the CI gate (specification section 36.1).
// Verifies workspace layout rules that eslint cannot express.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");
const appsDir = join(root, "apps");

const problems = [];

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

if (problems.length > 0) {
  console.error(`package-boundary check failed (${problems.length} problems):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(`package-boundary check passed for ${manifests.length} workspaces`);
