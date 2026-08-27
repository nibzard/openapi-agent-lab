/**
 * Study-directory loading shared by the study commands. The loaders are
 * read-only: no command here rewrites a member of a locked protocol.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  diagnostic,
  invalidInput,
  isJsonObject,
  sha256Hex,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { packFreezeDigest } from "@oal/runner";
import {
  declaredMemberPaths,
  loadPhasePlan,
  loadProtocol,
  protocolLockFromJson,
  type LockMember,
  type PhasePlan,
  type ProtocolLoadResult,
  type ProtocolLock,
  type StudyProtocol
} from "@oal/study-ir";
import type { CellProtocolDigests } from "@oal/scheduler";
import { defaultSchemaDir, loadPack, parsePackDocument } from "@oal/pack";
import type { LoadedPack } from "@oal/pack";

/** Stable diagnostic codes of the study-directory readers. */
export const StudyCliCode = {
  NotStudy: "OAL-STUDY-NOT-A-STUDY",
  PackMismatch: "OAL-STUDY-PACK-MISMATCH",
  LockMissing: "OAL-STUDY-LOCK-MISSING",
  LockDrift: "OAL-STUDY-LOCK-DRIFT",
  LockExists: "OAL-STUDY-LOCK-EXISTS",
  PaidEvidencePresent: "OAL-STUDY-PAID-EVIDENCE-PRESENT",
  NothingToMaterialize: "OAL-STUDY-NOTHING-TO-MATERIALIZE",
  NoExecutor: "OAL-STUDY-RUN-NO-EXECUTOR",
  ScheduleMismatch: "OAL-STUDY-SCHEDULE-MISMATCH",
  TargetExists: "OAL-STUDY-TARGET-EXISTS",
  AnalysisIncomplete: "OAL-STUDY-ANALYSIS-INCOMPLETE",
  EvalMissing: "OAL-STUDY-EVAL-MISSING",
  MemberMissing: "OAL-STUDY-MEMBER-MISSING"
} as const;

/** The protocol document every study root must hold. */
export const PROTOCOL_MEMBER = "study.yaml";

/** The protocol lock document of a study root. */
export const LOCK_MEMBER = "protocol.lock.json";

/** One loaded study root: the protocol plus its member bytes. */
export interface LoadedStudy {
  readonly root: string;
  readonly protocol: StudyProtocol;
  /**
   * False when the protocol document failed its own load. The protocol
   * field is then a typed null placeholder, so readers must check this
   * flag before they touch the protocol.
   */
  readonly loaded: boolean;
  readonly diagnostics: ProtocolLoadResult["diagnostics"];
  /** Member bytes by protocol-root path, including the protocol itself. */
  readonly members: ReadonlyMap<string, string>;
}

/** Read one schema document from the repository schema directory. */
export async function readSchema(name: string): Promise<Json> {
  const text = await readFile(path.join(defaultSchemaDir(), name), "utf8");
  return JSON.parse(text) as Json;
}

/** Read one study member document as text, or null when absent. */
export async function readMember(
  root: string,
  relative: string
): Promise<string | null> {
  return await readFile(path.join(root, relative), "utf8").catch(() => null);
}

/**
 * Walk a study root and collect the bytes of every declared member plus
 * the protocol document itself.
 */
export async function membersOf(
  root: string,
  protocol: StudyProtocol
): Promise<Map<string, string>> {
  const members = new Map<string, string>();
  const protocolText = await readMember(root, PROTOCOL_MEMBER);
  if (protocolText !== null) {
    members.set(PROTOCOL_MEMBER, protocolText);
  }
  for (const relative of declaredMemberPaths(protocol)) {
    const text = await readMember(root, relative);
    if (text !== null) {
      members.set(relative, text);
    }
  }
  return members;
}

/** Load and validate the protocol of one study root. */
export async function loadStudy(root: string): Promise<LoadedStudy> {
  const absolute = path.resolve(root);
  const protocolText = await readMember(absolute, PROTOCOL_MEMBER);
  if (protocolText === null) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      `Directory ${absolute} holds no ${PROTOCOL_MEMBER}, so it is not a ` +
        "study root."
    );
  }
  const parsed = parsePackDocument(protocolText, PROTOCOL_MEMBER);
  if (parsed.value === null) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      `${PROTOCOL_MEMBER} of ${absolute} is not JSON or YAML.`
    );
  }
  const schema = await readSchema("study-protocol.v1.schema.json");
  const loaded = loadProtocol(parsed.value, {
    schema,
    documentUri: path.join(absolute, PROTOCOL_MEMBER)
  });
  if (loaded.protocol === null) {
    return {
      root: absolute,
      protocol: null as unknown as StudyProtocol,
      loaded: false,
      diagnostics: loaded.diagnostics,
      members: new Map()
    };
  }
  return {
    root: absolute,
    protocol: loaded.protocol,
    loaded: true,
    diagnostics: loaded.diagnostics,
    members: await membersOf(absolute, loaded.protocol)
  };
}

