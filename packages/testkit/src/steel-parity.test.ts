/**
 * Steel parity suite for the Steel Computer pack, version 0.1.0
 * (specification section 39.5, migration sequence of section 39.7).
 *
 * There is no older implementation to diff against, so parity means
 * the migrated pack validates against the source contract
 * `examples/steel-v1.json` and keeps every section 39.5 behavior that
 * version 0.1.0 can express. The companion file
 * `steel-parity-golden.test.ts` freezes the response trace, and
 * `packs/steel-computer/PARITY.md` records the coverage of each
 * section 39.5 bullet.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { isJsonObject, type JsonObject, type Json } from "@oal/core";
import {
  evaluateSecurity,
  handleGatewayRequest,
  matchRoute,
  mintRunCredentials,
  type GatewayOptions,
  type RawRequest
} from "@oal/gateway";
import { templateVariables } from "@oal/pack";

import {
  compilePackContract,
  findRepoRoot,
  loadSteelPack,
  type PackForTest
} from "./index.ts";
import {
  compileSteelSourceContract,
  credentialFindings,
  fillPathTemplate,
  operationOf,
  packFilePaths,
  packResponseFixtures,
  parityApiKey,
  parityGatewayOptions,
  participantReferences,
  sha256OfFile,
  STEEL_API_KEY_HEADER,
  studyLabelFindings,
  type ScanFinding
} from "./steel-parity.ts";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** Digest pairs the PackIR records: contract, prompts, evals, files. */
const DIGEST_PAIR_COUNT = 23;

/**
 * Path segments that name a platform endpoint, never a product route.
 * The documentation facade of specification section 9.4 serves the
 * contract outside ContractIR, so no facade route can appear here.
 */
const FORBIDDEN_SEGMENTS: readonly string[] = [
  "health",
  "healthz",
  "ready",
  "readiness",
  "reset",
  "admin",
  "actuator",
  "debug",
  "metrics",
  "introspect",
  "internal",
  "swagger",
  "docs",
  "documentation",
  "openapi.json",
  "openapi.yaml",
  "__"
];

/** Read one JSON value as text, with the empty string as fallback. */
function textOf(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Read one JSON value as an object, or nothing when it is not one. */
function objectOf(value: Json | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

/** Read one JSON value as an array of objects, dropping other entries. */
function asObjectArray(value: Json | undefined): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonObject => isJsonObject(entry))
    : [];
}

/** Template variables that specification section 19.2 allows. */
function templateVariableAllowed(name: string): boolean {
  if (
    name === "pack.name" ||
    name === "pack.version" ||
    name === "api.baseUrl" ||
    name === "api.contractFile" ||
    name === "case.name"
  ) {
    return true;
  }
  return name.startsWith("case.input.");
}

let pack: PackForTest;
let repoRoot: string;

beforeAll(async () => {
  pack = await loadSteelPack();
  repoRoot = findRepoRoot();
});

describe("Steel parity: operation coverage", () => {
  it("compiles source and pack to the same 41 operations", async () => {
    const source = await compileSteelSourceContract(repoRoot);
    const migrated = await compilePackContract(pack.loaded);
    // Both sides emit the same single capability warning for the ZIP
    // media type of `download_archive` (migration note drift item 8)
    // and no error diagnostic.
    for (const result of [source, migrated]) {
      expect(
        result.report.diagnostics.filter((entry) => entry.severity === "error")
      ).toEqual([]);
      expect(result.report.diagnostics).toHaveLength(1);
      expect(result.report.diagnostics[0]?.code).toBe(
        "OAL-CAP-MEDIA-UNSUPPORTED"
      );
    }
    expect(source.contract.operations).toHaveLength(41);
    expect(migrated.contract.operations).toHaveLength(41);

    const sourceKeys = source.contract.operations.map(
      (operation) => operation.key
    );
    expect(new Set(sourceKeys).size).toBe(41);
    const packKeys = migrated.contract.operations.map(
      (operation) => operation.key
    );
    expect(new Set(packKeys).size).toBe(41);

    // The pack adds no operation the source does not declare, and it
    // drops none: the two key sets are identical.
    expect(packKeys.filter((key) => !sourceKeys.includes(key))).toEqual([]);
    expect(sourceKeys.filter((key) => !packKeys.includes(key))).toEqual([]);

    for (const key of sourceKeys) {
      const sourceOperation = operationOf(source.contract, key);
      const packOperation = operationOf(migrated.contract, key);
      expect(packOperation.method, key).toBe(sourceOperation.method);
      expect(packOperation.path_template, key).toBe(
        sourceOperation.path_template
      );
      expect(packOperation.operation_id, key).toBe(
        sourceOperation.operation_id
      );
    }
  });

  it("keeps every operation reachable through the router", async () => {
    const migrated = await compilePackContract(pack.loaded);
    for (const operation of migrated.contract.operations) {
      const target = fillPathTemplate(operation.path_template);
      const route = matchRoute(
        migrated.contract.operations,
        operation.method,
        target
      );
      expect(route.match, operation.key).not.toBeNull();
      expect(route.match?.operation.key, operation.key).toBe(operation.key);
    }
  });

  it("resolves every eval to the exact full contract surface", () => {
    expect(pack.validation.errors).toEqual([]);
    expect([...pack.validation.coverage.contractOperations]).toHaveLength(41);
    const scopeIds = [...pack.validation.coverage.scope.keys()].sort();
    expect(scopeIds).toEqual([
      "basic-lifecycle",
      "checkpoint-recovery",
      "documentation-discovery"
    ]);
    for (const keys of pack.validation.coverage.scope.values()) {
      expect(keys).toHaveLength(41);
    }
  });
});

