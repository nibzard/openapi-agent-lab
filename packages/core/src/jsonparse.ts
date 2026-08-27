import type { Json } from "./json.ts";

export interface StrictJsonOptions {
  /** Maximum input length in bytes. */
  maxBytes?: number;
  /** Maximum parsed node count. */
  maxNodes?: number;
}

export class StrictJsonError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = "StrictJsonError";
    this.offset = offset;
  }
}

interface ScanState {
  text: string;
  index: number;
  nodes: number;
  maxNodes: number;
}

function skipWhitespace(s: ScanState): void {
  const { text } = s;
  while (s.index < text.length) {
    const ch = text.charCodeAt(s.index);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      s.index += 1;
    } else {
      return;
    }
  }
}

function countNode(s: ScanState): void {
  s.nodes += 1;
  if (s.nodes > s.maxNodes) {
    throw new StrictJsonError("JSON node limit exceeded.", s.index);
  }
}

function parseValue(s: ScanState): Json {
  skipWhitespace(s);
  if (s.index >= s.text.length) {
    throw new StrictJsonError("Unexpected end of JSON input.", s.index);
  }
  const ch = s.text.charCodeAt(s.index);
  if (ch === 0x7b /* { */) {
    return parseObject(s);
  }
  if (ch === 0x5b /* [ */) {
    return parseArray(s);
  }
  if (ch === 0x22 /* " */) {
    return parseString(s);
  }
  if (ch === 0x74 /* t */) {
    expectLiteral(s, "true");
    countNode(s);
    return true;
  }
  if (ch === 0x66 /* f */) {
    expectLiteral(s, "false");
    countNode(s);
    return false;
  }
  if (ch === 0x6e /* n */) {
    expectLiteral(s, "null");
    countNode(s);
    return null;
  }
  if (ch === 0x2d /* - */ || (ch >= 0x30 && ch <= 0x39)) {
    return parseNumber(s);
  }
  throw new StrictJsonError("Unexpected character in JSON input.", s.index);
}

function expectLiteral(s: ScanState, literal: string): void {
  if (!s.text.startsWith(literal, s.index)) {
    throw new StrictJsonError("Invalid JSON literal.", s.index);
  }
  s.index += literal.length;
}

function parseNumber(s: ScanState): number {
  const start = s.index;
  const { text } = s;
  if (text.charCodeAt(s.index) === 0x2d /* - */) {
    s.index += 1;
  }
  const intStart = s.index;
  while (
    s.index < text.length &&
    text.charCodeAt(s.index) >= 0x30 &&
    text.charCodeAt(s.index) <= 0x39
  ) {
    s.index += 1;
  }
  if (s.index === intStart) {
    throw new StrictJsonError("Invalid JSON number.", start);
  }
  if (text.charCodeAt(s.index) === 0x2e /* . */) {
    s.index += 1;
    const fracStart = s.index;
    while (
      s.index < text.length &&
      text.charCodeAt(s.index) >= 0x30 &&
      text.charCodeAt(s.index) <= 0x39
    ) {
      s.index += 1;
    }
    if (s.index === fracStart) {
      throw new StrictJsonError("Invalid JSON fraction.", start);
    }
  }
  if (
    text.charCodeAt(s.index) === 0x65 /* e */ ||
    text.charCodeAt(s.index) === 0x45 /* E */
  ) {
    s.index += 1;
    if (
      text.charCodeAt(s.index) === 0x2b /* + */ ||
      text.charCodeAt(s.index) === 0x2d /* - */
    ) {
      s.index += 1;
    }
    const expStart = s.index;
    while (
      s.index < text.length &&
      text.charCodeAt(s.index) >= 0x30 &&
      text.charCodeAt(s.index) <= 0x39
    ) {
      s.index += 1;
    }
    if (s.index === expStart) {
      throw new StrictJsonError("Invalid JSON exponent.", start);
    }
  }
  const raw = text.slice(start, s.index);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new StrictJsonError("JSON number out of range.", start);
  }
  countNode(s);
  return value;
}

