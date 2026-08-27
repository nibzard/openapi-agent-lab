/**
 * Prompt materialization (specification section 19.1). The runner, not an
 * adapter, renders the three prompt roles and plans every participant file.
 * Nothing implicit is added: an absent instructions, task, or launch
 * declaration is a failure, never a default.
 */

import {
  assertSafeRelativePath,
  canonicalJsonSha256,
  invalidInput,
  isJsonObject,
  type JsonObject
} from "@oal/core";
import type { LoadedPack, PackReference } from "@oal/pack";

import {
  renderTemplate,
  type RenderedTemplate,
  type TemplateContext,
  type TemplateEngine
} from "./template.ts";

/** Stable error codes of the prompt module. */
export const PromptCode = {
  PromptSetUnknown: "OAL-RUN-PROMPT-SET-UNKNOWN",
  EvalUnknown: "OAL-RUN-EVAL-UNKNOWN",
  PromptSetMismatch: "OAL-RUN-PROMPT-SET-MISMATCH",
  DeclarationMissing: "OAL-RUN-PROMPT-DECLARATION-MISSING",
  SourceMissing: "OAL-RUN-PROMPT-SOURCE-MISSING",
  SourceHidden: "OAL-RUN-PROMPT-SOURCE-HIDDEN",
  TargetUnsafe: "OAL-RUN-PROMPT-TARGET-UNSAFE",
  TargetDuplicate: "OAL-RUN-PROMPT-TARGET-DUPLICATE",
  EngineUnknown: "OAL-RUN-PROMPT-ENGINE-UNKNOWN"
} as const;

/** The three prompt roles of specification section 19.1. */
export type PromptRole = "instructions" | "task" | "launch";

export type PurposeDisclosure = "diagnostic" | "naturalistic";

/** Where one planned workspace file comes from. */
export type WorkspaceFileOrigin =
  | "prompt"
  | "participant-file"
  | "contract"
  | "result-schema";

/**
 * One intended workspace file. An entry either carries rendered text or
 * names a pack source that is copied byte for byte.
 */
export interface WorkspaceFilePlan {
  /** Safe path relative to the workspace root. */
  readonly target: string;
  readonly origin: WorkspaceFileOrigin;
  /** Pack-relative source path, or null for runner-generated content. */
  readonly source: string | null;
  /** Absolute path of the pack file to copy. Null for rendered entries. */
  readonly sourcePath: string | null;
  /** Rendered text. Null means byte-for-byte copy. */
  readonly text: string | null;
  /** Engine the entry declared, or null for a byte-for-byte copy. */
  readonly engine: TemplateEngine | null;
  readonly bytes: number;
  readonly sha256: string;
}

/** One rendered prompt role. */
export interface RenderedPrompt extends RenderedTemplate {
  readonly role: PromptRole;
  /** Pack-relative source path. */
  readonly source: string;
  /** Workspace target, or null when the role is delivered inline. */
  readonly target: string | null;
}

/** Frozen result of one prompt set plus one eval. */
export interface MaterializedPrompts {
  readonly promptSetId: string;
  readonly purposeDisclosure: PurposeDisclosure;
  readonly evalId: string;
  readonly prompts: Readonly<Record<PromptRole, RenderedPrompt>>;
  /** Workspace plan in resolution order. */
  readonly files: readonly WorkspaceFilePlan[];
  /** Digest of the frozen rendered set, without the rendered text itself. */
  readonly frozenSha256: string;
}

export interface MaterializePromptsOptions {
  readonly pack: LoadedPack;
  readonly promptSetId: string;
  readonly evalId: string;
  readonly context: TemplateContext;
}

/** Pack reference roles the participant must never receive. */
const HIDDEN_ROLES: readonly string[] = [
  "rubric",
  "state_fixture",
  "state_schema",
  "fixture_body",
  "behavior_entrypoint",
  "case_source",
  "case_schema",
  "payload_schema"
];

/** Optional flag that lets two declarations share one target. */
const ALLOW_DUPLICATE_KEY = "allow_duplicate_target";

/** Default task target, matching the PackIR builder. */
const DEFAULT_TASK_TARGET = "TASK.md";

const PROMPT_ROLES: readonly PromptRole[] = ["instructions", "task", "launch"];

