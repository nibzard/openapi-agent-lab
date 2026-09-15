/**
 * Supported runtime-expression subset for Arazzo 1.1 workflows
 * (specification section 20.2).
 *
 * The subset accepts these whole-value expressions:
 *
 * - `$url`
 * - `$statusCode`
 * - `$response.body` and `$response.body#<json-pointer>`
 * - `$request.body` and `$request.body#<json-pointer>`
 * - `$inputs.<name>` with an optional pointer
 * - `$outputs.<stepId>.<name>` with an optional pointer
 * - `$steps.<stepId>.outputs.<name>` with an optional pointer
 *
 * `$outputs.<stepId>.<name>` is an alias of `$steps.<stepId>.outputs.<name>`;
 * both read one resolved step output. Every other Arazzo runtime-expression
 * source, for example `$method`, `$request.path`, `$response.headers`,
 * `$workflows`, `$sourceDescriptions`, `$components`, and `$self`, is outside
 * the subset and fails strict validation.
 *
 * Criteria accept comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), boolean
 * `&&`, `||`, and `!`, parentheses, JSON literals, and string interpolation
 * written `{$...}` either inside a quoted string or as one whole operand. A
 * template made of exactly one expression and no literal text evaluates to the
 * expression value itself, so `{$statusCode} == 201` compares two numbers.
 *
 * Evaluation is deterministic: no host globals, no clock, no randomness, no
 * filesystem, and no network. A missing value evaluates to `null`; a type
 * mismatch raises a typed error. Every function stays inside the caller's
 * length, depth, and step budgets.
 */

import {
  canonicalJson,
  jsonEquals,
  resolveJsonPointer,
  type Json,
  type JsonObject
} from "@oal/core";

import { ArazzoCode } from "./codes.ts";

/** Resource limits for one expression or criterion. */
export interface ArazzoExpressionLimits {
  /** Maximum source length in UTF-16 code units. */
  readonly maxSourceLength: number;
  /** Maximum nesting depth of the parsed tree. */
  readonly maxDepth: number;
  /** Maximum evaluation steps for one evaluation. */
  readonly maxSteps: number;
}

export const DEFAULT_EXPRESSION_LIMITS: ArazzoExpressionLimits = {
  maxSourceLength: 2048,
  maxDepth: 32,
  maxSteps: 10_000
};

/** Stable error codes raised while parsing or evaluating an expression. */
export type ArazzoExpressionErrorCode =
  | typeof ArazzoCode.ExpressionLength
  | typeof ArazzoCode.ExpressionDepth
  | typeof ArazzoCode.ExpressionInvalid
  | typeof ArazzoCode.ExpressionUnsupported
  | typeof ArazzoCode.ExpressionSteps;

/** Typed failure raised by parsing or evaluation. Never a silent null. */
export class ArazzoExpressionError extends Error {
  readonly code: ArazzoExpressionErrorCode;
  readonly expression: string;
  readonly offset: number | null;

  constructor(init: {
    code: ArazzoExpressionErrorCode;
    message: string;
    expression: string;
    offset?: number | null;
  }) {
    super(init.message);
    this.name = "ArazzoExpressionError";
    this.code = init.code;
    this.expression = init.expression;
    this.offset = init.offset ?? null;
  }
}

/** One resolved runtime-expression source. */
export type RuntimeSource =
  | { readonly kind: "url" }
  | { readonly kind: "status_code" }
  | { readonly kind: "response_body"; readonly pointer: string }
  | { readonly kind: "request_body"; readonly pointer: string }
  | { readonly kind: "input"; readonly name: string; readonly pointer: string }
  | {
      readonly kind: "step_output";
      readonly stepId: string;
      readonly name: string;
      readonly pointer: string;
    };

/** Comparison operators supported inside one criterion. */
export type CompareOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** One part of an interpolation template. */
export type TemplatePart =
  | { readonly literal: string }
  | { readonly expression: string; readonly source: RuntimeSource };

/** A value operand: a JSON literal, one runtime expression, or a template. */
export type OperandNode =
  | { readonly node: "literal"; readonly value: Json }
  | {
      readonly node: "runtime";
      readonly text: string;
      readonly source: RuntimeSource;
    }
  | { readonly node: "template"; readonly parts: readonly TemplatePart[] };

