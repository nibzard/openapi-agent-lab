import type { Json, JsonObject } from "./json.ts";
import { escapeToken } from "./jsonpointer.ts";

/**
 * Canonical YAML subset parsers shared by every workspace package.
 *
 * Two engines live here:
 *
 * 1. `parseSafeYaml` — the full recursive-descent engine that OpenAPI
 *    ingestion uses. It accepts anchors, aliases, core-schema tags,
 *    multi-line flow collections and quoted scalars, and reports failures
 *    with line, column, and JSON Pointer positions.
 * 2. `parseBlockYaml` — the parameterized line-based engine that backs the
 *    pack manifest parser, the Arazzo workflow parser, and the Steel rubric
 *    loader. One engine plus a dialect object reproduces each caller's
 *    exact limits, error classes, codes, and messages.
 */

// ---------------------------------------------------------------------------
// Full engine (OpenAPI documents)
// ---------------------------------------------------------------------------

/**
 * Hand-written YAML subset parser for OpenAPI documents.
 *
 * Supported: block mappings and sequences, flow collections, plain,
 * single-quoted and double-quoted scalars, literal `|` and folded `>`
 * block scalars with indentation and chomping indicators, comments,
 * directives, a single document with an optional leading `---`, anchors
 * and aliases, and duplicate-key rejection.
 *
 * Every expansion is bounded: materialized node count, alias expansion
 * count, and nesting depth are capped, so alias bombs fail closed. No
 * dynamic evaluation of any kind happens here.
 */

export type SafeYamlErrorCode =
  | "invalid"
  | "duplicate-key"
  | "node-limit"
  | "alias-limit"
  | "depth-limit"
  | "size-limit";

export class SafeYamlError extends Error {
  readonly code: SafeYamlErrorCode;
  /** One-based line number of the failure. */
  readonly line: number;
  /** One-based column number of the failure. */
  readonly column: number;
  /** JSON Pointer of the node being parsed when the failure occurred. */
  readonly nodePointer: string;

  constructor(
    code: SafeYamlErrorCode,
    message: string,
    line: number,
    column: number,
    nodePointer: string
  ) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "SafeYamlError";
    this.code = code;
    this.line = line;
    this.column = column;
    this.nodePointer = nodePointer;
  }
}

export interface SafeYamlOptions {
  /** Maximum input length in bytes. */
  maxBytes?: number;
  /** Maximum materialized node count, including alias expansions. */
  maxNodes?: number;
  /** Maximum nesting depth. */
  maxDepth?: number;
  /** Maximum number of alias expansions. */
  maxAliasExpansions?: number;
}

interface YamlLine {
  /** Content after leading indentation. */
  readonly text: string;
  /** Number of leading spaces. */
  readonly indent: number;
  readonly blank: boolean;
  readonly comment: boolean;
}

interface Position {
  li: number;
  ci: number;
}

/** Anchor and tag attached to one node. */
interface NodeProperties {
  anchor: string | null;
  tag: string | null;
}

/**
 * Core-schema tags that pass through unchanged. `!!str` forces a string.
 * Any other tag is rejected so no dynamic construct is ever accepted.
 */
const PASSTHROUGH_TAGS: ReadonlySet<string> = new Set([
  "int",
  "float",
  "bool",
  "null",
  "map",
  "seq"
]);

const ANCHOR_PATTERN = /^[^\s,[\]{}]+/;
const TAG_PATTERN = /^[^\s,]+/;

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/** YAML 1.2 core-schema resolution for plain scalars. */
function resolvePlainScalar(raw: string): Json {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  switch (text) {
    case "~":
    case "null":
    case "Null":
    case "NULL":
      return null;
    case "true":
    case "True":
    case "TRUE":
      return true;
    case "false":
    case "False":
    case "FALSE":
      return false;
    default:
      break;
  }
  // Leading zeros are kept as strings so octal-looking values are never
  // silently reinterpreted as decimal integers.
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(text)) {
    return Number(text);
  }
  if (/^0x[0-9a-fA-F]+$/.test(text)) {
    return Number.parseInt(text, 16);
  }
  if (/^0o[0-7]+$/.test(text)) {
    return Number.parseInt(text.slice(2), 8);
  }
  if (
    /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text) &&
    /[.eE]/.test(text)
  ) {
    const value = Number(text);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return text;
}

function plainScalarEnd(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "#" && i > 0 && isSpace(text[i - 1])) {
      return i;
    }
  }
  return text.length;
}

function foldLines(lines: readonly string[]): string {
  let out = "";
  let pendingBreaks = 0;
  let prevMore = false;
  let first = true;
  for (const line of lines) {
    if (line === "") {
      pendingBreaks += 1;
      continue;
    }
    const more = line.startsWith(" ") || line.startsWith("\t");
    if (first) {
      out = line;
      first = false;
    } else if (pendingBreaks > 0) {
      out += `${"\n".repeat(pendingBreaks)}${line}`;
    } else if (more || prevMore) {
      out += `\n${line}`;
    } else {
      out += ` ${line}`;
    }
    pendingBreaks = 0;
    prevMore = more;
  }
  return out;
}

function splitLines(text: string): YamlLine[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const lines: YamlLine[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] as string;
    let indent = 0;
    let tabSeen = false;
    while (indent < raw.length) {
      const ch = raw[indent];
      if (ch === " ") {
        indent += 1;
        continue;
      }
      if (ch === "\t") {
        tabSeen = true;
        indent += 1;
        continue;
      }
      break;
    }
    const content = raw.slice(indent);
    const blank = content.trim().length === 0;
    if (tabSeen && !blank) {
      throw new SafeYamlError(
        "invalid",
        "Tab characters must not be used for indentation.",
        index + 1,
        indent + 1,
        "#"
      );
    }
    lines.push({
      text: content,
      indent,
      blank,
      comment: content.startsWith("#")
    });
  }
  return lines;
}

