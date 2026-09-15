/**
 * Hostile-pattern acceptance checks (strict ingestion). A pattern such
 * as `^(a+)+$` accepts its language, yet an adversarial value drives
 * its evaluation into exponential backtracking. The serving boundary
 * bounds the cost with a deadline, and this module names the risk at
 * ingestion time: every declared pattern answers a short adversarial
 * probe battery inside the same boundary, and a pattern that misses
 * the probe deadline becomes a diagnostic.
 *
 * The battery is a heuristic, not a proof. It builds candidates from
 * the pattern's own literal characters, which is where nearly every
 * catastrophic-backtracking shape trips. A pattern that passes can
 * still be hostile; a pattern that fails the probe is hostile with
 * near certainty, because benign patterns answer in microseconds.
 */

import {
  diagnostic,
  patternAcceptsInWorker,
  SchemaWorkerError,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import type { ContractIR, SchemaIR } from "@oal/contract-ir";

/** Diagnostic code of a pattern that missed the probe deadline. */
export const HOSTILE_PATTERN_CODE = "OAL-PATTERN-HOSTILE";

/** Probe deadline per candidate; benign patterns answer far faster. */
const PROBE_DEADLINE_MS = 100;

/** Candidate lengths; each step roughly doubles the explored tree. */
const PROBE_LENGTHS = [16, 24, 32] as const;

export interface HostilePatternOptions {
  /**
   * True when the caller runs strict mode: a hostile pattern is an
   * error. Otherwise it is a warning.
   */
  readonly strict?: boolean;
  /** Probe deadline per candidate in milliseconds. */
  readonly deadlineMs?: number;
}

/**
 * Probe every distinct pattern of one compiled contract and return one
 * diagnostic per hostile pattern. Patterns repeat across schemas of one
 * contract, so each distinct source string is probed once.
 */
export async function hostilePatternDiagnostics(
  contract: ContractIR,
  options: HostilePatternOptions = {}
): Promise<Diagnostic[]> {
  const findings: Diagnostic[] = [];
  const probed = new Set<string>();
  for (const schema of Object.values(contract.schemas)) {
    for (const pattern of patternsOf(schema)) {
      if (probed.has(pattern)) {
        continue;
      }
      probed.add(pattern);
      if (await patternIsHostile(pattern, options)) {
        findings.push(
          diagnostic({
            severity: options.strict === true ? "error" : "warning",
            phase: "compile",
            code: HOSTILE_PATTERN_CODE,
            message: `Pattern ${pattern} missed a ${options.deadlineMs ?? PROBE_DEADLINE_MS} ms adversarial probe. A served value can hit the schema-worker deadline.`,
            json_pointer: schema.source_pointer
          })
        );
      }
    }
  }
  return findings;
}

/** Collect every declared `pattern` keyword of one schema document. */
function* patternsOf(schema: SchemaIR): Generator<string> {
  yield* patternsOfNode(schema.schema);
}

function* patternsOfNode(node: Json): Generator<string> {
  if (Array.isArray(node)) {
    for (const entry of node) {
      yield* patternsOfNode(entry);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const holder = node as JsonObject;
  const pattern = holder["pattern"];
  if (typeof pattern === "string" && pattern.length > 0) {
    yield pattern;
  }
  for (const value of Object.values(holder)) {
    yield* patternsOfNode(value);
  }
}

/**
 * Build the adversarial battery of one pattern: its own two most
 * common literal characters, alone and in combination, each followed
 * by a character that forces the mismatch.
 */
function candidatesOf(pattern: string): string[] {
  const counts = new Map<string, number>();
  for (const ch of pattern) {
    if (/[a-z0-9]/.test(ch)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([ch]) => ch);
  const first = ranked[0] ?? "a";
  const second = ranked[1] ?? (first === "a" ? "b" : "a");
  const candidates: string[] = [];
  for (const length of PROBE_LENGTHS) {
    // A pure run plus a mismatching tail forces the full tree walk.
    candidates.push(`${first.repeat(length)}!`);
    // A mixed run stresses shapes such as `(a|ab)+` that stay linear
    // on a pure run.
    if (second !== first) {
      candidates.push(`${first.repeat(length - 8)}${second.repeat(8)}!`);
    }
  }
  return candidates;
}

/**
 * True when one pattern misses the probe deadline on any candidate.
 * Only a deadline counts as hostile: a compile failure or an ordinary
 * refusal is the pattern's business, not a resource risk.
 */
async function patternIsHostile(
  pattern: string,
  options: HostilePatternOptions
): Promise<boolean> {
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  for (const candidate of candidatesOf(pattern)) {
    try {
      await patternAcceptsInWorker(pattern, candidate, { deadlineMs });
    } catch (error) {
      if (
        error instanceof SchemaWorkerError &&
        error.code === "OAL-SCHEMA-WORKER-TIMEOUT"
      ) {
        return true;
      }
    }
  }
  return false;
}
