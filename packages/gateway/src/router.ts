/**
 * Route matching over ContractIR operations. Path matching does not
 * filesystem-normalize dot segments; percent decoding happens exactly
 * once after bounded syntax validation (section 15.8).
 */

import { decodePathSegment } from "@oal/core";
import type { OperationIR } from "@oal/contract-ir";

export interface RouteMatch {
  operation: OperationIR;
  /** Decoded path parameter values keyed by parameter name. */
  pathParameters: Record<string, string>;
}

export interface RouteResult {
  match: RouteMatch | null;
  /** Methods that exist on the matched path template, for 405 replies. */
  allowedMethods: string[];
  /** True when the path exists but the method does not. */
  pathExists: boolean;
}

/**
 * Match a concrete request path and method against operations.
 * Ambiguous template pairs are rejected at compile time, so the first
 * segment-equal match is unique.
 */
export function matchRoute(
  operations: readonly OperationIR[],
  method: string,
  path: string,
): RouteResult {
  const segments = splitPath(path);
  let pathExists = false;
  const allowedMethods: string[] = [];
  for (const operation of operations) {
    const extracted = extractSegments(operation, segments);
    if (extracted === null) {
      continue;
    }
    pathExists = true;
    allowedMethods.push(operation.method);
    if (operation.method === method.toUpperCase()) {
      return {
        match: { operation, pathParameters: extracted },
        allowedMethods,
        pathExists,
      };
    }
  }
  return { match: null, allowedMethods, pathExists };
}

function splitPath(path: string): string[] {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return normalized.length === 0 ? [] : normalized.split("/");
}

function extractSegments(
  operation: OperationIR,
  segments: readonly string[],
): Record<string, string> | null {
  const template = operation.route_segments;
  if (template.length !== segments.length) {
    return null;
  }
  const parameters: Record<string, string> = {};
  for (let i = 0; i < template.length; i += 1) {
    const segment = template[i];
    const actual = segments[i] as string;
    if (segment === undefined) {
      return null;
    }
    if (segment.kind === "literal") {
      // Literal comparison is case-sensitive; no dot normalization.
      if (segment.value !== actual) {
        return null;
      }
    } else {
      const decoded = decodePathSegment(actual);
      if (decoded === null) {
        return null;
      }
      if (decoded.length === 0) {
        return null;
      }
      parameters[segment.value] = decoded;
    }
  }
  return parameters;
}
