/**
 * Deterministic seed derivation (specification section 17.5).
 *
 * Every derivation hashes a canonical JSON object. The runner never hashes
 * delimiter-free string concatenation, and never mixes one namespace into
 * another, so adding an unrelated generator call cannot perturb another
 * namespace.
 */

import { canonicalJsonSha256, isSha256Hex, type JsonObject } from "@oal/core";

/** Seed-derivation schema version of the hashed documents. */
export const SEED_SCHEMA_VERSION = 1;

/** Assignment kinds that domain-separate their nonnegative index. */
export type AssignmentKind =
  | "ordinary_repetition"
  | "primary"
  | "held_replacement";

export const ASSIGNMENT_KINDS: readonly AssignmentKind[] = [
  "ordinary_repetition",
  "primary",
  "held_replacement"
];

/** PRNG namespaces required by specification section 17.5. */
export const PRNG_NAMESPACES: readonly string[] = [
  "ids",
  "uuids",
  "generated_strings",
  "tokens",
  "schema_branches",
  "faults",
  "fixtures"
];

export interface DigestRef {
  id: string;
  sha256: string;
}

/** Inputs to run-seed derivation; nullable fields are omitted from the hash. */
export interface RunSeedInput {
  contractExecutionSha256: string;
  /** Pre-localization participant-surface template digest. */
  participantSurfaceTemplateSha256: string;
  packSha256: string | null;
  scenario: DigestRef | null;
  behaviorSha256: string;
  eval: DigestRef | null;
  case: DigestRef | null;
  cohortSeed: string;
  assignment: { kind: AssignmentKind; index: number };
}

export interface ManualRunSeedInput {
  runId: string;
  contractExecutionSha256: string;
  packSha256: string | null;
  scenarioSha256: string | null;
  backendSha256: string;
}

function requireDigest(value: string, what: string): string {
  if (!isSha256Hex(value)) {
    throw new Error(
      `${what} must be a lowercase 64-character SHA-256 digest, got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

function requireIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Assignment index must be a nonnegative integer, got ${String(index)}.`
    );
  }
  return index;
}

function digestRef(ref: DigestRef): JsonObject {
  return {
    id: ref.id,
    sha256: requireDigest(ref.sha256, "sha256")
  };
}

function assignmentBlock(kind: AssignmentKind, index: number): JsonObject {
  if (!ASSIGNMENT_KINDS.includes(kind)) {
    throw new Error(
      `Assignment kind must be one of ${ASSIGNMENT_KINDS.join(", ")}, got ${JSON.stringify(kind)}.`
    );
  }
  return { kind, index: requireIndex(index) };
}

/** Canonical document hashed to produce the run seed. */
export function runSeedDocument(input: RunSeedInput): JsonObject {
  const document: JsonObject = {
    schema_version: SEED_SCHEMA_VERSION,
    contract_execution_sha256: requireDigest(
      input.contractExecutionSha256,
      "contractExecutionSha256"
    ),
    participant_surface_template_sha256: requireDigest(
      input.participantSurfaceTemplateSha256,
      "participantSurfaceTemplateSha256"
    ),
    behavior_sha256: requireDigest(input.behaviorSha256, "behaviorSha256"),
    cohort_seed: input.cohortSeed,
    assignment: assignmentBlock(input.assignment.kind, input.assignment.index)
  };
  document.pack_sha256 =
    input.packSha256 === null
      ? null
      : requireDigest(input.packSha256, "packSha256");
  document.scenario =
    input.scenario === null ? null : digestRef(input.scenario);
  document.eval = input.eval === null ? null : digestRef(input.eval);
  document.case = input.case === null ? null : digestRef(input.case);
  return document;
}

/**
 * Run seed: the lowercase SHA-256 over the canonical UTF-8 bytes of the
 * section 17.5 document.
 */
export function deriveRunSeed(input: RunSeedInput): string {
  return canonicalJsonSha256(runSeedDocument(input));
}

/**
 * Run seed for manual `oal serve` without `--run-seed`: a separate canonical
 * tuple of the contract execution digest, pack/scenario/backend digests, and
 * run ID. A cohort seed is never used here.
 */
export function deriveManualRunSeed(input: ManualRunSeedInput): string {
  const document: JsonObject = {
    schema_version: SEED_SCHEMA_VERSION,
    kind: "manual_serve",
    run_id: input.runId,
    contract_execution_sha256: requireDigest(
      input.contractExecutionSha256,
      "contractExecutionSha256"
    ),
    pack_sha256:
      input.packSha256 === null
        ? null
        : requireDigest(input.packSha256, "packSha256"),
    scenario_sha256:
      input.scenarioSha256 === null
        ? null
        : requireDigest(input.scenarioSha256, "scenarioSha256"),
    backend_sha256: requireDigest(input.backendSha256, "backendSha256")
  };
  return canonicalJsonSha256(document);
}

function requireSeed(seed: string, what: string): string {
  return requireDigest(seed, what);
}

/**
 * Trial seed: one run may execute several numbered trials of the same frozen
 * treatment. Domain separation keeps trial order from colliding with any other
 * index space.
 */
export function deriveTrialSeed(
  runSeed: string,
  trial: { index: number; id?: string | null }
): string {
  const trialBlock: JsonObject = { index: requireIndex(trial.index) };
  if (trial.id !== undefined && trial.id !== null) {
    trialBlock.id = trial.id;
  }
  return canonicalJsonSha256({
    schema_version: SEED_SCHEMA_VERSION,
    kind: "trial",
    run_seed: requireSeed(runSeed, "runSeed"),
    trial: trialBlock
  });
}

/**
 * Namespace seed for one generator family (IDs, UUIDs, generated strings,
 * tokens, schema branches, faults, fixtures). Unrelated namespaces never
 * perturb each other.
 */
export function deriveNamespaceSeed(
  runSeed: string,
  namespace: string
): string {
  if (namespace.length === 0) {
    throw new Error("PRNG namespace must not be empty.");
  }
  return canonicalJsonSha256({
    schema_version: SEED_SCHEMA_VERSION,
    kind: "namespace",
    run_seed: requireSeed(runSeed, "runSeed"),
    namespace
  });
}

/** Per-request seed derived from the governing seed and request sequence. */
export function deriveRequestSeed(seed: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(
      `Request sequence must be a positive integer, got ${String(sequence)}.`
    );
  }
  return canonicalJsonSha256({
    schema_version: SEED_SCHEMA_VERSION,
    kind: "request",
    seed: requireSeed(seed, "seed"),
    request_sequence: sequence
  });
}

/** Run ID derived from the run seed (`run_` plus 24 hex characters). */
export function runSeedId(seed: string): string {
  return `run_${requireSeed(seed, "seed").slice(0, 24)}`;
}
