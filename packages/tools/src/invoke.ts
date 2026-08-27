/**
 * Catalog invoke (specification sections 18.5 and 18.6). The bridge owns
 * envelope validation, authentication-parameter rejection, binary transport,
 * and truncation. Execution belongs to an `InvocationTarget` that the
 * gateway implements, so no catalog call can bypass authentication,
 * validation, limits, faults, persistence, tracing, or response validation.
 */

import { invalidInput, type Json, type OalError } from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";

import {
  applyResultTruncation,
  DEFAULT_ENVELOPE_LIMITS,
  TRUNCATION_POLICY,
  validateInvocationEnvelope,
  validateInvocationResult,
  type BinaryBody,
  type EnvelopeLimits,
  type InvocationEnvelope,
  type InvocationResult,
  type TruncationPolicy,
  type TruncationRecord
} from "./envelope.ts";
import { resolveOperation } from "./describe.ts";

/** Transport kinds an MCP bridge emits, from section 18.6. */
export const MCP_TRANSPORT_KINDS = ["mcp-direct", "mcp-catalog"] as const;

export type McpTransportKind = (typeof MCP_TRANSPORT_KINDS)[number];

/** Every transport kind a tool exchange can travel on. */
export type ToolTransportKind = "http" | McpTransportKind;

/**
 * Execution target. The gateway implements it, so every catalog invocation
 * runs through the full product pipeline.
 */
export interface InvocationTarget {
  /** Execute one validated envelope and return the normalized result. */
  execute(
    envelope: InvocationEnvelope,
    context: InvocationContext
  ): Promise<InvocationResult> | InvocationResult;
}

/** Context the bridge passes with every forwarded envelope. */
export interface InvocationContext {
  /** The resolved operation, for routing and trace labeling. */
  operation: OperationIR;
  /** Transport the call arrived on. */
  transport: ToolTransportKind;
}

export interface CatalogInvokeOptions {
  contract: ContractIR;
  target: InvocationTarget;
  transport?: McpTransportKind | undefined;
  limits?: EnvelopeLimits | undefined;
  truncation?: TruncationPolicy | undefined;
}

/** Untyped catalog input, as a participant sends it. */
export interface CatalogInvokeInput {
  /** Canonical key, UID, or unique operationId. */
  operation: string;
  parameters?: unknown;
  contentType?: unknown;
  accept?: unknown;
  body?: unknown;
}

/** Everything the bridge reports besides the normalized result. */
export interface CatalogInvokeReport {
  result: InvocationResult;
  transport: McpTransportKind;
  operation: OperationIR;
  truncation?: TruncationRecord | undefined;
}

/**
 * Bridge for the `invoke_operation` catalog tool. Construct one per trial;
 * it holds no credential material and never injects authentication itself.
 */
export class CatalogInvokeBridge {
  readonly transport: McpTransportKind;
  private readonly contract: ContractIR;
  private readonly target: InvocationTarget;
  private readonly limits: EnvelopeLimits;
  private readonly truncation: TruncationPolicy;

  constructor(options: CatalogInvokeOptions) {
    this.contract = options.contract;
    this.target = options.target;
    this.transport = options.transport ?? "mcp-catalog";
    this.limits = options.limits ?? DEFAULT_ENVELOPE_LIMITS;
    this.truncation = options.truncation ?? TRUNCATION_POLICY;
  }

  /**
   * Validate, forward, and normalize one catalog invocation. The `operation`
   * field accepts a canonical key, a UID, or a unique operationId; it is
   * resolved to the canonical key before anything is forwarded. The envelope
   * is validated before the target sees it, and the result is truncated under
   * the frozen policy before the participant sees it.
   */
  async invoke(input: CatalogInvokeInput): Promise<CatalogInvokeReport> {
    if (typeof input.operation !== "string" || input.operation.length === 0) {
      throw invokeError(
        "envelope_invalid",
        "The invocation must name one operation."
      );
    }
    const referenced = resolveOperation(this.contract, input.operation);
    const envelope = toEnvelope({ ...input, operation: referenced.key });
    const operation = validateInvocationEnvelope(
      envelope,
      this.contract,
      this.limits
    );
    const forwarded = await this.target.execute(envelope, {
      operation,
      transport: this.transport
    });
    validateInvocationResult(forwarded);
    const result = applyResultTruncation(forwarded, this.truncation);
    return {
      result,
      transport: this.transport,
      operation,
      ...(result.truncation === undefined
        ? {}
        : { truncation: result.truncation })
    };
  }
}

function invokeError(code: string, message: string, details?: Json): OalError {
  return invalidInput(code, message, details);
}

/** Normalize untyped catalog input into one envelope. */
export function toEnvelope(input: CatalogInvokeInput): InvocationEnvelope {
  if (typeof input.operation !== "string" || input.operation.length === 0) {
    throw invokeError(
      "envelope_invalid",
      "The invocation must name one operation."
    );
  }
  const groups = isRecord(input.parameters) ? input.parameters : {};
  const parameters = {
    path: asJsonObject(groups.path, "path"),
    query: asJsonObject(groups.query, "query"),
    headers: asJsonObject(groups.headers, "headers"),
    cookies: asJsonObject(groups.cookies, "cookies")
  };
  const contentType =
    input.contentType === undefined || input.contentType === null
      ? null
      : asMediaType(input.contentType, "contentType");
  const accept =
    input.accept === undefined || input.accept === null
      ? []
      : asMediaTypeList(input.accept);
  const body = input.body === undefined ? undefined : asBody(input.body);
  return { operation: input.operation, parameters, contentType, accept, body };
}

function asJsonObject(value: unknown, group: string): Record<string, Json> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw invokeError(
      "envelope_invalid",
      `The '${group}' parameter group must be a JSON object.`,
      { group }
    );
  }
  return value;
}

function asMediaType(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invokeError(
      "envelope_invalid",
      `The '${field}' field must be a media type string.`,
      { field }
    );
  }
  return value;
}

function asMediaTypeList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invokeError(
      "envelope_invalid",
      "The 'accept' field must be an array of media type strings."
    );
  }
  return [...(value as string[])];
}

function asBody(value: unknown): Json | BinaryBody {
  if (isRecord(value) && value.kind === "binary") {
    const base64 = typeof value.base64 === "string" ? value.base64 : "";
    const contentType =
      typeof value.contentType === "string" ? value.contentType : "";
    const byteCount =
      typeof value.byteCount === "number" ? value.byteCount : -1;
    const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
    if (
      base64.length === 0 ||
      contentType.length === 0 ||
      byteCount < 0 ||
      sha256.length === 0
    ) {
      throw invokeError(
        "binary_body_invalid",
        "A binary body needs base64, contentType, byteCount, and sha256."
      );
    }
    return { kind: "binary", base64, contentType, byteCount, sha256 };
  }
  return value as Json;
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
