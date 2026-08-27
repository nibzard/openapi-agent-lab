import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJsonSha256,
  DiagnosticCode,
  diagnostic,
  invalidInput,
  isJsonObject,
  OalError,
  parseJsonStrict,
  resolveWithinRoot,
  sha256HexBytes,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import { PackCode } from "./codes.ts";
import { defaultSchemaDir, PackSchemaSet } from "./schemas.ts";
import { parsePackYaml } from "./yaml.ts";

/** Manifest file names accepted at the pack root, in preference order. */
export const PACK_MANIFEST_NAMES = ["pack.yaml", "pack.json"] as const;
export type PackManifestName = (typeof PACK_MANIFEST_NAMES)[number];

/**
 * Conventional location of the optional declarative semantic event registry.
 * The pack manifest schema version 1 has no field for it, so the loader
 * discovers the file here when it exists.
 */
export const SEMANTIC_REGISTRY_NAMES = [
  "events/registry.json",
  "events/registry.yaml"
] as const;

export type PackReferenceRole =
  | "contract_entrypoint"
  | "fixture_body"
  | "state_fixture"
  | "prompt_instructions"
  | "prompt_launch"
  | "task"
  | "result_schema"
  | "state_schema"
  | "case_source"
  | "case_schema"
  | "participant_file"
  | "rubric"
  | "behavior_entrypoint"
  | "payload_schema";

/** How the bytes behind a reference are interpreted. */
export type PackReferenceParse = "document" | "text" | "none";

export interface PackReference {
  readonly role: PackReferenceRole;
  /** JSON Pointer of the declaring node inside the manifest. */
  readonly pointer: string;
  /** Declared POSIX path relative to the pack root. */
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: number;
  /** SHA-256 over the original bytes. */
  readonly sha256: string;
  /** Parsed JSON or YAML value for document references. */
  readonly document: Json | null;
  /** Decoded UTF-8 text for text references. */
  readonly text: string | null;
}

export interface PackLoadOptions {
  /** Directory holding the `*.schema.json` documents. */
  readonly schemaDir?: string;
  readonly maxManifestBytes?: number;
  readonly maxArtifactBytes?: number;
}

export interface LoadedPack {
  /** Canonical absolute pack root. */
  readonly root: string;
  readonly manifestName: PackManifestName;
  readonly manifest: JsonObject;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly references: readonly PackReference[];
  readonly semanticEventRegistry: JsonObject | null;
  readonly schemaSet: PackSchemaSet;
  readonly diagnostics: Diagnostic[];
}

interface DeclaredReference {
  readonly role: PackReferenceRole;
  readonly pointer: string;
  readonly path: string;
  readonly parse: PackReferenceParse;
}

const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