/**
 * Materialize one prompt set and one eval in the fixed order: prompt set
 * files, then the eval task, then eval participant files. A duplicate
 * target is fatal unless both declarations set
 * `allow_duplicate_target: true` and the source bytes are identical.
 */
export function materializePrompts(
  options: MaterializePromptsOptions
): MaterializedPrompts {
  const manifest = options.pack.manifest;
  const set = findPromptSet(manifest, options.promptSetId);
  const evaluation = findEval(manifest, options.evalId);
  const declaredSet = textOf(evaluation, "prompt_set");
  if (declaredSet !== options.promptSetId) {
    throw invalidInput(
      PromptCode.PromptSetMismatch,
      `Eval ${options.evalId} declares prompt set ${declaredSet}, not ${options.promptSetId}.`,
      { eval: options.evalId, declared: declaredSet }
    );
  }

  const instructionsNode = objectOf(set, "instructions");
  if (instructionsNode === null) {
    throw declarationMissing("prompt set instructions", options.promptSetId);
  }
  const launchNode = objectOf(set, "launch");
  if (launchNode === null) {
    throw declarationMissing("prompt set launch", options.promptSetId);
  }
  const taskNode = objectOf(evaluation, "task");
  if (taskNode === null) {
    throw declarationMissing("eval task", options.evalId);
  }

  const instructionsSource = sourceOf(instructionsNode, "instructions");
  const launchSource = sourceOf(launchNode, "launch");
  const taskSource = sourceOf(taskNode, "task");
  const instructionsEngine = engineOf(instructionsNode, "instructions");
  const launchEngine = engineOf(launchNode, "launch");
  const taskEngine = engineOf(taskNode, "task");
  const delivery = textOf(instructionsNode, "delivery") ?? "inline";
  const instructionsTarget = textOf(instructionsNode, "target");
  if (delivery === "file" && instructionsTarget === null) {
    throw declarationMissing(
      "prompt set instructions target",
      options.promptSetId
    );
  }
  const taskTarget = textOf(taskNode, "target") ?? DEFAULT_TASK_TARGET;

  const context = options.context;
  const prompts = Object.freeze({
    instructions: renderRole(
      "instructions",
      instructionsEngine,
      "prompt set instructions",
      instructionsSource,
      delivery === "file" ? instructionsTarget : null,
      options.pack,
      context
    ),
    task: renderRole(
      "task",
      taskEngine,
      "eval task",
      taskSource,
      taskTarget,
      options.pack,
      context
    ),
    launch: renderRole(
      "launch",
      launchEngine,
      "prompt set launch",
      launchSource,
      null,
      options.pack,
      context
    )
  }) as Readonly<Record<PromptRole, RenderedPrompt>>;

  const plan = new PlanBuilder(options.pack, context);
  const resultNode = objectOf(evaluation, "result");
  const resultSchema =
    resultNode === null ? null : textOf(resultNode, "schema");

  // Step 2: the files the prompt set declares.
  if (delivery === "file" && instructionsTarget !== null) {
    plan.add(
      instructionsSource,
      instructionsTarget,
      instructionsEngine,
      "prompt set instructions",
      "prompt",
      instructionsNode[ALLOW_DUPLICATE_KEY] === true
    );
  }
  for (const node of listOf(set, "participant_files")) {
    plan.add(
      textOf(node, "source"),
      textOf(node, "target"),
      optionalEngine(node, "prompt set file"),
      "prompt set participant file",
      "participant-file",
      node[ALLOW_DUPLICATE_KEY] === true
    );
  }

  // Step 3: the eval task at its declared target.
  plan.add(
    taskSource,
    taskTarget,
    taskEngine,
    "eval task",
    "prompt",
    taskNode[ALLOW_DUPLICATE_KEY] === true
  );

  // Step 4: eval participant files.
  for (const node of listOf(evaluation, "participant_files")) {
    plan.add(
      textOf(node, "source"),
      textOf(node, "target"),
      optionalEngine(node, "eval participant file"),
      "eval participant file",
      "participant-file",
      node[ALLOW_DUPLICATE_KEY] === true
    );
  }

  const files = plan.build(resultSchema);
  const purpose =
    textOf(set, "purpose_disclosure") === "naturalistic"
      ? "naturalistic"
      : "diagnostic";
  const frozen: JsonObject = {
    prompt_set: { id: options.promptSetId, purpose_disclosure: purpose },
    eval: { id: options.evalId },
    prompts: PROMPT_ROLES.map((role) => {
      const prompt = prompts[role];
      return {
        role,
        engine: prompt.engine,
        source: prompt.source,
        target: prompt.target,
        source_sha256: prompt.sourceSha256,
        rendered_sha256: prompt.renderedSha256
      };
    }),
    files: files.map((file) => ({
      target: file.target,
      origin: file.origin,
      source: file.source,
      engine: file.engine,
      bytes: file.bytes,
      sha256: file.sha256
    }))
  };
  return Object.freeze({
    promptSetId: options.promptSetId,
    purposeDisclosure: purpose,
    evalId: options.evalId,
    prompts,
    files: Object.freeze(files),
    frozenSha256: canonicalJsonSha256(frozen)
  });
}

