/**
 * Documentation agreement checks. The review found documented workflows
 * that the command-line interface refuses. These checks pin the honest
 * wording so a claim cannot drift back ahead of the behavior: every
 * refused workflow stays documented as refused, and the corrected
 * webclip repair claim stays limited to its recorded observations.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function doc(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, "..", "docs", name), "utf8");
}

async function readme(): Promise<string> {
  return readFile(path.join(import.meta.dirname, "..", "README.md"), "utf8");
}

async function packReadme(): Promise<string> {
  return readFile(
    path.join(import.meta.dirname, "..", "packs", "webclip", "README.md"),
    "utf8"
  );
}

describe("documented commands match the CLI surface", () => {
  it("documents scenario serving as refused", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("--mode scenario");
    expect(usage).toContain("refuses to serve");
  });

  it("documents the tool exposure refusal", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("direct-tools|catalog-tools");
    expect(usage).toContain("exit code `4`");
  });

  it("documents the study launch refusal", async () => {
    const methods = await doc("research-methods.md");
    expect(methods).toContain("refuses to launch");
    expect(methods).toContain("stops before participant launch");
  });

  it("keeps the README execution states explicit", async () => {
    const text = await readme();
    expect(text).toContain("Refused by the command-line interface");
    expect(text).toContain("Implemented components, not connected");
  });

  it("keeps the final-state claim honest", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("the final state stays empty");
  });
});

describe("the webclip repair claim", () => {
  it("limits the claim to the recorded observations", async () => {
    const text = await packReadme();
    expect(text).toContain("do not establish");
    expect(text).toContain("Three trials with no control group");
    // The old claim asserted confirmation; it must stay gone.
    expect(text).not.toContain("confirms the repair");
  });
});
