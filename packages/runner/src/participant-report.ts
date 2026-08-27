/**
 * Structured final output (specification section 19.5). The result source
 * is exactly one of adapter_final or workspace_file; there is no implicit
 * fallback between them. A missing, invalid, or schema-invalid output is
 * task evidence, never an infrastructure failure.
 */

import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

import {
  canonicalJson,
  invalidInput,
  isWithin,
  parseJsonStrict,
  SchemaValidator,
  sha256Hex,
  type Json,
  type JsonObject
} from "@oal/core";
import { Redactor } from "@oal/evidence";

/** Stable codes of the report module. Each one is task evidence. */
export const ReportCode = {
  SourceUnknown: "OAL-RUN-REPORT-SOURCE-UNKNOWN",
  Missing: "OAL-RUN-REPORT-MISSING",
  PathUnsafe: "OAL-RUN-REPORT-PATH-UNSAFE",
  Symlink: "OAL-RUN-REPORT-SYMLINK",
  NotRegular: "OAL-RUN-REPORT-NOT-REGULAR-FILE",
  TooLarge: "OAL-RUN-REPORT-TOO-LARGE",
  Mutated: "OAL-RUN-REPORT-MUTATED-AFTER-EXIT",
  JsonInvalid: "OAL-RUN-REPORT-JSON-INVALID",
  DuplicateKey: "OAL-RUN-REPORT-DUPLICATE-KEY",
  SchemaInvalid: "OAL-RUN-REPORT-SCHEMA-INVALID",
  WriteFailed: "OAL-RUN-REPORT-WRITE-FAILED"
} as const;

export type ResultSourceKind = "adapter_final" | "workspace_file";

/** The adapter's declared final message channel. */
export interface AdapterFinalSource {
  readonly source: "adapter_final";
  readonly text: string;
}

/** One safe relative filename read after the agent exits. */
export interface WorkspaceFileSource {
  readonly source: "workspace_file";
  readonly workspaceDir: string;
  readonly filename: string;
  /** Agent exit time in epoch milliseconds, when the runner knows it. */
  readonly exitedAtMs: number | null;
}

export type ResultSource = AdapterFinalSource | WorkspaceFileSource;

export interface CollectReportOptions {
  /** Directory that receives participant-report.json on success. */
  readonly reportDir: string;
  /** Byte cap of a workspace result file. Default 1 MiB. */
  readonly maxBytes?: number;
  /** Bound of the preserved redacted text. Default 64 KiB. */
  readonly maxTextBytes?: number;
  /** Secret values replaced with `[REDACTED]` in the preserved text. */
  readonly secrets?: readonly string[];
  /** Result schema of the eval; the parsed value is checked against it. */
  readonly resultSchema?: Json | null;
  /** Persisted report file name. Default participant-report.json. */
  readonly reportFilename?: string;
}

/** Task-evidence problem. It never fails the run as infrastructure. */
export interface ReportProblem {
  readonly code: string;
  readonly subject: string;
  readonly message: string;
}

export interface ReportSuccess {
  readonly status: "ok";
  readonly source: ResultSourceKind;
  /** Bounded redacted text of the final output. */
  readonly text: string;
  /** Parsed value as the adapter produced it, before redaction. */
  readonly value: Json;
  readonly textSha256: string;
  /** Absolute path of the persisted report, or null when not written. */
  readonly writtenTo: string | null;
}

export interface ReportFailure {
  readonly status: "problem";
  readonly problem: ReportProblem;
  /** Bounded redacted text, when the source produced any text. */
  readonly text: string | null;
}

export type ReportOutcome = ReportSuccess | ReportFailure;

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_TEXT_BYTES = 65_536;
const TRUNCATION_MARK = "\n[TRUNCATED]";
const DUPLICATE_KEY_MESSAGE = "Duplicate object key";
const MUTATION_TOLERANCE_MS = 2;

/**
 * Collect the participant report from exactly one source. On success the
 * report is persisted as canonical JSON; the persisted value is redacted
 * while the returned value keeps what the adapter produced. On failure the
 * problem is returned together with the bounded redacted text, and nothing
 * is written.
 */
export async function collectParticipantReport(
  source: ResultSource,
  options: CollectReportOptions
): Promise<ReportOutcome> {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
  };
  const redactor = new Redactor({
    hmacKey: new Uint8Array(32),
    secrets: options.secrets ?? []
  });

  const kind: string = source.source;
  if (kind !== "adapter_final" && kind !== "workspace_file") {
    return failure(
      ReportCode.SourceUnknown,
      kind,
      "Result source must be adapter_final or workspace_file."
    );
  }
  if (source.source === "adapter_final") {
    if (source.text.trim().length === 0) {
      return failure(
        ReportCode.Missing,
        "adapter_final",
        "The adapter final message channel is empty."
      );
    }
    return parseAndPersist(source, source.text, limits, redactor, options);
  }
  const read = await readWorkspaceFile(source, limits);
  if (read.status === "problem") {
    return failure(read.code, source.filename, read.message);
  }
  return parseAndPersist(source, read.text, limits, redactor, options);
}

type WorkspaceRead =
  | { readonly status: "text"; readonly text: string }
  | {
      readonly status: "problem";
      readonly code: string;
      readonly message: string;
    };

