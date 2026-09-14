/**
 * Path parameter pattern collection (specification section 15.6). A
 * contract often patterns the `{id}` parameter of an item path while
 * the response schema of the same resource leaves its `id` property
 * unpatterned. The id a client reads back must also work in a path, so
 * generation applies the strictest pattern any path parameter of the
 * resource family declares.
 */

import type {
  ContractIR,
  OperationIR,
  ParameterIR,
  SchemaIR
} from "@oal/contract-ir";
import { isJsonObject } from "@oal/core";

/**
 * Family key of an operation: the template's literal segments with the
 * parameters removed. `/computers` and `/computers/{id}` share one key,
 * so the id a collection operation creates satisfies the pattern the
 * item operations declare. Sub-resources keep their own key.
 */
export function pathFamilyKey(operation: OperationIR): string {
  return operation.route_segments
    .filter((segment) => segment.kind === "literal")
    .map((segment) => segment.value)
    .join("/");
}

/**
 * Collect the strictest declared pattern per family and parameter name.
 * One pass over the compiled operations; the result is a pure function
 * of the contract, so it is computed once per contract, never per
 * request. An empty pattern accepts every string and is skipped.
 */
export function compilePathParameterPatterns(
  contract: ContractIR
): Map<string, Record<string, string>> {
  const families = new Map<string, Map<string, string>>();
  for (const operation of contract.operations) {
    if (operation.surface !== "path") {
      continue;
    }
    const family = pathFamilyKey(operation);
    for (const parameter of operation.parameters) {
      if (parameter.location !== "path") {
        continue;
      }
      const pattern = parameterPattern(parameter, contract.schemas);
      if (pattern === null) {
        continue;
      }
      const byName = families.get(family) ?? new Map<string, string>();
      const incumbent = byName.get(parameter.name);
      if (incumbent === undefined || stricter(pattern, incumbent)) {
        byName.set(parameter.name, pattern);
      }
      families.set(family, byName);
    }
  }
  const table = new Map<string, Record<string, string>>();
  for (const [family, byName] of families) {
    table.set(family, Object.fromEntries(byName));
  }
  return table;
}

/**
 * Declared pattern of a path parameter, or null. The parameter schema
 * wins over a `content` media-type schema, mirroring the resolution
 * order request validation applies (section 15.4).
 */
function parameterPattern(
  parameter: ParameterIR,
  schemas: Record<string, SchemaIR>
): string | null {
  const ref =
    parameter.schema_ref ??
    (parameter.content === null ? null : parameter.content.schema_ref);
  if (ref === null) {
    return null;
  }
  const registered = schemas[ref];
  if (registered === undefined) {
    return null;
  }
  const schema = registered.schema;
  if (!isJsonObject(schema) || typeof schema.pattern !== "string") {
    return null;
  }
  return schema.pattern.length > 0 ? schema.pattern : null;
}

/**
 * Strictest of two patterns: the longer source wins, then the
 * lexicographically smaller one. The total order keeps the choice
 * independent of operation order, so identical contracts select
 * identical patterns across runs.
 */
function stricter(challenger: string, incumbent: string): boolean {
  if (challenger.length !== incumbent.length) {
    return challenger.length > incumbent.length;
  }
  return challenger < incumbent;
}