describe("Steel parity: no undeclared platform endpoints", () => {
  it("declares no health, reset, admin, or introspection route", async () => {
    const migrated = await compilePackContract(pack.loaded);
    expect(migrated.contract.operations).toHaveLength(41);
    for (const operation of migrated.contract.operations) {
      const segments = operation.path_template
        .split("/")
        .map((segment) => segment.toLowerCase());
      for (const forbidden of FORBIDDEN_SEGMENTS) {
        expect(
          segments.includes(forbidden),
          `${operation.key} must not declare ${forbidden}`
        ).toBe(false);
      }
      expect(
        operation.path_template === "/.well-known/jwks.json" ||
          operation.path_template.startsWith("/v1/"),
        operation.key
      ).toBe(true);
    }
  });

  it("ships no production server URL with the pack", async () => {
    const source = await compileSteelSourceContract(repoRoot);
    const migrated = await compilePackContract(pack.loaded);
    const entry = pack.loaded.references.find(
      (reference) => reference.role === "contract_entrypoint"
    );
    const packContractText =
      entry === undefined ? "" : await readFile(entry.absolutePath, "utf8");
    const sourceContractText = await readFile(
      path.join(repoRoot, "examples", "steel-v1.json"),
      "utf8"
    );

    expect(source.contract.api.servers).toHaveLength(1);
    expect(source.contract.api.servers[0]?.url).toBe("https://api.steel.dev");
    expect(migrated.contract.api.servers).toEqual([]);
    expect(packContractText).not.toContain("api.steel.dev");
    expect(sourceContractText).toContain("api.steel.dev");
    const participantCopy = objectOf(
      objectOf(pack.loaded.manifest["contract"])?.["participant_copy"]
    );
    expect(participantCopy?.["replace_servers"]).toBe(true);
    expect(participantCopy?.["external_docs"]).toBe("strip");
  });
});

