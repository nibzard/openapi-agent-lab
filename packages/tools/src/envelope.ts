/**
 * Shared invocation envelope (specification section 18.1). Direct and
 * catalog tools normalize every call into one input shape and every
 * gateway answer into one output shape. The bridge validates an envelope,
 * rejects protected authentication parameters, carries binary bodies as
 * bounded base64, and truncates large output under a frozen policy.
 *
 * Error codes in this module are participant-facing rejection reasons and
 * use lower snake case, for example `protected_auth_parameter`. Operator
 * facing configuration failures use the `OAL-` prefix instead.
 */

import { Buffer } from "node:buffer";

import {
  canonicalJson,
  invalidInput,
  isJsonObject,
  sha256HexBytes,
  type Json,
  type JsonObject,
  type OalError
} from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";

/** Envelope schema version. Bump it only when the wire shape changes. */
export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Rejection code for a supplied security-scheme parameter. */
export const PROTECTED_AUTH_PARAMETER = "protected_auth_parameter";

/** Parameter groups in the envelope, in specification order. */
export const ENVELOPE_PARAMETER_GROUPS = [
  "path",
  "query",
  "headers",
  "cookies"
] as const;

export type EnvelopeParameterGroup = (typeof ENVELOPE_PARAMETER_GROUPS)[number];

/** Parameters grouped for transport. Values are plain JSON. */
export type InvocationParameters = {
  path: JsonObject;
  query: JsonObject;
  headers: JsonObject;
  cookies: JsonObject;
};

/** Binary body transported as bounded base64 with integrity metadata. */
export interface BinaryBody {
  kind: "binary";
  /** Base64 of the complete body bytes. */
  base64: string;
  contentType: string;
  byteCount: number;
  /** SHA-256 over the decoded bytes. */
  sha256: string;
}

/** Normalized tool invocation input. */
export interface InvocationEnvelope {
  /** Canonical operation key, for example `path:POST /v1/computers`. */
  operation: string;
  parameters: InvocationParameters;
  contentType: string | null;
  accept: string[];
  body?: Json | BinaryBody | undefined;
}

/** One response header with every value it carried. */
export interface HeaderValues {
  name: string;
  values: string[];
}

/** Frozen large-output truncation policy, version 1. */
export interface TruncationPolicy {
  version: 1;
  /** Largest body size the tool transport returns, in bytes. */
  maxOutputBytes: number;
  /** Retained bytes are a prefix of the complete serialization. */
  strategy: "byte-prefix";
}

export const TRUNCATION_POLICY: TruncationPolicy = Object.freeze({
  version: 1,
  maxOutputBytes: 65_536,
  strategy: "byte-prefix"
});

/** Record of one truncation decision, with the complete-byte digest. */
export interface TruncationRecord {
  policyVersion: 1;
  strategy: "byte-prefix";
  maxOutputBytes: number;
  completeBytes: number;
  retainedBytes: number;
  /** SHA-256 over the complete body bytes before truncation. */
  completeSha256: string;
}

/** Normalized tool invocation output. */
export interface InvocationResult {
  status: number;
  headers: HeaderValues[];
  body?: Json | BinaryBody | undefined;
  contentType: string | null;
  requestId: string;
  truncation?: TruncationRecord | undefined;
}

/** Bounds for binary transport, applied before anything is forwarded. */
export interface EnvelopeLimits {
  /** Largest decoded binary body accepted, in bytes. */
  maxBinaryBodyBytes: number;
}

export const DEFAULT_ENVELOPE_LIMITS: EnvelopeLimits = Object.freeze({
  maxBinaryBodyBytes: 262_144
});

export const REQUEST_ID_PATTERN = /^req_[0-9]{8}$/;

/** Canonical key shape shared by every compiled operation. */
const OPERATION_KEY_PATTERN = /^path:[A-Za-z]+ \/[^ ]*$/;

/** Empty parameter groups for a fresh envelope. */
export function emptyParameters(): InvocationParameters {
  return { path: {}, query: {}, headers: {}, cookies: {} };
}

function envelopeError(
  code: string,
  message: string,
  details?: Json
): OalError {
  return invalidInput(code, message, details);
}

/**
 * Collect the parameter names that implement a declared security scheme for
 * one operation. An api-key scheme contributes its wire name at its own
 * location. Every HTTP, OAuth 2.0, and OpenID Connect scheme contributes the
 * `authorization` header. Mutual TLS contributes nothing. Names compare
 * lowercase because header and cookie names are case-insensitive.
 */
