/**
 * Restricted expression engine for rubric predicates and captures
 * (specification section 26.1).
 *
 * The engine tokenizes a CEL-like subset, parses it with a recursive
 * descent parser, and evaluates it over frozen JSON evidence. It offers
 * no functions, no assignment, no macros, no imports, no reflection,
 * and no host globals. Time, randomness, filesystem, network, and
 * process state stay unreachable because no such value exists in the
 * scope an evaluator supplies.
 *
 * A missing property, a missing variable, an index outside a range, and
 * a member selected from a non-object all evaluate to null. Type errors
 * and resource limits raise a typed ExpressionError. The engine never
 * throws another error type and never mutates the scope.
 */

import {
  isJsonObject,
  jsonEquals,
  type Json,
  type JsonObject
} from "@oal/core";

/** Resource limits for one expression (specification section 26.7). */
export interface ExpressionLimits {
  /** Maximum source length in UTF-16 code units. */
  maxSourceLength: number;
  /** Maximum nesting depth of the parsed tree. */
  maxDepth: number;
  /** Maximum evaluation steps for one evaluation. */
  maxSteps: number;
}

export const DEFAULT_EXPRESSION_LIMITS: ExpressionLimits = {
  maxSourceLength: 4096,
  maxDepth: 64,
  maxSteps: 200000
};

/** Stable error codes for the expression engine. */
export type ExpressionErrorCode =
  | "OAL-EXPRESSION-LENGTH"
  | "OAL-EXPRESSION-DEPTH"
  | "OAL-EXPRESSION-SYNTAX"
  | "OAL-EXPRESSION-FORBIDDEN"
  | "OAL-EXPRESSION-TYPE"
  | "OAL-EXPRESSION-DIVISION"
  | "OAL-EXPRESSION-STEPS"
  | "OAL-EXPRESSION-NOT-BOOLEAN";

/**
 * Typed failure raised by parsing or evaluation. Callers classify it as
 * an evaluator infrastructure outcome, never as a task failure.
 */
export class ExpressionError extends Error {
  readonly code: ExpressionErrorCode;
  readonly expression: string;
  readonly offset: number | null;

  constructor(init: {
    code: ExpressionErrorCode;
    message: string;
    expression: string;
    offset?: number | null | undefined;
  }) {
    super(init.message);
    this.name = "ExpressionError";
    this.code = init.code;
    this.expression = init.expression;
    this.offset = init.offset ?? null;
  }
}

/** Binary operators in the supported subset. */
export type BinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "in";

export type ExpressionNode =
  | { node: "literal"; value: Json }
  | { node: "identifier"; name: string }
  | { node: "list"; items: ExpressionNode[] }
  | { node: "member"; target: ExpressionNode; property: string }
  | { node: "index"; target: ExpressionNode; index: ExpressionNode }
  | { node: "unary"; operator: "!" | "-"; operand: ExpressionNode }
  | {
      node: "binary";
      operator: BinaryOperator;
      left: ExpressionNode;
      right: ExpressionNode;
    };

type Token =
  | { kind: "number"; text: string; offset: number; value: number }
  | { kind: "string"; text: string; offset: number; value: string }
  | { kind: "identifier"; text: string; offset: number }
  | { kind: "operator"; text: string; offset: number };

/**
 * Root identifiers that never name a scope variable. Naming one of
 * these is an attempt to reach host state and is rejected at parse
 * time, before any evaluation starts.
 */
const FORBIDDEN_ROOTS: ReadonlySet<string> = new Set([
  "process",
  "globalThis",
  "global",
  "window",
  "self",
  "document",
  "Date",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Error",
  "Function",
  "Promise",
  "eval",
  "require",
  "import",
  "module",
  "exports",
  "console",
  "fetch",
  "Buffer",
  "crypto",
  "fs",
  "os",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "this",
  "super",
  "new",
  "delete",
  "typeof",
  "void",
  "class",
  "function",
  "yield",
  "await"
]);

const LITERALS: Readonly<Record<string, Json>> = {
  true: true,
  false: false,
  null: null
};

