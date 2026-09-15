import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DiagnosticCode,
  EXIT_INVALID,
  EXIT_OK,
  invalidInput,
  isJsonObject,
  isSafeId,
  resolveWithinRoot,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { loadEval, type Eval } from "@oal/evaluator";
import {
  defaultSchemaDir,
  loadPack,
  parsePackDocument,
  type LoadedPack
} from "@oal/pack";

import type { CommandArgs, CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

/** Stable diagnostic codes for the eval authoring commands. */
export const EvalCliCode = {
  TargetNotEmpty: "OAL-EVAL-TARGET-NOT-EMPTY",
  IdUnsafe: "OAL-EVAL-ID-UNSAFE",
  DocumentMissing: "OAL-EVAL-DOCUMENT-MISSING",
  DocumentAmbiguous: "OAL-EVAL-DOCUMENT-AMBIGUOUS",
  SchemaMissing: "OAL-EVAL-SCHEMA-MISSING"
} as const;

/** Accepted eval document file names, in preference order. */
export const EVAL_DOCUMENT_NAMES = ["eval.yaml", "eval.json"] as const;

/** Directories created for every new eval directory. */
export const EVAL_DIRECTORIES = ["cases"] as const;

function requireSinglePositional(args: CommandArgs, name: string): string {
  const value = args.positionals[0];
  if (value === undefined) {
    throw missingArgument(args.command.name, name);
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  return value;
}

function requireTerminalOrJson(args: CommandArgs): void {
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function str(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Turn one directory name into a safe eval identifier. */
export function safeEvalId(candidate: string): string | null {
  const cleaned = candidate
    .trim()
    .toLowerCase()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "");
  return isSafeId(cleaned) ? cleaned : null;
}

export interface EvalScaffoldOptions {
  /** Working directory used to resolve the target. */
  readonly cwd?: string;
  /** Eval identifier; defaults to the target directory name. */
  readonly id?: string;
}

export interface EvalScaffoldResult {
  readonly root: string;
  readonly id: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

/**
 * Scaffold one eval directory: a task document, an eval document, a
 * result schema stub, a rubric template, and one example case. The
 * layout validates with `oal eval validate` without any edit.
 */
export async function scaffoldEval(
  directory: string,
  options: EvalScaffoldOptions
): Promise<EvalScaffoldResult> {
  const cwd = options.cwd ?? process.cwd();
  const root = path.resolve(cwd, directory);
  const existing = await stat(root).catch(() => null);
  if (existing !== null && !existing.isDirectory()) {
    throw invalidInput(
      EvalCliCode.TargetNotEmpty,
      `Eval target is not a directory: ${root}`
    );
  }
  if (existing !== null) {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw invalidInput(
        EvalCliCode.TargetNotEmpty,
        `Eval target is not empty: ${root}`
      );
    }
  }
  const id =
    options.id === undefined
      ? safeEvalId(path.basename(root))
      : isSafeId(options.id)
        ? options.id
        : null;
  if (id === null) {
    throw invalidInput(
      EvalCliCode.IdUnsafe,
      options.id === undefined
        ? `Eval directory name is not a safe ID: ${path.basename(root)}`
        : `Eval identifier is not a safe ID: ${options.id}`
    );
  }

  await mkdir(root, { recursive: true });
  for (const dir of EVAL_DIRECTORIES) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  const files: Array<{ relative: string; contents: string }> = [
    { relative: "task.md", contents: taskTemplate(id) },
    { relative: "eval.yaml", contents: evalTemplate(id) },
    { relative: "result.schema.json", contents: resultSchema(id) },
    { relative: "rubric.yaml", contents: rubricTemplate(id) },
    { relative: "cases/case.schema.json", contents: caseSchema(id) },
    { relative: "cases/cases.jsonl", contents: CASE_LINE }
  ];
  for (const file of files) {
    await writeFile(path.join(root, file.relative), file.contents);
  }
  return {
    root,
    id,
    directories: [...EVAL_DIRECTORIES],
    files: files.map((file) => file.relative)
  };
}

/** `oal eval init <directory> [--id <id>]` (specification section 23.7). */
export const evalInitCommand: CommandHandler = async (args, io) => {
  const directory = requireSinglePositional(args, "directory");
  const id = args.flags.string("id");
  const result = await scaffoldEval(directory, {
    cwd: args.context.cwd,
    ...(id === undefined ? {} : { id })
  });
  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        root: result.root,
        id: result.id,
        directories: [...result.directories],
        files: [...result.files]
      } as Json)
    );
  } else {
    io.stdout(`created: ${result.root}`);
    io.stdout(`eval id: ${result.id}`);
    for (const file of result.files) {
      io.stdout(`file: ${file}`);
    }
  }
  return EXIT_OK;
};

