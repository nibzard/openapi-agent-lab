/**
 * Session event emission (specification sections 21.2, 22.3, and 30).
 *
 * Every event that leaves an adapter passes through here. Text is bounded and
 * redacted before it is recorded, so no credential value reaches the sink.
 * The record shape follows schemas/agent-event.v1.schema.json.
 */

import { Buffer } from "node:buffer";

import { formatRfc3339, prefixedId24, sha256Hex } from "@oal/core";

import type {
  AgentEventSink,
  AgentSessionEvent,
  AgentStartedPayload,
  AgentStreamPayload,
  TextRedactor
} from "./types.ts";

/** Text replacement marker required by specification section 30.4. */
export const REDACTED_MARKER = "[REDACTED]";

/** Default bound on one preview in characters. */
export const DEFAULT_MAX_PREVIEW_CHARS = 2000;

/** Adapter identifiers must be lowercase and hyphen separated. */
const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Identifier grammar shared by every ID used in references. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Narrow an unknown value to a plain JSON object. */
function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Build a redactor from exact secret values. Every occurrence of a listed
 * value becomes one marker. Short values are skipped because replacing them
 * would corrupt ordinary text without protecting anything.
 */
export function createSecretRedactor(secrets: readonly string[]): TextRedactor {
  const targets = secrets
    .filter((value) => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  if (targets.length === 0) {
    return (text: string): string => text;
  }
  return (text: string): string => {
    let out = text;
    for (const secret of targets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED_MARKER);
      }
    }
    return out;
  };
}

/** Redactor that changes nothing. Used when no secrets are known. */
export const identityRedactor: TextRedactor = (text: string): string => text;

export interface SessionEventRecorderOptions {
  runId: string;
  adapter: string;
  sink: AgentEventSink;
  /** Redactor applied to text before it is recorded. */
  redact?: TextRedactor | undefined;
  /** Clock producing RFC 3339 timestamps. Defaults to wall time. */
  now?: (() => string) | undefined;
  /** Bound on one preview in characters. */
  maxPreviewChars?: number | undefined;
}

/**
 * Emits normalized session events in order. The recorder owns the sequence,
 * the event identifiers, the timestamp, and the redaction boundary.
 */
export class SessionEventRecorder {
  readonly runId: string;
  readonly adapter: string;
  private readonly sink: AgentEventSink;
  private readonly redact: TextRedactor;
  private readonly now: () => string;
  private readonly maxPreviewChars: number;
  private nextSequence = 1;

  constructor(options: SessionEventRecorderOptions) {
    if (!RUN_ID_PATTERN.test(options.runId)) {
      throw new Error(
        `runId is not a safe identifier: ${JSON.stringify(options.runId)}`
      );
    }
    if (!ADAPTER_ID_PATTERN.test(options.adapter)) {
      throw new Error(
        `adapter id must match ^[a-z][a-z0-9-]*$: ${JSON.stringify(options.adapter)}`
      );
    }
    this.runId = options.runId;
    this.adapter = options.adapter;
    this.sink = options.sink;
    this.redact = options.redact ?? options.sink.redact ?? identityRedactor;
    this.now = options.now ?? ((): string => formatRfc3339(Date.now()));
    this.maxPreviewChars = options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
  }

  /** Number of events emitted so far. */
  get emitted(): number {
    return this.nextSequence - 1;
  }

  /** Emit the `agent.started` record. */
  started(init: {
    model?: string | null | undefined;
    cliVersion?: string | null | undefined;
    effort?: string | null | undefined;
    sandbox?: string | null | undefined;
  }): void {
    const payload: AgentStartedPayload = {
      model: init.model ?? null,
      ...(init.cliVersion === undefined
        ? {}
        : { cli_version: init.cliVersion }),
      ...(init.effort === undefined ? {} : { effort: init.effort }),
      ...(init.sandbox === undefined ? {} : { sandbox: init.sandbox })
    };
    this.emit("agent.started", payload, {});
  }

