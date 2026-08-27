/**
 * Catalog search (specification section 18.3). Search is deterministic and
 * local: tokenized lexical ranking over contract fields, with no embedding,
 * model, or network access. The tokenizer, field weights, stop-word list,
 * and version are frozen and recorded so any ranking change is visible.
 *
 * Two specification wordings needed a decision, recorded here:
 *
 * - Path fields index literal segments only. A brace-wrapped parameter is
 *   dropped as a whole, because parameter names carry their own weight.
 * - The operationId field indexes the operationId when present, and the
 *   generated tool name otherwise, matching the single weight-table row.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  infrastructure,
  invalidInput,
  isJsonObject,
  sha256Hex,
  type Json
} from "@oal/core";
import type {
  ContractIR,
  OperationIR,
  SchemaIR,
  SupportLevel
} from "@oal/contract-ir";

/** Version of the complete ranking algorithm. */
export const SEARCH_ALGORITHM_VERSION = 1 as const;

/** Version of the tokenizer alone. */
export const SEARCH_TOKENIZER_VERSION = 1 as const;

/** Version of the checked-in English stop-word list. */
export const STOP_WORD_LIST_VERSION = "v1" as const;

export const STOP_WORD_LIST_FILE = "stop-words.v1.txt";

/** Indexed fields and their weights, from specification section 18.3. */
export type SearchFieldName =
  | "operationId"
  | "method"
  | "pathLiteral"
  | "summary"
  | "tag"
  | "parameterName"
  | "propertyName"
  | "description";

export const SEARCH_FIELD_WEIGHTS: Readonly<Record<SearchFieldName, number>> =
  Object.freeze({
    operationId: 10,
    method: 8,
    pathLiteral: 8,
    summary: 6,
    tag: 5,
    parameterName: 4,
    propertyName: 3,
    description: 1
  });

/** Score factors, multiplied by the field weight. */
export const SEARCH_SCORE_FACTORS = Object.freeze({
  exactToken: 100,
  tokenPrefix: 25,
  exactPhrase: 200
});

export const SEARCH_LIMITS = Object.freeze({
  queryTokens: 32,
  fieldTokens: 4096,
  maxResults: 100
});

const DEFAULT_RESULT_LIMIT = 10;

/** Frozen record of everything that decides the ranking. */
export interface SearchAlgorithmDescriptor {
  version: typeof SEARCH_ALGORITHM_VERSION;
  tokenizer: {
    version: typeof SEARCH_TOKENIZER_VERSION;
    normalization: readonly string[];
    splits: readonly string[];
    drops: readonly string[];
  };
  stemming: "none";
  collation: "unicode-code-point";
  stopWordList: {
    version: typeof STOP_WORD_LIST_VERSION;
    file: string;
    size: number;
    sha256: string;
  };
  fieldWeights: Readonly<Record<SearchFieldName, number>>;
  scoreFactors: typeof SEARCH_SCORE_FACTORS;
  limits: typeof SEARCH_LIMITS;
  ordering: "score-descending-then-canonical-key-ascending";
}

/** One indexed field: an ordered token list plus a lookup set. */
interface IndexedField {
  field: SearchFieldName;
  weight: number;
  tokens: string[];
  tokenSet: Set<string>;
}

/** One indexed operation with its search metadata. */
interface IndexedOperation {
  key: string;
  uid: string;
  operationId: string | null;
  method: string;
  pathTemplate: string;
  summary: string | null;
  tags: string[];
  support: SupportLevel;
  fields: IndexedField[];
}

export interface SearchOperationsInput {
  query: string;
  /** Results to return. The default is 10 and the cap is 100. */
  limit?: number | undefined;
  /** Restrict results to these uppercase HTTP methods. */
  methods?: string[] | undefined;
  /** Restrict results to operations that carry one of these tags. */
  tags?: string[] | undefined;
  /** Restrict results to these support levels. */
  support?: SupportLevel[] | undefined;
}

export interface SearchOperationRecord {
  key: string;
  uid: string;
  operationId: string | null;
  method: string;
  pathTemplate: string;
  summary: string | null;
  tags: string[];
  support: SupportLevel;
  /** Deterministic integer lexical score. */
  score: number;
}

export interface SearchOperationsResult {
  algorithm: SearchAlgorithmDescriptor;
  results: SearchOperationRecord[];
  /** Operations that passed every filter, before the limit was applied. */
  matchedCount: number;
  limited: boolean;
}

