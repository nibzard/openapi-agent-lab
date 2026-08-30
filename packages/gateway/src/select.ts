/**
 * Contract response selection (specification section 15.5). Status and
 * value provenance follow the documented precedence; the choice is
 * deterministic for identical ContractIR and fixtures.
 */

import { canonicalJson, isJsonObject, type Json } from "@oal/core";
import type { ResponseIR } from "@oal/contract-ir";
import {
  generateValue,
  GenerationUnsupportedError,
  type GenerationOptions
} from "./generate.ts";
import { negotiateResponseMedia, preferredMediaType } from "./negotiate.ts";
import { responseBodyViolations } from "./response-body.ts";

export interface ContractFixture {
  id: string;
  operation: string;
  status: number;
  media_type?: string;
  headers?: Record<string, string>;
  body?: { kind: string; source?: string; value?: Json };
}

export interface SelectedResponse {
  status: number;
  response: ResponseIR | null;
  mediaType: string | null;
  headers: Record<string, string>;
  body: Json | undefined;
  provenance: string;
  approximation: string | null;
}

/**
 * Select the contract response for an operation. Fixtures win over
 * example and schema generation, exactly as the precedence table
 * requires. When an Accept header is supplied, the value is taken from
 * the negotiated media type, not the declared preference order.
 */
export function selectResponse(
  operationKey: string,
  responses: readonly ResponseIR[],
  fixtures: readonly ContractFixture[],
  generationOptions: GenerationOptions,
  acceptHeader?: string | null
): SelectedResponse | null {
  const fixture = fixtures.find(
    (entry) =>
      entry.operation === operationKey &&
      entry.status >= 200 &&
      entry.status <= 599
  );

  if (fixture !== undefined) {
    const declared = findResponseForStatus(responses, fixture.status);
    return {
      status: fixture.status,
      response: declared,
      mediaType:
        fixture.media_type ?? pickMediaType(declared) ?? "application/json",
      headers: fixture.headers ?? {},
      body: fixture.body?.value,
      provenance: `fixture:${fixture.id}`,
      approximation: null
    };
  }

  const chosen = chooseSuccessResponse(responses);
  if (chosen === null) {
    return null;
  }
  return synthesizeResponse(chosen, generationOptions, acceptHeader);
}

/**
 * Status precedence for contract mode: 200, 201, 202, 204, lowest other
 * explicit 2xx, then a declared 2XX range emitted as concrete 200. A
 * default response is never selected as an automatic success.
 */
export function chooseSuccessResponse(
  responses: readonly ResponseIR[]
): ResponseIR | null {
  const exact = responses
    .filter(
      (response) =>
        response.selector_kind === "exact" && response.status !== null
    )
    .sort((a, b) => (a.status as number) - (b.status as number));
  const preferred = [200, 201, 202, 204];
  for (const status of preferred) {
    const match = exact.find((response) => response.status === status);
    if (match !== undefined) {
      return match;
    }
  }
  const other2xx = exact.find((response) => {
    const status = response.status as number;
    return status >= 200 && status < 300 && !preferred.includes(status);
  });
  if (other2xx !== undefined) {
    return other2xx;
  }
  const range = responses
    .filter(
      (response) =>
        response.selector_kind === "range" && /^2XX$/i.test(response.selector)
    )
    .sort((a, b) => a.selector.localeCompare(b.selector));
  const rangeMatch = range[0];
  if (rangeMatch !== undefined) {
    // A 2XX range is emitted as the concrete status 200.
    return rangeMatch;
  }
  return null;
}

