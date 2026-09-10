/**
 * The mock adapter boundary (specification section 37.1). Every external
 * response engine sits behind this interface. The built-in deterministic
 * generator is the reference implementation; a future Prism adapter must
 * satisfy the same byte-identical determinism invariant.
 */

import type { ContractIR, OperationIR } from "@oal/contract-ir";
import type { Json } from "@oal/core";

/** What the adapter can do without the gateway stepping in. */
export interface MockAdapterCapabilities {
  /** Resolve declared response examples deterministically. */
  examples: boolean;
  /** Generate values from schemas with a seeded generator. */
  schemaGeneration: boolean;
  /** Honor Accept-driven media negotiation itself. */
  contentNegotiation: boolean;
  /** Emit declared response headers itself. */
  responseHeaders: boolean;
}

/** A validated, parsed request for exactly one operation. */
export interface MockRequest {
  operationKey: string;
  pathParameters: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: Json | undefined;
  contentType: string | null;
  accept: string | null;
}

/** The canonical response the adapter produced. */
export interface MockResponse {
  status: number;
  mediaType: string | null;
  headers: Record<string, string>;
  body: Json | undefined;
  /** Where the body came from, for example fixture: or example:. */
  provenance: string;
  /** Approximation note when the adapter could not honor the contract. */
  approximation: string | null;
}

export interface MockRespondInput {
  contract: ContractIR;
  request: MockRequest;
  /** Run seed; part of the determinism key. */
  seed: string;
}

/**
 * A deterministic contract-response engine. For an identical ContractIR
 * operation, validated request, response-selection policy, and seed, the
 * adapter MUST return a byte-identical serialized response.
 */
export interface MockAdapter {
  readonly id: string;
  readonly version: string;
  capabilities(): MockAdapterCapabilities;
  respond(input: MockRespondInput): Promise<MockResponse | null>;
}

/** Byte-identical serialization used for determinism comparison. */
export function serializeMockResponse(response: MockResponse): string {
  return JSON.stringify([
    response.status,
    response.mediaType,
    Object.entries(response.headers)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`),
    response.body === undefined ? null : response.body,
    response.provenance,
    response.approximation
  ]);
}

/** Find one operation by canonical key; null when absent. */
export function operationByKey(
  contract: ContractIR,
  key: string
): OperationIR | null {
  return contract.operations.find((entry) => entry.key === key) ?? null;
}
