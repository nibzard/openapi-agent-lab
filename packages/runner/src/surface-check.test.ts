import { describe, expect, it } from "vitest";

import {
  canonicalJsonSha256,
  jsonClone,
  sha256Hex,
  type JsonObject
} from "@oal/core";

import {
  parseSurfacePolicy,
  surfaceEntriesOf,
  type ParticipantSurfacePolicy,
  type RenderedSurfaceText
} from "./cue.ts";
import {
  applyProvenancePolicy,
  checkParticipantSurfaces,
  classifySurfaceEntry,
  compareCellSurfaces,
  SurfaceCheckCode,
  verifyPostRunSurface,
  type CellSurface,
  type SurfaceClassificationInput
} from "./surface-check.ts";
import {
  compileSurfaceManifest,
  type ContractRouteDescriptor,
  type EnvironmentNameDescriptor,
  type MessageKindDescriptor,
  type ResponseCatalogDescriptor
} from "./surface.ts";
import type { WorkspaceFilePlan } from "./prompts.ts";

const CATALOG_SHA_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CATALOG_SHA_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function slugOf(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

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

function policyDocument(): JsonObject {
  return {
    schema_version: 1,
    kind: "ParticipantSurfacePolicy",
    id: "cue-policy-1",
    version: "1.0.0",
    forbidden_literals: [{ literal: "benchmark", case_insensitive: true }],
    forbidden_patterns: [],
    allowed_exceptions: [],
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
    required_reviews: { equivalence: false, blinding: false },
    extensions: {}
  };
}

function policy(): ParticipantSurfacePolicy {
  return parseSurfacePolicy(policyDocument());
}

interface CellExtra {
  readonly responseCatalogs?: readonly ResponseCatalogDescriptor[];
  readonly contractRoutes?: readonly ContractRouteDescriptor[];
  readonly environmentNames?: readonly EnvironmentNameDescriptor[];
  readonly messageKinds?: readonly MessageKindDescriptor[];
  readonly cellLevels?: Readonly<Record<string, string>>;
}

function cell(
  cellId: string,
  files: readonly WorkspaceFilePlan[],
  extra?: CellExtra
): CellSurface {
  const compiled = compileSurfaceManifest({
    cellId,
    runId: `run-${cellId}`,
    isTemplate: false,
    files,
    ...(extra?.responseCatalogs === undefined
      ? {}
      : { responseCatalogs: extra.responseCatalogs }),
    ...(extra?.contractRoutes === undefined
      ? {}
      : { contractRoutes: extra.contractRoutes }),
    ...(extra?.environmentNames === undefined
      ? {}
      : { environmentNames: extra.environmentNames }),
    ...(extra?.messageKinds === undefined
      ? {}
      : { messageKinds: extra.messageKinds })
  });
  const rendered: RenderedSurfaceText[] = files.map((file) => ({
    surfaceEntry: `file-${slugOf(file.target)}`,
    text: file.text ?? ""
  }));
  return {
    cellId,
    manifest: compiled.manifest,
    rendered,
    ...(extra?.cellLevels === undefined ? {} : { cellLevels: extra.cellLevels })
  };
}

const PLAIN_TASK = filePlan("TASK.md", "Finish the reported task.");
const PLAIN_INSTRUCTIONS = filePlan(
  "INSTRUCTIONS.md",
  "Follow the API you received."
);

describe("compareCellSurfaces", () => {
  it("passes two cells with the same rendered surface", async () => {
    const a = cell("cell-a", [PLAIN_INSTRUCTIONS, PLAIN_TASK]);
    const b = cell("cell-b", [
      PLAIN_INSTRUCTIONS,
      filePlan("TASK.md", PLAIN_TASK.text ?? "")
    ]);

    const outcomes = compareCellSurfaces(policy(), [a, b]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.cellA).toBe("cell-a");
    expect(outcomes[0]?.cellB).toBe("cell-b");
    expect(outcomes[0]?.differences).toEqual([]);

    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a, b]
    });
    expect(check.diagnostics).toEqual([]);
    expect(check.audits.map((audit) => audit.result)).toEqual(["pass", "pass"]);
  });

  it("fails a shared entry whose bytes drift outside the allowlist", async () => {
    const a = cell("cell-a", [
      PLAIN_INSTRUCTIONS,
      filePlan("TASK.md", "Task version one.")
    ]);
    const b = cell("cell-b", [
      PLAIN_INSTRUCTIONS,
      filePlan("TASK.md", "Task version two, longer.")
    ]);

    const outcomes = compareCellSurfaces(policy(), [a, b]);
    expect(
      outcomes[0]?.differences.map((difference) => [
        difference.surface_entry,
        difference.kind,
        difference.allowed,
        difference.onlyIn
      ])
    ).toEqual([["file-TASK.md", "bytes", false, null]]);

    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a, b]
    });
    expect(check.diagnostics.map((entry) => entry.code)).toEqual([
      "OAL-CELL-DRIFT"
    ]);
    expect(check.diagnostics[0]?.phase).toBe("preflight");
    expect(check.diagnostics[0]?.details).toEqual({
      cell_a: "cell-a",
      cell_b: "cell-b",
      surface_entry: "file-TASK.md",
      kind: "bytes"
    });
    expect(check.audits.every((audit) => audit.result === "fail")).toBe(true);
  });

  it("reports an entry only one cell holds as a cue leak", async () => {
    const a = cell("cell-a", [PLAIN_INSTRUCTIONS, PLAIN_TASK]);
    const b = cell("cell-b", [
      PLAIN_INSTRUCTIONS,
      PLAIN_TASK,
      filePlan("hint.md", "Extra hint.", "participant-file")
    ]);

    const outcomes = compareCellSurfaces(policy(), [a, b]);
    expect(
      outcomes[0]?.differences.map((difference) => [
        difference.surface_entry,
        difference.kind,
        difference.allowed,
        difference.onlyIn
      ])
    ).toEqual([["file-hint.md", "name", false, "b"]]);

    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a, b]
    });
    expect(check.diagnostics.map((entry) => entry.code)).toEqual([
      "OAL-CUE-LEAK"
    ]);
  });

  it("classifies a shared route target change as a route difference", () => {
    const withRouteTarget = (
      source: JsonObject,
      cellId: string,
      target: string
    ): JsonObject => {
      const clone = jsonClone(source);
      clone["cell_id"] = cellId;
      const entries = clone["entries"] as JsonObject[];
      const route = entries.find((entry) => entry["channel"] === "http-route");
      if (route === undefined) {
        throw new Error("manifest holds no route entry");
      }
      route["target"] = target;
      return clone;
    };

    const a = cell("cell-a", [PLAIN_TASK], {
      contractRoutes: [
        {
          method: "GET",
          path: "/gadgets",
          catalogSha256: CATALOG_SHA_A,
          maxBytes: 4096
        }
      ]
    });
    const b: CellSurface = {
      cellId: "cell-b",
      manifest: withRouteTarget(a.manifest, "cell-b", "GET /widgets"),
      rendered: []
    };
    const differences = compareCellSurfaces(policy(), [a, b])[0]?.differences;
    expect(
      differences?.map((difference) => [difference.kind, difference.allowed])
    ).toEqual([["route", true]]);

    const c: CellSurface = {
      cellId: "cell-c",
      manifest: withRouteTarget(a.manifest, "cell-c", "GET /gizmos")
    };
    const unallowed = compareCellSurfaces(policy(), [a, c])[0]?.differences;
    expect(
      unallowed?.map((difference) => [difference.kind, difference.allowed])
    ).toEqual([["route", false]]);
  });

  it("allows differences on treatment-owned paths and catalogs", async () => {
    const a = cell(
      "cell-a",
      [
        PLAIN_TASK,
        filePlan(
          "docs/tone/notes.md",
          "Friendly tone notes.",
          "participant-file"
        )
      ],
      {
        contractRoutes: [
          {
            method: "GET",
            path: "/widgets",
            catalogSha256: CATALOG_SHA_A,
            maxBytes: 4096
          }
        ],
        responseCatalogs: [
          {
            id: "widgets",
            operationKey: "path:GET /widgets",
            sha256: CATALOG_SHA_A,
            maxBytes: 4096
          }
        ]
      }
    );
    const b = cell(
      "cell-b",
      [
        PLAIN_TASK,
        filePlan("docs/tone/notes.md", "Terse tone notes.", "participant-file")
      ],
      {
        contractRoutes: [
          {
            method: "GET",
            path: "/widgets",
            catalogSha256: CATALOG_SHA_B,
            maxBytes: 8192
          }
        ],
        responseCatalogs: [
          {
            id: "widgets",
            operationKey: "path:GET /widgets",
            sha256: CATALOG_SHA_B,
            maxBytes: 8192
          }
        ]
      }
    );

    const differences = compareCellSurfaces(policy(), [a, b])[0]?.differences;
    expect(differences?.map((difference) => difference.kind)).toEqual([
      "bytes",
      "catalog",
      "bytes",
      "catalog",
      "bytes"
    ]);
    expect(differences?.every((difference) => difference.allowed)).toBe(true);
    expect(
      (await checkParticipantSurfaces({ policy: policy(), cells: [a, b] }))
        .diagnostics
    ).toEqual([]);
  });

  it("allows a difference on an entry marked as treatment provenance", async () => {
    const a = cell("cell-a", [PLAIN_TASK], {
      responseCatalogs: [
        {
          id: "widgets",
          operationKey: "path:GET /widgets",
          sha256: CATALOG_SHA_A,
          maxBytes: 4096,
          provenanceClass: "treatment"
        }
      ]
    });
    const b = cell("cell-b", [PLAIN_TASK], {
      responseCatalogs: [
        {
          id: "widgets",
          operationKey: "path:GET /widgets",
          sha256: CATALOG_SHA_B,
          maxBytes: 4096,
          provenanceClass: "treatment"
        }
      ]
    });

    const differences = compareCellSurfaces(policy(), [a, b])[0]?.differences;
    expect(differences?.map((difference) => difference.kind)).toEqual([
      "catalog"
    ]);
    expect(differences?.every((difference) => difference.allowed)).toBe(true);
    expect(
      (await checkParticipantSurfaces({ policy: policy(), cells: [a, b] }))
        .diagnostics
    ).toEqual([]);
  });

  it("honors the pairwise surface-difference allowlist by entry id", async () => {
    const document = policyDocument();
    document["pairwise_surface_diff_allowlist"] = [
      {
        cell_a: "cell-a",
        cell_b: "cell-b",
        allowed_differences: ["file-TASK.md"]
      }
    ];
    const allowlistPolicy = parseSurfacePolicy(document);
    const a = cell("cell-a", [filePlan("TASK.md", "Task version one.")]);
    const b = cell("cell-b", [filePlan("TASK.md", "Task version two.")]);

    const outcomes = compareCellSurfaces(allowlistPolicy, [a, b]);
    expect(
      outcomes[0]?.differences.map((difference) => difference.allowed)
    ).toEqual([true]);
    expect(
      (
        await checkParticipantSurfaces({
          policy: allowlistPolicy,
          cells: [a, b]
        })
      ).diagnostics
    ).toEqual([]);
  });

  it("rejects a duplicate cell identifier", () => {
    const a = cell("cell-a", [PLAIN_TASK]);
    expect(() => compareCellSurfaces(policy(), [a, a])).toThrowError(
      /share the identifier/
    );
  });
});