/** The identity one local pack carries: ID, version, and freeze digest. */
export async function packIdentityOf(packDir: string): Promise<{
  readonly pack: LoadedPack;
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}> {
  const pack = await loadPack(path.resolve(packDir));
  const metadata = isJsonObject(pack.manifest["metadata"])
    ? pack.manifest["metadata"]
    : {};
  const id = typeof metadata["id"] === "string" ? metadata["id"] : null;
  const version =
    typeof metadata["version"] === "string" ? metadata["version"] : null;
  if (id === null || version === null) {
    throw invalidInput(
      StudyCliCode.PackMismatch,
      `Pack ${pack.root} declares no metadata ID or version.`
    );
  }
  return { pack, id, version, sha256: packFreezeDigest(pack) };
}

/**
 * Resolve the identity-only PackRef of a protocol against one local pack.
 * A missing pack or any field mismatch fails closed.
 */
export async function resolvePackRef(
  study: LoadedStudy,
  packDir: string
): Promise<LoadedPack> {
  const identity = await packIdentityOf(packDir);
  const reference = study.protocol.evaluation.pack;
  const problems: string[] = [];
  if (identity.id !== reference.id) {
    problems.push(`id: protocol ${reference.id}, pack ${identity.id}`);
  }
  if (identity.version !== reference.version) {
    problems.push(
      `version: protocol ${reference.version}, pack ${identity.version}`
    );
  }
  if (identity.sha256 !== reference.sha256) {
    problems.push(
      `sha256: protocol ${reference.sha256}, pack ${identity.sha256}`
    );
  }
  if (problems.length > 0) {
    throw invalidInput(
      StudyCliCode.PackMismatch,
      `Local pack ${identity.pack.root} does not satisfy the protocol ` +
        `PackRef (${problems.join("; ")}).`
    );
  }
  return identity.pack;
}

/** Load one phase plan of a study, resolved against its protocol. */
export async function loadStudyPhase(
  study: LoadedStudy,
  phaseId: string,
  cellCount: number
): Promise<{
  readonly plan: PhasePlan | null;
  readonly diagnostics: ProtocolLoadResult["diagnostics"];
}> {
  const relative = study.protocol.phases[phaseId];
  if (relative === undefined) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      `Protocol ${study.protocol.metadata.id} declares no phase ` +
        `"${phaseId}". Known phases: ${Object.keys(study.protocol.phases).join(", ")}.`
    );
  }
  const text =
    study.members.get(relative) ?? (await readMember(study.root, relative));
  if (text === null) {
    throw invalidInput(
      StudyCliCode.MemberMissing,
      `Phase document ${relative} of ${study.root} is missing.`
    );
  }
  const parsed = parsePackDocument(text, relative);
  if (parsed.value === null) {
    throw invalidInput(
      StudyCliCode.NotStudy,
      `Phase document ${relative} of ${study.root} is not JSON or YAML.`
    );
  }
  const schema = await readSchema("phase-plan.v1.schema.json");
  const loaded = loadPhasePlan(parsed.value, {
    schema,
    protocol: study.protocol,
    cellCount,
    documentUri: path.join(study.root, relative)
  });
  return { plan: loaded.phasePlan, diagnostics: loaded.diagnostics };
}

/** Every phase identifier the protocol declares, in declaration order. */
export function phaseIdsOf(study: LoadedStudy): string[] {
  return Object.keys(study.protocol.phases);
}

/** The lock members of a study: protocol plus every declared member. */
export function lockMembersOf(study: LoadedStudy): LockMember[] {
  const members: LockMember[] = [];
  for (const [relative, text] of study.members) {
    members.push({ path: relative, text });
  }
  return members;
}

/** Read the protocol lock of a study root, or null when absent. */
export async function readLock(root: string): Promise<{
  readonly lock: ProtocolLock | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const text = await readMember(root, LOCK_MEMBER);
  if (text === null) {
    return { lock: null, diagnostics: [] };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      lock: null,
      diagnostics: [
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: StudyCliCode.LockDrift,
          message: `Lock ${path.join(root, LOCK_MEMBER)} is not valid JSON: ${reason}`
        })
      ]
    };
  }
  const schema = await readSchema("protocol-lock.v1.schema.json");
  const loaded = protocolLockFromJson(parsed, {
    schema,
    documentUri: path.join(root, LOCK_MEMBER)
  });
  return { lock: loaded.lock, diagnostics: loaded.diagnostics };
}

/**
 * The manifest entry of one eval a pack declares, or null when the pack
 * declares no eval with that identifier.
 */
export function evalEntryOf(
  pack: LoadedPack,
  evalId: string
): JsonObject | null {
  const evals = Array.isArray(pack.manifest["evals"])
    ? pack.manifest["evals"]
    : [];
  for (const entry of evals) {
    if (isJsonObject(entry) && entry["id"] === evalId) {
      return entry;
    }
  }
  return null;
}

/** The manifest entry of one scenario a pack declares, or null. */
export function scenarioEntryOf(
  pack: LoadedPack,
  scenarioId: string
): JsonObject | null {
  const scenarios = Array.isArray(pack.manifest["scenarios"])
    ? pack.manifest["scenarios"]
    : [];
  for (const entry of scenarios) {
    if (isJsonObject(entry) && entry["id"] === scenarioId) {
      return entry;
    }
  }
  return null;
}

