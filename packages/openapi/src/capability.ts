import {
  canonicalJson,
  isToolName,
  type Diagnostic,
  type Json
} from "@oal/core";
import type {
  ContractIR,
  MediaContentIR,
  OperationIR,
  SupportLevel,
  WebhookIR
} from "@oal/contract-ir";
import {
  CAPABILITY_REPORT_SCHEMA_VERSION,
  type CapabilityRecommendations,
  type CapabilityReport,
  type CapabilitySurfaceRef,
  type FeatureCapability,
  type OperationCapability,
  type SupportCounts,
  type ToolViability
} from "@oal/capability";

import { jsonByteLength } from "./examples.ts";
import { generateToolName } from "./tools.ts";
import { responseSelectorSupport, worstOf } from "./support.ts";

/** Default direct-tools thresholds from specification section 9.3. */
export const DIRECT_TOOL_MAX_OPERATIONS = 50;
export const DIRECT_TOOL_MAX_SCHEMA_BYTES = 256 * 1024;

export interface CapabilityOptions {
  /** Exposure thresholds for direct tool generation. */
  readonly toolExposure?: {
    readonly maxOperations?: number;
    readonly maxSchemaBytes?: number;
  };
}

/** Every operation reachable from the contract, in canonical order. */
function allOperations(
  contract: ContractIR
): Array<{ operation: OperationIR; webhook: string | null }> {
  const out: Array<{ operation: OperationIR; webhook: string | null }> =
    contract.operations.map((operation) => ({ operation, webhook: null }));
  for (const hook of contract.webhooks) {
    for (const operation of hook.operations) {
      out.push({ operation, webhook: hook.name });
    }
  }
  return out.sort((a, b) => (a.operation.key < b.operation.key ? -1 : 1));
}

function emptyCounts(): SupportCounts {
  return {
    supported: 0,
    approximated: 0,
    requires_scenario: 0,
    unsupported: 0
  };
}

/** The name an operation prefers, before collision suffixes are applied. */
export function preferredToolName(
  operation: OperationIR,
  unique: boolean
): string {
  if (
    operation.operation_id !== null &&
    unique &&
    isToolName(operation.operation_id)
  ) {
    return operation.operation_id;
  }
  return generateToolName(operation.method, operation.path_template);
}

/** Tool descriptor bytes that a direct-tools adapter would publish. */
function toolDescriptorBytes(operation: OperationIR): number {
  return jsonByteLength({
    tool_name: operation.tool_name,
    summary: operation.summary,
    description: operation.description,
    parameters: operation.parameters.map((parameter) => ({
      name: parameter.name,
      location: parameter.location,
      style: parameter.style,
      explode: parameter.explode,
      required: parameter.required,
      schema_ref: parameter.schema_ref,
      content: parameter.content
    })),
    request_body: operation.request_body,
    responses: operation.responses
  } as unknown as Json);
}

const REQUIREMENT_TEXT: Readonly<Record<string, string>> = {
  "security:oauth2":
    "Supply synthetic OAuth 2.0 tokens and scope grants for the affected operations.",
  "security:open-id-connect":
    "Supply synthetic OpenID Connect tokens for the affected operations.",
  "security:mutualTLS":
    "Supply a mutual TLS stand-in or restrict runs away from mutualTLS schemes.",
  "response:no-success":
    "Declare a concrete 2xx response so deterministic success is observable.",
  "response:informational":
    "Cover the informational response with an explicit scenario expectation.",
  "webhook:invocation-unsupported":
    "Exercise webhooks through an outbound stand-in declared in the scenario.",
  "media:application/xml":
    "Provide XML payload fixtures or restrict runs to JSON media types.",
  "media:multipart":
    "Provide multipart fixtures with bounded part counts for the affected operations."
};

function requirementFor(code: string): string {
  const known = REQUIREMENT_TEXT[code];
  if (known !== undefined) {
    return known;
  }
  if (code.startsWith("style:")) {
    return `Provide a scenario that serializes the '${code.slice(6)}' parameter style.`;
  }
  if (code.startsWith("media:")) {
    return `Provide fixtures for media type '${code.slice(6)}'.`;
  }
  if (code.startsWith("schema:")) {
    return `Provide a scenario that constructs the '${code.slice(7)}' schema shape.`;
  }
  if (code.startsWith("parameter:content:")) {
    return `Provide a scenario that encodes parameters as '${code.slice("parameter:content:".length)}'.`;
  }
  if (code.startsWith("security:")) {
    return `Supply synthetic credentials for '${code.slice(9)}'.`;
  }
  if (code.startsWith("callback:")) {
    return `Exercise the '${code.slice(9)}' callback through an outbound stand-in.`;
  }
  return `Cover '${code}' with an explicit scenario requirement.`;
}

