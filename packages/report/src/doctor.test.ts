import { describe, expect, it } from "vitest";

import {
  DOCTOR_CAPABILITIES,
  DOCTOR_PROBE_LIMITS,
  DOCTOR_REQUIRED_NODE_MAJOR,
  aggregateDoctorReport,
  checkAdapter,
  checkGatewayDeterminism,
  checkLimits,
  checkNodeRuntime,
  checkPackageVersions,
  checkSchemaFiles,
  checkSqliteStore,
  probeSqliteStore,
  runDoctor,
  type DoctorCapability,
  type DoctorCapabilityProbe,
  type DoctorCheck,
  type DoctorInput,
  type DoctorLimitTable
} from "./doctor.ts";

function healthyInput(): DoctorInput {
  const capabilities: Partial<Record<DoctorCapability, DoctorCapabilityProbe>> =
    {};
  for (const capability of DOCTOR_CAPABILITIES) {
    capabilities[capability] = () => ({
      supported: true,
      detail: capability
    });
  }
  return {
    nodeVersion: "24.18.0",
    packageVersions: { "@oal/core": "0.0.0", "@oal/gateway": "0.0.0" },
    schemaFiles: [
      { id: "pack", load: () => ({ schema_version: 1 }) },
      { id: "study", load: () => ({ schema_version: 1 }) }
    ],
    adapter: {
      name: "codex",
      probe: () => ({
        ok: true,
        features: ["spawn", "report"],
        detail: null
      })
    },
    diskArtifact: {
      directory: "artifacts",
      write: () => Promise.resolve({ ok: true, error: null })
    },
    limits: { table: DOCTOR_PROBE_LIMITS, ceilings: DOCTOR_PROBE_LIMITS },
    capabilities
  };
}