  /**
   * Emit one captured text chunk as an `agent.session_event`. The preview is
   * redacted first and bounded second, so a truncated marker cannot expose a
   * partial secret.
   */
  text(
    channel: "stdout" | "stderr" | "jsonrpc",
    text: string,
    kind?: string
  ): void {
    const clean = this.redact(text);
    const bounded = clean.slice(0, this.maxPreviewChars);
    const payload: AgentStreamPayload = {
      channel,
      redacted: clean !== text,
      bytes: Buffer.byteLength(bounded, "utf8"),
      sha256: sha256Hex(bounded),
      ...(bounded === "" ? {} : { preview: bounded }),
      ...(kind === undefined ? {} : { kind })
    };
    this.emit("agent.session_event", payload, {});
  }

  /**
   * Emit an adapter-declared machine-readable fact. `detail` carries only
   * secret-free structured fields and lands in the event extensions.
   */
  adapterEvent(kind: string, detail?: Readonly<Record<string, unknown>>): void {
    const payload: AgentStreamPayload = {
      channel: "adapter",
      redacted: false,
      kind
    };
    this.emit("agent.session_event", payload, detail ?? {});
  }

  /** Emit the `agent.exited` record. */
  exited(init: {
    exitCode: number | null;
    signal: string | null;
    graceful: boolean;
  }): void {
    this.emit(
      "agent.exited",
      {
        exit_code: init.exitCode,
        signal: init.signal,
        graceful: init.graceful
      },
      {}
    );
  }

  private emit(
    type: AgentSessionEvent["type"],
    payload: AgentSessionEvent["payload"],
    extensions: Readonly<Record<string, unknown>>
  ): void {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const event: AgentSessionEvent = {
      schema_version: 1,
      type,
      event_id: prefixedId24("ag_", `${this.runId}:${sequence.toString(10)}`),
      sequence,
      observed_at: this.now(),
      run_id: this.runId,
      adapter: this.adapter,
      payload,
      extensions
    };
    this.sink.emit(event);
  }
}

/** Sink that collects events in memory. Used by tests and tools. */
export function collectingSink(): {
  events: AgentSessionEvent[];
  sink: AgentEventSink;
} {
  const events: AgentSessionEvent[] = [];
  return {
    events,
    sink: {
      emit(event: AgentSessionEvent): void {
        events.push(event);
      }
    }
  };
}

/**
 * Check one event against the published schema. The caller reads the schema
 * file, so the check follows the file rather than a copy of its rules.
 * Returns an empty list when the event conforms.
 */