/** Parsed criterion tree. */
export type CriterionNode =
  | { readonly node: "value"; readonly operand: OperandNode }
  | { readonly node: "not"; readonly operand: CriterionNode }
  | {
      readonly node: "and";
      readonly left: CriterionNode;
      readonly right: CriterionNode;
    }
  | {
      readonly node: "or";
      readonly left: CriterionNode;
      readonly right: CriterionNode;
    }
  | {
      readonly node: "compare";
      readonly operator: CompareOperator;
      readonly left: OperandNode;
      readonly right: OperandNode;
    };

/** Frozen evaluation scope for one candidate event. */
export interface RuntimeContext {
  readonly url: string | null;
  readonly statusCode: number | null;
  readonly requestBody: Json | null;
  readonly responseBody: Json | null;
  readonly inputs: JsonObject;
  /** Step ID to its resolved outputs. */
  readonly stepOutputs: ReadonlyMap<string, JsonObject>;
}

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_POINTER_LENGTH = 512;
const COMPARISON_OPERATORS: readonly CompareOperator[] = [
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<"
];
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const EXPRESSION_BODY = /[A-Za-z0-9_.-]/;
const POINTER_TERMINATOR = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  ")",
  "}",
  '"',
  "'",
  "&",
  "|",
  "=",
  "!",
  "<",
  ">",
  ","
]);

/**
 * Parse one whole-value runtime expression. Throws
 * {@link ArazzoExpressionError} for any source outside the subset.
 */
export function parseRuntimeExpression(
  text: string,
  limits: ArazzoExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): RuntimeSource {
  if (text.length > limits.maxSourceLength) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionLength,
      message: "The runtime expression exceeds the length limit.",
      expression: text
    });
  }
  if (!text.startsWith("$")) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionInvalid,
      message: "A runtime expression must start with '$'.",
      expression: text
    });
  }
  const hash = text.indexOf("#");
  const head = hash === -1 ? text : text.slice(0, hash);
  const pointer = hash === -1 ? "" : text.slice(hash + 1);
  if (pointer.length > MAX_POINTER_LENGTH) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionLength,
      message: "The JSON pointer exceeds the length limit.",
      expression: text
    });
  }
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionInvalid,
      message: "A JSON pointer must start with '/'.",
      expression: text
    });
  }

  if (head === "$url") {
    return { kind: "url" };
  }
  if (head === "$statusCode") {
    return { kind: "status_code" };
  }
  if (head === "$response.body") {
    return { kind: "response_body", pointer };
  }
  if (head === "$request.body") {
    return { kind: "request_body", pointer };
  }
  const input = afterPrefix(head, "$inputs.");
  if (input !== null) {
    return { kind: "input", name: requireName(input, text), pointer };
  }
  const output = afterPrefix(head, "$outputs.");
  if (output !== null) {
    const separator = output.indexOf(".");
    if (separator === -1) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionInvalid,
        message: "A step output reference needs '<stepId>.<name>'.",
        expression: text
      });
    }
    const stepId = output.slice(0, separator);
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionInvalid,
        message: "A step reference needs a step ID before the output name.",
        expression: text
      });
    }
    return {
      kind: "step_output",
      stepId,
      name: requireName(output.slice(separator + 1), text),
      pointer
    };
  }
  const step = afterPrefix(head, "$steps.");
  if (step !== null) {
    const separator = step.indexOf(".");
    const stepId = separator === -1 ? "" : step.slice(0, separator);
    const tail = separator === -1 ? "" : step.slice(separator + 1);
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionInvalid,
        message: "A step reference needs a step ID before the output name.",
        expression: text
      });
    }
    const name = afterPrefix(tail, "outputs.");
    if (name === null) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionUnsupported,
        message:
          "Only '$steps.<stepId>.outputs.<name>' is supported for $steps.",
        expression: text
      });
    }
    return {
      kind: "step_output",
      stepId,
      name: requireName(name, text),
      pointer
    };
  }
  const segments = head.split(".");
  const source =
    segments.length > 1 ? `${segments[0]}.${segments[1]}` : (segments[0] ?? "");
  throw new ArazzoExpressionError({
    code: ArazzoCode.ExpressionUnsupported,
    message: `Runtime expression source '${source}' is outside the supported subset.`,
    expression: text
  });
}

