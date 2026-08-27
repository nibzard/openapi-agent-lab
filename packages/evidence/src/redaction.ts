/**
 * Credential redaction (specification section 30). Redaction runs
 * before any persistence or telemetry: names derive from security
 * schemes and configuration, values from an exact secret registry,
 * key patterns, and defensive shape recognition. Structured evidence
 * keeps a keyed fingerprint; text contexts use [REDACTED].
 */

import { createHmac } from "node:crypto";
import { isJsonObject, type Json, type JsonObject } from "@oal/core";

/** Case-insensitive name fragments from section 30.3. */
export const DEFAULT_KEY_PATTERNS: readonly string[] = [
  "api key",
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "private key",
  "privatekey"
];

export interface RedactionConfig {
  /** Exact header names, compared lowercase. */
  sensitiveHeaderNames?: string[];
  /** Exact cookie names. */
  sensitiveCookieNames?: string[];
  /** Exact query parameter names. */
  sensitiveQueryNames?: string[];
  /** Path parameter names whose values get stable fingerprints. */
  sensitivePathParameters?: string[];
  /** JSON Pointers redacted wherever they appear in bodies. */
  jsonPointers?: string[];
  /** Form field names. */
  formFields?: string[];
  /** Environment variable names. */
  environmentNames?: string[];
  /** Case-insensitive key fragments. */
  keyPatterns?: string[];
}

export interface RedactorOptions {
  /** Run- or installation-specific HMAC key; never a plain digest. */
  hmacKey: Uint8Array;
  /** Exact-value registry of every run secret. */
  secrets?: readonly string[];
  config?: RedactionConfig;
}

/** Structured replacement shape from section 30.4. */
export interface RedactedValue {
  redacted: true;
  kind: string;
  fingerprint: string;
}

/** Collapse separators so x-api-key, x_api_key, and x api key unify. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]+/g, "");
}

/** Kind labels for recognized credential shapes. */
type ShapeKind =
  | "bearer_token"
  | "basic_credential"
  | "jwt"
  | "private_key"
  | "provider_key";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PROVIDER_KEY_PREFIXES: readonly string[] = [
  "sk-",
  "pk-",
  "rk-",
  "ghp_",
  "gho_",
  "xoxb-",
  "xoxp-",
  "AKIA"
];

export class Redactor {
  private readonly hmacKey: Uint8Array;
  private readonly secrets: readonly string[];
  private readonly patterns: readonly string[];
  private readonly sensitiveNames: ReadonlySet<string>;
  readonly config: RedactionConfig;

  constructor(options: RedactorOptions) {
    this.hmacKey = options.hmacKey;
    this.secrets = (options.secrets ?? []).filter((value) => value.length > 0);
    this.config = options.config ?? {};
    this.patterns =
      options.config?.keyPatterns === undefined
        ? DEFAULT_KEY_PATTERNS
        : options.config.keyPatterns;
    const names = new Set<string>();
    for (const name of options.config?.sensitiveHeaderNames ?? []) {
      names.add(name.toLowerCase());
    }
    for (const name of options.config?.sensitiveCookieNames ?? []) {
      names.add(name.toLowerCase());
    }
    for (const name of options.config?.sensitiveQueryNames ?? []) {
      names.add(name.toLowerCase());
    }
    for (const name of options.config?.formFields ?? []) {
      names.add(name.toLowerCase());
    }
    this.sensitiveNames = names;
  }

  /** Keyed fingerprint with the section 30.4 representation. */
  fingerprint(value: string): string {
    const digest = createHmac("sha256", this.hmacKey)
      .update(value)
      .digest("hex");
    return `hmac-sha256:${digest.slice(0, 8)}`;
  }

  /** Stable fingerprint for sensitive path segments (section 25.4). */
  pathFingerprint(segment: string): string {
    const digest = createHmac("sha256", this.hmacKey)
      .update(segment)
      .digest("hex");
    return `path-${digest.slice(0, 12)}`;
  }

  /** Whether a header, cookie, query, or form name is configured sensitive. */
  isSensitiveName(name: string): boolean {
    return this.sensitiveNames.has(name.toLowerCase());
  }