const TWO_CHARACTER_OPERATORS: readonly string[] = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">="
];

const ONE_CHARACTER_OPERATORS: readonly string[] = [
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "(",
  ")",
  "[",
  "]",
  ".",
  ","
];

const RELATIONAL_OPERATORS: readonly ("<" | "<=" | ">" | ">=")[] = [
  "<",
  "<=",
  ">",
  ">="
];
const NUMBER_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

const PREVIEW_LIMIT = 96;

function preview(source: string): string {
  return source.length <= PREVIEW_LIMIT
    ? source
    : `${source.slice(0, PREVIEW_LIMIT)}...`;
}

function fail(
  code: ExpressionErrorCode,
  message: string,
  source: string,
  offset?: number | null
): never {
  throw new ExpressionError({
    code,
    message: `${message} In ${JSON.stringify(preview(source))}.`,
    expression: source,
    offset
  });
}

/** Human-readable JSON type name used in type error messages. */
export function jsonTypeName(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const current = source[position];
    if (current === undefined) {
      break;
    }
    if (
      current === " " ||
      current === "\t" ||
      current === "\n" ||
      current === "\r"
    ) {
      position += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      const scanned = scanString(source, position);
      tokens.push({
        kind: "string",
        text: source.slice(position, scanned.next),
        offset: position,
        value: scanned.value
      });
      position = scanned.next;
      continue;
    }
    if (current >= "0" && current <= "9") {
      const match = NUMBER_PATTERN.exec(source.slice(position));
      const text = match === null ? "" : match[0];
      if (text.length === 0) {
        fail(
          "OAL-EXPRESSION-SYNTAX",
          "Invalid number literal.",
          source,
          position
        );
      }
      const value = Number(text);
      if (!Number.isFinite(value)) {
        fail(
          "OAL-EXPRESSION-SYNTAX",
          "Number literal is too large.",
          source,
          position
        );
      }
      tokens.push({ kind: "number", text, offset: position, value });
      position += text.length;
      continue;
    }
    const identifier = IDENTIFIER_PATTERN.exec(source.slice(position));
    if (identifier !== null && identifier[0].length > 0) {
      tokens.push({
        kind: "identifier",
        text: identifier[0],
        offset: position
      });
      position += identifier[0].length;
      continue;
    }
    const twoCharacter = source.slice(position, position + 2);
    if (TWO_CHARACTER_OPERATORS.includes(twoCharacter)) {
      tokens.push({ kind: "operator", text: twoCharacter, offset: position });
      position += 2;
      continue;
    }
    if (ONE_CHARACTER_OPERATORS.includes(current)) {
      tokens.push({ kind: "operator", text: current, offset: position });
      position += 1;
      continue;
    }
    fail(
      "OAL-EXPRESSION-SYNTAX",
      `Unexpected character ${JSON.stringify(current)}.`,
      source,
      position
    );
  }
  return tokens;
}

function scanString(
  source: string,
  start: number
): { value: string; next: number } {
  const quote = source[start];
  let position = start + 1;
  let value = "";
  while (position < source.length) {
    const current = source[position];
    if (current === undefined) {
      break;
    }
    if (current === quote) {
      return { value, next: position + 1 };
    }
    if (current === "\n" || current === "\r") {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        "String literals may not contain a raw line break.",
        source,
        position
      );
    }
    if (current !== "\\") {
      value += current;
      position += 1;
      continue;
    }
    const escaped = source[position + 1];
    if (escaped === undefined) {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        "Unterminated escape sequence.",
        source,
        position
      );
    }
    if (escaped === "u") {
      const digits = source.slice(position + 2, position + 6);
      if (digits.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) {
        fail(
          "OAL-EXPRESSION-SYNTAX",
          "A unicode escape needs four hexadecimal digits.",
          source,
          position
        );
      }
      value += String.fromCharCode(Number.parseInt(digits, 16));
      position += 6;
      continue;
    }
    const mapped = STRING_ESCAPES[escaped];
    if (mapped === undefined) {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        `Unknown escape sequence ${JSON.stringify(`\\${escaped}`)}.`,
        source,
        position
      );
    }
    value += mapped;
    position += 2;
  }
  fail("OAL-EXPRESSION-SYNTAX", "Unterminated string literal.", source, start);
}

