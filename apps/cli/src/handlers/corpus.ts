/**
 * Corpus commands (specification section 48.5): `oal corpus validate`
 * checks every declared corpus, and `oal corpus run` executes one
 * through the local target. The local target drives the public HTTP
 * listener of a fresh scenario serve per case and the separate
 * operator controls for waits and operator steps. It never calls
 * behavior code directly and never invents a response.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";

import {
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  invalidInput,
  isJsonObject,
  sha256Hex,
  stableJsonStringify,
  type ExitCode,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  loadPack,
  parseCorpus,
  type CorpusCase,
  type CorpusDocument
} from "@oal/pack";
import {
  runCorpus,
  type CorpusOperatorCommand,
  type CorpusReport,
  type CorpusTarget,
  type CorpusTargetRequest,
  type CorpusTargetResponse
} from "@oal/corpus";

import { emitDiagnostics } from "../diagnostics.ts";
import { missingArgument } from "../usage.ts";
import type { CommandArgs } from "../commands.ts";
import { MemoryIo, type Io } from "../io.ts";
import { main } from "../cli.ts";
import { TerminationGuard } from "../signals.ts";
import { VERSION } from "../version.ts";
import { compileServeSource } from "./serve.ts";

/** One corpus the commands selected. */
export interface SelectedCorpus {
  readonly document: CorpusDocument;
  readonly source: string;
}

/** Load and parse every corpus a pack declares. */
export async function corporaOfPack(
  packDir: string,
  io: Io
): Promise<SelectedCorpus[]> {
  const loaded = await loadPack(path.resolve(packDir));
  const errors = loaded.diagnostics.filter(
    (entry) => entry.severity === "error"
  );
  if (errors.length > 0) {
    for (const entry of errors) {
      io.stderr(`pack diagnostic ${entry.code}: ${entry.message}`);
    }
    throw invalidInput(
      "OAL-PACK-INVALID",
      "The pack reports errors; fix them first."
    );
  }
  const references = loaded.references.filter(
    (reference) => reference.role === "corpus"
  );
  return references.map((reference) => ({
    document: parseCorpus(reference.document ?? {}),
    source: reference.path
  }));
}

/** `oal corpus validate PACK`. */
export async function corpusValidateCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const packDir = args.positionals[0];
  if (packDir === undefined) {
    throw missingArgument(args.command.name, "pack");
  }
  try {
    const corpora = await corporaOfPack(packDir, io);
    io.stdout(
      stableJsonStringify({
        validated: corpora.length,
        corpora: corpora.map((corpus) => ({
          id: corpus.document.id,
          cases: corpus.document.cases.length,
          source: corpus.source
        }))
      })
    );
    return EXIT_OK;
  } catch (cause) {
    emitDiagnostics(io, args.context, [
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: errorCodeOf(cause),
        message: cause instanceof Error ? cause.message : String(cause)
      })
    ]);
    return EXIT_INVALID;
  }
}

function errorCodeOf(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    return String((cause as { readonly code: unknown }).code);
  }
  return "OAL-CORPUS-INVALID";
}

/** Parse one `--input name=value` flag value as JSON, or a string. */
function parseInputValue(raw: string): Json {
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return raw;
  }
}