/** Parse one criterion condition into a tree. */
export function parseCriterion(
  text: string,
  limits: ArazzoExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): CriterionNode {
  if (text.length > limits.maxSourceLength) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionLength,
      message: "The criterion exceeds the length limit.",
      expression: text
    });
  }
  const parser = new CriterionParser(text, limits);
  const node = parser.parseRoot();
  if (!parser.atEnd()) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionInvalid,
      message: "Unexpected content after the criterion.",
      expression: text,
      offset: parser.offset()
    });
  }
  return node;
}

/** True when a string holds at least one `{$...}` interpolation. */
export function isTemplateText(text: string): boolean {
  return text.includes("{$");
}

/**
 * Split one Arazzo expression string into literal and `{$...}` parts. Every
 * embedded expression must belong to the supported subset.
 */
export function parseTemplate(
  text: string,
  limits: ArazzoExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): TemplatePart[] {
  if (text.length > limits.maxSourceLength) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionLength,
      message: "The expression string exceeds the length limit.",
      expression: text
    });
  }
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "{" && text.charAt(i + 1) === "$") {
      if (literal !== "") {
        parts.push({ literal });
        literal = "";
      }
      const start = i + 1;
      let end = start;
      while (
        end < text.length &&
        text.charAt(end) !== "}" &&
        text.charAt(end) !== "\n"
      ) {
        end += 1;
      }
      if (text.charAt(end) !== "}") {
        throw new ArazzoExpressionError({
          code: ArazzoCode.ExpressionInvalid,
          message: "An interpolation is missing its closing brace.",
          expression: text,
          offset: i
        });
      }
      const expression = text.slice(start, end);
      parts.push({
        expression,
        source: parseRuntimeExpression(expression, limits)
      });
      i = end + 1;
      continue;
    }
    literal += text.charAt(i);
    i += 1;
  }
  if (literal !== "") {
    parts.push({ literal });
  }
  return parts;
}

/** Collect every runtime expression inside one criterion tree. */
export function collectRuntimeSources(node: CriterionNode): RuntimeSource[] {
  const found: RuntimeSource[] = [];
  visitCriterion(node, found);
  return found;
}

function visitCriterion(node: CriterionNode, found: RuntimeSource[]): void {
  switch (node.node) {
    case "value":
      visitOperand(node.operand, found);
      return;
    case "not":
      visitCriterion(node.operand, found);
      return;
    case "and":
    case "or":
      visitCriterion(node.left, found);
      visitCriterion(node.right, found);
      return;
    case "compare":
      visitOperand(node.left, found);
      visitOperand(node.right, found);
      return;
  }
}

function visitOperand(node: OperandNode, found: RuntimeSource[]): void {
  switch (node.node) {
    case "literal":
      return;
    case "runtime":
      found.push(node.source);
      return;
    case "template":
      for (const part of node.parts) {
        if ("source" in part) {
          found.push(part.source);
        }
      }
      return;
  }
}

/** Evaluate one runtime expression against a frozen scope. */
export function evaluateRuntimeSource(
  source: RuntimeSource,
  context: RuntimeContext
): Json {
  switch (source.kind) {
    case "url":
      return context.url;
    case "status_code":
      return context.statusCode;
    case "response_body":
      return pick(context.responseBody, source.pointer);
    case "request_body":
      return pick(context.requestBody, source.pointer);
    case "input": {
      const named = context.inputs[source.name];
      return pick(named === undefined ? null : named, source.pointer);
    }
    case "step_output": {
      const outputs = context.stepOutputs.get(source.stepId);
      if (outputs === undefined) {
        return null;
      }
      const named = outputs[source.name];
      return pick(named === undefined ? null : named, source.pointer);
    }
  }
}

/** Evaluation outcome for one criterion. */
export interface CriterionEvaluation {
  readonly passed: boolean;
  /** Typed failure message, or null when the criterion evaluated. */
  readonly error: string | null;
}

