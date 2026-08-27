/**
 * The raw HTTP exposure treatment (specification sections 9.3, 9.4,
 * 15.1, and 31.3). One loopback listener serves the pure product
 * pipeline of `@oal/gateway` and, when the run declares one, the frozen
 * documentation plane in front of it. The participant receives the
 * per-run base URL and the declared synthetic authentication
 * instructions; contract delivery stays controlled by contract
 * visibility.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  canonicalJsonSha256,
  DiagnosticCode,
  errorDiagnostics,
  formatRfc3339,
  isJsonObject,
  sequenceId,
  sha256HexBytes,
  unsupported,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";
import { CONTRACT_IR_SCHEMA_VERSION, type ContractIR } from "@oal/contract-ir";
import type { LimitTable } from "@oal/config";
import {
  Redactor,
  traceHeaders,
  traceQuery,
  type DocumentationExchange,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import {
  FRAMEWORK_ERRORS,
  handleGatewayRequest,
  matchRoute,
  problemDocument,
  type FrameworkError,
  type GatewayResponse,
  type RouteResult
} from "@oal/gateway";

import {
  compileDocumentationProfile,
  conventionalCandidates,
  declaredSchemes,
  DocumentationPlane,
  type CandidateEnablement,
  type CompiledDocumentationProfile,
  type DocumentationAuthentication
} from "./exposure-documentation.ts";
import type { ContractVisibility } from "./preflight.ts";
import {
  credentialEnvironmentName,
  credentialEnvironmentNames,
  type ExposureFactory,
  type ExposureHandle,
  type ExposureRequest,
  type TraceWriter
} from "./setup.ts";

/** Maximum bytes of one body kept verbatim in the trace. */
const MAX_TRACE_JSON_BYTES = 16 * 1024;

/** Default bind host; the runner never leaves loopback. */
export const DEFAULT_EXPOSURE_HOST = "127.0.0.1";

/** Sliding window width of the per-run burst quota. */
const BURST_WINDOW_MS = 1000;

/**
 * A documentation profile that failed validation. The diagnostics are
 * preflight-style OAL records, so the caller can surface them before
 * any participant material exists.
 */
export class ExposureProfileError extends Error {
  readonly code = "OAL-DOCS-PROFILE-INVALID";

  constructor(
    readonly diagnostics: readonly Diagnostic[],
    message: string
  ) {
    super(message);
    this.name = "ExposureProfileError";
  }
}

/** Documentation options of {@link createRawHttpExposure}. */
export interface RawHttpDocumentationOptions {
  /**
   * The exact sanitized localized contract bytes. A function receives
   * the live base URL, because file visibility rewrites server entries
   * with it and the facade must serve the same bytes.
   */
  readonly sanitizedContract?: string | ((baseUrl: string) => string);
  /** Candidate enablement; every candidate stays individually settable. */
  readonly candidates?: CandidateEnablement;
  /** Declared authentication policy; the default requires credentials. */
  readonly authentication?: DocumentationAuthentication;
}

/** Options of {@link createRawHttpExposure}. */
export interface RawHttpExposureOptions {
  /**
   * Contract visibility of specification section 9.4. The default
   * `file` copies the sanitized contract through the participant-file
   * machinery, so the listener serves no documentation route.
   */
  readonly visibility?: ContractVisibility;
  /**
   * Declare the documentation plane. Required for `discoverable`; any
   * other visibility freezes the same inventory with every candidate
   * disabled, which answers the neutral unknown-route shape on those
   * probes.
   */
  readonly documentation?: RawHttpDocumentationOptions;
}

/**
 * Render the declared synthetic authentication instructions for one
 * contract. Instructions name schemes, wire names, and environment
 * names only; credential values never appear.
 */
export function syntheticCredentialInstructions(
  contract: ContractIR
): readonly string[] {
  const instructions: string[] = [];
  for (const { alias, scheme } of declaredSchemes(contract)) {
    const name = credentialEnvironmentName(alias);
    const wireName = scheme.wire_name ?? alias;
    if (scheme.type === "http" && scheme.scheme === "basic") {
      instructions.push(
        `Scheme ${alias}: send the Authorization header with Basic credentials.` +
          ` Build it from the values of ${name}_USERNAME and ${name}_PASSWORD.`
      );
    } else if (
      scheme.type === "oauth2" ||
      scheme.type === "openIdConnect" ||
      (scheme.type === "http" && scheme.scheme === "bearer")
    ) {
      instructions.push(
        `Scheme ${alias}: send the Authorization header with the bearer token` +
          ` from the value of ${name}.`
      );
    } else if (scheme.type === "apiKey") {
      const location = scheme.location === null ? "header" : scheme.location;
      const target =
        location === "query"
          ? `append the ${wireName} query parameter`
          : location === "cookie"
            ? `send the ${wireName} cookie`
            : `send the ${wireName} header`;
      instructions.push(
        `Scheme ${alias}: ${target} with the value of ${name} on every request.`
      );
    } else if (scheme.type === "mutualTLS") {
      instructions.push(
        `Scheme ${alias}: the contract declares mutual TLS, and this build does not authenticate it.`
      );
    } else {
      instructions.push(
        `Scheme ${alias}: present the credential of type ${scheme.type} through ${name}.`
      );
    }
  }
  return Object.freeze(instructions);
}

