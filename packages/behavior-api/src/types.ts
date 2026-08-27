/**
 * Behavior backend public API (specification section 16.2). A behavior
 * module owns domain state transitions; the gateway owns everything
 * else. The interfaces are the versioned contract between them.
 */

import type { Json } from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";

export type { Json };

/** The operation a behavior request targets, with contract metadata. */
export type ContractOperation = OperationIR;

export interface MultipartPart {
  name: string;
  headers: Array<{ name: string; values: string[] }>;
  body: Body;
}

export type Body =
  | { kind: "none" }
  | { kind: "json"; value: Json }
  | { kind: "text"; text: string; sizeBytes: number; sha256: string }
  | {
      kind: "binary";
      bytes: Uint8Array;
      sizeBytes: number;
      sha256: string;
    }
  | { kind: "multipart"; parts: MultipartPart[] };

/** Read-only virtual time; behavior never reads the wall clock. */
export interface DeterministicClock {
  now(): string;
  nowMs(): number;
}

/** Run-scoped deterministic ID allocation. */
export interface DeterministicIds {
  next(prefix: string): string;
}

/** Run-scoped deterministic randomness, namespaced per rule. */
export interface DeterministicRandom {
  nextFloat(): number;
  nextInt(maxExclusive: number): number;
  nextBytes(length: number): Uint8Array;
}

/** Digest-addressed binary storage outside JSON state. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ digest: string; sizeBytes: number }>;
  get(digest: string): Promise<Uint8Array | null>;
}

export interface BackendModule {
  apiVersion: 1;
  name: string;
  version: string;
  create(context: BackendFactoryContext): Promise<BehaviorBackend>;
}

export interface BackendFactoryContext {
  readonly contract: ContractIR;
  readonly packRoot: string;
  readonly config: Json;
}

export interface BehaviorBackend {
  describe(): Promise<BackendDescription>;
  initialize(context: InitializeContext): Promise<InitializeResult>;
  handle(
    request: BehaviorRequest,
    context: HandleContext
  ): Promise<BehaviorResult>;
  project?(
    state: Readonly<Json>,
    request: BehaviorRequest | null
  ): Promise<Json>;
  close?(): Promise<void>;
}

export interface BackendDescription {
  backendApiVersion: 1;
  stateSchemaVersion: number;
  operations: Array<{
    key: string;
    support: "implemented" | "passthrough" | "unsupported";
  }>;
  semanticEvents?: Array<{
    name: string;
    eventVersion: number;
    payloadSchema: Json;
  }>;
}

export interface InitializeContext {
  readonly runId: string;
  readonly fixtures: ReadonlyArray<Json>;
  readonly clock: DeterministicClock;
  readonly ids: DeterministicIds;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
}

export interface InitializeResult {
  state: Json;
  observations?: Json;
}

export interface BehaviorRequest {
  readonly operation: ContractOperation;
  readonly principal: Json | null;
  readonly parameters: {
    path: Readonly<Record<string, Json>>;
    query: Readonly<Record<string, Json>>;
    header: Readonly<Record<string, Json>>;
    cookie: Readonly<Record<string, Json>>;
  };
  readonly body: Body;
  readonly selectedRequestMediaType: string | null;
  readonly acceptedResponseMediaTypes: ReadonlyArray<string>;
}

export interface HandleContext {
  readonly runId: string;
  readonly requestId: string;
  readonly state: Readonly<Json>;
  readonly clock: DeterministicClock;
  readonly ids: DeterministicIds;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
}

export interface BehaviorResult {
  response: {
    status: number;
    headers?: Array<{ name: string; values: string[] }>;
    mediaType?: string;
    body?: Body;
  };
  nextState?: Json;
  effects?: string[];
  observations?: Json;
  semanticEvents?: Array<{
    name: string;
    eventVersion: number;
    payload: Json;
  }>;
}
