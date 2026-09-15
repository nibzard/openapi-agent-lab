/**
 * `oal study validate` (specification section 23.14). Validation loads the
 * protocol against its schema, reviews the design, resolves the
 * identity-only PackRef against a local pack, compiles the StudyIR, and
 * loads every declared PhasePlan. Lock handling: `--check-lock` fails on
 * drift, `--write-lock` is an explicit maintainer action that refuses a
 * protocol version holding paid analytical evidence. Materialization
 * writes effective contracts into one newly created exact target.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  diagnostic,
  EXIT_INVALID,
  EXIT_OK,
  invalidInput,
  isJsonObject,
  sha256Hex,
  stableJsonStringify,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  compileStudy,
  createProtocolLock,
  protocolLockSha256,
  serializeProtocolLock,
  verifyProtocolLock,
  type EffectiveContractDigest,
  type PhasePlan,
  type ProtocolLock,
  type StudyIR
} from "@oal/study-ir";
import {
  loadContractVariantSet,
  materializeContractVariantSet,
  packRegistrySnapshot,
  VariantSchemaSet,
  type MaterializeSuccess
} from "@oal/contract-variant";
import {
  resolvedCellCount,
  reviewStudyDesign,
  type StudyFinding
} from "@oal/study";
import type { LoadedPack } from "@oal/pack";

import type { CommandHandler } from "../commands.ts";
import { emitDiagnostics } from "../diagnostics.ts";
import { tooManyArguments } from "../usage.ts";
import { compileServeSource } from "./serve.ts";
import {
  exists,
  hasPaidAnalyticalEvidence,
  loadStudy,
  loadStudyPhase,
  lockMembersOf,
  LOCK_MEMBER,
  packIdentityOf,
  phaseIdsOf,
  readLock,
  readSchema,
  resolvePackRef,
  StudyCliCode,
  type LoadedStudy
} from "./study-tree.ts";

/** Stable diagnostic codes of the validate command. */
export const ValidateCode = {
  PackMissing: "OAL-STUDY-VALIDATE-PACK-MISSING",
  MaterializeTargetExists: "OAL-STUDY-VALIDATE-MATERIALIZE-TARGET-EXISTS"
} as const;

/** One finding of the design review, projected to a diagnostic. */
function findingToDiagnostic(finding: StudyFinding): Diagnostic {
  return diagnostic({
    severity: finding.severity,
    phase: "preflight",
    code: finding.code,
    message: finding.message
  });
}

/** Load the three schemas the variant loader validates against. */
async function variantSchemas(): Promise<VariantSchemaSet> {
  const read = async (name: string): Promise<JsonObject> => {
    const document = await readSchema(name);
    if (!isJsonObject(document)) {
      throw invalidInput(
        StudyCliCode.NotStudy,
        `Schema document ${name} is not a JSON object.`
      );
    }
    return document;
  };
  return VariantSchemaSet.fromDocuments({
    set: await read("contract-variant-set.v1.schema.json"),
    manifest: await read("contract-variant-manifest.v1.schema.json"),
    diff: await read("contract-variant-diff.v1.schema.json")
  });
}

/**
 * Materialize every variant of the declared variant set in memory. A
 * protocol without a variant set materializes nothing.
 */
async function materializedVariantsOf(
  study: LoadedStudy,
  pack: LoadedPack
): Promise<
  | { readonly ok: true; readonly variants: readonly MaterializeSuccess[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
> {
  const setPath = study.protocol.evaluation.contract_variant_set;
  if (setPath === undefined) {
    return { ok: true, variants: [] };
  }
  const text = study.members.get(setPath);
  if (text === undefined) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.MemberMissing,
          message: `Variant set member ${setPath} of ${study.root} is missing.`
        })
      ]
    };
  }
  const loaded = await loadContractVariantSet(text, await variantSchemas());
  if (!loaded.ok) {
    return { ok: false, diagnostics: [...loaded.diagnostics] };
  }
  const identity = await packIdentityOf(pack.root);
  const registry = packRegistrySnapshot({
    packId: identity.id,
    packVersion: identity.version,
    packSha256: identity.sha256
  });
  const materialized = materializeContractVariantSet(loaded.value, registry);
  if (!materialized.ok) {
    return { ok: false, diagnostics: [...materialized.diagnostics] };
  }
  return { ok: true, variants: materialized.value };
}

/** Effective-contract digests a protocol lock records. */
async function effectiveContractsOf(
  study: LoadedStudy,
  pack: LoadedPack
): Promise<readonly EffectiveContractDigest[]> {
  const materialized = await materializedVariantsOf(study, pack);
  if (!materialized.ok) {
    return [];
  }
  return materialized.variants.map((entry) => ({
    variant: entry.variant.id,
    sha256: sha256Hex(entry.effectiveText)
  }));
}

