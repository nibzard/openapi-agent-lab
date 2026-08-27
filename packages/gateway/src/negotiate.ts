/**
 * Content negotiation (specification section 15.7). Accept headers are
 * parsed case-insensitively with quality factors; ties break to the
 * lexically smallest lowercase media type so identical inputs always
 * negotiate identically.
 */

export interface AcceptPreference {
  /** Lowercase full media type, for example application/vnd.api+json. */
  type: string;
  /** Quality factor between 0 and 1 in steps of 0.001. */
  q: number;
  /** 2 exact, 1 subtype wildcard, 0 full wildcard. */
  specificity: number;
}

/**
 * Parse an Accept header into deterministic preference order: descending
 * quality, then descending specificity, then ascending lexical type.
 * Entries with an unparsable quality factor are dropped.
 */
export function parseAccept(header: string | null): AcceptPreference[] {
  if (header === null || header.trim().length === 0) {
    return [];
  }
  const preferences: AcceptPreference[] = [];
  for (const entry of header.split(",")) {
    const segments = entry.trim().split(";");
    const type = (segments[0] ?? "").trim().toLowerCase();
    if (!/^[*]|[\w!#$&.^+-]+\/[*]|[\w!#$&.^+-]+\/[\w!#$&.^+-]+$/.test(type)) {
      continue;
    }
    let q = 1;
    for (const parameter of segments.slice(1)) {
      const pair = parameter.trim();
      if (!pair.toLowerCase().startsWith("q=")) {
        continue;
      }
      const raw = pair.slice(2).trim();
      if (!/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(raw)) {
        q = -1;
        break;
      }
      q = Number(raw);
    }
    if (q < 0) {
      continue;
    }
    preferences.push({
      type,
      q,
      specificity: specificityOf(type)
    });
  }
  preferences.sort((a, b) => {
    if (a.q !== b.q) {
      return b.q - a.q;
    }
    if (a.specificity !== b.specificity) {
      return b.specificity - a.specificity;
    }
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
  return preferences;
}

function specificityOf(type: string): number {
  if (type === "*/*") {
    return 0;
  }
  if (type.endsWith("/*")) {
    return 1;
  }
  return 2;
}

function matches(preference: AcceptPreference, candidate: string): boolean {
  if (preference.specificity === 0) {
    return true;
  }
  const [ptype, psub] = splitType(preference.type);
  const [ctype, csub] = splitType(candidate);
  if (ptype !== ctype) {
    return false;
  }
  if (preference.specificity === 1) {
    return true;
  }
  return psub === csub;
}

function splitType(type: string): [string, string] {
  const slash = type.indexOf("/");
  if (slash === -1) {
    return [type, ""];
  }
  return [type.slice(0, slash), type.slice(slash + 1)];
}

/**
 * Choose the response media type for a request. A missing or empty
 * Accept header permits the declared preference order unchanged. The
 * result is null when the Accept header cannot be satisfied; callers
 * answer 406 responseMediaTypeUnacceptable.
 */
export function negotiateResponseMedia(
  declared: readonly string[],
  acceptHeader: string | null
): string | null {
  if (declared.length === 0) {
    return null;
  }
  const preferences = parseAccept(acceptHeader);
  if (preferences.length === 0) {
    return declared[0] as string;
  }
  for (const preference of preferences) {
    if (preference.q === 0) {
      continue;
    }
    const candidates = declared
      .filter((candidate) => matches(preference, candidate.toLowerCase()))
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    const winner = candidates[0];
    if (winner !== undefined) {
      return winner;
    }
  }
  return null;
}

/**
 * Choose the declared request media type matching a concrete
 * Content-Type, ignoring parameters such as charset. Null means the
 * Content-Type is not declared; callers answer 415.
 */
export function matchRequestMedia(
  declared: readonly string[],
  contentType: string | null
): string | null {
  if (contentType === null) {
    return null;
  }
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.length === 0) {
    return null;
  }
  for (const candidate of declared) {
    if (candidate.toLowerCase() === base) {
      return candidate;
    }
  }
  return null;
}
