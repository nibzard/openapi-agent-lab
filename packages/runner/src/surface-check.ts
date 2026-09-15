/**
 * Cell-pair surface comparison, provenance classes, and post-run digest
 * verification (specification section 9.6). Analytical preflight compares
 * the rendered participant surface of every cell pair: a difference outside
 * the declared factor-owned allowlist fails with OAL-CELL-DRIFT, and
 * participant information that one cell shows and the other does not fails
 * with OAL-CUE-LEAK. Framework-incidental entries are removed by default;
 * a compatibility pack may preserve one only as declared pack behavior.
 */

import {
  canonicalJsonSha256,
  diagnostic,
  invalidInput,
  isSha256Hex,
  type Diagnostic,
  type JsonObject
} from "@oal/core";
import type { ProtocolBlinding } from "@oal/study-ir";

import {
  buildCueAudit,
  cueIsolationAdvisory,
  privateArtifactProblems,
  surfaceEntriesOf,
  surfaceEntryJson,
  treatmentOwnedMatch,
  type CueAudit,
  type CueAuditDifference,
  type CueAuditPairwise,
  type ParticipantSurfacePolicy,
  type RenderedSurfaceText,
  type SurfaceEntryView,
  type SurfacePolicyTreatmentOwned
} from "./cue.ts";
import type { WorkspaceFileOrigin } from "./prompts.ts";
import type { SurfaceChannel, SurfaceProvenanceClass } from "./surface.ts";

/** Stable error and diagnostic codes of the surface-check module. */
export const SurfaceCheckCode = {
  CellDuplicate: "OAL-RUN-SURFACE-CHECK-CELL-DUPLICATE",
  ReviewMissing: "OAL-RUN-SURFACE-REVIEW-MISSING",
  ReviewNotApproved: "OAL-RUN-SURFACE-REVIEW-NOT-APPROVED",
  DigestInvalid: "OAL-RUN-SURFACE-CHECK-DIGEST-INVALID",
  PreserveUnknown: "OAL-RUN-SURFACE-PRESERVE-UNKNOWN",
  PreserveNotIncidental: "OAL-RUN-SURFACE-PRESERVE-NOT-INCIDENTAL"
} as const;

/** Taxonomy codes the checks emit (section 32.2 study category). */
export const SURFACE_CHECK_FAILURE_CODES = [
  "OAL-CUE-LEAK",
  "OAL-CELL-DRIFT",
  "OAL-HASH-MISMATCH"
] as const;

/** One cell of the comparison: its rendered manifest and rendered bytes. */
export interface CellSurface {
  readonly cellId: string;
  readonly manifest: JsonObject;
  readonly rendered?: readonly RenderedSurfaceText[] | undefined;
  /** Factor-to-level map of the cell; used to pin exceptions. */
  readonly cellLevels?: Readonly<Record<string, string>> | undefined;
}

/** One surface difference between two cells. */
export interface SurfacePairDifference extends CueAuditDifference {
  /** Cell that holds the entry when only one does; null when both do. */
  readonly onlyIn: "a" | "b" | null;
  /** Observation used in diagnostics; not part of the audit document. */
  readonly observation: string;
}

/** One cell-pair comparison result. */
export interface SurfacePairOutcome {
  readonly cellA: string;
  readonly cellB: string;
  readonly differences: readonly SurfacePairDifference[];
}

/** Human review evidence linked to the cue audit. */
export interface ReviewEvidence {
  readonly kind: "equivalence" | "blinding";
  readonly approved: boolean;
  /** Digest of the cue audit the review covered; blinding reviews only. */
  readonly cueAuditSha256: string | null;
}

