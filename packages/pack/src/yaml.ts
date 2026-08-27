import type { Json, JsonObject } from "@oal/core";

/**
 * Safe YAML subset parser for pack manifests.
 *
 * Supported: block mappings and block sequences (including a compact mapping
 * that starts on a sequence dash line), single-line flow collections, plain,
 * single-quoted and double-quoted scalars, literal `|` and folded `>`
 * block scalars with indentation and chomping indicators, comments, one
 * document with an optional leading `---`, and duplicate-key rejection.
 *
 * Not supported and rejected closed: anchors, aliases, tags, multiple
 * documents, multi-line flow collections, and compact nested sequences.
 *
 * Every expansion is bounded by node count, nesting depth, and input size.
 * No dynamic evaluation of any kind happens here.
 */

export type PackYamlErrorCode =
  | "invalid"
  | "duplicate-key"
  | "node-limit"
  | "depth-limit"
  | "size-limit";

export class PackYamlError extends Error {
  readonly code: PackYamlErrorCode;
  /** One-based line number of the failure. */
  readonly line: number;

  constructor(code: PackYamlErrorCode, message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "PackYamlError";
    this.code = code;
    this.line = line;
  }
}

export interface PackYamlOptions {
  /** Maximum input length in bytes. Default 4 MiB. */
  readonly maxBytes?: number;
  /** Maximum materialized node count. Default 100_000. */
  readonly maxNodes?: number;
  /** Maximum nesting depth. Default 48. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_DEPTH = 48;

interface SourceLine {
  /** Content after leading indentation, without the line terminator. */
  readonly text: string;
  /** Number of leading spaces. */
  readonly indent: number;
  /** One-based source line number. */
  readonly number: number;
  /** True for empty and comment-only lines. */
  readonly blank: boolean;
}

interface QuotedScalar {
  readonly value: string;
  /** Index just past the closing quote. */
  readonly next: number;
}

interface FlowValue {
  readonly value: Json;
  /** Index just past the parsed value. */
  readonly next: number;
}

interface EntrySplit {
  readonly key: string;
  /** Text after the separating colon, possibly empty. */
  readonly rest: string;
}

const PLAIN_INTEGER = /^[+-]?[0-9]+$/;
const PLAIN_NUMBER = /^[+-]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][+-]?[0-9]+)?$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function isLineBreak(ch: string): boolean {
  return ch === "\n" || ch === "\r";
}

/** Convert one raw document line into a significant-line record. */
function toSourceLine(raw: string, number: number): SourceLine {
  let indent = 0;
  while (indent < raw.length && raw.charAt(indent) === " ") {
    indent += 1;
  }
  if (raw.charAt(indent) === "\t") {
    throw new PackYamlError(
      "invalid",
      "Tab characters are not allowed in indentation.",
      number
    );
  }
  const text = raw.slice(indent);
  return {
    text,
    indent,
    number,
    blank: text === "" || text.startsWith("#")
  };
}

/** True for "- item" and a bare "-". */
function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Read one quoted scalar starting at `start`, which must be a quote. */
function readQuoted(text: string, start: number): QuotedScalar | null {
  const quote = text.charAt(start);
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === quote) {
      if (quote === "'" && text.charAt(i + 1) === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, next: i + 1 };
    }
    if (quote === '"' && ch === "\\") {
      const escape = text.charAt(i + 1);
      switch (escape) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "0":
          out += "\0";
          break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return null;
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          return null;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

/** Resolve an unquoted scalar to null, boolean, number, or string. */
function resolvePlainScalar(input: string): Json {
  const value = input.trim();
  if (
    value === "" ||
    value === "null" ||
    value === "Null" ||
    value === "NULL" ||
    value === "~"
  ) {
    return null;
  }
  if (value === "true" || value === "True" || value === "TRUE") {
    return true;
  }
  if (value === "false" || value === "False" || value === "FALSE") {
    return false;
  }
  if (PLAIN_INTEGER.test(value) || PLAIN_NUMBER.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return value;
}

/** Cut a trailing comment that starts outside quotes after whitespace. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || isSpace(text.charAt(i - 1)))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Split "key: rest" into its parts, or return null for a non-entry line. */
function splitEntry(text: string): EntrySplit | null {
  const first = text.charAt(0);
  if (first === '"' || first === "'") {
    const scalar = readQuoted(text, 0);
    if (scalar === null) {
      return null;
    }
    let i = scalar.next;
    while (i < text.length && isSpace(text.charAt(i))) {
      i += 1;
    }
    if (text.charAt(i) !== ":") {
      return null;
    }
    return { key: scalar.value, rest: text.slice(i + 1) };
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "#" && i > 0 && isSpace(text.charAt(i - 1))) {
      return null;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    const after = text.charAt(i + 1);
    if (ch === ":" && (after === "" || isSpace(after))) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1) };
    }
  }
  return null;
}

