/**
 * Eval and EvalCase document models (specification sections 12.2, 12.6,
 * and 19.5).
 *
 * One eval names the participant material of a task: the prompt set, the
 * task document with its template engine, participant files, the
 * operation scope, the case source, the result contract, the rubric, and
 * the scenario. A case source is a bounded JSONL file in which every
 * non-empty line is one EvalCase.
 *
 * The loaders validate the document shape, then apply the semantic rules
 * the JSON Schema cannot express: safe relative references, the
 * conditional result filename, unique case identifiers, case inputs that
 * match the case schema, template variables that resolve against the
 * case inputs, and an inline rubric that compiles. They never throw on
 * document content; every problem is a diagnostic.
 */

import {
  diagnostic,
  isJsonObject,
  isSafeId,
  isSafeRelativePath,
  parseJsonStrict,
  resolveJsonPointer,
  SchemaValidator,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { loadRubric } from "./rubric.ts";

/**
 * Stable diagnostic codes produced by the eval document loaders. Codes
 * are stable API; wording is not. The taxonomy in section 32.2 lists the
 * categories, so eval authoring extends the input and pack rows.
 */
export const EvalDocCode = {
  EvalInvalid: "OAL-EVAL-INVALID",
  CaseInvalid: "OAL-EVAL-CASE-INVALID",
  SchemaDraft: "OAL-EVAL-SCHEMA-DRAFT"
} as const;

/** Template engines allowed in version 1 (section 12.3). */
export type TemplateEngine = "literal" | "mustache-strict";

export interface EvalTask {
  /** Root-relative source of the task document. */
  source: string;
  engine: TemplateEngine;
  /** Participant workspace file name; the runner defaults to TASK.md. */
  target?: string | undefined;
}

export interface EvalParticipantFile {
  source: string;
  target: string;
}

export type OperationSelector =
  | { kind: "tags"; tags: string[] }
  | { kind: "methods"; methods: string[] };

/** Deterministic operation scope declaration (section 12.3). */
export type OperationScope =
  | { mode: "all" }
  | { mode: "list"; operations: string[] }
  | { mode: "selector"; selector: OperationSelector };

/** Bounded JSONL case source declaration (section 12.6). */
export interface EvalCases {
  source: string;
  schema: string;
  /** JSON Pointer that names the case identifier inside one case line. */
  id_pointer: string;
}

export interface EvalResult {
  source: "adapter_final" | "workspace_file";
  schema: string;
  required: boolean;
  /** Participant workspace file name for a workspace_file result. */
  filename?: string | undefined;
}

/** One eval, matching schemas/eval.v1.schema.json. */
export interface Eval {
  id: string;
  prompt_set: string;
  task: EvalTask;
  participant_files?: EvalParticipantFile[] | undefined;
  operation_scope: OperationScope;
  cases?: EvalCases | undefined;
  result: EvalResult;
  rubric: string;
  scenario: string;
}

/** One JSONL case line, matching schemas/eval-case.v1.schema.json. */
export interface EvalCase {
  id: string;
  input: JsonObject;
  description?: string | undefined;
}

export interface EvalLoadOptions {
  /** Draft 2020-12 eval schema. The caller reads it from schemas/. */
  schema?: Json | undefined;
  /** Draft 2020-12 eval case schema for the case lines. */
  caseSchema?: Json | undefined;
  /** Draft 2020-12 rubric schema used when the rubric document resolves. */
  rubricSchema?: Json | undefined;
  /** Resolves one referenced file to decoded UTF-8 text. */
  resolveText?: ((reference: string) => string | undefined) | undefined;
  /** Resolves one referenced file to a parsed document. */
  resolveDocument?: ((reference: string) => Json | undefined) | undefined;
  /** Document URI recorded in diagnostics. */
  documentUri?: string | undefined;
}

export interface EvalLoadResult {
  /** The typed eval, or null when any error was reported. */
  eval: Eval | null;
  /** Count of loaded case lines; zero when no case source resolves. */
  caseCount: number;
  diagnostics: Diagnostic[];
}

export interface EvalCaseOptions {
  /** Draft 2020-12 eval case schema. */
  schema?: Json | undefined;
  /** Document URI recorded in diagnostics. */
  documentUri?: string | undefined;
  /** JSON Pointer prefix recorded in diagnostics for one case. */
  pointer?: string | undefined;
}

export interface EvalCaseResult {
  /** The typed case, or null when any error was reported. */
  case: EvalCase | null;
  diagnostics: Diagnostic[];
}

export interface EvalCasesResult {
  /** Every case whose line loaded; broken lines are skipped. */
  cases: EvalCase[];
  diagnostics: Diagnostic[];
}

/**
 * Load and check one eval document. The function never throws on
 * document content; every problem is reported as a diagnostic.
 */
export function loadEval(
  document: Json,
  options: EvalLoadOptions = {}
): EvalLoadResult {
  const loader = new EvalLoader(options);
  const evaluation = loader.load(document);
  return {
    eval: evaluation === null || loader.failed ? null : evaluation,
    caseCount: loader.caseCount,
    diagnostics: loader.diagnostics
  };
}

/** Load one JSONL case line. */
export function loadEvalCase(
  document: Json,
  options: EvalCaseOptions = {}
): EvalCaseResult {
  const diagnostics: Diagnostic[] = [];
  const pointer = options.pointer ?? "#/";
  if (options.schema !== undefined) {
    for (const violation of new SchemaValidator(options.schema).errors(
      document
    )) {
      diagnostics.push(
        caseError(
          `${violation.code}: ${violation.message}`,
          violation.pointer.length === 0
            ? pointer
            : `${pointer}${violation.pointer.slice(1)}`,
          options.documentUri
        )
      );
    }
  }
  if (!isJsonObject(document)) {
    diagnostics.push(
      caseError("A case must be an object.", pointer, options.documentUri)
    );
    return { case: null, diagnostics };
  }
  const id = document["id"];
  if (typeof id !== "string" || !isSafeId(id)) {
    diagnostics.push(
      caseError(
        "The case id is not a safe identifier.",
        `${pointer}/id`,
        options.documentUri
      )
    );
    return { case: null, diagnostics };
  }
  const input = document["input"];
  if (!isJsonObject(input)) {
    diagnostics.push(
      caseError(
        "A case needs an input object.",
        `${pointer}/input`,
        options.documentUri
      )
    );
    return { case: null, diagnostics };
  }
  const description = document["description"];
  if (description !== undefined && typeof description !== "string") {
    diagnostics.push(
      caseError(
        "The case description must be a string.",
        `${pointer}/description`,
        options.documentUri
      )
    );
    return { case: null, diagnostics };
  }
  const loaded: EvalCase = {
    id,
    input,
    ...(description === undefined ? {} : { description })
  };
  const failed = diagnostics.some((entry) => entry.severity === "error");
  return {
    case: failed ? null : loaded,
    diagnostics
  };
}

/**
 * Load every non-empty line of one JSONL case source. Blank lines are
 * skipped, case identifiers must be unique, and the id pointer must name
 * a non-empty string inside every case.
 */
export function loadEvalCases(
  text: string,
  options: EvalCaseOptions & { idPointer?: string | undefined } = {}
): EvalCasesResult {
  const diagnostics: Diagnostic[] = [];
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) {
      continue;
    }
    const pointer = `#/${index}`;
    let parsed: Json;
    try {
      parsed = parseJsonStrict(line);
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      diagnostics.push(
        caseError(
          `Case line ${index + 1} is not valid JSON: ${reason}`,
          pointer,
          options.documentUri
        )
      );
      continue;
    }
    const loaded = loadEvalCase(parsed, {
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      ...(options.documentUri === undefined
        ? {}
        : { documentUri: options.documentUri }),
      pointer
    });
    diagnostics.push(...loaded.diagnostics);
    const oneCase = loaded.case;
    if (oneCase === null) {
      continue;
    }
    if (seen.has(oneCase.id)) {
      diagnostics.push(
        caseError(
          `Duplicate case id ${JSON.stringify(oneCase.id)} at line ${
            index + 1
          }.`,
          `${pointer}/id`,
          options.documentUri
        )
      );
      continue;
    }
    seen.add(oneCase.id);
    if (
      options.idPointer !== undefined &&
      !caseIdResolves(options.idPointer, parsed)
    ) {
      diagnostics.push(
        caseError(
          `Case id_pointer ${JSON.stringify(
            options.idPointer
          )} names no non-empty string at line ${index + 1}.`,
          pointer,
          options.documentUri
        )
      );
    }
    cases.push(oneCase);
  }
  return { cases, diagnostics };
}