/** Result of the analytical participant-surface check. */
export interface SurfaceCheckOutcome {
  /** One private cue audit per cell, in input order. */
  readonly audits: readonly CueAudit[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Compare every cell pair. Each pair records one difference per entry that
 * only one cell holds (kind `name`), per shared entry whose target or route
 * differs (`name` or `route`), whose catalog digest differs (`catalog`), or
 * whose byte size or size bound differs (`bytes`). A file entry reports one
 * `bytes` difference for a content change, because its digest and its size
 * describe the same bytes. The synthetic `workspace` aggregate is skipped:
 * its size bound derives from the file entries already compared. A
 * difference is allowed when either cell marks the entry as provenance
 * class `treatment`, when a treatment-owned path, route, field, or catalog
 * owns the entry name, or when the pair allowlist names the entry.
 */
export function compareCellSurfaces(
  policy: ParticipantSurfacePolicy,
  cells: readonly CellSurface[]
): readonly SurfacePairOutcome[] {
  const outcomes: SurfacePairOutcome[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    if (seen.has(cell.cellId)) {
      throw invalidInput(
        SurfaceCheckCode.CellDuplicate,
        `Two compared cells share the identifier ${cell.cellId}.`,
        { cell_id: cell.cellId }
      );
    }
    seen.add(cell.cellId);
  }
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const first = cells[i];
      const second = cells[j];
      if (first === undefined || second === undefined) {
        continue;
      }
      outcomes.push(compareOnePair(policy, first, second));
    }
  }
  return Object.freeze(outcomes);
}

function compareOnePair(
  policy: ParticipantSurfacePolicy,
  first: CellSurface,
  second: CellSurface
): SurfacePairOutcome {
  const entriesA = new Map(
    surfaceEntriesOf(first.manifest).map((entry) => [entry.id, entry])
  );
  const entriesB = new Map(
    surfaceEntriesOf(second.manifest).map((entry) => [entry.id, entry])
  );
  const differences: SurfacePairDifference[] = [];

  const add = (
    entry: SurfaceEntryView,
    other: SurfaceEntryView | undefined,
    kind: CueAuditDifference["kind"],
    observation: string,
    onlyIn: "a" | "b" | null
  ): void => {
    differences.push(
      Object.freeze({
        surface_entry: entry.id,
        kind,
        allowed: differenceAllowed(policy, first.cellId, second.cellId, [
          entry,
          other
        ]),
        onlyIn,
        observation
      })
    );
  };

  for (const entry of entriesA.values()) {
    if (entry.channel === "workspace") {
      continue;
    }
    const other = entriesB.get(entry.id);
    if (other === undefined) {
      add(
        entry,
        undefined,
        "name",
        `${entry.target} appears only in cell ${first.cellId}.`,
        "a"
      );
      continue;
    }
    if (entry.target !== other.target) {
      const kind: CueAuditDifference["kind"] =
        entry.channel === "http-route" ? "route" : "name";
      add(
        entry,
        other,
        kind,
        `${entry.target} differs from ${other.target}.`,
        null
      );
    }
    if (entry.channel === "file") {
      if (
        entry.catalogSha256 !== other.catalogSha256 ||
        entry.bytes !== other.bytes ||
        entry.maxBytes !== other.maxBytes
      ) {
        add(
          entry,
          other,
          "bytes",
          `File digest ${entry.catalogSha256 ?? "none"} or size ${
            entry.bytes ?? "none"
          } of ${entry.maxBytes} differs from ${other.catalogSha256 ?? "none"} or ${
            other.bytes ?? "none"
          } of ${other.maxBytes}.`,
          null
        );
      }
      continue;
    }
    if (entry.catalogSha256 !== other.catalogSha256) {
      add(
        entry,
        other,
        "catalog",
        `Catalog digest ${entry.catalogSha256 ?? "none"} differs from ${
          other.catalogSha256 ?? "none"
        }.`,
        null
      );
    }
    if (entry.bytes !== other.bytes || entry.maxBytes !== other.maxBytes) {
      add(
        entry,
        other,
        "bytes",
        `Size ${entry.bytes ?? "none"} of ${entry.maxBytes} differs from ${
          other.bytes ?? "none"
        } of ${other.maxBytes}.`,
        null
      );
    }
  }
  for (const entry of entriesB.values()) {
    if (entry.channel === "workspace" || entriesA.has(entry.id)) {
      continue;
    }
    add(
      entry,
      undefined,
      "name",
      `${entry.target} appears only in cell ${second.cellId}.`,
      "b"
    );
  }
  return Object.freeze({
    cellA: first.cellId,
    cellB: second.cellId,
    differences: Object.freeze(differences)
  });
}

/**
 * Whether a declared owner allows this difference. An entry either cell
 * marks as provenance class `treatment` is owned by a factor. Otherwise the
 * treatment-owned lists must own the entry name, or the pair allowlist must
 * name the entry identifier or target.
 */