function obj(value: Json | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function arr(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** Escape one JSON Pointer token. */
function token(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function at(pointer: string, key: string): string {
  return `${pointer}/${token(key)}`;
}

function atIndex(pointer: string, index: number): string {
  return `${pointer}/${index}`;
}

function error(
  code: string,
  message: string,
  options: { pointer?: string; uri?: string; details?: Json } = {}
): Diagnostic {
  return diagnostic({
    severity: "error",
    phase: "compile",
    code,
    message,
    ...(options.pointer === undefined ? {} : { json_pointer: options.pointer }),
    ...(options.uri === undefined ? {} : { document_uri: options.uri }),
    ...(options.details === undefined ? {} : { details: options.details })
  });
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Parse text into a JSON value, choosing strict JSON or safe YAML. */
export function parsePackDocument(
  text: string,
  source: string
): { value: Json | null; diagnostic: Diagnostic | null } {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        value: parseJsonStrict(text, { maxNodes: 200_000 }),
        diagnostic: null
      };
    } catch (cause) {
      return {
        value: null,
        diagnostic: error(
          DiagnosticCode.JsonInvalid,
          `${source} is not valid JSON: ${describe(cause)}`,
          { uri: source }
        )
      };
    }
  }
  try {
    return { value: parsePackYaml(text), diagnostic: null };
  } catch (cause) {
    return {
      value: null,
      diagnostic: error(
        DiagnosticCode.YamlInvalid,
        `${source} is not valid YAML: ${describe(cause)}`,
        { uri: source }
      )
    };
  }
}

/**
 * Locate, parse, and schema-validate the pack manifest, then load and validate
 * every file it references. Content failures come back as diagnostics; only a
 * missing pack directory, a missing manifest, or an ambiguous manifest throws.
 */
export async function loadPack(
  directory: string,
  options: PackLoadOptions = {}
): Promise<LoadedPack> {
  const root = path.resolve(directory);
  const rootStats = await stat(root).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory()) {
    throw invalidInput(
      PackCode.ManifestMissing,
      `Pack directory not found: ${root}`
    );
  }
  const schemaSet = await PackSchemaSet.load(
    options.schemaDir ?? defaultSchemaDir()
  );
  const maxManifestBytes =
    options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  const maxArtifactBytes =
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

  const diagnostics: Diagnostic[] = [];
  const name = await pickManifestName(root);
  if (name === null) {
    throw invalidInput(
      PackCode.ManifestMissing,
      `Pack directory has no pack.yaml or pack.json: ${root}`
    );
  }
  const manifestUri = path.join(root, name);
  const bytes = await readBounded(manifestUri, maxManifestBytes, diagnostics);
  const manifestSha256 = sha256HexBytes(bytes);
  const parsed = parsePackDocument(decode(bytes), manifestUri);
  if (parsed.diagnostic !== null) {
    diagnostics.push(parsed.diagnostic);
  }
  const manifest = obj(parsed.value);
  if (manifest === null) {
    diagnostics.push(
      error(PackCode.ContractInvalid, "Pack manifest must be a mapping.", {
        uri: manifestUri
      })
    );
    return {
      root,
      manifestName: name,
      manifest: {},
      manifestBytes: bytes.byteLength,
      manifestSha256,
      references: [],
      semanticEventRegistry: null,
      schemaSet,
      diagnostics
    };
  }

  for (const violation of schemaSet.validator("pack").errors(manifest)) {
    diagnostics.push(
      error(DiagnosticCode.PackSchemaInvalid, violation.message, {
        pointer: violation.pointer,
        uri: manifestUri
      })
    );
  }
  for (const item of arr(manifest["prompt_sets"])) {
    for (const violation of schemaSet.validator("prompt-set").errors(item)) {
      diagnostics.push(
        error(DiagnosticCode.PackSchemaInvalid, violation.message, {
          pointer: violation.pointer,
          uri: manifestUri
        })
      );
    }
  }
  for (const item of arr(manifest["evals"])) {
    for (const violation of schemaSet.validator("eval").errors(item)) {
      diagnostics.push(
        error(DiagnosticCode.PackSchemaInvalid, violation.message, {
          pointer: violation.pointer,
          uri: manifestUri
        })
      );
    }
  }

  const references = await loadReferences(
    root,
    manifest,
    maxArtifactBytes,
    diagnostics
  );
  const semanticEventRegistry = await loadSemanticRegistry(
    root,
    manifest,
    maxArtifactBytes,
    schemaSet,
    diagnostics
  );

  return {
    root,
    manifestName: name,
    manifest,
    manifestBytes: bytes.byteLength,
    manifestSha256,
    references,
    semanticEventRegistry,
    schemaSet,
    diagnostics
  };
}

async function pickManifestName(
  root: string
): Promise<PackManifestName | null> {
  const present: PackManifestName[] = [];
  for (const candidate of PACK_MANIFEST_NAMES) {
    const stats = await stat(path.join(root, candidate)).catch(() => null);
    if (stats !== null && stats.isFile()) {
      present.push(candidate);
    }
  }
  if (present.length > 1) {
    throw invalidInput(
      PackCode.ManifestAmbiguous,
      `Pack directory has both pack.yaml and pack.json: ${root}`
    );
  }
  return present[0] ?? null;
}

async function readBounded(
  absolutePath: string,
  maxBytes: number,
  diagnostics: Diagnostic[]
): Promise<Uint8Array> {
  const bytes = await readFile(absolutePath).catch(() => null);
  if (bytes === null) {
    diagnostics.push(
      error(DiagnosticCode.InputMissing, `File not found: ${absolutePath}`, {
        uri: absolutePath
      })
    );
    return new Uint8Array(0);
  }
  if (bytes.byteLength > maxBytes) {
    diagnostics.push(
      error(
        DiagnosticCode.InputTooLarge,
        `File exceeds the ${maxBytes} byte limit (${bytes.byteLength} bytes): ${absolutePath}`,
        { uri: absolutePath }
      )
    );
  }
  return bytes;
}

