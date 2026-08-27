/**
 * Helpers for the Steel parity suite (specification section 39.5).
 *
 * Parity here means the migrated pack validates against the source
 * contract `examples/steel-v1.json` and keeps every behavior that pack
 * version 0.1.0 can express. There is no old implementation to diff
 * against, so these helpers rebuild both sides: the source contract and
 * the pack contract compile through the same OpenAPI compiler, and the
 * scripted request set replays every operation through the pure gateway
 * pipeline. See packs/steel-computer/PARITY.md for the coverage record.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { LIMIT_DEFAULTS } from "@oal/config";
import {
  isJsonObject,
  sha256HexBytes,
  type Json,
  type JsonObject
} from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";
import {
  handleGatewayRequest,
  mintRunCredentials,
  type ContractFixture,
  type GatewayOptions,
  type GatewayResponse,
  type RawRequest
} from "@oal/gateway";
import { compileOpenApi, type CompileResult } from "@oal/openapi";
import type { PackReference } from "@oal/pack";

import { findRepoRoot } from "./index.ts";

/** Repository path of the source contract, the parity reference. */
export const STEEL_SOURCE_CONTRACT = "examples/steel-v1.json";

/**
 * Fixed run seed. The gateway derives every synthetic credential and
 * every generated response value from it, so a fixed seed keeps the
 * golden trace byte-stable without a clock or a random source.
 */
export const PARITY_RUN_SEED = "steel-parity-0.1.0";

/**
 * Fixed path parameter values for the scripted request set. The nil
 * UUID satisfies the UUID pattern that the direct session routes
 * declare on their `id` parameter.
 */
export const PARITY_PATH_VALUES: Readonly<Record<string, string>> = {
  id: "00000000-0000-0000-0000-000000000000",
  sessionId: "00000000-0000-0000-0000-000000000000",
  extensionId: "extension-1",
  path: "brief.txt"
};

/** The API key scheme name declared by the source contract. */
export const STEEL_API_KEY_SCHEME = "apiKey";

/** Header name the API key scheme declares. */
export const STEEL_API_KEY_HEADER = "steel-api-key";

/**
 * Compile the source Steel v1 contract from the repository root. The
 * compile runs on the raw published bytes, including the `servers` key
 * that the pack copy drops (migration note drift item 15).
 */
export async function compileSteelSourceContract(
  root = findRepoRoot()
): Promise<CompileResult> {
  const absolute = path.join(root, STEEL_SOURCE_CONTRACT);
  const documents: Record<string, string> = {
    [STEEL_SOURCE_CONTRACT]: await readFile(absolute, "utf8")
  };
  return compileOpenApi({ documents, entrypoint: STEEL_SOURCE_CONTRACT });
}

/**
 * Read the response fixtures that the pack manifest declares and shape
 * them for the gateway engine. File bodies load from the pack root;
 * inline bodies pass through as declared.
 */
export async function packResponseFixtures(
  packRoot: string,
  manifest: JsonObject
): Promise<ContractFixture[]> {
  const contract = manifest["contract"];
  const declared = isJsonObject(contract)
    ? asArray(contract["response_fixtures"])
    : [];
  const fixtures: ContractFixture[] = [];
  for (const entry of declared) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const id = entry["id"];
    const operation = entry["operation"];
    const status = entry["status"];
    if (
      typeof id !== "string" ||
      typeof operation !== "string" ||
      typeof status !== "number"
    ) {
      continue;
    }
    const body = entry["body"];
    const headers = entry["headers"];
    const mediaType = entry["media_type"];
    const loadedBody = isJsonObject(body)
      ? await loadFixtureBody(packRoot, body)
      : undefined;
    fixtures.push({
      id,
      operation,
      status,
      ...(typeof mediaType === "string" ? { media_type: mediaType } : {}),
      headers: isJsonObject(headers) ? stringsOf(headers) : {},
      ...(loadedBody === undefined ? {} : { body: loadedBody })
    });
  }
  return fixtures;
}

function asArray(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

async function loadFixtureBody(
  packRoot: string,
  body: JsonObject
): Promise<ContractFixture["body"]> {
  const kind = body["kind"];
  if (kind === "json_inline") {
    return { kind: "json_inline", value: body["value"] ?? null };
  }
  if (kind === "json_file") {
    const source = body["source"];
    if (typeof source !== "string") {
      throw new Error("A json_file fixture body declares no source.");
    }
    const value = JSON.parse(
      await readFile(path.join(packRoot, source), "utf8")
    ) as Json;
    return { kind: "json_file", value };
  }
  return { kind: typeof kind === "string" ? kind : "none" };
}

function stringsOf(value: JsonObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[name] = entry;
    }
  }
  return out;
}

/** Gateway options for one parity run over one contract. */
export function parityGatewayOptions(
  contract: ContractIR,
  fixtures: readonly ContractFixture[],
  runSeed = PARITY_RUN_SEED
): GatewayOptions {
  return {
    contract,
    limits: LIMIT_DEFAULTS,
    fixtures: [...fixtures],
    runSeed
  };
}

/** Mint the run API key for the contract's API key scheme. */
export function parityApiKey(
  contract: ContractIR,
  runSeed = PARITY_RUN_SEED
): string {
  const credentials = mintRunCredentials(contract, runSeed);
  return credentials.apiKeys[STEEL_API_KEY_SCHEME] ?? "";
}

/** Fill the parameter placeholders of one path template. */
export function fillPathTemplate(template: string): string {
  let filled = template;
  for (const [name, value] of Object.entries(PARITY_PATH_VALUES)) {
    filled = filled.replaceAll(`{${name}}`, value);
  }
  return filled;
}