interface FeatureAccumulator {
  kind: FeatureCapability["kind"];
  name: string;
  level: SupportLevel;
  reasonCodes: Set<string>;
  operationKeys: Set<string>;
}

/**
 * Derive the machine-readable capability report from a compiled contract.
 * The report is a pure function of the contract, so identical contracts
 * produce identical reports.
 */
export function buildCapabilityReport(
  contract: ContractIR,
  options: CapabilityOptions = {}
): CapabilityReport {
  const operations = allOperations(contract);

  const operationCounts = emptyCounts();
  const schemeCounts = emptyCounts();
  const capabilities: OperationCapability[] = [];
  const features = new Map<string, FeatureAccumulator>();
  const duplicateIds = new Map<string, number>();
  const preferredCounts = new Map<string, number>();

  const record = (
    kind: FeatureCapability["kind"],
    name: string,
    level: SupportLevel,
    reasonCodes: readonly string[],
    operationKey: string
  ): void => {
    const key = JSON.stringify([kind, name]);
    const entry = features.get(key) ?? {
      kind,
      name,
      level: "supported",
      reasonCodes: new Set<string>(),
      operationKeys: new Set<string>()
    };
    entry.level = worstOf([entry.level, level]);
    for (const code of reasonCodes) {
      entry.reasonCodes.add(code);
    }
    entry.operationKeys.add(operationKey);
    features.set(key, entry);
  };

  const idOccurrences = new Map<string, number>();
  for (const { operation } of operations) {
    if (operation.operation_id !== null) {
      idOccurrences.set(
        operation.operation_id,
        (idOccurrences.get(operation.operation_id) ?? 0) + 1
      );
    }
  }
  for (const { operation, webhook } of operations) {
    operationCounts[operation.support.level] += 1;
    if (operation.operation_id !== null) {
      const count = idOccurrences.get(operation.operation_id) ?? 0;
      if (count > 1 && !duplicateIds.has(operation.operation_id)) {
        duplicateIds.set(operation.operation_id, count);
      }
    }
    const unique =
      operation.operation_id !== null &&
      idOccurrences.get(operation.operation_id) === 1;
    const preferred = preferredToolName(operation, unique);
    preferredCounts.set(preferred, (preferredCounts.get(preferred) ?? 0) + 1);

    const surfaces: CapabilitySurfaceRef[] = [];
    const reasonCodes = new Set<string>(operation.support.diagnostic_codes);
    for (const parameter of operation.parameters) {
      surfaces.push({
        kind: "parameter",
        name: `${parameter.location}:${parameter.name}`
      });
      record(
        "serialization",
        `${parameter.location}:${parameter.style}`,
        parameter.support,
        parameter.support_reason_codes,
        operation.key
      );
      for (const code of parameter.support_reason_codes) {
        reasonCodes.add(code);
      }
      if (parameter.content !== null) {
        surfaces.push({
          kind: "parameter",
          name: `${parameter.location}:${parameter.name}`
        });
        record(
          "media_type",
          parameter.content.media_type,
          parameter.support,
          parameter.support_reason_codes,
          operation.key
        );
      }
      if (
        parameter.schema_ref !== null &&
        parameter.support_reason_codes.some((code) =>
          code.startsWith("schema:")
        )
      ) {
        surfaces.push({ kind: "schema", name: parameter.schema_ref });
      }
    }
    const requestMedia = operation.request_body?.content ?? [];
    for (const content of requestMedia) {
      surfaces.push({ kind: "request_media_type", name: content.media_type });
      record(
        "media_type",
        content.media_type,
        content.support,
        content.support_reason_codes,
        operation.key
      );
      for (const code of content.support_reason_codes) {
        reasonCodes.add(code);
      }
    }
    for (const response of operation.responses) {
      surfaces.push({ kind: "response_selector", name: response.selector });
      const selector = responseSelectorSupport(
        response.selector,
        response.selector_kind
      );
      record(
        "response_generation",
        response.selector,
        selector.level,
        selector.reasonCodes,
        operation.key
      );
      for (const code of selector.reasonCodes) {
        reasonCodes.add(code);
      }
      for (const content of response.content) {
        recordMediaContent(
          content,
          operation.key,
          surfaces,
          record,
          reasonCodes
        );
      }
    }
    for (const callback of operation.callbacks) {
      surfaces.push({ kind: "callback", name: callback.name });
      record(
        "callback",
        callback.name,
        "approximated",
        [`callback:${callback.name}`],
        operation.key
      );
      reasonCodes.add(`callback:${callback.name}`);
    }
    const security = operation.security;
    if (security !== null) {
      for (const alternative of security.alternatives) {
        for (const scheme of alternative.schemes) {
          const declared = contract.security_schemes[scheme.name];
          const level = declared?.support ?? "unsupported";
          const codes = declared?.support_reason_codes ?? [
            `security:${scheme.name}`
          ];
          surfaces.push({ kind: "security_alternative", name: scheme.name });
          record("security_flow", scheme.name, level, codes, operation.key);
          for (const code of codes) {
            reasonCodes.add(code);
          }
        }
      }
    }
    if (webhook !== null) {
      surfaces.push({ kind: "webhook", name: webhook });
      record(
        "webhook",
        webhook,
        "approximated",
        ["webhook:invocation-unsupported"],
        operation.key
      );
      reasonCodes.add("webhook:invocation-unsupported");
    }

    capabilities.push({
      key: operation.key,
      uid: operation.uid,
      operation_id: operation.operation_id,
      method: operation.method,
      path_template: operation.path_template,
      level: operation.support.level,
      reason_codes: [...reasonCodes].sort(),
      surfaces
    });
  }

  for (const scheme of Object.values(contract.security_schemes)) {
    schemeCounts[scheme.support] += 1;
  }

  const toolNameCollisions = [...preferredCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();

  const maxOperations =
    options.toolExposure?.maxOperations ?? DIRECT_TOOL_MAX_OPERATIONS;
  const maxSchemaBytes =
    options.toolExposure?.maxSchemaBytes ?? DIRECT_TOOL_MAX_SCHEMA_BYTES;
  const serializedBytes = operations.reduce(
    (total, { operation }) => total + toolDescriptorBytes(operation),
    0
  );
  const invalidToolNames = operations
    .map(({ operation }) => operation.tool_name)
    .filter((name) => !isToolName(name));

  const usable = operations.filter(
    ({ operation }) =>
      operation.support.level === "supported" ||
      operation.support.level === "approximated"
  );
  const unsupportedCodes = new Set<string>();
  for (const { operation } of operations) {
    if (operation.support.level === "unsupported") {
      for (const code of operation.support.diagnostic_codes) {
        unsupportedCodes.add(code);
      }
      for (const parameter of operation.parameters) {
        if (parameter.support === "unsupported") {
          for (const code of parameter.support_reason_codes) {
            unsupportedCodes.add(code);
          }
        }
      }
      for (const content of operation.request_body?.content ?? []) {
        if (content.support === "unsupported") {
          for (const code of content.support_reason_codes) {
            unsupportedCodes.add(code);
          }
        }
      }
    }
  }

  const directTools: ToolViability = {
    viable:
      usable.length > 0 &&
      usable.length <= maxOperations &&
      serializedBytes <= maxSchemaBytes &&
      invalidToolNames.length === 0,
    operation_count: operations.length,
    serialized_schema_bytes: serializedBytes,
    max_operations: maxOperations,
    max_schema_bytes: maxSchemaBytes,
    reason_codes: directReasonCodes(
      usable.length,
      operations.length,
      serializedBytes,
      maxOperations,
      maxSchemaBytes,
      invalidToolNames.length
    )
  };
  const catalogViable = usable.length > 0 && invalidToolNames.length === 0;

  const viability = contractModeViability(operations.length, usable.length);
  const recommendations: CapabilityRecommendations = {
    contract_mode_viability: viability,
    scenario_requirements: scenarioRequirements(capabilities),
    direct_tools: directTools,
    catalog_tools: {
      viable: catalogViable,
      reason_codes: catalogViable
        ? []
        : catalogReasonCodes(
            operations.length,
            usable.length,
            invalidToolNames.length
          )
    },
    recommended_exposure: recommendedExposure(
      usable.length,
      directTools.viable,
      catalogViable
    ),
    strict_blockers: [...unsupportedCodes].sort()
  };

  return {
    schema_version: CAPABILITY_REPORT_SCHEMA_VERSION,
    kind: "CapabilityReport",
    contract_semantic_sha256: contract.source.semantic_sha256,
    source: {
      openapi_version: contract.source.openapi_version,
      media_type: contract.source.media_type,
      entrypoint: contract.source.entrypoint
    },
    counts: { operations: operationCounts, security_schemes: schemeCounts },
    operations: capabilities,
    features: [...features.values()]
      .map(toFeature)
      .sort((a, b) =>
        a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : 1
      ),
    missing_operation_ids: operations.filter(
      ({ operation }) => operation.operation_id === null
    ).length,
    duplicate_operation_ids: [...duplicateIds.keys()].sort(),
    tool_name_collisions: toolNameCollisions,
    recommendations,
    diagnostics: contract.diagnostics
  };
}

function recordMediaContent(
  content: MediaContentIR,
  operationKey: string,
  surfaces: CapabilitySurfaceRef[],
  record: (
    kind: FeatureCapability["kind"],
    name: string,
    level: SupportLevel,
    reasonCodes: readonly string[],
    operationKey: string
  ) => void,
  reasonCodes: Set<string>
): void {
  surfaces.push({ kind: "response_media_type", name: content.media_type });
  record(
    "media_type",
    content.media_type,
    content.support,
    content.support_reason_codes,
    operationKey
  );
  for (const code of content.support_reason_codes) {
    reasonCodes.add(code);
  }
}

function toFeature(entry: FeatureAccumulator): FeatureCapability {
  return {
    kind: entry.kind,
    name: entry.name,
    level: entry.level,
    reason_codes: [...entry.reasonCodes].sort(),
    operation_keys: [...entry.operationKeys].sort()
  };
}

function contractModeViability(
  total: number,
  usable: number
): CapabilityRecommendations["contract_mode_viability"] {
  if (total === 0 || usable === 0) {
    return "not_viable";
  }
  return usable < total ? "partial" : "viable";
}

function directReasonCodes(
  usable: number,
  total: number,
  bytes: number,
  maxOperations: number,
  maxSchemaBytes: number,
  invalidNames: number
): string[] {
  const codes: string[] = [];
  if (usable === 0) {
    codes.push("operations:none-supported");
  }
  if (usable > maxOperations) {
    codes.push("tool:operation-count");
  }
  if (bytes > maxSchemaBytes) {
    codes.push("tool:schema-bytes");
  }
  if (invalidNames > 0) {
    codes.push("tool-name:invalid");
  }
  if (codes.length === 0 && usable < total) {
    codes.push("operations:partial-coverage");
  }
  return codes.sort();
}

function catalogReasonCodes(
  total: number,
  usable: number,
  invalidNames: number
): string[] {
  const codes: string[] = [];
  if (total === 0) {
    codes.push("operations:none");
  } else if (usable === 0) {
    codes.push("operations:none-supported");
  }
  if (invalidNames > 0) {
    codes.push("tool-name:invalid");
  }
  return codes.sort();
}

function recommendedExposure(
  usable: number,
  directViable: boolean,
  catalogViable: boolean
): CapabilityRecommendations["recommended_exposure"] {
  if (usable === 0) {
    return "raw-http";
  }
  if (directViable) {
    return "direct-tools";
  }
  return catalogViable ? "catalog-tools" : "raw-http";
}

function scenarioRequirements(
  capabilities: readonly OperationCapability[]
): string[] {
  const codes = new Set<string>();
  for (const capability of capabilities) {
    if (capability.level === "supported") {
      continue;
    }
    for (const code of capability.reason_codes) {
      codes.add(code);
    }
  }
  return [...codes].sort().map(requirementFor);
}

/** Webhook operations that carry data but never execute as routes. */
export function webhookOperationCount(webhooks: readonly WebhookIR[]): number {
  return webhooks.reduce((total, hook) => total + hook.operations.length, 0);
}

/** Bytes of the canonical JSON form of the whole contract. */
export function contractBytes(contract: ContractIR): number {
  return jsonByteLength(contract as unknown as Json);
}

/** Canonical JSON text of the report, for byte-stable serialization. */
export function capabilityReportJson(report: CapabilityReport): string {
  return canonicalJson(report as unknown as Json);
}

/** Diagnostics that block a strict run, in a stable order. */
export function strictBlockersOf(
  report: CapabilityReport
): readonly Diagnostic[] {
  return report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
}
