/**
 * Evidence integrity classification (specification section 33.3).
 * Verification problems from the artifact store, stream tail health,
 * and contradiction signals combine into one classification with
 * stable reason codes. A corrupt trailing JSONL line is reported, not
 * hidden: the records before it stay valid and counted.
 */

import { readFile } from "node:fs/promises";
import { parseJsonStrict } from "@oal/core";
import type { EvidenceIntegrityFlag } from "./lifecycle.ts";

export type EvidenceClassification =
  | "valid"
  | "incomplete"
  | "invalid_evidence";

/** Contradiction signals accepted as classifier input (section 33.3). */
export type ContradictionSignal =
  | "undeclared_participant_surface_change"
  | "schedule_mutation"
  | "compatibility_drift"
  | "state_contradiction"
  | "semantic_contradiction"
  | "parent_exchange_contradiction";

export const CONTRADICTION_SIGNALS: readonly ContradictionSignal[] = [
  "undeclared_participant_surface_change",
  "schedule_mutation",
  "compatibility_drift",
  "state_contradiction",
  "semantic_contradiction",
  "parent_exchange_contradiction"
];

/** Stable reason code for each contradiction signal. */
const CONTRADICTION_REASONS: Readonly<
  Record<ContradictionSignal, IntegrityReasonCode>
> = {
  undeclared_participant_surface_change:
    "participant_surface_undeclared_change",
  schedule_mutation: "schedule_mutation",
  compatibility_drift: "compatibility_drift",
  state_contradiction: "state_contradiction",
  semantic_contradiction: "semantic_contradiction",
  parent_exchange_contradiction: "parent_exchange_contradiction"
};

/** Every reason code the classifier can emit. */
export type IntegrityReasonCode =
  | "artifact_missing"
  | "digest_mismatch"
  | "size_mismatch"
  | "manifest_missing"
  | "manifest_digest_mismatch"
  | "completion_pointer_invalid"
  | "corrupt_trailing_line"
  | "verification_problem_unclassified"
  | "participant_surface_undeclared_change"
  | "schedule_mutation"
  | "compatibility_drift"
  | "state_contradiction"
  | "semantic_contradiction"
  | "parent_exchange_contradiction";

/** Reasons that belong to a missing artifact, not a corrupt one. */
const INCOMPLETE_REASONS: ReadonlySet<IntegrityReasonCode> = new Set([
  "artifact_missing"
]);

/** Line-level health of one append-only JSONL stream. */
export interface TailHealthReport {
  /** Lines in the file, blank lines included. */
  total_lines: number;
  /** Lines that parse as strict JSON. */
  valid_records: number;
  /** One-based numbers of the lines that fail to parse. */
  corrupt_lines: number[];
  /** Highest corrupt line number, or null when every line parses. */
  last_corrupt_line: number | null;
  /**
   * Valid records before the last corrupt line. Without corruption it
   * equals valid_records.
   */
  valid_records_before_corruption: number;
  /** Whether the final line parses as strict JSON. */
  final_line_valid: boolean;
  /** Whether the file ends with a newline. */
  newline_terminated: boolean;
}

export interface IntegrityInput {
  /** Problems reported by ArtifactStore.verify. */
  problems: readonly string[];
  /** Contradiction signals observed by the caller. */
  contradictions?: readonly ContradictionSignal[] | undefined;
  /** Tail health of the append-only streams in scope. */
  streamHealth?: readonly TailHealthReport[] | undefined;
}

export interface IntegrityResult {
  classification: EvidenceClassification;
  /** Sorted, de-duplicated reason codes. */
  reason_codes: IntegrityReasonCode[];
}

/**
 * Read one JSONL file and report whether its final line is complete.
 * Every line is parsed, so a corrupt trailing line cannot erase the
 * valid records before it.
 */
export async function tailHealth(path: string): Promise<TailHealthReport> {
  const text = await readFile(path, "utf8");
  if (text.length === 0) {
    return {
      total_lines: 0,
      valid_records: 0,
      corrupt_lines: [],
      last_corrupt_line: null,
      valid_records_before_corruption: 0,
      final_line_valid: true,
      newline_terminated: true
    };
  }
  const newlineTerminated = text.endsWith("\n");
  const lines = (newlineTerminated ? text.slice(0, -1) : text).split("\n");
  const corruptLines: number[] = [];
  let validRecords = 0;
  let validBeforeCorruption = 0;
  let lastCorruptLine: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isStrictJson(line)) {
      validRecords += 1;
      continue;
    }
    corruptLines.push(index + 1);
    lastCorruptLine = index + 1;
    validBeforeCorruption = validRecords;
  }
  return {
    total_lines: lines.length,
    valid_records: validRecords,
    corrupt_lines: corruptLines,
    last_corrupt_line: lastCorruptLine,
    valid_records_before_corruption:
      lastCorruptLine === null ? validRecords : validBeforeCorruption,
    final_line_valid: isStrictJson(lines[lines.length - 1] ?? ""),
    newline_terminated: newlineTerminated
  };
}

/**
 * Classify one evidence set. Verification problems map onto reason
 * codes, contradictions always yield invalid_evidence, and only a
 * missing artifact without any corruption yields incomplete. A broken
 * manifest or completion pointer also yields invalid_evidence: the
 * evidence set then has no anchor left to verify against, so the
 * classifier fails closed.
 */
export function classifyEvidenceIntegrity(
  input: IntegrityInput
): IntegrityResult {
  const reasons = new Set<IntegrityReasonCode>();
  for (const signal of input.contradictions ?? []) {
    if (!CONTRADICTION_SIGNALS.includes(signal)) {
      continue;
    }
    reasons.add(CONTRADICTION_REASONS[signal]);
  }
  for (const problem of input.problems) {
    reasons.add(reasonForProblem(problem));
  }
  for (const health of input.streamHealth ?? []) {
    if (health.corrupt_lines.length > 0) {
      reasons.add("corrupt_trailing_line");
    }
  }
  const sorted = [...reasons].sort();
  const onlyMissing = sorted.every((reason) => INCOMPLETE_REASONS.has(reason));
  if (sorted.length === 0) {
    return { classification: "valid", reason_codes: [] };
  }
  return {
    classification: onlyMissing ? "incomplete" : "invalid_evidence",
    reason_codes: sorted
  };
}

/** Map one artifact store problem string onto its reason code. */
export function reasonForProblem(problem: string): IntegrityReasonCode {
  if (problem.includes("manifest is missing")) {
    return "manifest_missing";
  }
  if (problem.includes("completion pointer")) {
    return "completion_pointer_invalid";
  }
  if (problem.includes("manifest digest")) {
    return "manifest_digest_mismatch";
  }
  if (problem.includes("digest mismatch")) {
    return "digest_mismatch";
  }
  if (problem.includes("size mismatch")) {
    return "size_mismatch";
  }
  if (problem.endsWith(" is missing")) {
    return "artifact_missing";
  }
  return "verification_problem_unclassified";
}

/**
 * The section 22.4 evidence integrity flag for one classification:
 * valid maps to intact, incomplete to missing, and invalid_evidence to
 * corrupt.
 */
export function integrityFlag(
  classification: EvidenceClassification
): EvidenceIntegrityFlag {
  switch (classification) {
    case "valid":
      return "intact";
    case "incomplete":
      return "missing";
    default:
      return "corrupt";
  }
}

function isStrictJson(line: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }
  try {
    parseJsonStrict(line, { maxBytes: 4_194_304, maxNodes: 100_000 });
    return true;
  } catch {
    return false;
  }
}
