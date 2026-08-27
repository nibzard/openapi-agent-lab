/**
 * Shared fixtures of the evaluator integration suite (specification
 * section 36.1).
 *
 * The evaluator package depends only on `@oal/core` and `@oal/evidence`,
 * so this module rebuilds the minimal loading path the testkit offers:
 * repository-root discovery, a YAML subset parser that mirrors the pack
 * parser, pack-relative schema resolution, and Steel trace builders.
 *
 * The rubric digests pinned in `integration-steel.test.ts` prove that the
 * rebuilt path loads the shipped Steel rubrics exactly as the pack loader
 * does.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isJsonObject, type Json, type JsonObject } from "@oal/core";
import type { TraceBody, TraceEvent } from "@oal/evidence";

import { loadRubric, type Rubric, type RubricLoadResult } from "./rubric.ts";

/** File whose presence marks the repository root. */
const REPO_ROOT_MARKER = "pnpm-workspace.yaml";

/** Directory of this module, always inside the repository. */
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Find the repository root.
 *
 * The search starts at this module and walks up, so it works from any
 * working directory. The module fallback keeps the helper usable when a
 * caller passes a start directory outside the repository.
 */
export function repoRoot(start: string = MODULE_DIR): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, REPO_ROOT_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No ${REPO_ROOT_MARKER} found above ${start}.`);
    }
    current = parent;
  }
}

/** Directory of the shipped Steel Computer pack. */
export function steelPackRoot(): string {
  return path.join(repoRoot(), "packs", "steel-computer");
}

/** Read one JSON document inside the Steel pack. */
export function readSteelJson(relativePath: string): Json {
  const absolute = path.join(steelPackRoot(), relativePath);
  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as Json;
  if (!isJsonObject(parsed)) {
    throw new Error(`Not a JSON object: ${relativePath}`);
  }
  return parsed;
}

/** Every eval of the Steel Computer pack. */
export const STEEL_EVAL_IDS = [
  "checkpoint-recovery",
  "basic-lifecycle",
  "documentation-discovery"
] as const;

/** One eval of the Steel Computer pack. */
export type SteelEvalId = (typeof STEEL_EVAL_IDS)[number];

/**
 * Load one shipped Steel rubric with the repository rubric schema.
 *
 * `schema:` references inside the rubric resolve against the pack root,
 * which is the convention the pack rubrics follow.
 */
export function loadSteelRubric(evalId: SteelEvalId): RubricLoadResult {
  const rubricPath = path.join("evals", evalId, "rubric.yaml");
  const document = parseSteelYaml(
    readFileSync(path.join(steelPackRoot(), rubricPath), "utf8")
  );
  const schema = readFileSync(
    path.join(repoRoot(), "schemas", "rubric.v1.schema.json"),
    "utf8"
  );
  return loadRubric(document, {
    schema: JSON.parse(schema) as Json,
    resolveSchema: (reference: string): Json | undefined => {
      try {
        return readSteelJson(reference);
      } catch {
        return undefined;
      }
    },
    documentUri: `file://${path.join(steelPackRoot(), rubricPath)}`
  });
}

/** The rubric of one Steel eval, or a thrown error when it did not load. */
export function steelRubric(evalId: SteelEvalId): Rubric {
  const result = loadSteelRubric(evalId);
  if (result.rubric !== null && result.diagnostics.length === 0) {
    return result.rubric;
  }
  const first = result.diagnostics[0];
  throw new Error(
    first === undefined
      ? `The rubric of ${evalId} did not load.`
      : `${first.code}: ${first.message}`
  );
}

/**
 * Parse the YAML subset the pack rubrics use.
 *
 * The semantics mirror `parsePackYaml` of `@oal/pack`: block mappings,
 * block sequences with compact mapping items, comments, plain and quoted
 * scalars, literal `|` and folded `>` block scalars with chomping, and
 * duplicate-key rejection. Anchors, aliases, tags, and flow collections
 * are rejected, because no shipped rubric uses them.
 */

