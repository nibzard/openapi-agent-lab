/**
 * Bounded regular-expression synthesis (specification section 15.6).
 * Produce one string a pattern accepts, or fail closed. The synthesizer
 * is a pure function of the pattern and the declared length bounds: no
 * seed, no clock, no randomness. Unsupported constructs — lookarounds,
 * backreferences, named groups, inline flags, unicode property escapes,
 * word boundaries outside classes — return null so the caller can fail
 * closed with a named cause.
 */

/**
 * Test one candidate against a vendor pattern. The schema validator
 * compiles the same expression against the same schema, so this adds
 * no new trust boundary; an untestable pattern accepts nothing.
 */
export function patternAccepts(pattern: string, candidate: string): boolean {
  try {
    return new RegExp(pattern).test(candidate);
  } catch {
    return false;
  }
}

/** Declared JSON Schema length bounds; null means undeclared. */
export interface PatternBounds {
  minLength: number | null;
  maxLength: number | null;
}

const MAX_PATTERN_CHARS = 1024;
const MAX_NODES = 256;
const MAX_REPEAT = 64;
const MAX_SYNTH_LENGTH = 256;
const MAX_ATTEMPTS = 96;

/** One quantified atom reduced to its first declared member. */
interface Term {
  /** The atom's deterministic contribution per repetition. */
  first: string;
  /** Quantifier minimum. */
  min: number;
  /** Quantifier maximum, already capped for enumeration. */
  max: number;
}

interface ParseState {
  source: string;
  pos: number;
  nodes: number;
}

/**
 * Synthesize a string the pattern accepts within the declared bounds.
 * Deterministic: first alternative, first declared member of every
 * atom, minimum counts, then an odometer over the count vector when
 * the bounds demand more length.
 */
