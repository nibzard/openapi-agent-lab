/**
 * Shared response-body schema check (specification sections 15.4 and
 * 15.5). One definition serves both response validation and response
 * selection: a candidate body is checked against the declared content
 * schema with response-side writeOnly handling, whatever produced the
 * value. The check skips silently when the content declares no schema
 * or the registry cannot resolve it. Schema evaluation runs inside the
 * bounded worker boundary.
 */

import { validateSchemaInstance, type Json } from "@oal/core";
import type { MediaContentIR } from "@oal/contract-ir";
import {
  materializeSchemaRefs,
  strippingSchemaLookup,
  strippedSchema
} from "./validate.ts";

export interface BodyViolation {
  pointer: string;
  code: string;
  message: string;
}

/**
 * Check one body against a declared content entry. Returns an empty
 * array when the entry carries no resolvable schema.
 */
export async function responseBodyViolations(
  content: MediaContentIR,
  body: Json,
  lookup: (ref: string) => Json | undefined
): Promise<BodyViolation[]> {
  if (content.schema_ref === null) {
    return [];
  }
  const schema = lookup(content.schema_ref);
  if (schema === undefined) {
    return [];
  }
  const resolver = strippingSchemaLookup(lookup, "writeOnly");
  const violations = await validateSchemaInstance(
    strippedSchema(schema, "writeOnly"),
    body,
    { refs: materializeSchemaRefs(resolver) }
  );
  return violations.map((violation) => ({
    pointer: violation.pointer,
    code: violation.code,
    message: violation.message
  }));
}