function differenceAllowed(
  policy: ParticipantSurfacePolicy,
  cellA: string,
  cellB: string,
  entries: readonly (SurfaceEntryView | undefined)[]
): boolean {
  const targets = new Set<string>();
  for (const entry of entries) {
    if (entry === undefined) {
      continue;
    }
    if (entry.provenanceClass === "treatment") {
      return true;
    }
    targets.add(entry.target);
    if (entry.id.startsWith("catalog-")) {
      targets.add(entry.id.slice("catalog-".length));
    }
  }
  for (const target of targets) {
    if (treatmentOwnedMatch(policy.treatment_owned, target) !== null) {
      return true;
    }
  }
  for (const rule of policy.pairwise_surface_diff_allowlist) {
    const pairMatches =
      (rule.cell_a === cellA && rule.cell_b === cellB) ||
      (rule.cell_a === cellB && rule.cell_b === cellA);
    if (!pairMatches) {
      continue;
    }
    for (const entry of entries) {
      if (entry !== undefined && rule.allowed_differences.includes(entry.id)) {
        return true;
      }
    }
    for (const target of targets) {
      if (rule.allowed_differences.includes(target)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Run the full analytical participant-surface check: compare every cell
 * pair, scan every rendered surface, build one private cue audit per cell,
 * and emit diagnostics. Unallowed lexical findings, participant information
 * that one cell shows and the other does not, and private artifacts on the
 * surface emit OAL-CUE-LEAK. Other unallowed differences emit OAL-CELL-DRIFT.
 * Required review evidence that is missing or not approved fails too.
 *
 * The scans run inside the bounded schema worker boundary, because the
 * policy patterns are pack-supplied.
 */
export async function checkParticipantSurfaces(input: {
  readonly policy: ParticipantSurfacePolicy;
  readonly cells: readonly CellSurface[];
  readonly reviews?: readonly ReviewEvidence[] | undefined;
  readonly blindingMode?: ProtocolBlinding["mode"] | undefined;
  readonly isolation?: "advisory" | "os" | undefined;
}): Promise<SurfaceCheckOutcome> {
  const outcomes = compareCellSurfaces(input.policy, input.cells);
  const pairwise: CueAuditPairwise[] = outcomes.map((outcome) => ({
    cell_a: outcome.cellA,
    cell_b: outcome.cellB,
    differences: outcome.differences.map((difference) => ({
      surface_entry: difference.surface_entry,
      kind: difference.kind,
      allowed: difference.allowed
    }))
  }));

  const diagnostics: Diagnostic[] = [];
  const audits: CueAudit[] = [];
  for (const cell of input.cells) {
    const audit = await buildCueAudit({
      cellId: cell.cellId,
      policy: input.policy,
      manifest: cell.manifest,
      rendered: cell.rendered ?? [],
      cellLevels: cell.cellLevels,
      pairwise
    });
    audits.push(audit);
    for (const finding of audit.findings) {
      if (finding.allowed_exception) {
        continue;
      }
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: "OAL-CUE-LEAK",
          message:
            `Cell ${cell.cellId} shows a forbidden ${finding.kind} ` +
            `"${finding.match}" in surface entry ${finding.surface_entry}.`,
          details: {
            cell_id: cell.cellId,
            surface_entry: finding.surface_entry,
            kind: finding.kind,
            match: finding.match
          }
        })
      );
    }
    for (const problem of privateArtifactProblems(cell.manifest)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: "OAL-CUE-LEAK",
          message: problem.message,
          details: {
            cell_id: cell.cellId,
            surface_entry: problem.entryId,
            target: problem.target
          }
        })
      );
    }
  }

  for (const outcome of outcomes) {
    for (const difference of outcome.differences) {
      if (difference.allowed) {
        continue;
      }
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: difference.onlyIn === null ? "OAL-CELL-DRIFT" : "OAL-CUE-LEAK",
          message:
            `Cells ${outcome.cellA} and ${outcome.cellB} differ on ` +
            `${difference.surface_entry}: ${difference.observation}`,
          details: {
            cell_a: outcome.cellA,
            cell_b: outcome.cellB,
            surface_entry: difference.surface_entry,
            kind: difference.kind
          }
        })
      );
    }
  }

  if (input.policy.required_reviews.equivalence) {
    const approved = (input.reviews ?? []).some(
      (review) => review.kind === "equivalence" && review.approved
    );
    if (!approved) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: SurfaceCheckCode.ReviewMissing,
          message:
            "The cue policy requires an approved equivalence review; none is on record."
        })
      );
    }
  }
  if (input.policy.required_reviews.blinding) {
    for (const audit of audits) {
      const covered = (input.reviews ?? []).some(
        (review) =>
          review.kind === "blinding" &&
          review.approved &&
          review.cueAuditSha256 === audit.sha256
      );
      if (!covered) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: SurfaceCheckCode.ReviewMissing,
            message:
              `The cue policy requires an approved blinding review of the ` +
              `cue audit of cell ${audit.cellId}.`,
            details: {
              cell_id: audit.cellId,
              cue_audit_sha256: audit.sha256
            }
          })
        );
      }
    }
    for (const review of input.reviews ?? []) {
      if (review.kind === "blinding" && !review.approved) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: SurfaceCheckCode.ReviewNotApproved,
            message:
              "A blinding review on record is not approved; reviewer approval is required."
          })
        );
      }
    }
  }

  if (input.blindingMode !== undefined && input.isolation !== undefined) {
    const advisory = cueIsolationAdvisory({
      blindingMode: input.blindingMode,
      isolation: input.isolation
    });
    if (advisory !== null) {
      diagnostics.push(advisory);
    }
  }

  return Object.freeze({
    audits: Object.freeze(audits),
    diagnostics: Object.freeze(diagnostics)
  });
}

