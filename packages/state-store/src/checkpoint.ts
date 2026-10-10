/**
 * Checkpoint documents (specification section 48.4).
 *
 * A checkpoint captures every deterministic component at one
 * transaction boundary: the domain state, the virtual clock, the ID
 * allocator positions, every pseudorandom stream, the fault
 * counters, the idempotency replay entries, and the blob
 * references. An absent required component is an error, never an
 * empty default: restoring a state-only snapshot would silently
 * restart the counters and the streams, so building and parsing both
 * refuse it.
 *
 * The document is the payload a checkpoint directory encrypts under
 * its own key. This module builds and validates the payload; the
 * directory mechanics belong to the world commands.
 */

import {
  DiagnosticCode,
  isRfc3339,
  type Json,
  type JsonObject
} from "@oal/core";

import {
  checkpointIncomplete,
  checkpointIncompatible,
  checkpointIntegrity
} from "./errors.ts";
import { DeterministicPrng } from "./random.ts";

/** Version of the checkpoint document format this build reads. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Clock algorithm identity of the serialized clock component. */
export const CLOCK_ALGORITHM = "virtual-clock-ms-v1";

/** ID allocator algorithm identity of the serialized ID component. */
export const IDS_ALGORITHM = "monotonic-counter-v1";

/** Source world identity a checkpoint restores (section 48.4). */
export interface CheckpointWorldComponent {
  readonly world_id: string;
  readonly generation: number;
  /** Checkpoint this world forked from, or null at creation. */
  readonly origin_checkpoint_id: string | null;
}

/** Domain state at the checkpoint boundary. */
export interface CheckpointStateComponent {
  readonly state_schema_version: number;
  readonly revision: number;
  readonly logical_time: string;
  readonly state: JsonObject;
}

/** Virtual clock position at the boundary. */
export interface CheckpointClockComponent {
  readonly now_ms: number;
  readonly tick_ms: number;
}

/** ID allocator positions; the next ID of a prefix is position plus one. */
export interface CheckpointIdsComponent {
  readonly positions: Readonly<Record<string, number>>;
}

/** One pseudorandom stream's algorithm and full internal position. */
export interface CheckpointRandomStream {
  readonly namespace: string;
  readonly algorithm: string;
  readonly state: string;
}

/** Fault occurrence counters plus the fault stream position. */
export interface CheckpointFaultsComponent {
  readonly counters: Readonly<Record<string, number>>;
  readonly random: CheckpointRandomStream;
}

/**
 * One idempotency replay entry, response included. The identity is
 * plaintext: the importing world re-derives the keyed tags under its
 * own key, so a replay keeps working after the key change (section
 * 48.4).
 */
export interface CheckpointIdempotencyEntry {
  readonly operation_key: string;
  readonly principal_key: string;
  readonly normalized_path: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly created_sequence: number;
  readonly response: {
    readonly status: number;
    readonly headers: JsonObject;
    readonly body: Json | null;
    readonly logical_time: string;
  };
}

/** One referenced blob and its integrity metadata. */
export interface CheckpointBlobReference {
  readonly blob_id: string;
  readonly sha256: string | null;
  readonly secret_hmac: string | null;
  readonly bytes: number;
  readonly media_type: string | null;
  readonly relative_path: string;
}

/** The services positions a checkpoint exports with the state. */
export interface CheckpointServices {
  readonly clock: CheckpointClockComponent;
  readonly ids: CheckpointIdsComponent;
  readonly random: readonly CheckpointRandomStream[];
  readonly faults: CheckpointFaultsComponent;
}

