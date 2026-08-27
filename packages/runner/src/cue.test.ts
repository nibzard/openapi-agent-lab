import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  canonicalJsonSha256,
  parseJsonStrict,
  SchemaValidator,
  sha256Hex,
  type JsonObject
} from "@oal/core";

import {
  buildCueAudit,
  CueCode,
  cueIsolationAdvisory,
  parseSurfacePolicy,
  policyJson,
  PRIVATE_SURFACE_FRAGMENTS,
  privateArtifactProblems,
  surfaceEntriesOf,
  surfacePolicySha256,
  type ParticipantSurfacePolicy
} from "./cue.ts";
import { compileSurfaceManifest } from "./surface.ts";
import { renderTemplate, resolveContext } from "./template.ts";
import type { WorkspaceFilePlan } from "./prompts.ts";

const SCHEMA_PATH = join(process.cwd(), "schemas", "cue-audit.v1.schema.json");

function filePlan(
  target: string,
  text: string,
  origin: WorkspaceFilePlan["origin"] = "prompt"
): WorkspaceFilePlan {
  return {
    target,
    origin,
    source: origin === "contract" ? `pack/${target}` : null,
    sourcePath: null,
    text,
    engine: origin === "prompt" ? "mustache-strict" : null,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text)
  };
}

function basePolicyDocument(): JsonObject {
  return {
    schema_version: 1,
    kind: "ParticipantSurfacePolicy",
    id: "cue-policy-1",
    version: "1.0.0",
    forbidden_literals: [
      { literal: "benchmark", case_insensitive: true },
      { literal: "control-arm", case_insensitive: false }
    ],
    forbidden_patterns: ["evaluat[a-z]+"],
    allowed_exceptions: [
      {
        surface_entry: "file-TASK.md",
        factor_level: "level-tone-friendly",
        literal: "benchmark",
        reason: "Domain term of the selected contract."
      }
    ],
    treatment_owned: {
      paths: ["docs/tone/"],
      routes: ["/widgets"],
      fields: ["priority"],
      catalogs: ["widgets"]
    },
    neutral_profiles: {
      response_profile: "response-neutral-1",
      credential_profile: "credential-neutral-1",
      server_profile: "server-neutral-1"
    },
    pairwise_surface_diff_allowlist: [],
    required_reviews: { equivalence: true, blinding: true },
    extensions: {}
  };
}

function cellManifest(
  files: readonly WorkspaceFilePlan[],
  cellId = "cell-a"
): JsonObject {
  return compileSurfaceManifest({
    cellId,
    runId: "r-7f3a91",
    isTemplate: false,
    files
  }).manifest;
}

function parsedPolicy(
  document: JsonObject = basePolicyDocument()
): ParticipantSurfacePolicy {
  return parseSurfacePolicy(document);
}