  /** Whether a key matches a configured case-insensitive pattern. */
  isSensitiveKey(key: string): boolean {
    if (this.isSensitiveName(key)) {
      return true;
    }
    const normalized = normalizeKey(key);
    for (const pattern of this.patterns) {
      if (normalized.includes(normalizeKey(pattern))) {
        return true;
      }
    }
    return false;
  }

  /** Whether a value is an exact registered secret or contains one. */
  containsSecret(value: string): boolean {
    for (const secret of this.secrets) {
      if (value.includes(secret)) {
        return true;
      }
    }
    return false;
  }

  /** Defensive recognition of credential shapes (section 30.3). */
  credentialKind(value: string): ShapeKind | null {
    if (value.startsWith("Bearer ")) {
      return "bearer_token";
    }
    if (value.startsWith("Basic ")) {
      return "basic_credential";
    }
    if (value.includes("-----BEGIN") && value.includes("PRIVATE KEY-----")) {
      return "private_key";
    }
    if (value.length >= 24 && JWT_PATTERN.test(value)) {
      return "jwt";
    }
    for (const prefix of PROVIDER_KEY_PREFIXES) {
      if (value.startsWith(prefix) && value.length >= prefix.length + 8) {
        return "provider_key";
      }
    }
    return null;
  }

  /** Structured replacement for a sensitive value (section 30.4). */
  redactedValue(value: string, kind?: string): RedactedValue {
    return {
      redacted: true,
      kind: kind ?? "sensitive_value",
      fingerprint: this.fingerprint(value)
    };
  }

  /**
   * Redact one header: the value becomes [REDACTED] with the
   * structured kind recorded on the trace header record by the caller.
   */
  redactHeaderValue(name: string, value: string): string {
    if (this.isSensitiveName(name) || this.isSensitiveKey(name)) {
      return "[REDACTED]";
    }
    if (this.containsSecret(value) || this.credentialKind(value) !== null) {
      return "[REDACTED]";
    }
    return value;
  }

  /** Redact one cookie value by cookie name. */
  redactCookieValue(name: string, value: string): string {
    if (this.isSensitiveKey(name) || this.containsSecret(value)) {
      return "[REDACTED]";
    }
    return value;
  }

  /**
   * Redact one query value by parameter name. Sensitive names keep a
   * stable fingerprint so cross-event equality survives redaction.
   */
  redactQueryValue(name: string, value: string): string {
    if (this.isSensitiveKey(name)) {
      return this.pathFingerprint(value);
    }
    if (this.containsSecret(value)) {
      return "[REDACTED]";
    }
    return value;
  }

  /**
   * Redact a path parameter or segment value: a stable HMAC
   * fingerprint, never the raw target (section 25.4).
   */
  redactPathValue(value: string): string {
    return this.pathFingerprint(value);
  }

  /** Recursively redact a JSON value in place, returning a new value. */
  redactJson(value: Json): Json {
    return this.redactNode(value, []);
  }

  /** Replace every registered secret occurrence inside free text. */
  redactText(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join("[REDACTED]");
    }
    return result;
  }

  private redactNode(value: Json, pointer: string[]): Json {
    if (typeof value === "string") {
      if (this.pointerIsSensitive(pointer)) {
        return this.redactedValue(value, "sensitive_pointer");
      }
      if (this.containsSecret(value)) {
        return this.redactedValue(value, "registered_secret");
      }
      const shape = this.credentialKind(value);
      if (shape !== null) {
        return this.redactedValue(value, shape);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.redactNode(item, [...pointer, index.toString(10)])
      );
    }
    if (isJsonObject(value)) {
      const redacted: JsonObject = {};
      for (const [key, inner] of Object.entries(value)) {
        if (this.isSensitiveKey(key)) {
          redacted[key] = this.redactedValue(
            typeof inner === "string" ? inner : JSON.stringify(inner),
            "sensitive_key"
          );
          continue;
        }
        redacted[key] = this.redactNode(inner, [...pointer, key]);
      }
      return redacted;
    }
    return value;
  }

  private pointerIsSensitive(pointer: string[]): boolean {
    if (this.config.jsonPointers === undefined) {
      return false;
    }
    const joined = `/${pointer.join("/")}`;
    return this.config.jsonPointers.includes(joined);
  }
}