describe("Steel parity: API key behavior", () => {
  it("preserves the source security scheme", async () => {
    const source = await compileSteelSourceContract(repoRoot);
    const migrated = await compilePackContract(pack.loaded);
    for (const contract of [source.contract, migrated.contract]) {
      expect(Object.keys(contract.security_schemes)).toEqual(["apiKey"]);
      const scheme = contract.security_schemes["apiKey"];
      expect(scheme?.type).toBe("apiKey");
      expect(scheme?.location).toBe("header");
      expect(scheme?.wire_name).toBe(STEEL_API_KEY_HEADER);
    }
  });

  it("accepts a minted run credential through the gateway", async () => {
    const migrated = await compilePackContract(pack.loaded);
    const contract = migrated.contract;
    const fixtures = await packResponseFixtures(
      pack.loaded.root,
      pack.loaded.manifest
    );
    const options = parityGatewayOptions(contract, fixtures);
    const apiKey = parityApiKey(contract);
    expect(apiKey).toMatch(/^oal_[0-9a-f]{24}$/u);
    expect(mintRunCredentials(contract, "seed-a").apiKeys["apiKey"]).toBe(
      mintRunCredentials(contract, "seed-a").apiKeys["apiKey"]
    );
    expect(mintRunCredentials(contract, "seed-b").apiKeys["apiKey"]).not.toBe(
      apiKey
    );

    const withKey: RawRequest = {
      method: "GET",
      target: "/v1/sessions",
      headers: { [STEEL_API_KEY_HEADER]: apiKey },
      body: new Uint8Array(0)
    };
    const response = handleGatewayRequest(options, 1, withKey);
    expect(response.status).toBe(200);
    expect(response.frameworkCode).toBeNull();
    expect(response.provenance).toBe("fixture:sessions-list-empty");
  });

  it("keeps the published anonymous alternative until the runner enforces the pack credential", async () => {
    const migrated = await compilePackContract(pack.loaded);
    const contract = migrated.contract;
    const operation = operationOf(contract, "path:GET /v1/sessions");

    // The source contract declares `security: [{"apiKey": []}, {}]`.
    // Specification section 13.7 keeps the empty requirement as an
    // anonymous alternative, so the contract-level gateway always
    // resolves the anonymous principal, with or without a presented
    // key. Migration note drift item 4 records this: the pack
    // compensates with `security.enforce: true` and one generated
    // credential, and the enforced 401 problem document lands with the
    // runner wiring (tasks T042 and T053). The previous test proves
    // the minted credential is accepted through the full pipeline.
    expect(operation.security?.anonymous).toBe(true);
    expect(operation.security?.alternatives).toEqual([
      { schemes: [{ name: "apiKey", scopes: [] }] },
      { schemes: [] }
    ]);
    const credentials = mintRunCredentials(contract, "seed-a");
    const anonymous = evaluateSecurity(
      operation,
      contract,
      { headers: {}, query: {}, cookies: {} },
      credentials
    );
    expect(anonymous).toEqual({
      ok: true,
      principal: { scheme: "anonymous", scopes: [], anonymous: true }
    });
    const withKey = evaluateSecurity(
      operation,
      contract,
      {
        headers: {
          [STEEL_API_KEY_HEADER]: credentials.apiKeys["apiKey"] ?? ""
        },
        query: {},
        cookies: {}
      },
      credentials
    );
    expect(withKey).toEqual({
      ok: true,
      principal: { scheme: "anonymous", scopes: [], anonymous: true }
    });

    const security = objectOf(pack.loaded.manifest["security"]);
    expect(security?.["enforce"]).toBe(true);
    const declared = asObjectArray(security?.["credentials"]);
    expect(declared).toHaveLength(1);
    const credential = declared[0];
    expect(credential?.["scheme"]).toBe("apiKey");
    expect(objectOf(credential?.["provider"])?.["kind"]).toBe("generated");
    expect(objectOf(credential?.["expose"])?.["environment"]).toBe(
      "STEEL_API_KEY"
    );
    expect(security?.["base_url_environment"]).toBe("STEEL_BASE_URL");
  });
});