async function readWorkspaceFile(
  source: WorkspaceFileSource,
  limits: { readonly maxBytes: number }
): Promise<WorkspaceRead> {
  const problem = (code: string, message: string): WorkspaceRead => ({
    status: "problem",
    code,
    message
  });
  if (source.filename.includes("\\") || source.filename.startsWith("/")) {
    return problem(
      ReportCode.PathUnsafe,
      "Result filename must be a POSIX relative path."
    );
  }
  if (
    source.filename.split("/").some((part) => part === ".." || part === ".")
  ) {
    return problem(
      ReportCode.PathUnsafe,
      "Result filename must not traverse outside the workspace."
    );
  }
  const root = path.resolve(source.workspaceDir);
  const absolute = path.join(root, source.filename);
  if (source.filename.length === 0 || !isWithin(root, absolute)) {
    return problem(
      ReportCode.PathUnsafe,
      "Result filename must stay inside the workspace."
    );
  }
  const before = await lstatQuiet(absolute);
  if (before === null) {
    return problem(
      ReportCode.Missing,
      "The declared result file does not exist after the agent exited."
    );
  }
  if (before.isSymbolicLink()) {
    return problem(ReportCode.Symlink, "The result file is a symbolic link.");
  }
  if (!before.isFile()) {
    return problem(
      ReportCode.NotRegular,
      "The result file is not a regular file."
    );
  }
  if (before.size > limits.maxBytes) {
    return problem(
      ReportCode.TooLarge,
      `The result file exceeds the declared byte cap of ${limits.maxBytes}.`
    );
  }
  if (
    source.exitedAtMs !== null &&
    before.mtimeMs > source.exitedAtMs + MUTATION_TOLERANCE_MS
  ) {
    return problem(
      ReportCode.Mutated,
      "The result file changed after the agent exited."
    );
  }
  const bytes = await readFileQuiet(absolute);
  if (bytes === null) {
    return problem(ReportCode.Missing, "The result file could not be read.");
  }
  const after = await lstatQuiet(absolute);
  if (
    after === null ||
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size
  ) {
    return problem(
      ReportCode.Mutated,
      "The result file changed while it was being read."
    );
  }
  return { status: "text", text: new TextDecoder("utf-8").decode(bytes) };
}

async function parseAndPersist(
  source: ResultSource,
  rawText: string,
  limits: { readonly maxBytes: number; readonly maxTextBytes: number },
  redactor: Redactor,
  options: CollectReportOptions
): Promise<ReportOutcome> {
  let value: Json;
  try {
    value = parseJsonStrict(rawText, { maxBytes: limits.maxBytes });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const duplicate = message.startsWith(DUPLICATE_KEY_MESSAGE);
    return {
      status: "problem",
      problem: {
        code: duplicate ? ReportCode.DuplicateKey : ReportCode.JsonInvalid,
        subject: source.source,
        message
      },
      text: boundedText(rawText, limits.maxTextBytes, redactor)
    };
  }

  if (options.resultSchema !== null && options.resultSchema !== undefined) {
    const violations = new SchemaValidator(options.resultSchema).errors(value);
    if (violations.length > 0) {
      return {
        status: "problem",
        problem: {
          code: ReportCode.SchemaInvalid,
          subject: source.source,
          message: violations
            .map((violation) => `${violation.pointer}: ${violation.message}`)
            .join("; ")
        },
        text: boundedText(rawText, limits.maxTextBytes, redactor)
      };
    }
  }

  const text = boundedText(rawText, limits.maxTextBytes, redactor);
  const document: JsonObject = {
    schema_version: 1,
    kind: "ParticipantReport",
    source: source.source,
    text,
    text_sha256: sha256Hex(text),
    value: redactor.redactJson(value)
  };
  const filename = options.reportFilename ?? "participant-report.json";
  const target = path.join(path.resolve(options.reportDir), filename);
  const written = await persist(target, canonicalJson(document));
  return Object.freeze({
    status: "ok",
    source: source.source,
    text,
    value,
    textSha256: sha256Hex(text),
    writtenTo: written
  });
}

async function persist(
  target: string,
  contents: string
): Promise<string | null> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid.toString(16)}`;
  try {
    await writeFile(temporary, `${contents}\n`, "utf8");
    await rename(temporary, target);
  } catch {
    throw invalidInput(
      ReportCode.WriteFailed,
      `Could not write the participant report: ${target}.`,
      { target }
    );
  }
  return target;
}

function failure(
  code: string,
  subject: string,
  message: string
): ReportFailure {
  return Object.freeze({
    status: "problem",
    problem: Object.freeze({ code, subject, message }),
    text: null
  });
}

/**
 * Redact registered secrets, then bound the text to `maxTextBytes`. The
 * truncation mark keeps the bound exact and visible.
 */
function boundedText(
  text: string,
  maxTextBytes: number,
  redactor: Redactor
): string {
  const redacted = redactor.redactText(text);
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.byteLength <= maxTextBytes) {
    return redacted;
  }
  const limit = Math.max(0, maxTextBytes - TRUNCATION_MARK.length);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(0, limit)
  );
  return `${decoded}${TRUNCATION_MARK}`;
}

async function lstatQuiet(absolute: string): Promise<Stats | null> {
  return lstat(absolute).catch(() => null);
}

async function readFileQuiet(absolute: string): Promise<Uint8Array | null> {
  return readFile(absolute).catch(() => null);
}