describe("checkParticipantSurfaces", () => {
  it("emits OAL-CUE-LEAK for a forbidden literal on one cell", async () => {
    const a = cell("cell-a", [PLAIN_TASK]);
    const b = cell("cell-b", [
      filePlan("TASK.md", "Complete the benchmark checklist.")
    ]);

    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a, b]
    });
    expect(check.diagnostics.map((entry) => entry.code)).toEqual([
      "OAL-CUE-LEAK",
      "OAL-CELL-DRIFT"
    ]);
    expect(check.diagnostics[0]?.message).toContain("file-TASK.md");
    expect(check.audits.every((audit) => audit.result === "fail")).toBe(true);
  });

  it("emits OAL-CUE-LEAK when a manifest delivers a private artifact", async () => {
    const a = cell("cell-a", [
      PLAIN_TASK,
      filePlan("factor-levels.json", "[]", "participant-file")
    ]);
    const b = cell("cell-b", [PLAIN_TASK]);

    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a, b]
    });
    expect(check.diagnostics.map((entry) => entry.code)).toEqual([
      "OAL-CUE-LEAK",
      "OAL-CUE-LEAK"
    ]);
    expect(check.diagnostics[0]?.message).toContain("factor-levels.json");
  });

  it("requires the declared equivalence and blinding reviews", async () => {
    const document = policyDocument();
    document["required_reviews"] = { equivalence: true, blinding: true };
    const strictPolicy = parseSurfacePolicy(document);
    const a = cell("cell-a", [PLAIN_TASK]);
    const b = cell("cell-b", [PLAIN_TASK]);

    const missing = await checkParticipantSurfaces({
      policy: strictPolicy,
      cells: [a, b]
    });
    expect(missing.diagnostics.map((entry) => entry.code)).toEqual([
      SurfaceCheckCode.ReviewMissing,
      SurfaceCheckCode.ReviewMissing,
      SurfaceCheckCode.ReviewMissing
    ]);

    const partial = await checkParticipantSurfaces({
      policy: strictPolicy,
      cells: [a, b],
      reviews: [
        { kind: "equivalence", approved: true, cueAuditSha256: null },
        { kind: "blinding", approved: true, cueAuditSha256: "0".repeat(64) }
      ]
    });
    expect(partial.diagnostics.map((entry) => entry.code)).toEqual([
      SurfaceCheckCode.ReviewMissing,
      SurfaceCheckCode.ReviewMissing
    ]);

    const covered = await checkParticipantSurfaces({
      policy: strictPolicy,
      cells: [a, b],
      reviews: [
        { kind: "equivalence", approved: true, cueAuditSha256: null },
        ...partial.audits.map((audit) => ({
          kind: "blinding" as const,
          approved: true,
          cueAuditSha256: audit.sha256
        }))
      ]
    });
    expect(covered.diagnostics).toEqual([]);
  });

  it("warns when a strict policy runs under advisory isolation", async () => {
    const a = cell("cell-a", [PLAIN_TASK]);
    const check = await checkParticipantSurfaces({
      policy: policy(),
      cells: [a],
      blindingMode: "strict",
      isolation: "advisory"
    });
    expect(
      check.diagnostics.map((entry) => [entry.code, entry.severity])
    ).toEqual([["OAL-RUN-CUE-ISOLATION-ADVISORY", "warning"]]);
  });
});

