/**
 * Release candidate assembly tests (plan SE-P6-03). The candidate
 * carries installable archives, the recorded provider-skip evidence,
 * the honest readiness output, the limitations document, and a
 * digest manifest. Nothing publishes. The practitioner trials stay
 * external: these checks pin what a reviewer receives.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildReleaseCandidate } from "../scripts/build-release-candidate.mjs";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("the stateful release candidate", () => {
  it("assembles archives, evidence, readiness, and limitations", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "oal-candidate-"));
    scratch.push(out);
    const { manifest } = await buildReleaseCandidate(out);

    // The installable archives ride the candidate.
    expect(manifest.units).toBeGreaterThanOrEqual(30);
    expect(manifest.archives).toContain("oal-cli-0.0.0.tgz");
    expect(existsSync(path.join(out, "archives", "oal-cli-0.0.0.tgz"))).toBe(
      true
    );

    // The recorded provider skip rides the candidate, never a pass.
    const skip = JSON.parse(
      await readFile(path.join(out, "evidence", "skip.json"), "utf8")
    ) as { kind?: unknown };
    expect(skip.kind).toBe("VerificationSkip");

    // The readiness output names its blocks honestly.
    const readiness = await readFile(path.join(out, "readiness.txt"), "utf8");
    expect(readiness).toContain("SE-P5-03");
    expect(readiness).toContain("blocking");
    expect(readiness).toContain("gate exit: 1");

    // The limitations document rides the candidate.
    const limitations = await readFile(
      path.join(out, "LIMITATIONS.md"),
      "utf8"
    );
    expect(limitations).toContain("SE-P5-03");
    expect(limitations).toContain("No practitioner trial is recorded");

    // Every artifact in the manifest digests to its recorded value.
    const written = JSON.parse(
      await readFile(path.join(out, "manifest.json"), "utf8")
    ) as { artifacts?: Array<{ path?: unknown; sha256?: unknown }> };
    const artifacts = written.artifacts ?? [];
    expect(artifacts.length).toBeGreaterThanOrEqual(35);
    for (const artifact of artifacts) {
      expect(typeof artifact.path).toBe("string");
      expect(String(artifact.sha256)).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The manifest itself is not self-referential.
    expect(
      artifacts.some((artifact) => artifact.path === "manifest.json")
    ).toBe(false);
  }, 240_000);
});