/** Recursive descent parser over the token stream. */
class Parser {
  private readonly tokens: readonly Token[];
  private readonly source: string;
  private readonly limits: ExpressionLimits;
  private readonly roots: string[] = [];
  private readonly members: string[] = [];
  private position = 0;
  private depth = 0;

  constructor(source: string, limits: ExpressionLimits) {
    this.source = source;
    this.limits = limits;
    this.tokens = tokenize(source);
  }

  parse(): ExpressionNode {
    if (this.tokens.length === 0) {
      fail("OAL-EXPRESSION-SYNTAX", "Expression is empty.", this.source, 0);
    }
    const ast = this.parseOr();
    const trailing = this.peek();
    if (trailing !== undefined) {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        `Unexpected ${describeToken(trailing)} after a complete expression.`,
        this.source,
        trailing.offset
      );
    }
    return ast;
  }

  /** Root identifiers in source order, deduplicated and sorted. */
  rootIdentifiers(): readonly string[] {
    return [...new Set(this.roots)].sort();
  }

  /**
   * Property names the expression reads through `.name` or
   * `["name"]` access, deduplicated and sorted. Rubric loading uses
   * the list to keep scope-only fields out of persisted captures.
   */
  memberProperties(): readonly string[] {
    return [...new Set(this.members)].sort();
  }

  private parseOr(): ExpressionNode {
    this.depth += 1;
    if (this.depth > this.limits.maxDepth) {
      fail(
        "OAL-EXPRESSION-DEPTH",
        `Expression nests deeper than ${this.limits.maxDepth} levels.`,
        this.source,
        null
      );
    }
    try {
      let left = this.parseAnd();
      for (;;) {
        if (!this.atOperator("||")) {
          return left;
        }
        this.advance();
        left = {
          node: "binary",
          operator: "||",
          left,
          right: this.parseAnd()
        };
      }
    } finally {
      this.depth -= 1;
    }
  }

  private parseAnd(): ExpressionNode {
    let left = this.parseEquality();
    for (;;) {
      if (!this.atOperator("&&")) {
        return left;
      }
      this.advance();
      left = {
        node: "binary",
        operator: "&&",
        left,
        right: this.parseEquality()
      };
    }
  }

  private parseEquality(): ExpressionNode {
    let left = this.parseRelational();
    for (;;) {
      const operator = this.peekOperatorText();
      if (operator !== "==" && operator !== "!=") {
        return left;
      }
      this.advance();
      left = {
        node: "binary",
        operator,
        left,
        right: this.parseRelational()
      };
    }
  }

  private parseRelational(): ExpressionNode {
    let left = this.parseAdditive();
    for (;;) {
      const next = this.peek();
      if (next === undefined) {
        return left;
      }
      const operator = relationalOperatorOf(next);
      if (operator === null) {
        return left;
      }
      this.advance();
      left = {
        node: "binary",
        operator,
        left,
        right: this.parseAdditive()
      };
    }
  }

  private parseAdditive(): ExpressionNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const operator = this.peekOperatorText();
      if (operator !== "+" && operator !== "-") {
        return left;
      }
      this.advance();
      left = {
        node: "binary",
        operator,
        left,
        right: this.parseMultiplicative()
      };
    }
  }

  private parseMultiplicative(): ExpressionNode {
    let left = this.parseUnary();
    for (;;) {
      const operator = this.peekOperatorText();
      if (operator !== "*" && operator !== "/") {
        return left;
      }
      this.advance();
      left = {
        node: "binary",
        operator,
        left,
        right: this.parseUnary()
      };
    }
  }

  private parseUnary(): ExpressionNode {
    const operator = this.peekOperatorText();
    if (operator === "!" || operator === "-") {
      this.advance();
      return { node: "unary", operator, operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExpressionNode {
    let target = this.parsePrimary();
    for (;;) {
      if (this.atOperator(".")) {
        this.advance();
        const property = this.expectIdentifier('a property name after "."');
        target = { node: "member", target, property };
        this.members.push(property);
        continue;
      }
      if (this.atOperator("[")) {
        this.advance();
        const index = this.parseOr();
        this.expectOperator("]");
        target = { node: "index", target, index };
        if (
          index.node === "literal" &&
          typeof index.value === "string" &&
          index.value.length > 0
        ) {
          this.members.push(index.value);
        }
        continue;
      }
      return target;
    }
  }

  private parsePrimary(): ExpressionNode {
    const token = this.peek();
    if (token === undefined) {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        "Expression ends early.",
        this.source,
        null
      );
    }
    switch (token.kind) {
      case "number":
      case "string": {
        this.advance();
        return { node: "literal", value: token.value };
      }
      case "operator": {
        if (token.text !== "(" && token.text !== "[") {
          fail(
            "OAL-EXPRESSION-SYNTAX",
            `Unexpected ${describeToken(token)}.`,
            this.source,
            token.offset
          );
        }
        if (token.text === "(") {
          this.advance();
          const inner = this.parseOr();
          this.expectOperator(")");
          return inner;
        }
        this.advance();
        const items: ExpressionNode[] = [];
        if (!this.atOperator("]")) {
          items.push(this.parseOr());
          while (this.atOperator(",")) {
            this.advance();
            items.push(this.parseOr());
          }
        }
        this.expectOperator("]");
        return { node: "list", items };
      }
      case "identifier": {
        this.advance();
        const literal = LITERALS[token.text];
        if (literal !== undefined) {
          return { node: "literal", value: literal };
        }
        if (FORBIDDEN_ROOTS.has(token.text)) {
          fail(
            "OAL-EXPRESSION-FORBIDDEN",
            `${JSON.stringify(token.text)} is not a rubric variable.`,
            this.source,
            token.offset
          );
        }
        this.roots.push(token.text);
        return { node: "identifier", name: token.text };
      }
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private peekOperatorText(): string | null {
    const token = this.peek();
    if (token === undefined || token.kind !== "operator") {
      return null;
    }
    return token.text;
  }

  private atOperator(text: string): boolean {
    return this.peekOperatorText() === text;
  }

  private advance(): void {
    const token = this.peek();
    if (token !== undefined) {
      this.position += 1;
    }
  }

  private expectOperator(text: string): void {
    if (!this.atOperator(text)) {
      const token = this.peek();
      fail(
        "OAL-EXPRESSION-SYNTAX",
        `Expected ${JSON.stringify(text)} but found ${
          token === undefined ? "end of expression" : describeToken(token)
        }.`,
        this.source,
        token === undefined ? null : token.offset
      );
    }
    this.advance();
  }

  private expectIdentifier(what: string): string {
    const token = this.peek();
    if (token === undefined || token.kind !== "identifier") {
      fail(
        "OAL-EXPRESSION-SYNTAX",
        `Expected ${what} but found ${
          token === undefined ? "end of expression" : describeToken(token)
        }.`,
        this.source,
        token === undefined ? null : token.offset
      );
    }
    this.advance();
    return token.text;
  }
}

function describeToken(token: Token): string {
  return `${JSON.stringify(token.text)} (${token.kind})`;
}

/** Map one token to a relation operator, or null when it is none. */
function relationalOperatorOf(token: Token): BinaryOperator | null {
  if (token.kind === "identifier" && token.text === "in") {
    return "in";
  }
  if (token.kind !== "operator") {
    return null;
  }
  for (const candidate of RELATIONAL_OPERATORS) {
    if (candidate === token.text) {
      return candidate;
    }
  }
  return null;
}

/** Mutable step budget shared by one evaluation. */
interface StepBudget {
  remaining: number;
}

function spend(budget: StepBudget, source: string): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    fail(
      "OAL-EXPRESSION-STEPS",
      "Evaluation exceeded the step limit.",
      source,
      null
    );
  }
}

function requireBoolean(
  value: Json,
  operator: string,
  source: string
): boolean {
  if (typeof value !== "boolean") {
    fail(
      "OAL-EXPRESSION-TYPE",
      `Operator ${JSON.stringify(operator)} needs a boolean but received ${jsonTypeName(value)}.`,
      source,
      null
    );
  }
  return value;
}

function requireNumber(value: Json, operator: string, source: string): number {
  if (typeof value !== "number") {
    fail(
      "OAL-EXPRESSION-TYPE",
      `Operator ${JSON.stringify(operator)} needs a number but received ${jsonTypeName(value)}.`,
      source,
      null
    );
  }
  return value;
}

function finiteNumber(value: number, operator: string, source: string): number {
  if (!Number.isFinite(value)) {
    fail(
      "OAL-EXPRESSION-TYPE",
      `Operator ${JSON.stringify(operator)} produced a non-finite number.`,
      source,
      null
    );
  }
  return value;
}

function evaluateNode(
  node: ExpressionNode,
  scope: JsonObject,
  budget: StepBudget,
  source: string
): Json {
  spend(budget, source);
  switch (node.node) {
    case "literal":
      return node.value;
    case "identifier":
      return Object.hasOwn(scope, node.name)
        ? (scope[node.name] ?? null)
        : null;
    case "list": {
      const items: Json[] = [];
      for (const item of node.items) {
        items.push(evaluateNode(item, scope, budget, source));
      }
      return items;
    }
    case "member": {
      const target = evaluateNode(node.target, scope, budget, source);
      if (isJsonObject(target) && Object.hasOwn(target, node.property)) {
        return target[node.property] ?? null;
      }
      return null;
    }
    case "index": {
      const target = evaluateNode(node.target, scope, budget, source);
      const index = evaluateNode(node.index, scope, budget, source);
      if (Array.isArray(target)) {
        if (typeof index !== "number" || !Number.isInteger(index)) {
          return null;
        }
        if (index < 0 || index >= target.length) {
          return null;
        }
        return target[index] ?? null;
      }
      if (isJsonObject(target) && typeof index === "string") {
        return Object.hasOwn(target, index) ? (target[index] ?? null) : null;
      }
      return null;
    }
    case "unary": {
      const operand = evaluateNode(node.operand, scope, budget, source);
      if (node.operator === "!") {
        return !requireBoolean(operand, "!", source);
      }
      return finiteNumber(-requireNumber(operand, "-", source), "-", source);
    }
    case "binary": {
      return evaluateBinary(node, scope, budget, source);
    }
  }
}

function evaluateBinary(
  node: Extract<ExpressionNode, { node: "binary" }>,
  scope: JsonObject,
  budget: StepBudget,
  source: string
): Json {
  const operator = node.operator;
  if (operator === "&&" || operator === "||") {
    return evaluateLogical(node, scope, budget, source);
  }
  const left = evaluateNode(node.left, scope, budget, source);
  const right = evaluateNode(node.right, scope, budget, source);
  switch (operator) {
    case "==":
      return jsonEquals(left, right);
    case "!=":
      return !jsonEquals(left, right);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (typeof left === "number" && typeof right === "number") {
        return compareNumbers(operator, left, right);
      }
      if (typeof left === "string" && typeof right === "string") {
        return compareStrings(operator, left, right);
      }
      return fail(
        "OAL-EXPRESSION-TYPE",
        `Operator ${JSON.stringify(operator)} needs two numbers or two strings but received ${jsonTypeName(left)} and ${jsonTypeName(right)}.`,
        source,
        null
      );
    }
    case "in": {
      if (Array.isArray(right)) {
        return right.some((item) => jsonEquals(item, left));
      }
      if (isJsonObject(right)) {
        return typeof left === "string" && Object.hasOwn(right, left);
      }
      return fail(
        "OAL-EXPRESSION-TYPE",
        `Operator "in" needs an array or object on the right but received ${jsonTypeName(right)}.`,
        source,
        null
      );
    }
    case "+": {
      if (typeof left === "number" && typeof right === "number") {
        return finiteNumber(left + right, "+", source);
      }
      if (typeof left === "string" && typeof right === "string") {
        return left + right;
      }
      return fail(
        "OAL-EXPRESSION-TYPE",
        `Operator "+" needs two numbers or two strings but received ${jsonTypeName(left)} and ${jsonTypeName(right)}.`,
        source,
        null
      );
    }
    case "-":
    case "*": {
      const leftNumber = requireNumber(left, operator, source);
      const rightNumber = requireNumber(right, operator, source);
      return finiteNumber(
        operator === "-" ? leftNumber - rightNumber : leftNumber * rightNumber,
        operator,
        source
      );
    }
    case "/": {
      const leftNumber = requireNumber(left, "/", source);
      const rightNumber = requireNumber(right, "/", source);
      if (rightNumber === 0) {
        fail("OAL-EXPRESSION-DIVISION", "Division by zero.", source, null);
      }
      return finiteNumber(leftNumber / rightNumber, "/", source);
    }
  }
}

