/**
 * Environment and self-checks (specification section 23.13).
 *
 * The doctor engine verifies that the host can actually run a trial:
 * runtime version, workspace package versions, the SQLite state store,
 * pack and study schema files, the configured agent adapter, gateway
 * determinism, writable artifact storage, the limits table, and the
 * platform capabilities the harness relies on.
 *
 * The engine spawns nothing and makes no paid model call. Everything
 * environment-specific arrives as an injected probe; the caller owns
 * process creation and the network. Results are plain values with a
 * stable check id, so output ordering is deterministic.
 */

import { canonicalJson, type Json } from "@oal/core";
import { closeDatabase, integrityCheck, openDatabase } from "@oal/state-store";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type RawRequest
} from "@oal/gateway";

export const DOCTOR_SCHEMA_VERSION = 1;
export const DOCTOR_REPORT_KIND = "DoctorReport";

/** Required runtime major version (specification: Node.js 24 LTS). */
export const DOCTOR_REQUIRED_NODE_MAJOR = 24;

/** Platform capability checks of section 23.13, in report order. */
export const DOCTOR_CAPABILITIES = [
  "sandbox_mechanisms",
  "loopback_ephemeral_ports",
  "process_group_termination",
  "network_isolation",
  "file_permissions",
  "container_runtime"
] as const;

export type DoctorCapability = (typeof DOCTOR_CAPABILITIES)[number];

export type DoctorStatus = "pass" | "warn" | "fail";

/** Limit table type the gateway pipeline enforces. */
export type DoctorLimitTable = GatewayOptions["limits"];

export interface DoctorCheck {
  /** Stable identifier, for example `runtime.node`. */
  id: string;
  status: DoctorStatus;
  message: string;
  detail?:
    | Readonly<Record<string, string | number | boolean | null>>
    | undefined;
}

export interface DoctorReport {
  schema_version: typeof DOCTOR_SCHEMA_VERSION;
  kind: typeof DOCTOR_REPORT_KIND;
  checks: readonly DoctorCheck[];
  status: DoctorStatus;
  counts: { pass: number; warn: number; fail: number };
}

export interface DoctorInput {
  /** Runtime version string, for example `24.18.0`. */
  nodeVersion: string;
  /** Workspace package versions keyed by package name. */
  packageVersions?: Readonly<Record<string, string>> | undefined;
  /** Pack and study schema files to load. */
  schemaFiles?: readonly DoctorSchemaFile[] | undefined;
  /** Configured agent adapter and its probe result supplier. */
  adapter?: DoctorAdapter | undefined;
  /** Artifact directory and its write probe. */
  diskArtifact?: DoctorDiskArtifact | undefined;
  /** Resolved limits table with the hard ceilings from section 31.1. */
  limits?: DoctorLimitsInput | undefined;
  /** Platform capability probes keyed by capability id. */
  capabilities?:
    | Readonly<Partial<Record<DoctorCapability, DoctorCapabilityProbe>>>
    | undefined;
}

export interface DoctorSchemaFile {
  /** Schema identity, for example `pack` or `study`. */
  id: string;
  /** Loads the schema file; throws, or returns null, when unloadable. */
  load: () => unknown;
}

export interface DoctorAdapter {
  name: string;
  /** Probes the adapter executable and features; spawns nothing here. */
  probe: () => DoctorAdapterResult | Promise<DoctorAdapterResult>;
}

export interface DoctorAdapterResult {
  ok: boolean;
  features: readonly string[];
  detail: string | null;
}

export interface DoctorDiskArtifact {
  directory: string;
  /** Writes one probe artifact and reports whether the write survived. */
  write: () => Promise<{ ok: boolean; error: string | null }>;
}

export interface DoctorLimitsInput {
  table: DoctorLimitTable;
  /** Hard ceilings; a key the table holds but this lacks is reported. */
  ceilings: Readonly<Partial<Record<keyof DoctorLimitTable, number>>>;
}

export type DoctorCapabilityProbe =
  | (() => DoctorCapabilityResult)
  | (() => Promise<DoctorCapabilityResult>);

