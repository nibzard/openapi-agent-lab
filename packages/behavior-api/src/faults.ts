/**
 * Deterministic fault rules (specification section 16.6). Scenarios
 * declare bounded faults; the engine matches them in declaration
 * order with per-rule occurrence counters and a rule-scoped PRNG.
 */

import type { Json } from "@oal/core";

export type FaultPhase = "before_behavior" | "after_behavior";

export interface FaultPredicate {
  /** Request parameter equality, keyed by parameter name. */
  parameters?: Record<string, Json>;
  /** Body top-level property equality. */
  body?: Record<string, Json>;
}

export interface FaultMatch {
  /** Exact occurrence number or bounded list, counted per rule. */
  occurrence?: number | number[];
  /** Restricted expression predicates over the request. */
  predicate?: FaultPredicate;
  /** Seeded probability in [0, 1] from the rule's PRNG namespace. */
  probability?: number;
  /** Inclusive virtual-time window in milliseconds. */
  windowMs?: { from: number; to: number };
}

export type FaultAction =
  | {
      kind: "response";
      status: number;
      media_type?: string;
      headers?: Record<string, string>;
      body?: Json;
    }
  | { kind: "disconnect"; after_bytes?: number }
  | { kind: "timeout" }
  | { kind: "corrupt_candidate" };

export interface FaultRule {
  id: string;
  operation: string;
  phase: FaultPhase;
  match: FaultMatch;
  action: FaultAction;
}

export interface FaultMatchInput {
  operation: string;
  phase: FaultPhase;
  /** Parameters after deserialization, all locations flattened. */
  parameters: Readonly<Record<string, Json>>;
  /** Request body; JSON bodies only participate in predicates. */
  body: Json | undefined;
  /** Current virtual time in milliseconds. */
  nowMs: number;
  /** Rule-scoped uniform sample in [0, 1). */
  sample: number;
}

export interface FaultEvaluation {
  rule: FaultRule;
  /** Occurrence count for the rule after this evaluation. */
  occurrence: number;
}

/** Per-run, per-rule occurrence counters. */
export class FaultCounters {
  private readonly counts = new Map<string, number>();

  next(ruleId: string): number {
    const current = this.counts.get(ruleId) ?? 0;
    const next = current + 1;
    this.counts.set(ruleId, next);
    return next;
  }

  get(ruleId: string): number {
    return this.counts.get(ruleId) ?? 0;
  }
}

function jsonEquals(left: Json | undefined, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesPredicate(
  predicate: FaultPredicate,
  input: FaultMatchInput
): boolean {
  for (const [name, expected] of Object.entries(predicate.parameters ?? {})) {
    if (!jsonEquals(input.parameters[name], expected)) {
      return false;
    }
  }
  if (predicate.body !== undefined) {
    if (
      typeof input.body !== "object" ||
      input.body === null ||
      Array.isArray(input.body)
    ) {
      return false;
    }
    for (const [name, expected] of Object.entries(predicate.body)) {
      if (!jsonEquals((input.body as Record<string, Json>)[name], expected)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Evaluate declared rules in declaration order. The first matching
 * terminal action wins. Counters advance for every evaluation that
 * passes the predicate and window gates, before the occurrence and
 * probability checks, so occurrence numbering stays deterministic.
 */
export function matchFault(
  rules: readonly FaultRule[],
  input: FaultMatchInput,
  counters: FaultCounters
): FaultEvaluation | null {
  for (const rule of rules) {
    if (rule.operation !== input.operation || rule.phase !== input.phase) {
      continue;
    }
    const { match } = rule;
    if (
      match.predicate !== undefined &&
      !matchesPredicate(match.predicate, input)
    ) {
      continue;
    }
    if (match.windowMs !== undefined) {
      const { from, to } = match.windowMs;
      if (input.nowMs < from || input.nowMs > to) {
        continue;
      }
    }
    const occurrence = counters.next(rule.id);
    if (match.occurrence !== undefined) {
      const wanted = Array.isArray(match.occurrence)
        ? match.occurrence
        : [match.occurrence];
      if (!wanted.includes(occurrence)) {
        continue;
      }
    }
    if (match.probability !== undefined) {
      if (input.sample >= match.probability) {
        continue;
      }
    }
    return { rule, occurrence };
  }
  return null;
}

/** Validate a scenario's fault declarations. Returns error text or null. */
export function validateFaultRules(rules: readonly FaultRule[]): string | null {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.id.length === 0) {
      return "fault rule has an empty id";
    }
    if (seen.has(rule.id)) {
      return `duplicate fault id ${rule.id}`;
    }
    seen.add(rule.id);
    if (rule.action.kind === "response") {
      if (
        !Number.isInteger(rule.action.status) ||
        rule.action.status < 200 ||
        rule.action.status > 599
      ) {
        return `fault ${rule.id} declares an invalid status`;
      }
    }
    if (
      rule.action.kind === "disconnect" &&
      rule.action.after_bytes !== undefined
    ) {
      if (
        !Number.isInteger(rule.action.after_bytes) ||
        rule.action.after_bytes < 0
      ) {
        return `fault ${rule.id} declares an invalid after_bytes bound`;
      }
    }
    const probability = rule.match.probability;
    if (probability !== undefined && (probability < 0 || probability > 1)) {
      return `fault ${rule.id} declares a probability outside [0, 1]`;
    }
    const window = rule.match.windowMs;
    if (window !== undefined && window.from > window.to) {
      return `fault ${rule.id} declares an inverted time window`;
    }
  }
  return null;
}