function caseError(
  message: string,
  pointer: string,
  documentUri: string | undefined
): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "compile",
    code: EvalDocCode.CaseInvalid,
    message,
    ...(documentUri === undefined ? {} : { document_uri: documentUri }),
    json_pointer: pointer
  });
}

/** The id pointer must resolve to a non-empty string inside the case. */
function caseIdResolves(pointer: string, document: Json): boolean {
  const value = resolveJsonPointer(document, pointer);
  return typeof value === "string" && value.length > 0;
}

/** Template variables version 1 allows (section 19.2). */
const TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  "pack.name",
  "pack.version",
  "eval.id",
  "run.id",
  "run.index",
  "run.seed",
  "api.baseUrl",
  "api.contractFile",
  "exposure.mode",
  "contract.visibility",
  "case.name"
]);

const CASE_INPUT_PREFIX = "case.input.";
const MUSTACHE_TAG = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const OPERATION_KEY_PATTERN = /^path:[A-Z]+ [^ ]+$/;
const HTTP_METHOD_PATTERN = /^[A-Z]+$/;
const JSON_POINTER_PATTERN = /^(\/[^/~]*(~[01])?)*$/;

/** Sorted unique mustache variable names referenced by one template. */
export function templateVariablesOf(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MUSTACHE_TAG)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Read one object field. A missing field reads as undefined. */
function fieldOf(value: JsonObject, key: string): Json | undefined {
  return value[key];
}