/** One phase of the validation report. */
interface PhaseReport {
  readonly phase: string;
  readonly member: string | null;
  readonly valid: boolean;
  readonly analytical: boolean | null;
  readonly purpose: string | null;
  readonly primaryAssignments: number | null;
}

/** Load one phase plan, projecting a typed failure into diagnostics. */
async function loadPhaseSafe(
  study: LoadedStudy,
  phaseId: string,
  cellCount: number
): Promise<{
  readonly plan: PhasePlan | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  try {
    return await loadStudyPhase(study, phaseId, cellCount);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      "message" in cause
    ) {
      return {
        plan: null,
        diagnostics: [
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: String((cause as { readonly code: unknown }).code),
            message: String((cause as { readonly message: unknown }).message)
          })
        ]
      };
    }
    throw cause;
  }
}

/** `oal study validate <study-dir> [options]`. */
export const studyValidateCommand: CommandHandler = async (args, io) => {
  const directory = args.positionals[0];
  if (directory === undefined) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      'Command "study validate" requires a study directory.'
    );
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const root = path.resolve(args.context.cwd, directory);
  const study = await loadStudy(root);
  const diagnostics: Diagnostic[] = [...study.diagnostics];
  const protocolLoaded = study.loaded;

  let pack: LoadedPack | null = null;
  const packFlag = args.flags.string("pack");
  if (packFlag === undefined) {
    diagnostics.push(
      diagnostic({
        severity: "warning",
        phase: "preflight",
        code: ValidateCode.PackMissing,
        message:
          "No --pack was supplied, so the identity-only PackRef of the " +
          "protocol was not resolved against a local pack."
      })
    );
  } else if (protocolLoaded) {
    pack = await resolvePackRef(study, packFlag);
  }

  let ir: StudyIR | null = null;
  let cellCount = 0;
  if (protocolLoaded) {
    const contract =
      pack === null
        ? undefined
        : (
            await compileServeSource(
              pack.root,
              args.context.cwd,
              args.context.maxSourceBytes
            )
          ).contract;
    const compiled = compileStudy(study.protocol, {
      schema: await readSchema("study-ir.v1.schema.json"),
      members: study.members,
      ...(contract === undefined ? {} : { contract }),
      documentUri: path.join(study.root, "study.yaml")
    });
    ir = compiled.ir;
    diagnostics.push(...compiled.diagnostics);
    cellCount = resolvedCellCount({
      protocol: study.protocol,
      ...(ir === null ? {} : { ir })
    });
  }

  const phaseFlag = args.flags.string("phase");
  const phaseIds = protocolLoaded
    ? phaseFlag === undefined
      ? phaseIdsOf(study)
      : [phaseFlag]
    : [];
  const phases: PhaseReport[] = [];
  const phasePlans = new Map<string, PhasePlan>();
  for (const phaseId of phaseIds) {
    const loaded = await loadPhaseSafe(study, phaseId, cellCount);
    diagnostics.push(...loaded.diagnostics);
    if (loaded.plan !== null) {
      phasePlans.set(phaseId, loaded.plan);
    }
    phases.push({
      phase: phaseId,
      member: study.protocol.phases[phaseId] ?? null,
      valid: loaded.plan !== null,
      analytical: loaded.plan?.analytical ?? null,
      purpose: loaded.plan?.purpose ?? null,
      primaryAssignments: loaded.plan?.design.primary_assignments ?? null
    });
  }
  if (protocolLoaded) {
    for (const finding of reviewStudyDesign({
      protocol: study.protocol,
      ...(ir === null ? {} : { ir }),
      phases: phasePlans
    })) {
      diagnostics.push(findingToDiagnostic(finding));
    }
  }

  const lockState = await readLock(study.root);
  diagnostics.push(...lockState.diagnostics);
  const lock: ProtocolLock | null = lockState.lock;
  let lockDigest: string | null = null;
  if (args.flags.has("check-lock")) {
    if (lock === null || !protocolLoaded) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.LockMissing,
          message:
            `Study ${study.root} holds no usable ${LOCK_MEMBER}. Run ` +
            '"study validate --write-lock" to create one.'
        })
      );
    } else {
      const verified = verifyProtocolLock(lock, {
        members: lockMembersOf(study),
        protocol: study.protocol
      });
      diagnostics.push(...verified.diagnostics);
      lockDigest = verified.lockSha256;
      for (const drift of verified.drift) {
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "preflight",
            code: StudyCliCode.LockDrift,
            message: `Protocol lock drift (${drift.kind}): ${drift.detail}`
          })
        );
      }
    }
  }

  if (args.flags.has("write-lock")) {
    if (!protocolLoaded) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.LockDrift,
          message: "A lock is written only for a protocol that loads."
        })
      );
    } else if (await hasPaidAnalyticalEvidence(study.root)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.PaidEvidencePresent,
          message:
            `Study ${study.root} already holds paid analytical evidence, ` +
            "so its protocol version cannot be re-locked."
        })
      );
    } else {
      const effective =
        pack === null ? [] : await effectiveContractsOf(study, pack);
      const created = createProtocolLock(
        study.protocol,
        lockMembersOf(study),
        effective,
        {
          schema: await readSchema("protocol-lock.v1.schema.json"),
          documentUri: path.join(study.root, LOCK_MEMBER)
        }
      );
      diagnostics.push(...created.diagnostics);
      if (created.lock !== null) {
        await writeFile(
          path.join(study.root, LOCK_MEMBER),
          `${serializeProtocolLock(created.lock)}\n`
        );
        lockDigest = protocolLockSha256(created.lock);
      }
    }
  }

  const materialized: string[] = [];
  const materializeDir = args.flags.string("materialize-contracts");
  if (materializeDir !== undefined && protocolLoaded) {
    const target = path.resolve(args.context.cwd, materializeDir);
    if (study.protocol.evaluation.contract_variant_set === undefined) {
      diagnostics.push(
        diagnostic({
          severity: "warning",
          phase: "preflight",
          code: StudyCliCode.NothingToMaterialize,
          message:
            `Protocol ${study.protocol.metadata.id} references no contract ` +
            "variant set, so there is nothing to materialize."
        })
      );
    } else if (pack === null) {
      diagnostics.push(
        diagnostic({
          severity: "warning",
          phase: "preflight",
          code: ValidateCode.PackMissing,
          message:
            "Materialization needs --pack, because variants materialize " +
            "against one local pack."
        })
      );
    } else if (await exists(target)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.TargetExists,
          message: `Materialization target already exists: ${target}.`
        })
      );
    } else {
      const result = await materializedVariantsOf(study, pack);
      if (!result.ok) {
        diagnostics.push(...result.diagnostics);
      } else if (result.variants.length === 0) {
        diagnostics.push(
          diagnostic({
            severity: "warning",
            phase: "preflight",
            code: StudyCliCode.NothingToMaterialize,
            message: "The declared variant set holds no variant."
          })
        );
      } else {
        await mkdir(target, { recursive: true });
        for (const entry of result.variants) {
          const file = path.join(target, `${entry.variant.id}.openapi.json`);
          await writeFile(file, `${canonicalJson(entry.effectiveDocument)}\n`);
          materialized.push(file);
        }
      }
    }
  }

  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  emitDiagnostics(io, args.context, diagnostics);

  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        kind: "StudyValidateCli",
        root: study.root,
        protocol: protocolLoaded
          ? {
              id: study.protocol.metadata.id,
              version: study.protocol.metadata.version
            }
          : null,
        pack_resolved: pack !== null,
        ir_compiled: ir !== null,
        cells: cellCount,
        phases: phases.map(
          (entry): Json => ({
            phase: entry.phase,
            member: entry.member,
            valid: entry.valid,
            analytical: entry.analytical,
            purpose: entry.purpose,
            primary_assignments: entry.primaryAssignments,
            cells: cellCount
          })
        ),
        lock: {
          present: lock !== null,
          ...(lockDigest === null ? {} : { sha256: lockDigest })
        },
        materialized: [...materialized],
        errors: errors.length,
        warnings: warnings.length
      } as Json)
    );
  } else {
    io.stdout(`study: ${study.root}`);
    io.stdout(
      `protocol: ${protocolLoaded ? study.protocol.metadata.id : "-"} ` +
        `version=${protocolLoaded ? study.protocol.metadata.version : "-"}`
    );
    io.stdout(`pack resolved: ${pack === null ? "no" : pack.root}`);
    io.stdout(`cells: ${cellCount}`);
    for (const entry of phases) {
      io.stdout(
        `phase: ${entry.phase} valid=${entry.valid} ` +
          `purpose=${entry.purpose ?? "-"} analytical=${entry.analytical} ` +
          `primary=${entry.primaryAssignments ?? "-"} cells=${cellCount}`
      );
    }
    io.stdout(`lock: ${lock === null ? "absent" : "present"}`);
    if (lockDigest !== null) {
      io.stdout(`lock sha256: ${lockDigest}`);
    }
    for (const file of materialized) {
      io.stdout(`materialized: ${file}`);
    }
  }
  return errors.length > 0 ? EXIT_INVALID : EXIT_OK;
};
