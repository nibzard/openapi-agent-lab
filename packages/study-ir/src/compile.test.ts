import { describe, expect, it } from "vitest";

import {
  canonicalJsonSha256,
  SchemaValidator,
  sha256Hex,
  type Json
} from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";

import {
  compileStudy,
  protocolSourceDigest,
  serializeStudyIr,
  studyIrJson,
  studyIrSha256
} from "./compile.ts";
import { loadProtocol, protocolJson } from "./protocol.ts";
import type { StudyCompileResult, StudyIR } from "./compile.ts";
import {
  baseMembers,
  baseProtocolDoc,
  loadSchema,
  RUN_PROFILE_TEXT,
  SURFACE_POLICY_TEXT,
  VARIANT_SET_TEXT
} from "./fixtures.ts";

const protocolSchema = loadSchema("study-protocol.v1.schema.json");
const irSchema = loadSchema("study-ir.v1.schema.json");

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

/** One present field of a fixture object. */
function fieldOf(record: Record<string, Json>, key: string): Json {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`Fixture field ${JSON.stringify(key)} is absent.`);
  }
  return value;
}

/** The compiled IR of a result that must have compiled. */
function irOf(result: StudyCompileResult): StudyIR {
  if (result.ir === null) {
    throw new Error(
      `Fixture compile failed: ${codesOf(result.diagnostics).join(", ")}`
    );
  }
  return result.ir;
}

function compileFixture() {
  const protocol = loadProtocol(baseProtocolDoc(), {
    schema: protocolSchema
  }).protocol;
  if (protocol === null) {
    throw new Error("Fixture protocol must load.");
  }
  return compileStudy(protocol, {
    schema: irSchema,
    members: baseMembers()
  });
}

/** The smallest ContractIR that still names one canonical operation key. */
function minimalContract(keys: string[]): ContractIR {
  const operations: OperationIR[] = keys.map((key) => ({
    key,
    uid: `op_${sha256Hex(key).slice(0, 12)}`,
    surface: "path",
    method: "GET",
    path_template: "/v1/widgets",
    route_segments: [],
    operation_id: null,
    tool_name: "listWidgets",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    request_body: null,
    responses: [],
    security: null,
    callbacks: [],
    extensions: {},
    source_pointer: "/paths/~1v1~1widgets/get",
    support: { level: "supported", diagnostic_codes: [] }
  }));
  return {
    $schema: "https://agentlab.dev/schemas/contract-ir.v1.json",
    schema_version: 1,
    kind: "ContractIR",
    compiler: { name: "fixture", version: "1.0.0" },
    source: {
      entrypoint: "contract/openapi.json",
      media_type: "application/json",
      openapi_version: "3.1.0",
      sha256: sha256Hex("contract"),
      semantic_sha256: sha256Hex("contract semantic"),
      execution_sha256: sha256Hex("contract execution"),
      documents: []
    },
    api: { title: null, version: null, description: null, servers: [] },
    security_schemes: {},
    schemas: {},
    operations,
    webhooks: [],
    diagnostics: [],
    extensions: {}
  };
}