/** A complete checkpoint document (checkpoint.v1). */
export interface CheckpointDocument {
  readonly schema_version: 1;
  readonly kind: "Checkpoint";
  readonly checkpoint_id: string;
  readonly world: CheckpointWorldComponent;
  readonly state: CheckpointStateComponent;
  readonly clock: {
    algorithm: typeof CLOCK_ALGORITHM;
  } & CheckpointClockComponent;
  readonly ids: { algorithm: typeof IDS_ALGORITHM } & CheckpointIdsComponent;
  readonly random: { streams: readonly CheckpointRandomStream[] };
  readonly faults: CheckpointFaultsComponent;
  readonly idempotency: { entries: readonly CheckpointIdempotencyEntry[] };
  readonly blobs: { references: readonly CheckpointBlobReference[] };
}

/** Input of {@link buildCheckpointDocument}. */
export interface BuildCheckpointInput {
  readonly checkpoint_id: string;
  readonly world: CheckpointWorldComponent;
  readonly state: CheckpointStateComponent;
  readonly services: CheckpointServices;
  readonly idempotency: readonly CheckpointIdempotencyEntry[];
  readonly blobs: readonly CheckpointBlobReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require a nonnegative safe integer. */
function requireCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw checkpointIntegrity(
      `Checkpoint component ${what} must be a nonnegative integer, got ${JSON.stringify(value)}.`,
      {
        component: what,
        value: (value === undefined ? null : value) as Json | null
      }
    );
  }
  return value;
}

/** Require a nonempty string. */
function requireLabel(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw checkpointIntegrity(
      `Checkpoint component ${what} must be a nonempty string.`,
      { component: what }
    );
  }
  return value;
}

/** Require a record of nonnegative integers. */
function requireCountRecord(
  value: unknown,
  what: string
): Record<string, number> {
  if (!isRecord(value)) {
    throw checkpointIncomplete(
      `Checkpoint component ${what} must be an object of counters.`,
      { component: what }
    );
  }
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    out[key] = requireCount(count, `${what}.${key}`);
  }
  return out;
}

/** Validate one random stream position against the known algorithm. */
function validateStream(value: unknown, what: string): CheckpointRandomStream {
  if (!isRecord(value)) {
    throw checkpointIncomplete(
      `Checkpoint component ${what} must be a random stream object.`,
      { component: what }
    );
  }
  const algorithm = requireLabel(value["algorithm"], `${what}.algorithm`);
  const state = requireLabel(value["state"], `${what}.state`);
  const namespaceRaw = value["namespace"];
  if (algorithm !== DeterministicPrng.ALGORITHM) {
    throw checkpointIncompatible(
      `Checkpoint stream ${JSON.stringify(
        typeof namespaceRaw === "string" ? namespaceRaw : ""
      )} declares algorithm ${JSON.stringify(algorithm)}; this build restores ${
        DeterministicPrng.ALGORITHM
      } only.`,
      { component: what, algorithm, supported: DeterministicPrng.ALGORITHM }
    );
  }
  // The state is the exported position of the algorithm; validate it
  // by restoring it, which rejects malformed encodings.
  DeterministicPrng.fromState(state);
  const namespace = requireLabel(value["namespace"], `${what}.namespace`);
  return { namespace, algorithm, state };
}

/** Validate the header every document carries. */
function validateHeader(value: Record<string, unknown>): void {
  if (value["schema_version"] !== CHECKPOINT_SCHEMA_VERSION) {
    throw checkpointIncompatible(
      `Checkpoint declares schema version ${JSON.stringify(
        value["schema_version"]
      )}; this build reads version ${String(CHECKPOINT_SCHEMA_VERSION)} only.`,
      {
        found: (value["schema_version"] === undefined
          ? null
          : value["schema_version"]) as Json | null,
        supported: CHECKPOINT_SCHEMA_VERSION
      }
    );
  }
  if (value["kind"] !== "Checkpoint") {
    throw checkpointIntegrity(
      `Checkpoint kind is ${JSON.stringify(value["kind"])}, not "Checkpoint".`,
      { component: "kind" }
    );
  }
  requireLabel(value["checkpoint_id"], "checkpoint_id");
}

