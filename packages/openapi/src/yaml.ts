import { escapeToken, type Json } from "@oal/core";

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