describe("classifySurfaceEntry", () => {
  it("classifies the four provenance classes", () => {
    const owned = policy().treatment_owned;
    const cases: readonly (readonly [
      SurfaceClassificationInput,
      ReturnType<typeof classifySurfaceEntry>
    ])[] = [
      [
        {
          channel: "file",
          target: "docs/tone/notes.md",
          source: "pack",
          origin: "participant-file",
          treatmentOwned: owned
        },
        "treatment"
      ],
      [
        {
          channel: "file",
          target: "openapi.json",
          source: "pack/openapi.json",
          origin: "contract"
        },
        "contractual"
      ],
      [
        { channel: "http-route", target: "GET /widgets", source: "facade" },
        "contractual"
      ],
      [
        { channel: "credential", target: "OAL_WIDGET_KEY", source: "apiKey" },
        "contractual"
      ],
      [
        { channel: "tool", target: "list_widgets", source: "exposure" },
        "contractual"
      ],
      [
        {
          channel: "file",
          target: "TASK.md",
          source: "runner",
          origin: "prompt"
        },
        "task_essential"
      ],
      [
        {
          channel: "file",
          target: "result.schema.json",
          source: "eval",
          origin: "result-schema"
        },
        "task_essential"
      ],
      [
        { channel: "environment", target: "OAL_BASE_URL", source: "runner" },
        "framework_incidental"
      ],
      [
        { channel: "message", target: "sandbox_denial", source: "adapter" },
        "framework_incidental"
      ]
    ];

    for (const [input, expected] of cases) {
      expect(classifySurfaceEntry(input)).toBe(expected);
    }
  });
});