interface FileDeclaration {
  readonly target: string;
  readonly source: string;
  readonly reference: PackReference;
  readonly allowDuplicate: boolean;
  readonly origin: WorkspaceFileOrigin;
  readonly engine: TemplateEngine | null;
  /** Human label used in error messages. */
  readonly label: string;
}

/** Collects file declarations in resolution order and rejects conflicts. */
class PlanBuilder {
  private readonly declared: FileDeclaration[] = [];
  private readonly byTarget = new Map<string, FileDeclaration>();

  constructor(
    private readonly pack: LoadedPack,
    private readonly context: TemplateContext
  ) {}

  add(
    source: string | null,
    target: string | null,
    engine: TemplateEngine | null,
    label: string,
    origin: WorkspaceFileOrigin,
    allowDuplicate: boolean
  ): void {
    if (source === null || target === null) {
      throw declarationMissing(`${label} source or target`, "the declaration");
    }
    const reference = this.referenceFor(source, label);
    assertSafeTarget(target, label);
    const previous = this.byTarget.get(target);
    if (previous !== undefined) {
      if (
        !previous.allowDuplicate ||
        !allowDuplicate ||
        previous.reference.sha256 !== reference.sha256
      ) {
        throw invalidInput(
          PromptCode.TargetDuplicate,
          `Two declarations write the same target ${target}: ${previous.label} and ${label}.`,
          { target, first: previous.label, second: label }
        );
      }
      // Both declarations allow it and the bytes are identical, so the
      // target keeps its first plan entry.
      return;
    }
    const declaration: FileDeclaration = {
      target,
      source,
      reference,
      allowDuplicate,
      origin,
      engine,
      label
    };
    this.byTarget.set(target, declaration);
    this.declared.push(declaration);
  }

  build(resultSchema: string | null): WorkspaceFilePlan[] {
    return this.declared.map((declaration) => {
      const origin: WorkspaceFileOrigin =
        resultSchema !== null && declaration.source === resultSchema
          ? "result-schema"
          : declaration.origin;
      if (declaration.engine === null) {
        return Object.freeze({
          target: declaration.target,
          origin,
          source: declaration.source,
          sourcePath: declaration.reference.absolutePath,
          text: null,
          engine: null,
          bytes: declaration.reference.bytes,
          sha256: declaration.reference.sha256
        });
      }
      const source = declaration.reference.text;
      if (source === null) {
        throw invalidInput(
          PromptCode.SourceMissing,
          `${declaration.label} source did not load as text: ${declaration.source}.`,
          { source: declaration.source }
        );
      }
      const rendered = renderTemplate({
        name: declaration.label,
        engine: declaration.engine,
        source,
        context: this.context
      });
      return Object.freeze({
        target: declaration.target,
        origin,
        source: declaration.source,
        sourcePath: null,
        text: rendered.text,
        engine: declaration.engine,
        bytes: byteLength(rendered.text),
        sha256: rendered.renderedSha256
      });
    });
  }