/** Validate the world component. */
function validateWorld(value: unknown): CheckpointWorldComponent {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The world component is absent.", {
      component: "world"
    });
  }
  const origin = value["origin_checkpoint_id"];
  return {
    world_id: requireLabel(value["world_id"], "world.world_id"),
    generation: requireCount(value["generation"], "world.generation"),
    origin_checkpoint_id:
      origin === undefined || origin === null
        ? null
        : requireLabel(origin, "world.origin_checkpoint_id")
  };
}

/** Validate the state component. */
function validateState(value: unknown): CheckpointStateComponent {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The state component is absent.", {
      component: "state"
    });
  }
  const state = value["state"];
  if (!isRecord(state)) {
    throw checkpointIntegrity("Checkpoint state.state must be a JSON object.", {
      component: "state.state"
    });
  }
  const logicalTime = requireLabel(value["logical_time"], "state.logical_time");
  if (!isRfc3339(logicalTime)) {
    throw checkpointIntegrity(
      `Checkpoint state.logical_time is not an RFC 3339 timestamp: ${JSON.stringify(logicalTime)}.`,
      { component: "state.logical_time" }
    );
  }
  return {
    state_schema_version: requireCount(
      value["state_schema_version"],
      "state.state_schema_version"
    ),
    revision: requireCount(value["revision"], "state.revision"),
    logical_time: logicalTime,
    state: state as JsonObject
  };
}

/** Validate the clock position the builder stamps with its algorithm. */
function requireClockPosition(value: unknown): CheckpointClockComponent {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The clock component is absent.", {
      component: "clock"
    });
  }
  return {
    now_ms: requireCount(value["now_ms"], "clock.now_ms"),
    tick_ms: requireCount(value["tick_ms"], "clock.tick_ms")
  };
}

/** Validate the clock component of a parsed document. */
function validateClock(value: unknown): {
  algorithm: typeof CLOCK_ALGORITHM;
} & CheckpointClockComponent {
  const position = requireClockPosition(value);
  const algorithm = requireLabel(
    (value as Record<string, unknown>)["algorithm"],
    "clock.algorithm"
  );
  if (algorithm !== CLOCK_ALGORITHM) {
    throw checkpointIncompatible(
      `Checkpoint clock declares algorithm ${JSON.stringify(algorithm)}; this build restores ${CLOCK_ALGORITHM} only.`,
      { component: "clock", algorithm, supported: CLOCK_ALGORITHM }
    );
  }
  return { algorithm, ...position };
}

/** Validate the ID positions the builder stamps with its algorithm. */
function requireIdsPositions(value: unknown): CheckpointIdsComponent {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The ids component is absent.", {
      component: "ids"
    });
  }
  return { positions: requireCountRecord(value["positions"], "ids.positions") };
}

/** Validate the ID allocator component of a parsed document. */
function validateIds(value: unknown): {
  algorithm: typeof IDS_ALGORITHM;
} & CheckpointIdsComponent {
  const component = requireIdsPositions(value);
  const algorithm = requireLabel(
    (value as Record<string, unknown>)["algorithm"],
    "ids.algorithm"
  );
  if (algorithm !== IDS_ALGORITHM) {
    throw checkpointIncompatible(
      `Checkpoint ids declares algorithm ${JSON.stringify(algorithm)}; this build restores ${IDS_ALGORITHM} only.`,
      { component: "ids", algorithm, supported: IDS_ALGORITHM }
    );
  }
  return { algorithm, ...component };
}

/** Validate the faults component. */
function validateFaults(value: unknown): CheckpointFaultsComponent {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The faults component is absent.", {
      component: "faults"
    });
  }
  return {
    counters: requireCountRecord(value["counters"], "faults.counters"),
    random: validateStream(value["random"], "faults.random")
  };
}