/** Logical operators short-circuit and need boolean operands. */
function evaluateLogical(
  node: Extract<ExpressionNode, { node: "binary" }>,
  scope: JsonObject,
  budget: StepBudget,
  source: string
): Json {
  const operator = node.operator;
  const left = requireBoolean(
    evaluateNode(node.left, scope, budget, source),
    operator,
    source
  );
  if (left !== (operator === "&&")) {
    return left;
  }
  return requireBoolean(
    evaluateNode(node.right, scope, budget, source),
    operator,
    source
  );
}

function compareNumbers(
  operator: string,
  left: number,
  right: number
): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

function compareStrings(
  operator: string,
  left: string,
  right: string
): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

/** A parsed expression with its root identifiers and evaluation limits. */
export interface CompiledExpression {
  readonly source: string;
  readonly rootIdentifiers: readonly string[];
  /** Property names read through member or string-index access. */
  readonly memberProperties: readonly string[];
  evaluate(scope: JsonObject): Json;
  evaluatePredicate(scope: JsonObject): boolean;
}

function makeCompiled(
  source: string,
  ast: ExpressionNode,
  roots: readonly string[],
  members: readonly string[],
  limits: ExpressionLimits
): CompiledExpression {
  return {
    source,
    rootIdentifiers: roots,
    memberProperties: members,
    evaluate(scope: JsonObject): Json {
      return evaluateNode(ast, scope, { remaining: limits.maxSteps }, source);
    },
    evaluatePredicate(scope: JsonObject): boolean {
      const value = evaluateNode(
        ast,
        scope,
        { remaining: limits.maxSteps },
        source
      );
      if (typeof value !== "boolean") {
        fail(
          "OAL-EXPRESSION-NOT-BOOLEAN",
          `Predicate must return a boolean but returned ${jsonTypeName(value)}.`,
          source,
          null
        );
      }
      return value;
    }
  };
}

