/**
 * The HTTP gateway (specification section 15.1). One logical pipeline
 * serves every product request: limits, parsing, routing,
 * authentication, media selection, validation, response selection, and
 * serialization. Framework failures skip behavior but still produce a
 * stored exchange event shape.
 */

import { canonicalJson, SchemaWorkerError, type Json } from "@oal/core";
import { CONTRACT_IR_SCHEMA_VERSION, type ContractIR } from "@oal/contract-ir";
import type { LimitTable } from "@oal/config";
import {
  evaluateSecurity,
  mintRunCredentials,
  type RunCredentials
} from "./auth.ts";
import { parseMultipart, type MultipartPart } from "./multipart.ts";
import { FRAMEWORK_ERRORS, problemDocument } from "./problem.ts";
import { validateResponse, type ResponseValidationResult } from "./response.ts";
import { matchRoute } from "./router.ts";
import { matchRequestMedia, parseAccept } from "./negotiate.ts";
import {
  compilePathParameterPatterns,
  pathFamilyKey
} from "./path-patterns.ts";
import {
  selectResponse,
  type ContractFixture,
  type SelectedResponse
} from "./select.ts";
import {
  scenarioCandidateOf,
  scenarioRequestOf,
  type ScenarioBackend,
  type ScenarioOutcome,
  type ScenarioTransaction
} from "./scenario.ts";
import type { GatewayState } from "./state.ts";
import {
  createContractSchemaLookup,
  validateBody,
  validateParameters,
  type BodyValidationResult,
  type ParsedRequest,
  type SchemaLookup,
  type ValidationResult
} from "./validate.ts";

/** Raw wire request before any parsing. */
export interface RawRequest {
  method: string;
  /** Request target: path plus optional query string. */
  target: string;
  /** Header values; repeated names arrive as arrays. */
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

/** Serialized gateway response. */
export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  /** Serialized body bytes; absent for HEAD, 204, and 304. */
  body: string | undefined;
  /** Ingress sequence for trace correlation. */
  requestId: string;
  /** Response-value provenance, for example fixture: or example:. */
  provenance: string | null;
  /** Approximation marker, for example example_invalid_skipped:1. */
  approximation: string | null;
  /** Framework error code when a framework error was served. */
  frameworkCode: string | null;
}