/** Record fields that hold rendered run substitutions. */
const VOLATILE_RECORD_KEYS = new Set([
  "base_url",
  "port",
  "documentation_base_url"
]);

/** Rendered substitutions inside the documentation block. */
const VOLATILE_DOCUMENTATION_KEYS = new Set(["base_url", "contract_sha256"]);

/**
 * Digest of the server record with every rendered run substitution
 * removed. Random ports and rewritten base URLs do not change the
 * value, so two servers built from identical options digest equal
 * (specification section 9.6, template digest).
 */
export function serverRecordSurfaceDigest(record: JsonObject): string {
  const template: JsonObject = {};
  for (const [key, value] of Object.entries(record)) {
    if (VOLATILE_RECORD_KEYS.has(key)) {
      continue;
    }
    if (key === "documentation" && isJsonObject(value)) {
      const documentation: JsonObject = {};
      for (const [name, item] of Object.entries(value)) {
        if (!VOLATILE_DOCUMENTATION_KEYS.has(name)) {
          documentation[name] = item;
        }
      }
      template[key] = documentation;
      continue;
    }
    template[key] = value;
  }
  return canonicalJsonSha256(template as Json);
}

/**
 * Collect one request body without ever buffering past the limit. The
 * byte count and the streaming digest keep running after the stored
 * preview stops, as section 31.3 requires.
 */
class BodyCollector {
  private readonly chunks: Buffer[] = [];
  private readonly hash = createHash("sha256");
  private readonly limit: number;
  private stored = 0;
  private total = 0;
  private digest: string | null = null;

  constructor(limit: number) {
    this.limit = limit;
  }

  add(chunk: Buffer): void {
    this.total += chunk.byteLength;
    this.hash.update(chunk);
    if (this.stored < this.limit) {
      const room = this.limit - this.stored;
      const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(piece);
      this.stored += piece.byteLength;
    }
  }

  get overflowed(): boolean {
    return this.total > this.limit;
  }

  get totalBytes(): number {
    return this.total;
  }

  get sha256(): string {
    if (this.digest === null) {
      this.digest = this.hash.digest("hex");
    }
    return this.digest;
  }

  storedBytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Why a request was refused before any plane dispatch. */
type Refusal = "run" | "burst" | "concurrent";

/**
 * Per-run admission control. The counters cover the total request
 * quota, the sliding-window burst quota, and the bounded request
 * queue; every check runs before any dispatch or state change.
 */
class AdmissionControl {
  private readonly limits: LimitTable;
  private total = 0;
  private inFlight = 0;
  private window: number[] = [];

  constructor(limits: LimitTable) {
    this.limits = limits;
  }