/** Evaluate one criterion. A typed failure counts as a failed criterion. */
export function evaluateCriterion(
  node: CriterionNode,
  context: RuntimeContext,
  limits: ArazzoExpressionLimits = DEFAULT_EXPRESSION_LIMITS
): CriterionEvaluation {
  try {
    return {
      passed: new Evaluator(context, limits).boolean(node),
      error: null
    };
  } catch (error) {
    if (error instanceof ArazzoExpressionError) {
      return { passed: false, error: error.message };
    }
    return { passed: false, error: "The criterion could not be evaluated." };
  }
}

/** Evaluate one operand to a JSON value. */
export function evaluateOperand(
  node: OperandNode,
  context: RuntimeContext
): Json {
  return new Evaluator(context, DEFAULT_EXPRESSION_LIMITS).value(node);
}

function pick(document: Json, pointer: string): Json {
  if (pointer === "") {
    return document;
  }
  const resolved = resolveJsonPointer(document, pointer);
  return resolved === undefined ? null : resolved;
}

function afterPrefix(text: string, prefix: string): string | null {
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

function requireName(name: string, text: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new ArazzoExpressionError({
      code: ArazzoCode.ExpressionInvalid,
      message: "A name in a runtime expression must not be empty.",
      expression: text
    });
  }
  return name;
}

/** Bounded evaluator over one frozen scope. */
class Evaluator {
  private steps = 0;

  private readonly context: RuntimeContext;
  private readonly limits: ArazzoExpressionLimits;

  constructor(context: RuntimeContext, limits: ArazzoExpressionLimits) {
    this.context = context;
    this.limits = limits;
  }

  private tick(): void {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionSteps,
        message: "The evaluation exceeded the step budget.",
        expression: ""
      });
    }
  }

  boolean(node: CriterionNode): boolean {
    this.tick();
    switch (node.node) {
      case "value": {
        const value = this.value(node.operand);
        if (typeof value !== "boolean") {
          throw new ArazzoExpressionError({
            code: ArazzoCode.ExpressionInvalid,
            message: "A bare criterion operand must be a boolean.",
            expression: ""
          });
        }
        return value;
      }
      case "not":
        return !this.boolean(node.operand);
      case "and":
        return this.boolean(node.left) && this.boolean(node.right);
      case "or":
        return this.boolean(node.left) || this.boolean(node.right);
      case "compare":
        return compare(
          node.operator,
          this.value(node.left),
          this.value(node.right)
        );
    }
  }

  value(node: OperandNode): Json {
    this.tick();
    switch (node.node) {
      case "literal":
        return node.value;
      case "runtime":
        return evaluateRuntimeSource(node.source, this.context);
      case "template": {
        const only = node.parts[0];
        if (node.parts.length === 1 && only !== undefined && "source" in only) {
          return evaluateRuntimeSource(only.source, this.context);
        }
        let out = "";
        for (const part of node.parts) {
          out +=
            "source" in part
              ? stringify(evaluateRuntimeSource(part.source, this.context))
              : part.literal;
        }
        return out;
      }
    }
  }
}

function compare(operator: CompareOperator, left: Json, right: Json): boolean {
  if (operator === "==") {
    return jsonEquals(left, right);
  }
  if (operator === "!=") {
    return !jsonEquals(left, right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return order(operator, left - right);
  }
  if (typeof left === "string" && typeof right === "string") {
    return order(operator, left < right ? -1 : left > right ? 1 : 0);
  }
  throw new ArazzoExpressionError({
    code: ArazzoCode.ExpressionInvalid,
    message:
      "Ordering comparisons need two numbers or two strings on either side.",
    expression: operator
  });
}

function order(operator: CompareOperator, sign: number): boolean {
  switch (operator) {
    case "<":
      return sign < 0;
    case "<=":
      return sign <= 0;
    case ">":
      return sign > 0;
    case ">=":
      return sign >= 0;
    default:
      return false;
  }
}

/** Arazzo interpolation converts scalars to text and structures to JSON. */
function stringify(value: Json): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return canonicalJson(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      return canonicalJson(value);
  }
}

/** Recursive-descent parser for one criterion condition. */
class CriterionParser {
  private pos = 0;
  private depth = 0;