/** Enumerate every relative path the manifest declares. */
export function collectDeclaredReferences(
  manifest: JsonObject
): DeclaredReference[] {
  const declared: DeclaredReference[] = [];
  const push = (
    role: PackReferenceRole,
    pointer: string,
    value: Json | undefined,
    parse: PackReferenceParse
  ): void => {
    const target = str(value);
    if (target !== null) {
      declared.push({ role, pointer, path: target, parse });
    }
  };

  const contract = obj(manifest["contract"]);
  if (contract !== null) {
    push(
      "contract_entrypoint",
      at("/contract", "entrypoint"),
      contract["entrypoint"],
      "document"
    );
    const fixtures = arr(contract["response_fixtures"]);
    for (let i = 0; i < fixtures.length; i += 1) {
      const fixture = obj(fixtures[i]);
      const body = fixture === null ? null : obj(fixture["body"]);
      if (body === null) {
        continue;
      }
      const kind = str(body["kind"]);
      push(
        "fixture_body",
        `${atIndex(at("/contract", "response_fixtures"), i)}/body`,
        body["source"],
        kind === "json_file" ? "document" : "none"
      );
    }
  }

  const behavior = obj(manifest["behavior"]);
  if (behavior !== null) {
    const backend = obj(behavior["backend"]);
    if (backend !== null) {
      push(
        "behavior_entrypoint",
        `${at("/behavior", "backend")}/entrypoint`,
        backend["entrypoint"],
        "text"
      );
    }
    push(
      "state_schema",
      at("/behavior", "state_schema"),
      behavior["state_schema"],
      "document"
    );
    const fixtures = arr(behavior["fixtures"]);
    for (let i = 0; i < fixtures.length; i += 1) {
      push(
        "state_fixture",
        atIndex(at("/behavior", "fixtures"), i),
        fixtures[i],
        "document"
      );
    }
  }

  const promptSets = arr(manifest["prompt_sets"]);
  for (let i = 0; i < promptSets.length; i += 1) {
    const set = obj(promptSets[i]);
    if (set === null) {
      continue;
    }
    const instructions = obj(set["instructions"]);
    if (instructions !== null) {
      push(
        "prompt_instructions",
        `${atIndex("/prompt_sets", i)}/instructions`,
        instructions["source"],
        "text"
      );
    }
    const launch = obj(set["launch"]);
    if (launch !== null) {
      push(
        "prompt_launch",
        `${atIndex("/prompt_sets", i)}/launch`,
        launch["source"],
        "text"
      );
    }
  }

  const evals = arr(manifest["evals"]);
  for (let i = 0; i < evals.length; i += 1) {
    const evaluation = obj(evals[i]);
    if (evaluation === null) {
      continue;
    }
    const base = atIndex("/evals", i);
    const task = obj(evaluation["task"]);
    if (task !== null) {
      push("task", `${base}/task`, task["source"], "text");
    }
    const files = arr(evaluation["participant_files"]);
    for (let j = 0; j < files.length; j += 1) {
      const file = obj(files[j]);
      if (file === null) {
        continue;
      }
      push(
        "participant_file",
        atIndex(`${base}/participant_files`, j),
        file["source"],
        "text"
      );
    }
    const cases = obj(evaluation["cases"]);
    if (cases !== null) {
      push("case_source", `${base}/cases`, cases["source"], "text");
      push("case_schema", `${base}/cases`, cases["schema"], "document");
    }
    const result = obj(evaluation["result"]);
    if (result !== null) {
      push("result_schema", `${base}/result`, result["schema"], "document");
    }
    push("rubric", base, evaluation["rubric"], "document");
  }

  const scenarios = arr(manifest["scenarios"]);
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = obj(scenarios[i]);
    if (scenario === null) {
      continue;
    }
    const fixtures = arr(scenario["fixtures"]);
    for (let j = 0; j < fixtures.length; j += 1) {
      push(
        "state_fixture",
        atIndex(`${atIndex("/scenarios", i)}/fixtures`, j),
        fixtures[j],
        "document"
      );
    }
  }

  return declared;
}