class YamlParser {
  private readonly lines: readonly YamlLine[];
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private readonly maxAliasExpansions: number;
  private li = 0;
  private ci = 0;
  private nodes = 0;
  private depth = 0;
  private aliases = 0;
  private flowDepth = 0;
  private readonly anchors = new Map<string, Json>();
  private readonly path: string[] = [];

  constructor(
    text: string,
    options: { maxNodes: number; maxDepth: number; maxAliasExpansions: number }
  ) {
    this.maxNodes = options.maxNodes;
    this.maxDepth = options.maxDepth;
    this.maxAliasExpansions = options.maxAliasExpansions;
    this.lines = splitLines(text);
  }

  // ---- cursor ---------------------------------------------------------

  private currentLine(): YamlLine | undefined {
    return this.lines[this.li];
  }

  private currentText(): string {
    const line = this.lines[this.li];
    return line === undefined ? "" : line.text.slice(this.ci);
  }

  private pointer(): string {
    let out = "#";
    for (const token of this.path) {
      out += `/${escapeToken(token)}`;
    }
    return out;
  }

  private fail(code: SafeYamlErrorCode, message: string): never {
    throw new SafeYamlError(
      code,
      message,
      this.li + 1,
      this.ci + 1,
      this.pointer()
    );
  }

  private save(): Position {
    return { li: this.li, ci: this.ci };
  }

  private restore(at: Position): void {
    this.li = at.li;
    this.ci = at.ci;
  }

  private advanceLine(): void {
    this.li += 1;
    this.ci = 0;
  }

  private skipLineSpaces(): void {
    const text = this.currentText();
    let i = 0;
    while (i < text.length && isSpace(text[i])) {
      i += 1;
    }
    this.ci += i;
  }

  /** True when only spaces, a comment, or nothing remains on the line. */
  private atLineEnd(): boolean {
    const rest = this.currentText().replace(/^[ \t]+/, "");
    return rest.length === 0 || rest.startsWith("#");
  }

  private skipIgnorable(): void {
    for (;;) {
      const line = this.currentLine();
      if (line === undefined) {
        return;
      }
      if (line.blank || line.comment) {
        if (this.ci === 0) {
          this.advanceLine();
          continue;
        }
        if (this.atLineEnd()) {
          this.advanceLine();
          continue;
        }
        return;
      }
      if (this.ci > 0 && this.atLineEnd()) {
        this.advanceLine();
        continue;
      }
      return;
    }
  }

