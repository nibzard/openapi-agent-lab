/**
 * Canonical credential key-name recognition (specification section 30.3).
 *
 * Every sink that decides whether a key name is credential-shaped
 * delegates here: compiler example screening, trace headers and queries,
 * JSON redaction, and session environment scanning. One list keeps the
 * sinks in agreement, so a credential name one sink recognizes cannot
 * pass another sink untouched.
 *
 * The canonical list is the union of the lists the sinks used before
 * unification: the section 30.3 fragments (API key, token, secret,
 * password, authorization, cookie, credential, private key) plus the
 * session-id and access-key fragments the compiler screening added.
 *
 * A key name matches when either rule fires:
 *
 * 1. Normalized containment. The key is lowercased and every run of
 *    `-`, `_`, and whitespace collapses away, so `x-api-key`,
 *    `x_api_key`, `api--key`, and `t o k e n` all contain their
 *    fragment.
 * 2. Loose compound join. One arbitrary character may join the two
 *    words of a compound fragment: `apiXkey`, `sessionZid`.
 */

/** Credential key-name fragments, stored in normalized (separator-free) form. */
export const CREDENTIAL_KEY_FRAGMENTS: readonly string[] = [
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "sessionid",
  "accesskey"
];

/**
 * Compound fragments that also match when one arbitrary character joins
 * their two words (rule 2). Stored as regular-expression sources so the
 * loose rule stays readable next to the normalized rule.
 */
const LOOSE_COMPOUND_JOINS: readonly string[] = [
  "api.?key",
  "private.?key",
  "session.?id",
  "access.?key"
];

/** One collapsed separator character: hyphen, underscore, or whitespace. */
const SEPARATOR_RUN = "[-_\\s]";

/** Escape one character that would otherwise carry pattern syntax. */
function escapeLiteral(char: string): string {
  return /[A-Za-z0-9]/.test(char) ? char : `\\${char}`;
}

/**
 * Spread one fragment so an optional separator run may sit between every
 * pair of characters: `token` becomes `t[-_\s]*o[-_\s]*k[-_\s]*e[-_\s]*n`.
 * The spread matches exactly the keys whose normalized form contains the
 * fragment, because normalization only deletes separator runs.
 */
function separatorTolerant(fragment: string): string {
  return fragment.split("").map(escapeLiteral).join(`${SEPARATOR_RUN}*`);
}

/** Case-insensitive pattern implementing both recognition rules. */
export const CREDENTIAL_KEY_PATTERN: RegExp = new RegExp(
  [
    ...CREDENTIAL_KEY_FRAGMENTS.map(separatorTolerant),
    ...LOOSE_COMPOUND_JOINS
  ].join("|"),
  "i"
);

/** Lowercase a key name and collapse every separator run. */
export function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]+/g, "");
}

/** True when a key name is credential-shaped. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}