export interface DoctorCapabilityResult {
  /** True when supported, false when absent, null when undetermined. */
  supported: boolean | null;
  detail: string | null;
}

/** Result of the built-in SQLite store probe. */
export interface DoctorStoreResult {
  opened: boolean;
  integrity: boolean | null;
  journalMode: string | null;
  error: string | null;
}

/**
 * Generous limit values for the gateway self-check. They only bound one
 * tiny probe request; they are not the operator configuration.
 */
export const DOCTOR_PROBE_LIMITS: DoctorLimitTable = {
  maxSourceOpenapiBytes: 1024 * 1024,
  maxBundledDocumentBytes: 2 * 1024 * 1024,
  maxParsedNodes: 10_000,
  maxUniqueReferenceTargets: 1_000,
  maxTraversalDepth: 64,
  maxOperations: 1_000,
  maxOneExampleBytes: 64 * 1024,
  maxRetainedExamplesBytes: 1024 * 1024,
  maxPromptBytes: 64 * 1024,
  maxStudyProtocolBytes: 1024 * 1024,
  maxStudyFactors: 16,
  maxLevelsPerFactor: 16,
  maxResolvedCells: 64,
  maxContractVariantsPerStudy: 16,
  maxFrozenAssignmentsPerStudyRun: 100,
  maxParticipantSurfaceEntriesPerCell: 1_000,
  maxDocumentationCandidatesPerProfile: 16,
  maxRequestTargetBytes: 8 * 1024,
  maxRequestHeaderBytes: 16 * 1024,
  maxRequestBodyBytes: 1024 * 1024,
  maxGeneratedResponseBodyBytes: 1024 * 1024,
  maxMultipartParts: 64,
  maxSseEventsPerResponse: 100,
  maxSseDurationMs: 30_000,
  maxConcurrentConnectionsPerRun: 32,
  maxRequestsPerRun: 10_000,
  maxBurstRequestsPerSecond: 100,
  maxDomainObjects: 10_000,
  maxPersistedStateBytes: 16 * 1024 * 1024,
  maxEventLogBytes: 16 * 1024 * 1024,
  maxArtifactsPerRunBytes: 64 * 1024 * 1024,
  trialWallTimeMs: 30 * 60_000,
  gracefulTerminationMs: 5_000,
  maxBatchTrials: 4,
  maxParallelTrials: 2,
  maxExtensionMemoryBytes: 256 * 1024 * 1024,
  maxExtensionCores: 1,
  maxExtensionProcesses: 16,
  schemaWorkerDeadlineMs: 5_000,
  schemaWorkerCount: 1,
  schemaWorkerMaxPending: 16,
  schemaWorkerMaxMessageBytes: 1024 * 1024,
  schemaWorkerMemoryBytes: 128 * 1024 * 1024
};