  private referenceFor(source: string, label: string): PackReference {
    const hidden = this.pack.references.find(
      (entry) => entry.path === source && HIDDEN_ROLES.includes(entry.role)
    );
    if (hidden !== undefined) {
      throw invalidInput(
        PromptCode.SourceHidden,
        `${label} source is hidden pack material (${hidden.role}): ${source}.`,
        { source, role: hidden.role }
      );
    }
    const reference = this.pack.references.find(
      (entry) => entry.path === source && entry.text !== null
    );
    if (reference === undefined) {
      throw invalidInput(
        PromptCode.SourceMissing,
        `${label} source is not a loaded text file: ${source}.`,
        { source }
      );
    }
    return reference;
  }
}

function renderRole(
  role: PromptRole,
  engine: TemplateEngine,
  label: string,
  source: string,
  target: string | null,
  pack: LoadedPack,
  context: TemplateContext
): RenderedPrompt {
  const hidden = pack.references.find(
    (entry) => entry.path === source && HIDDEN_ROLES.includes(entry.role)
  );
  if (hidden !== undefined) {
    throw invalidInput(
      PromptCode.SourceHidden,
      `${label} source is hidden pack material (${hidden.role}): ${source}.`,
      { source, role: hidden.role }
    );
  }
  const reference = pack.references.find(
    (entry) => entry.path === source && entry.text !== null
  );
  if (reference === undefined || reference.text === null) {
    throw invalidInput(
      PromptCode.SourceMissing,
      `${label} source is not a loaded text file: ${source}.`,
      { source }
    );
  }
  const rendered = renderTemplate({
    name: label,
    engine,
    source: reference.text,
    context
  });
  return Object.freeze({
    role,
    engine: rendered.engine,
    name: rendered.name,
    text: rendered.text,
    variables: rendered.variables,
    source,
    target,
    sourceSha256: rendered.sourceSha256,
    renderedSha256: rendered.renderedSha256
  });
}

function assertSafeTarget(target: string, label: string): void {
  try {
    assertSafeRelativePath(target, `${label} target`);
  } catch (cause) {
    throw invalidInput(
      PromptCode.TargetUnsafe,
      cause instanceof Error ? cause.message : `${label} target is unsafe.`,
      { target, label }
    );
  }
}

function findPromptSet(manifest: JsonObject, id: string): JsonObject {
  for (const entry of listOf(manifest, "prompt_sets")) {
    if (textOf(entry, "id") === id) {
      return entry;
    }
  }
  throw invalidInput(
    PromptCode.PromptSetUnknown,
    `Pack declares no prompt set ${id}.`,
    { prompt_set: id }
  );
}

function findEval(manifest: JsonObject, id: string): JsonObject {
  for (const entry of listOf(manifest, "evals")) {
    if (textOf(entry, "id") === id) {
      return entry;
    }
  }
  throw invalidInput(PromptCode.EvalUnknown, `Pack declares no eval ${id}.`, {
    eval: id
  });
}

function declarationMissing(what: string, owner: string): Error {
  return invalidInput(
    PromptCode.DeclarationMissing,
    `No ${what} is declared for ${owner}. The runner adds none implicitly.`,
    { what, owner }
  );
}

function sourceOf(node: JsonObject, label: string): string {
  const source = textOf(node, "source");
  if (source === null) {
    throw declarationMissing(`${label} source`, "the declaration");
  }
  return source;
}

function engineOf(node: JsonObject, label: string): TemplateEngine {
  const engine = textOf(node, "engine");
  if (engine !== "literal" && engine !== "mustache-strict") {
    throw invalidInput(
      PromptCode.EngineUnknown,
      `${label} must declare engine literal or mustache-strict, found ${engine}.`,
      { engine, label }
    );
  }
  return engine;
}

function optionalEngine(
  node: JsonObject,
  label: string
): TemplateEngine | null {
  const engine = textOf(node, "engine");
  if (engine === null) {
    return null;
  }
  if (engine !== "literal" && engine !== "mustache-strict") {
    throw invalidInput(
      PromptCode.EngineUnknown,
      `${label} must declare engine literal or mustache-strict, found ${engine}.`,
      { engine, label }
    );
  }
  return engine;
}

function objectOf(node: JsonObject, key: string): JsonObject | null {
  const value = node[key];
  return isJsonObject(value) ? value : null;
}

/** Objects of one manifest array field; other element types are dropped. */
function listOf(node: JsonObject, key: string): readonly JsonObject[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject);
}

function textOf(node: JsonObject, key: string): string | null {
  const value = node[key];
  return typeof value === "string" ? value : null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