describe("applyProvenancePolicy", () => {
  it("removes framework-incidental entries by default", () => {
    const manifest = cell("cell-a", [PLAIN_TASK], {
      environmentNames: [{ name: "OAL_BASE_URL", source: "runner" }],
      messageKinds: [
        { kind: "sandbox_denial", source: "adapter-generic", maxBytes: 512 }
      ]
    }).manifest;
    const entries = surfaceEntriesOf(manifest);

    const outcome = applyProvenancePolicy({
      entries,
      packId: "widget-pack",
      packVersion: "1.2.3"
    });

    expect(outcome.removed.map((entry) => entry.id)).toEqual([
      "workspace-root",
      "env-OAL_BASE_URL",
      "message-sandbox_denial"
    ]);
    expect(outcome.kept.map((entry) => entry.id)).toEqual(["file-TASK.md"]);
    expect(outcome.preserved).toEqual([]);
  });

  it("makes a preserved cue declared pack behavior with its own digest", () => {
    const manifest = cell("cell-a", [PLAIN_TASK], {
      messageKinds: [
        { kind: "sandbox_denial", source: "adapter-generic", maxBytes: 512 }
      ]
    }).manifest;
    const entries = surfaceEntriesOf(manifest);

    const outcome = applyProvenancePolicy({
      entries,
      preserve: ["message-sandbox_denial"],
      packId: "widget-pack",
      packVersion: "1.2.3"
    });

    expect(outcome.removed.map((entry) => entry.id)).toEqual([
      "workspace-root"
    ]);
    expect(outcome.kept.map((entry) => entry.id)).toEqual([
      "file-TASK.md",
      "message-sandbox_denial"
    ]);
    const preserved = outcome.preserved[0];
    expect(preserved?.entry_id).toBe("message-sandbox_denial");
    expect(preserved?.pack_id).toBe("widget-pack");
    expect(preserved?.pack_version).toBe("1.2.3");
    expect(preserved?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const kept = outcome.kept.find(
      (entry) => entry.id === "message-sandbox_denial"
    );
    expect(kept?.provenanceClass).toBe("task_essential");
  });

  it("rejects a preserve request that names no incidental entry", () => {
    const entries = surfaceEntriesOf(cell("cell-a", [PLAIN_TASK]).manifest);

    expect(() =>
      applyProvenancePolicy({
        entries,
        preserve: ["file-missing"],
        packId: "widget-pack",
        packVersion: "1.2.3"
      })
    ).toThrowError(/names no surface entry/);
    try {
      applyProvenancePolicy({
        entries,
        preserve: ["file-TASK.md"],
        packId: "widget-pack",
        packVersion: "1.2.3"
      });
      throw new Error("expected a thrown error");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        SurfaceCheckCode.PreserveNotIncidental
      );
    }
  });
});