let stopWordCache: ReadonlySet<string> | undefined;
let stopWordDescriptor: SearchAlgorithmDescriptor["stopWordList"] | undefined;

/** Load the checked-in stop-word list once and freeze it. */
export function stopWords(): ReadonlySet<string> {
  loadStopWordList();
  return stopWordCache as ReadonlySet<string>;
}

function loadStopWordList(): SearchAlgorithmDescriptor["stopWordList"] {
  if (stopWordDescriptor !== undefined) {
    return stopWordDescriptor;
  }
  const target = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    STOP_WORD_LIST_FILE
  );
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    throw infrastructure(
      "OAL-STOP-WORDS-MISSING",
      `The versioned stop-word list is missing: ${target}`
    );
  }
  const words = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const seen = new Set<string>();
  for (const word of words) {
    if (word !== word.toLowerCase()) {
      throw infrastructure(
        "OAL-STOP-WORDS-INVALID",
        "The stop-word list contains an uppercase entry.",
        { word }
      );
    }
    if (seen.has(word)) {
      throw infrastructure(
        "OAL-STOP-WORDS-INVALID",
        "The stop-word list contains a duplicate entry.",
        { word }
      );
    }
    seen.add(word);
  }
  const sorted = [...seen].sort(compareCodePoints);
  if (sorted.join("\n") !== [...seen].join("\n")) {
    throw infrastructure(
      "OAL-STOP-WORDS-INVALID",
      "The stop-word list is not sorted by code point."
    );
  }
  stopWordCache = seen;
  stopWordDescriptor = Object.freeze({
    version: STOP_WORD_LIST_VERSION,
    file: STOP_WORD_LIST_FILE,
    size: seen.size,
    sha256: sha256Hex(text)
  });
  return stopWordDescriptor;
}

/** Compare two strings by Unicode code point, not by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const leftPoint = (left[i] as string).codePointAt(0) as number;
    const rightPoint = (right[i] as string).codePointAt(0) as number;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  return left.length < right.length ? -1 : 1;
}

/**
 * Split text into tokens: NFKC normalization, camelCase, snake_case,
 * kebab-case, punctuation, and whitespace boundaries. Digits stay attached
 * to their word, so a literal such as `v1` stays one token.
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const spaced = normalized
    .replace(/([\p{Ll}\p{Lo}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  return spaced
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Query tokens after stop-word removal: order preserved, duplicates removed,
 * capped at the frozen query limit.
 */
export function queryTokens(query: string): string[] {
  const stops = stopWords();
  const out: string[] = [];
  for (const token of tokenize(query)) {
    if (stops.has(token) || out.includes(token)) {
      continue;
    }
    if (out.length >= SEARCH_LIMITS.queryTokens) {
      break;
    }
    out.push(token);
  }
  return out;
}

function makeField(field: SearchFieldName, text: string): IndexedField {
  const tokens: string[] = [];
  const tokenSet = new Set<string>();
  for (const token of tokenize(text)) {
    if (tokens.length >= SEARCH_LIMITS.fieldTokens) {
      break;
    }
    tokens.push(token);
    tokenSet.add(token);
  }
  return {
    field,
    weight: SEARCH_FIELD_WEIGHTS[field],
    tokens,
    tokenSet
  };
}

/** Registry lookup for schema references, by UID and by source pointer. */
class SchemaLookup {
  private readonly byUid = new Map<string, Json>();
  private readonly byPointer = new Map<string, string>();

  constructor(schemas: Record<string, SchemaIR>) {
    for (const uid of Object.keys(schemas).sort(compareCodePoints)) {
      const entry = schemas[uid];
      if (entry === undefined) {
        continue;
      }
      this.byUid.set(uid, entry.schema);
      this.byPointer.set(entry.source_pointer, uid);
    }
  }

  resolve(reference: string): Json | undefined {
    const byUid = this.byUid.get(reference);
    if (byUid !== undefined) {
      return byUid;
    }
    const marker = reference.indexOf("#");
    const rawPointer = marker === -1 ? reference : reference.slice(marker + 1);
    if (rawPointer.length === 0) {
      return undefined;
    }
    const pointer = rawPointer.startsWith("/") ? rawPointer : `/${rawPointer}`;
    const uid = this.byPointer.get(pointer);
    return uid === undefined ? undefined : this.byUid.get(uid);
  }
}

