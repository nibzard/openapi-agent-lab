/**
 * Compiler resource limits from specification section 31.1.
 *
 * The values mirror `LIMIT_DEFAULTS` in `@oal/config`. `@oal/config` is not a
 * declared dependency of this package, so the compiler-relevant subset is
 * repeated here and every value stays overridable through
 * {@link CompileOptions.limits}.
 */

export interface CompilerLimits {
  maxSourceOpenapiBytes: number;
  maxBundledDocumentBytes: number;
  maxParsedNodes: number;
  maxUniqueReferenceTargets: number;
  maxTraversalDepth: number;
  maxOperations: number;
  maxOneExampleBytes: number;
  maxRetainedExamplesBytes: number;
}

export const COMPILER_LIMIT_DEFAULTS: CompilerLimits = {
  maxSourceOpenapiBytes: 10 * 1024 * 1024,
  maxBundledDocumentBytes: 25 * 1024 * 1024,
  maxParsedNodes: 100_000,
  maxUniqueReferenceTargets: 2_000,
  maxTraversalDepth: 64,
  maxOperations: 5_000,
  maxOneExampleBytes: 1024 * 1024,
  maxRetainedExamplesBytes: 10 * 1024 * 1024
};

/** Apply caller overrides, refusing non-positive or non-finite values. */
export function resolveCompilerLimits(
  overrides?: Partial<CompilerLimits>
): CompilerLimits {
  const resolved: CompilerLimits = { ...COMPILER_LIMIT_DEFAULTS };
  if (overrides === undefined) {
    return resolved;
  }
  for (const key of Object.keys(overrides) as Array<keyof CompilerLimits>) {
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Limit ${key} must be a positive finite number.`);
    }
    resolved[key] = value;
  }
  return resolved;
}
