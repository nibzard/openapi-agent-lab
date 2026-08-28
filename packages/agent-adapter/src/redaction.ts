/**
 * Session-event redaction (specification sections 21.2 and 30.3).
 *
 * The recorder must redact even when the sink offers no redact hook, because
 * the runner sink only forwards events. The registry below is built from the
 * credential values the runner already placed in the run context, and the
 * shared evidence Redactor performs the replacement, so session previews and
 * the participant report agree on one [REDACTED] representation.
 */

import { Redactor } from "@oal/evidence";

import type { AgentRunContext, TextRedactor } from "./types.ts";

/**
 * HMAC key of the shared redactor. Session text redaction only substitutes
 * the marker, so the key never reaches an output, and a fixed key keeps the
 * adapter free of run state.
 */
const SESSION_HMAC_KEY = new Uint8Array(32);

/** Shortest registered value. Shorter strings would corrupt ordinary text. */
const MIN_SECRET_CHARS = 4;

/** Order secrets so a longer value replaces before its own substrings. */
function byLengthDescending(a: string, b: string): number {
  return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Suffixes the environment builder appends to a scheme's credential name
 * when one http basic scheme splits into a username and a password. The
 * runner writes `OAL_AUTH_<ALIAS>_USERNAME` and `OAL_AUTH_<ALIAS>_PASSWORD`
 * while it declares the bare scheme name plus the constant split names
 * `OAL_AUTH_BASIC_USERNAME` and `OAL_AUTH_BASIC_PASSWORD`, so one declared
 * name covers the bare form and both split forms.
 */
const CREDENTIAL_SPLIT_SUFFIXES = ["_USERNAME", "_PASSWORD"] as const;

/** Declared names plus the split forms the environment builder writes. */
function declaredCredentialNames(
  names: readonly string[] | undefined
): Set<string> {
  const declared = new Set<string>();
  for (const name of names ?? []) {
    declared.add(name);
    for (const suffix of CREDENTIAL_SPLIT_SUFFIXES) {
      declared.add(`${name}${suffix}`);
    }
  }
  return declared;
}

/**
 * Every credential value the run context can expose through child output. A
 * value registers when its environment name is a declared credential name
 * or one of its basic split forms, when a section 30.3 key pattern flags
 * the name, or when the value itself has a credential shape.
 */
export function sessionSecrets(context: AgentRunContext): string[] {
  const probe = new Redactor({ hmacKey: SESSION_HMAC_KEY });
  const declared = declaredCredentialNames(context.exposure.credentialNames);
  const secrets = new Set<string>();
  for (const environment of [
    context.toolEnvironment,
    context.launcherEnvironment
  ]) {
    for (const [name, value] of Object.entries(environment)) {
      if (value.length < MIN_SECRET_CHARS) {
        continue;
      }
      if (
        declared.has(name) ||
        probe.isSensitiveKey(name) ||
        probe.credentialKind(value) !== null
      ) {
        secrets.add(value);
      }
    }
  }
  return [...secrets].sort(byLengthDescending);
}

/**
 * Redactor for one run's session events. Every adapter passes it to the
 * recorder, so redaction never depends on the sink contract.
 */
export function createSessionRedactor(context: AgentRunContext): TextRedactor {
  const redactor = new Redactor({
    hmacKey: SESSION_HMAC_KEY,
    secrets: sessionSecrets(context)
  });
  return (text: string): string => redactor.redactText(text);
}