interface EvalSchemas {
  readonly eval: Json;
  readonly case: Json;
  readonly rubric: Json;
}

/** Read the three schema documents eval validation needs. */
async function loadEvalSchemas(): Promise<EvalSchemas> {
  const dir = defaultSchemaDir();
  const wanted: readonly (readonly [keyof EvalSchemas, string])[] = [
    ["eval", "eval.v1.schema.json"],
    ["case", "eval-case.v1.schema.json"],
    ["rubric", "rubric.v1.schema.json"]
  ];
  const documents = new Map<keyof EvalSchemas, Json>();
  for (const [name, file] of wanted) {
    const target = path.join(dir, file);
    const text = await readFile(target, "utf8").catch(() => null);
    if (text === null) {
      throw invalidInput(
        EvalCliCode.SchemaMissing,
        `Required schema document is missing: ${target}`
      );
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw invalidInput(
        EvalCliCode.SchemaMissing,
        `Schema document is not valid JSON (${target}): ${reason}`
      );
    }
    if (!isJsonObject(parsed)) {
      throw invalidInput(
        EvalCliCode.SchemaMissing,
        `Schema document is not a JSON object: ${target}`
      );
    }
    documents.set(name, parsed);
  }
  const schema = (name: keyof EvalSchemas): Json => {
    const found = documents.get(name);
    if (found === undefined) {
      throw invalidInput(
        EvalCliCode.SchemaMissing,
        `Schema document was not loaded: ${name}`
      );
    }
    return found;
  };
  return {
    eval: schema("eval"),
    case: schema("case"),
    rubric: schema("rubric")
  };
}

/** Find the eval document for a path that names a file or a directory. */
async function locateEvalDocument(root: string): Promise<string> {
  const stats = await stat(root).catch(() => null);
  if (stats === null) {
    throw invalidInput(
      EvalCliCode.DocumentMissing,
      `Eval path not found: ${root}`
    );
  }
  if (stats.isFile()) {
    return root;
  }
  if (!stats.isDirectory()) {
    throw invalidInput(
      EvalCliCode.DocumentMissing,
      `Eval path is not a file or a directory: ${root}`
    );
  }
  const present: string[] = [];
  for (const name of EVAL_DOCUMENT_NAMES) {
    const entry = await stat(path.join(root, name)).catch(() => null);
    if (entry !== null && entry.isFile()) {
      present.push(name);
    }
  }
  if (present.length > 1) {
    throw invalidInput(
      EvalCliCode.DocumentAmbiguous,
      `Eval directory has both eval.yaml and eval.json: ${root}`
    );
  }
  const found = present[0];
  if (found === undefined) {
    throw invalidInput(
      EvalCliCode.DocumentMissing,
      `Eval directory has no eval.yaml or eval.json: ${root}`
    );
  }
  return path.join(root, found);
}

/** References the eval document declares, split by how they are read. */
function declaredReferences(document: Json | null): {
  texts: string[];
  documents: string[];
} {
  const texts: string[] = [];
  const documents: string[] = [];
  if (document === null || !isJsonObject(document)) {
    return { texts, documents };
  }
  const task = document["task"];
  if (isJsonObject(task)) {
    const source = task["source"];
    if (typeof source === "string") {
      texts.push(source);
    }
  }
  const files = document["participant_files"];
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (isJsonObject(entry) && typeof entry["source"] === "string") {
        texts.push(entry["source"]);
      }
    }
  }
  const cases = document["cases"];
  if (isJsonObject(cases)) {
    if (typeof cases["source"] === "string") {
      texts.push(cases["source"]);
    }
    if (typeof cases["schema"] === "string") {
      documents.push(cases["schema"]);
    }
  }
  const result = document["result"];
  if (isJsonObject(result) && typeof result["schema"] === "string") {
    documents.push(result["schema"]);
  }
  if (typeof document["rubric"] === "string") {
    documents.push(document["rubric"]);
  }
  return { texts, documents };
}

async function readAsset(
  baseDir: string,
  reference: string,
  maxBytes: number
): Promise<string | null> {
  const absolute = await resolveWithinRoot(
    baseDir,
    reference,
    "eval asset"
  ).catch(() => null);
  if (absolute === null) {
    // The loader reports the reference it could not resolve.
    return null;
  }
  const bytes = await readFile(absolute).catch(() => null);
  if (bytes === null || bytes.byteLength > maxBytes) {
    return null;
  }
  return decode(bytes);
}

