import type { ContractIR } from "@oal/contract-ir";
import {
  canonicalJson,
  DiagnosticCode,
  diagnostic,
  type Diagnostic,
  type JsonObject
} from "@oal/core";

import { PackCode } from "./codes.ts";
import {
  loadPack,
  type PackLoadOptions,
  type PackManifestName
} from "./manifest.ts";
import {
  buildPackIr,
  contractIndexFromContractIr,
  contractIndexFromDocument,
  packIrCanonicalText,
  type ContractIndex,
  type OperationCoverage,
  type PackIrOptions,
  type PackLimits
} from "./packir.ts";
import { validatePackInvariants } from "./invariants.ts";

export interface PackValidateOptions extends PackLoadOptions {
  readonly contractIr?: ContractIR;
  readonly capabilityReportSha256?: string;
  readonly limits?: PackLimits;
}

export interface PackValidationResult {
  readonly root: string;
  readonly manifestName: PackManifestName;
  readonly manifestSha256: string;
  readonly manifest: JsonObject;
  /** Serialized effective PackIR, or null when loading failed. */
  readonly packIr: JsonObject | null;
  readonly index: ContractIndex;
  readonly coverage: OperationCoverage;
  readonly diagnostics: Diagnostic[];
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

/**
 * Load one pack directory, validate it end to end, and build the effective
 * PackIR. Never throws for pack content problems: every failure is a
 * diagnostic in the result.
 */
export async function validatePack(
  directory: string,
  options: PackValidateOptions = {}
): Promise<PackValidationResult> {
  const loaded = await loadPack(directory, options);
  const irOptions: PackIrOptions = {
    ...(options.contractIr === undefined
      ? {}
      : { contractIr: options.contractIr }),
    ...(options.capabilityReportSha256 === undefined
      ? {}
      : { capabilityReportSha256: options.capabilityReportSha256 }),
    ...(options.limits === undefined ? {} : { limits: options.limits })
  };
  const built = buildPackIr(loaded, irOptions);
  const diagnostics = [...loaded.diagnostics, ...built.diagnostics];

  const contractReference = loaded.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  const index =
    options.contractIr !== undefined
      ? contractIndexFromContractIr(options.contractIr)
      : contractIndexFromDocument(
          contractReference !== undefined &&
            contractReference.document !== null &&
            typeof contractReference.document === "object" &&
            !Array.isArray(contractReference.document)
            ? contractReference.document
            : {}
        );

  const invariantDiagnostics = validatePackInvariants({
    loaded,
    index,
    coverage: built.coverage
  });
  diagnostics.push(...invariantDiagnostics);

  if (built.ir !== null) {
    for (const violation of loaded.schemaSet
      .validator("pack-ir")
      .errors(built.ir)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: DiagnosticCode.PackSchemaInvalid,
          message: `PackIR violates pack-ir.v1: ${violation.message}`,
          json_pointer: violation.pointer
        })
      );
    }
    const rebuilt = buildPackIr(loaded, irOptions);
    if (
      rebuilt.ir === null ||
      canonicalJson(rebuilt.ir) !== packIrCanonicalText(built.ir)
    ) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "compile",
          code: PackCode.DigestUnstable,
          message:
            "PackIR digests are not stable across rebuilds of the same pack."
        })
      );
    }
  }

  return {
    root: loaded.root,
    manifestName: loaded.manifestName,
    manifestSha256: loaded.manifestSha256,
    manifest: loaded.manifest,
    packIr: built.ir,
    index,
    coverage: built.coverage,
    diagnostics,
    errors: diagnostics.filter((entry) => entry.severity === "error"),
    warnings: diagnostics.filter((entry) => entry.severity === "warning")
  };
}