const MAX_SCHEMA_DEPTH = 24;

/** Collect object property names from one schema, bounded and cycle-safe. */
function collectPropertyNames(
  schema: Json | undefined,
  lookup: SchemaLookup,
  out: string[],
  seen: Set<string>,
  depth: number
): void {
  if (schema === undefined || depth > MAX_SCHEMA_DEPTH) {
    return;
  }
  if (!isJsonObject(schema)) {
    return;
  }
  const rawRef: unknown = schema.$ref;
  const reference = typeof rawRef === "string" ? rawRef : null;
  if (reference !== null) {
    if (seen.has(reference)) {
      return;
    }
    seen.add(reference);
    collectPropertyNames(
      lookup.resolve(reference),
      lookup,
      out,
      seen,
      depth + 1
    );
    return;
  }
  const properties = schema.properties;
  if (isJsonObject(properties)) {
    for (const name of Object.keys(properties).sort(compareCodePoints)) {
      if (out.length >= SEARCH_LIMITS.fieldTokens) {
        return;
      }
      out.push(name);
      collectPropertyNames(properties[name], lookup, out, seen, depth + 1);
    }
  }
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const list = schema[combinator];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      collectPropertyNames(entry, lookup, out, seen, depth + 1);
    }
  }
  const items = schema.items;
  if (items !== undefined) {
    collectPropertyNames(items, lookup, out, seen, depth + 1);
  }
}

function propertyNamesText(
  operation: OperationIR,
  lookup: SchemaLookup
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  const bodies =
    operation.request_body === null ? [] : operation.request_body.content;
  for (const media of bodies) {
    collectPropertyNames(
      media.schema_ref === null ? undefined : lookup.resolve(media.schema_ref),
      lookup,
      names,
      seen,
      0
    );
  }
  for (const response of operation.responses) {
    for (const media of response.content) {
      collectPropertyNames(
        media.schema_ref === null
          ? undefined
          : lookup.resolve(media.schema_ref),
        lookup,
        names,
        seen,
        0
      );
    }
  }
  return names.join(" ");
}

function pathLiteralText(operation: OperationIR): string {
  const literals: string[] = [];
  for (const segment of operation.route_segments) {
    if (segment.kind === "literal") {
      literals.push(segment.value);
    }
  }
  if (literals.length === 0 && operation.path_template.includes("/")) {
    return operation.path_template;
  }
  return literals.join(" ");
}

/** Frozen descriptor of the algorithm version in force. */
export function searchAlgorithm(): SearchAlgorithmDescriptor {
  return Object.freeze({
    version: SEARCH_ALGORITHM_VERSION,
    tokenizer: Object.freeze({
      version: SEARCH_TOKENIZER_VERSION,
      normalization: Object.freeze(["nfkc", "lowercase"]),
      splits: Object.freeze([
        "camelCase",
        "snake_case",
        "kebab-case",
        "punctuation",
        "whitespace"
      ]),
      drops: Object.freeze(["path-parameter-braces", "stop-words"])
    }),
    stemming: "none",
    collation: "unicode-code-point",
    stopWordList: loadStopWordList(),
    fieldWeights: SEARCH_FIELD_WEIGHTS,
    scoreFactors: SEARCH_SCORE_FACTORS,
    limits: SEARCH_LIMITS,
    ordering: "score-descending-then-canonical-key-ascending"
  });
}

/** Deterministic lexical index over one contract. */
export class OperationSearchIndex {
  private readonly entries: readonly IndexedOperation[];
  readonly algorithm: SearchAlgorithmDescriptor;

  private constructor(
    entries: readonly IndexedOperation[],
    algorithm: SearchAlgorithmDescriptor
  ) {
    this.entries = entries;
    this.algorithm = algorithm;
  }