export function protectedParameterNames(
  contract: ContractIR,
  operation: OperationIR
): { headers: string[]; query: string[]; cookies: string[] } {
  const referenced = new Set<string>();
  const security = operation.security;
  if (security === null) {
    for (const name of Object.keys(contract.security_schemes)) {
      referenced.add(name);
    }
  } else {
    for (const alternative of security.alternatives) {
      for (const scheme of alternative.schemes) {
        referenced.add(scheme.name);
      }
    }
  }
  const headers = new Set<string>();
  const query = new Set<string>();
  const cookies = new Set<string>();
  for (const name of [...referenced].sort()) {
    const scheme = contract.security_schemes[name];
    if (scheme === undefined) {
      continue;
    }
    if (scheme.type === "apiKey") {
      if (scheme.wire_name === null) {
        continue;
      }
      const wireName = scheme.wire_name.toLowerCase();
      if (scheme.location === "header") {
        headers.add(wireName);
      } else if (scheme.location === "query") {
        query.add(wireName);
      } else if (scheme.location === "cookie") {
        cookies.add(wireName);
      }
      continue;
    }
    if (
      scheme.type === "http" ||
      scheme.type === "oauth2" ||
      scheme.type === "openIdConnect"
    ) {
      headers.add("authorization");
    }
  }
  return {
    headers: [...headers].sort(),
    query: [...query].sort(),
    cookies: [...cookies].sort()
  };
}

/**
 * Reject an envelope that supplies a parameter implementing a declared
 * security scheme. Header and cookie names compare case-insensitively,
 * query names exactly. The error lists names and locations only. Values
 * are neither logged nor forwarded.
 */
export function rejectProtectedParameters(
  envelope: InvocationEnvelope,
  protectedNames: {
    headers: string[];
    query: string[];
    cookies: string[];
  }
): void {
  const rejected: Array<{ group: string; name: string }> = [];
  collectRejection(
    rejected,
    "headers",
    envelope.parameters.headers,
    protectedNames.headers,
    true
  );
  collectRejection(
    rejected,
    "query",
    envelope.parameters.query,
    protectedNames.query,
    false
  );
  collectRejection(
    rejected,
    "cookies",
    envelope.parameters.cookies,
    protectedNames.cookies,
    true
  );
  if (rejected.length === 0) {
    return;
  }
  rejected.sort((a, b) =>
    a.group !== b.group
      ? a.group < b.group
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : 1
  );
  throw envelopeError(
    PROTECTED_AUTH_PARAMETER,
    "The invocation supplies a parameter that implements a declared" +
      " security scheme. The bridge injects credentials itself.",
    { parameters: rejected }
  );
}

function collectRejection(
  out: Array<{ group: string; name: string }>,
  group: string,
  values: JsonObject,
  names: readonly string[],
  caseInsensitive: boolean
): void {
  const supplied = new Set<string>(
    caseInsensitive
      ? Object.keys(values).map((key) => key.toLowerCase())
      : Object.keys(values)
  );
  for (const name of names) {
    if (supplied.has(name)) {
      out.push({ group, name });
    }
  }
}

/** True when the value is a well-formed binary body record. */
export function isBinaryBody(value: unknown): value is BinaryBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<BinaryBody>;
  return (
    record.kind === "binary" &&
    typeof record.base64 === "string" &&
    typeof record.contentType === "string" &&
    typeof record.byteCount === "number" &&
    typeof record.sha256 === "string"
  );
}

/** Encode body bytes as a bounded binary body record. */
export function encodeBinaryBody(
  bytes: Uint8Array,
  contentType: string,
  limits: EnvelopeLimits = DEFAULT_ENVELOPE_LIMITS
): BinaryBody {
  if (bytes.length > limits.maxBinaryBodyBytes) {
    throw envelopeError(
      "body_too_large",
      "The binary body exceeds the transport bound.",
      {
        byteCount: bytes.length,
        maxBinaryBodyBytes: limits.maxBinaryBodyBytes
      }
    );
  }
  return {
    kind: "binary",
    base64: Buffer.from(bytes).toString("base64"),
    contentType,
    byteCount: bytes.length,
    sha256: sha256HexBytes(bytes)
  };
}

/** Decode and verify a binary body record. */
export function decodeBinaryBody(
  body: BinaryBody,
  limits: EnvelopeLimits = DEFAULT_ENVELOPE_LIMITS
): { bytes: Uint8Array; contentType: string } {
  if (body.byteCount > limits.maxBinaryBodyBytes) {
    throw envelopeError(
      "body_too_large",
      "The binary body exceeds the transport bound.",
      { byteCount: body.byteCount }
    );
  }
  const decoded = Buffer.from(body.base64, "base64");
  if (decoded.length !== body.byteCount) {
    throw envelopeError(
      "binary_body_invalid",
      "The declared byte count does not match the base64 payload.",
      { declaredBytes: body.byteCount, decodedBytes: decoded.length }
    );
  }
  if (sha256HexBytes(decoded) !== body.sha256) {
    throw envelopeError(
      "binary_body_invalid",
      "The SHA-256 of the binary body does not match the declared digest.",
      { declaredSha256: body.sha256 }
    );
  }
  return { bytes: decoded, contentType: body.contentType };
}

/** Serialize one result body to its transport bytes. */
function bodyBytes(body: Json | BinaryBody): Uint8Array {
  if (isBinaryBody(body)) {
    return new Uint8Array(Buffer.from(body.base64, "base64"));
  }
  return new Uint8Array(Buffer.from(canonicalJson(body), "utf8"));
}