/** Input of {@link classifySurfaceEntry}. */
export interface SurfaceClassificationInput {
  readonly channel: SurfaceChannel;
  readonly target: string;
  readonly source: string;
  /** Pack-relative origin of a file entry, when known. */
  readonly origin?: WorkspaceFileOrigin | undefined;
  /** Treatment-owned names of the cue policy, when supplied. */
  readonly treatmentOwned?: SurfacePolicyTreatmentOwned | undefined;
}

/**
 * Classify one surface entry into the four provenance classes of section
 * 9.6. Rules apply in order: treatment-owned names are `treatment`; the
 * selected contract and its routes, catalogs, credentials, and tools are
 * `contractual`; authored task material is `task_essential`; everything
 * else is framework text with no study purpose, `framework_incidental`.
 */
export function classifySurfaceEntry(
  input: SurfaceClassificationInput
): SurfaceProvenanceClass {
  if (
    input.treatmentOwned !== undefined &&
    treatmentOwnedMatch(input.treatmentOwned, input.target) !== null
  ) {
    return "treatment";
  }
  if (input.origin === "contract") {
    return "contractual";
  }
  if (
    input.channel === "http-route" ||
    input.channel === "credential" ||
    input.channel === "tool"
  ) {
    return "contractual";
  }
  if (
    input.origin === "prompt" ||
    input.origin === "participant-file" ||
    input.origin === "result-schema"
  ) {
    return "task_essential";
  }
  return "framework_incidental";
}

/** One historical cue a compatibility pack preserved as declared behavior. */
export interface PreservedCue {
  readonly entry_id: string;
  readonly pack_id: string;
  readonly pack_version: string;
  readonly sha256: string;
}

/** Result of {@link applyProvenancePolicy}. */
export interface ProvenanceOutcome {
  /** Entries that stay on the participant surface. */
  readonly kept: readonly SurfaceEntryView[];
  /** Framework-incidental entries removed by the default rule. */
  readonly removed: readonly SurfaceEntryView[];
  /** Pack declarations for preserved historical cues. */
  readonly preserved: readonly PreservedCue[];
}

/**
 * Apply the provenance rules of section 9.6. Framework-incidental entries
 * are removed by default. A compatibility pack may preserve one, but the
 * preserved cue becomes declared pack behavior with its own digest and is
 * reclassified as task-essential material; it can never stay neutral.
 */