describe("compileStudy", () => {
  it("compiles a validated protocol into schema-valid IR", () => {
    const result = compileFixture();
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).not.toBeNull();
    const violations = new SchemaValidator(irSchema).errors(
      studyIrJson(irOf(result))
    );
    expect(violations).toEqual([]);
  });

  it("rewrites authored dotted patches into canonical nested objects", () => {
    const ir = irOf(compileFixture());
    const documentation = ir.factors.find(
      (factor) => factor.id === "documentation"
    );
    const discoverable = documentation?.levels.find(
      (level) => level.id === "discoverable"
    );
    expect(discoverable?.run_profile_patch).toEqual({
      exposure: {
        contract_visibility: "discoverable",
        documentation_profile: "openapi-conventional-v1"
      }
    });
  });

  it("orders factors, levels, and cells canonically", () => {
    const reversed = baseProtocolDoc();
    const factors = reversed["factors"] as Json[];
    const first = factors[0];
    const second = factors[1];
    if (first === undefined || second === undefined) {
      throw new Error("Fixture must declare two factors.");
    }
    reversed["factors"] = [second, first];
    const protocol = loadProtocol(reversed, {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Reordered fixture protocol must load.");
    }
    const result = compileStudy(protocol, {
      schema: irSchema,
      members: baseMembers()
    });
    const ir = irOf(result);
    expect(ir.factors.map((factor) => factor.id)).toEqual([
      "api_shape",
      "documentation"
    ]);
    expect(ir.factors[0]?.levels.map((level) => level.id)).toEqual([
      "shape_a",
      "shape_b"
    ]);
    expect(ir.cells.map((cell) => cell.cell_id)).toEqual([
      "shape_a__blind",
      "shape_a__discoverable",
      "shape_a__supplied",
      "shape_b__blind",
      "shape_b__discoverable",
      "shape_b__supplied"
    ]);
  });

  it("freezes a digest for every referenced member", () => {
    const ir = irOf(compileFixture());
    expect(ir.constants.run_profile_sha256).toBe(sha256Hex(RUN_PROFILE_TEXT));
    expect(ir.evaluation.contract_variant_set_sha256).toBe(
      sha256Hex(VARIANT_SET_TEXT)
    );
    expect(ir.blinding.participant_surface_policy_sha256).toBe(
      sha256Hex(SURFACE_POLICY_TEXT)
    );
  });

  it("records the canonical protocol source digest", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const ir = irOf(compileFixture());
    expect(ir.protocol.source_sha256).toBe(protocolSourceDigest(protocol));
    expect(ir.protocol.source_sha256).toBe(
      canonicalJsonSha256(protocolJson(protocol))
    );
  });

  it("fails on a member the protocol names but the caller omits", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const members = new Map(baseMembers());
    members.delete("phases/pilot.yaml");
    const result = compileStudy(protocol, { schema: irSchema, members });
    expect(result.ir).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-MEMBER-MISSING");
  });

  it("verifies operation references against the contract", () => {
    const doc = baseProtocolDoc();
    const factors = doc["factors"] as Record<string, unknown>[];
    const documentation = factors[1] as {
      levels: { run_profile_patch?: Record<string, string> }[];
    };
    const blind = documentation.levels[2];
    if (blind === undefined) {
      throw new Error("Fixture has no third documentation level.");
    }
    blind.run_profile_patch = {
      "exposure.documentation_profile": "path:GET /v1/widgets"
    };
    const protocol = loadProtocol(doc, {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const missing = compileStudy(protocol, {
      schema: irSchema,
      members: baseMembers(),
      contract: minimalContract(["path:GET /v1/other"])
    });
    expect(missing.ir).toBeNull();
    expect(codesOf(missing.diagnostics)).toContain(
      "OAL-STUDY-OPERATION-UNKNOWN"
    );
    const present = compileStudy(protocol, {
      schema: irSchema,
      members: baseMembers(),
      contract: minimalContract(["path:GET /v1/widgets"])
    });
    expect(present.diagnostics).toEqual([]);
  });
});

describe("compile determinism", () => {
  it("produces byte-identical canonical IR for equal inputs", () => {
    const first = compileFixture();
    const second = compileFixture();
    expect(serializeStudyIr(irOf(second))).toBe(serializeStudyIr(irOf(first)));
    expect(studyIrSha256(irOf(second))).toBe(studyIrSha256(irOf(first)));
  });

  it("is independent of authored key order inside the document", () => {
    const reordered = baseProtocolDoc();
    const constants = reordered["constants"] as Record<string, Json>;
    reordered["constants"] = {
      response_profile: fieldOf(constants, "response_profile"),
      data_plane_scope: fieldOf(constants, "data_plane_scope"),
      required_parallel: fieldOf(constants, "required_parallel"),
      run_profile: fieldOf(constants, "run_profile")
    };
    const other = loadProtocol(reordered, {
      schema: protocolSchema
    }).protocol;
    if (other === null) {
      throw new Error("Reordered fixture protocol must load.");
    }
    const base = compileFixture();
    const reorderedResult = compileStudy(other, {
      schema: irSchema,
      members: baseMembers()
    });
    expect(serializeStudyIr(irOf(reorderedResult))).toBe(
      serializeStudyIr(irOf(base))
    );
  });

  it("changes the IR digest when member bytes change", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const changed = new Map(baseMembers());
    changed.set(
      "profiles/codex-high-raw-sequential.yaml",
      `${RUN_PROFILE_TEXT}# edited\n`
    );
    const base = compileFixture();
    const other = compileStudy(protocol, {
      schema: irSchema,
      members: changed
    });
    expect(studyIrSha256(irOf(other))).not.toBe(studyIrSha256(irOf(base)));
  });
});
