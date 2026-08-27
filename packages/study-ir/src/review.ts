/**
 * Human review artifacts of a study (specification sections 12.12 and 22.6).
 *
 * A BlindingReview records that people compared rendered participant
 * surfaces across cells. An EquivalenceReview records that people compared
 * counterfactual contract variants. Both are evidence, not proof. The
 * loaders validate the document shape and one semantic rule the schema
 * cannot express: an approval contradicts a blocking finding.
 */

import {
  diagnostic,
  isJsonObject,
  isSafeId,
  isSha256Hex,
  SchemaValidator,
  type Diagnostic,
  type Json
} from "@oal/core";

import { StudyCode } from "./codes.ts";

export interface ReviewReviewer {
  readonly name: string;
  readonly role: string;
}

export type FindingSeverity = "info" | "minor" | "major" | "blocking";

export interface ReviewFinding {
  readonly severity: FindingSeverity;
  readonly description: string;
  readonly resolution?: string | null | undefined;
}

export interface BlindingReviewSurface {
  readonly cell_id: string;
  readonly manifest_sha256: string;
}

/** Typed BlindingReview. Serialized form validates against its schema. */
export interface BlindingReview {
  readonly schema_version: 1;
  readonly kind: "BlindingReview";
  readonly id: string;
  readonly reviewed_at?: string | undefined;
  readonly reviewers: readonly ReviewReviewer[];
  readonly reviewed_surfaces: readonly BlindingReviewSurface[];
  readonly cue_audit_sha256: string;
  readonly findings: readonly ReviewFinding[];
  readonly approved: boolean;
  readonly extensions: Readonly<Record<string, Json>>;
}

export interface EquivalenceReviewedArtifact {
  readonly artifact: string;
  readonly sha256: string;
}

/** Typed EquivalenceReview. Serialized form validates against its schema. */
export interface EquivalenceReview {
  readonly schema_version: 1;
  readonly kind: "EquivalenceReview";
  readonly id: string;
  readonly reviewed_at?: string | undefined;
  readonly reviewers: readonly ReviewReviewer[];
  readonly reviewed: readonly EquivalenceReviewedArtifact[];
  readonly findings: readonly ReviewFinding[];
  readonly approved: boolean;
  readonly extensions: Readonly<Record<string, Json>>;
}

export interface ReviewLoadOptions {
  readonly schema?: Json | undefined;
  readonly documentUri?: string | undefined;
}

export interface BlindingReviewLoadResult {
  readonly review: BlindingReview | null;
  readonly diagnostics: Diagnostic[];
}

export interface EquivalenceReviewLoadResult {
  readonly review: EquivalenceReview | null;
  readonly diagnostics: Diagnostic[];
}

const SEVERITIES: ReadonlySet<string> = new Set<string>([
  "info",
  "minor",
  "major",
  "blocking"
]);

function schemaDiagnostics(
  document: Json,
  schema: Json | undefined,
  documentUri: string | null,
  report: (entry: Diagnostic) => void
): void {
  if (schema === undefined) {
    return;
  }
  const violations = new SchemaValidator(schema).errors(document);
  for (const violation of violations) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.SchemaInvalid,
        message: `${violation.code}: ${violation.message}`,
        document_uri: documentUri,
        json_pointer:
          violation.pointer.length === 0
            ? "#/"
            : `#/${violation.pointer.slice(1)}`
      })
    );
  }
}

function readReviewers(
  value: Json | undefined,
  report: (entry: Diagnostic) => void
): ReviewReviewer[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A review needs at least one reviewer.",
        json_pointer: "#/reviewers"
      })
    );
    return null;
  }
  const reviewers: ReviewReviewer[] = [];
  for (const entry of value) {
    if (
      !isJsonObject(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["role"] !== "string"
    ) {
      continue;
    }
    reviewers.push({ name: entry["name"], role: entry["role"] });
  }
  if (reviewers.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A review needs at least one resolvable reviewer.",
        json_pointer: "#/reviewers"
      })
    );
    return null;
  }
  return reviewers;
}

function readFindings(value: Json | undefined): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const findings: ReviewFinding[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const severity = entry["severity"];
    const description = entry["description"];
    if (
      typeof severity !== "string" ||
      !SEVERITIES.has(severity) ||
      typeof description !== "string"
    ) {
      continue;
    }
    const resolution = entry["resolution"];
    findings.push({
      severity: severity as FindingSeverity,
      description,
      ...(typeof resolution === "string" || resolution === null
        ? { resolution }
        : {})
    });
  }
  return findings;
}

/** An approval contradicts a blocking finding. */
function checkApprovalConsistency(
  kind: string,
  approved: boolean,
  findings: readonly ReviewFinding[],
  report: (entry: Diagnostic) => void
): void {
  if (!approved) {
    return;
  }
  for (const finding of findings) {
    if (finding.severity === "blocking") {
      report(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCode.StructureInvalid,
          message: `The ${kind} is approved but records a blocking finding.`,
          json_pointer: "#/approved"
        })
      );
      return;
    }
  }
}