/** Preload every referenced asset the resolvers of loadEval need. */
async function loadAssets(
  baseDir: string,
  document: Json | null,
  maxBytes: number
): Promise<{
  texts: Map<string, string>;
  documents: Map<string, Json>;
  diagnostics: Diagnostic[];
}> {
  const references = declaredReferences(document);
  const texts = new Map<string, string>();
  const documents = new Map<string, Json>();
  const diagnostics: Diagnostic[] = [];
  for (const reference of references.texts) {
    const text = await readAsset(baseDir, reference, maxBytes);
    if (text !== null) {
      texts.set(reference, text);
    }
  }
  for (const reference of references.documents) {
    const text = await readAsset(baseDir, reference, maxBytes);
    if (text === null) {
      continue;
    }
    const parsed = parsePackDocument(text, reference);
    if (parsed.diagnostic !== null) {
      diagnostics.push(parsed.diagnostic);
    }
    if (parsed.value !== null) {
      documents.set(reference, parsed.value);
    }
  }
  return { texts, documents, diagnostics };
}

/** `oal eval validate <path> [--strict]` (specification section 23.7). */
export const evalValidateCommand: CommandHandler = async (args, io) => {
  const target = requireSinglePositional(args, "path");
  requireTerminalOrJson(args);
  const root = path.resolve(args.context.cwd, target);
  const documentPath = await locateEvalDocument(root);
  const bytes = await readFile(documentPath).catch(() => null);
  if (bytes === null) {
    throw invalidInput(
      EvalCliCode.DocumentMissing,
      `Eval document could not be read: ${documentPath}`
    );
  }
  if (bytes.byteLength > args.context.maxSourceBytes) {
    throw invalidInput(
      DiagnosticCode.InputTooLarge,
      `Eval document exceeds the ${args.context.maxSourceBytes} byte limit ` +
        `(${bytes.byteLength} bytes): ${documentPath}`
    );
  }
  const parsed = parsePackDocument(decode(bytes), documentPath);
  if (parsed.value === null) {
    emitDiagnostics(
      io,
      args.context,
      parsed.diagnostic === null ? [] : [parsed.diagnostic]
    );
    return EXIT_INVALID;
  }
  const schemas = await loadEvalSchemas();
  const baseDir = path.dirname(documentPath);
  const assets = await loadAssets(
    baseDir,
    parsed.value,
    args.context.maxSourceBytes
  );
  const result = await loadEval(parsed.value, {
    schema: schemas.eval,
    caseSchema: schemas.case,
    rubricSchema: schemas.rubric,
    resolveText: (reference) => assets.texts.get(reference),
    resolveDocument: (reference) => assets.documents.get(reference),
    documentUri: documentPath
  });
  const diagnostics = [...assets.diagnostics, ...result.diagnostics];
  emitDiagnostics(io, args.context, diagnostics);
  const hasErrors = diagnostics.some((entry) => entry.severity === "error");
  const hasWarnings = diagnostics.some((entry) => entry.severity === "warning");
  if (hasErrors || (args.flags.has("strict") && hasWarnings)) {
    return EXIT_INVALID;
  }
  const evaluation = result.eval;
  if (evaluation === null) {
    return EXIT_INVALID;
  }
  if (args.context.format === "json") {
    const record: JsonObject = isJsonObject(parsed.value)
      ? { ...parsed.value, case_count: result.caseCount }
      : { case_count: result.caseCount };
    io.stdout(stableJsonStringify(record));
  } else {
    for (const line of summaryLines(evaluation, result.caseCount)) {
      io.stdout(line);
    }
  }
  return EXIT_OK;
};

function summaryLines(evaluation: Eval, caseCount: number): string[] {
  const target = evaluation.task.target ?? "TASK.md";
  const filename =
    evaluation.result.filename === undefined
      ? ""
      : ` ${evaluation.result.filename}`;
  return [
    `eval: ${evaluation.id}`,
    `prompt_set: ${evaluation.prompt_set}`,
    `task: ${evaluation.task.source} -> ${target}`,
    `result: ${evaluation.result.source} ${evaluation.result.schema}${filename}`,
    `cases: ${caseCount}`,
    `rubric: ${evaluation.rubric}`,
    `scenario: ${evaluation.scenario}`
  ];
}

/** One listed eval, built from the manifest and its loaded references. */
type EvalListEntry = {
  id: string;
  prompt_set: string;
  task_source: string;
  task_target: string;
  result_source: string;
  result_schema: string;
  rubric: string;
  rubric_sha256: string;
  scenario: string;
};