export function applyProvenancePolicy(input: {
  readonly entries: readonly SurfaceEntryView[];
  /** Entry identifiers the compatibility pack preserves. */
  readonly preserve?: readonly string[] | undefined;
  readonly packId: string;
  readonly packVersion: string;
}): ProvenanceOutcome {
  const byId = new Map(
    input.entries.map((entry) => [entry.id, entry] as const)
  );
  const preserve = new Set<string>(input.preserve ?? []);
  for (const id of preserve) {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw invalidInput(
        SurfaceCheckCode.PreserveUnknown,
        `Preserved cue names no surface entry: ${id}.`,
        { entry_id: id }
      );
    }
    if (entry.provenanceClass !== "framework_incidental") {
      throw invalidInput(
        SurfaceCheckCode.PreserveNotIncidental,
        `Only framework-incidental entries can be preserved: ${id}.`,
        { entry_id: id, provenance_class: entry.provenanceClass }
      );
    }
  }

  const kept: SurfaceEntryView[] = [];
  const removed: SurfaceEntryView[] = [];
  const preserved: PreservedCue[] = [];
  for (const entry of input.entries) {
    if (entry.provenanceClass !== "framework_incidental") {
      kept.push(entry);
      continue;
    }
    if (preserve.has(entry.id)) {
      kept.push(Object.freeze({ ...entry, provenanceClass: "task_essential" }));
      preserved.push(
        Object.freeze({
          entry_id: entry.id,
          pack_id: input.packId,
          pack_version: input.packVersion,
          sha256: canonicalJsonSha256(surfaceEntryJson(entry))
        })
      );
      continue;
    }
    removed.push(entry);
  }
  return Object.freeze({
    kept: Object.freeze(kept),
    removed: Object.freeze(removed),
    preserved: Object.freeze(preserved)
  });
}

/** One post-run digest mismatch. */
export interface SurfaceDigestDrift {
  readonly code: "OAL-HASH-MISMATCH";
  readonly subject: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

/**
 * Verify the surface hashes after execution (section 9.6). The caller
 * supplies the rendered manifest digest frozen at participant launch and
 * the manifest observed after the run. Every mismatch reports drift with
 * the OAL-HASH-MISMATCH taxonomy code.
 */
export function verifyPostRunSurface(input: {
  readonly runId: string;
  /** Digest of the rendered manifest frozen at participant launch. */
  readonly frozenManifestSha256: string;
  /** Manifest rebuilt from the post-run workspace. */
  readonly observedManifest: JsonObject;
  /** Digest of the archived manifest document, when one was stored. */
  readonly observedManifestSha256?: string | undefined;
}): readonly SurfaceDigestDrift[] {
  if (!isSha256Hex(input.frozenManifestSha256)) {
    throw invalidInput(
      SurfaceCheckCode.DigestInvalid,
      "Frozen manifest digest is not a sha256 hex string.",
      { digest: input.frozenManifestSha256 }
    );
  }
  if (
    input.observedManifestSha256 !== undefined &&
    !isSha256Hex(input.observedManifestSha256)
  ) {
    throw invalidInput(
      SurfaceCheckCode.DigestInvalid,
      "Observed manifest digest is not a sha256 hex string.",
      { digest: input.observedManifestSha256 }
    );
  }
  const drift: SurfaceDigestDrift[] = [];
  const observed = canonicalJsonSha256(input.observedManifest);
  if (observed !== input.frozenManifestSha256) {
    drift.push(
      driftOf(
        "manifest",
        input.frozenManifestSha256,
        observed,
        `The surface manifest of run ${input.runId} drifted after execution.`
      )
    );
  }
  if (
    input.observedManifestSha256 !== undefined &&
    input.observedManifestSha256 !== input.frozenManifestSha256
  ) {
    drift.push(
      driftOf(
        "archived-manifest",
        input.frozenManifestSha256,
        input.observedManifestSha256,
        `The archived surface manifest of run ${input.runId} drifted after execution.`
      )
    );
  }
  if (input.observedManifest["template"] === false) {
    const recorded = input.observedManifest["rendered_sha256"];
    if (typeof recorded !== "string" || !isSha256Hex(recorded)) {
      throw invalidInput(
        SurfaceCheckCode.DigestInvalid,
        "Rendered manifest holds no valid rendered_sha256.",
        { run_id: input.runId }
      );
    }
    const body: JsonObject = {
      cell_id: input.observedManifest["cell_id"] ?? null,
      run_id: input.observedManifest["run_id"] ?? null,
      entries: input.observedManifest["entries"] ?? [],
      extensions: input.observedManifest["extensions"] ?? {}
    };
    const recomputed = canonicalJsonSha256(body);
    if (recomputed !== recorded) {
      drift.push(
        driftOf(
          "rendered_sha256",
          recorded,
          recomputed,
          `The recorded rendered digest of run ${input.runId} does not match its manifest body.`
        )
      );
    }
  }
  return Object.freeze(drift);
}

function driftOf(
  subject: string,
  expected: string,
  actual: string,
  message: string
): SurfaceDigestDrift {
  return Object.freeze({
    code: "OAL-HASH-MISMATCH",
    subject,
    expected,
    actual,
    message
  });
}