/** Minimal one-operation contract the gateway self-check issues. */
function probeGatewayOptions(): GatewayOptions {
  const contract: GatewayOptions["contract"] = {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "oal-doctor", version: "0" },
    source: {
      entrypoint: "doctor-probe.yaml",
      media_type: "application/yaml",
      openapi_version: "3.1.0",
      sha256: "",
      semantic_sha256: "",
      execution_sha256: "",
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {},
    schemas: {},
    operations: [
      {
        key: "path:GET /_oal_doctor_health",
        uid: "op_doctor_health",
        surface: "path",
        method: "GET",
        path_template: "/_oal_doctor_health",
        route_segments: [{ kind: "literal", value: "_oal_doctor_health" }],
        operation_id: "doctorHealth",
        tool_name: "doctor_health",
        summary: null,
        description: null,
        tags: [],
        deprecated: false,
        servers: [],
        parameters: [],
        request_body: null,
        responses: [
          {
            selector: "200",
            selector_kind: "exact",
            status: 200,
            description: null,
            headers: [],
            content: [
              {
                media_type: "application/json",
                schema_ref: null,
                examples: [],
                support: "supported",
                support_reason_codes: []
              }
            ],
            source_pointer: ""
          }
        ],
        security: null,
        callbacks: [],
        extensions: {},
        source_pointer: "",
        support: { level: "supported", diagnostic_codes: [] }
      }
    ],
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
  return {
    contract,
    limits: DOCTOR_PROBE_LIMITS,
    runSeed: "oal-doctor-probe"
  };
}

const PROBE_REQUEST: RawRequest = {
  method: "GET",
  target: "/_oal_doctor_health",
  headers: { accept: "application/json" },
  body: new Uint8Array(0)
};

/** Runtime major-version compatibility with the tested LTS line. */
export function checkNodeRuntime(nodeVersion: string): DoctorCheck {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(nodeVersion.trim());
  if (match === null) {
    return {
      id: "runtime.node",
      status: "fail",
      message: `The runtime version '${nodeVersion}' cannot be parsed.`,
      detail: { version: nodeVersion }
    };
  }
  const major = Number(match[1]);
  if (major < DOCTOR_REQUIRED_NODE_MAJOR) {
    return {
      id: "runtime.node",
      status: "fail",
      message: `Node ${major} is below the required major version ${DOCTOR_REQUIRED_NODE_MAJOR}.`,
      detail: { version: nodeVersion, major }
    };
  }
  if (major > DOCTOR_REQUIRED_NODE_MAJOR) {
    return {
      id: "runtime.node",
      status: "warn",
      message: `Node ${major} is newer than the tested major version ${DOCTOR_REQUIRED_NODE_MAJOR}.`,
      detail: { version: nodeVersion, major }
    };
  }
  return {
    id: "runtime.node",
    status: "pass",
    message: `Node ${nodeVersion} matches the required major version ${DOCTOR_REQUIRED_NODE_MAJOR}.`,
    detail: { version: nodeVersion, major }
  };
}

/** Workspace package version consistency. */
export function checkPackageVersions(
  versions: Readonly<Record<string, string>> | null
): DoctorCheck {
  const names = Object.keys(versions ?? {});
  if (names.length === 0) {
    return {
      id: "runtime.packages",
      status: "warn",
      message: "No workspace package versions were supplied."
    };
  }
  const distinct = [...new Set(names.map((name) => versions?.[name] ?? ""))];
  if (distinct.length === 1) {
    return {
      id: "runtime.packages",
      status: "pass",
      message: `All ${names.length} workspace packages report version ${distinct[0] ?? ""}.`,
      detail: { packages: names.length, version: distinct[0] ?? "" }
    };
  }
  return {
    id: "runtime.packages",
    status: "warn",
    message: `Workspace package versions differ across ${names.length} packages: ${distinct
      .slice(0, 5)
      .join(", ")}.`,
    detail: { packages: names.length, distinct: distinct.length }
  };
}

/**
 * Open a private in-memory store, verify it, and close it. The probe
 * uses the same state-store entry points a run uses.
 */
export function probeSqliteStore(): DoctorStoreResult {
  let opened: ReturnType<typeof openDatabase> | undefined;
  try {
    opened = openDatabase({ path: ":memory:" });
    const integrity = integrityCheck(opened.db);
    const journalMode = opened.journalMode;
    closeDatabase(opened.db);
    return {
      opened: true,
      integrity,
      journalMode,
      error: null
    };
  } catch (error) {
    if (opened !== undefined && opened.db.isOpen) {
      closeDatabase(opened.db);
    }
    return {
      opened: false,
      integrity: null,
      journalMode: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** SQLite availability through the state store. */
export function checkSqliteStore(): DoctorCheck {
  const result = probeSqliteStore();
  if (result.opened && result.integrity === true) {
    return {
      id: "store.sqlite",
      status: "pass",
      message: "The SQLite state store opens and passes its integrity check.",
      detail: { journal_mode: result.journalMode ?? "" }
    };
  }
  return {
    id: "store.sqlite",
    status: "fail",
    message: `The SQLite state store is unavailable: ${result.error ?? "integrity check failed"}.`
  };
}

/** Presence and loadability of pack and study schema files. */
export function checkSchemaFiles(
  files: readonly DoctorSchemaFile[]
): DoctorCheck[] {
  if (files.length === 0) {
    return [
      {
        id: "schemas.files",
        status: "warn",
        message:
          "No schema files were supplied; pack and study schemas were not checked."
      }
    ];
  }
  return files.map((file): DoctorCheck => {
    try {
      const loaded = file.load();
      if (loaded === null || loaded === undefined) {
        return {
          id: `schemas.${file.id}`,
          status: "fail",
          message: `Schema file '${file.id}' did not load.`
        };
      }
      if (typeof loaded !== "object" || Array.isArray(loaded)) {
        return {
          id: `schemas.${file.id}`,
          status: "fail",
          message: `Schema file '${file.id}' did not yield a schema object.`
        };
      }
      return {
        id: `schemas.${file.id}`,
        status: "pass",
        message: `Schema file '${file.id}' is present and loadable.`
      };
    } catch (error) {
      return {
        id: `schemas.${file.id}`,
        status: "fail",
        message: `Schema file '${file.id}' failed to load: ${
          error instanceof Error ? error.message : String(error)
        }.`
      };
    }
  });
}

/** Adapter executable and feature probe result. */
export async function checkAdapter(
  adapter: DoctorAdapter | null
): Promise<DoctorCheck> {
  if (adapter === null) {
    return {
      id: "adapter.probe",
      status: "warn",
      message: "No agent adapter is configured; the probe was skipped."
    };
  }
  let result: DoctorAdapterResult;
  try {
    result = await adapter.probe();
  } catch (error) {
    return {
      id: "adapter.probe",
      status: "fail",
      message: `Agent adapter '${adapter.name}' probe threw: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      detail: { adapter: adapter.name }
    };
  }
  const features = result.features.join(", ");
  if (result.ok) {
    return {
      id: "adapter.probe",
      status: "pass",
      message: `Agent adapter '${adapter.name}' probe succeeded.`,
      detail: { adapter: adapter.name, features }
    };
  }
  return {
    id: "adapter.probe",
    status: "fail",
    message: `Agent adapter '${adapter.name}' probe failed: ${result.detail ?? "no detail"}.`,
    detail: { adapter: adapter.name, features }
  };
}

/** Gateway determinism double-check through the full pipeline. */
export function checkGatewayDeterminism(): DoctorCheck {
  const asJson = (value: unknown): Json => value as Json;
  const options = probeGatewayOptions();
  const first = handleGatewayRequest(options, 1, PROBE_REQUEST);
  const second = handleGatewayRequest(options, 1, PROBE_REQUEST);
  const third = handleGatewayRequest(probeGatewayOptions(), 1, PROBE_REQUEST);
  const firstJson = canonicalJson(asJson(first));
  const same =
    firstJson === canonicalJson(asJson(second)) &&
    firstJson === canonicalJson(asJson(third));
  if (!same) {
    return {
      id: "gateway.determinism",
      status: "fail",
      message: "The gateway produced different responses for identical inputs."
    };
  }
  if (first.frameworkCode !== null) {
    return {
      id: "gateway.determinism",
      status: "warn",
      message: `The gateway is deterministic but the probe hit framework error ${first.frameworkCode}.`,
      detail: { status: first.status, framework_code: first.frameworkCode }
    };
  }
  return {
    id: "gateway.determinism",
    status: "pass",
    message: "The gateway returns identical responses for identical inputs.",
    detail: {
      status: first.status,
      provenance: first.provenance
    }
  };
}

/** Writability of the artifact directory. */
export async function checkDiskArtifacts(
  artifact: DoctorDiskArtifact | null
): Promise<DoctorCheck> {
  if (artifact === null) {
    return {
      id: "disk.artifacts",
      status: "warn",
      message:
        "No artifact directory was supplied; the write probe was skipped."
    };
  }
  const result = await artifact.write();
  if (result.ok) {
    return {
      id: "disk.artifacts",
      status: "pass",
      message: "The artifacts directory accepts writes.",
      detail: { directory: artifact.directory }
    };
  }
  return {
    id: "disk.artifacts",
    status: "fail",
    message: `The artifacts directory rejects writes: ${result.error ?? "unknown error"}.`,
    detail: { directory: artifact.directory }
  };
}

/** Limits table sanity against the section 31.1 ceilings. */
export function checkLimits(limits: DoctorLimitsInput | null): DoctorCheck {
  if (limits === null) {
    return {
      id: "limits.table",
      status: "warn",
      message: "No limits table was supplied."
    };
  }
  const invalid: string[] = [];
  const overCeiling: string[] = [];
  const missingCeiling: string[] = [];
  for (const key of Object.keys(limits.table)) {
    const value = limits.table[key as keyof DoctorLimitTable];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      invalid.push(key);
      continue;
    }
    const ceiling = limits.ceilings[key as keyof DoctorLimitTable];
    if (ceiling === undefined) {
      missingCeiling.push(key);
    } else if (value > ceiling) {
      overCeiling.push(key);
    }
  }
  const entries = Object.keys(limits.table).length;
  if (invalid.length > 0) {
    return {
      id: "limits.table",
      status: "fail",
      message: `Limits table holds invalid values for: ${bounded(invalid)}.`,
      detail: { entries, invalid: invalid.length }
    };
  }
  if (overCeiling.length > 0) {
    return {
      id: "limits.table",
      status: "fail",
      message: `Limit ${overCeiling[0] ?? ""} exceeds its hard ceiling.`,
      detail: { entries, over_ceiling: overCeiling.length }
    };
  }
  if (missingCeiling.length > 0) {
    return {
      id: "limits.table",
      status: "warn",
      message: `No ceiling is known for: ${bounded(missingCeiling)}.`,
      detail: { entries, missing_ceiling: missingCeiling.length }
    };
  }
  return {
    id: "limits.table",
    status: "pass",
    message: `The limits table is sane; ${entries} entries were checked.`,
    detail: { entries }
  };
}

async function checkCapability(
  capability: DoctorCapability,
  probe: DoctorCapabilityProbe | null
): Promise<DoctorCheck> {
  if (probe === null) {
    return {
      id: `capability.${capability}`,
      status: "warn",
      message: `Capability '${capability}' was not assessed.`
    };
  }
  let result: DoctorCapabilityResult;
  try {
    result = await probe();
  } catch (error) {
    return {
      id: `capability.${capability}`,
      status: "fail",
      message: `Capability probe '${capability}' threw: ${
        error instanceof Error ? error.message : String(error)
      }.`
    };
  }
  if (result.supported === true) {
    return {
      id: `capability.${capability}`,
      status: "pass",
      message: `Capability '${capability}' is supported.`,
      detail: { detail: result.detail ?? "" }
    };
  }
  if (result.supported === null) {
    return {
      id: `capability.${capability}`,
      status: "warn",
      message: `Capability '${capability}' could not be determined: ${result.detail ?? "no detail"}.`
    };
  }
  return {
    id: `capability.${capability}`,
    status: "warn",
    message: `Capability '${capability}' is not supported: ${result.detail ?? "no detail"}.`
  };
}

function bounded(values: readonly string[]): string {
  const shown = values.slice(0, 5).join(", ");
  return values.length > 5 ? `${shown}, and ${values.length - 5} more` : shown;
}

/** Aggregate checks into one report with an overall status. */
export function aggregateDoctorReport(
  checks: readonly DoctorCheck[]
): DoctorReport {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    if (check.status === "pass") {
      counts.pass += 1;
    } else if (check.status === "warn") {
      counts.warn += 1;
    } else {
      counts.fail += 1;
    }
  }
  const status: DoctorStatus =
    counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    kind: DOCTOR_REPORT_KIND,
    checks: [...checks],
    status,
    counts
  };
}

/**
 * Run every doctor check. Probe results arrive through the input, so
 * the engine itself performs no process creation and no network call.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNodeRuntime(input.nodeVersion),
    checkPackageVersions(input.packageVersions ?? null),
    checkSqliteStore(),
    ...checkSchemaFiles(input.schemaFiles ?? []),
    await checkAdapter(input.adapter ?? null),
    checkGatewayDeterminism(),
    await checkDiskArtifacts(input.diskArtifact ?? null),
    checkLimits(input.limits ?? null)
  ];
  for (const capability of DOCTOR_CAPABILITIES) {
    checks.push(
      await checkCapability(
        capability,
        input.capabilities?.[capability] ?? null
      )
    );
  }
  return aggregateDoctorReport(checks);
}
