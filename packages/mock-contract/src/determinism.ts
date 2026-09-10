/**
 * Adapter determinism verification (specification section 37.1).
 * Preflight invokes representative candidates twice and rejects an
 * adapter whose output is not byte-identical.
 */

import type { MockAdapter, MockRespondInput } from "./types.ts";
import { serializeMockResponse } from "./types.ts";

export interface DeterminismProblem {
  operationKey: string;
  first: string;
  second: string;
}

export interface DeterminismResult {
  ok: boolean;
  checked: number;
  problems: DeterminismProblem[];
}

/**
 * Run every candidate twice against the adapter and compare the
 * serialized responses byte-for-byte.
 */
export async function verifyDeterminism(
  adapter: MockAdapter,
  candidates: readonly MockRespondInput[]
): Promise<DeterminismResult> {
  const problems: DeterminismProblem[] = [];
  for (const candidate of candidates) {
    const first = await adapter.respond(candidate);
    const second = await adapter.respond(candidate);
    const firstBytes = first === null ? "null" : serializeMockResponse(first);
    const secondBytes =
      second === null ? "null" : serializeMockResponse(second);
    if (firstBytes !== secondBytes) {
      problems.push({
        operationKey: candidate.request.operationKey,
        first: firstBytes,
        second: secondBytes
      });
    }
  }
  return { ok: problems.length === 0, checked: candidates.length, problems };
}