export function validateAgentSessionEvent(
  event: unknown,
  schema: unknown
): string[] {
  const root = asJsonObject(schema);
  if (root === null) {
    return ["schema is not an object"];
  }
  const record = asJsonObject(event);
  if (record === null) {
    return ["event is not an object"];
  }
  const properties = asJsonObject(root.properties);
  if (properties === null) {
    return ["schema has no properties"];
  }
  const problems: string[] = [];
  for (const name of requiredNames(root)) {
    if (record[name] === undefined) {
      problems.push(`missing required field ${name}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (properties[key] === undefined) {
      problems.push(`unexpected field ${key}`);
    }
  }
  if (record.schema_version !== 1) {
    problems.push("schema_version must be 1");
  }
  const type = record.type;
  if (typeof type !== "string" || !enumValues(properties.type).includes(type)) {
    problems.push(`type ${JSON.stringify(type)} is not in the schema enum`);
  }
  problems.push(
    ...checkPattern(record.event_id, "event_id", properties.event_id),
    ...checkInteger(record.sequence, "sequence", properties.sequence),
    ...checkPattern(record.observed_at, "observed_at", properties.observed_at),
    ...checkPattern(record.run_id, "run_id", properties.run_id),
    ...checkPattern(record.adapter, "adapter", properties.adapter)
  );
  if (asJsonObject(record.extensions) === null) {
    problems.push("extensions must be an object");
  }
  problems.push(...checkPayload(record.payload, properties, root));
  return problems;
}

function checkPayload(
  payload: unknown,
  properties: Record<string, unknown>,
  root: Record<string, unknown>
): string[] {
  const branches = asJsonObject(properties.payload)?.oneOf;
  if (!Array.isArray(branches)) {
    return ["schema payload has no oneOf branches"];
  }
  const attempts: string[][] = [];
  for (const branch of branches) {
    const rule = asJsonObject(branch);
    if (rule !== null) {
      attempts.push(checkPayloadBranch(payload, rule, root));
    }
  }
  if (attempts.length === 0) {
    return ["schema payload has no usable branches"];
  }
  if (attempts.some((attempt) => attempt.length === 0)) {
    return [];
  }
  const detail = attempts.map((attempt) => attempt.join("; ")).join(" | ");
  return [`payload matches no schema branch: ${detail}`];
}

function checkPayloadBranch(
  payload: unknown,
  branch: Record<string, unknown>,
  root: Record<string, unknown>
): string[] {
  const record = asJsonObject(payload);
  if (record === null) {
    return ["payload is not an object"];
  }
  const properties = asJsonObject(branch.properties);
  const rules = properties ?? {};
  const problems: string[] = [];
  for (const name of requiredNames(branch)) {
    if (record[name] === undefined) {
      problems.push(`missing ${name}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (rules[key] === undefined) {
      problems.push(`unexpected ${key}`);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const rule = asJsonObject(rules[key]);
    if (rule === null) {
      continue;
    }
    const options = enumValues(rule);
    if (
      options.length > 0 &&
      (typeof value !== "string" || !options.includes(value))
    ) {
      problems.push(`${key} is not in the schema enum`);
    }
    const resolved = resolveRef(rule, root);
    problems.push(...checkAgainst(value, key, resolved ?? rule));
  }
  return problems;
}

function checkAgainst(
  value: unknown,
  field: string,
  rule: Record<string, unknown>
): string[] {
  const type = rule.type;
  if (type === undefined) {
    return [];
  }
  const allowed = Array.isArray(type) ? type : [type];
  const matches =
    (allowed.includes("string") && typeof value === "string") ||
    (allowed.includes("integer") && Number.isInteger(value)) ||
    (allowed.includes("boolean") && typeof value === "boolean") ||
    (allowed.includes("null") && value === null);
  if (matches) {
    const pattern = patternOf(rule);
    if (pattern !== null && typeof value === "string" && !pattern.test(value)) {
      return [`${field} does not match the schema pattern`];
    }
    const minimum = rule.minimum;
    if (
      typeof minimum === "number" &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      value < minimum
    ) {
      return [`${field} is below the schema minimum`];
    }
    return [];
  }
  return [`${field} must be of schema type ${allowed.join("|")}`];
}

function requiredNames(rule: Record<string, unknown>): string[] {
  const required = rule.required;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((name): name is string => typeof name === "string");
}

function enumValues(rule: unknown): string[] {
  const record = asJsonObject(rule);
  const options = record?.enum;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.filter((value): value is string => typeof value === "string");
}

/** Follow one `$ref` pointer inside the same document, when present. */
function resolveRef(
  rule: Record<string, unknown>,
  root: Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof rule.$ref !== "string" || !rule.$ref.startsWith("#/")) {
    return null;
  }
  const tokens = rule.$ref.slice(2).split("/");
  let target: unknown = root;
  for (const token of tokens) {
    const holder = asJsonObject(target);
    if (holder === null) {
      return null;
    }
    target = holder[token];
  }
  return asJsonObject(target);
}

function patternOf(rule: Record<string, unknown>): RegExp | null {
  if (typeof rule.pattern !== "string") {
    return null;
  }
  return new RegExp(`^(?:${rule.pattern})$`);
}

function checkPattern(value: unknown, field: string, rule: unknown): string[] {
  const resolved = asJsonObject(rule);
  if (resolved === null) {
    return [];
  }
  if (typeof value !== "string") {
    return [`${field} must be a string`];
  }
  const pattern = patternOf(resolved);
  if (pattern === null) {
    return [];
  }
  return pattern.test(value) ? [] : [`${field} does not match its pattern`];
}

function checkInteger(value: unknown, field: string, rule: unknown): string[] {
  const resolved = asJsonObject(rule);
  if (resolved === null) {
    return [];
  }
  if (!Number.isInteger(value)) {
    return [`${field} must be an integer`];
  }
  const minimum = resolved.minimum;
  if (
    typeof minimum === "number" &&
    typeof value === "number" &&
    value < minimum
  ) {
    return [`${field} is below the schema minimum`];
  }
  return [];
}