/** One scripted request: no body, no query, the minted API key. */
export function scriptedRequest(
  operation: OperationIR,
  apiKey: string
): RawRequest {
  return {
    method: operation.method,
    target: fillPathTemplate(operation.path_template),
    headers: { [STEEL_API_KEY_HEADER]: apiKey },
    body: new Uint8Array(0)
  };
}

/** Every operation of the contract, in canonical key order. */
export function operationsByKey(contract: ContractIR): OperationIR[] {
  return [...contract.operations].sort((left, right) =>
    left.key < right.key ? -1 : 1
  );
}

/** One operation by canonical key; a thrown error when it is absent. */
export function operationOf(contract: ContractIR, key: string): OperationIR {
  const operation = contract.operations.find(
    (candidate) => candidate.key === key
  );
  if (operation === undefined) {
    throw new Error(`The contract declares no operation ${key}.`);
  }
  return operation;
}

/** One scripted request per operation, in canonical key order. */
export function scriptedSteelRequests(
  contract: ContractIR,
  apiKey: string
): readonly { operation: OperationIR; raw: RawRequest }[] {
  return operationsByKey(contract).map((operation) => ({
    operation,
    raw: scriptedRequest(operation, apiKey)
  }));
}

/** The observable record of one gateway response. */
export function gatewayRecord(response: GatewayResponse): string {
  return JSON.stringify([
    response.requestId,
    response.status,
    response.headers,
    response.body,
    response.provenance,
    response.frameworkCode
  ]);
}

/** Replay one scripted set through the gateway pipeline. */
export function runScriptedSet(
  options: GatewayOptions,
  requests: readonly { raw: RawRequest }[]
): GatewayResponse[] {
  return requests.map((entry, index) =>
    handleGatewayRequest(options, index + 1, entry.raw)
  );
}

/** Reference roles whose files a participant can receive. */
const PARTICIPANT_ROLES: ReadonlySet<string> = new Set([
  "contract_entrypoint",
  "prompt_instructions",
  "prompt_launch",
  "task",
  "participant_file",
  "result_schema",
  "case_source",
  "fixture_body"
]);

/** Every pack reference a participant could receive bytes from. */
export function participantReferences(
  references: readonly PackReference[]
): PackReference[] {
  return references.filter((reference) =>
    PARTICIPANT_ROLES.has(reference.role)
  );
}

/** Every regular file under one directory, as pack-relative paths. */
export async function packFilePaths(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out.sort();
}

async function walk(
  root: string,
  directory: string,
  out: string[]
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

/** One finding of an artifact scan. */
export interface ScanFinding {
  readonly where: string;
  readonly pattern: string;
  readonly excerpt: string;
}

/**
 * Credential-shaped material patterns. Each pattern matches a value
 * form, never a bare name: the pack legitimately names the
 * `steel-api-key` header and the `STEEL_API_KEY` variable without
 * shipping a secret.
 */
const CREDENTIAL_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u
  },
  { id: "bearer-value", pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/u },
  { id: "basic-value", pattern: /\bBasic\s+[A-Za-z0-9+/=]{12,}/u },
  {
    id: "prefixed-key",
    pattern: /\b(?:sk|pk|rk|ghp|gho|xox[baprs]|oal)[-_.][A-Za-z0-9]{12,}/u
  },
  { id: "cloud-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { id: "hex-secret", pattern: /\b[0-9a-f]{32,64}\b/iu },
  {
    id: "assigned-secret",
    pattern:
      /\b(?:api[_-]?key|apikey|token|secret|access[_-]?key|password|passwd|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/=-]{16,}["']?/u
  }
];

/**
 * Study-identity label patterns. Plain words cover the terms with no
 * ordinary meaning in the Steel surface. The suffix, numbered, and
 * joined forms cover identifier shapes for the terms the published
 * contract or the task text uses in another sense, such as `level` in
 * a schema and `replacement_path` in a case template.
 */
const LABEL_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  {
    id: "label-word",
    pattern:
      /\b(?:factor|cohort|cell|treatment|variant|analyzer|protocol|phase|assignment|study|placebo|estimand|contrast|blinding)\b/iu
  },
  {
    id: "label-identifier",
    pattern:
      /\b(?:factor|level|cell|cohort|arm|treatment|variant|replacement|analyzer|protocol|phase|assignment|study)[-_]?(?:id|label|name|key|group|status)\b/iu
  },
  {
    id: "label-numbered",
    pattern:
      /\b(?:factor|level|cell|cohort|arm|treatment|variant|replacement|analyzer)[-_]?\d+\b/iu
  },
  {
    id: "label-joined",
    pattern: /\b(?:factor|cell|cohort|variant|analyzer)[_-][a-z0-9]+/iu
  }
];

function scan(
  where: string,
  text: string,
  patterns: readonly { id: string; pattern: RegExp }[]
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { id, pattern } of patterns) {
    const match = pattern.exec(text);
    if (match !== null) {
      findings.push({
        where,
        pattern: id,
        excerpt: match[0].slice(0, 60)
      });
    }
  }
  return findings;
}

/** Find credential-shaped material in one artifact. */
export function credentialFindings(where: string, text: string): ScanFinding[] {
  return scan(where, text, CREDENTIAL_PATTERNS);
}

/** Find study-identity labels in one artifact. */
export function studyLabelFindings(where: string, text: string): ScanFinding[] {
  return scan(where, text, LABEL_PATTERNS);
}

/** SHA-256 over the raw bytes of one file. */
export async function sha256OfFile(absolutePath: string): Promise<string> {
  return sha256HexBytes(new Uint8Array(await readFile(absolutePath)));
}