function parseString(s: ScanState): string {
  const { text } = s;
  const start = s.index;
  s.index += 1; // opening quote
  let out = "";
  while (true) {
    if (s.index >= text.length) {
      throw new StrictJsonError("Unterminated JSON string.", start);
    }
    const ch = text.charCodeAt(s.index);
    if (ch === 0x22 /* " */) {
      s.index += 1;
      countNode(s);
      return out;
    }
    if (ch === 0x5c /* \ */) {
      s.index += 1;
      if (s.index >= text.length) {
        throw new StrictJsonError("Unterminated escape.", start);
      }
      const esc = text[s.index] as string;
      s.index += 1;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(s.index, s.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new StrictJsonError("Invalid unicode escape.", s.index);
          }
          s.index += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          break;
        }
        default:
          throw new StrictJsonError("Invalid escape character.", s.index);
      }
      continue;
    }
    if (ch < 0x20) {
      throw new StrictJsonError(
        "Unescaped control character in string.",
        s.index
      );
    }
    out += text[s.index] as string;
    s.index += 1;
  }
}

function parseObject(s: ScanState): Json {
  const { text } = s;
  const start = s.index;
  const seen = new Set<string>();
  const result: { [key: string]: Json } = {};
  countNode(s);
  s.index += 1; // {
  skipWhitespace(s);
  if (text.charCodeAt(s.index) === 0x7d /* } */) {
    s.index += 1;
    return result;
  }
  while (true) {
    skipWhitespace(s);
    if (text.charCodeAt(s.index) !== 0x22) {
      throw new StrictJsonError("Expected string object key.", s.index);
    }
    const key = parseString(s);
    if (seen.has(key)) {
      throw new StrictJsonError(`Duplicate object key: ${key}`, start);
    }
    seen.add(key);
    skipWhitespace(s);
    if (text.charCodeAt(s.index) !== 0x3a /* : */) {
      throw new StrictJsonError("Expected ':' after object key.", s.index);
    }
    s.index += 1;
    const value = parseValue(s);
    result[key] = value;
    skipWhitespace(s);
    const ch = text.charCodeAt(s.index);
    if (ch === 0x2c /* , */) {
      s.index += 1;
      continue;
    }
    if (ch === 0x7d /* } */) {
      s.index += 1;
      return result;
    }
    throw new StrictJsonError("Expected ',' or '}' in object.", s.index);
  }
}

function parseArray(s: ScanState): Json {
  const { text } = s;
  s.index += 1; // [
  const result: Json[] = [];
  countNode(s);
  skipWhitespace(s);
  if (text.charCodeAt(s.index) === 0x5d /* ] */) {
    s.index += 1;
    return result;
  }
  while (true) {
    const value = parseValue(s);
    result.push(value);
    skipWhitespace(s);
    const ch = text.charCodeAt(s.index);
    if (ch === 0x2c /* , */) {
      s.index += 1;
      continue;
    }
    if (ch === 0x5d /* ] */) {
      s.index += 1;
      return result;
    }
    throw new StrictJsonError("Expected ',' or ']' in array.", s.index);
  }
}

/**
 * Parse JSON text with duplicate-key rejection, no NaN/Infinity, and
 * bounded node counts. Throws {@link StrictJsonError} on any violation.
 */
export function parseJsonStrict(
  text: string,
  options: StrictJsonOptions = {}
): Json {
  const s: ScanState = {
    text,
    index: 0,
    nodes: 0,
    maxNodes: options.maxNodes ?? 100_000
  };
  if (text.length > (options.maxBytes ?? 26_214_400)) {
    throw new StrictJsonError("JSON input exceeds byte limit.", 0);
  }
  const value = parseValue(s);
  skipWhitespace(s);
  if (s.index !== text.length) {
    throw new StrictJsonError("Trailing content after JSON value.", s.index);
  }
  return value;
}