const BLOCK_HEADER = /^([|>])([+-]\d*|\d+[+-]?)?$/;

class YamlParser {
  private readonly lines: readonly SourceLine[];
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private index = 0;
  private nodes = 0;

  constructor(
    lines: readonly SourceLine[],
    options: Required<PackYamlOptions>
  ) {
    this.lines = lines;
    this.maxNodes = options.maxNodes;
    this.maxDepth = options.maxDepth;
  }

  parseDocument(): Json {
    this.skipDocumentStart();
    const first = this.peek();
    if (first === null) {
      return null;
    }
    const value = this.parseNode(0);
    const trailing = this.peek();
    if (trailing !== null) {
      throw new PackYamlError(
        "invalid",
        trailing.text.startsWith("---")
          ? "Multiple YAML documents are not supported."
          : "Unexpected content after the document.",
        trailing.number
      );
    }
    return value;
  }

  private skipDocumentStart(): void {
    while (true) {
      const line = this.peek();
      if (line === null) {
        return;
      }
      if (line.text.startsWith("%")) {
        this.index += 1;
        continue;
      }
      if (line.text === "---") {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private peek(): SourceLine | null {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined || !line.blank) {
        return line ?? null;
      }
      this.index += 1;
    }
    return null;
  }

  private countNode(line: number): void {
    this.nodes += 1;
    if (this.nodes > this.maxNodes) {
      throw new PackYamlError("node-limit", "YAML node limit exceeded.", line);
    }
  }

  private parseNode(depth: number): Json {
    if (depth > this.maxDepth) {
      const line = this.peek();
      throw new PackYamlError(
        "depth-limit",
        "YAML nesting depth limit exceeded.",
        line?.number ?? 1
      );
    }
    const line = this.peek();
    if (line === null) {
      return null;
    }
    if (isSequenceEntry(line.text)) {
      return this.parseSequence(line.indent, depth);
    }
    return this.parseMapping(line.indent, depth, null);
  }

  private parseSequence(indent: number, depth: number): Json[] {
    const items: Json[] = [];
    while (true) {
      const line = this.peek();
      if (
        line === null ||
        line.indent < indent ||
        !isSequenceEntry(line.text)
      ) {
        return items;
      }
      if (line.indent > indent) {
        throw new PackYamlError(
          "invalid",
          "Unexpected indentation in a block sequence.",
          line.number
        );
      }
      this.index += 1;
      this.countNode(line.number);
      const rest = line.text === "-" ? "" : line.text.slice(2);
      items.push(this.parseSequenceItem(rest, line, depth));
    }
  }

  private parseSequenceItem(
    rest: string,
    dash: SourceLine,
    depth: number
  ): Json {
    if (rest === "") {
      const nested = this.peek();
      if (nested !== null && nested.indent > dash.indent) {
        return this.parseNode(depth + 1);
      }
      return null;
    }
    if (isSequenceEntry(rest)) {
      throw new PackYamlError(
        "invalid",
        "Compact nested sequences are not supported.",
        dash.number
      );
    }
    const content = stripComment(rest);
    if (splitEntry(content) !== null) {
      const offset = dash.text.length - rest.length;
      return this.parseMapping(dash.indent + offset, depth, {
        content,
        line: dash.number
      });
    }
    return this.parseFlowValue(rest, dash.number);
  }

  private parseMapping(
    indent: number,
    depth: number,
    pending: { readonly content: string; readonly line: number } | null
  ): JsonObject {
    const result: JsonObject = {};
    let first = pending;
    while (true) {
      let content: string;
      let lineNumber: number;
      if (first !== null) {
        content = first.content;
        lineNumber = first.line;
        first = null;
      } else {
        const line = this.peek();
        if (line === null || line.indent < indent) {
          return result;
        }
        if (line.indent > indent) {
          throw new PackYamlError(
            "invalid",
            "Unexpected indentation in a block mapping.",
            line.number
          );
        }
        if (isSequenceEntry(line.text)) {
          return result;
        }
        this.index += 1;
        content = line.text;
        lineNumber = line.number;
      }
      const entry = splitEntry(content);
      if (entry === null) {
        throw new PackYamlError(
          "invalid",
          "Expected a 'key: value' mapping entry.",
          lineNumber
        );
      }
      if (entry.key === "") {
        throw new PackYamlError(
          "invalid",
          "Mapping keys must not be empty.",
          lineNumber
        );
      }
      this.countNode(lineNumber);
      if (Object.hasOwn(result, entry.key)) {
        throw new PackYamlError(
          "duplicate-key",
          `Duplicate mapping key: ${entry.key}`,
          lineNumber
        );
      }
      result[entry.key] = this.parseValue(
        entry.rest,
        indent,
        lineNumber,
        depth
      );
    }
  }

  private parseValue(
    rest: string,
    indent: number,
    lineNumber: number,
    depth: number
  ): Json {
    const header = stripComment(rest).trim();
    if (header === "") {
      const next = this.peek();
      if (next === null) {
        return null;
      }
      if (next.indent > indent) {
        return this.parseNode(depth + 1);
      }
      if (next.indent === indent && isSequenceEntry(next.text)) {
        return this.parseSequence(indent, depth + 1);
      }
      return null;
    }
    if (BLOCK_HEADER.test(header)) {
      return this.parseBlockScalar(header, indent);
    }
    return this.parseFlowValue(rest, lineNumber);
  }

  private parseBlockScalar(header: string, indent: number): string {
    const style = header.charAt(0);
    const indicators = header.slice(1);
    const chomp = indicators.includes("-")
      ? "strip"
      : indicators.includes("+")
        ? "keep"
        : "clip";
    const explicit = /^[0-9]/.test(indicators)
      ? indent + Number(indicators.replace(/[^0-9]/g, ""))
      : null;

    const collected: SourceLine[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined) {
        break;
      }
      if (line.text === "") {
        collected.push(line);
        this.index += 1;
        continue;
      }
      if (line.indent <= indent) {
        break;
      }
      collected.push(line);
      this.index += 1;
    }
    while (
      collected.length > 0 &&
      collected[collected.length - 1]?.text === ""
    ) {
      collected.pop();
    }
    const firstContent = collected.find((line) => line.text !== "");
    const contentIndent =
      explicit ?? (firstContent === undefined ? indent : firstContent.indent);

    const rendered = collected.map((line) =>
      line.text === ""
        ? ""
        : line.text.slice(Math.max(0, line.indent - contentIndent))
    );
    let text = "";
    if (style === "|") {
      text = rendered.length === 0 ? "" : `${rendered.join("\n")}\n`;
    } else {
      const folded: string[] = [];
      let buffer = "";
      for (const line of rendered) {
        if (line === "") {
          folded.push(buffer);
          buffer = "";
          continue;
        }
        buffer = buffer === "" ? line : `${buffer} ${line}`;
      }
      folded.push(buffer);
      const body = folded.join("\n");
      text = body === "" ? "" : `${body}\n`;
    }
    if (chomp === "strip") {
      return text.replace(/\n+$/, "");
    }
    if (chomp === "keep") {
      return text;
    }
    return text.replace(/\n+$/, "\n");
  }