class EvalLoader {
  readonly diagnostics: Diagnostic[] = [];
  failed = false;
  caseCount = 0;
  /** Input keys present in every case; null when no case source loads. */
  private caseInputKeys: ReadonlySet<string> | null = null;
  private readonly documentUri: string | null;
  private readonly resolveText:
    | ((reference: string) => string | undefined)
    | undefined;
  private readonly resolveDocument:
    | ((reference: string) => Json | undefined)
    | undefined;

  constructor(private readonly options: EvalLoadOptions) {
    this.documentUri = options.documentUri ?? null;
    this.resolveText = options.resolveText;
    this.resolveDocument = options.resolveDocument;
  }

  load(document: Json): Eval | null {
    if (this.options.schema !== undefined) {
      const violations = new SchemaValidator(this.options.schema).errors(
        document
      );
      for (const violation of violations) {
        this.error(
          EvalDocCode.EvalInvalid,
          `${violation.code}: ${violation.message}`,
          violation.pointer.length === 0
            ? "#/"
            : `#/${violation.pointer.slice(1)}`
        );
      }
    }
    if (!isJsonObject(document)) {
      this.error(EvalDocCode.EvalInvalid, "Eval must be an object.", "#/");
      return null;
    }
    const id = this.readSafeId(fieldOf(document, "id"), "#/id", "eval id");
    const promptSet = this.readSafeId(
      fieldOf(document, "prompt_set"),
      "#/prompt_set",
      "prompt set id"
    );
    const task = this.readTask(fieldOf(document, "task"));
    const participantFiles = this.readParticipantFiles(
      fieldOf(document, "participant_files"),
      task === null || task.target === undefined ? undefined : task.target
    );
    const scope = this.readOperationScope(fieldOf(document, "operation_scope"));
    const cases = this.readCases(fieldOf(document, "cases"));
    const result = this.readResult(fieldOf(document, "result"));
    const rubric = this.readReference(
      fieldOf(document, "rubric"),
      "#/rubric",
      "rubric reference"
    );
    const scenario = this.readSafeId(
      fieldOf(document, "scenario"),
      "#/scenario",
      "scenario id"
    );
    if (
      id === null ||
      promptSet === null ||
      task === null ||
      participantFiles === null ||
      scope === null ||
      cases === null ||
      result === null ||
      rubric === null ||
      scenario === null
    ) {
      return null;
    }
    this.checkTaskSource(task);
    this.checkResultSchema(result);
    this.checkRubric(rubric);
    return {
      id,
      prompt_set: promptSet,
      task,
      ...(participantFiles === undefined
        ? {}
        : { participant_files: participantFiles }),
      operation_scope: scope,
      ...(cases === undefined ? {} : { cases }),
      result,
      rubric,
      scenario
    };
  }

