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

describe("the package-boundary check", () => {
  it("rejects an environment import of the runner", async () => {
    const { execFile } = await import("node:child_process");
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const script = path.join(
      import.meta.dirname,
      "..",
      "scripts",
      "check-package-boundaries.mjs"
    );
    const tree = await mkdtemp(path.join(tmpdir(), "oal-boundaries-"));
    try {
      await mkdir(path.join(tree, "packages", "environment", "src"), {
        recursive: true
      });
      await mkdir(path.join(tree, "apps"), { recursive: true });
      await writeFile(
        path.join(tree, "packages", "environment", "package.json"),
        JSON.stringify({
          name: "@oal/environment",
          exports: { ".": "./src/index.ts" }
        }),
        "utf8"
      );
      await writeFile(
        path.join(tree, "packages", "environment", "src", "index.ts"),
        'import type { FrozenPlan } from "@oal/runner";\n',
        "utf8"
      );
      const result = await run("node", [script], { cwd: tree }).then(
        (ok) => ({ code: 0, output: ok.stderr }),
        (error: unknown) => {
          const failure = error as { code?: number; stderr?: string };
          return {
            code: failure.code ?? -1,
            output: typeof failure.stderr === "string" ? failure.stderr : ""
          };
        }
      );
      expect(result.output).toContain(
        "packages/environment imports @oal/runner"
      );
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });
});