  // ---- accounting -----------------------------------------------------

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > this.maxNodes) {
      this.fail("node-limit", "YAML node limit exceeded.");
    }
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      this.fail("depth-limit", "YAML nesting depth limit exceeded.");
    }
  }

  private exit(): void {
    this.depth -= 1;
  }

  private applyTag(tag: string | null, value: Json): Json {
    if (tag === null) {
      return value;
    }
    if (tag === "!str") {
      if (value === null) {
        return "";
      }
      return typeof value === "object" ? value : String(value);
    }
    if (PASSTHROUGH_TAGS.has(tag.slice(1))) {
      return value;
    }
    this.fail("invalid", `Unsupported YAML tag: ${tag}.`);
  }

  private register(anchor: string | null, value: Json): void {
    if (anchor !== null) {
      this.anchors.set(anchor, value);
    }
  }

  // ---- document -------------------------------------------------------

  parseDocument(): Json {
    let line = this.currentLine();
    while (
      line !== undefined &&
      !line.blank &&
      !line.comment &&
      line.text.startsWith("%")
    ) {
      this.advanceLine();
      line = this.currentLine();
    }
    if (
      line !== undefined &&
      !line.blank &&
      !line.comment &&
      (line.text === "---" || line.text.startsWith("--- "))
    ) {
      this.ci = 3;
      this.skipLineSpaces();
    }
    this.skipIgnorable();
    const value = this.parseNode(0, 0, true);
    this.skipIgnorable();
    const trailing = this.currentLine();
    if (trailing === undefined || trailing.blank || trailing.comment) {
      return value;
    }
    if (trailing.text === "..." || trailing.text.startsWith("... ")) {
      this.advanceLine();
      this.skipIgnorable();
      const after = this.currentLine();
      if (after !== undefined && !after.blank && !after.comment) {
        this.fail("invalid", "Unexpected content after the document end.");
      }
      return value;
    }
    if (trailing.text === "---" || trailing.text.startsWith("--- ")) {
      this.fail("invalid", "Multiple YAML documents are not supported.");
    }
    this.ci = 0;
    this.fail("invalid", "Unexpected content after the document value.");
  }

  // ---- block nodes ----------------------------------------------------

  /**
   * Parse one node whose first character sits at the current position.
   *
   * @param col        Column at which this node's content begins.
   * @param blockMin   Minimum indentation for a value placed on a following
   *                   line.
   * @param allowBlock Whether a block collection may start here.
   */
  private parseNode(col: number, blockMin: number, allowBlock: boolean): Json {
    this.countNode();
    this.enter();
    try {
      const properties = this.consumeProperties();
      const anchor = properties.anchor;
      if (this.currentLine() === undefined) {
        this.register(anchor, null);
        return this.applyTag(properties.tag, null);
      }
      if (this.atLineEnd()) {
        this.advanceLine();
        const nested = this.parseFollowingBlock(blockMin, allowBlock);
        this.register(anchor, nested);
        return this.applyTag(properties.tag, nested);
      }
      const text = this.currentText();
      const head = text[0];
      if (head === undefined) {
        this.register(anchor, null);
        return null;
      }
      if (head === "*") {
        const value = this.readAlias();
        this.register(anchor, value);
        return this.applyTag(properties.tag, value);
      }
      if (allowBlock && this.isSequenceEntry(text)) {
        const value = this.parseSequence(col);
        this.register(anchor, value);
        return this.applyTag(properties.tag, value);
      }
      if (allowBlock && this.tryScanKey() !== null) {
        const value = this.parseMapping(col);
        this.register(anchor, value);
        return this.applyTag(properties.tag, value);
      }
      if (head === "|" || head === ">") {
        const value = this.parseBlockScalar(blockMin);
        this.register(anchor, value);
        return this.applyTag(properties.tag, value);
      }
      if (head === "[" || head === "{") {
        const value = this.parseFlow();
        this.register(anchor, value);
        return this.applyTag(properties.tag, value);
      }
      const value = this.parseInlineScalar(blockMin);
      this.register(anchor, value);
      return this.applyTag(properties.tag, value);
    } finally {
      this.exit();
    }
  }

  /** Parse a node that begins on a line after the current one. */
  private parseFollowingBlock(
    blockMin: number,
    allowSameIndentSequence: boolean
  ): Json {
    this.skipIgnorable();
    const line = this.currentLine();
    if (line === undefined) {
      return null;
    }
    if (line.indent >= blockMin) {
      this.ci = 0;
      return this.parseNode(line.indent, line.indent + 1, true);
    }
    if (
      allowSameIndentSequence &&
      line.indent === blockMin - 1 &&
      this.isSequenceEntry(line.text)
    ) {
      this.ci = 0;
      return this.parseSequence(line.indent);
    }
    return null;
  }

  private consumeProperties(): NodeProperties {
    let anchor: string | null = null;
    let tag: string | null = null;
    for (;;) {
      this.skipLineSpaces();
      const text = this.currentText();
      if (text.startsWith("&")) {
        const match = ANCHOR_PATTERN.exec(text.slice(1));
        if (match === null) {
          this.fail("invalid", "Anchor name is missing.");
        }
        anchor = match[0];
        this.ci += 1 + match[0].length;
        continue;
      }
      if (text.startsWith("!")) {
        const match = TAG_PATTERN.exec(text.slice(1));
        const name = match === null ? "" : match[0];
        this.ci += 1 + name.length;
        tag = name;
        continue;
      }
      return { anchor, tag };
    }
  }

  private isSequenceEntry(text: string): boolean {
    if (!text.startsWith("-")) {
      return false;
    }
    return text.length === 1 || isSpace(text[1]);
  }

  /** Detect a `key:` prefix at the current position without consuming it. */
  private tryScanKey(): { key: string; valueOffset: number } | null {
    const text = this.currentText();
    if (text.startsWith("[") || text.startsWith("{")) {
      return null;
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const saved = this.ci;
      let key: string;
      try {
        key = this.readQuotedScalar();
      } catch {
        this.ci = saved;
        return null;
      }
      const after = this.currentText();
      const isKey =
        after.startsWith(":") &&
        (after.length === 1 || isSpace(after[1]) || after[1] === "#");
      // A probe never consumes: put the cursor back before returning.
      this.ci = saved;
      return isKey
        ? { key, valueOffset: text.length - after.length + 1 }
        : null;
    }
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "#" && (i === 0 || isSpace(text[i - 1]))) {
        return null;
      }
      if (ch === ":" && (i + 1 >= text.length || isSpace(text[i + 1]))) {
        const raw = text.slice(0, i).trimEnd();
        if (raw.length === 0) {
          return null;
        }
        return { key: raw, valueOffset: i + 1 };
      }
    }
    return null;
  }

  private parseMapping(indent: number): Json {
    const result: { [key: string]: Json } = {};
    let started = false;
    for (;;) {
      if (started) {
        this.skipIgnorable();
        const line = this.currentLine();
        if (line === undefined || this.ci !== 0) {
          break;
        }
        if (line.indent < indent) {
          break;
        }
        if (line.indent > indent) {
          this.fail("invalid", "Mapping entry is over-indented.");
        }
        if (this.isSequenceEntry(line.text)) {
          break;
        }
      }
      const scanned = this.tryScanKey();
      if (scanned === null) {
        if (started) {
          break;
        }
        this.fail("invalid", "Expected a mapping entry.");
      }
      started = true;
      if (Object.hasOwn(result, scanned.key)) {
        this.path.push(scanned.key);
        const where = { line: this.li + 1, column: this.ci + 1 };
        throw new SafeYamlError(
          "duplicate-key",
          `Duplicate mapping key: ${JSON.stringify(scanned.key)}`,
          where.line,
          where.column,
          this.pointer()
        );
      }
      this.ci += scanned.valueOffset;
      this.skipLineSpaces();
      this.path.push(scanned.key);
      const value = this.atLineEnd()
        ? this.valueOnNextLine(indent + 1, true)
        : this.parseNode(indent + scanned.valueOffset, indent + 1, false);
      this.path.pop();
      result[scanned.key] = value;
    }
    return result;
  }

  private parseSequence(indent: number): Json {
    const result: Json[] = [];
    let started = false;
    for (;;) {
      if (started) {
        this.skipIgnorable();
        const line = this.currentLine();
        if (
          line === undefined ||
          this.ci !== 0 ||
          line.indent !== indent ||
          !this.isSequenceEntry(line.text)
        ) {
          break;
        }
      }
      this.ci = 1;
      const after = this.currentText();
      let spaces = 0;
      while (spaces < after.length && isSpace(after[spaces])) {
        spaces += 1;
      }
      this.ci = 1 + spaces;
      this.path.push(result.length.toString(10));
      const item = this.atLineEnd()
        ? this.valueOnNextLine(indent + 1, false)
        : this.parseNode(indent + 1 + spaces, indent + 1, true);
      this.path.pop();
      result.push(item);
      started = true;
    }
    return result;
  }

  private valueOnNextLine(
    blockMin: number,
    allowSameIndentSequence: boolean
  ): Json {
    this.advanceLine();
    return this.parseFollowingBlock(blockMin, allowSameIndentSequence);
  }

  // ---- scalars --------------------------------------------------------

  private parseInlineScalar(blockMin: number): Json {
    const text = this.currentText();
    if (text.startsWith('"') || text.startsWith("'")) {
      return this.readQuotedScalar();
    }
    return this.readPlainScalar(blockMin);
  }

  private readAlias(): Json {
    const text = this.currentText();
    const match = ANCHOR_PATTERN.exec(text.slice(1));
    if (match === null) {
      this.fail("invalid", "Alias name is missing.");
    }
    const name = match[0];
    const rest = text.slice(1 + name.length);
    const accepted =
      rest.length === 0 ||
      rest.startsWith(" #") ||
      rest.startsWith(",") ||
      rest.startsWith("]") ||
      rest.startsWith("}") ||
      rest.startsWith(":") ||
      (this.flowDepth === 0 && rest.trim().length === 0);
    if (!accepted) {
      this.fail("invalid", "Unexpected content after an alias.");
    }
    this.ci += 1 + name.length;
    this.aliases += 1;
    if (this.aliases > this.maxAliasExpansions) {
      this.fail("alias-limit", "YAML alias expansion limit exceeded.");
    }
    const target = this.anchors.get(name);
    if (target === undefined) {
      this.fail("invalid", `Unknown alias: ${JSON.stringify(name)}.`);
    }
    return this.cloneCounting(target);
  }

  /** Deep copy an alias target while billing every copied node. */
  private cloneCounting(value: Json): Json {
    this.countNode();
    if (Array.isArray(value)) {
      const out: Json[] = [];
      for (const item of value) {
        out.push(this.cloneCounting(item));
      }
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.cloneCounting(item);
      }
      return out;
    }
    return value;
  }

  private readPlainScalar(blockMin: number): Json {
    const first = this.currentText()
      .slice(0, plainScalarEnd(this.currentText()))
      .trimEnd();
    this.ci += first.length;
    const parts = [first.trimStart()];
    let lastGood = this.save();
    for (;;) {
      const mark = this.save();
      this.advanceLine();
      const line = this.currentLine();
      if (
        line === undefined ||
        line.blank ||
        line.comment ||
        line.indent < blockMin
      ) {
        this.restore(mark);
        break;
      }
      this.ci = 0;
      const isContinuation =
        !this.isSequenceEntry(line.text) && this.tryScanKey() === null;
      if (!isContinuation) {
        this.restore(mark);
        break;
      }
      const rest = line.text.slice(0, plainScalarEnd(line.text)).trimEnd();
      parts.push(rest.trimStart());
      this.ci = rest.length;
      lastGood = this.save();
    }
    this.restore(lastGood);
    return resolvePlainScalar(parts.join(" "));
  }

  private readQuotedScalar(): string {
    const line = this.currentLine();
    const quote = line === undefined ? undefined : line.text[this.ci];
    if (quote !== '"' && quote !== "'") {
      this.fail("invalid", "Expected a quoted scalar.");
    }
    this.ci += 1;
    let out = "";
    let pendingBreaks = 0;
    for (;;) {
      const current = this.currentLine();
      if (current === undefined) {
        this.fail("invalid", "Unterminated quoted scalar.");
      }
      // `line.text` excludes indentation, and `this.ci` indexes into it.
      const text = current.text;
      if (this.ci >= text.length) {
        this.li += 1;
        this.ci = 0;
        this.skipBlankLines();
        pendingBreaks += 1;
        if (this.currentLine() === undefined) {
          this.fail("invalid", "Unterminated quoted scalar.");
        }
        continue;
      }
      const ch = text[this.ci];
      if (ch === undefined) {
        this.fail("invalid", "Unexpected end of the quoted scalar.");
      }
      if (ch === quote) {
        if (quote === "'" && text[this.ci + 1] === "'") {
          out += "'";
          this.ci += 2;
          continue;
        }
        this.ci += 1;
        return out;
      }
      if (quote === '"' && ch === "\\") {
        const escape = text[this.ci + 1];
        if (escape === undefined) {
          this.ci += 1;
          continue;
        }
        if (escape === "\n") {
          this.li += 1;
          this.ci = 0;
          this.skipBlankLines();
          continue;
        }
        this.ci += 2;
        out += this.readEscape(escape);
        pendingBreaks = 0;
        continue;
      }
      if (pendingBreaks > 0) {
        out += pendingBreaks > 1 ? "\n".repeat(pendingBreaks - 1) : " ";
        pendingBreaks = 0;
      }
      out += ch;
      this.ci += 1;
    }
  }

  private readEscape(escape: string): string {
    switch (escape) {
      case "0":
        return "\0";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "t":
      case "\t":
        return "\t";
      case "n":
        return "\n";
      case "v":
        return "\v";
      case "f":
        return "\f";
      case "r":
        return "\r";
      case "e":
        return "\x1b";
      case " ":
        return " ";
      case '"':
        return '"';
      case "/":
        return "/";
      case "\\":
        return "\\";
      case "N":
        return "";
      case "_":
        return " ";
      case "L":
        return "";
      case "P":
        return "";
      case "x":
      case "u":
      case "U": {
        const width = escape === "x" ? 2 : escape === "u" ? 4 : 8;
        const text = this.currentText();
        const hex = text.slice(0, width);
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          this.fail("invalid", "Malformed unicode escape in a quoted scalar.");
        }
        this.ci += width;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        this.fail("invalid", `Unknown escape sequence: \\${escape}.`);
    }
  }

  private skipBlankLines(): void {
    for (;;) {
      const line = this.currentLine();
      if (line === undefined || !line.blank) {
        return;
      }
      this.li += 1;
    }
  }

  private parseBlockScalar(blockMin: number): string {
    const header = this.currentText();
    const folded = header.startsWith(">");
    let chomp: "clip" | "strip" | "keep" = "clip";
    let explicitIndent = 0;
    let i = 1;
    for (; i < header.length; i += 1) {
      const ch = header[i];
      if (ch === undefined) {
        break;
      }
      if (ch >= "1" && ch <= "9") {
        explicitIndent = Number(ch);
        continue;
      }
      if (ch === "-") {
        chomp = "strip";
        continue;
      }
      if (ch === "+") {
        chomp = "keep";
        continue;
      }
      break;
    }
    const tail = header.slice(i).trim();
    if (tail.length > 0 && !tail.startsWith("#")) {
      this.fail("invalid", "Malformed block scalar header.");
    }
    const baseIndent = this.currentLine()?.indent ?? 0;
    this.advanceLine();

    let contentIndent = explicitIndent > 0 ? baseIndent + explicitIndent : -1;
    const collected: string[] = [];
    for (;;) {
      const line = this.currentLine();
      if (line === undefined) {
        break;
      }
      if (line.blank) {
        collected.push("");
        this.advanceLine();
        continue;
      }
      if (contentIndent < 0) {
        contentIndent = line.indent;
        if (contentIndent < blockMin) {
          break;
        }
      }
      if (line.indent < contentIndent) {
        break;
      }
      collected.push(`${" ".repeat(line.indent - contentIndent)}${line.text}`);
      this.advanceLine();
    }
    let trailingBlanks = 0;
    while (collected.length > 0 && collected[collected.length - 1] === "") {
      collected.pop();
      trailingBlanks += 1;
    }
    if (collected.length === 0) {
      return "";
    }
    const body = folded ? foldLines(collected) : collected.join("\n");
    if (chomp === "strip") {
      return body;
    }
    if (chomp === "keep") {
      return `${body}\n${"\n".repeat(trailingBlanks)}`;
    }
    return `${body}\n`;
  }

  // ---- flow collections ----------------------------------------------

  private parseFlow(): Json {
    this.enter();
    this.flowDepth += 1;
    try {
      const open = this.currentText()[0];
      if (open !== "[" && open !== "{") {
        this.fail("invalid", "Expected a flow collection.");
      }
      const close = open === "[" ? "]" : "}";
      this.ci += 1;
      this.countNode();
      if (open === "[") {
        const items: Json[] = [];
        for (;;) {
          this.skipFlowWhitespace();
          const text = this.currentText();
          if (text.startsWith(close)) {
            this.ci += 1;
            return items;
          }
          if (this.currentLine() === undefined) {
            this.fail("invalid", "Unterminated flow sequence.");
          }
          this.path.push(items.length.toString(10));
          const item = this.parseFlowValue(close);
          this.path.pop();
          items.push(item);
          const next = this.flowSeparator(close, "sequence");
          if (next === "end") {
            return items;
          }
        }
      }
      const result: { [key: string]: Json } = {};
      for (;;) {
        this.skipFlowWhitespace();
        const text = this.currentText();
        if (text.startsWith(close)) {
          this.ci += 1;
          return result;
        }
        if (this.currentLine() === undefined) {
          this.fail("invalid", "Unterminated flow mapping.");
        }
        const keyToken = this.readFlowToken();
        const key =
          typeof keyToken === "string" ? keyToken : JSON.stringify(keyToken);
        this.skipFlowWhitespace();
        let value: Json = null;
        if (this.currentText().startsWith(":")) {
          this.ci += 1;
          this.skipFlowWhitespace();
          const after = this.currentText();
          if (!after.startsWith(",") && !after.startsWith(close)) {
            this.path.push(key);
            value = this.parseFlowValue(close);
            this.path.pop();
          }
        }
        if (Object.hasOwn(result, key)) {
          this.path.push(key);
          const where = { line: this.li + 1, column: this.ci + 1 };
          throw new SafeYamlError(
            "duplicate-key",
            `Duplicate mapping key: ${JSON.stringify(key)}`,
            where.line,
            where.column,
            this.pointer()
          );
        }
        result[key] = value;
        if (this.flowSeparator(close, "mapping") === "end") {
          return result;
        }
      }
    } finally {
      this.flowDepth -= 1;
      this.exit();
    }
  }

  /** Consume a `,` or closing token; returns "end" when the collection closed. */
  private flowSeparator(
    close: string,
    kind: "sequence" | "mapping"
  ): "continue" | "end" {
    this.skipFlowWhitespace();
    const text = this.currentText();
    if (text.startsWith(",")) {
      this.ci += 1;
      this.skipFlowWhitespace();
      if (this.currentText().startsWith(close)) {
        this.ci += 1;
        return "end";
      }
      return "continue";
    }
    if (text.startsWith(close)) {
      this.ci += 1;
      return "end";
    }
    this.fail("invalid", `Expected ',' or '${close}' in a flow ${kind}.`);
  }

  private parseFlowValue(close: string): Json {
    this.countNode();
    const text = this.currentText();
    if (text.startsWith("[") || text.startsWith("{")) {
      return this.parseFlow();
    }
    const anchor = this.consumeFlowProperties();
    const afterProps = this.currentText();
    let value: Json;
    if (afterProps.startsWith("[") || afterProps.startsWith("{")) {
      value = this.parseFlow();
    } else if (afterProps.startsWith("*")) {
      value = this.readAlias();
    } else {
      value = this.readFlowToken();
    }
    this.register(anchor, value);
    if (close === "]" && this.currentText().startsWith(":")) {
      this.ci += 1;
      this.skipFlowWhitespace();
      const next = this.currentText();
      const inner =
        next.startsWith(",") || next.startsWith(close)
          ? null
          : this.parseFlowValue(close);
      const entry: { [key: string]: Json } = {};
      entry[typeof value === "string" ? value : JSON.stringify(value)] = inner;
      return entry;
    }
    return value;
  }

  private consumeFlowProperties(): string | null {
    let anchor: string | null = null;
    for (;;) {
      const text = this.currentText();
      if (text.startsWith("&")) {
        const match = ANCHOR_PATTERN.exec(text.slice(1));
        if (match === null) {
          this.fail("invalid", "Anchor name is missing.");
        }
        anchor = match[0];
        this.ci += 1 + match[0].length;
        this.skipFlowWhitespace();
        continue;
      }
      if (text.startsWith("!")) {
        const match = TAG_PATTERN.exec(text.slice(1));
        this.ci += 1 + (match === null ? 0 : match[0].length);
        this.skipFlowWhitespace();
        continue;
      }
      return anchor;
    }
  }

  private skipFlowWhitespace(): void {
    for (;;) {
      const text = this.currentText();
      if (text.length === 0) {
        if (this.currentLine() === undefined) {
          return;
        }
        this.li += 1;
        this.ci = 0;
        continue;
      }
      if (isSpace(text[0])) {
        this.ci += 1;
        continue;
      }
      if (text[0] === "#") {
        this.li += 1;
        this.ci = 0;
        continue;
      }
      return;
    }
  }

  private readFlowToken(): Json {
    const text = this.currentText();
    if (text.startsWith('"') || text.startsWith("'")) {
      return this.readQuotedScalar();
    }
    let i = 0;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "," || ch === "]" || ch === "}") {
        break;
      }
      if (ch === ":") {
        const next = text[i + 1];
        if (
          next === undefined ||
          next === "," ||
          next === "]" ||
          next === "}" ||
          isSpace(next)
        ) {
          break;
        }
      }
      if (ch === "#" && i > 0 && isSpace(text[i - 1])) {
        break;
      }
    }
    const raw = text.slice(0, i).trimEnd();
    this.ci += raw.length;
    return resolvePlainScalar(raw);
  }
}