describe("parseSurfacePolicy", () => {
  it("validates and freezes a policy document", () => {
    const policy = parsedPolicy();

    expect(policy.id).toBe("cue-policy-1");
    expect(policy.forbidden_literals[0]).toEqual({
      literal: "benchmark",
      case_insensitive: true
    });
    expect(policy.forbidden_literals[1]?.literal).toBe("control-arm");
    expect(policy.allowed_exceptions[0]?.factor_level).toBe(
      "level-tone-friendly"
    );
    expect(policy.neutral_profiles.credential_profile).toBe(
      "credential-neutral-1"
    );
    expect(policy.required_reviews).toEqual({
      equivalence: true,
      blinding: true
    });
    expect(surfacePolicySha256(policy)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("round-trips through the schema document form", () => {
    const document = basePolicyDocument();
    const policy = parsedPolicy(document);

    expect(canonicalJson(policyJson(policy))).toBe(canonicalJson(document));
    expect(canonicalJsonSha256(policyJson(policy))).toBe(
      surfacePolicySha256(policy)
    );
  });

  it("rejects an unknown exception literal and a broken pattern", () => {
    const stray = basePolicyDocument();
    (stray["allowed_exceptions"] as JsonObject[])[0] = {
      surface_entry: "file-TASK.md",
      literal: "not-a-forbidden-literal"
    };
    expect(() => parseSurfacePolicy(stray)).toThrowError(/forbidden literal/);

    const broken = basePolicyDocument();
    broken["forbidden_patterns"] = ["evaluat[a-z"];
    try {
      parseSurfacePolicy(broken);
      throw new Error("expected a thrown error");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(CueCode.PatternInvalid);
    }

    const wrongKind = basePolicyDocument();
    wrongKind["kind"] = "SomethingElse";
    expect(() => parseSurfacePolicy(wrongKind)).toThrowError(
      /ParticipantSurfacePolicy/
    );
  });
});

describe("buildCueAudit", () => {
  it("detects a forbidden literal case-insensitively", () => {
    const manifest = cellManifest([
      filePlan("TASK.md", "Run the BENCHmark suite now.")
    ]);
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [
        { surfaceEntry: "file-TASK.md", text: "Run the BENCHmark suite now." }
      ]
    });

    expect(audit.findings).toEqual([
      {
        kind: "literal",
        match: "BENCHmark",
        surface_entry: "file-TASK.md",
        allowed_exception: false
      }
    ]);
    expect(audit.result).toBe("fail");
    expect(audit.document["result"]).toBe("fail");
  });

  it("keeps a case-sensitive literal silent under changed case", () => {
    const manifest = cellManifest([
      filePlan("TASK.md", "Welcome to the Control-Arm demo.")
    ]);
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [
        {
          surfaceEntry: "file-TASK.md",
          text: "Welcome to the Control-Arm demo."
        }
      ]
    });

    expect(audit.findings.map((finding) => finding.match)).toEqual([]);
    expect(audit.result).toBe("pass");
  });

  it("matches a forbidden pattern over rendered bytes", () => {
    const manifest = cellManifest([
      filePlan("TASK.md", "The evaluator grades every submission.")
    ]);
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [
        {
          surfaceEntry: "file-TASK.md",
          text: "The evaluator grades every submission."
        }
      ]
    });

    expect(audit.findings).toEqual([
      {
        kind: "pattern",
        match: "evaluator",
        surface_entry: "file-TASK.md",
        allowed_exception: false
      }
    ]);
  });

  it("pins an exception to one entry and one factor level", () => {
    const files = [
      filePlan("INSTRUCTIONS.md", "Start the benchmark when told."),
      filePlan("TASK.md", "Finish the benchmark task.")
    ];
    const manifest = cellManifest(files);
    const policy = parsedPolicy();
    const rendered = files.map((file) => ({
      surfaceEntry: `file-${file.target}`,
      text: file.text ?? ""
    }));
    const atLevel = buildCueAudit({
      cellId: "cell-a",
      policy,
      manifest,
      rendered,
      cellLevels: { tone: "level-tone-friendly" }
    });

    expect(
      atLevel.findings.map((finding) => [
        finding.surface_entry,
        finding.allowed_exception
      ])
    ).toEqual([
      ["file-INSTRUCTIONS.md", false],
      ["file-TASK.md", true]
    ]);
    expect(atLevel.result).toBe("fail");

    const otherLevel = buildCueAudit({
      cellId: "cell-a",
      policy,
      manifest,
      rendered,
      cellLevels: { tone: "level-tone-terse" }
    });
    expect(
      otherLevel.findings.every((finding) => !finding.allowed_exception)
    ).toBe(true);

    const noLevels = buildCueAudit({
      cellId: "cell-a",
      policy,
      manifest,
      rendered
    });
    expect(
      noLevels.findings.every((finding) => !finding.allowed_exception)
    ).toBe(true);
  });

  it("scans rendered bytes, not the source template", () => {
    const context = resolveContext({
      values: { "case.name": "the benchmark results" }
    });
    const rendered = renderTemplate({
      name: "task",
      engine: "mustache-strict",
      source: "Summarize {{case.name}} in one paragraph.",
      context
    });

    expect(rendered.sourceSha256).not.toBe(rendered.renderedSha256);
    expect(rendered.text).toContain("benchmark");
    expect(rendered.variables).toEqual(["case.name"]);

    const manifest = cellManifest([filePlan("TASK.md", rendered.text)]);
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [{ surfaceEntry: "file-TASK.md", text: rendered.text }]
    });
    expect(audit.findings.map((finding) => finding.match)).toEqual([
      "benchmark"
    ]);

    const sourceOnly = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [
        {
          surfaceEntry: "file-TASK.md",
          text: "Summarize {{case.name}} in one paragraph."
        }
      ]
    });
    expect(sourceOnly.findings).toEqual([]);
    expect(sourceOnly.result).toBe("pass");
  });

  it("scans entry names, so a revealing environment name is caught", () => {
    const manifest = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [filePlan("TASK.md", "Plain task text.")],
      environmentNames: [
        { name: "OAL_BENCHMARK_MODE", source: "participant.environment" }
      ]
    }).manifest;
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: []
    });

    expect(audit.findings).toEqual([
      {
        kind: "literal",
        match: "BENCHMARK",
        surface_entry: "env-OAL_BENCHMARK_MODE",
        allowed_exception: false
      }
    ]);
  });

  it("fails on an unallowed pairwise difference and records the pair", () => {
    const manifest = cellManifest([filePlan("TASK.md", "Plain task text.")]);
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [],
      pairwise: [
        {
          cell_a: "cell-a",
          cell_b: "cell-b",
          differences: [
            { surface_entry: "file-TASK.md", kind: "bytes", allowed: false },
            { surface_entry: "file-LOG.md", kind: "name", allowed: true }
          ]
        }
      ]
    });

    expect(audit.result).toBe("fail");
    expect(audit.document["pairwise"]).toEqual([
      {
        cell_a: "cell-a",
        cell_b: "cell-b",
        differences: [
          { surface_entry: "file-TASK.md", kind: "bytes", allowed: false },
          { surface_entry: "file-LOG.md", kind: "name", allowed: true }
        ]
      }
    ]);
  });

  it("rejects rendered bytes for an unknown entry and a cell mismatch", () => {
    const manifest = cellManifest([filePlan("TASK.md", "Plain task text.")]);
    const policy = parsedPolicy();

    try {
      buildCueAudit({
        cellId: "cell-a",
        policy,
        manifest,
        rendered: [{ surfaceEntry: "file-MISSING", text: "text" }]
      });
      throw new Error("expected a thrown error");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(CueCode.EntryUnknown);
    }

    try {
      buildCueAudit({
        cellId: "cell-b",
        policy,
        manifest,
        rendered: []
      });
      throw new Error("expected a thrown error");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(CueCode.CellIdMismatch);
    }
  });

  it("produces a document that conforms to cue-audit.v1.schema.json", async () => {
    const files = [filePlan("TASK.md", "Finish the benchmark task.")];
    const manifest = cellManifest(files);
    const schema = parseJsonStrict(await readFile(SCHEMA_PATH, "utf8"), {
      maxBytes: 1_048_576
    });
    const audit = buildCueAudit({
      cellId: "cell-a",
      policy: parsedPolicy(),
      manifest,
      rendered: [{ surfaceEntry: "file-TASK.md", text: files[0]?.text ?? "" }],
      cellLevels: { tone: "level-tone-friendly" },
      pairwise: [
        {
          cell_a: "cell-a",
          cell_b: "cell-b",
          differences: [
            { surface_entry: "file-TASK.md", kind: "bytes", allowed: true }
          ]
        }
      ]
    });

    expect(new SchemaValidator(schema).errors(audit.document)).toEqual([]);
    expect(audit.sha256).toBe(canonicalJsonSha256(audit.document));
    expect(audit.result).toBe("pass");
    expect(audit.document["policy_sha256"]).toBe(
      surfacePolicySha256(parsedPolicy())
    );
    const scanned = audit.document["scanned"] as JsonObject[];
    expect(scanned.length).toBe(surfaceEntriesOf(manifest).length);
    for (const entry of scanned) {
      expect(entry["bytes_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("privateArtifactProblems", () => {
  it("flags a manifest entry that delivers the cue audit", () => {
    const manifest = cellManifest([
      filePlan("TASK.md", "Plain task text."),
      filePlan("cue-audit.json", "{}", "participant-file")
    ]);

    const problems = privateArtifactProblems(manifest);
    expect(problems.map((problem) => problem.entryId)).toEqual([
      "file-cue-audit.json"
    ]);
    expect(problems[0]?.fragment).toBe("cue-audit");
    expect(problems[0]?.code).toBe(CueCode.PrivateArtifactVisible);
  });

  it("accepts a manifest without private artifacts", () => {
    const manifest = cellManifest([filePlan("TASK.md", "Plain task text.")]);
    expect(privateArtifactProblems(manifest)).toEqual([]);
    expect(PRIVATE_SURFACE_FRAGMENTS).toContain("factor-level");
  });
});

describe("cueIsolationAdvisory", () => {
  it("reports a strict policy under advisory isolation only", () => {
    const advisory = cueIsolationAdvisory({
      blindingMode: "strict",
      isolation: "advisory"
    });
    expect(advisory?.code).toBe(CueCode.IsolationAdvisory);
    expect(advisory?.severity).toBe("warning");
    expect(advisory?.message).toContain("advisory isolation");

    expect(
      cueIsolationAdvisory({ blindingMode: "strict", isolation: "os" })
    ).toBeNull();
    expect(
      cueIsolationAdvisory({ blindingMode: "none", isolation: "advisory" })
    ).toBeNull();
  });
});
