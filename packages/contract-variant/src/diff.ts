/**
 * Structural diff between one base contract and one effective variant, plus
 * the ContractVariantDiff document that classifies every difference against
 * the declared allowlists.
 */

import { isJsonObject, type Json } from "@oal/core";
import { operationKey } from "@oal/contract-ir";
import { PATH_METHODS } from "@oal/openapi";

import {
  classifyPointerLayer,
  escapeToken,
  type DifferenceLayer
} from "./patch.ts";
import type {
  ContractVariant,
  ContractVariantDiff,
  DiffDifference,
  DiffViolation
} from "./model.ts";

/** One minimal structural edit between two JSON documents. */
export interface StructuralDifference {
  readonly pointer: string;
  readonly op: "add" | "remove" | "replace";
  readonly before?: Json;
  readonly after?: Json;
}

/**
 * Compute the minimal structural difference between two documents. Object
 * members are visited in lexicographic order, arrays by index, and edits are
 * reported at the deepest pointer that differs. Output order is the pointer
 * order, so the result is deterministic.
 */
export function diffJson(
  base: Json,
  effective: Json,
  pointer = ""
): readonly StructuralDifference[] {
  if (isJsonObject(base) && isJsonObject(effective)) {
    const out: StructuralDifference[] = [];
    for (const key of [
      ...new Set([...Object.keys(base), ...Object.keys(effective)])
    ].sort()) {
      const at = `${pointer}/${escapeToken(key)}`;
      const left: Json | undefined = base[key];
      const right: Json | undefined = effective[key];
      if (left === undefined) {
        out.push({ pointer: at, op: "add", after: right as Json });
        continue;
      }
      if (right === undefined) {
        out.push({ pointer: at, op: "remove", before: left });
        continue;
      }
      out.push(...diffJson(left, right, at));
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(effective)) {
    const out: StructuralDifference[] = [];
    const shared = Math.min(base.length, effective.length);
    for (let i = 0; i < shared; i += 1) {
      out.push(
        ...diffJson(base[i] as Json, effective[i] as Json, `${pointer}/${i}`)
      );
    }
    for (let i = shared; i < base.length; i += 1) {
      out.push({
        pointer: `${pointer}/${i}`,
        op: "remove",
        before: base[i] as Json
      });
    }
    for (let i = shared; i < effective.length; i += 1) {
      out.push({
        pointer: `${pointer}/${i}`,
        op: "add",
        after: effective[i] as Json
      });
    }
    return out;
  }
  if (base === effective) {
    return [];
  }
  // A scalar changed, a container replaced a scalar, or the container kinds
  // differ. Both sides are reported at the same pointer.
  return [{ pointer, op: "replace", before: base, after: effective }];
}

/** Operation keys declared by one OpenAPI document, in canonical order. */
export function operationKeysOfDocument(document: Json): readonly string[] {
  if (!isJsonObject(document)) {
    return [];
  }
  const keys = new Set<string>();
  collectKeys(document.paths, keys);
  collectKeys(document.webhooks, keys);
  return [...keys].sort();
}

function collectKeys(node: Json | undefined, keys: Set<string>): void {
  if (!isJsonObject(node)) {
    return;
  }
  for (const template of Object.keys(node)) {
    const item = node[template];
    if (!isJsonObject(item)) {
      continue;
    }
    for (const method of PATH_METHODS) {
      if (isJsonObject(item[method])) {
        keys.add(operationKey(method, template));
      }
    }
  }
}

export interface BuildDiffInput {
  readonly variant: ContractVariant;
  readonly baseSha256: string;
  readonly effectiveSha256: string;
  readonly base: Json;
  readonly effective: Json;
  /** Common projection allowlist, or null when the set declares none. */
  readonly commonAllowlist: readonly string[] | null;
}

/**
 * Build the ContractVariantDiff for one variant: every structural difference
 * classified by layer, the operation inventory, and the violations that mark
 * undeclared drift.
 */
export function buildContractVariantDiff(
  input: BuildDiffInput
): ContractVariantDiff {
  const differences: DiffDifference[] = [];
  const violations: DiffViolation[] = [];
  for (const difference of diffJson(input.base, input.effective)) {
    const layer: DifferenceLayer = classifyPointerLayer(
      difference.pointer,
      input.commonAllowlist,
      input.variant.allowlist
    );
    differences.push({
      pointer: difference.pointer,
      layer,
      op: difference.op,
      ...(difference.before === undefined ? {} : { before: difference.before }),
      ...(difference.after === undefined ? {} : { after: difference.after }),
      allowlisted: layer !== "unrelated"
    });
    if (layer === "unrelated") {
      violations.push({
        pointer: difference.pointer,
        reason: `The ${difference.op} at ${difference.pointer} is outside every declared allowlist, so it is undeclared drift.`
      });
    }
  }

  const baseKeys = operationKeysOfDocument(input.base);
  const effectiveKeys = operationKeysOfDocument(input.effective);
  const baseSet = new Set(baseKeys);
  const effectiveSet = new Set(effectiveKeys);

  return {
    schema_version: 1,
    variant_id: input.variant.id,
    base_sha256: input.baseSha256,
    effective_sha256: input.effectiveSha256,
    differences,
    violations,
    operation_inventory: {
      added: effectiveKeys.filter((key) => !baseSet.has(key)),
      removed: baseKeys.filter((key) => !effectiveSet.has(key)),
      unchanged_count: baseKeys.filter((key) => effectiveSet.has(key)).length
    },
    verified: violations.length === 0,
    extensions: {}
  };
}