function prefixAtByteBoundary(
  bytes: Uint8Array,
  max: number
): { retained: Uint8Array; complete: boolean } {
  if (bytes.length <= max) {
    return { retained: bytes, complete: true };
  }
  let cut = max;
  // Never split one UTF-8 code point: back up over continuation bytes.
  while (
    cut > 0 &&
    (bytes[cut] as number) >= 0x80 &&
    (bytes[cut] as number) < 0xc0
  ) {
    cut -= 1;
  }
  return { retained: bytes.subarray(0, cut), complete: false };
}

/**
 * Apply the frozen truncation policy to one result. The body becomes the
 * retained prefix of its complete serialization, and the record carries the
 * digest of the complete bytes.
 */
export function applyResultTruncation(
  result: InvocationResult,
  policy: TruncationPolicy = TRUNCATION_POLICY
): InvocationResult {
  if (result.body === undefined) {
    return result;
  }
  const bytes = bodyBytes(result.body);
  if (bytes.length <= policy.maxOutputBytes) {
    return result;
  }
  const { retained } = prefixAtByteBoundary(bytes, policy.maxOutputBytes);
  const truncatedBody: Json | BinaryBody = isBinaryBody(result.body)
    ? {
        kind: "binary",
        base64: Buffer.from(retained).toString("base64"),
        contentType: result.body.contentType,
        byteCount: retained.length,
        sha256: sha256HexBytes(retained)
      }
    : (Buffer.from(retained).toString("utf8") as Json);
  return {
    ...result,
    body: truncatedBody,
    truncation: {
      policyVersion: policy.version,
      strategy: policy.strategy,
      maxOutputBytes: policy.maxOutputBytes,
      completeBytes: bytes.length,
      retainedBytes: retained.length,
      completeSha256: sha256HexBytes(bytes)
    }
  };
}

/** Check a normalized result against the shared shape. */
export function validateInvocationResult(result: InvocationResult): void {
  if (typeof result.status !== "number" || !Number.isInteger(result.status)) {
    throw envelopeError(
      "envelope_invalid",
      "The result 'status' must be an integer."
    );
  }
  if (!Array.isArray(result.headers)) {
    throw envelopeError(
      "envelope_invalid",
      "The result 'headers' must be an array of name and values records."
    );
  }
  const requestId: unknown = result.requestId;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw envelopeError(
      "envelope_invalid",
      "The result 'requestId' must match req_ plus eight digits.",
      { requestId: String(requestId) }
    );
  }
  if (result.contentType !== null && typeof result.contentType !== "string") {
    throw envelopeError(
      "envelope_invalid",
      "The result 'contentType' must be a media type string or null."
    );
  }
}

/**
 * Validate one envelope against a contract and resolve its operation. The
 * check covers the key shape, the parameter groups, the media-type fields,
 * and the binary body record. It rejects protected authentication
 * parameters, so a valid envelope never carries a credential.
 */
export function validateInvocationEnvelope(
  envelope: InvocationEnvelope,
  contract: ContractIR,
  limits: EnvelopeLimits = DEFAULT_ENVELOPE_LIMITS
): OperationIR {
  if (typeof envelope.operation !== "string") {
    throw envelopeError(
      "envelope_invalid",
      "The envelope 'operation' must be a canonical key string."
    );
  }
  if (!OPERATION_KEY_PATTERN.test(envelope.operation)) {
    throw envelopeError(
      "envelope_invalid",
      "The envelope 'operation' is not a canonical key.",
      { operation: envelope.operation }
    );
  }
  const operation = contract.operations.find(
    (candidate) => candidate.key === envelope.operation
  );
  if (operation === undefined) {
    throw envelopeError(
      "operation_not_found",
      "The envelope names an operation the contract does not declare.",
      { operation: envelope.operation }
    );
  }
  const groups: Json | undefined = envelope.parameters;
  if (!isJsonObject(groups)) {
    throw envelopeError(
      "envelope_invalid",
      "The envelope must carry a 'parameters' object."
    );
  }
  for (const group of ENVELOPE_PARAMETER_GROUPS) {
    const values: Json | undefined = envelope.parameters[group];
    if (!isJsonObject(values)) {
      throw envelopeError(
        "envelope_invalid",
        `The '${group}' parameter group must be a JSON object.`,
        { group }
      );
    }
  }
  if (
    envelope.contentType !== null &&
    typeof envelope.contentType !== "string"
  ) {
    throw envelopeError(
      "envelope_invalid",
      "The envelope 'contentType' must be a media type string or null."
    );
  }
  if (
    !Array.isArray(envelope.accept) ||
    envelope.accept.some((entry) => typeof entry !== "string")
  ) {
    throw envelopeError(
      "envelope_invalid",
      "The envelope 'accept' must be an array of media type strings."
    );
  }
  if (isBinaryBody(envelope.body)) {
    decodeBinaryBody(envelope.body, limits);
  }
  rejectProtectedParameters(
    envelope,
    protectedParameterNames(contract, operation)
  );
  return operation;
}