export function synthesizePattern(
  pattern: string,
  bounds: PatternBounds
): string | null {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return null;
  }
  const state: ParseState = { source: pattern, pos: 0, nodes: 0 };
  const alternatives = parseDisjunction(state);
  if (alternatives === null || state.pos !== pattern.length) {
    // Unbalanced ")" or other trailing syntax the parser refuses.
    return null;
  }
  const minLength = bounds.minLength ?? 0;
  const maxLength = Math.min(
    bounds.maxLength ?? MAX_SYNTH_LENGTH,
    MAX_SYNTH_LENGTH
  );
  if (minLength > maxLength) {
    return null;
  }
  for (const terms of alternatives) {
    const candidate = synthesizeAlternative(terms, minLength, maxLength);
    if (candidate !== null && patternAccepts(pattern, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Recursive-descent grammar:
 *   disjunction := sequence ("|" sequence)*
 *   sequence    := term*
 *   term        := atom quantifier?
 *   quantifier  := "*" | "+" | "?" | "{n}" | "{n,}" | "{n,m}"
 *   atom        := anchor | "." | class | group | escape | literal
 */
function parseDisjunction(state: ParseState): Term[][] | null {
  const alternatives: Term[][] = [];
  for (;;) {
    const terms = parseSequence(state);
    if (terms === null) {
      return null;
    }
    alternatives.push(terms);
    if (state.source[state.pos] === "|") {
      state.pos += 1;
      continue;
    }
    break;
  }
  return alternatives;
}

function parseSequence(state: ParseState): Term[] | null {
  const terms: Term[] = [];
  while (state.pos < state.source.length) {
    const ch = state.source[state.pos];
    if (ch === "|" || ch === ")") {
      break;
    }
    const atom = parseAtom(state);
    if (atom === null) {
      return null;
    }
    const term = parseQuantifier(state, atom);
    if (term === null) {
      return null;
    }
    terms.push(term);
  }
  return terms;
}

/**
 * Parse one atom and reduce it to its deterministic contribution:
 * the first declared member of a class, the lower bound of a range,
 * a group flattened at its own minimum counts.
 */
function parseAtom(state: ParseState): string | null {
  if (state.nodes > MAX_NODES) {
    return null;
  }
  state.nodes += 1;
  const ch = state.source[state.pos];
  if (ch === "^" || ch === "$") {
    state.pos += 1;
    return "";
  }
  if (ch === ".") {
    state.pos += 1;
    return firstPrintableMatch(".");
  }
  if (ch === "[") {
    return parseClass(state);
  }
  if (ch === "(") {
    return parseGroup(state);
  }
  if (ch === "\\") {
    return parseEscape(state);
  }
  if (ch === undefined || ch === "*" || ch === "+" || ch === "?") {
    // End of input, or a quantifier without an atom: a syntax error.
    return null;
  }
  state.pos += 1;
  return ch;
}

function parseQuantifier(state: ParseState, atom: string): Term | null {
  let min = 1;
  let max = 1;
  const ch = state.source[state.pos];
  if (ch === "*") {
    min = 0;
    max = MAX_SYNTH_LENGTH;
    state.pos += 1;
  } else if (ch === "+") {
    min = 1;
    max = MAX_SYNTH_LENGTH;
    state.pos += 1;
  } else if (ch === "?") {
    min = 0;
    max = 1;
    state.pos += 1;
  } else if (ch === "{") {
    const counted = parseCounted(state);
    if (counted === null) {
      // A "{" that is not a counted quantifier is a literal brace;
      // leave it for the next atom and close this term unquantified.
      return closeTerm(atom, 1, 1);
    }
    // MAX_REPEAT bounds numbers written in the pattern; an open-ended
    // "{n,}" keeps the synthesis ceiling as its enumeration maximum.
    if (
      counted.min > MAX_REPEAT ||
      (counted.declared && counted.max > MAX_REPEAT)
    ) {
      return null;
    }
    min = counted.min;
    max = counted.max;
  }
  // A lazy marker changes matching preference, not membership.
  if (state.source[state.pos] === "?") {
    state.pos += 1;
  }
  return closeTerm(atom, min, max);
}

function closeTerm(atom: string, min: number, max: number): Term {
  // Anchors and empty groups match empty; repetition changes nothing.
  const effectiveMax = atom.length === 0 ? min : max;
  return { first: atom, min, max: effectiveMax };
}

/**
 * Parse `{n}`, `{n,}`, or `{n,m}` starting at "{". Returns null when
 * the text is not a counted quantifier, leaving the position
 * untouched so the brace can be parsed as a literal.
 */
function parseCounted(
  state: ParseState
): { min: number; max: number; declared: boolean } | null {
  const rest = state.source.slice(state.pos);
  const match = /^\{(\d+)(,(\d+)?)?\}/.exec(rest);
  if (match === null) {
    return null;
  }
  const low = Number(match[1]);
  const open = match[2] !== undefined && match[3] === undefined;
  const high = open
    ? MAX_SYNTH_LENGTH
    : match[2] === undefined
      ? low
      : Number(match[3]);
  if (high < low) {
    // Out-of-order ranges are refused rather than second-guessed.
    return null;
  }
  state.pos += match[0].length;
  // Only numbers written in the pattern count against MAX_REPEAT.
  return { min: low, max: high, declared: !open };
}

function parseGroup(state: ParseState): string | null {
  state.pos += 1; // "("
  if (state.source[state.pos] === "?") {
    if (state.source[state.pos + 1] !== ":") {
      // Lookarounds, named groups, and inline flags are refused.
      return null;
    }
    state.pos += 2; // "?:"
  }
  const nested = parseDisjunction(state);
  if (nested === null || state.source[state.pos] !== ")") {
    return null;
  }
  state.pos += 1;
  const first = nested[0];
  if (first === undefined) {
    return null;
  }
  return flattenAtMinimum(first);
}

/** Concatenate one alternative's atoms at their minimum counts. */
function flattenAtMinimum(terms: readonly Term[]): string {
  let out = "";
  for (const term of terms) {
    out += term.first.repeat(term.min);
  }
  return out;
}

function parseClass(state: ParseState): string | null {
  const start = state.pos;
  state.pos += 1; // "["
  const negated = state.source[state.pos] === "^";
  if (negated) {
    state.pos += 1;
  }
  // A "]" directly after "[" or "^" is a literal member.
  const bodyStart = state.pos;
  if (state.source[state.pos] === "]") {
    state.pos += 1;
  }
  let closed = false;
  while (state.pos < state.source.length) {
    const ch = state.source[state.pos];
    if (ch === "\\") {
      state.pos += 2;
      continue;
    }
    state.pos += 1;
    if (ch === "]") {
      closed = true;
      break;
    }
  }
  if (!closed || state.pos > state.source.length) {
    return null;
  }
  const full = state.source.slice(start, state.pos);
  if (negated) {
    return firstPrintableMatch(full);
  }
  return firstDeclaredMember(state.source.slice(bodyStart, state.pos - 1));
}

function parseEscape(state: ParseState): string | null {
  state.pos += 1; // "\"
  const ch = state.source[state.pos];
  if (ch === undefined) {
    return null;
  }
  state.pos += 1;
  switch (ch) {
    case "d":
    case "w":
      return "0";
    case "s":
      return " ";
    case "D":
    case "W":
    case "S":
      return firstPrintableMatch(`\\${ch}`);
    case "p":
    case "P":
      // Unicode property escapes need the u flag the validator does
      // not set; refuse.
      return null;
    case "b":
    case "B":
      // Word boundaries are assertions, not members.
      return null;
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    case "x": {
      const hex = state.source.slice(state.pos, state.pos + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        return null;
      }
      state.pos += 2;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    case "u": {
      if (state.source[state.pos] === "{") {
        return null;
      }
      const hex = state.source.slice(state.pos, state.pos + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return null;
      }
      state.pos += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    case "c": {
      const control = state.source[state.pos];
      if (control === undefined || !/[A-Za-z]/.test(control)) {
        return null;
      }
      state.pos += 1;
      return String.fromCharCode(control.toUpperCase().charCodeAt(0) % 32);
    }
    default:
      // Identity escape: the character itself.
      return ch;
  }
}

/**
 * First declared member of a positive class body: a literal, a range
 * lower bound, or a class escape's canonical first member.
 */
function firstDeclaredMember(body: string): string | null {
  const ch = body[0];
  if (ch === undefined) {
    return null;
  }
  if (ch !== "\\") {
    // A literal member, or the lower bound of a range.
    return ch;
  }
  const escape = body[1];
  if (escape === undefined) {
    return null;
  }
  switch (escape) {
    case "d":
    case "w":
      return "0";
    case "s":
      return " ";
    case "D":
    case "W":
    case "S":
      return firstPrintableMatch(`\\${escape}`);
    case "b":
      // Inside a class, \b is the backspace character.
      return "\b";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "x": {
      const hex = body.slice(2, 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        return null;
      }
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    case "u": {
      const hex = body.slice(2, 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return null;
      }
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    case "p":
    case "P":
      return null;
    default:
      // Identity escape: the character itself.
      return escape;
  }
}

/** First printable ASCII character the source accepts. */
function firstPrintableMatch(source: string): string | null {
  let probe: RegExp;
  try {
    probe = new RegExp(source);
  } catch {
    return null;
  }
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const ch = String.fromCharCode(code);
    if (probe.test(ch)) {
      return ch;
    }
  }
  return null;
}

/** Build one alternative's candidate from a count vector. */
function buildCandidate(
  terms: readonly Term[],
  counts: readonly number[]
): string {
  let out = "";
  let index = 0;
  for (const term of terms) {
    out += term.first.repeat(counts[index] ?? term.min);
    index += 1;
  }
  return out;
}

/**
 * Enumerate the count vector deterministically: minimum counts first,
 * a direct jump to the declared minLength through the last elastic
 * term, then an odometer over the elastic wheels.
 */
function synthesizeAlternative(
  terms: readonly Term[],
  minLength: number,
  maxLength: number
): string | null {
  const mins: number[] = [];
  terms.forEach((term) => {
    mins.push(term.min);
  });
  let attempts = 0;
  const base = buildCandidate(terms, mins);
  attempts += 1;
  if (base.length >= minLength && base.length <= maxLength) {
    return base;
  }
  const elastic: number[] = [];
  terms.forEach((term, i) => {
    if (term.max > term.min && term.first.length > 0) {
      elastic.push(i);
    }
  });
  // Jump: give the whole deficit to the last elastic term.
  const lastElastic = elastic[elastic.length - 1];
  if (base.length < minLength && lastElastic !== undefined) {
    const term = terms[lastElastic];
    if (term !== undefined) {
      const deficit = minLength - base.length;
      const counts = [...mins];
      counts[lastElastic] = Math.min(
        term.max,
        term.min + Math.ceil(deficit / term.first.length)
      );
      attempts += 1;
      const jumped = buildCandidate(terms, counts);
      if (jumped.length >= minLength && jumped.length <= maxLength) {
        return jumped;
      }
    }
  }
  // Odometer over the elastic wheels, right wheel first.
  const counts = [...mins];
  while (attempts < MAX_ATTEMPTS) {
    let advanced = false;
    for (let w = elastic.length - 1; w >= 0; w -= 1) {
      const wheel = elastic[w];
      const term = wheel === undefined ? undefined : terms[wheel];
      if (wheel === undefined || term === undefined) {
        continue;
      }
      if ((counts[wheel] ?? term.min) < term.max) {
        counts[wheel] = (counts[wheel] ?? term.min) + 1;
        for (let r = w + 1; r < elastic.length; r += 1) {
          const reset = elastic[r];
          if (reset !== undefined) {
            const resetTerm = terms[reset];
            counts[reset] = resetTerm === undefined ? 0 : resetTerm.min;
          }
        }
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      return null;
    }
    attempts += 1;
    const candidate = buildCandidate(terms, counts);
    if (candidate.length >= minLength && candidate.length <= maxLength) {
      return candidate;
    }
  }
  return null;
}
