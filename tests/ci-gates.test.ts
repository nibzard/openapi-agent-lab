/**
 * Repository checks for the CI gates (task T050). The workflows run on
 * GitHub Actions; these tests keep their shape honest inside the repo,
 * so a gate cannot disappear without a failing test.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readWorkflow(name: string): Promise<string> {
  return readFile(
    path.join(import.meta.dirname, "..", ".github", "workflows", name),
    "utf8"
  );
}

describe("the CI workflow", () => {
  it("runs the full local gate on every pull request", async () => {
    const text = await readWorkflow("ci.yml");
    expect(text).toContain("pnpm run ci");
    expect(text).toContain("pull_request");
  });

  it("runs the clean-install test suite on Linux and macOS", async () => {
    const text = await readWorkflow("ci.yml");
    expect(text).toContain("ubuntu-latest");
    expect(text).toContain("macos-latest");
    expect(text).toContain("--frozen-lockfile");
  });
});

describe("the nightly workflow", () => {
  it("keeps the scheduled probes on a nightly cron", async () => {
    const text = await readWorkflow("nightly.yml");
    expect(text).toContain("schedule:");
    expect(text).toMatch(/cron:\s*"/u);
  });
});