  private readonly text: string;
  private readonly limits: ArazzoExpressionLimits;

  constructor(text: string, limits: ArazzoExpressionLimits) {
    this.text = text;
    this.limits = limits;
  }

  offset(): number {
    return this.pos;
  }

  atEnd(): boolean {
    this.skipSpaces();
    return this.pos >= this.text.length;
  }

  parseRoot(): CriterionNode {
    const node = this.parseDisjunction();
    this.skipSpaces();
    return node;
  }

  private parseDisjunction(): CriterionNode {
    this.enter();
    let left = this.parseConjunction();
    while (this.consumeSymbol("||")) {
      left = { node: "or", left, right: this.parseConjunction() };
    }
    this.leave();
    return left;
  }

  private parseConjunction(): CriterionNode {
    this.enter();
    let left = this.parseUnary();
    while (this.consumeSymbol("&&")) {
      left = { node: "and", left, right: this.parseUnary() };
    }
    this.leave();
    return left;
  }

  private parseUnary(): CriterionNode {
    this.enter();
    this.skipSpaces();
    if (this.peek() === "!" && this.peekAt(1) !== "=") {
      this.pos += 1;
      const operand = this.parseUnary();
      this.leave();
      return { node: "not", operand };
    }
    if (this.peek() === "(") {
      this.pos += 1;
      const inner = this.parseDisjunction();
      this.skipSpaces();
      if (this.peek() !== ")") {
        throw this.invalid("Expected ')' after a grouped criterion.");
      }
      this.pos += 1;
      this.leave();
      return inner;
    }
    const comparison = this.parseComparisonNode();
    this.leave();
    return comparison;
  }

  private parseComparisonNode(): CriterionNode {
    const left = this.parseOperand();
    this.skipSpaces();
    const operator = this.readComparisonOperator();
    if (operator === null) {
      return { node: "value", operand: left };
    }
    return { node: "compare", operator, left, right: this.parseOperand() };
  }

  private parseOperand(): OperandNode {
    this.enter();
    this.skipSpaces();
    if (this.pos >= this.text.length) {
      throw this.invalid("Expected a value operand.");
    }
    const ch = this.peek();
    let node: OperandNode;
    if (ch === '"' || ch === "'") {
      node = this.parseQuoted(ch);
    } else if (ch === "{") {
      node = this.parseBareTemplate();
    } else if (ch === "$") {
      node = this.parseRuntime();
    } else if (ch === "-" || isDigit(ch)) {
      node = this.parseNumber();
    } else {
      node = this.parseWord();
    }
    this.leave();
    return node;
  }

  private parseQuoted(quote: string): OperandNode {
    this.pos += 1;
    const parts = this.scanTemplate(quote, true);
    const first = parts[0];
    if (parts.length === 0) {
      return { node: "literal", value: "" };
    }
    if (parts.length === 1 && first !== undefined && "literal" in first) {
      return { node: "literal", value: first.literal };
    }
    return { node: "template", parts };
  }

  /**
   * Read one whole `{$...}` operand. The braces must hold exactly one
   * expression; literal text inside them is not part of the subset.
   */
  private parseBareTemplate(): OperandNode {
    if (this.peekAt(1) !== "$") {
      throw this.invalid("An interpolation operand must hold one expression.");
    }
    const start = this.pos + 1;
    this.pos += 1;
    this.skipExpression();
    if (this.text.charAt(this.pos - 1) !== "}") {
      throw this.invalid(
        "An interpolation operand is missing its closing brace."
      );
    }
    const expression = this.text.slice(start, this.pos - 1);
    return {
      node: "template",
      parts: [
        { expression, source: parseRuntimeExpression(expression, this.limits) }
      ]
    };
  }