/** Error thrown for any unsupported YAML construct. */
export class SteelYamlError extends Error {
  /** One-based line number of the failure. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "SteelYamlError";
    this.line = line;
  }
}

interface SourceLine {
  readonly text: string;
  readonly indent: number;
  readonly number: number;
  readonly blank: boolean;
}

const PLAIN_INTEGER = /^[+-]?[0-9]+$/;
const PLAIN_NUMBER = /^[+-]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][+-]?[0-9]+)?$/;
const BLOCK_HEADER = /^([|>])([+-]\d*|\d+[+-]?)?$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function toSourceLine(raw: string, number: number): SourceLine {
  let indent = 0;
  while (indent < raw.length && raw.charAt(indent) === " ") {
    indent += 1;
  }
  if (raw.charAt(indent) === "\t") {
    throw new SteelYamlError(
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

function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

interface QuotedScalar {
  readonly value: string;
  readonly next: number;
}

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
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return null;
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else {
        const map: Readonly<Record<string, string>> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          n: "\n",
          t: "\t",
          r: "\r",
          b: "\b",
          f: "\f",
          "0": "\0"
        };
        const mapped = map[escape];
        if (mapped === undefined) {
          return null;
        }
        out += mapped;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

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

interface EntrySplit {
  readonly key: string;
  readonly rest: string;
}

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

class SteelYamlParser {
  private readonly lines: readonly SourceLine[];
  private index = 0;

  constructor(lines: readonly SourceLine[]) {
    this.lines = lines;
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
      throw new SteelYamlError(
        "Unexpected content after the document.",
        trailing.number
      );
    }
    return value;
  }

  private skipDocumentStart(): void {
    for (;;) {
      const line = this.peek();
      if (line === null) {
        return;
      }
      if (line.text.startsWith("%") || line.text === "---") {
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

  private parseNode(depth: number): Json {
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
        throw new SteelYamlError(
          "Unexpected indentation in a block sequence.",
          line.number
        );
      }
      this.index += 1;
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
      throw new SteelYamlError(
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
    return this.parseScalar(rest, dash.number);
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
          throw new SteelYamlError(
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
        throw new SteelYamlError(
          "Expected a 'key: value' mapping entry.",
          lineNumber
        );
      }
      if (entry.key === "") {
        throw new SteelYamlError("Mapping keys must not be empty.", lineNumber);
      }
      if (Object.hasOwn(result, entry.key)) {
        throw new SteelYamlError(
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
    return this.parseScalar(rest, lineNumber);
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

  private parseScalar(text: string, lineNumber: number): Json {
    const stripped = stripComment(text).trim();
    if (stripped === "") {
      return null;
    }
    const first = stripped.charAt(0);
    if (first === "&" || first === "*" || first === "!") {
      throw new SteelYamlError(
        "Anchors, aliases, and tags are not supported.",
        lineNumber
      );
    }
    if (first === "[" || first === "{") {
      throw new SteelYamlError(
        "Flow collections are not supported.",
        lineNumber
      );
    }
    if (first === '"' || first === "'") {
      const scalar = readQuoted(stripped, 0);
      if (scalar === null || scalar.next !== stripped.length) {
        throw new SteelYamlError(
          "Unterminated or trailing quoted scalar.",
          lineNumber
        );
      }
      return scalar.value;
    }
    return resolvePlainScalar(stripped);
  }
}

/** Parse the YAML subset the Steel rubrics use. */
export function parseSteelYaml(text: string): Json {
  const lines = text
    .split("\n")
    .map((raw, position) => toSourceLine(raw.replace(/\r$/, ""), position + 1));
  return new SteelYamlParser(lines).parseDocument();
}

/**
 * Build one `api.exchange` trace event.
 *
 * The field set mirrors the trace the loopback exposure writes: the
 * operation block carries the contract identity, the request carries the
 * path parameters the participant used, and the response carries the
 * status and body the rubric inspects.
 */
export interface TraceExchangeInit {
  readonly sequence: number;
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly status: number;
  readonly pathParameters?: Record<string, string>;
  readonly requestPath?: string;
  readonly requestBody?: TraceBody;
  readonly responseBody?: TraceBody;
  readonly matched?: boolean;
}

/** Session identifier the Steel fixtures use. */
export const SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** Fixed instant every fixture exchange reports. */
export const OBSERVED_AT = "2023-11-14T22:13:20.000Z";

export function traceExchange(init: TraceExchangeInit): TraceEvent {
  const operationKey = `path:${init.method} ${init.pathTemplate}`;
  return {
    schema_version: 1,
    type: "api.exchange",
    event_id: `req_${init.sequence.toString(10).padStart(8, "0")}`,
    sequence: init.sequence,
    participant_ingress_sequence: init.sequence,
    observed_at: OBSERVED_AT,
    logical_time: null,
    batch_id: null,
    run_id: null,
    eval_id: null,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: init.matched ?? true,
      key: operationKey,
      uid: `op-${init.operationId}`,
      operation_id: init.operationId,
      method: init.method,
      path_template: init.pathTemplate,
      support: "supported"
    },
    request: {
      received_at: OBSERVED_AT,
      method: init.method,
      path: init.requestPath ?? init.pathTemplate,
      query_string: "",
      query: [],
      path_parameters: init.pathParameters ?? {},
      headers: [],
      credential_present: true,
      content_type: "application/json",
      body: init.requestBody ?? { kind: "none" }
    },
    authentication: {
      status: "authenticated",
      alternative_index: null,
      schemes: ["apiKey"],
      principal_ref: null
    },
    validation: {
      request: { status: "valid", violations: [] },
      response: { status: "valid", violations: [] }
    },
    backend: null,
    response: {
      completed_at: OBSERVED_AT,
      status: init.status,
      headers: [],
      content_type: "application/json",
      body: init.responseBody ?? { kind: "none" }
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error: null,
    duration_ms: 4,
    resource_usage: null,
    extensions: {}
  };
}

/** Build one JSON trace body. */
export function jsonBody(value: Json): TraceBody {
  return {
    kind: "json",
    size_bytes: JSON.stringify(value).length,
    value,
    truncated: false
  };
}

/** Build one binary trace body with the digest a rubric compares. */
export function binaryBody(sha256: string): TraceBody {
  return { kind: "binary", size_bytes: 32, sha256, blob_ref: null };
}

/** Build one multipart trace body with a single file part. */
export function multipartBody(filename: string): TraceBody {
  return {
    kind: "multipart",
    size_bytes: 32,
    parts: [
      {
        name: "file",
        filename,
        headers: [],
        body: binaryBody(
          `sha256-${filename.replace(/[^a-z0-9]/gu, "")}`.padEnd(64, "0")
        )
      }
    ]
  };
}

/** Final reports, one per Steel eval. Each matches its pack schema. */
export const STEEL_REPORTS: Readonly<Record<SteelEvalId, JsonObject>> = {
  "checkpoint-recovery": {
    released_session: true,
    saved_state_create_supported: false,
    notes: "flow complete"
  },
  "basic-lifecycle": {
    session_created: true,
    session_released: true,
    final_status: "released"
  },
  "documentation-discovery": {
    session_created: true,
    operations_discovered: 41,
    contract_source: "openapi.json"
  }
};

/** Path parameters of one session-scoped Steel route. */
function sessionParams(extra: Readonly<Record<string, string>> = {}): {
  sessionId: string;
} & Record<string, string> {
  return { sessionId: SESSION_ID, ...extra };
}

/** One create-session exchange with a live session body. */
export function createSession(sequence: number, status = 201): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "create_session",
    method: "POST",
    pathTemplate: "/v1/sessions",
    status,
    responseBody: jsonBody({ id: SESSION_ID, status: "live" })
  });
}