/** Read one pack-relative text file, or null when absent. */
export async function packFileText(
  pack: LoadedPack,
  relative: string
): Promise<string | null> {
  return await readFile(path.join(pack.root, relative), "utf8").catch(
    () => null
  );
}

/**
 * Protocol-time digests of every cell of a study, hashed from the real
 * member and pack bytes the protocol freezes. One shared policy, eval,
 * scenario, rubric, and run-profile template give every cell the same
 * digest values.
 */
export async function cellDigestsOf(
  study: LoadedStudy,
  pack: LoadedPack
): Promise<Map<string, CellProtocolDigests>> {
  const evalEntry = evalEntryOf(pack, study.protocol.evaluation.eval);
  if (evalEntry === null) {
    throw invalidInput(
      StudyCliCode.EvalMissing,
      `Pack ${pack.root} declares no eval ` +
        `"${study.protocol.evaluation.eval}".`
    );
  }
  const scenarioEntry = scenarioEntryOf(
    pack,
    study.protocol.evaluation.scenario
  );
  const rubricPath =
    typeof evalEntry["rubric"] === "string" ? evalEntry["rubric"] : null;
  const rubricText =
    rubricPath === null ? null : await packFileText(pack, rubricPath);
  if (rubricText === null) {
    throw invalidInput(
      StudyCliCode.MemberMissing,
      `Rubric ${rubricPath ?? "(none declared)"} of pack ${pack.root} is missing.`
    );
  }
  const policyText =
    study.protocol.blinding.participant_surface_policy === undefined
      ? ""
      : (study.members.get(
          study.protocol.blinding.participant_surface_policy
        ) ?? "");
  const runProfileText =
    study.members.get(study.protocol.constants.run_profile) ?? "";
  const evalText = await packEvalText(pack, evalEntry);
  const scenarioText =
    scenarioEntry === null ? "null" : canonicalJson(scenarioEntry as Json);
  const shared: CellProtocolDigests = {
    participant_surface_policy_sha256: sha256Hex(policyText),
    eval_sha256: sha256Hex(evalText),
    scenario_sha256: sha256Hex(scenarioText),
    rubric_sha256: sha256Hex(rubricText),
    run_profile_template_sha256: sha256Hex(runProfileText)
  };
  const cells = cellIdsOf(study);
  return new Map(cells.map((cellId) => [cellId, { ...shared }]));
}

/** Every cell identifier of a study: the cross product of factor levels. */
export function cellIdsOf(study: LoadedStudy): string[] {
  const expand = (
    levels: readonly { readonly id: string }[][],
    index: number,
    prefix: string[]
  ): string[] => {
    const current = levels[index];
    if (current === undefined) {
      return [prefix.join("__")];
    }
    const out: string[] = [];
    for (const level of current) {
      out.push(...expand(levels, index + 1, [...prefix, level.id]));
    }
    return out;
  };
  const ordered = study.protocol.factors.map((factor) =>
    [...factor.levels].sort((a, b) => (a.id < b.id ? -1 : 1))
  );
  return expand(ordered, 0, []).sort();
}

/** The bytes of one eval entry: its task, result schema, and document. */
async function packEvalText(
  pack: LoadedPack,
  entry: JsonObject
): Promise<string> {
  const parts: string[] = [canonicalJson(entry)];
  const task = isJsonObject(entry["task"])
    ? typeof entry["task"]["source"] === "string"
      ? entry["task"]["source"]
      : null
    : null;
  if (task !== null) {
    const text = await packFileText(pack, task);
    if (text !== null) {
      parts.push(text);
    }
  }
  const result = isJsonObject(entry["result"])
    ? typeof entry["result"]["schema"] === "string"
      ? entry["result"]["schema"]
      : null
    : null;
  if (result !== null) {
    const text = await packFileText(pack, result);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * True when the study root holds paid analytical evidence: at least one
 * completed StudyRun of an analytical phase below `study-runs/`.
 */
export async function hasPaidAnalyticalEvidence(
  root: string
): Promise<boolean> {
  const runsRoot = path.join(root, "study-runs");
  const names = await readdir(runsRoot).catch(() => []);
  for (const name of names) {
    const header = await readJsonMember(
      runsRoot,
      path.join(name, "study-run.json")
    );
    if (
      header !== null &&
      isJsonObject(header["phase"]) &&
      header["phase"]["analytical"] === true
    ) {
      return true;
    }
  }
  return false;
}

/** Digest of one file's bytes, or null when the file is absent. */
export async function fileSha256(target: string): Promise<string | null> {
  const bytes = await readFile(target).catch(() => null);
  return bytes === null ? null : sha256Hex(bytes.toString("utf8"));
}

/** True when the target exists, whatever it is. */
export async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

/** Read one JSON member of a directory, or null. */
export async function readJsonMember(
  root: string,
  relative: string
): Promise<JsonObject | null> {
  const text = await readMember(root, relative);
  if (text === null) {
    return null;
  }
  try {
    const parsed: Json | undefined = JSON.parse(text) as Json;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
