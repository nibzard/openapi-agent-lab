/**
 * The built-in deterministic mock adapter. It delegates response
 * selection and generation to the gateway engine so the gateway and the
 * adapter boundary can never disagree (specification section 37.1).
 */

import {
  type ContractFixture,
  negotiateResponseMedia,
  selectResponse
} from "@oal/gateway";
import type {
  MockAdapter,
  MockAdapterCapabilities,
  MockRespondInput,
  MockResponse
} from "./types.ts";

export const BUILTIN_MOCK_ADAPTER_ID = "builtin";

export class BuiltinMockAdapter implements MockAdapter {
  readonly id = BUILTIN_MOCK_ADAPTER_ID;
  readonly version = "0.1.0";

  constructor(private readonly fixtures: ContractFixture[] = []) {}

  capabilities(): MockAdapterCapabilities {
    return {
      examples: true,
      schemaGeneration: true,
      contentNegotiation: true,
      responseHeaders: true
    };
  }

  respond(input: MockRespondInput): MockResponse | null {
    const operation = input.contract.operations.find(
      (entry) => entry.key === input.request.operationKey
    );
    if (operation === undefined) {
      return null;
    }
    const selected = selectResponse(
      operation.key,
      operation.responses,
      this.fixtures.filter((fixture) => fixture.operation === operation.key),
      {
        seed: `${input.seed}:${operation.uid}`,
        lookup: (ref: string) => input.contract.schemas[ref]?.schema
      }
    );
    if (selected === null) {
      return null;
    }
    const declared =
      selected.response?.content.map((entry) => entry.media_type) ?? [];
    const media =
      declared.length > 0
        ? negotiateResponseMedia(declared, input.request.accept)
        : selected.mediaType;
    return {
      status: selected.status,
      mediaType: media,
      headers: { ...selected.headers },
      body: selected.body,
      provenance: selected.provenance,
      approximation: selected.approximation
    };
  }
}

/** Convenience constructor matching the adapter interface exactly. */
export function builtinMockAdapter(
  fixtures?: ContractFixture[]
): BuiltinMockAdapter {
  return new BuiltinMockAdapter(fixtures);
}