function listEntry(
  loaded: LoadedPack,
  entry: JsonObject,
  index: number
): EvalListEntry {
  const task = isJsonObject(entry["task"]) ? entry["task"] : null;
  const result = isJsonObject(entry["result"]) ? entry["result"] : null;
  const declaredTarget = str(task?.["target"]);
  const reference = loaded.references.find(
    (candidate) =>
      candidate.role === "rubric" && candidate.pointer === `/evals/${index}`
  );
  return {
    id: str(entry["id"]),
    prompt_set: str(entry["prompt_set"]),
    task_source: str(task?.["source"]),
    task_target: declaredTarget === "" ? "TASK.md" : declaredTarget,
    result_source: str(result?.["source"]),
    result_schema: str(result?.["schema"]),
    rubric: str(entry["rubric"]),
    rubric_sha256:
      reference !== undefined && reference.sha256 !== ""
        ? reference.sha256
        : "",
    scenario: str(entry["scenario"])
  };
}

/** `oal eval list <pack>`: every eval a pack declares. */
export const evalListCommand: CommandHandler = async (args, io) => {
  const directory = requireSinglePositional(args, "pack");
  requireTerminalOrJson(args);
  const loaded = await loadPack(path.resolve(args.context.cwd, directory));
  emitDiagnostics(io, args.context, loaded.diagnostics);
  if (loaded.diagnostics.some((entry) => entry.severity === "error")) {
    return EXIT_INVALID;
  }
  const metadata = isJsonObject(loaded.manifest["metadata"])
    ? loaded.manifest["metadata"]
    : null;
  const evals = Array.isArray(loaded.manifest["evals"])
    ? loaded.manifest["evals"]
    : [];
  const entries: EvalListEntry[] = [];
  for (let index = 0; index < evals.length; index += 1) {
    const entry = evals[index];
    if (isJsonObject(entry)) {
      entries.push(listEntry(loaded, entry, index));
    }
  }
  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        pack: str(metadata?.["id"]),
        evals: entries
      } as Json)
    );
  } else {
    for (const entry of entries) {
      const digest = entry.rubric_sha256 === "" ? "-" : entry.rubric_sha256;
      io.stdout(
        `${entry.id}: task_target=${entry.task_target} ` +
          `result_source=${entry.result_source} rubric_sha256=${digest}`
      );
    }
  }
  return EXIT_OK;
};

function taskTemplate(id: string): string {
  return `# Task for eval ${id}

Read the OpenAPI document in this workspace, then answer in JSON that
matches result.schema.json.

1. State the base URL the contract declares.
2. List every operation as METHOD followed by the path template.
3. For each operation, report only what the contract states about it.
   Quote the contract when it is explicit and write "not stated" when
   it is not.

Send no requests. Record any assumption you make in your final answer.
`;
}

function evalTemplate(id: string): string {
  return `# One eval (specification sections 12.2 and 12.6).
# References are POSIX paths relative to this directory.
id: ${id}
prompt_set: smoke
task:
  source: task.md
  engine: literal
  target: TASK.md
participant_files:
  - source: result.schema.json
    target: result.schema.json
operation_scope:
  mode: all
cases:
  source: cases/cases.jsonl
  schema: cases/case.schema.json
  id_pointer: /id
result:
  source: adapter_final
  schema: result.schema.json
  required: true
rubric: rubric.yaml
scenario: baseline
`;
}

function resultSchema(id: string): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `https://agentlab.dev/evals/${id}/result.schema.json`,
      title: "Scaffolded eval result",
      description:
        "Structured answer for the scaffolded task. Extend it freely.",
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        assumptions: { type: "array", items: { type: "string" } }
      }
    },
    null,
    2
  )}\n`;
}

function caseSchema(id: string): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `https://agentlab.dev/evals/${id}/case.schema.json`,
      title: "Scaffolded eval case input",
      description:
        "Synthetic non-secret inputs one case line may carry. Template " +
        "variables read them as case.input.<key>.",
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: {
        topic: { type: "string", minLength: 1 }
      }
    },
    null,
    2
  )}\n`;
}

function rubricTemplate(id: string): string {
  return `rubric_version: 1
id: ${id}
description: >-
  Template rubric. It asserts only that the participant produced a
  structured result. Replace it with task-specific checks.
scoring:
  method: weighted_binary
  pass_threshold: 1
checks:
  - id: structured-result
    kind: predicate
    weight: 1
    required: true
    evidence_class: participant_observable
    expression: report.operations != null
    on_missing: fail
signals: []
`;
}

const CASE_LINE = `${JSON.stringify({
  id: "example",
  input: { topic: "operations" },
  description: "One synthetic non-secret example case."
})}\n`;