/** Load one BlindingReview document. Never throws on content. */
export function loadBlindingReview(
  document: Json,
  options: ReviewLoadOptions = {}
): BlindingReviewLoadResult {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;
  schemaDiagnostics(document, options.schema, uri, report);
  if (!isJsonObject(document)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A BlindingReview must be an object.",
        document_uri: uri,
        json_pointer: "#/"
      })
    );
    return { review: null, diagnostics };
  }
  const id = typeof document["id"] === "string" ? document["id"] : null;
  if (id === null || !isSafeId(id)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A BlindingReview id must be a safe identifier.",
        document_uri: uri,
        json_pointer: "#/id"
      })
    );
    return { review: null, diagnostics };
  }
  const reviewers = readReviewers(document["reviewers"], report);
  const surfacesValue = document["reviewed_surfaces"];
  const surfaces: BlindingReviewSurface[] = [];
  if (Array.isArray(surfacesValue)) {
    for (const entry of surfacesValue) {
      if (
        !isJsonObject(entry) ||
        typeof entry["cell_id"] !== "string" ||
        typeof entry["manifest_sha256"] !== "string" ||
        !isSha256Hex(entry["manifest_sha256"])
      ) {
        continue;
      }
      surfaces.push({
        cell_id: entry["cell_id"],
        manifest_sha256: entry["manifest_sha256"]
      });
    }
  }
  if (surfaces.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "A BlindingReview must cover at least one cell surface.",
        document_uri: uri,
        json_pointer: "#/reviewed_surfaces"
      })
    );
  }
  const cueAudit = document["cue_audit_sha256"];
  if (typeof cueAudit !== "string" || !isSha256Hex(cueAudit)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "cue_audit_sha256 must be a lowercase SHA-256 digest.",
        document_uri: uri,
        json_pointer: "#/cue_audit_sha256"
      })
    );
  }
  const approved = document["approved"];
  if (typeof approved !== "boolean") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "approved must be a boolean.",
        document_uri: uri,
        json_pointer: "#/approved"
      })
    );
    return { review: null, diagnostics };
  }
  const findings = readFindings(document["findings"]);
  checkApprovalConsistency("BlindingReview", approved, findings, report);
  if (
    reviewers === null ||
    surfaces.length === 0 ||
    typeof cueAudit !== "string"
  ) {
    return { review: null, diagnostics };
  }
  const reviewedAt = document["reviewed_at"];
  const review: BlindingReview = {
    schema_version: 1,
    kind: "BlindingReview",
    id,
    ...(typeof reviewedAt === "string" ? { reviewed_at: reviewedAt } : {}),
    reviewers,
    reviewed_surfaces: surfaces,
    cue_audit_sha256: cueAudit,
    findings,
    approved,
    extensions: isJsonObject(document["extensions"])
      ? document["extensions"]
      : {}
  };
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { review: null, diagnostics };
  }
  return { review, diagnostics };
}

/** Load one EquivalenceReview document. Never throws on content. */
export function loadEquivalenceReview(
  document: Json,
  options: ReviewLoadOptions = {}
): EquivalenceReviewLoadResult {
  const diagnostics: Diagnostic[] = [];
  const report = (entry: Diagnostic): void => {
    diagnostics.push(entry);
  };
  const uri = options.documentUri ?? null;
  schemaDiagnostics(document, options.schema, uri, report);
  if (!isJsonObject(document)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "An EquivalenceReview must be an object.",
        document_uri: uri,
        json_pointer: "#/"
      })
    );
    return { review: null, diagnostics };
  }
  const id = typeof document["id"] === "string" ? document["id"] : null;
  if (id === null || !isSafeId(id)) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "An EquivalenceReview id must be a safe identifier.",
        document_uri: uri,
        json_pointer: "#/id"
      })
    );
    return { review: null, diagnostics };
  }
  const reviewers = readReviewers(document["reviewers"], report);
  const reviewedValue = document["reviewed"];
  const reviewed: EquivalenceReviewedArtifact[] = [];
  if (Array.isArray(reviewedValue)) {
    for (const entry of reviewedValue) {
      if (
        !isJsonObject(entry) ||
        typeof entry["artifact"] !== "string" ||
        typeof entry["sha256"] !== "string" ||
        !isSha256Hex(entry["sha256"])
      ) {
        continue;
      }
      reviewed.push({ artifact: entry["artifact"], sha256: entry["sha256"] });
    }
  }
  if (reviewed.length === 0) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "An EquivalenceReview must name at least one reviewed digest.",
        document_uri: uri,
        json_pointer: "#/reviewed"
      })
    );
  }
  if (reviewers !== null && reviewers.length < 2) {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "An EquivalenceReview needs at least two reviewers.",
        document_uri: uri,
        json_pointer: "#/reviewers"
      })
    );
  }
  const approved = document["approved"];
  if (typeof approved !== "boolean") {
    report(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: StudyCode.StructureInvalid,
        message: "approved must be a boolean.",
        document_uri: uri,
        json_pointer: "#/approved"
      })
    );
    return { review: null, diagnostics };
  }
  const findings = readFindings(document["findings"]);
  checkApprovalConsistency("EquivalenceReview", approved, findings, report);
  if (reviewers === null || reviewed.length === 0) {
    return { review: null, diagnostics };
  }
  const reviewedAt = document["reviewed_at"];
  const review: EquivalenceReview = {
    schema_version: 1,
    kind: "EquivalenceReview",
    id,
    ...(typeof reviewedAt === "string" ? { reviewed_at: reviewedAt } : {}),
    reviewers,
    reviewed,
    findings,
    approved,
    extensions: isJsonObject(document["extensions"])
      ? document["extensions"]
      : {}
  };
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { review: null, diagnostics };
  }
  return { review, diagnostics };
}