async function loadReferences(
  root: string,
  manifest: JsonObject,
  maxBytes: number,
  diagnostics: Diagnostic[]
): Promise<PackReference[]> {
  const loaded: PackReference[] = [];
  const cache = new Map<string, PackReference>();
  for (const declared of collectDeclaredReferences(manifest)) {
    const cacheKey = `${declared.parse} ${declared.path}`;
    const cached = cache.get(cacheKey);
    const reference =
      cached === undefined
        ? await loadOne(root, declared, maxBytes, diagnostics)
        : { ...cached, role: declared.role, pointer: declared.pointer };
    if (cached === undefined) {
      cache.set(cacheKey, reference);
    }
    loaded.push(reference);
    if (declared.role === "contract_entrypoint") {
      checkContractDocument(reference, diagnostics);
    }
    if (
      declared.role === "result_schema" ||
      declared.role === "state_schema" ||
      declared.role === "case_schema"
    ) {
      checkSchemaDocument(reference, diagnostics);
    }
  }
  return loaded;
}

async function loadOne(
  root: string,
  declared: DeclaredReference,
  maxBytes: number,
  diagnostics: Diagnostic[]
): Promise<PackReference> {
  const base: PackReference = {
    role: declared.role,
    pointer: declared.pointer,
    path: declared.path,
    absolutePath: "",
    bytes: 0,
    sha256: "",
    document: null,
    text: null
  };
  let absolutePath: string;
  try {
    absolutePath = await resolveWithinRoot(root, declared.path, "pack asset");
  } catch (cause) {
    const missing =
      cause instanceof OalError && cause.code === DiagnosticCode.RefNotFound;
    diagnostics.push(
      error(
        missing ? PackCode.AssetNotFile : PackCode.PathUnsafe,
        `${describe(cause)} (${declared.path})`,
        { pointer: declared.pointer, details: { path: declared.path } }
      )
    );
    return base;
  }
  const stats = await stat(absolutePath).catch(() => null);
  if (stats === null || !stats.isFile()) {
    diagnostics.push(
      error(
        PackCode.AssetNotFile,
        `Pack asset is not a regular file: ${declared.path}`,
        { pointer: declared.pointer, details: { path: declared.path } }
      )
    );
    return { ...base, absolutePath };
  }
  const bytes = await readFile(absolutePath).catch(() => null);
  if (bytes === null) {
    diagnostics.push(
      error(
        PackCode.AssetMissing,
        `Pack asset could not be read: ${declared.path}`,
        { pointer: declared.pointer, details: { path: declared.path } }
      )
    );
    return { ...base, absolutePath };
  }
  if (bytes.byteLength > maxBytes) {
    diagnostics.push(
      error(
        PackCode.AssetTooLarge,
        `Pack asset exceeds the ${maxBytes} byte limit (${bytes.byteLength} bytes): ${declared.path}`,
        { pointer: declared.pointer, details: { path: declared.path } }
      )
    );
    return { ...base, absolutePath };
  }
  let document: Json | null = null;
  let text: string | null = null;
  if (declared.parse === "document") {
    const parsed = parsePackDocument(decode(bytes), declared.path);
    if (parsed.diagnostic !== null) {
      diagnostics.push(
        error(parsed.diagnostic.code, parsed.diagnostic.message, {
          pointer: declared.pointer,
          details: { path: declared.path }
        })
      );
    }
    document = parsed.value;
  } else if (declared.parse === "text") {
    text = decode(bytes);
  }
  return {
    role: declared.role,
    pointer: declared.pointer,
    path: declared.path,
    absolutePath,
    bytes: bytes.byteLength,
    sha256: sha256HexBytes(bytes),
    document,
    text
  };
}

function checkContractDocument(
  reference: PackReference,
  diagnostics: Diagnostic[]
): void {
  const document = obj(reference.document);
  if (document === null) {
    diagnostics.push(
      error(
        PackCode.ContractInvalid,
        "Contract entrypoint must be a document.",
        { pointer: reference.pointer }
      )
    );
    return;
  }
  const version = str(document["openapi"]);
  if (version === null || !version.startsWith("3.")) {
    diagnostics.push(
      error(
        PackCode.ContractInvalid,
        "Contract entrypoint must declare an OpenAPI 3.x version.",
        { pointer: reference.pointer }
      )
    );
    return;
  }
  if (!isJsonObject(document["paths"])) {
    diagnostics.push(
      error(
        PackCode.ContractInvalid,
        "Contract entrypoint must declare paths.",
        { pointer: reference.pointer }
      )
    );
  }
}

