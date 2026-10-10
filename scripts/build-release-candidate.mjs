#!/usr/bin/env node
/**
 * Assemble the stateful release candidate (plan SE-P6-03) without
 * publishing anything. The candidate directory carries the
 * installable archives, the recorded provider-skip evidence, the
 * honest readiness output, the limitations document, and a manifest
 * that digests every artifact.
 *
 * Usage: node scripts/build-release-candidate.mjs [--out DIR]
 * Default output: dist/release-candidate
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildArchives } from "./build-archives.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Digest one file. */
async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Every file below one directory, relative to it. */
async function filesBelow(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else {
        found.push(path.relative(dir, target));
      }
    }
  };
  await walk(dir);
  return found.sort();
}

/**
 * Assemble the candidate. Returns the manifest document and the
 * output directory.
 */
export async function buildReleaseCandidate(outDir) {
  await rm(outDir, { recursive: true, force: true });
  // The archive builder places its tarballs under <out>/archives.
  const { units, tarballs } = await buildArchives(outDir);

  // The recorded provider-skip evidence rides the candidate so a
  // reviewer sees the verification state without the repository.
  const evidenceDir = path.join(outDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const evidenceSource = path.join(
    ROOT,
    "docs",
    "evidence",
    "github-verify-skip-2026-10-10"
  );
  for (const file of await readdir(evidenceSource)) {
    await cp(path.join(evidenceSource, file), path.join(evidenceDir, file));
  }

  // The readiness output is included verbatim, blocks included: the
  // candidate never claims a milestone it has not reached.
  const readiness = await run("node", [
    path.join(ROOT, "scripts", "stateful-readiness.mjs")
  ]).catch((cause) => {
    const stderr = String(cause.stderr ?? "");
    const stdout = String(cause.stdout ?? cause.message);
    return { stdout: `${stdout}\n${stderr}`, failed: true };
  });
  await writeFile(
    path.join(outDir, "readiness.txt"),
    `${readiness.stdout.trim()}\n${readiness.failed === true ? "gate exit: 1\n" : ""}`
  );

  await cp(
    path.join(ROOT, "docs", "stateful-limitations.md"),
    path.join(outDir, "LIMITATIONS.md")
  );

  const entries = [];
  for (const relative of await filesBelow(outDir)) {
    entries.push({
      path: relative,
      sha256: await sha256Of(path.join(outDir, relative))
    });
  }
  const manifest = {
    schema_version: 1,
    kind: "ReleaseCandidateManifest",
    built_at: new Date().toISOString(),
    tool_version: JSON.parse(
      await readFile(path.join(ROOT, "apps", "cli", "package.json"), "utf8")
    ).version,
    archives: tarballs.map((tarball) => path.basename(tarball)),
    units: units.length,
    artifacts: entries,
    notes: [
      "Not published. Install offline with npm install --offline archives/*.tgz.",
      "Provider verification is a recorded skip; see evidence/skip.json.",
      "Readiness blocks are honest; see readiness.txt."
    ]
  };
  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return { outDir, manifest };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outDir =
    outIndex !== -1 && process.argv[outIndex + 1] !== undefined
      ? path.resolve(process.argv[outIndex + 1])
      : path.join(ROOT, "dist", "release-candidate");
  const { manifest } = await buildReleaseCandidate(outDir);
  process.stdout.write(
    `${JSON.stringify(
      {
        out: outDir,
        archives: manifest.archives.length,
        artifacts: manifest.artifacts.length
      },
      null,
      2
    )}\n`
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  await main();
}