/** Validate the idempotency component. */
function validateIdempotency(
  value: unknown
): readonly CheckpointIdempotencyEntry[] {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The idempotency component is absent.", {
      component: "idempotency"
    });
  }
  const entries = value["entries"];
  if (!Array.isArray(entries)) {
    throw checkpointIncomplete(
      "The idempotency component carries no entries array.",
      { component: "idempotency.entries" }
    );
  }
  return entries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw checkpointIntegrity(
        `Idempotency entry ${String(index)} is not an object.`,
        { component: `idempotency.entries.${String(index)}` }
      );
    }
    const response = raw["response"];
    if (!isRecord(response)) {
      throw checkpointIntegrity(
        `Idempotency entry ${String(index)} carries no response object.`,
        { component: `idempotency.entries.${String(index)}.response` }
      );
    }
    const headers = response["headers"];
    if (headers !== undefined && !isRecord(headers)) {
      throw checkpointIntegrity(
        `Idempotency entry ${String(index)} response headers are not an object.`,
        { component: `idempotency.entries.${String(index)}.response.headers` }
      );
    }
    const logicalTime = requireLabel(
      response["logical_time"],
      `idempotency.entries.${String(index)}.response.logical_time`
    );
    if (!isRfc3339(logicalTime)) {
      throw checkpointIntegrity(
        `Idempotency entry ${String(index)} logical time is not RFC 3339: ${JSON.stringify(logicalTime)}.`,
        {
          component: `idempotency.entries.${String(index)}.response.logical_time`
        }
      );
    }
    return {
      operation_key: requireLabel(
        raw["operation_key"],
        `idempotency.entries.${String(index)}.operation_key`
      ),
      principal_key: requireLabel(
        raw["principal_key"],
        `idempotency.entries.${String(index)}.principal_key`
      ),
      normalized_path: requireLabel(
        raw["normalized_path"],
        `idempotency.entries.${String(index)}.normalized_path`
      ),
      idempotency_key: requireLabel(
        raw["idempotency_key"],
        `idempotency.entries.${String(index)}.idempotency_key`
      ),
      request_fingerprint: requireLabel(
        raw["request_fingerprint"],
        `idempotency.entries.${String(index)}.request_fingerprint`
      ),
      created_sequence: requireCount(
        raw["created_sequence"],
        `idempotency.entries.${String(index)}.created_sequence`
      ),
      response: {
        status: requireCount(
          response["status"],
          `idempotency.entries.${String(index)}.response.status`
        ),
        headers: (headers ?? {}) as JsonObject,
        body: (response["body"] ?? null) as Json | null,
        logical_time: logicalTime
      }
    };
  });
}

/** Validate the blob component. */
function validateBlobs(value: unknown): readonly CheckpointBlobReference[] {
  if (!isRecord(value)) {
    throw checkpointIncomplete("The blobs component is absent.", {
      component: "blobs"
    });
  }
  const references = value["references"];
  if (!Array.isArray(references)) {
    throw checkpointIncomplete(
      "The blobs component carries no references array.",
      { component: "blobs.references" }
    );
  }
  return references.map((raw, index) => {
    if (!isRecord(raw)) {
      throw checkpointIntegrity(
        `Blob reference ${String(index)} is not an object.`,
        { component: `blobs.references.${String(index)}` }
      );
    }
    const sha256 = raw["sha256"];
    const secretHmac = raw["secret_hmac"];
    const marks =
      (sha256 === null || sha256 === undefined ? 0 : 1) +
      (secretHmac === null || secretHmac === undefined ? 0 : 1);
    if (marks !== 1) {
      throw checkpointIntegrity(
        `Blob reference ${String(index)} sets exactly one of sha256 or secret_hmac.`,
        { component: `blobs.references.${String(index)}` }
      );
    }
    const mediaType = raw["media_type"];
    if (
      mediaType !== undefined &&
      mediaType !== null &&
      typeof mediaType !== "string"
    ) {
      throw checkpointIntegrity(
        `Blob reference ${String(index)} media type is not a string.`,
        { component: `blobs.references.${String(index)}.media_type` }
      );
    }
    return {
      blob_id: requireLabel(
        raw["blob_id"],
        `blobs.references.${String(index)}.blob_id`
      ),
      sha256: (sha256 ?? null) as string | null,
      secret_hmac: (secretHmac ?? null) as string | null,
      bytes: requireCount(
        raw["bytes"],
        `blobs.references.${String(index)}.bytes`
      ),
      media_type: mediaType ?? null,
      relative_path: requireLabel(
        raw["relative_path"],
        `blobs.references.${String(index)}.relative_path`
      )
    };
  });
}