/**
 * Parse one YAML document into a JSON value. Throws {@link SafeYamlError} on
 * any syntax, duplicate-key, or resource-limit violation.
 */
export function parseSafeYaml(
  text: string,
  options: SafeYamlOptions = {}
): Json {
  const maxNodes = options.maxNodes ?? 100_000;
  const maxBytes = options.maxBytes ?? 26_214_400;
  if (text.length > maxBytes) {
    throw new SafeYamlError(
      "size-limit",
      "YAML input exceeds the byte limit.",
      1,
      1,
      "#"
    );
  }
  const parser = new YamlParser(text, {
    maxNodes,
    maxDepth: options.maxDepth ?? 64,
    maxAliasExpansions: options.maxAliasExpansions ?? maxNodes
  });
  return parser.parseDocument();
}

// ---------------------------------------------------------------------------
// Line-based engine (pack manifests, Arazzo workflows, Steel rubrics)
// ---------------------------------------------------------------------------

/**
 * Failure situations the line-based engine reports. The dialect turns each
 * situation into the caller's exact error code and message.
 */
export type BlockYamlSituation =
  | "tab-indent"
  | "directive"
  | "multiple-documents"
  | "trailing-content"
  | "sequence-indent"
  | "compact-sequence"
  | "mapping-indent"
  | "expected-entry"
  | "empty-key"
  | "duplicate-key"
  | "node-limit"
  | "depth-limit"
  | "anchors"
  | "flow-unsupported"
  | "quoted-scalar"
  | "flow-trailing"
  | "flow-unterminated"
  | "flow-quoted"
  | "flow-key"
  | "flow-colon"
  | "flow-empty-key"
  | "flow-separator";

