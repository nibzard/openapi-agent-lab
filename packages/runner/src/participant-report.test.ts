import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Json } from "@oal/core";

import { cleanupRunnerFixtures, newTempDir } from "./prompts.test.ts";
import {
  collectParticipantReport,
  ReportCode,
  type CollectReportOptions,
  type ReportFailure,
  type ReportOutcome
} from "./participant-report.ts";

const RESULT_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: { type: "array", items: { type: "string" } }
  }
};

const VALID = '{"operations":["path:GET /widgets"]}';

const SECRET = "oal_run_secret_1";

afterEach(async () => {
  await cleanupRunnerFixtures();
});

function options(
  workspace: string,
  extra: Partial<CollectReportOptions> = {}
): CollectReportOptions {
  return {
    reportDir: workspace,
    secrets: [SECRET],
    resultSchema: RESULT_SCHEMA,
    maxBytes: 4096,
    maxTextBytes: 256,
    ...extra
  };
}

async function failureOf(
  call: () => Promise<ReportOutcome>
): Promise<ReportFailure> {
  const outcome = await call();
  expect(outcome.status).toBe("problem");
  if (outcome.status !== "problem") {
    throw new Error("Expected a problem outcome.");
  }
  return outcome;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

describe("adapter_final source", () => {
  it("parses once, redacts, and writes participant-report.json", async () => {
    const workspace = await newTempDir();
    const outcome = await collectParticipantReport(
      {
        source: "adapter_final",
        text: `{"operations":["key ${SECRET}"],"note":"${SECRET}"}`
      },
      options(workspace, { resultSchema: { type: "object" } })
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok" || outcome.writtenTo === null) {
      throw new Error("Expected a success outcome with a written report.");
    }
    expect(outcome.value).toEqual({
      operations: [`key ${SECRET}`],
      note: SECRET
    });
    expect(outcome.text).toContain("[REDACTED]");
    expect(outcome.text).not.toContain(SECRET);
    expect(outcome.writtenTo).toBe(
      path.join(workspace, "participant-report.json")
    );

    const persisted = await readFile(outcome.writtenTo, "utf8");
    expect(persisted).toContain('"ParticipantReport"');
    expect(persisted).not.toContain(SECRET);
  });

  it("bounds the preserved text to the declared byte count", async () => {
    const workspace = await newTempDir();
    const long = `{"operations":[] ${"x".repeat(400)}`;
    const failure = await failureOf(() =>
      collectParticipantReport(
        { source: "adapter_final", text: long },
        options(workspace)
      )
    );
    expect(failure.problem.code).toBe(ReportCode.JsonInvalid);
    expect(failure.text?.endsWith("\n[TRUNCATED]")).toBe(true);
    expect(byteLength(failure.text ?? "")).toBeLessThanOrEqual(256);
  });

  it("reports invalid JSON and duplicate keys as task evidence", async () => {
    const workspace = await newTempDir();
    const invalid = await failureOf(() =>
      collectParticipantReport(
        { source: "adapter_final", text: '{"operations": }' },
        options(workspace)
      )
    );
    expect(invalid.problem.code).toBe(ReportCode.JsonInvalid);
    expect(invalid.text).toBe('{"operations": }');

    const duplicated = await failureOf(() =>
      collectParticipantReport(
        {
          source: "adapter_final",
          text: '{"operations":[],"operations":[]}'
        },
        options(workspace)
      )
    );
    expect(duplicated.problem.code).toBe(ReportCode.DuplicateKey);
    expect(duplicated.problem.subject).toBe("adapter_final");
  });

  it("reports schema-invalid output and writes nothing", async () => {
    const workspace = await newTempDir();
    const invalid = await failureOf(() =>
      collectParticipantReport(
        { source: "adapter_final", text: '{"operations":"nope"}' },
        options(workspace)
      )
    );
    expect(invalid.problem.code).toBe(ReportCode.SchemaInvalid);
    expect(invalid.problem.message).toContain("/operations");
    await expect(
      readFile(path.join(workspace, "participant-report.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never falls back to a workspace file when the channel is empty", async () => {
    const workspace = await newTempDir();
    await writeFile(
      path.join(workspace, "result.json"),
      '{"operations":[]}',
      "utf8"
    );
    const failure = await failureOf(() =>
      collectParticipantReport(
        { source: "adapter_final", text: "   " },
        options(workspace)
      )
    );
    expect(failure.problem.code).toBe(ReportCode.Missing);
    expect(failure.problem.subject).toBe("adapter_final");
    await expect(
      readFile(path.join(workspace, "participant-report.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("workspace_file source", () => {
  it("reads one declared file and writes the report", async () => {
    const workspace = await newTempDir();
    await writeFile(path.join(workspace, "result.json"), VALID, "utf8");
    const outcome = await collectParticipantReport(
      {
        source: "workspace_file",
        workspaceDir: workspace,
        filename: "result.json",
        exitedAtMs: null
      },
      options(workspace)
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      throw new Error("Expected a success outcome.");
    }
    expect(outcome.value).toEqual({ operations: ["path:GET /widgets"] });
    expect(outcome.source).toBe("workspace_file");
  });

  it("rejects traversal, absolute, and dot-segment filenames", async () => {
    const workspace = await newTempDir();
    for (const filename of ["../result.json", "/etc/passwd", "a/../b.json"]) {
      const failure = await failureOf(() =>
        collectParticipantReport(
          {
            source: "workspace_file",
            workspaceDir: workspace,
            filename,
            exitedAtMs: null
          },
          options(workspace)
        )
      );
      expect(failure.problem.code).toBe(ReportCode.PathUnsafe);
      expect(failure.problem.subject).toBe(filename);
    }
  });

  it("rejects a missing file, a symlink, a directory, and oversize", async () => {
    const workspace = await newTempDir();
    const missing = await failureOf(() =>
      collectParticipantReport(
        {
          source: "workspace_file",
          workspaceDir: workspace,
          filename: "absent.json",
          exitedAtMs: null
        },
        options(workspace)
      )
    );
    expect(missing.problem.code).toBe(ReportCode.Missing);
    expect(missing.problem.subject).toBe("absent.json");

    await writeFile(path.join(workspace, "real.json"), VALID, "utf8");
    await symlink("real.json", path.join(workspace, "link.json"));
    const linked = await failureOf(() =>
      collectParticipantReport(
        {
          source: "workspace_file",
          workspaceDir: workspace,
          filename: "link.json",
          exitedAtMs: null
        },
        options(workspace)
      )
    );
    expect(linked.problem.code).toBe(ReportCode.Symlink);

    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "nested", "deep.json"), VALID, "utf8");
    const directory = await failureOf(() =>
      collectParticipantReport(
        {
          source: "workspace_file",
          workspaceDir: workspace,
          filename: "nested",
          exitedAtMs: null
        },
        options(workspace)
      )
    );
    expect(directory.problem.code).toBe(ReportCode.NotRegular);

    const oversize = await failureOf(() =>
      collectParticipantReport(
        {
          source: "workspace_file",
          workspaceDir: workspace,
          filename: "nested/deep.json",
          exitedAtMs: null
        },
        options(workspace, { maxBytes: 8 })
      )
    );
    expect(oversize.problem.code).toBe(ReportCode.TooLarge);
  });

  it("rejects a file that changed after the agent exited", async () => {
    const workspace = await newTempDir();
    const target = path.join(workspace, "result.json");
    await writeFile(target, VALID, "utf8");
    const writtenAt = new Date(Date.now() - 60_000);
    await utimes(target, writtenAt, writtenAt);

    const quiet = await collectParticipantReport(
      {
        source: "workspace_file",
        workspaceDir: workspace,
        filename: "result.json",
        exitedAtMs: writtenAt.getTime() + 1000
      },
      options(workspace)
    );
    expect(quiet.status).toBe("ok");

    const afterExit = new Date(Date.now() + 60_000);
    await utimes(target, afterExit, afterExit);
    const mutated = await failureOf(() =>
      collectParticipantReport(
        {
          source: "workspace_file",
          workspaceDir: workspace,
          filename: "result.json",
          exitedAtMs: Date.now()
        },
        options(workspace)
      )
    );
    expect(mutated.problem.code).toBe(ReportCode.Mutated);
  });
});
