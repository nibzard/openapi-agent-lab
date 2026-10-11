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
  it("documents scenario serving through the shared owner", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("--mode scenario");
    expect(usage).toContain("shared environment owner");
    expect(usage).toContain("exports the environment manifest");
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
    expect(text).toMatch(
      /Direct-tool and catalog-tool execution[^\n]*runner refuses/
    );
    expect(text).toMatch(
      /Study tooling[^\n]*participant launch is unavailable/
    );
    expect(text).toContain("live provider verification remains pending");
  });

  it("keeps the final-state claim honest", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("the final state stays empty");
  });

  it("keeps the README serve claim current", async () => {
    const text = await readme();
    expect(text).toMatch(/oal serve packs\/webclip --mode scenario/);
    expect(text).toContain("oal world checkpoint");
    expect(text).toContain("oal world fork");
    expect(text).toMatch(
      /Reset and virtual-time controls use a separate private operator socket/
    );
    // The stale stateless claim must stay gone.
    expect(text).not.toContain("stays in contract mode");
    expect(text).not.toContain("placeholder; not written yet");
  });

  it("documents the live corpus surface in the network policy", async () => {
    const security = await doc("security.md");
    expect(security).toContain("Operator-authorized corpus runs");
    expect(security).toContain("--allow-live-writes");
    expect(security).toContain("restricted to a disposable repository");
    expect(security).toContain("never retried automatically");
    expect(security).toContain(
      "never enters a pack file,\nthe participant environment, or any artifact"
    );
  });

  it("documents the corpus verify skip semantics", async () => {
    const usage = await doc("usage.md");
    expect(usage).toContain("oal corpus verify");
    expect(usage).toContain("Missing credentials record a skip, never a pass");
    expect(usage).toContain("VerificationSkip");
    expect(usage).toContain("exits with code");
    expect(usage).toContain("never automatically");
    // The credential discipline stays stated where the command lives.
    expect(usage).toContain("restricted to a disposable repository");
  });
});

describe("the external pack tutorial", () => {
  it("documents only commands the installed executable runs", async () => {
    const tutorial = await doc("tutorial-external-pack.md");
    // Every command below is exercised by an automated check; the
    // wording cannot drift ahead of the behavior.
    expect(tutorial).toContain("pnpm run archives");
    expect(tutorial).toContain("npm install --offline --no-audit --no-fund");
    expect(tutorial).toContain("oal pack validate ./external-demo");
    expect(tutorial).toContain("oal corpus run ./external-demo");
    expect(tutorial).toContain("--corpus demo-core");
    expect(tutorial).toContain("oal serve ./external-demo --mode scenario");
    expect(tutorial).toContain("oal world checkpoint --world");
    expect(tutorial).toContain("oal world fork ./checkpoint");
    expect(tutorial).toContain("oal run ./external-demo --eval smoke");
    expect(tutorial).toContain("--agent mock-agent");
    // The tutorial must keep naming the honest failure modes.
    expect(tutorial).toContain("exit");
    expect(tutorial).toContain("assertion failure");
  });

  it("keeps the authoring reference past its placeholder", async () => {
    const authoring = await doc("authoring-packs.md");
    expect(authoring).not.toBe(
      "This document is a placeholder for pack authoring workflows.\n"
    );
    // The enforced authoring rules stay stated.
    expect(authoring).toContain("erasable-syntax");
    expect(authoring).toContain("@oal/behavior-api");
    expect(authoring).toContain("frozen");
    expect(authoring).toContain("emulator_only");
    // Every fidelity classification keeps its meaning.
    for (const classification of [
      "documented",
      "observed",
      "synthetic",
      "unsupported"
    ]) {
      expect(authoring).toContain(classification);
    }
  });

  it("keeps the limitations document explicit about the blockers", async () => {
    const limitations = await doc("stateful-limitations.md");
    expect(limitations).toContain("has not run");
    expect(limitations).toContain("No practitioner trial is recorded");
    expect(limitations).toContain("advisory");
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