/**
 * Assemble one checkpoint document. Every component must be present:
 * a missing services component, replay entry list, or blob list is
 * `OAL-CHECKPOINT-INCOMPLETE`, not an empty default.
 */
export function buildCheckpointDocument(
  input: BuildCheckpointInput
): CheckpointDocument {
  const world = validateWorld(input.world);
  const state = validateState(input.state);
  const clock: {
    algorithm: typeof CLOCK_ALGORITHM;
  } & CheckpointClockComponent = {
    algorithm: CLOCK_ALGORITHM,
    ...requireClockPosition(input.services.clock)
  };
  const ids: { algorithm: typeof IDS_ALGORITHM } & CheckpointIdsComponent = {
    algorithm: IDS_ALGORITHM,
    ...requireIdsPositions(input.services.ids)
  };
  const streams = input.services.random.map((stream, index) =>
    validateStream(stream, `random.streams.${String(index)}`)
  );
  const faults = validateFaults(input.services.faults);
  const idempotency = validateIdempotency({ entries: input.idempotency });
  const blobs = validateBlobs({ references: input.blobs });
  if (streams.length === 0) {
    throw checkpointIncomplete(
      "A checkpoint must carry at least one random stream position.",
      { component: "random.streams" }
    );
  }
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    kind: "Checkpoint",
    checkpoint_id: requireLabel(input.checkpoint_id, "checkpoint_id"),
    world,
    state,
    clock,
    ids,
    random: { streams },
    faults,
    idempotency: { entries: idempotency },
    blobs: { references: blobs }
  };
}

/**
 * Validate one parsed checkpoint payload. A state-only snapshot, a
 * document with omitted components, and incompatible algorithm or
 * schema versions all fail before any world opens.
 */
export function parseCheckpointDocument(value: Json): CheckpointDocument {
  if (!isRecord(value)) {
    throw checkpointIncomplete("A checkpoint document must be a JSON object.", {
      component: "document"
    });
  }
  validateHeader(value);
  const clock = validateClock(value["clock"]);
  const ids = validateIds(value["ids"]);
  const faults = validateFaults(value["faults"]);
  const random = value["random"];
  if (!isRecord(random) || !Array.isArray(random["streams"])) {
    throw checkpointIncomplete(
      "The random component with its streams array is absent.",
      { component: "random" }
    );
  }
  const streams = random["streams"].map((stream, index) =>
    validateStream(stream, `random.streams.${String(index)}`)
  );
  if (streams.length === 0) {
    throw checkpointIncomplete(
      "A checkpoint must carry at least one random stream position.",
      { component: "random.streams" }
    );
  }
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    kind: "Checkpoint",
    checkpoint_id: requireLabel(value["checkpoint_id"], "checkpoint_id"),
    world: validateWorld(value["world"]),
    state: validateState(value["state"]),
    clock,
    ids,
    random: { streams },
    faults,
    idempotency: { entries: validateIdempotency(value["idempotency"]) },
    blobs: { references: validateBlobs(value["blobs"]) }
  };
}

/** Stable code of the absent-component failure, for callers that match. */
export const CHECKPOINT_INCOMPLETE_CODE = DiagnosticCode.CheckpointIncomplete;

/** Stable code of the version failure, for callers that match. */
export const CHECKPOINT_INCOMPATIBLE_CODE =
  DiagnosticCode.CheckpointIncompatible;