function checkSchemaDocument(
  reference: PackReference,
  diagnostics: Diagnostic[]
): void {
  const document = obj(reference.document);
  if (document === null) {
    diagnostics.push(
      error(PackCode.ContractInvalid, "Schema asset must be an object.", {
        pointer: reference.pointer
      })
    );
    return;
  }
  const declared = str(document["$schema"]);
  if (
    declared !== null &&
    declared !== "https://json-schema.org/draft/2020-12/schema"
  ) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "compile",
        code: PackCode.SchemaDraft,
        message: `Schema asset should declare Draft 2020-12, found ${declared}.`,
        json_pointer: reference.pointer
      })
    );
  }
}

async function loadSemanticRegistry(
  root: string,
  manifest: JsonObject,
  maxBytes: number,
  schemaSet: PackSchemaSet,
  diagnostics: Diagnostic[]
): Promise<JsonObject | null> {
  let name: string | null = null;
  for (const candidate of SEMANTIC_REGISTRY_NAMES) {
    const stats = await stat(path.join(root, candidate)).catch(() => null);
    if (stats !== null && stats.isFile()) {
      name = candidate;
      break;
    }
  }
  if (name === null) {
    return null;
  }
  const bytes = await readFile(path.join(root, name)).catch(() => null);
  if (bytes === null) {
    return null;
  }
  if (bytes.byteLength > maxBytes) {
    diagnostics.push(
      error(
        PackCode.AssetTooLarge,
        `Semantic event registry exceeds the ${maxBytes} byte limit: ${name}`,
        { uri: name }
      )
    );
    return null;
  }
  const parsed = parsePackDocument(decode(bytes), name);
  if (parsed.diagnostic !== null) {
    diagnostics.push(parsed.diagnostic);
    return null;
  }
  const registry = obj(parsed.value);
  if (registry === null) {
    diagnostics.push(
      error(
        PackCode.ContractInvalid,
        "Semantic event registry must be a mapping.",
        { uri: name }
      )
    );
    return null;
  }
  for (const violation of schemaSet
    .validator("semantic-event-registry")
    .errors(registry)) {
    diagnostics.push(
      error(DiagnosticCode.PackSchemaInvalid, violation.message, {
        pointer: violation.pointer,
        uri: name
      })
    );
  }
  const metadata = obj(manifest["metadata"]);
  const packId = metadata === null ? null : str(metadata["id"]);
  const registryPack = str(registry["pack_id"]);
  if (packId !== null && registryPack !== null && packId !== registryPack) {
    diagnostics.push(
      error(
        PackCode.RegistryPackMismatch,
        `Semantic event registry declares pack ${registryPack}, manifest declares ${packId}.`,
        { uri: name, details: { registry: registryPack, manifest: packId } }
      )
    );
  }
  await loadRegistryPayloadSchemas(root, registry, maxBytes, diagnostics);
  return registry;
}

async function loadRegistryPayloadSchemas(
  root: string,
  registry: JsonObject,
  maxBytes: number,
  diagnostics: Diagnostic[]
): Promise<void> {
  const events = arr(registry["events"]);
  for (let i = 0; i < events.length; i += 1) {
    const event = obj(events[i]);
    if (event === null) {
      continue;
    }
    const pointer = `/events/${i}`;
    const declared = str(event["payload_schema"]);
    const expected = str(event["payload_schema_sha256"]);
    if (declared === null || expected === null) {
      continue;
    }
    const reference = await loadOne(
      root,
      { role: "payload_schema", pointer, path: declared, parse: "document" },
      maxBytes,
      diagnostics
    );
    if (reference.sha256 === "") {
      continue;
    }
    if (reference.sha256 !== expected) {
      diagnostics.push(
        error(
          PackCode.RegistryDigestMismatch,
          `Payload schema digest for ${declared} is ${reference.sha256}, registry pins ${expected}.`,
          { pointer, details: { path: declared, found: reference.sha256 } }
        )
      );
    }
    if (reference.document !== null && !isJsonObject(reference.document)) {
      diagnostics.push(
        error(
          PackCode.ContractInvalid,
          `Payload schema must be an object: ${declared}`,
          { pointer }
        )
      );
    }
  }
}

/** Canonical JSON digest of a parsed artifact, used for stability checks. */
export function referenceDigest(reference: PackReference): string | null {
  if (reference.document !== null) {
    return canonicalJsonSha256(reference.document);
  }
  if (reference.text !== null) {
    return reference.sha256;
  }
  return null;
}