describe("runDoctor", () => {
  it("passes every check in a healthy environment", async () => {
    const report = await runDoctor(healthyInput());

    expect(report.status).toBe("pass");
    expect(report.counts).toEqual({ pass: 15, warn: 0, fail: 0 });
    expect(report.checks.map((check) => check.id)).toEqual([
      "runtime.node",
      "runtime.packages",
      "store.sqlite",
      "schemas.pack",
      "schemas.study",
      "adapter.probe",
      "gateway.determinism",
      "disk.artifacts",
      "limits.table",
      "capability.sandbox_mechanisms",
      "capability.loopback_ephemeral_ports",
      "capability.process_group_termination",
      "capability.network_isolation",
      "capability.file_permissions",
      "capability.container_runtime"
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("aggregates any failure into an overall fail", async () => {
    const input = healthyInput();
    const study = input.schemaFiles?.[1];
    if (study !== undefined) {
      study.load = (): never => {
        throw new Error("study schema missing");
      };
    }
    const report = await runDoctor(input);

    expect(report.status).toBe("fail");
    expect(report.counts.fail).toBe(1);
    const failed = report.checks.find((check) => check.status === "fail");
    expect(failed?.id).toBe("schemas.study");
    expect(failed?.message).toContain("study schema missing");
  });

  it("warns instead of failing when optional probes are absent", async () => {
    const report = await runDoctor({ nodeVersion: "24.18.0" });

    expect(report.status).toBe("warn");
    expect(report.counts.fail).toBe(0);
    const ids = new Set(report.checks.map((check) => check.id));
    for (const id of [
      "runtime.packages",
      "schemas.files",
      "adapter.probe",
      "disk.artifacts",
      "limits.table",
      "capability.sandbox_mechanisms"
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    const sqlite = report.checks.find((check) => check.id === "store.sqlite");
    expect(sqlite?.status).toBe("pass");
    const gateway = report.checks.find(
      (check) => check.id === "gateway.determinism"
    );
    expect(gateway?.status).toBe("pass");
  });

  it("fails an adapter probe that reports failure", async () => {
    const check = await checkAdapter({
      name: "codex",
      probe: () => ({
        ok: false,
        features: [],
        detail: "executable not found"
      })
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("executable not found");
  });

  it("fails an adapter probe that throws", async () => {
    const check = await checkAdapter({
      name: "generic",
      probe: (): never => {
        throw new Error("probe timed out");
      }
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("probe timed out");
  });
});

describe("doctor check units", () => {
  it("grades the runtime major version", () => {
    expect(checkNodeRuntime("24.18.0").status).toBe("pass");
    expect(checkNodeRuntime("v24.1.0").status).toBe("pass");
    expect(checkNodeRuntime("23.11.0").status).toBe("fail");
    expect(checkNodeRuntime("25.0.0").status).toBe("warn");
    expect(checkNodeRuntime("banana").status).toBe("fail");
    expect(checkNodeRuntime("24.18.0").detail?.["major"]).toBe(
      DOCTOR_REQUIRED_NODE_MAJOR
    );
  });

  it("grades workspace package version consistency", () => {
    expect(checkPackageVersions({ a: "0.0.0", b: "0.0.0" }).status).toBe(
      "pass"
    );
    expect(checkPackageVersions({ a: "0.0.0", b: "0.1.0" }).status).toBe(
      "warn"
    );
    expect(checkPackageVersions(null).status).toBe("warn");
  });

  it("opens and verifies the SQLite state store", () => {
    const probe = probeSqliteStore();
    expect(probe).toEqual({
      opened: true,
      integrity: true,
      journalMode: "memory",
      error: null
    });
    expect(checkSqliteStore().status).toBe("pass");
  });

  it("checks schema files for presence and loadability", () => {
    const checks = checkSchemaFiles([
      { id: "pack", load: () => ({ schema_version: 1 }) },
      { id: "study", load: () => null },
      {
        id: "broken",
        load: (): never => {
          throw new Error("unreadable");
        }
      }
    ]);
    expect(checks.map((check) => check.status)).toEqual([
      "pass",
      "fail",
      "fail"
    ]);
    expect(checks[2]?.message).toContain("unreadable");
    expect(checkSchemaFiles([])).toEqual([
      {
        id: "schemas.files",
        status: "warn",
        message:
          "No schema files were supplied; pack and study schemas were not checked."
      }
    ]);
  });

  it("confirms gateway determinism through the full pipeline", async () => {
    const check = await checkGatewayDeterminism();
    expect(check.status).toBe("pass");
    expect(check.detail?.["status"]).toBe(200);
  });

  it("rejects a limits table that is not sane", () => {
    const ceilings = DOCTOR_PROBE_LIMITS;
    const over: DoctorLimitTable = {
      ...DOCTOR_PROBE_LIMITS,
      maxRequestsPerRun: DOCTOR_PROBE_LIMITS.maxRequestsPerRun + 1
    };
    expect(checkLimits({ table: over, ceilings }).status).toBe("fail");

    const zero: DoctorLimitTable = {
      ...DOCTOR_PROBE_LIMITS,
      maxOperations: 0
    };
    const zeroCheck = checkLimits({ table: zero, ceilings });
    expect(zeroCheck.status).toBe("fail");
    expect(zeroCheck.message).toContain("maxOperations");

    const partialCeilings = Object.fromEntries(
      Object.entries(DOCTOR_PROBE_LIMITS).filter(
        ([key]) => key !== "maxSseDurationMs"
      )
    );
    const missingCheck = checkLimits({
      table: DOCTOR_PROBE_LIMITS,
      ceilings: partialCeilings
    });
    expect(missingCheck.status).toBe("warn");
    expect(missingCheck.message).toContain("maxSseDurationMs");

    expect(checkLimits({ table: DOCTOR_PROBE_LIMITS, ceilings }).status).toBe(
      "pass"
    );
  });

  it("aggregates statuses with fail over warn over pass", () => {
    const check = (status: DoctorCheck["status"]): DoctorCheck => ({
      id: "unit",
      status,
      message: "unit"
    });
    expect(aggregateDoctorReport([check("pass")]).status).toBe("pass");
    expect(aggregateDoctorReport([check("pass"), check("warn")]).status).toBe(
      "warn"
    );
    expect(
      aggregateDoctorReport([check("pass"), check("warn"), check("fail")])
        .status
    ).toBe("fail");
    const empty = aggregateDoctorReport([]);
    expect(empty.counts).toEqual({ pass: 0, warn: 0, fail: 0 });
    expect(empty.kind).toBe("DoctorReport");
  });
});