/** One failure the engine reports through the dialect's `fail` hook. */
export type BlockYamlFailure =
  | {
      readonly situation: Exclude<
        BlockYamlSituation,
        "duplicate-key" | "flow-separator"
      >;
      /** One-based source line number. */
      readonly line: number;
    }
  | {
      readonly situation: "duplicate-key";
      readonly line: number;
      readonly key: string;
    }
  | {
      readonly situation: "flow-separator";
      readonly line: number;
      readonly close: string;
    };

/** Node-count and depth limits the engine enforces. */
export interface BlockYamlLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
}

/**
 * Dialect that reproduces one caller's exact parsing behavior.
 *
 * The flags exist because the three historical parsers agreed on the core
 * algorithm but disagreed on purposeful details: which constructs count as
 * unsupported, when tabs are rejected, which quoted escapes exist, and how
 * block scalars treat blank lines and the keep indicator.
 */
export interface BlockYamlDialect {
  /**
   * Turn one failure into the error the caller throws. The implementation
   * must throw the returned error.
   */
  fail(failure: BlockYamlFailure): Error;
  /** Skip `%` directive lines instead of reporting them. */
  readonly skipDirectives: boolean;
  /**
   * Reject indentation tabs while splitting lines (`split`, before any
   * construct is parsed) or while reading lines (`read`, as the cursor
   * reaches them).
   */
  readonly tabCheck: "split" | "read";
  /** Parse single-line flow collections; `false` rejects them outright. */
  readonly flow: boolean;
  /** Limits to enforce, or `null` to disable both checks. */
  readonly limits: BlockYamlLimits | null;
  /** Accept the `\b`, `\f`, and `\0` escapes in double-quoted scalars. */
  readonly extendedEscapes: boolean;
  /**
   * Treat every blank line, comment-only lines included, as block-scalar
   * content regardless of indentation.
   */
  readonly blankIsContent: boolean;
  /**
   * Apply chomping to the rendered text plus one newline (`text`, the pack
   * and Steel form) or to the joined body (`body`, the Arazzo form). The
   * two forms disagree only when over-stripped rendering yields empty
   * trailing entries.
   */
  readonly chompFormulation: "text" | "body";
  /** Skip CR and LF between flow tokens. */
  readonly flowSkipsBreaks: boolean;
  /** Stop a plain flow-mapping key at `]` as well as at `:`, `,`, and `}`. */
  readonly flowKeyBreaksOnBracket: boolean;
}

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