/** Find the declared response for a concrete status. */
export function findResponseForStatus(
  responses: readonly ResponseIR[],
  status: number
): ResponseIR | null {
  const classPrefix = `${Math.floor(status / 100)}XX`;
  const order: Array<(response: ResponseIR) => boolean> = [
    (response) =>
      response.selector_kind === "exact" && response.status === status,
    (response) =>
      response.selector_kind === "range" &&
      response.selector.toUpperCase() === classPrefix,
    (response) => response.selector_kind === "default"
  ];
  for (const predicate of order) {
    const match = responses.find(predicate);
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

function synthesizeResponse(
  response: ResponseIR,
  generationOptions: GenerationOptions,
  acceptHeader?: string | null
): SelectedResponse | null {
  const declared = response.content.map((entry) => entry.media_type);
  // The body must come from the media type that is actually served.
  // A missing Accept header reaches this function as null, never
  // undefined; both shapes permit the documented preference order.
  const mediaType =
    acceptHeader === null || acceptHeader === undefined
      ? pickMediaType(response)
      : negotiateResponseMedia(declared, acceptHeader);
  let body: Json | undefined;
  let provenance = "none";
  let approximation: string | null = null;
  if (mediaType !== null) {
    const content = response.content.find(
      (entry) => entry.media_type === mediaType
    );
    if (content !== undefined) {
      // Examples outrank schema generation in the value precedence
      // table, but an example whose value violates the declared schema
      // is skipped for the next candidate (section 15.5). Without a
      // resolvable schema there is no generation path and no body
      // check, so the highest-precedence candidate is served as-is.
      const lookup = generationOptions.lookup;
      if (lookup === undefined || content.schema_ref === null) {
        const highest = orderedExampleValues(content.examples)[0];
        if (highest !== undefined) {
          body = highest.value;
          provenance = highest.provenance;
        }
      } else {
        let skipped = 0;
        for (const candidate of orderedExampleValues(content.examples)) {
          const violations = responseBodyViolations(
            content,
            candidate.value,
            lookup
          );
          if (violations.length === 0) {
            body = candidate.value;
            provenance = candidate.provenance;
            break;
          }
          skipped += 1;
        }
        if (body === undefined) {
          try {
            body = generateValue(
              { $ref: content.schema_ref },
              generationOptions
            );
            provenance = "schema_generation";
          } catch (error) {
            if (error instanceof GenerationUnsupportedError) {
              approximation = "generation_unsupported";
              return null;
            }
            throw error;
          }
        }
        if (skipped > 0) {
          approximation = `example_invalid_skipped:${skipped}`;
        }
      }
    }
  }
  const status =
    response.selector_kind === "range" ? 200 : (response.status ?? 200);
  return {
    status,
    response,
    mediaType,
    headers: {},
    body,
    provenance,
    approximation
  };
}

/**
 * Response-example candidates in value-precedence order: the singular
 * example first, then named examples in ascending name order.
 */
function orderedExampleValues(
  examples: readonly {
    name: string | null;
    value: Json;
    summary?: string | null;
  }[]
): { value: Json; provenance: string }[] {
  const named = examples
    .filter((example) => example.name !== null)
    .sort((a, b) => (a.name as string).localeCompare(b.name as string));
  const singular = examples.find((example) => example.name === null);
  const ordered: { value: Json; provenance: string }[] = [];
  if (singular !== undefined) {
    ordered.push({ value: singular.value, provenance: "example:singular" });
  }
  for (const example of named) {
    ordered.push({
      value: example.value,
      provenance: `example:${example.name as string}`
    });
  }
  return ordered;
}

/**
 * Response-value precedence among examples: singular example, then
 * lexicographically first named example.
 */
export function selectExampleValue(
  examples: readonly {
    name: string | null;
    value: Json;
    summary?: string | null;
  }[]
): { value: Json; provenance: string } | null {
  return orderedExampleValues(examples)[0] ?? null;
}

/**
 * Pick the deterministic preferred media type of a response: the
 * documented default preference of section 15.7 over the declared
 * content entries.
 */
export function pickMediaType(response: ResponseIR | null): string | null {
  if (response === null || response.content.length === 0) {
    return null;
  }
  return preferredMediaType(response.content.map((entry) => entry.media_type));
}

/** Stable canonical-JSON ordering helper for provenance records. */
export function provenanceKey(value: Json): string {
  return canonicalJson(value);
}

export function isJsonRecord(
  value: Json | undefined
): value is Record<string, Json> {
  return isJsonObject(value);
}
