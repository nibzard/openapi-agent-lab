import type { Json } from "@oal/core";

/**
 * Credential-shape recognition from specification sections 30.1 and 30.3.
 * These patterns classify locations and shapes; they never capture or echo
 * the matched value.
 */

/** Case-insensitive key pattern for credential-shaped names. */
export const SENSITIVE_KEY_PATTERN =
  /(api.?key|token|secret|password|authorization|credential|private.?key|cookie|session.?id|access.?key)/i;

/** Annotation a pack author uses to mark a value as sensitive. */
export const SENSITIVE_ANNOTATION = "x-agent-lab-sensitive";

export type SensitiveKind =
  | "bearer_token"
  | "basic_credential"
  | "jwt"
  | "pem_private_key"
  | "provider_key"
  | "annotated"
  | "sensitive_key";

interface ValueShape {
  readonly kind: SensitiveKind;
  readonly pattern: RegExp;
}

const VALUE_SHAPES: readonly ValueShape[] = [
  {
    kind: "bearer_token",
    pattern: /^Bearer\s+[A-Za-z0-9._~+/=-]{8,}$/i
  },
  {
    kind: "basic_credential",
    pattern: /^Basic\s+[A-Za-z0-9+/=]{8,}$/i
  },
  {
    kind: "jwt",
    pattern: /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/
  },
  {
    kind: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  },
  {
    kind: "provider_key",
    pattern:
      /^(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})$/
  }
];

/** High-confidence production credential shapes that fail ingestion. */
const HIGH_CONFIDENCE_SHAPES: readonly RegExp[] = [
  /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----/,
  /^AKIA[0-9A-Z]{16}$/,
  /^sk-[A-Za-z0-9]{32,}$/,
  /^ghp_[A-Za-z0-9]{36,}$/,
  /^github_pat_[A-Za-z0-9_]{40,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{20,}$/
];

/** True when a key name is credential-shaped. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Classify a value as credential-shaped. Returns a kind label or null; the
 * value itself is never returned.
 */
export function classifySensitiveValue(value: Json): SensitiveKind | null {
  if (typeof value !== "string") {
    return null;
  }
  for (const shape of VALUE_SHAPES) {
    if (shape.pattern.test(value)) {
      return shape.kind;
    }
  }
  return null;
}

/**
 * Detect a high-confidence production credential. The scan covers a bounded
 * depth of nested collections so an object example cannot smuggle one in.
 * Such a finding fails ingestion with `OAL-INPUT-SECRET-DETECTED`.
 */
export function detectHighConfidenceSecret(value: Json, depth = 0): boolean {
  if (typeof value === "string") {
    return HIGH_CONFIDENCE_SHAPES.some((pattern) => pattern.test(value));
  }
  if (depth >= 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => detectHighConfidenceSecret(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) =>
      detectHighConfidenceSecret(item, depth + 1)
    );
  }
  return false;
}

/**
 * Decide whether an example under `key` must be skipped and redacted.
 * Sensitive examples stay out of ContractIR and of every participant copy.
 */
export function isSensitiveExample(key: string | null, value: Json): boolean {
  if (key !== null && isSensitiveKey(key)) {
    return true;
  }
  return classifySensitiveValue(value) !== null;
}