/** Parse one expression and return its tree. */
export function parseExpression(
  source: string,
  limits: ExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): ExpressionNode {
  if (source.length > limits.maxSourceLength) {
    fail(
      "OAL-EXPRESSION-LENGTH",
      `Expression is longer than ${limits.maxSourceLength} characters.`,
      source,
      null
    );
  }
  return new Parser(source, limits).parse();
}

/** Parse once, then evaluate many times against different scopes. */
export function compileExpression(
  source: string,
  limits: ExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): CompiledExpression {
  if (source.length > limits.maxSourceLength) {
    fail(
      "OAL-EXPRESSION-LENGTH",
      `Expression is longer than ${limits.maxSourceLength} characters.`,
      source,
      null
    );
  }
  const parser = new Parser(source, limits);
  return makeCompiled(
    source,
    parser.parse(),
    parser.rootIdentifiers(),
    parser.memberProperties(),
    limits
  );
}

/** Parse and evaluate one expression in a single step. */
export function evaluateExpression(
  source: string,
  scope: JsonObject,
  limits: ExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): Json {
  return compileExpression(source, limits).evaluate(scope);
}

/** Parse and evaluate one expression, then require a boolean result. */
export function evaluatePredicate(
  source: string,
  scope: JsonObject,
  limits: ExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): boolean {
  return compileExpression(source, limits).evaluatePredicate(scope);
}