describe("verifyPostRunSurface", () => {
  it("accepts a rebuilt manifest that still hashes the same", () => {
    const frozen = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [PLAIN_TASK]
    });
    const observed = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [filePlan("TASK.md", PLAIN_TASK.text ?? "")]
    });

    expect(
      verifyPostRunSurface({
        runId: "r-7f3a91",
        frozenManifestSha256: frozen.manifestSha256,
        observedManifest: observed.manifest,
        observedManifestSha256: frozen.manifestSha256
      })
    ).toEqual([]);
  });

  it("reports drift when the post-run manifest differs", () => {
    const frozen = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [PLAIN_TASK]
    });
    const observed = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [filePlan("TASK.md", "Rewritten after execution.")]
    });

    const drift = verifyPostRunSurface({
      runId: "r-7f3a91",
      frozenManifestSha256: frozen.manifestSha256,
      observedManifest: observed.manifest
    });
    expect(drift.map((entry) => [entry.code, entry.subject])).toEqual([
      ["OAL-HASH-MISMATCH", "manifest"]
    ]);
    expect(drift[0]?.expected).toBe(frozen.manifestSha256);
    expect(drift[0]?.actual).toBe(canonicalJsonSha256(observed.manifest));

    const archived = verifyPostRunSurface({
      runId: "r-7f3a91",
      frozenManifestSha256: frozen.manifestSha256,
      observedManifest: frozen.manifest,
      observedManifestSha256: observed.manifestSha256
    });
    expect(archived.map((entry) => entry.subject)).toEqual([
      "archived-manifest"
    ]);
  });

  it("reports a recorded rendered digest that no longer matches the body", () => {
    const frozen = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [PLAIN_TASK]
    });
    const tampered = jsonClone(frozen.manifest);
    tampered["rendered_sha256"] = "c".repeat(64);

    const drift = verifyPostRunSurface({
      runId: "r-7f3a91",
      frozenManifestSha256: frozen.manifestSha256,
      observedManifest: tampered
    });
    expect(drift.map((entry) => [entry.subject, entry.code])).toEqual([
      ["manifest", "OAL-HASH-MISMATCH"],
      ["rendered_sha256", "OAL-HASH-MISMATCH"]
    ]);
    expect(drift[1]?.actual).toBe(frozen.manifest["rendered_sha256"]);
  });

  it("rejects a digest that is not a sha256 hex string", () => {
    const compiled = compileSurfaceManifest({
      cellId: "cell-a",
      runId: "r-7f3a91",
      isTemplate: false,
      files: [PLAIN_TASK]
    });
    expect(() =>
      verifyPostRunSurface({
        runId: "r-7f3a91",
        frozenManifestSha256: "not-a-digest",
        observedManifest: compiled.manifest
      })
    ).toThrowError(/sha256/);
  });
});