  /**
   * Read template parts until the stop character. `allowEscapes` applies to
   * quoted strings, where `\"` and `\\` are escapes.
   */
  private scanTemplate(stop: string, allowEscapes: boolean): TemplatePart[] {
    const parts: TemplatePart[] = [];
    let literal = "";
    while (this.pos < this.text.length) {
      const ch = this.peek();
      if (ch === stop) {
        this.pos += 1;
        if (literal !== "") {
          parts.push({ literal });
        }
        return parts;
      }
      if (allowEscapes && ch === "\\") {
        const escape = this.peekAt(1);
        const mapped = escape === "n" ? "\n" : escape === "t" ? "\t" : escape;
        if (mapped === "") {
          throw this.invalid("Unterminated escape in a string literal.");
        }
        literal += mapped;
        this.pos += 2;
        continue;
      }
      if (ch === "{" && this.peekAt(1) === "$") {
        if (literal !== "") {
          parts.push({ literal });
          literal = "";
        }
        this.pos += 1;
        const start = this.pos;
        this.skipExpression();
        if (this.text.charAt(this.pos - 1) !== "}") {
          throw this.invalid("An interpolation is missing its closing brace.");
        }
        const expression = this.text.slice(start, this.pos - 1);
        parts.push({
          expression,
          source: parseRuntimeExpression(expression, this.limits)
        });
        continue;
      }
      if (ch === "\n") {
        throw this.invalid("A string literal must stay on one line.");
      }
      literal += ch;
      this.pos += 1;
    }
    throw this.invalid(
      stop === "}"
        ? "An interpolation operand is missing its closing brace."
        : "A string literal is missing its closing quote."
    );
  }

  /** Advance past one `$...` expression, including its closing brace. */
  private skipExpression(): void {
    while (this.pos < this.text.length) {
      const ch = this.peek();
      if (ch === "}") {
        this.pos += 1;
        return;
      }
      if (ch === "\n") {
        return;
      }
      this.pos += 1;
    }
  }

  private parseRuntime(): OperandNode {
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.text.length && EXPRESSION_BODY.test(this.peek())) {
      this.pos += 1;
    }
    if (this.peek() === "#") {
      this.pos += 1;
      while (this.pos < this.text.length) {
        const ch = this.peek();
        if (POINTER_TERMINATOR.has(ch)) {
          break;
        }
        this.pos += 1;
      }
    }
    const text = this.text.slice(start, this.pos);
    return {
      node: "runtime",
      text,
      source: parseRuntimeExpression(text, this.limits)
    };
  }

  private parseNumber(): OperandNode {
    const start = this.pos;
    while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.peek())) {
      this.pos += 1;
    }
    const text = this.text.slice(start, this.pos);
    if (!NUMBER_PATTERN.test(text)) {
      throw this.invalid(`'${text}' is not a supported number literal.`);
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw this.invalid(`'${text}' is not a finite number.`);
    }
    return { node: "literal", value };
  }

  private parseWord(): OperandNode {
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.peek())) {
      this.pos += 1;
    }
    const text = this.text.slice(start, this.pos);
    if (text === "true") {
      return { node: "literal", value: true };
    }
    if (text === "false") {
      return { node: "literal", value: false };
    }
    if (text === "null") {
      return { node: "literal", value: null };
    }
    throw this.invalid(
      text === ""
        ? `Unexpected character '${this.peek()}' in a criterion.`
        : `Identifiers are not supported in a criterion: '${text}'.`
    );
  }

  private readComparisonOperator(): CompareOperator | null {
    for (const operator of COMPARISON_OPERATORS) {
      if (this.text.startsWith(operator, this.pos)) {
        this.pos += operator.length;
        return operator;
      }
    }
    return null;
  }

  private consumeSymbol(symbol: string): boolean {
    this.skipSpaces();
    if (this.text.startsWith(symbol, this.pos)) {
      this.pos += symbol.length;
      return true;
    }
    return false;
  }

  private skipSpaces(): void {
    while (this.pos < this.text.length) {
      const ch = this.peek();
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
        return;
      }
      this.pos += 1;
    }
  }

  private peek(): string {
    return this.text.charAt(this.pos);
  }

  private peekAt(offset: number): string {
    return this.text.charAt(this.pos + offset);
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > this.limits.maxDepth) {
      throw new ArazzoExpressionError({
        code: ArazzoCode.ExpressionDepth,
        message: "The criterion exceeds the nesting depth limit.",
        expression: this.text,
        offset: this.pos
      });
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private invalid(message: string): ArazzoExpressionError {
    return new ArazzoExpressionError({
      code: ArazzoCode.ExpressionInvalid,
      message,
      expression: this.text,
      offset: this.pos
    });
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