  admit(now: number): Refusal | null {
    this.total += 1;
    if (this.total > this.limits.maxRequestsPerRun) {
      return "run";
    }
    const horizon = now - BURST_WINDOW_MS;
    this.window = this.window.filter((seen) => seen > horizon);
    this.window.push(now);
    if (this.window.length > this.limits.maxBurstRequestsPerSecond) {
      return "burst";
    }
    this.inFlight += 1;
    if (this.inFlight > this.limits.maxConcurrentConnectionsPerRun) {
      this.inFlight -= 1;
      return "concurrent";
    }
    return null;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

function queryOf(target: string): URLSearchParams {
  const marker = target.indexOf("?");
  return new URLSearchParams(marker === -1 ? "" : target.slice(marker + 1));
}

function pathOf(target: string): string {
  const marker = target.indexOf("?");
  return marker === -1 ? target : target.slice(0, marker);
}

function bodyOf(
  bytes: Uint8Array,
  sizeBytes?: number,
  sha256?: string | null
): TraceBody {
  const size = sizeBytes ?? bytes.byteLength;
  if (size === 0) {
    return { kind: "none" };
  }
  if (size > MAX_TRACE_JSON_BYTES || bytes.byteLength < size) {
    return {
      kind: "binary",
      size_bytes: size,
      sha256: sha256 ?? sha256HexBytes(bytes),
      blob_ref: null
    };
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return {
      kind: "json",
      size_bytes: size,
      value: JSON.parse(text) as Json,
      truncated: false
    };
  } catch {
    return {
      kind: "text",
      size_bytes: size,
      sha256: sha256 ?? sha256HexBytes(bytes),
      text,
      truncated: false
    };
  }
}

/** The same framework bytes the gateway itself would send. */
function frameworkResponse(
  error: FrameworkError,
  requestId: string
): GatewayResponse {
  return {
    status: error.status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify(problemDocument(error, requestId)),
    requestId,
    provenance: null,
    frameworkCode: error.code
  };
}

/** Serialize one response onto the socket. */
function settle(
  outgoing: ServerResponse,
  response: {
    status: number;
    headers: Record<string, string>;
    body: string | undefined;
  }
): void {
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(response.body ?? "");
}

function listen(server: Server, request: ExposureRequest): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(request.port, request.host, () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("The loopback gateway reported no port."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function stop(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server.closeAllConnections();
}

/**
 * Build one raw HTTP exposure factory. The returned factory closes
 * over the visibility and documentation plan, so the injected
 * `ExposureRequest` stays free of study concerns.
 */
export function createRawHttpExposure(
  options: RawHttpExposureOptions = {}
): ExposureFactory {
  return (request: ExposureRequest): Promise<ExposureHandle> =>
    startRawHttpExposure(request, options);
}

/**
 * The default exposure treatment: raw HTTP over `file` visibility with
 * no documentation route. The sanitized contract file reaches the
 * participant through the workspace plan, never through the listener.
 */
export const createLoopbackExposure: ExposureFactory = (request) =>
  startRawHttpExposure(request, {});

async function startRawHttpExposure(
  request: ExposureRequest,
  options: RawHttpExposureOptions
): Promise<ExposureHandle> {
  // The contract schema version is checked before the listener binds,
  // so an unsupported contract fails the trial at startup (section
  // 42.2, AC-012). The producer types the field narrowly; a contract
  // read from disk carries no runtime guarantee, so widen it first.
  const version: number = request.contract.schema_version;
  if (version !== CONTRACT_IR_SCHEMA_VERSION) {
    throw unsupported(
      DiagnosticCode.UnsupportedSchemaVersion,
      `Contract schema version ${String(version)} is not supported; this build serves version ${String(CONTRACT_IR_SCHEMA_VERSION)}.`,
      { contract_schema_version: version }
    );
  }
  const visibility: ContractVisibility = options.visibility ?? "file";
  const documentation = options.documentation;
  const candidates = conventionalCandidates(
    documentation?.candidates ?? {},
    visibility
  );
  const authentication: DocumentationAuthentication =
    documentation?.authentication ?? "required";

  const trace = request.trace;
  const redactor = new Redactor({
    hmacKey: Buffer.from(request.trialSeed, "utf8"),
    config: {
      sensitiveHeaderNames: [...request.sensitiveHeaderNames],
      keyPatterns: [...request.sensitiveKeyPatterns]
    }
  });
  const admission = new AdmissionControl(request.limits);
  let plane: DocumentationPlane | null = null;

  const answer = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    collector: BodyCollector
  ): Promise<void> => {
    const startedAt = request.now();
    const method = (incoming.method ?? "GET").toUpperCase();
    const target = incoming.url ?? "/";
    const path = pathOf(target);
    const query = queryOf(target);
    const bytes = collector.storedBytes();
    const reserved = trace.reserve();
    const requestId = sequenceId("req", reserved.sequence);

    // Section 31.3: validate every limit before any dispatch or state
    // change. A limit event stays visible in evidence.
    const refusal = admission.admit(request.now());
    const overTarget =
      Buffer.byteLength(target, "utf8") > request.limits.maxRequestTargetBytes;
    if (refusal !== null || overTarget || collector.overflowed) {
      const error =
        refusal !== null
          ? FRAMEWORK_ERRORS.requestQuotaExceeded
          : overTarget
            ? FRAMEWORK_ERRORS.requestTargetTooLarge
            : FRAMEWORK_ERRORS.requestBodyTooLarge;
      const response = frameworkResponse(error, requestId);
      await completeApiExchange(request, trace, redactor, {
        method,
        target,
        headers: incoming.headers,
        collector,
        response,
        reserved,
        startedAt,
        routed: false
      });
      settle(outgoing, response);
      if (refusal === null) {
        admission.release();
      }
      return;
    }

    // Section 15.1: the documentation-candidate inventory is checked
    // before product route matching and never enters it.
    const candidate = plane?.match(method, path) ?? null;
    if (candidate !== null && plane !== null) {
      const result = plane.serve(candidate, {
        method,
        path,
        headers: incoming.headers,
        query,
        requestId
      });
      const exchange: DocumentationExchange = {
        schema_version: 1,
        type: "documentation.exchange",
        event_id: sequenceId("doc", reserved.sequence),
        sequence: reserved.sequence,
        participant_ingress_sequence: reserved.sequence,
        observed_at: formatRfc3339(startedAt),
        batch_id: request.batchId,
        run_id: request.runId,
        actor: "participant",
        request: { method, path },
        candidate: {
          profile: plane.profileId,
          route_id: result.candidate.route_id
        },
        authentication: { status: result.authenticationStatus },
        visibility: plane.visibility,
        outcome: result.outcome,
        response: {
          status: result.serving.status,
          content_type: result.serving.headers["content-type"] ?? null,
          bytes: result.bytes,
          body_sha256: result.bodySha256
        },
        duration_ms: Math.max(0, request.now() - startedAt),
        extensions: {}
      };
      await trace.complete(exchange as unknown as TraceEvent);
      settle(outgoing, result.serving);
      admission.release();
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      headers[name] = value ?? [];
    }
    const response = handleGatewayRequest(
      {
        contract: request.contract,
        limits: request.limits,
        runSeed: request.trialSeed
      },
      reserved.sequence,
      { method, target, headers, body: bytes }
    );
    await completeApiExchange(request, trace, redactor, {
      method,
      target,
      headers: incoming.headers,
      collector,
      response,
      reserved,
      startedAt,
      routed: true
    });
    settle(outgoing, response);
    admission.release();
  };

  const server: Server = createServer((incoming, outgoing) => {
    const collector = new BodyCollector(request.limits.maxRequestBodyBytes);
    incoming.on("data", (chunk: Buffer) => {
      collector.add(chunk);
    });
    incoming.on("end", () => {
      void answer(incoming, outgoing, collector);
    });
    incoming.on("error", () => undefined);
    outgoing.on("error", () => undefined);
  });

  const port = await listen(server, request);
  const baseUrl = `http://${request.host}:${port}`;

  if (documentation !== undefined || candidates.some((c) => c.enabled)) {
    const supplied = documentation?.sanitizedContract;
    const document =
      supplied === undefined
        ? null
        : typeof supplied === "function"
          ? supplied(baseUrl)
          : supplied;
    const documentBytes =
      document === null ? null : Buffer.byteLength(document, "utf8");
    const compiled: CompiledDocumentationProfile = compileDocumentationProfile({
      visibility,
      candidates,
      authentication,
      contract: request.contract,
      documentBytes,
      maxDocumentBytes: request.limits.maxBundledDocumentBytes
    });
    const errors = errorDiagnostics(compiled.diagnostics);
    if (compiled.profile === null || errors.length > 0) {
      await stop(server);
      throw new ExposureProfileError(
        compiled.diagnostics,
        `The documentation profile is invalid: ${errors[0]?.code ?? "unknown"}.`
      );
    }
    plane =
      document === null
        ? null
        : new DocumentationPlane({
            profile: compiled.profile,
            visibility,
            contract: request.contract,
            trialSeed: request.trialSeed,
            document
          });
  }

  const names = credentialEnvironmentNames(request.contract);
  const instructions = syntheticCredentialInstructions(request.contract);
  const indexEnabled = candidates.some(
    (candidate) => candidate.enabled && candidate.role === "index"
  );

  const serverRecord: JsonObject = {
    schema_version: 1,
    kind: "Server",
    run_id: request.runId,
    mode: "contract",
    base_url: baseUrl,
    host: request.host,
    port,
    transport: "http",
    documentation_base_url:
      plane !== null && visibility === "discoverable" ? baseUrl : null,
    documentation:
      plane === null
        ? null
        : {
            profile: plane.profileId,
            base_url: visibility === "discoverable" ? baseUrl : null,
            authentication: plane.authentication,
            candidates: plane.candidates.map((candidate) => ({
              route_id: candidate.route_id,
              method: candidate.method,
              path: candidate.path,
              role: candidate.role,
              enabled: candidate.enabled
            })),
            contract_sha256: plane.documentSha256,
            index_sha256: indexEnabled ? plane.indexSha256 : null
          },
    mcp: null,
    credential_names: [...names],
    credential_instructions: [...instructions]
  };

  let closed = false;
  return {
    baseUrl,
    credentialNames: Object.freeze([...names]),
    documentationUrl: visibility === "discoverable" ? baseUrl : null,
    mcpUrl: null,
    serverRecord,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await stop(server);
    }
  };
}

interface ApiExchangeInput {
  readonly method: string;
  readonly target: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly collector: BodyCollector;
  readonly response: GatewayResponse;
  readonly reserved: { sequence: number; event_id: string };
  readonly startedAt: number;
  readonly routed: boolean;
}

/** Record one product or limit exchange as an api.exchange event. */
async function completeApiExchange(
  request: ExposureRequest,
  trace: TraceWriter,
  redactor: Redactor,
  input: ApiExchangeInput
): Promise<void> {
  const { method, target, response } = input;
  const path = pathOf(target);
  const query = queryOf(target);
  const bytes = input.collector.storedBytes();
  const route: RouteResult = input.routed
    ? matchRoute(request.contract.operations, method, path)
    : { match: null, allowedMethods: [], pathExists: false };
  const headerPairs = Object.entries(input.headers).flatMap(([name, value]) =>
    value === undefined
      ? []
      : ([[name, Array.isArray(value) ? [...value] : [value]]] as Array<
          [string, string[]]
        >)
  );
  const queryEntries: Array<[string, string[]]> = [...query.entries()].map(
    ([name, value]) => [name, [value]]
  );
  const contentType = input.headers["content-type"];
  const complete = bytes.byteLength === input.collector.totalBytes;
  const requestSha = complete ? null : input.collector.sha256;

  const event: TraceEvent = {
    schema_version: 1,
    type: "api.exchange",
    event_id: input.reserved.event_id,
    sequence: input.reserved.sequence,
    participant_ingress_sequence: input.reserved.sequence,
    observed_at: formatRfc3339(input.startedAt),
    logical_time: null,
    batch_id: request.batchId,
    run_id: request.runId,
    eval_id: request.evalId,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: route.match !== null,
      key: route.match?.operation.key ?? null,
      uid: route.match?.operation.operation_id ?? null,
      operation_id: route.match?.operation.operation_id ?? null,
      method,
      path_template: route.match?.operation.path_template ?? path,
      support: route.match === null ? "unsupported" : "supported"
    },
    request: {
      received_at: formatRfc3339(input.startedAt),
      method,
      path,
      query_string: query.toString(),
      query: traceQuery(queryEntries, redactor),
      path_parameters: route.match?.pathParameters ?? {},
      headers: traceHeaders(headerPairs, redactor),
      credential_present:
        input.headers["authorization"] !== undefined ||
        request.sensitiveHeaderNames.some((name) =>
          Object.keys(input.headers).some(
            (header) => header.toLowerCase() === name
          )
        ),
      content_type: typeof contentType === "string" ? contentType : null,
      body: bodyOf(bytes, input.collector.totalBytes, requestSha)
    },
    authentication: {
      status:
        response.frameworkCode === "authentication_failed"
          ? "rejected"
          : "authenticated",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: {
        status: response.frameworkCode === null ? "valid" : "invalid",
        violations:
          response.frameworkCode === null
            ? []
            : [
                {
                  pointer: "",
                  code: response.frameworkCode,
                  message: "The gateway rejected the request."
                }
              ]
      },
      response: { status: "valid", violations: [] }
    },
    backend: {
      mode: "contract",
      name: null,
      outcome: response.frameworkCode === null ? "handled" : "skipped",
      duration_ms: Math.max(0, request.now() - input.startedAt),
      response_provenance:
        response.provenance?.startsWith("fixture:") === true
          ? "fixture"
          : "generated",
      effects: [],
      observations: {}
    },
    response: {
      completed_at: formatRfc3339(request.now()),
      status: response.status,
      headers: Object.entries(response.headers).map(([name, value]) => ({
        name: name.toLowerCase(),
        values: [value],
        redacted: false
      })),
      content_type: response.headers["content-type"] ?? null,
      body: bodyOf(Buffer.from(response.body ?? "", "utf8"))
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error:
      response.frameworkCode === null
        ? null
        : {
            layer: "routing",
            code: response.frameworkCode,
            message: "The gateway served a framework error document.",
            retryable: false,
            details: {}
          },
    duration_ms: Math.max(0, request.now() - input.startedAt),
    resource_usage: {
      request_bytes: input.collector.totalBytes,
      response_bytes: Buffer.byteLength(response.body ?? "", "utf8")
    },
    extensions: {}
  };
  await trace.complete(event);
}