  static build(contract: ContractIR): OperationSearchIndex {
    const lookup = new SchemaLookup(contract.schemas);
    const entries = [...contract.operations]
      .sort((a, b) => compareCodePoints(a.key, b.key))
      .map((operation) => {
        const fields: IndexedField[] = [
          makeField(
            "operationId",
            operation.operation_id ?? operation.tool_name
          ),
          makeField("method", operation.method),
          makeField("pathLiteral", pathLiteralText(operation)),
          makeField("summary", operation.summary ?? ""),
          makeField("tag", operation.tags.join(" ")),
          makeField(
            "parameterName",
            operation.parameters.map((parameter) => parameter.name).join(" ")
          ),
          makeField("propertyName", propertyNamesText(operation, lookup)),
          makeField("description", operation.description ?? "")
        ];
        return {
          key: operation.key,
          uid: operation.uid,
          operationId: operation.operation_id,
          method: operation.method,
          pathTemplate: operation.path_template,
          summary: operation.summary,
          tags: [...operation.tags],
          support: operation.support.level,
          fields
        } satisfies IndexedOperation;
      });
    return new OperationSearchIndex(entries, searchAlgorithm());
  }

  get size(): number {
    return this.entries.length;
  }

  /** Run one search. Filters apply before the limit. */
  search(input: SearchOperationsInput): SearchOperationsResult {
    const limit = input.limit ?? DEFAULT_RESULT_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SEARCH_LIMITS.maxResults
    ) {
      throw invalidInput(
        "OAL-SEARCH-LIMIT-INVALID",
        "The search limit must be an integer from 1 to 100.",
        { limit }
      );
    }
    const methods =
      input.methods === undefined
        ? undefined
        : new Set(input.methods.map((method) => method.toUpperCase()));
    const tags = input.tags === undefined ? undefined : new Set(input.tags);
    const support =
      input.support === undefined ? undefined : new Set(input.support);

    const query = input.query;
    const tokens = queryTokens(query);
    const phrase = tokenize(query).slice(0, SEARCH_LIMITS.queryTokens);

    const scored: Array<{ entry: IndexedOperation; score: number }> = [];
    for (const entry of this.entries) {
      if (methods !== undefined && !methods.has(entry.method)) {
        continue;
      }
      if (tags !== undefined && !entry.tags.some((tag) => tags.has(tag))) {
        continue;
      }
      if (support !== undefined && !support.has(entry.support)) {
        continue;
      }
      const score = scoreEntry(entry, tokens, phrase);
      if (score > 0) {
        scored.push({ entry, score });
      }
    }
    scored.sort((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : compareCodePoints(a.entry.key, b.entry.key)
    );
    const limited = scored.length > limit;
    const results = scored
      .slice(0, limit)
      .map(({ entry, score }) => toRecord(entry, score));
    return {
      algorithm: this.algorithm,
      results,
      matchedCount: scored.length,
      limited
    };
  }
}

function toRecord(
  entry: IndexedOperation,
  score: number
): SearchOperationRecord {
  return {
    key: entry.key,
    uid: entry.uid,
    operationId: entry.operationId,
    method: entry.method,
    pathTemplate: entry.pathTemplate,
    summary: entry.summary,
    tags: [...entry.tags],
    support: entry.support,
    score
  };
}

/** Score one entry: exact token, token prefix, and exact phrase bonuses. */
function scoreEntry(
  entry: IndexedOperation,
  tokens: readonly string[],
  phrase: readonly string[]
): number {
  let score = 0;
  for (const field of entry.fields) {
    for (const token of tokens) {
      if (field.tokenSet.has(token)) {
        score += SEARCH_SCORE_FACTORS.exactToken * field.weight;
        continue;
      }
      if (hasTokenPrefix(field.tokenSet, token)) {
        score += SEARCH_SCORE_FACTORS.tokenPrefix * field.weight;
      }
    }
    if (containsSequence(field.tokens, phrase)) {
      score += SEARCH_SCORE_FACTORS.exactPhrase * field.weight;
    }
  }
  return score;
}

function hasTokenPrefix(tokens: ReadonlySet<string>, token: string): boolean {
  for (const candidate of tokens) {
    if (candidate.length > token.length && candidate.startsWith(token)) {
      return true;
    }
  }
  return false;
}

function containsSequence(
  tokens: readonly string[],
  phrase: readonly string[]
): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) {
    return false;
  }
  const last = tokens.length - phrase.length;
  for (let start = 0; start <= last; start += 1) {
    let matches = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if ((tokens[start + offset] as string) !== (phrase[offset] as string)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

/** Build an index and run one search in one step. */
export function searchOperations(
  contract: ContractIR,
  input: SearchOperationsInput
): SearchOperationsResult {
  return OperationSearchIndex.build(contract).search(input);
}