describe("Steel parity: Steel signals stay observable", () => {
  let options: GatewayOptions;

  beforeAll(async () => {
    const migrated = await compilePackContract(pack.loaded);
    const fixtures = await packResponseFixtures(
      pack.loaded.root,
      pack.loaded.manifest
    );
    options = parityGatewayOptions(migrated.contract, fixtures);
  });

  function problem(
    method: string,
    target: string,
    sequence: number
  ): {
    status: number;
    document: Record<string, unknown>;
    headers: Record<string, string>;
  } {
    const response = handleGatewayRequest(options, sequence, {
      method,
      target,
      headers: { [STEEL_API_KEY_HEADER]: parityApiKey(options.contract) },
      body: new Uint8Array(0)
    });
    const document = JSON.parse(response.body ?? "{}") as Record<
      string,
      unknown
    >;
    return { status: response.status, document, headers: response.headers };
  }

  it("answers an unknown endpoint with the neutral route_not_found problem", () => {
    const { status, document, headers } = problem(
      "GET",
      "/v1/not-a-steel-route",
      1
    );
    expect(status).toBe(404);
    expect(headers["content-type"]).toBe("application/problem+json");
    // Exactly five fields: no route hints, no violations, no detail.
    expect(document).toEqual({
      type: "https://agentlab.dev/problems/route_not_found",
      title: "The request target is not a known route.",
      status: 404,
      code: "route_not_found",
      request_id: "req_00000001"
    });
  });

  it("answers a wrong method with method_not_allowed and the allow header", () => {
    const { status, document, headers } = problem("DELETE", "/v1/sessions", 2);
    expect(status).toBe(405);
    expect(document.code).toBe("method_not_allowed");
    expect(headers.allow).toBe("GET, POST");
  });

  it("rejects a checkpoint-on-create attempt", async () => {
    const migrated = await compilePackContract(pack.loaded);
    const create = operationOf(migrated.contract, "path:POST /v1/sessions");
    const schemaRef = create.request_body?.content[0]?.schema_ref;
    expect(schemaRef).toBeDefined();
    const requestSchema = migrated.contract.schemas[schemaRef ?? ""];
    expect(requestSchema).toBeDefined();
    const schemaBody = requestSchema?.schema as JsonObject;
    const properties = schemaBody["properties"] as JsonObject;
    expect(Object.keys(properties)).not.toContain("checkpoint_id");
    expect(schemaBody["additionalProperties"]).toBe(false);

    // The source contract keeps the same limit, so the pack gained no
    // checkpoint identity on creation (drift item 16).
    const source = await compileSteelSourceContract(repoRoot);
    const sourceCreate = operationOf(source.contract, "path:POST /v1/sessions");
    const sourceRef = sourceCreate.request_body?.content[0]?.schema_ref;
    const sourceBody = source.contract.schemas[sourceRef ?? ""]?.schema as
      | JsonObject
      | undefined;
    const sourceProperties = (sourceBody?.["properties"] ?? {}) as JsonObject;
    expect(Object.keys(sourceProperties)).not.toContain("checkpoint_id");

    const response = handleGatewayRequest(options, 3, {
      method: "POST",
      target: "/v1/sessions",
      headers: {
        [STEEL_API_KEY_HEADER]: parityApiKey(options.contract),
        "content-type": "application/json"
      },
      body: new TextEncoder().encode('{"checkpoint_id":"cp-1"}')
    });
    expect(response.status).toBe(422);
    expect(response.frameworkCode).toBe("request_schema_invalid");
    const document = JSON.parse(response.body ?? "{}") as JsonObject;
    const violations = asObjectArray(document["violations"]);
    const checkpoint = violations.find((violation) =>
      textOf(violation["message"]).includes("checkpoint_id")
    );
    expect(textOf(checkpoint?.["code"])).toBe("additionalProperties");
  });

  it("answers invented routes with the same neutral problem", () => {
    const sessionId = "00000000-0000-0000-0000-000000000000";
    const invented: readonly (readonly [string, string])[] = [
      ["POST", `/v1/sessions/${sessionId}/fork`],
      ["POST", `/v1/sessions/${sessionId}/clone`],
      ["POST", `/v1/sessions/${sessionId}/snapshot`],
      ["GET", "/v1/browser"],
      ["POST", "/v1/computers"],
      ["GET", "/v1/checkpoints"]
    ];
    invented.forEach(([method, target], index) => {
      const { status, document } = problem(method, target, index + 10);
      expect(status, target).toBe(404);
      expect(document.code, target).toBe("route_not_found");
      expect(Object.keys(document).sort(), target).toEqual([
        "code",
        "request_id",
        "status",
        "title",
        "type"
      ]);
    });
  });
});

describe("Steel parity: redaction", () => {
  it("ships no credential-shaped material in any pack file", async () => {
    const findings: ScanFinding[] = [];
    for (const relative of await packFilePaths(pack.root)) {
      const text = await readFile(path.join(pack.root, relative), "utf8");
      findings.push(...credentialFindings(relative, text));
    }
    expect(findings).toEqual([]);
  });

  it("ships no study labels in participant-visible artifacts", async () => {
    const findings: ScanFinding[] = [];
    for (const reference of participantReferences(pack.loaded.references)) {
      const text = await readFile(reference.absolutePath, "utf8");
      findings.push(...studyLabelFindings(reference.path, text));
    }
    const manifestText = await readFile(
      path.join(pack.root, pack.loaded.manifestName),
      "utf8"
    );
    findings.push(
      ...studyLabelFindings(pack.loaded.manifestName, manifestText)
    );
    expect(findings).toEqual([]);
  });

  it("uses only allowed template variables", () => {
    const packIr = pack.validation.packIr;
    expect(packIr).not.toBeNull();
    for (const set of asObjectArray(packIr?.["prompt_sets"])) {
      const declared = set["variables"];
      const names = Array.isArray(declared) ? declared.map(textOf) : [];
      for (const name of names.filter((value) => value !== "")) {
        expect(templateVariableAllowed(name), name).toBe(true);
      }
    }
    const tasks = pack.loaded.references.filter(
      (entry) => entry.role === "task"
    );
    expect(tasks).toHaveLength(3);
    for (const reference of tasks) {
      for (const name of templateVariables(reference.text ?? "")) {
        expect(
          templateVariableAllowed(name),
          `${reference.path}: ${name}`
        ).toBe(true);
      }
    }
  });
});