  private parseFlowValue(text: string, lineNumber: number): Json {
    const stripped = stripComment(text).trim();
    if (stripped === "") {
      return null;
    }
    const first = stripped.charAt(0);
    if (first === '"' || first === "'") {
      const scalar = readQuoted(stripped, 0);
      if (scalar === null || scalar.next !== stripped.length) {
        throw new PackYamlError(
          "invalid",
          "Unterminated or trailing quoted scalar.",
          lineNumber
        );
      }
      this.countNode(lineNumber);
      return scalar.value;
    }
    if (first === "&" || first === "*" || first === "!") {
      throw new PackYamlError(
        "invalid",
        "Anchors, aliases, and tags are not supported.",
        lineNumber
      );
    }
    if (first === "[" || first === "{") {
      const flow = this.parseFlowCollection(stripped, 0, lineNumber);
      if (flow.next !== stripped.length) {
        throw new PackYamlError(
          "invalid",
          "Trailing content after a flow collection.",
          lineNumber
        );
      }
      return flow.value;
    }
    this.countNode(lineNumber);
    return resolvePlainScalar(stripped);
  }

  private parseFlowCollection(
    text: string,
    start: number,
    lineNumber: number
  ): FlowValue {
    const open = text.charAt(start);
    const close = open === "[" ? "]" : "}";
    let i = start + 1;
    const items: Json[] = [];
    const map: JsonObject = {};
    while (true) {
      i = skipFlowSpace(text, i);
      if (i >= text.length) {
        throw new PackYamlError(
          "invalid",
          "Unterminated flow collection.",
          lineNumber
        );
      }
      if (text.charAt(i) === close) {
        return {
          value: open === "[" ? items : map,
          next: i + 1
        };
      }
      this.countNode(lineNumber);
      if (open === "[") {
        const item = this.parseFlowItem(text, i, lineNumber);
        items.push(item.value);
        i = item.next;
      } else {
        const key = this.parseFlowKey(text, i, lineNumber);
        i = skipFlowSpace(text, key.next);
        if (text.charAt(i) !== ":") {
          throw new PackYamlError(
            "invalid",
            "Expected ':' in a flow mapping.",
            lineNumber
          );
        }
        const value = this.parseFlowItem(text, i + 1, lineNumber);
        if (Object.hasOwn(map, key.value)) {
          throw new PackYamlError(
            "duplicate-key",
            `Duplicate mapping key: ${key.value}`,
            lineNumber
          );
        }
        map[key.value] = value.value;
        i = value.next;
      }
      i = skipFlowSpace(text, i);
      const separator = text.charAt(i);
      if (separator === ",") {
        i += 1;
        continue;
      }
      if (separator === close) {
        return {
          value: open === "[" ? items : map,
          next: i + 1
        };
      }
      throw new PackYamlError(
        "invalid",
        `Expected ',' or '${close}' in a flow collection.`,
        lineNumber
      );
    }
  }