/** `oal corpus run PACK [--corpus ID] [--input NAME=VALUE]...`. */
export async function corpusRunCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const packDir = args.positionals[0];
  if (packDir === undefined) {
    throw missingArgument(args.command.name, "pack");
  }
  const corpusFlag = args.flags.string("corpus");
  const inputs: Record<string, Json> = {};
  for (const raw of args.flags.all("input")) {
    const separator = raw.indexOf("=");
    if (separator < 1) {
      throw invalidInput(
        "OAL-CORPUS-INPUT-INVALID",
        `--input expects NAME=VALUE, got ${JSON.stringify(raw)}.`
      );
    }
    inputs[raw.slice(0, separator)] = parseInputValue(raw.slice(separator + 1));
  }

  const corpora = await corporaOfPack(packDir, io);
  const selected =
    typeof corpusFlag === "string" && corpusFlag.length > 0
      ? corpora.filter((corpus) => corpus.document.id === corpusFlag)
      : corpora;
  if (selected.length === 0) {
    io.stderr(
      typeof corpusFlag === "string" && corpusFlag.length > 0
        ? `No corpus ${JSON.stringify(corpusFlag)} in this pack.`
        : "This pack declares no corpora."
    );
    return EXIT_INVALID;
  }
  if (selected.length > 1) {
    throw invalidInput(
      "OAL-CORPUS-AMBIGUOUS",
      "Select one corpus with --corpus; this pack declares several."
    );
  }
  const corpus = selected[0];
  if (corpus === undefined) {
    throw invalidInput("OAL-CORPUS-INVALID", "No corpus selected.");
  }
  const missing = corpus.document.inputs.filter((name) => !(name in inputs));
  if (missing.length > 0) {
    throw invalidInput(
      "OAL-CORPUS-INPUT-MISSING",
      `Corpus ${JSON.stringify(corpus.document.id)} needs --input values for: ${missing.join(", ")}.`
    );
  }

  const compiled = await compileServeSource(
    packDir,
    args.context.cwd,
    args.context.maxSourceBytes
  );
  const packRoot = path.resolve(args.context.cwd, packDir);
  const target = new LocalCorpusTarget({
    packDir: packRoot,
    cwd: args.context.cwd,
    contract: compiled.contract
  });
  let report: CorpusReport;
  try {
    report = await runCorpus(corpus.document, target, {
      inputs,
      loadSchema: schemaLoaderOf(packRoot)
    });
  } finally {
    await target.close();
  }

  const outFlag = args.flags.string("out");
  const text = stableJsonStringify(report as unknown as Json);
  if (typeof outFlag === "string" && outFlag.length > 0) {
    const target = path.resolve(args.context.cwd, outFlag);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${text}\n`);
    io.stdout(`Corpus report written to ${target}`);
  } else {
    io.stdout(text);
  }
  const troubled = report.summary.failed > 0 || report.summary.error > 0;
  return troubled ? EXIT_INVALID : EXIT_OK;
}

/** One query or path value as wire text. */
function wireTextOf(value: Json): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return stableJsonStringify(value);
}

/** Read pack-relative schemas for matches_schema assertions. */
function schemaLoaderOf(packRoot: string) {
  return async (relativePath: string): Promise<JsonObject | null> => {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(packRoot, relativePath), "utf8")
      ) as Json;
      return isJsonObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
}

interface LocalTargetOptions {
  readonly packDir: string;
  readonly cwd: string;
  readonly contract: {
    readonly operations: readonly {
      readonly operation_id: string | null;
      readonly method: string;
      readonly path_template: string;
    }[];
  };
}

/** The local corpus target: public HTTP plus operator controls. */
export class LocalCorpusTarget implements CorpusTarget {
  readonly id = "local";
  readonly version = VERSION;
  readonly capabilities = { operators: true, virtualTime: true };
  private readonly operations = new Map<
    string,
    { readonly method: string; readonly pathTemplate: string }
  >();
  private readonly options: LocalTargetOptions;
  private serve: {
    readonly pending: Promise<ExitCode>;
    readonly guard: TerminationGuard;
    readonly baseUrl: string;
    readonly bearer: string;
    readonly socketPath: string;
    readonly credential: string;
  } | null = null;
  private controlCounter = 0;
  private checkpointCounter = 0;

  constructor(options: LocalTargetOptions) {
    this.options = options;
    for (const operation of options.contract.operations) {
      if (operation.operation_id !== null) {
        this.operations.set(operation.operation_id, {
          method: operation.method.toUpperCase(),
          pathTemplate: operation.path_template
        });
      }
    }
  }

  private ensureServe(): {
    readonly baseUrl: string;
    readonly bearer: string;
    readonly socketPath: string;
    readonly credential: string;
  } {
    if (this.serve === null) {
      throw invalidInput(
        "OAL-CORPUS-WORLD-MISSING",
        "The local target has no world; prepare a case first."
      );
    }
    return this.serve;
  }

  async prepare(corpusCase: CorpusCase): Promise<void> {
    if (this.serve !== null) {
      throw invalidInput(
        "OAL-CORPUS-WORLD-EXISTS",
        "The local target already holds a world; clean it up first."
      );
    }
    const runId = `corpus-${corpusCase.id}`;
    const runSeed = sha256Hex(`oal-corpus:${runId}`);
    const io = new MemoryIo();
    const guard = new TerminationGuard();
    const pending = main(
      [
        "serve",
        this.options.packDir,
        "--mode",
        "scenario",
        "--port",
        "0",
        "--run-id",
        runId,
        "--run-seed",
        runSeed
      ],
      io,
      { cwd: this.options.cwd, guard }
    );
    let readiness: { readonly baseUrl: string };
    try {
      readiness = await awaitReadiness(io);
    } catch (cause) {
      // Never leak a serve the caller cannot stop.
      guard.handle("SIGINT");
      await pending.catch(() => undefined);
      throw cause;
    }
    const worldDir = path.join(
      this.options.cwd,
      ".oal",
      "control",
      "serve",
      runId
    );
    const credentials = JSON.parse(
      await readFile(path.join(worldDir, "credentials.json"), "utf8")
    ) as {
      alternatives: Array<{ schemes: Array<{ value: string }> }>;
    };
    const bearer = credentials.alternatives[0]?.schemes[0]?.value;
    if (typeof bearer !== "string") {
      throw invalidInput(
        "OAL-CORPUS-WORLD-MISSING",
        "The world wrote no bearer credential."
      );
    }
    const credential = (
      await readFile(
        path.join(worldDir, "operator", "operator-credential"),
        "utf8"
      )
    ).trim();
    this.serve = {
      pending,
      guard,
      baseUrl: readiness.baseUrl,
      bearer,
      socketPath: path.join(worldDir, "operator", "control.sock"),
      credential
    };
  }

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const world = this.ensureServe();
    const operation = this.operations.get(instruction.operationId);
    if (operation === undefined) {
      throw invalidInput(
        "OAL-CORPUS-OPERATION-UNKNOWN",
        `The contract declares no operation ${JSON.stringify(instruction.operationId)}.`
      );
    }
    if (
      instruction.poll &&
      operation.method !== "GET" &&
      operation.method !== "HEAD"
    ) {
      throw invalidInput(
        "OAL-CORPUS-POLL-NOT-READ",
        `Poll repeats read operations only; ${JSON.stringify(instruction.operationId)} is ${operation.method}.`
      );
    }
    let targetPath = operation.pathTemplate;
    for (const [name, value] of Object.entries(instruction.parameters.path)) {
      const token = `{${name}}`;
      if (!targetPath.includes(token)) {
        throw invalidInput(
          "OAL-CORPUS-PATH-PARAMETER-UNKNOWN",
          `Path ${JSON.stringify(operation.pathTemplate)} has no parameter ${JSON.stringify(name)}.`
        );
      }
      // A bound path value is encoded as exactly one path component.
      targetPath = targetPath.replace(
        token,
        encodeURIComponent(wireTextOf(value))
      );
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(instruction.parameters.query)) {
      if (value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          query.append(name, wireTextOf(item));
        }
        continue;
      }
      query.set(name, wireTextOf(value));
    }
    const url = `${world.baseUrl}${targetPath}${query.size === 0 ? "" : `?${query.toString()}`}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${world.bearer}`
    };
    for (const [name, value] of Object.entries(instruction.parameters.header)) {
      headers[name] = wireTextOf(value);
    }
    const body =
      instruction.body === undefined
        ? undefined
        : JSON.stringify(instruction.body);
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body })
      });
    } catch {
      // The transport never delivered a response. That is
      // uncertainty, not a target crash and not evidence of a
      // rollback: the step records the loss and the case reconciles
      // (section 48.6).
      return {
        status: null,
        outcome: "lost",
        headers: {},
        body: null,
        method: operation.method,
        url
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let parsed: Json = null;
    if (text.length > 0) {
      parsed = contentType.includes("json")
        ? ((JSON.parse(text) as Json) ?? null)
        : text;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return {
      status: response.status,
      headers: responseHeaders,
      body: parsed,
      method: operation.method,
      url
    };
  }

  async wait(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await this.operate({ kind: "advance_time", byMs: ms });
  }

  async operate(command: CorpusOperatorCommand): Promise<Json> {
    const world = this.ensureServe();
    this.controlCounter += 1;
    const controlId = `corpus-${randomBytes(8).toString("hex")}-${this.controlCounter.toString(10)}`;
    if (command.kind === "inspect") {
      const answer = await controlRequest(
        world.socketPath,
        "GET",
        "/v1/world",
        {
          credential: world.credential
        }
      );
      return requireOk(answer, "inspect");
    }
    if (command.kind === "advance_time" || command.kind === "reset") {
      const view = await controlRequest(world.socketPath, "GET", "/v1/world", {
        credential: world.credential
      });
      const result = view.body["result"];
      const generation = isJsonObject(result)
        ? Number(result["generation"])
        : 1;
      const route = command.kind === "reset" ? "/v1/reset" : "/v1/advance-time";
      const answer = await controlRequest(world.socketPath, "POST", route, {
        credential: world.credential,
        body: {
          control_id: controlId,
          expect_generation: generation,
          ...(command.kind === "advance_time"
            ? { by_ms: command.byMs ?? 0 }
            : {})
        }
      });
      return requireOk(answer, command.kind);
    }
    if (command.kind === "checkpoint") {
      this.checkpointCounter += 1;
      const out =
        command.out === undefined
          ? path.join(
              this.options.cwd,
              ".oal",
              "corpus",
              `checkpoint-${this.checkpointCounter.toString(10)}`
            )
          : path.resolve(this.options.cwd, command.out);
      const answer = await controlRequest(
        world.socketPath,
        "POST",
        "/v1/checkpoints",
        {
          credential: world.credential,
          body: { control_id: controlId, out }
        }
      );
      return requireOk(answer, "checkpoint");
    }
    throw invalidInput(
      "OAL-CORPUS-OPERATOR-UNSUPPORTED",
      `The local target does not support ${JSON.stringify(command.kind)} operator steps yet.`,
      { supported: ["inspect", "reset", "checkpoint", "advance_time"] }
    );
  }

  async cleanup(): Promise<void> {
    await this.close();
  }

  /** Stop the world this target holds, if any. */
  async close(): Promise<void> {
    const serve = this.serve;
    if (serve === null) {
      return;
    }
    this.serve = null;
    serve.guard.handle("SIGINT");
    await serve.pending;
  }
}

/** A control answer the socket returned. */
interface ControlAnswer {
  readonly status: number;
  readonly body: JsonObject;
}

function requireOk(answer: ControlAnswer, kind: string): Json {
  if (answer.status !== 200) {
    throw invalidInput(
      "OAL-CORPUS-OPERATOR-FAILED",
      `Operator ${JSON.stringify(kind)} answered HTTP ${answer.status.toString(10)}.`
    );
  }
  return answer.body["result"] ?? {};
}

/** Talk to the operator socket of one world. */
function controlRequest(
  socketPath: string,
  method: string,
  target: string,
  options: { readonly body?: Json; readonly credential: string }
): Promise<ControlAnswer> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? "" : JSON.stringify(options.body);
    const outgoing = request(
      {
        socketPath,
        path: target,
        method,
        headers: {
          authorization: `Bearer ${options.credential}`,
          ...(text.length === 0
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text).toString(10)
              })
        }
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: JSON.parse(
              Buffer.concat(chunks).toString("utf8")
            ) as JsonObject
          });
        });
      }
    );
    outgoing.on("error", reject);
    if (text.length > 0) {
      outgoing.write(text);
    }
    outgoing.end();
  });
}

/** Wait for the readiness record one serve prints. */
async function awaitReadiness(
  io: MemoryIo,
  timeoutMs = 60_000
): Promise<{ readonly baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chunk = io.stdoutChunks[0];
    if (chunk !== undefined) {
      try {
        const parsed = JSON.parse(chunk) as JsonObject;
        const baseUrl = parsed["baseUrl"];
        if (typeof baseUrl === "string") {
          return { baseUrl };
        }
      } catch {
        // The record is not complete yet; keep waiting.
      }
    }
    if (Date.now() > deadline) {
      throw invalidInput(
        "OAL-CORPUS-WORLD-MISSING",
        `No readiness record: ${io.stdoutChunks.join("")} stderr: ${io.stderrText()}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}
