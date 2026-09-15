/**
 * Scenario backend boundary (specification sections 9.2, 15.1 step 10,
 * and 16.1). The pipeline keeps parsing, authentication, request and
 * response validation, serialization, and the state transaction. A
 * scenario backend supplies only domain semantics: a response candidate
 * plus the state transition that commits only after response validation
 * passes.
 *
 * The gateway never loads pack code. The runner spawns the behavior
 * module in its own process and hands the pipeline this handle, so the
 * types below are the whole wire between the gateway and any backend.
 */

import { createHash } from "node:crypto";

import type { BehaviorRequest, Body } from "@oal/behavior-api";
import type { OperationIR } from "@oal/contract-ir";
import type { Json } from "@oal/core";

import type { Principal } from "./auth.ts";
import type { SelectedResponse } from "./select.ts";
import { findResponseForStatus } from "./select.ts";

/** State transition a served scenario response wants to commit. */
export interface ScenarioCommit {
  /** Next domain state; absent when the response changes nothing. */
  nextState?: Json;
  /**
   * Semantic events that commit atomically with the state. The runner
   * validates them against the backend registry before commit.
   */
  semanticEvents: ReadonlyArray<{
    name: string;
    eventVersion: number;
    payload: Json;
  }>;
  /** Domain effect names, in emission order. */
  effects: readonly string[];
}

/** The wire exchange one scenario transaction must record. */
export interface ScenarioExchange {
  requestId: string;
  method: string;
  target: string;
  operationKey: string;
  /** Status the participant received. */
  status: number;
}

/**
 * What the state must persist when the pipeline commits. A served
 * domain error carries the exchange without a transition, so the
 * recorded history shows the failed exchange without a state change.
 */
export interface ScenarioTransaction {
  exchange: ScenarioExchange;
  commit?: ScenarioCommit;
}

/** Domain response candidate before response validation. */
export interface ScenarioResponse {
  status: number;
  headers?: ReadonlyArray<{ name: string; values: readonly string[] }>;
  mediaType?: string;
  body?: Body;
}

export type ScenarioOutcome =
  | {
      kind: "served";
      response: ScenarioResponse;
      commit?: ScenarioCommit;
    }
  | { kind: "timeout"; timeoutMs: number; message: string }
  | { kind: "internal"; message: string };

/**
 * Backend handle the runner installs for scenario mode. Calls are
 * serialized per gateway state, so one handle call is one transaction
 * slot and backends see requests in ingress order.
 */
export interface ScenarioBackend {
  /** Backend identity for response provenance, for example "webclip". */
  readonly name: string;
  handle(request: BehaviorRequest, requestId: string): Promise<ScenarioOutcome>;
}

export interface ScenarioRequestInput {
  operation: OperationIR;
  principal: Principal;
  /** Deserialized, schema-validated parameters keyed by name. */
  parameters: Readonly<Record<string, Json>>;
  /** Raw body as the pipeline parsed it; Json view for multipart. */
  body: Json | undefined;
  /** Media type the request matched, or null without a request body. */
  selectedRequestMediaType: string | null;
  /** Accept preference order, most preferred first. */
  acceptedResponseMediaTypes: readonly string[];
}

/**
 * Build the backend request from what the pipeline already validated:
 * every parameter passed schema validation, the body passed its
 * schema, and the principal cleared declared security. The backend
 * never sees raw bytes or unvalidated input.
 */
export function scenarioRequestOf(
  input: ScenarioRequestInput
): BehaviorRequest {
  const path: Record<string, Json> = {};
  const query: Record<string, Json> = {};
  const header: Record<string, Json> = {};
  const cookie: Record<string, Json> = {};
  for (const parameter of input.operation.parameters) {
    const value = input.parameters[parameter.name];
    if (value === undefined) {
      continue;
    }
    const target =
      parameter.location === "path"
        ? path
        : parameter.location === "query"
          ? query
          : parameter.location === "header"
            ? header
            : cookie;
    target[parameter.name] = value;
  }
  return {
    operation: input.operation,
    principal: {
      scheme: input.principal.scheme,
      scopes: [...input.principal.scopes],
      anonymous: input.principal.anonymous
    },
    parameters: { path, query, header, cookie },
    body: behaviorBodyOf(input.body),
    selectedRequestMediaType: input.selectedRequestMediaType,
    acceptedResponseMediaTypes: [...input.acceptedResponseMediaTypes]
  };
}

/**
 * Map the parsed body onto the behavior body kinds. Multipart arrives
 * as its field-keyed Json view because that is the form the pipeline
 * validates; the lossless parts view is not reconstructible here.
 */
function behaviorBodyOf(body: Json | undefined): Body {
  if (body === undefined) {
    return { kind: "none" };
  }
  if (typeof body === "string") {
    return {
      kind: "text",
      text: body,
      sizeBytes: Buffer.byteLength(body, "utf8"),
      sha256: createHash("sha256").update(body, "utf8").digest("hex")
    };
  }
  return { kind: "json", value: body };
}

export type ScenarioCandidate =
  | { ok: true; selected: SelectedResponse; commit?: ScenarioCommit }
  | { ok: false; reason: "unsupported_body_kind" };

/**
 * Wrap one backend response as the pipeline response candidate. The
 * candidate flows through the same response validation, media checks,
 * and serialization as a contract selection, so a scenario response
 * can never bypass the contract.
 */
export function scenarioCandidateOf(
  backendName: string,
  responses: OperationIR["responses"],
  outcome: Extract<ScenarioOutcome, { kind: "served" }>
): ScenarioCandidate {
  const headers: Record<string, string> = {};
  for (const header of outcome.response.headers ?? []) {
    headers[header.name.toLowerCase()] = header.values.join(",");
  }
  let body: Json | undefined;
  const raw = outcome.response.body;
  if (raw !== undefined) {
    if (raw.kind === "json") {
      body = raw.value;
    } else if (raw.kind === "text") {
      body = raw.text;
    } else {
      // The wire forms the gateway serializes are JSON documents and
      // text. Binary and multipart scenario bodies are refused rather
      // than silently re-encoded.
      return { ok: false, reason: "unsupported_body_kind" };
    }
  }
  const declared = findResponseForStatus(responses, outcome.response.status);
  return {
    ok: true,
    selected: {
      status: outcome.response.status,
      response: declared,
      mediaType: outcome.response.mediaType ?? null,
      headers,
      body,
      provenance: `behavior:${backendName}`,
      approximation: null
    },
    ...(outcome.commit === undefined ? {} : { commit: outcome.commit })
  };
}