describe("Steel parity: hash coverage", () => {
  it("validates with zero errors and zero warnings", () => {
    expect(pack.validation.errors).toEqual([]);
    expect(pack.validation.warnings).toEqual([]);
    expect(pack.validation.packIr).not.toBeNull();
  });

  it("covers every declared artifact with a manifest digest", async () => {
    const packIr = pack.validation.packIr;
    expect(packIr).not.toBeNull();
    const irNode = packIr ?? {};
    const byPath = new Map(
      pack.loaded.references.map((reference) => [
        reference.path,
        reference.sha256
      ])
    );

    const digestPairs: { path: string; digest: string }[] = [];
    const contractNode = objectOf(irNode["contract"]);
    digestPairs.push({
      path: textOf(contractNode?.["entrypoint"]),
      digest: textOf(contractNode?.["source_sha256"])
    });
    const manifestSets = asObjectArray(pack.loaded.manifest["prompt_sets"]);
    for (const set of asObjectArray(irNode["prompt_sets"])) {
      const node = manifestSets.find((entry) => entry.id === set.id);
      const instructions = objectOf(node?.["instructions"]);
      const launch = objectOf(node?.["launch"]);
      digestPairs.push({
        path: textOf(instructions?.["source"]),
        digest: textOf(set["instructions_sha256"])
      });
      digestPairs.push({
        path: textOf(launch?.["source"]),
        digest: textOf(set["launch_sha256"])
      });
    }
    const manifestEvals = asObjectArray(pack.loaded.manifest["evals"]);
    for (const evaluation of asObjectArray(irNode["evals"])) {
      const node = manifestEvals.find((entry) => entry.id === evaluation.id);
      const task = objectOf(node?.["task"]);
      const result = objectOf(node?.["result"]);
      digestPairs.push({
        path: textOf(task?.["source"]),
        digest: textOf(evaluation["task_sha256"])
      });
      digestPairs.push({
        path: textOf(result?.["schema"]),
        digest: textOf(evaluation["result_schema_sha256"])
      });
      digestPairs.push({
        path: textOf(node?.["rubric"]),
        digest: textOf(evaluation["rubric_sha256"])
      });
    }
    for (const file of asObjectArray(irNode["participant_files"])) {
      digestPairs.push({
        path: textOf(file["source"]),
        digest: textOf(file["sha256"])
      });
    }
    const manifestScenarios = asObjectArray(pack.loaded.manifest["scenarios"]);
    for (const scenario of asObjectArray(irNode["scenarios"])) {
      const node = manifestScenarios.find((entry) => entry.id === scenario.id);
      const declared = node?.["fixtures"];
      const sources = Array.isArray(declared)
        ? declared.map((entry) => textOf(entry))
        : [];
      asObjectArray(scenario["fixtures"]).forEach((fixture, index) => {
        digestPairs.push({
          path: sources[index] ?? "",
          digest: textOf(fixture["sha256"])
        });
      });
    }

    expect(digestPairs).toHaveLength(DIGEST_PAIR_COUNT);
    for (const pair of digestPairs) {
      expect(pair.digest, pair.path).toMatch(DIGEST_PATTERN);
      expect(pair.digest, pair.path).toBe(byPath.get(pair.path));
    }

    const manifestDigest = await sha256OfFile(
      path.join(pack.root, pack.loaded.manifestName)
    );
    expect(objectOf(irNode["pack"])?.["manifest_sha256"]).toBe(manifestDigest);

    // Every hashed reference role is covered, and only the three known
    // gaps stay outside: response fixture bodies, case sources, and
    // case schemas. See PARITY.md.
    const digestValues = new Set(digestPairs.map((pair) => pair.digest));
    const covered = [
      ...new Set(
        pack.loaded.references
          .filter((reference) => digestValues.has(reference.sha256))
          .map((reference) => reference.role)
      )
    ].sort();
    expect(covered).toEqual([
      "contract_entrypoint",
      "participant_file",
      "prompt_instructions",
      "prompt_launch",
      "result_schema",
      "rubric",
      "state_fixture",
      "task"
    ]);
  });
});