export interface GatewayOptions {
  contract: ContractIR;
  limits: LimitTable;
  fixtures?: ContractFixture[];
  /** Run seed for credentials and deterministic generation. */
  runSeed: string;
  /** Transactional state; committed only after response validation. */
  state?: GatewayState;
  /**
   * Scenario backend for scenario mode. Present only when the runner
   * spawned a behavior module; the pipeline then routes every validated
   * request through it instead of contract selection.
   */
  backend?: ScenarioBackend;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/**
 * Schema lookups keyed by contract identity. Binding a registry
 * deep-copies every referenced subtree, so one lookup serves every
 * request of one contract instead of being rebuilt per request. The
 * memoized bound schemas are shared read-only: validation and
 * generation clone before they mutate, so no request observes another
 * request's state through them.
 */
const schemaLookups = new WeakMap<ContractIR, SchemaLookup>();

function contractSchemaLookup(contract: ContractIR): SchemaLookup {
  const cached = schemaLookups.get(contract);
  if (cached !== undefined) {
    return cached;
  }
  const lookup = createContractSchemaLookup(contract.schemas);
  schemaLookups.set(contract, lookup);
  return lookup;
}

/**
 * Path parameter pattern tables keyed by contract identity. The table
 * is a pure function of the compiled operations, so one pass over the
 * contract serves every request instead of being rebuilt per request.
 * The entries are shared read-only.
 */
const pathPatternTables = new WeakMap<
  ContractIR,
  Map<string, Record<string, string>>
>();

function pathPatternsFor(
  contract: ContractIR
): Map<string, Record<string, string>> {
  const cached = pathPatternTables.get(contract);
  if (cached !== undefined) {
    return cached;
  }
  const table = compilePathParameterPatterns(contract);
  pathPatternTables.set(contract, table);
  return table;
}

/**
 * Run credentials keyed by contract identity and run seed. Minting is
 * deterministic in the run seed alone, so the shared values equal the
 * ones a per-request mint would produce, and the pipeline only reads
 * them. One entry per seed keeps distinct runs of one contract
 * isolated.
 */
const runCredentials = new WeakMap<ContractIR, Map<string, RunCredentials>>();

function credentialsForRun(
  contract: ContractIR,
  runSeed: string
): RunCredentials {
  let bySeed = runCredentials.get(contract);
  if (bySeed === undefined) {
    bySeed = new Map<string, RunCredentials>();
    runCredentials.set(contract, bySeed);
  }
  const cached = bySeed.get(runSeed);
  if (cached !== undefined) {
    return cached;
  }
  const minted = mintRunCredentials(contract, runSeed);
  bySeed.set(runSeed, minted);
  return minted;
}

/**
 * Handle one request through the full product pipeline. Pure with
 * respect to the contract, fixtures, limits, and the ingress sequence:
 * identical inputs produce identical responses.
 *
 * The pipeline is asynchronous because schema and pattern evaluation
 * runs inside the bounded worker boundary. A worker-bound failure is
 * an infrastructure outcome: the request receives a framework error
 * response, a staged state transaction rolls back, and no hostile
 * pattern can block the serving event loop.
 */
export function handleGatewayRequest(
  options: GatewayOptions,
  sequence: number,
  raw: RawRequest
): Promise<GatewayResponse> {
  return serializeState(options.state, () => pipeline(options, sequence, raw));
}

/**
 * One state transaction at a time. The pipeline awaits worker replies
 * between staging and commit, so concurrent requests over one
 * transactional state are serialized per state object; requests
 * without state run concurrently.
 */
const stateChains = new WeakMap<GatewayState, Promise<void>>();

function serializeState(
  state: GatewayState | undefined,
  run: () => Promise<GatewayResponse>
): Promise<GatewayResponse> {
  if (state === undefined) {
    return run();
  }
  const previous = stateChains.get(state) ?? Promise.resolve();
  const result = previous.then(run, run);
  stateChains.set(
    state,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/**
 * Map one schema worker failure to its framework response. Timeouts
 * are 504 infrastructure outcomes; every other boundary failure is a
 * 500 infrastructure outcome. Anything else is not a worker failure
 * and keeps propagating.
 */
function schemaWorkerFramework(
  error: unknown
): (typeof FRAMEWORK_ERRORS)[keyof typeof FRAMEWORK_ERRORS] {
  if (error instanceof SchemaWorkerError) {
    return error.code === "OAL-SCHEMA-WORKER-TIMEOUT"
      ? FRAMEWORK_ERRORS.schemaWorkerTimeout
      : FRAMEWORK_ERRORS.schemaWorkerFailed;
  }
  throw error;
}

async function pipeline(
  options: GatewayOptions,
  sequence: number,
  raw: RawRequest
): Promise<GatewayResponse> {
  const { contract, limits } = options;
  const requestId = `req_${sequence.toString(10).padStart(8, "0")}`;

  // Step 1: the contract schema version gates every serve path
  // (section 42.2, AC-012). A mismatch refuses before any parsing. The
  // producer types the field narrowly, so widen it before the check: a
  // contract read from disk carries no type guarantee at runtime.
  const contractVersion: number = contract.schema_version;
  if (contractVersion !== CONTRACT_IR_SCHEMA_VERSION) {
    return framework(FRAMEWORK_ERRORS.contractVersionUnsupported, requestId);
  }

  // Step 2: target and header limits.
  if (raw.target.length > limits.maxRequestTargetBytes) {
    return framework(FRAMEWORK_ERRORS.requestTargetTooLarge, requestId);
  }
  const headerBytes = Object.entries(raw.headers).reduce(
    (total, [name, value]) =>
      total +
      name.length +
      (Array.isArray(value) ? value.join(",").length : (value ?? "").length),
    0
  );
  if (headerBytes > limits.maxRequestHeaderBytes) {
    return framework(FRAMEWORK_ERRORS.requestMalformed, requestId);
  }
  if (raw.body.length > limits.maxRequestBodyBytes) {
    return framework(FRAMEWORK_ERRORS.requestBodyTooLarge, requestId);
  }

  // Step 3: parsing.
  const method = raw.method.toUpperCase();
  const parsed = parseTarget(raw.target);
  if (parsed === null) {
    return framework(FRAMEWORK_ERRORS.requestMalformed, requestId);
  }
  const flatHeaders = flattenHeaders(raw.headers);
  const contentType = headerValue(raw.headers, "content-type");
  let body: Json | undefined;
  const rawType = contentType === null ? "" : contentType;
  const semicolon = rawType.indexOf(";");
  const baseType = (semicolon === -1 ? rawType : rawType.slice(0, semicolon))
    .trim()
    .toLowerCase();
  if (raw.body.length > 0) {
    if (baseType === "application/json" || baseType.endsWith("+json")) {
      try {
        body = JSON.parse(new TextDecoder().decode(raw.body)) as Json;
      } catch {
        return framework(FRAMEWORK_ERRORS.requestMalformed, requestId);
      }
    } else if (baseType === "application/x-www-form-urlencoded") {
      body = parseUrlEncoded(new TextDecoder().decode(raw.body));
    } else if (baseType.startsWith("multipart/")) {
      // The parts limit default is LIMIT_DEFAULTS.maxMultipartParts;
      // parseMultipart enforces it while the parts are counted.
      const multipart = parseMultipart(
        raw.body,
        contentType,
        limits.maxMultipartParts
      );
      if (!multipart.ok) {
        const error =
          multipart.code === "parts_limit_exceeded"
            ? FRAMEWORK_ERRORS.multipartPartsTooMany
            : FRAMEWORK_ERRORS.requestMalformed;
        return framework(error, requestId);
      }
      body = multipartJsonValue(multipart.parts);
    } else if (raw.body.length > 0) {
      body = new TextDecoder().decode(raw.body);
    }
  }

  // Step 4: route matching.
  const route = matchRoute(contract.operations, method, parsed.path);
  if (route.match === null) {
    if (route.pathExists) {
      const response = framework(FRAMEWORK_ERRORS.methodNotAllowed, requestId);
      response.headers.allow = route.allowedMethods.sort().join(", ");
      return response;
    }
    return framework(FRAMEWORK_ERRORS.routeNotFound, requestId);
  }
  const operation = route.match.operation;

  const credentials = credentialsForRun(contract, options.runSeed);
  const request: ParsedRequest = {
    pathParameters: route.match.pathParameters,
    query: parsed.query,
    headers: flatHeaders,
    cookies: parseCookies(headerValue(raw.headers, "cookie")),
    body,
    contentType
  };

  // Step 6: declared authentication.
  const auth = evaluateSecurity(operation, contract, request, credentials);
  if (!auth.ok) {
    const error =
      auth.code === "authorization_failed"
        ? FRAMEWORK_ERRORS.authorizationFailed
        : FRAMEWORK_ERRORS.authenticationFailed;
    return framework(error, requestId);
  }

  // One resolver serves parameters, bodies, responses, and generation,
  // so document-relative references resolve identically everywhere.
  // The resolver is the contract's shared instance: identical inputs
  // still produce identical responses.
  const schemaLookup = contractSchemaLookup(contract);

  // Step 7: request media type must be declared. The matched type
  // rides along: the scenario backend receives what the request
  // actually selected.
  const selectedRequestMediaType =
    operation.request_body !== null && request.body !== undefined
      ? matchRequestMedia(
          operation.request_body.content.map((entry) => entry.media_type),
          contentType
        )
      : null;
  if (
    operation.request_body !== null &&
    request.body !== undefined &&
    selectedRequestMediaType === null
  ) {
    return framework(FRAMEWORK_ERRORS.mediaTypeUnsupported, requestId);
  }

  // Step 8: request validation. A worker-bound failure here happens
  // before any state staging, so nothing has to roll back.
  let parameterResult: ValidationResult;
  let bodyResult: BodyValidationResult;
  try {
    parameterResult = await validateParameters(
      operation,
      request,
      schemaLookup
    );
    bodyResult = await validateBody(operation, request, schemaLookup);
  } catch (error) {
    return framework(schemaWorkerFramework(error), requestId, detailOf(error));
  }
  const violations = [...parameterResult.violations, ...bodyResult.violations];
  if (violations.length > 0) {
    const document = problemDocument(
      FRAMEWORK_ERRORS.requestSchemaInvalid,
      requestId,
      "The request violates the declared contract.",
      violations
    );
    return {
      status: FRAMEWORK_ERRORS.requestSchemaInvalid.status,
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify(document),
      requestId,
      provenance: null,
      approximation: null,
      frameworkCode: FRAMEWORK_ERRORS.requestSchemaInvalid.code
    };
  }

  // Steps 10 to 12: backend selection. The Accept header joins
  // selection so the value comes from the media type that is served.
  // The backend runs inside a state transaction: the staged mutation
  // stays invisible until response validation commits it. A
  // worker-bound failure rolls the transaction back, so a timeout
  // never mutates state.
  options.state?.stage(operation.key);
  let selected: SelectedResponse;
  let scenarioTransaction: ScenarioTransaction | undefined;
  if (options.backend !== undefined) {
    // Scenario mode: the behavior backend answers the validated
    // request. Media check, response validation, serialization, and
    // commit below are shared with contract mode, so a scenario
    // response can never bypass the contract. Backend failure details
    // stay out of the response body; section 15.2 forbids leaking
    // internals to the participant.
    let outcome: ScenarioOutcome;
    try {
      outcome = await options.backend.handle(
        scenarioRequestOf({
          operation,
          principal: auth.principal,
          parameters: parameterResult.parameters,
          body: request.body,
          selectedRequestMediaType,
          acceptedResponseMediaTypes: parseAccept(
            headerValue(raw.headers, "accept")
          ).map((entry) => entry.type)
        }),
        requestId
      );
    } catch {
      // The handle is an adapter around a child process; a throw is an
      // infrastructure fault, not a domain answer.
      options.state?.rollback();
      return framework(FRAMEWORK_ERRORS.internalError, requestId);
    }
    if (outcome.kind === "timeout") {
      options.state?.rollback();
      return framework(
        FRAMEWORK_ERRORS.behaviorTimeout,
        requestId,
        `The backend exceeded its ${outcome.timeoutMs} ms bound.`
      );
    }
    if (outcome.kind === "internal") {
      options.state?.rollback();
      return framework(FRAMEWORK_ERRORS.internalError, requestId);
    }
    const candidate = scenarioCandidateOf(
      options.backend.name,
      operation.responses,
      outcome
    );
    if (!candidate.ok) {
      options.state?.rollback();
      return framework(FRAMEWORK_ERRORS.mockResponseInvalid, requestId);
    }
    selected = candidate.selected;
    scenarioTransaction = {
      exchange: {
        requestId,
        method,
        target: raw.target,
        operationKey: operation.key,
        status: selected.status
      },
      ...(candidate.commit === undefined ? {} : { commit: candidate.commit })
    };
  } else {
    // Contract mode. A generated id must satisfy the strictest pattern
    // any path parameter of the served operation's family declares, so
    // the table of those patterns joins the generation options
    // (section 15.6).
    const parameterPatterns = pathPatternsFor(contract).get(
      pathFamilyKey(operation)
    );
    try {
      const candidate = await selectResponse(
        operation.key,
        operation.responses,
        options.fixtures ?? [],
        {
          seed: `${options.runSeed}:${operation.uid}`,
          lookup: schemaLookup,
          ...(parameterPatterns === undefined ? {} : { parameterPatterns })
        },
        headerValue(raw.headers, "accept")
      );
      if (candidate === null) {
        options.state?.rollback();
        return framework(FRAMEWORK_ERRORS.mockBehaviorUnavailable, requestId);
      }
      selected = candidate;
    } catch (error) {
      options.state?.rollback();
      return framework(
        schemaWorkerFramework(error),
        requestId,
        detailOf(error)
      );
    }
  }

  // Response media negotiation.
  const declared =
    selected.response?.content.map((entry) => entry.media_type) ?? [];
  const media = selected.mediaType;
  if (declared.length > 0 && media === null) {
    options.state?.rollback();
    return framework(FRAMEWORK_ERRORS.responseMediaTypeUnacceptable, requestId);
  }

  // Step 12: response validation before commit. Status, required
  // headers, media type, and body are checked against the declared
  // response; an invalid backend result never mutates state.
  let responseViolations: ResponseValidationResult;
  try {
    responseViolations = await validateResponse(
      operation.responses,
      selected,
      schemaLookup
    );
  } catch (error) {
    options.state?.rollback();
    return framework(schemaWorkerFramework(error), requestId, detailOf(error));
  }
  if (responseViolations.violations.length > 0) {
    options.state?.rollback();
    return framework(FRAMEWORK_ERRORS.mockResponseInvalid, requestId);
  }

  // Step 14: serialization. HEAD, 204, and 304 never carry body bytes;
  // Content-Length may still describe the selected representation.
  const headers: Record<string, string> = { ...selected.headers };
  const noBodyStatus = selected.status === 204 || selected.status === 304;
  const representation =
    selected.body === undefined
      ? undefined
      : media !== null &&
          !isJsonType(media) &&
          typeof selected.body === "string"
        ? selected.body
        : canonicalJson(selected.body);
  if (media !== null && headers["content-type"] === undefined) {
    headers["content-type"] = isJsonType(media)
      ? `${media}; charset=utf-8`
      : media;
  }
  if (representation !== undefined) {
    const representationBytes = Buffer.byteLength(representation, "utf8");
    headers["content-length"] = representationBytes.toString(10);
    if (representationBytes > limits.maxGeneratedResponseBodyBytes) {
      options.state?.rollback();
      return framework(FRAMEWORK_ERRORS.mockResponseInvalid, requestId);
    }
  }
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      safeHeaders[name] = value;
    }
  }
  // Step 13: the transaction commits only after every check above
  // passed. A scenario transaction carries the state transition and
  // semantic events; a persistent implementation throws when its store
  // commit fails, and the participant then receives a bounded 500
  // instead of a response whose state was never stored (section 17.1).
  try {
    options.state?.commit(scenarioTransaction);
  } catch {
    return framework(FRAMEWORK_ERRORS.stateCommitFailed, requestId);
  }
  return {
    status: selected.status,
    headers: safeHeaders,
    body: method === "HEAD" || noBodyStatus ? undefined : representation,
    requestId,
    provenance: selected.provenance,
    approximation: selected.approximation,
    frameworkCode: null
  };
}

/**
 * Bounded JSON view of parsed multipart parts for request validation.
 * A multipart body validates against the declared schema as an object
 * keyed by field name, the same form semantics the urlencoded branch
 * keeps: each part decodes to its text, and a repeated name collects
 * its values into an array.
 */
function multipartJsonValue(parts: readonly MultipartPart[]): Json {
  const decoder = new TextDecoder();
  const object: Record<string, Json> = {};
  for (const part of parts) {
    if (part.name === null) {
      continue;
    }
    const value = decoder.decode(part.body);
    const existing = object[part.name];
    if (existing === undefined) {
      object[part.name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      object[part.name] = [existing, value];
    }
  }
  return object;
}

function isJsonType(media: string): boolean {
  const base = media.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

function framework(
  error: (typeof FRAMEWORK_ERRORS)[keyof typeof FRAMEWORK_ERRORS],
  requestId: string,
  detail?: string
): GatewayResponse {
  return {
    status: error.status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify(problemDocument(error, requestId, detail)),
    requestId,
    provenance: null,
    approximation: null,
    frameworkCode: error.code
  };
}

/**
 * Stable detail line of one worker-bound failure. Only the registry
 * code and message of the typed error are exposed; unexpected errors
 * carry no detail.
 */
function detailOf(error: unknown): string | undefined {
  return error instanceof SchemaWorkerError
    ? `${error.code}: ${error.message}`
    : undefined;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name];
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

function parseTarget(
  target: string
): { path: string; query: Record<string, string | string[]> } | null {
  const question = target.indexOf("?");
  const rawPath = question === -1 ? target : target.slice(0, question);
  const rawQuery = question === -1 ? "" : target.slice(question + 1);
  if (!rawPath.startsWith("/")) {
    return null;
  }
  const query: Record<string, string | string[]> = {};
  if (rawQuery.length > 0) {
    for (const pair of rawQuery.split("&")) {
      const equals = pair.indexOf("=");
      const rawKey = equals === -1 ? pair : pair.slice(0, equals);
      const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
      const key = decodeComponent(rawKey.replace(/\+/g, " "));
      const value = decodeComponent(rawValue.replace(/\+/g, " "));
      if (key === null || value === null) {
        return null;
      }
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }
  }
  return { path: rawPath, query };
}

function decodeComponent(component: string): string | null {
  try {
    return decodeURIComponent(component);
  } catch {
    return null;
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === null) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const name = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (name.length > 0) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function parseUrlEncoded(text: string): Json {
  const result: Record<string, Json> = {};
  for (const pair of text.split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "true" : pair.slice(equals + 1);
    const key = decodeComponent(rawKey.replace(/\+/g, " "));
    const value = decodeComponent(rawValue.replace(/\+/g, " "));
    if (key === null || value === null) {
      continue;
    }
    result[key] = coerceScalar(value);
  }
  return result;
}

function coerceScalar(text: string): Json {
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return text;
}
