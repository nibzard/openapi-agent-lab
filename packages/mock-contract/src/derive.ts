/**
 * Single-operation contract derivation (specification section 37.1). An
 * external adapter receives one frozen derived contract, never the
 * participant-facing route table. The derived document is round-trip
 * checked against the source operation before it is handed over.
 */

import type { ContractIR, OperationIR } from "@oal/contract-ir";
import { canonicalJson, sha256Hex, type Json } from "@oal/core";

export interface DerivedContract {
  contract: ContractIR;
  /** Digest of the derived contract's canonical serialization. */
  digest: string;
}

/**
 * Collect schema UIDs that a normalized schema body references through
 * `$ref` keys carrying a registry UID.
 */
function refsInsideSchema(
  value: Json,
  registry: Set<string>,
  seen: Set<Json>
): void {
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      refsInsideSchema(item, registry, seen);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        registry.add(child);
      }
      refsInsideSchema(child, registry, seen);
    }
  }
}

/** The schema UIDs an operation references through its `*_ref` fields. */
function directSchemaRefs(operation: OperationIR): Set<string> {
  const refs = new Set<string>();
  for (const parameter of operation.parameters) {
    if (parameter.schema_ref !== null) {
      refs.add(parameter.schema_ref);
    }
    if (parameter.content !== null) {
      refs.add(parameter.content.schema_ref);
    }
  }
  for (const media of operation.request_body?.content ?? []) {
    if (media.schema_ref !== null) {
      refs.add(media.schema_ref);
    }
  }
  for (const response of operation.responses) {
    for (const media of response.content) {
      if (media.schema_ref !== null) {
        refs.add(media.schema_ref);
      }
    }
    for (const header of response.headers) {
      if (header.schema_ref !== null) {
        refs.add(header.schema_ref);
      }
      if (header.content !== null) {
        refs.add(header.content.schema_ref);
      }
    }
  }
  for (const callback of operation.callbacks) {
    for (const expression of callback.expressions) {
      for (const media of expression.request_body?.content ?? []) {
        if (media.schema_ref !== null) {
          refs.add(media.schema_ref);
        }
      }
      for (const response of expression.responses) {
        for (const media of response.content) {
          if (media.schema_ref !== null) {
            refs.add(media.schema_ref);
          }
        }
      }
    }
  }
  return refs;
}

function reachableSchemas(
  contract: ContractIR,
  operation: OperationIR
): Set<string> {
  const wanted = directSchemaRefs(operation);
  // Resolve transitively: referenced schemas may reference others.
  const queue = [...wanted];
  while (queue.length > 0) {
    const uid = queue.pop();
    if (uid === undefined) {
      continue;
    }
    const schema = contract.schemas[uid]?.schema;
    if (schema === undefined) {
      continue;
    }
    const before = wanted.size;
    refsInsideSchema(schema, wanted, new Set());
    if (wanted.size > before) {
      for (const added of wanted) {
        if (!queue.includes(added)) {
          queue.push(added);
        }
      }
    }
  }
  return wanted;
}

function requiredSchemeNames(operation: OperationIR): Set<string> {
  const names = new Set<string>();
  for (const alternative of operation.security?.alternatives ?? []) {
    for (const requirement of alternative.schemes) {
      names.add(requirement.name);
    }
  }
  return names;
}

/**
 * Derive the frozen single-operation contract. The operation is shared by
 * reference, so its bytes cannot drift from the source ContractIR. The
 * schemas and security schemes are copied by selection only.
 */
export function deriveSingleOperation(
  contract: ContractIR,
  operationKey: string
): DerivedContract {
  const operation = contract.operations.find(
    (entry) => entry.key === operationKey
  );
  if (operation === undefined) {
    throw new Error(`operation ${operationKey} is not in the contract`);
  }
  const schemas: ContractIR["schemas"] = {};
  for (const uid of reachableSchemas(contract, operation)) {
    const entry = contract.schemas[uid];
    if (entry !== undefined) {
      schemas[uid] = entry;
    }
  }
  const schemes: ContractIR["security_schemes"] = {};
  for (const name of requiredSchemeNames(operation)) {
    const scheme = contract.security_schemes[name];
    if (scheme !== undefined) {
      schemes[name] = scheme;
    }
  }
  const derived: ContractIR = {
    ...contract,
    operations: [operation],
    webhooks: [],
    schemas,
    security_schemes: schemes,
    diagnostics: []
  };
  return {
    contract: derived,
    digest: digestOf(derived)
  };
}

export interface RoundTripProblem {
  code: string;
  message: string;
}

/**
 * Round-trip verification (specification section 37.1): the derived
 * document must map byte-for-byte to the expected canonical key,
 * serializers, security, request media types, and response selectors.
 */
export function roundTripCheck(
  source: ContractIR,
  derived: DerivedContract,
  operationKey: string
): RoundTripProblem[] {
  const problems: RoundTripProblem[] = [];
  const original = source.operations.find(
    (entry) => entry.key === operationKey
  );
  if (original === undefined) {
    return [
      { code: "derived_source_missing", message: "source operation is missing" }
    ];
  }
  const copies = derived.contract.operations;
  if (copies.length !== 1) {
    problems.push({
      code: "derived_operations_invalid",
      message: `derived contract holds ${copies.length} operations, expected 1`
    });
    return problems;
  }
  const copy = copies[0];
  if (copy === undefined) {
    return [
      {
        code: "derived_operations_invalid",
        message: "derived operation absent"
      }
    ];
  }
  if (
    canonicalJson(copy as unknown as Json) !==
    canonicalJson(original as unknown as Json)
  ) {
    problems.push({
      code: "derived_operation_drift",
      message: "derived operation bytes differ from the source operation"
    });
  }
  for (const parameter of original.parameters) {
    if (
      parameter.schema_ref !== null &&
      derived.contract.schemas[parameter.schema_ref] === undefined
    ) {
      problems.push({
        code: "derived_schema_missing",
        message: `parameter schema ${parameter.schema_ref} was not carried over`
      });
    }
  }
  for (const media of original.request_body?.content ?? []) {
    if (
      media.schema_ref !== null &&
      derived.contract.schemas[media.schema_ref] === undefined
    ) {
      problems.push({
        code: "derived_schema_missing",
        message: `request body schema ${media.schema_ref} was not carried over`
      });
    }
  }
  return problems;
}

function digestOf(contract: ContractIR): string {
  return sha256Hex(canonicalJson(contract as unknown as Json));
}