/** One read-session exchange with the given status value. */
export function readSession(
  sequence: number,
  sessionStatus: string
): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "get_session",
    method: "GET",
    pathTemplate: "/v1/sessions/{id}",
    status: 200,
    pathParameters: { id: SESSION_ID },
    responseBody: jsonBody({ id: SESSION_ID, status: sessionStatus })
  });
}

/** One release-session exchange. */
export function releaseSession(sequence: number): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "release_session",
    method: "POST",
    pathTemplate: "/v1/sessions/{id}/release",
    status: 200,
    pathParameters: { id: SESSION_ID },
    responseBody: jsonBody({ id: SESSION_ID, status: "released" })
  });
}

/** One file upload exchange. */
export function uploadFile(sequence: number, filename: string): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "upload_file",
    method: "POST",
    pathTemplate: "/v1/sessions/{sessionId}/files",
    status: 201,
    pathParameters: sessionParams(),
    requestBody: multipartBody(filename),
    responseBody: jsonBody({ path: filename })
  });
}

/** One file download exchange. */
export function downloadFile(
  sequence: number,
  filename: string,
  sha256: string
): TraceEvent {
  return traceExchange({
    sequence,
    operationId: "download_file",
    method: "GET",
    pathTemplate: "/v1/sessions/{sessionId}/files/{path}",
    status: 200,
    pathParameters: sessionParams({ path: filename }),
    requestPath: `/v1/sessions/${SESSION_ID}/files/${filename}`,
    responseBody: binaryBody(sha256)
  });
}