  private parseFlowItem(
    text: string,
    start: number,
    lineNumber: number
  ): FlowValue {
    const i = skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === "[" || ch === "{") {
      return this.parseFlowCollection(text, i, lineNumber);
    }
    if (ch === '"' || ch === "'") {
      const scalar = readQuoted(text, i);
      if (scalar === null) {
        throw new PackYamlError(
          "invalid",
          "Unterminated quoted scalar in a flow collection.",
          lineNumber
        );
      }
      return { value: scalar.value, next: scalar.next };
    }
    let end = i;
    while (end < text.length) {
      const c = text.charAt(end);
      if (c === "," || c === "]" || c === "}") {
        break;
      }
      end += 1;
    }
    return { value: resolvePlainScalar(text.slice(i, end)), next: end };
  }

  private parseFlowKey(
    text: string,
    start: number,
    lineNumber: number
  ): { value: string; next: number } {
    const i = skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const scalar = readQuoted(text, i);
      if (scalar === null) {
        throw new PackYamlError(
          "invalid",
          "Unterminated quoted key in a flow mapping.",
          lineNumber
        );
      }
      return { value: scalar.value, next: scalar.next };
    }
    let end = i;
    while (end < text.length) {
      const c = text.charAt(end);
      if (c === ":" || c === "," || c === "}" || c === "]") {
        break;
      }
      end += 1;
    }
    const value = text.slice(i, end).trim();
    if (value === "") {
      throw new PackYamlError(
        "invalid",
        "Empty key in a flow mapping.",
        lineNumber
      );
    }
    return { value, next: end };
  }
}

function skipFlowSpace(text: string, start: number): number {
  let i = start;
  while (
    i < text.length &&
    (isSpace(text.charAt(i)) || isLineBreak(text.charAt(i)))
  ) {
    i += 1;
  }
  return i;
}

/**
 * Parse pack YAML text into a JSON value. Throws {@link PackYamlError} on any
 * unsupported construct, duplicate key, or limit violation.
 */
export function parsePackYaml(
  text: string,
  options: PackYamlOptions = {}
): Json {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const resolved: Required<PackYamlOptions> = {
    maxBytes,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH
  };
  if (text.length > maxBytes) {
    throw new PackYamlError(
      "size-limit",
      "YAML input exceeds the byte limit.",
      1
    );
  }
  const rawLines = text.split("\n");
  const lines = rawLines.map((raw, position) =>
    toSourceLine(raw.replace(/\r$/, ""), position + 1)
  );
  return new YamlParser(lines, resolved).parseDocument();
}
