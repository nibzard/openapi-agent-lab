/**
 * Privacy rules for report content (specification sections 27.4 and 30).
 *
 * A report is a public artifact, so it carries three guards:
 *
 * 1. Credential material and registered run secrets are replaced with
 *    the section 30.4 representation, reusing the evidence Redactor.
 * 2. Hidden chain-of-thought never enters a report: keys that name
 *    reasoning are removed and free text is bounded.
 * 3. Bounded summaries: object entries, array items, and nesting depth
 *    are capped so a report cannot grow without limit.
 *
 * Every function here is pure. Fingerprints come from the supplied
 * HMAC key; no clock, randomness, or environment read is involved.
 */

import { isJsonObject, type Json } from "@oal/core";
import { Redactor } from "@oal/evidence";

/** Key fragments that name hidden reasoning. Removed, not truncated. */
export const CHAIN_OF_THOUGHT_KEY_FRAGMENTS: readonly string[] = [
  "chain_of_thought",
  "chain-of-thought",
  "reasoning",
  "thinking",
  "thought"
];

/** Maximum length of one string inside a redacted summary. */
export const MAX_SUMMARY_TEXT_LENGTH = 200;

/** Maximum entries per object and items per array inside a summary. */
export const MAX_SUMMARY_ENTRIES = 64;

/** Maximum nesting depth of a summary. */
export const MAX_SUMMARY_DEPTH = 8;

/** Truncation marker appended to bounded strings. */
export const TRUNCATION_MARKER = "[truncated]";

/** Text replacement for redacted content (section 30.4 text contexts). */
export const REDACTED_TEXT = "[REDACTED]";

/** HMAC key and exact secret registry for summary redaction. */
export interface SummaryRedactionContext {
  hmacKey: Uint8Array;
  secrets?: readonly string[] | undefined;
}

function isChainOfThoughtKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return CHAIN_OF_THOUGHT_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

function boundText(text: string): string {
  if (text.length <= MAX_SUMMARY_TEXT_LENGTH) {
    return text;
  }
  const kept = MAX_SUMMARY_TEXT_LENGTH - TRUNCATION_MARKER.length;
  return `${text.slice(0, Math.max(0, kept))}${TRUNCATION_MARKER}`;
}

/**
 * Redact one final-state summary. Credential-shaped values, sensitive
 * keys, and registered secrets are replaced first when a context is
 * supplied; the structural guard always runs afterwards.
 */
export function redactSummary(
  value: Json,
  context?: SummaryRedactionContext
): Json {
  const credentialPass =
    context === undefined
      ? value
      : new Redactor({
          hmacKey: context.hmacKey,
          secrets: context.secrets ?? []
        }).redactJson(value);
  return boundNode(credentialPass, 0, context);
}

function boundNode(
  value: Json,
  depth: number,
  context?: SummaryRedactionContext
): Json {
  if (typeof value === "string") {
    const withoutSecrets = removeRegisteredSecrets(value, context);
    return boundText(withoutSecrets);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return [];
    }
    const kept = value.slice(0, MAX_SUMMARY_ENTRIES);
    return kept.map((item) => boundNode(item, depth + 1, context));
  }
  if (isJsonObject(value)) {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return {};
    }
    const out: Record<string, Json> = {};
    const surviving = Object.keys(value).filter(
      (key) => !isChainOfThoughtKey(key)
    );
    const kept = surviving.sort().slice(0, MAX_SUMMARY_ENTRIES);
    for (const key of kept) {
      const inner = value[key];
      if (inner !== undefined) {
        out[key] = boundNode(inner, depth + 1, context);
      }
    }
    // The marker reports entry-cap loss only. Removed reasoning keys
    // are redaction, not truncation, so they stay unmarked.
    if (surviving.length > kept.length) {
      out["truncated"] = true;
    }
    return out;
  }
  return value;
}

function removeRegisteredSecrets(
  text: string,
  context?: SummaryRedactionContext
): string {
  const secrets = context?.secrets;
  if (secrets === undefined || secrets.length === 0) {
    return text;
  }
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join(REDACTED_TEXT);
    }
  }
  return result;
}

/**
 * Last line of defense for a finished report: replace every registered
 * secret occurrence inside any string of the document. Key patterns are
 * deliberately not applied here because pattern-constrained fields such
 * as digests must keep their shape.
 */
export function enforceReportRedaction<T>(
  document: T,
  secrets: readonly string[]
): T {
  if (secrets.length === 0) {
    return document;
  }
  return redactStrings(document as unknown as Json, secrets) as unknown as T;
}

function redactStrings(value: Json, secrets: readonly string[]): Json {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (secret.length > 0) {
        result = result.split(secret).join(REDACTED_TEXT);
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item, secrets));
  }
  if (isJsonObject(value)) {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = value[key];
      if (inner !== undefined) {
        out[key] = redactStrings(inner, secrets);
      }
    }
    return out;
  }
  return value;
}

/**
 * Assert the redaction canary rule of section 30.6 for one report:
 * none of the registered secrets may occur anywhere in the canonical
 * JSON of the document.
 */
export function containsAnySecret(
  canonicalDocument: string,
  secrets: readonly string[]
): string | null {
  for (const secret of secrets) {
    if (secret.length > 0 && canonicalDocument.includes(secret)) {
      return secret;
    }
  }
  return null;
}