const BLOCK_HEADER = /^([|>])([+-]\d*|\d+[+-]?)?$/;
const PLAIN_INTEGER = /^[+-]?[0-9]+$/;
const PLAIN_NUMBER = /^[+-]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][+-]?[0-9]+)?$/;

function isLineBreak(ch: string): boolean {
  return ch === "\n" || ch === "\r";
}

/** True for "- item" and a bare "-". */
function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/**
 * Read one quoted scalar starting at `start`, which must be a quote. The
 * scan stays on one line, as the line-based dialects require.
 */
function readQuotedScalar(
  text: string,
  start: number,
  extendedEscapes: boolean
): QuotedScalar | null {
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
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return null;
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      let mapped: string | null = null;
      switch (escape) {
        case '"':
        case "\\":
        case "/":
          mapped = escape;
          break;
        case "n":
          mapped = "\n";
          break;
        case "t":
          mapped = "\t";
          break;
        case "r":
          mapped = "\r";
          break;
        case "b":
          if (!extendedEscapes) {
            return null;
          }
          mapped = "\b";
          break;
        case "f":
          if (!extendedEscapes) {
            return null;
          }
          mapped = "\f";
          break;
        case "0":
          if (!extendedEscapes) {
            return null;
          }
          mapped = "\0";
          break;
        default:
          return null;
      }
      out += mapped;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

/** Resolve one plain scalar to null, a boolean, a number, or a string. */
function resolveLineScalar(input: string): Json {
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
function splitEntry(text: string, extendedEscapes: boolean): EntrySplit | null {
  const first = text.charAt(0);
  if (first === '"' || first === "'") {
    const scalar = readQuotedScalar(text, 0, extendedEscapes);
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

/** Fold the rendered lines of a folded (`>`) block scalar. */
function foldRendered(rendered: readonly string[]): string {
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
  return folded.join("\n");
}

/** Split the input into significant lines, applying the dialect tab rule. */
function splitSourceLines(
  text: string,
  dialect: BlockYamlDialect
): SourceLine[] {
  return text.split("\n").map((raw, position) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let indent = 0;
    while (indent < line.length && line.charAt(indent) === " ") {
      indent += 1;
    }
    if (dialect.tabCheck === "split" && line.charAt(indent) === "\t") {
      throw dialect.fail({ situation: "tab-indent", line: position + 1 });
    }
    const content = line.slice(indent);
    return {
      text: content,
      indent,
      number: position + 1,
      blank: content === "" || content.startsWith("#")
    };
  });
}

/** Line-based reader. One instance parses exactly one document. */
class BlockYamlParser {
  private readonly lines: readonly SourceLine[];
  private readonly dialect: BlockYamlDialect;
  private readonly limited: boolean;
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private index = 0;
  private nodes = 0;

  constructor(lines: readonly SourceLine[], dialect: BlockYamlDialect) {
    this.lines = lines;
    this.dialect = dialect;
    this.limited = dialect.limits !== null;
    this.maxNodes = dialect.limits?.maxNodes ?? 0;
    this.maxDepth = dialect.limits?.maxDepth ?? 0;
  }

  private fail(failure: BlockYamlFailure): never {
    throw this.dialect.fail(failure);
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
      this.fail({
        situation: trailing.text.startsWith("---")
          ? "multiple-documents"
          : "trailing-content",
        line: trailing.number
      });
    }
    return value;
  }

  private skipDocumentStart(): void {
    for (;;) {
      const line = this.peek();
      if (line === null) {
        return;
      }
      if (line.text.startsWith("%")) {
        if (this.dialect.skipDirectives) {
          this.index += 1;
          continue;
        }
        this.fail({ situation: "directive", line: line.number });
      }
      if (line.text === "---") {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  /** Next significant line, or null at the end of the document. */
  private peek(): SourceLine | null {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined || !line.blank) {
        if (
          line !== undefined &&
          this.dialect.tabCheck === "read" &&
          line.text.startsWith("\t")
        ) {
          this.fail({ situation: "tab-indent", line: line.number });
        }
        return line ?? null;
      }
      this.index += 1;
    }
    return null;
  }

  private count(line: number): void {
    if (!this.limited) {
      return;
    }
    this.nodes += 1;
    if (this.nodes > this.maxNodes) {
      this.fail({ situation: "node-limit", line });
    }
  }

  private parseNode(depth: number): Json {
    if (this.limited && depth > this.maxDepth) {
      const line = this.peek();
      this.fail({ situation: "depth-limit", line: line?.number ?? 1 });
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
    for (;;) {
      const line = this.peek();
      if (
        line === null ||
        line.indent < indent ||
        !isSequenceEntry(line.text)
      ) {
        return items;
      }
      if (line.indent > indent) {
        this.fail({ situation: "sequence-indent", line: line.number });
      }
      this.index += 1;
      this.count(line.number);
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
      this.fail({ situation: "compact-sequence", line: dash.number });
    }
    const content = stripComment(rest);
    if (splitEntry(content, this.dialect.extendedEscapes) !== null) {
      const offset = dash.text.length - rest.length;
      return this.parseMapping(dash.indent + offset, depth, {
        content,
        line: dash.number
      });
    }
    return this.parseInline(rest, dash.number);
  }

  private parseMapping(
    indent: number,
    depth: number,
    pending: { readonly content: string; readonly line: number } | null
  ): JsonObject {
    const result: JsonObject = {};
    let first = pending;
    for (;;) {
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
          this.fail({ situation: "mapping-indent", line: line.number });
        }
        if (isSequenceEntry(line.text)) {
          return result;
        }
        this.index += 1;
        content = line.text;
        lineNumber = line.number;
      }
      const entry = splitEntry(content, this.dialect.extendedEscapes);
      if (entry === null) {
        this.fail({ situation: "expected-entry", line: lineNumber });
      }
      if (entry.key === "") {
        this.fail({ situation: "empty-key", line: lineNumber });
      }
      this.count(lineNumber);
      if (Object.hasOwn(result, entry.key)) {
        this.fail({
          situation: "duplicate-key",
          line: lineNumber,
          key: entry.key
        });
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
    return this.parseInline(rest, lineNumber);
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
      const contentBlank = this.dialect.blankIsContent
        ? line.blank
        : line.text === "";
      if (contentBlank) {
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
    if (this.dialect.chompFormulation === "text") {
      let text: string;
      if (style === "|") {
        text = rendered.length === 0 ? "" : `${rendered.join("\n")}\n`;
      } else {
        const body = foldRendered(rendered);
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
    const body = style === "|" ? rendered.join("\n") : foldRendered(rendered);
    if (chomp === "strip") {
      return body;
    }
    if (chomp === "keep") {
      return `${body}\n`;
    }
    return body === "" ? "" : `${body}\n`;
  }

  private parseInline(text: string, lineNumber: number): Json {
    const stripped = stripComment(text).trim();
    if (stripped === "") {
      return null;
    }
    const first = stripped.charAt(0);
    if (first === "&" || first === "*" || first === "!") {
      this.fail({ situation: "anchors", line: lineNumber });
    }
    if (first === '"' || first === "'") {
      const scalar = readQuotedScalar(
        stripped,
        0,
        this.dialect.extendedEscapes
      );
      if (scalar === null || scalar.next !== stripped.length) {
        this.fail({ situation: "quoted-scalar", line: lineNumber });
      }
      this.count(lineNumber);
      return scalar.value;
    }
    if (first === "[" || first === "{") {
      if (!this.dialect.flow) {
        this.fail({ situation: "flow-unsupported", line: lineNumber });
      }
      const flow = this.parseFlowCollection(stripped, 0, lineNumber);
      if (flow.next !== stripped.length) {
        this.fail({ situation: "flow-trailing", line: lineNumber });
      }
      return flow.value;
    }
    this.count(lineNumber);
    return resolveLineScalar(stripped);
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
    for (;;) {
      // Re-skip flow whitespace at the top of every iteration so a
      // separator directly followed by the closer ends the collection
      // instead of producing one empty item. The dialect decides whether
      // CR and LF count as flow whitespace here.
      i = this.skipFlowSpace(text, i);
      if (i >= text.length) {
        this.fail({ situation: "flow-unterminated", line: lineNumber });
      }
      if (text.charAt(i) === close) {
        return {
          value: open === "[" ? items : map,
          next: i + 1
        };
      }
      this.count(lineNumber);
      if (open === "[") {
        const item = this.parseFlowItem(text, i, lineNumber);
        items.push(item.value);
        i = item.next;
      } else {
        const key = this.parseFlowKey(text, i, lineNumber);
        i = this.skipFlowSpace(text, key.next);
        if (text.charAt(i) !== ":") {
          this.fail({ situation: "flow-colon", line: lineNumber });
        }
        const value = this.parseFlowItem(text, i + 1, lineNumber);
        if (Object.hasOwn(map, key.value)) {
          this.fail({
            situation: "duplicate-key",
            line: lineNumber,
            key: key.value
          });
        }
        map[key.value] = value.value;
        i = value.next;
      }
      i = this.skipFlowSpace(text, i);
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
      this.fail({ situation: "flow-separator", line: lineNumber, close });
    }
  }

  private parseFlowItem(
    text: string,
    start: number,
    lineNumber: number
  ): FlowValue {
    const i = this.skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === "[" || ch === "{") {
      return this.parseFlowCollection(text, i, lineNumber);
    }
    if (ch === '"' || ch === "'") {
      const scalar = readQuotedScalar(text, i, this.dialect.extendedEscapes);
      if (scalar === null) {
        this.fail({ situation: "flow-quoted", line: lineNumber });
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
    return { value: resolveLineScalar(text.slice(i, end)), next: end };
  }

  private parseFlowKey(
    text: string,
    start: number,
    lineNumber: number
  ): { value: string; next: number } {
    const i = this.skipFlowSpace(text, start);
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const scalar = readQuotedScalar(text, i, this.dialect.extendedEscapes);
      if (scalar === null) {
        this.fail({ situation: "flow-key", line: lineNumber });
      }
      return { value: scalar.value, next: scalar.next };
    }
    let end = i;
    while (end < text.length) {
      const c = text.charAt(end);
      if (
        c === ":" ||
        c === "," ||
        c === "}" ||
        (this.dialect.flowKeyBreaksOnBracket && c === "]")
      ) {
        break;
      }
      end += 1;
    }
    const value = text.slice(i, end).trim();
    if (value === "") {
      this.fail({ situation: "flow-empty-key", line: lineNumber });
    }
    return { value, next: end };
  }

  private skipFlowSpace(text: string, start: number): number {
    let i = start;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (!isSpace(ch) && !(this.dialect.flowSkipsBreaks && isLineBreak(ch))) {
        break;
      }
      i += 1;
    }
    return i;
  }
}

/**
 * Parse one YAML document with the shared line-based engine. Throws the
 * error the dialect's `fail` hook builds; nothing else escapes.
 */
export function parseBlockYaml(text: string, dialect: BlockYamlDialect): Json {
  const lines = splitSourceLines(text, dialect);
  return new BlockYamlParser(lines, dialect).parseDocument();
}