  private readTask(value: Json | undefined): EvalTask | null {
    if (!isJsonObject(value)) {
      this.error(EvalDocCode.EvalInvalid, "task must be an object.", "#/task");
      return null;
    }
    const source = this.readReference(
      fieldOf(value, "source"),
      "#/task/source",
      "task source"
    );
    const engine = fieldOf(value, "engine");
    if (engine !== "literal" && engine !== "mustache-strict") {
      this.error(
        EvalDocCode.EvalInvalid,
        "task engine must be literal or mustache-strict.",
        "#/task/engine"
      );
      return null;
    }
    const target = fieldOf(value, "target");
    if (
      target !== undefined &&
      (typeof target !== "string" || !isSafeRelativePath(target))
    ) {
      this.error(
        EvalDocCode.EvalInvalid,
        "task target must be a safe relative path.",
        "#/task/target"
      );
      return null;
    }
    if (source === null) {
      return null;
    }
    return {
      source,
      engine,
      ...(target === undefined ? {} : { target })
    };
  }

  private readParticipantFiles(
    value: Json | undefined,
    taskTarget: string | undefined
  ): EvalParticipantFile[] | undefined | null {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "participant_files must be an array.",
        "#/participant_files"
      );
      return null;
    }
    const files: EvalParticipantFile[] = [];
    const targets = new Set<string>();
    if (taskTarget !== undefined) {
      targets.add(taskTarget);
    }
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const pointer = `#/participant_files/${index}`;
      if (!isJsonObject(raw)) {
        this.error(
          EvalDocCode.EvalInvalid,
          "A participant file must be an object.",
          pointer
        );
        continue;
      }
      const source = this.readReference(
        fieldOf(raw, "source"),
        `${pointer}/source`,
        "participant file source"
      );
      const target = fieldOf(raw, "target");
      if (typeof target !== "string" || !isSafeRelativePath(target)) {
        this.error(
          EvalDocCode.EvalInvalid,
          "A participant file target must be a safe relative path.",
          `${pointer}/target`
        );
        continue;
      }
      if (source === null) {
        continue;
      }
      this.checkTextReference(source, `${pointer}/source`, "participant file");
      if (targets.has(target)) {
        this.error(
          EvalDocCode.EvalInvalid,
          `Participant target ${JSON.stringify(target)} is declared twice.`,
          `${pointer}/target`
        );
        continue;
      }
      targets.add(target);
      files.push({ source, target });
    }
    return files;
  }

  private readOperationScope(value: Json | undefined): OperationScope | null {
    if (!isJsonObject(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "operation_scope must be an object.",
        "#/operation_scope"
      );
      return null;
    }
    const mode = fieldOf(value, "mode");
    if (mode === "all") {
      return { mode: "all" };
    }
    if (mode === "list") {
      const operations = fieldOf(value, "operations");
      if (!Array.isArray(operations) || operations.length === 0) {
        this.error(
          EvalDocCode.EvalInvalid,
          "A list scope needs at least one operation key.",
          "#/operation_scope/operations"
        );
        return null;
      }
      const keys: string[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < operations.length; index += 1) {
        const entry = operations[index];
        const pointer = `#/operation_scope/operations/${index}`;
        if (typeof entry !== "string" || !OPERATION_KEY_PATTERN.test(entry)) {
          this.error(
            EvalDocCode.EvalInvalid,
            `Operation key ${JSON.stringify(
              entry
            )} must look like "path:GET /widgets".`,
            pointer
          );
          continue;
        }
        if (seen.has(entry)) {
          this.error(
            EvalDocCode.EvalInvalid,
            `Duplicate operation key ${JSON.stringify(entry)}.`,
            pointer
          );
          continue;
        }
        seen.add(entry);
        keys.push(entry);
      }
      if (keys.length === 0) {
        return null;
      }
      return { mode: "list", operations: keys };
    }
    if (mode === "selector") {
      const selector = fieldOf(value, "selector");
      if (!isJsonObject(selector)) {
        this.error(
          EvalDocCode.EvalInvalid,
          "A selector scope needs a selector object.",
          "#/operation_scope/selector"
        );
        return null;
      }
      const kind = fieldOf(selector, "kind");
      if (kind === "tags") {
        const tags = this.readStringArray(
          fieldOf(selector, "tags"),
          "#/operation_scope/selector/tags"
        );
        if (tags === null) {
          return null;
        }
        return { mode: "selector", selector: { kind: "tags", tags } };
      }
      if (kind === "methods") {
        const methods = fieldOf(selector, "methods");
        if (!Array.isArray(methods) || methods.length === 0) {
          this.error(
            EvalDocCode.EvalInvalid,
            "A methods selector needs at least one uppercase method.",
            "#/operation_scope/selector/methods"
          );
          return null;
        }
        const names: string[] = [];
        for (let index = 0; index < methods.length; index += 1) {
          const entry = methods[index];
          if (typeof entry !== "string" || !HTTP_METHOD_PATTERN.test(entry)) {
            this.error(
              EvalDocCode.EvalInvalid,
              `Method ${JSON.stringify(entry)} must be uppercase letters.`,
              `#/operation_scope/selector/methods/${index}`
            );
            continue;
          }
          names.push(entry);
        }
        if (names.length === 0) {
          return null;
        }
        return {
          mode: "selector",
          selector: { kind: "methods", methods: names }
        };
      }
      this.error(
        EvalDocCode.EvalInvalid,
        "A selector kind must be tags or methods.",
        "#/operation_scope/selector/kind"
      );
      return null;
    }
    this.error(
      EvalDocCode.EvalInvalid,
      "operation_scope mode must be all, list, or selector.",
      "#/operation_scope/mode"
    );
    return null;
  }

  private readStringArray(
    value: Json | undefined,
    pointer: string
  ): string[] | null {
    if (!Array.isArray(value) || value.length === 0) {
      this.error(
        EvalDocCode.EvalInvalid,
        "The selector needs at least one non-empty string.",
        pointer
      );
      return null;
    }
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (typeof entry !== "string" || entry.length === 0) {
        this.error(
          EvalDocCode.EvalInvalid,
          "The selector entry must be a non-empty string.",
          `${pointer}/${index}`
        );
        continue;
      }
      entries.push(entry);
    }
    if (entries.length === 0) {
      return null;
    }
    return entries;
  }

  private readCases(value: Json | undefined): EvalCases | undefined | null {
    if (value === undefined) {
      return undefined;
    }
    if (!isJsonObject(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "cases must be an object.",
        "#/cases"
      );
      return null;
    }
    const source = this.readReference(
      fieldOf(value, "source"),
      "#/cases/source",
      "case source"
    );
    const schema = this.readReference(
      fieldOf(value, "schema"),
      "#/cases/schema",
      "case schema"
    );
    const idPointer = fieldOf(value, "id_pointer");
    if (
      typeof idPointer !== "string" ||
      idPointer.length === 0 ||
      !JSON_POINTER_PATTERN.test(idPointer)
    ) {
      this.error(
        EvalDocCode.EvalInvalid,
        "cases id_pointer must be a non-empty JSON Pointer.",
        "#/cases/id_pointer"
      );
      return null;
    }
    if (source === null || schema === null) {
      return null;
    }
    this.loadCaseLines(source, schema, idPointer);
    return { source, schema, id_pointer: idPointer };
  }

  /** Load the case lines, then record the shared case input keys. */
  private loadCaseLines(
    source: string,
    schema: string,
    idPointer: string
  ): void {
    if (this.resolveText === undefined) {
      return;
    }
    const text = this.resolveText(source);
    if (text === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `Case source ${JSON.stringify(source)} cannot be resolved.`,
        "#/cases/source"
      );
      return;
    }
    const result = loadEvalCases(text, {
      ...(this.options.caseSchema === undefined
        ? {}
        : { schema: this.options.caseSchema }),
      ...(this.documentUri === null
        ? {}
        : { documentUri: `${this.documentUri} ${source}` }),
      idPointer
    });
    this.diagnostics.push(...result.diagnostics);
    const broken = result.diagnostics.some(
      (entry) => entry.severity === "error"
    );
    if (broken) {
      this.failed = true;
      return;
    }
    this.caseCount = result.cases.length;
    this.caseInputKeys = sharedKeys(result.cases);
    this.checkCaseInputs(result.cases, schema);
  }

  /** Validate every case input against the referenced case schema. */
  private checkCaseInputs(cases: readonly EvalCase[], schema: string): void {
    if (this.resolveDocument === undefined) {
      return;
    }
    const document = this.resolveDocument(schema);
    if (document === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `Case schema ${JSON.stringify(schema)} cannot be resolved.`,
        "#/cases/schema"
      );
      return;
    }
    if (!isJsonObject(document)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "The case schema must be a JSON object.",
        "#/cases/schema"
      );
      return;
    }
    this.warnSchemaDraft(document, "#/cases/schema");
    const validator = new SchemaValidator(document);
    for (const oneCase of cases) {
      for (const violation of validator.errors(oneCase.input)) {
        this.error(
          EvalDocCode.EvalInvalid,
          `Case ${JSON.stringify(oneCase.id)} input: ${violation.code}: ${
            violation.message
          }`,
          "#/cases/schema"
        );
      }
    }
  }

  private readResult(value: Json | undefined): EvalResult | null {
    if (!isJsonObject(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "result must be an object.",
        "#/result"
      );
      return null;
    }
    const source = fieldOf(value, "source");
    if (source !== "adapter_final" && source !== "workspace_file") {
      this.error(
        EvalDocCode.EvalInvalid,
        "result source must be adapter_final or workspace_file.",
        "#/result/source"
      );
      return null;
    }
    const schema = this.readReference(
      fieldOf(value, "schema"),
      "#/result/schema",
      "result schema"
    );
    const required = fieldOf(value, "required");
    if (typeof required !== "boolean") {
      this.error(
        EvalDocCode.EvalInvalid,
        "result required must be a boolean.",
        "#/result/required"
      );
    }
    const filename = fieldOf(value, "filename");
    if (source === "workspace_file") {
      if (typeof filename !== "string" || filename.length === 0) {
        this.error(
          EvalDocCode.EvalInvalid,
          "A workspace_file result needs a filename.",
          "#/result/filename"
        );
      } else if (filename.includes("/") || !isSafeRelativePath(filename)) {
        this.error(
          EvalDocCode.EvalInvalid,
          `Result filename ${JSON.stringify(
            filename
          )} must be a safe file name without directories.`,
          "#/result/filename"
        );
      }
    } else if (filename !== undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        "An adapter_final result must not declare a filename.",
        "#/result/filename"
      );
    }
    if (schema === null || typeof required !== "boolean") {
      return null;
    }
    return {
      source,
      schema,
      required,
      ...(typeof filename === "string" && filename.length > 0
        ? { filename }
        : {})
    };
  }

  private readReference(
    value: Json | undefined,
    pointer: string,
    what: string
  ): string | null {
    if (typeof value !== "string" || value.length === 0) {
      this.error(
        EvalDocCode.EvalInvalid,
        `The ${what} must be a non-empty reference.`,
        pointer
      );
      return null;
    }
    if (!isSafeRelativePath(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        `The ${what} ${JSON.stringify(value)} must be a safe relative path.`,
        pointer
      );
      return null;
    }
    return value;
  }

  /** The task source must resolve, and a strict template must typecheck. */
  private checkTaskSource(task: EvalTask): void {
    if (this.resolveText === undefined) {
      return;
    }
    const text = this.resolveText(task.source);
    if (text === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `Task source ${JSON.stringify(task.source)} cannot be resolved.`,
        "#/task/source"
      );
      return;
    }
    if (task.engine !== "mustache-strict") {
      return;
    }
    for (const name of templateVariablesOf(text)) {
      if (TEMPLATE_VARIABLES.has(name)) {
        continue;
      }
      if (
        name.startsWith(CASE_INPUT_PREFIX) &&
        this.caseInputKeys?.has(name.slice(CASE_INPUT_PREFIX.length)) === true
      ) {
        continue;
      }
      this.error(
        EvalDocCode.EvalInvalid,
        `The task template references ${JSON.stringify(
          name
        )}, which no case or allowlist provides.`,
        "#/task/source"
      );
    }
  }

  private checkTextReference(
    reference: string,
    pointer: string,
    what: string
  ): void {
    if (this.resolveText === undefined) {
      return;
    }
    if (this.resolveText(reference) === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `The ${what} ${JSON.stringify(reference)} cannot be resolved.`,
        pointer
      );
    }
  }

  private checkResultSchema(result: EvalResult): void {
    if (this.resolveDocument === undefined) {
      return;
    }
    const document = this.resolveDocument(result.schema);
    if (document === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `Result schema ${JSON.stringify(result.schema)} cannot be resolved.`,
        "#/result/schema"
      );
      return;
    }
    if (!isJsonObject(document)) {
      this.error(
        EvalDocCode.EvalInvalid,
        "The result schema must be a JSON object.",
        "#/result/schema"
      );
      return;
    }
    this.warnSchemaDraft(document, "#/result/schema");
  }

  /** An inline rubric must compile with the rubric loader. */
  private checkRubric(reference: string): void {
    if (this.resolveDocument === undefined) {
      return;
    }
    const document = this.resolveDocument(reference);
    if (document === undefined) {
      this.error(
        EvalDocCode.EvalInvalid,
        `Rubric reference ${JSON.stringify(reference)} cannot be resolved.`,
        "#/rubric"
      );
      return;
    }
    const rubric = loadRubric(document, {
      ...(this.options.rubricSchema === undefined
        ? {}
        : { schema: this.options.rubricSchema }),
      resolveSchema: this.resolveDocument,
      ...(this.documentUri === null
        ? {}
        : { documentUri: `${this.documentUri} ${reference}` })
    });
    this.diagnostics.push(...rubric.diagnostics);
    if (rubric.rubric === null) {
      this.failed = true;
    }
  }

  private warnSchemaDraft(document: JsonObject, pointer: string): void {
    const declared = document["$schema"];
    if (
      typeof declared === "string" &&
      declared !== "https://json-schema.org/draft/2020-12/schema"
    ) {
      this.diagnostics.push(
        diagnostic({
          severity: "warning",
          phase: "compile",
          code: EvalDocCode.SchemaDraft,
          message: `Schema asset should declare Draft 2020-12, found ${declared}.`,
          document_uri: this.documentUri,
          json_pointer: pointer
        })
      );
    }
  }

  private readSafeId(
    value: Json | undefined,
    pointer: string,
    what: string
  ): string | null {
    if (typeof value !== "string" || !isSafeId(value)) {
      this.error(
        EvalDocCode.EvalInvalid,
        `The ${what} is not a safe identifier.`,
        pointer
      );
      return null;
    }
    return value;
  }

  private error(code: string, message: string, pointer: string): void {
    this.failed = true;
    this.diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "compile",
        code,
        message,
        document_uri: this.documentUri,
        json_pointer: pointer
      })
    );
  }
}

/** Keys present in the input object of every case. */
function sharedKeys(cases: readonly EvalCase[]): Set<string> {
  const shared = new Set<string>();
  for (let index = 0; index < cases.length; index += 1) {
    const input = cases[index]?.input ?? {};
    const keys = Object.keys(input);
    if (index === 0) {
      for (const key of keys) {
        shared.add(key);
      }
      continue;
    }
    for (const key of [...shared]) {
      if (!(key in input)) {
        shared.delete(key);
      }
    }
  }
  return shared;
}
