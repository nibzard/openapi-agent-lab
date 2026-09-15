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
import type { Socket } from "node:net";

import {
  canonicalJsonSha256,
  configureSchemaWorker,
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
import { schemaWorkerSettingsOf, type LimitTable } from "@oal/config";
import {
  Redactor,
  redactPath,
  traceHeaders,
  traceQuery,
  type DocumentationExchange,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import {
  createGatewayState,
  FRAMEWORK_ERRORS,
  handleGatewayRequest,
  matchRoute,
  problemDocument,
  type ContractFixture,
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
 * Stable codes of one exchange the exposure could not complete, one per
 * failure class of the taxonomy in specification section 32.2. A
 * persistence failure invalidates evidence, gateway and plane failures
 * are mock-pipeline defects, and an ingress failure never reached a
 * reserved sequence.
 */
export const EXCHANGE_PERSIST_FAILED = "OAL-EXPOSURE-EXCHANGE-PERSIST-FAILED";
export const EXCHANGE_GATEWAY_FAILED = "OAL-EXPOSURE-EXCHANGE-GATEWAY-FAILED";
export const EXCHANGE_PLANE_FAILED = "OAL-EXPOSURE-EXCHANGE-PLANE-FAILED";
export const EXCHANGE_INGRESS_FAILED = "OAL-EXPOSURE-EXCHANGE-INGRESS-FAILED";

/** One stable exchange-failure code. */
export type ExchangeFailureCode =
  | typeof EXCHANGE_PERSIST_FAILED
  | typeof EXCHANGE_GATEWAY_FAILED
  | typeof EXCHANGE_PLANE_FAILED
  | typeof EXCHANGE_INGRESS_FAILED;

/**
 * The stage of {@link startRawHttpExposure} one failure escaped from.
 * The stage names the failure class, so the record carries the code of
 * the layer that failed instead of one hard-coded cause.
 */
type ExchangeFailureStage = "ingress" | "plane" | "gateway" | "persist";

/** Stable code of one failure stage (section 32.2 categories). */
const FAILURE_CODES: Readonly<
  Record<ExchangeFailureStage, ExchangeFailureCode>
> = {
  ingress: EXCHANGE_INGRESS_FAILED,
  plane: EXCHANGE_PLANE_FAILED,
  gateway: EXCHANGE_GATEWAY_FAILED,
  persist: EXCHANGE_PERSIST_FAILED
};

/** Failure records one exposure handle keeps; the list stays bounded. */
const MAX_RECORDED_EXCHANGE_FAILURES = 16;

/**
 * A documentation profile that failed validation. The diagnostics are
 * preflight-style OAL records, so the caller can surface them before
 * any participant material exists.
 */
export class ExposureProfileError extends Error {
  readonly code = "OAL-DOCS-PROFILE-INVALID";
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[], message: string) {
    super(message);
    this.diagnostics = diagnostics;
    this.name = "ExposureProfileError";
  }
}

/**
 * Diagnostic record of one exchange the exposure could not complete.
 * The participant saw the bounded generic 500 of section 15.2; the
 * record keeps the correlation id and time, never failure text. The
 * correlation id is null when the failure preceded ingress reservation.
 */
export interface ExposureFailureRecord {
  readonly code: ExchangeFailureCode;
  readonly requestId: string | null;
  readonly observedAt: string;
}

/**
 * The raw HTTP exposure handle. It extends the generic handle with the
 * exchange-failure diagnostics of this treatment, so a caller that
 * needs them reads them without changing the shared interface.
 */
export interface RawHttpExposureHandle extends ExposureHandle {
  /** Exchanges that failed after ingress, shielded from the caller. */
  readonly exchangeFailureCount: number;
  /** First failure records in ingress order; the list is bounded. */
  readonly exchangeFailures: readonly ExposureFailureRecord[];
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
   * Response fixtures of the loaded pack, served ahead of example and
   * schema generation (specification section 15.5). The list is copied
   * once when the listener starts; the default serves none.
   */
  readonly fixtures?: readonly ContractFixture[];
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
 * names only; credential values never appear. A pack-declared
 * participant name, when one exists, replaces the generated name.
 */
export function syntheticCredentialInstructions(
  contract: ContractIR,
  credentialEnvironments?: ReadonlyMap<string, string>
): readonly string[] {
  const instructions: string[] = [];
  for (const { alias, scheme } of declaredSchemes(contract)) {
    const name =
      credentialEnvironments?.get(alias) ?? credentialEnvironmentName(alias);
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
  private readonly secrets: readonly string[];
  private secretTail = "";
  private hasSecret = false;

  constructor(limit: number, secrets: readonly string[] = []) {
    this.limit = limit;
    this.secrets = secrets.filter((secret) => secret.length > 0);
  }

  add(chunk: Buffer): void {
    this.total += chunk.byteLength;
    this.hash.update(chunk);
    if (!this.hasSecret && this.secrets.length > 0) {
      const text = `${this.secretTail}${chunk.toString("utf8")}`;
      this.hasSecret = this.secrets.some((secret) => text.includes(secret));
      const overlap = Math.max(
        0,
        ...this.secrets.map((secret) => secret.length - 1)
      );
      this.secretTail = overlap === 0 ? "" : text.slice(-overlap);
    }
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

  get containsSecret(): boolean {
    return this.hasSecret;
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

/**
 * Collapse a gateway provenance string into the trace enum. The raw
 * string survives in backend.observations.provenance_detail, so the
 * class never destroys information: fixture:<id> and example:<name>
 * keep their identity one level down.
 */
function provenanceClassOf(
  provenance: string | null | undefined
): "fixture" | "behavior" | "example" | "generated" {
  if (provenance === null || provenance === undefined) {
    return "generated";
  }
  if (provenance.startsWith("fixture:")) {
    return "fixture";
  }
  if (provenance.startsWith("behavior:")) {
    return "behavior";
  }
  if (provenance.startsWith("example:")) {
    return "example";
  }
  return "generated";
}

function bodyOf(
  bytes: Uint8Array,
  redactor: Redactor,
  sizeBytes?: number,
  sha256?: string | null,
  containsSecret = false
): TraceBody {
  const size = sizeBytes ?? bytes.byteLength;
  if (size === 0) {
    return { kind: "none" };
  }
  if (size > MAX_TRACE_JSON_BYTES || bytes.byteLength < size) {
    const text = new TextDecoder().decode(bytes);
    return {
      kind: "binary",
      size_bytes: size,
      sha256:
        containsSecret || redactor.containsSecret(text)
          ? null
          : (sha256 ?? sha256HexBytes(bytes)),
      blob_ref: null
    };
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return {
      kind: "json",
      size_bytes: size,
      value: redactor.redactJson(JSON.parse(text) as Json),
      truncated: false
    };
  } catch {
    return {
      kind: "text",
      size_bytes: size,
      sha256:
        containsSecret || redactor.containsSecret(text)
          ? null
          : (sha256 ?? sha256HexBytes(bytes)),
      text: redactor.redactText(text),
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
    approximation: null,
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

/**
 * Settle one socket after an internal failure (sections 15.2 and
 * 17.1). The participant receives the bounded generic 500 problem
 * document; no internal detail of the failure crosses the wire. A
 * socket that already sent its headers only ends its body.
 */
function settleInternalFailure(
  outgoing: ServerResponse,
  requestId: string
): void {
  if (outgoing.headersSent) {
    outgoing.end();
    return;
  }
  settle(
    outgoing,
    frameworkResponse(FRAMEWORK_ERRORS.internalError, requestId)
  );
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
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
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
): Promise<RawHttpExposureHandle> {
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
  // The schema worker boundary serves this exposure with the resource
  // settings of the run's limit table, so a hostile pattern inside the
  // contract is bounded by the configured deadline and queue bounds.
  // The settings are process-global: one run resolves one table before
  // any exposure starts, and the last exposure to configure wins.
  configureSchemaWorker(schemaWorkerSettingsOf(request.limits));
  const candidates = conventionalCandidates(
    documentation?.candidates ?? {},
    visibility
  );
  const authentication: DocumentationAuthentication =
    documentation?.authentication ?? "required";

  const trace = request.trace;
  const documentationTrace = request.documentationTrace ?? {
    reserve: (): { sequence: number; event_id: string } => {
      const reserved = trace.reserve();
      return {
        sequence: reserved.sequence,
        event_id: sequenceId("doc", reserved.sequence)
      };
    },
    complete: (event: DocumentationExchange): Promise<void> =>
      trace.complete(event as unknown as TraceEvent)
  };
  const sensitiveHeaderNames = new Set(request.sensitiveHeaderNames);
  const sensitiveCookieNames = new Set<string>();
  const sensitiveQueryNames = new Set<string>();
  for (const scheme of Object.values(request.contract.security_schemes)) {
    if (scheme.type !== "apiKey" || scheme.wire_name === null) {
      continue;
    }
    if (scheme.location === "header") {
      sensitiveHeaderNames.add(scheme.wire_name);
    } else if (scheme.location === "cookie") {
      sensitiveCookieNames.add(scheme.wire_name);
    } else if (scheme.location === "query") {
      sensitiveQueryNames.add(scheme.wire_name);
    }
  }
  sensitiveHeaderNames.add("authorization");
  const redactor = new Redactor({
    hmacKey: Buffer.from(request.trialSeed, "utf8"),
    secrets: request.secrets ?? [],
    config: {
      sensitiveHeaderNames: [...sensitiveHeaderNames],
      sensitiveCookieNames: [...sensitiveCookieNames],
      sensitiveQueryNames: [...sensitiveQueryNames],
      keyPatterns: [...request.sensitiveKeyPatterns]
    }
  });
  // The fixture list is copied once, so no request can mutate what a
  // later request of the same run serves (section 15.5).
  const fixtures: ContractFixture[] =
    options.fixtures === undefined ? [] : [...options.fixtures];
  // One state serializes the pipelines of this exposure in ingress
  // order: the gateway awaits worker replies between staging and
  // commit, so without a shared state the pipelines run concurrently
  // and completion order stops matching ingress order.
  const gatewayState = createGatewayState();
  const admission = new AdmissionControl(request.limits);
  const exchangeFailures: ExposureFailureRecord[] = [];
  let exchangeFailureTotal = 0;
  let participantIngressSequence = 0;
  let plane: DocumentationPlane | null = null;

  /**
   * Record one exchange the exposure could not complete. The record
   * keeps no failure text: cause messages vary by host, and the run
   * record must stay a function of the request stream alone.
   */
  const recordExchangeFailure = (
    requestId: string | null,
    stage: ExchangeFailureStage,
    observedAt: number
  ): void => {
    exchangeFailureTotal += 1;
    if (exchangeFailures.length < MAX_RECORDED_EXCHANGE_FAILURES) {
      exchangeFailures.push({
        code: FAILURE_CODES[stage],
        requestId,
        observedAt: formatRfc3339(observedAt)
      });
    }
  };

  const answer = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    collector: BodyCollector,
    ingressSequence: number,
    ingressStartedAt: number,
    connectionOverLimit: boolean
  ): Promise<void> => {
    const method = (incoming.method ?? "GET").toUpperCase();
    const target = incoming.url ?? "/";
    // How far this exchange got. The failure path needs every piece to
    // settle the socket, give the admission slot back, and keep the
    // event stream moving, whatever stage failed.
    let startedAt: number | null = null;
    let reserved: { sequence: number; event_id: string } | null = null;
    let documentationExchange = false;
    let stage: ExchangeFailureStage = "ingress";
    // True while this request holds one concurrent-connection slot, so
    // the failure path below can give the slot back exactly once.
    let holdsAdmission = false;
    /**
     * The clock of the failure record. A clock that throws must not
     * stop the failure path, so fall back to the ingress reading.
     */
    const failureNow = (): number => {
      try {
        return request.now();
      } catch {
        return startedAt ?? 0;
      }
    };
    try {
      startedAt = ingressStartedAt;

      const path = pathOf(target);
      const query = queryOf(target);
      const bytes = collector.storedBytes();

      const candidate = plane?.match(method, path) ?? null;
      documentationExchange = candidate !== null && plane !== null;
      reserved = documentationExchange
        ? documentationTrace.reserve()
        : trace.reserve();
      const requestId = sequenceId("req", ingressSequence);

      // Section 31.3: validate every limit before any dispatch or state
      // change. A limit event stays visible in evidence.
      const admitted = admission.admit(request.now());
      holdsAdmission = admitted === null;
      const refusal: Refusal | null = connectionOverLimit
        ? "concurrent"
        : admitted;
      const overTarget =
        Buffer.byteLength(target, "utf8") >
        request.limits.maxRequestTargetBytes;
      if (refusal !== null || overTarget || collector.overflowed) {
        const error =
          refusal !== null
            ? FRAMEWORK_ERRORS.requestQuotaExceeded
            : overTarget
              ? FRAMEWORK_ERRORS.requestTargetTooLarge
              : FRAMEWORK_ERRORS.requestBodyTooLarge;
        const response = frameworkResponse(error, requestId);
        stage = "persist";
        await completeApiExchange(request, trace, redactor, {
          method,
          target,
          headers: incoming.headers,
          collector,
          response,
          reserved,
          ingressSequence,
          startedAt,
          routed: false
        });
        settle(outgoing, response);
        if (holdsAdmission) {
          admission.release();
          holdsAdmission = false;
        }
        return;
      }

      // Section 15.1: the documentation-candidate inventory is checked
      // before product route matching and never enters it.
      if (candidate !== null && plane !== null) {
        stage = "plane";
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
          event_id: reserved.event_id,
          sequence: reserved.sequence,
          participant_ingress_sequence: ingressSequence,
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
        stage = "persist";
        await documentationTrace.complete(exchange);
        settle(outgoing, result.serving);
        admission.release();
        holdsAdmission = false;
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        headers[name] = value ?? [];
      }
      stage = "gateway";
      // Effects this exchange commits land in the scenario state after
      // the gateway call, so snapshot the length and diff after it.
      const effectsBefore =
        request.scenarioState === undefined
          ? 0
          : request.scenarioState.appliedEffects.length;
      const response = await handleGatewayRequest(
        {
          contract: request.contract,
          limits: request.limits,
          fixtures,
          runSeed: request.trialSeed,
          state: request.scenarioState ?? gatewayState,
          ...(request.backend === undefined ? {} : { backend: request.backend })
        },
        reserved.sequence,
        { method, target, headers, body: bytes }
      );
      const committedEffects =
        request.scenarioState === undefined
          ? []
          : request.scenarioState.appliedEffects.slice(effectsBefore);
      stage = "persist";
      await completeApiExchange(request, trace, redactor, {
        method,
        target,
        headers: incoming.headers,
        collector,
        response,
        reserved,
        ingressSequence,
        startedAt,
        routed: true,
        committedEffects
      });
      settle(outgoing, response);
      admission.release();
      holdsAdmission = false;
    } catch {
      // Sections 15.2 and 17.1: an internal failure settles the
      // participant socket with the bounded generic 500, returns the
      // admission slot, and leaves the process alive. The reserved
      // sequence is completed with a minimal event, so the stream keeps
      // advancing and later events of the run flush instead of
      // buffering forever. The record carries no internal detail of the
      // failure, only the stable code of the stage that failed.
      const reservedSlot = reserved;
      const requestId =
        reservedSlot === null
          ? sequenceId("req", 0)
          : sequenceId("req", reservedSlot.sequence);
      settleInternalFailure(outgoing, requestId);
      if (holdsAdmission) {
        admission.release();
        holdsAdmission = false;
      }
      const observedAt = failureNow();
      if (
        reservedSlot !== null &&
        startedAt !== null &&
        !documentationExchange
      ) {
        try {
          await completeFailedExchange(request, trace, {
            reserved: reservedSlot,
            startedAt,
            observedAt,
            requestBytes: collector.totalBytes,
            stage,
            ingressSequence,
            backendMode: request.backend === undefined ? "contract" : "scenario"
          });
        } catch {
          // The sink already refused the original append; the sequence
          // was consumed, so the stream still advances.
        }
      }
      recordExchangeFailure(
        reservedSlot === null ? null : sequenceId("req", reservedSlot.sequence),
        stage,
        observedAt
      );
    }
  };

  const recordDisconnected = async (
    collector: BodyCollector,
    ingressSequence: number,
    startedAt: number
  ): Promise<void> => {
    let reserved: { sequence: number; event_id: string } | null = null;
    try {
      reserved = trace.reserve();
      const observedAt = request.now();
      await completeFailedExchange(request, trace, {
        reserved,
        startedAt,
        observedAt,
        requestBytes: collector.totalBytes,
        stage: "ingress",
        ingressSequence,
        backendMode: request.backend === undefined ? "contract" : "scenario"
      });
    } catch {
      recordExchangeFailure(
        reserved === null ? null : sequenceId("req", ingressSequence),
        reserved === null ? "ingress" : "persist",
        startedAt
      );
    }
  };

  const server: Server = createServer((incoming, outgoing) => {
    const collector = new BodyCollector(
      request.limits.maxRequestBodyBytes,
      request.secrets ?? []
    );
    participantIngressSequence += 1;
    const ingressSequence = participantIngressSequence;
    let ingressStartedAt = 0;
    try {
      ingressStartedAt = request.now();
    } catch {
      settleInternalFailure(outgoing, sequenceId("req", ingressSequence));
      recordExchangeFailure(null, "ingress", 0);
      return;
    }
    let handled = false;
    incoming.on("data", (chunk: Buffer) => {
      collector.add(chunk);
    });
    incoming.on("end", () => {
      if (handled) {
        return;
      }
      handled = true;
      // The handler settles every request itself, failures included,
      // so it never rejects; this guard only keeps a programmer error
      // from becoming an unhandled rejection that kills the process.
      answer(
        incoming,
        outgoing,
        collector,
        ingressSequence,
        ingressStartedAt,
        rejectedConnections.has(incoming.socket)
      ).catch(() => undefined);
    });
    const disconnect = (): void => {
      if (handled) {
        return;
      }
      handled = true;
      recordDisconnected(collector, ingressSequence, ingressStartedAt).catch(
        () => undefined
      );
    };
    incoming.on("aborted", disconnect);
    incoming.on("error", disconnect);
    outgoing.on("error", () => undefined);
  });
  const connections = new Set<Socket>();
  const rejectedConnections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    if (connections.size >= request.limits.maxConcurrentConnectionsPerRun) {
      rejectedConnections.add(socket);
    }
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
      rejectedConnections.delete(socket);
    });
  });
  server.requestTimeout = Math.max(
    1,
    Math.min(request.limits.trialWallTimeMs, 30_000)
  );
  server.headersTimeout = server.requestTimeout;

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

  const credentialEnvironments = request.credentialEnvironments;
  const names = [
    ...credentialEnvironmentNames(request.contract),
    ...(credentialEnvironments?.values() ?? [])
  ].filter((name, index, all) => all.indexOf(name) === index);
  const instructions = syntheticCredentialInstructions(
    request.contract,
    credentialEnvironments
  );
  const indexEnabled = candidates.some(
    (candidate) => candidate.enabled && candidate.role === "index"
  );

  const serverRecord: JsonObject = {
    schema_version: 1,
    kind: "Server",
    run_id: request.runId,
    mode: request.backend === undefined ? "contract" : "scenario",
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
  const handle: RawHttpExposureHandle = {
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
      for (const socket of connections) {
        socket.destroy();
      }
      await stop(server);
    },
    get exchangeFailureCount(): number {
      return exchangeFailureTotal;
    },
    get exchangeFailures(): readonly ExposureFailureRecord[] {
      return Object.freeze([...exchangeFailures]);
    }
  };
  return handle;
}

interface ApiExchangeInput {
  readonly method: string;
  readonly target: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly collector: BodyCollector;
  readonly response: GatewayResponse;
  readonly reserved: { sequence: number; event_id: string };
  readonly ingressSequence: number;
  readonly startedAt: number;
  readonly routed: boolean;
  /** Effects this exchange committed; scenario mode only. */
  readonly committedEffects?: readonly string[];
}

/** Record one product or limit exchange as an api.exchange event. */
async function completeApiExchange(
  request: ExposureRequest,
  trace: TraceWriter,
  redactor: Redactor,
  input: ApiExchangeInput
): Promise<void> {
  const { method, target, response } = input;
  const rawPath = pathOf(target);
  const path = redactPath(rawPath, redactor);
  const query = queryOf(target);
  const bytes = input.collector.storedBytes();
  const route: RouteResult = input.routed
    ? matchRoute(request.contract.operations, method, rawPath)
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
  const redactedQuery = traceQuery(queryEntries, redactor);
  const redactedQueryString = new URLSearchParams();
  for (const parameter of redactedQuery) {
    for (const value of parameter.values) {
      redactedQueryString.append(parameter.name, value);
    }
  }
  const contentType = input.headers["content-type"];
  const complete = bytes.byteLength === input.collector.totalBytes;
  const requestSha = complete ? null : input.collector.sha256;

  const event: TraceEvent = {
    schema_version: 1,
    type: "api.exchange",
    event_id: input.reserved.event_id,
    sequence: input.reserved.sequence,
    participant_ingress_sequence: input.ingressSequence,
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
      query_string: redactedQueryString.toString(),
      query: redactedQuery,
      path_parameters: Object.fromEntries(
        Object.entries(route.match?.pathParameters ?? {}).map(
          ([name, value]) => [
            name,
            redactor.isSensitiveKey(name) || redactor.containsSecret(value)
              ? redactor.redactPathValue(value)
              : value
          ]
        )
      ),
      headers: traceHeaders(headerPairs, redactor),
      credential_present:
        input.headers["authorization"] !== undefined ||
        request.sensitiveHeaderNames.some((name) =>
          Object.keys(input.headers).some(
            (header) => header.toLowerCase() === name
          )
        ),
      content_type: typeof contentType === "string" ? contentType : null,
      body: bodyOf(
        bytes,
        redactor,
        input.collector.totalBytes,
        requestSha,
        input.collector.containsSecret
      )
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
      mode: request.backend === undefined ? "contract" : "scenario",
      name: request.backend === undefined ? null : request.backend.name,
      outcome: response.frameworkCode === null ? "handled" : "skipped",
      duration_ms: Math.max(0, request.now() - input.startedAt),
      response_provenance: provenanceClassOf(response.provenance),
      effects: [...(input.committedEffects ?? [])],
      observations: {
        approximation: response.approximation,
        provenance_detail: response.provenance
      }
    },
    response: {
      completed_at: formatRfc3339(request.now()),
      status: response.status,
      headers: traceHeaders(
        Object.entries(response.headers).map(([name, value]) => [
          name,
          [value]
        ]),
        redactor
      ),
      content_type: response.headers["content-type"] ?? null,
      body: bodyOf(Buffer.from(response.body ?? "", "utf8"), redactor)
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

/** Inputs of {@link completeFailedExchange}. */
interface FailedExchangeInput {
  readonly reserved: { sequence: number; event_id: string };
  readonly startedAt: number;
  /** Safe clock reading taken on the failure path. */
  readonly observedAt: number;
  readonly requestBytes: number;
  readonly stage: ExchangeFailureStage;
  readonly ingressSequence: number;
  /** Backend mode of the run; scenario exchanges never record contract. */
  readonly backendMode: "contract" | "scenario";
}

/**
 * Complete one reserved sequence the exposure could not finish as a
 * minimal api.exchange: the participant saw the bounded generic 500.
 * The builder reads no contract, plane, or redaction state, so a
 * failure anywhere else in the pipeline cannot stop the event stream
 * from advancing past this sequence.
 */
async function completeFailedExchange(
  request: ExposureRequest,
  trace: TraceWriter,
  input: FailedExchangeInput
): Promise<void> {
  const code = FAILURE_CODES[input.stage];
  const response = frameworkResponse(
    FRAMEWORK_ERRORS.internalError,
    sequenceId("req", input.reserved.sequence)
  );
  const event: TraceEvent = {
    schema_version: 1,
    type: "api.exchange",
    event_id: input.reserved.event_id,
    sequence: input.reserved.sequence,
    participant_ingress_sequence: input.ingressSequence,
    observed_at: formatRfc3339(input.startedAt),
    logical_time: null,
    batch_id: request.batchId,
    run_id: request.runId,
    eval_id: request.evalId,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: false,
      key: null,
      uid: null,
      operation_id: null,
      method: null,
      path_template: null,
      support: "unsupported"
    },
    request: null,
    authentication: {
      status: "unauthenticated",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: { status: "not_evaluated", violations: [] },
      response: { status: "not_evaluated", violations: [] }
    },
    backend: {
      mode: input.backendMode,
      name: null,
      outcome: "skipped",
      duration_ms: 0,
      response_provenance: "generated",
      effects: [],
      observations: {}
    },
    response: {
      completed_at: formatRfc3339(input.observedAt),
      status: response.status,
      headers: Object.entries(response.headers).map(([name, value]) => ({
        name: name.toLowerCase(),
        values: [value],
        redacted: false
      })),
      content_type: response.headers["content-type"] ?? null,
      body: bodyOf(
        Buffer.from(response.body ?? "", "utf8"),
        new Redactor({ hmacKey: Buffer.from(request.trialSeed, "utf8") })
      )
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "unavailable", reason_code: code },
    error: {
      layer: input.stage === "persist" ? "persistence" : "internal",
      code,
      message: "The exposure settled the exchange with the generic error.",
      retryable: false,
      details: {}
    },
    duration_ms: Math.max(0, input.observedAt - input.startedAt),
    resource_usage: {
      request_bytes: input.requestBytes,
      response_bytes: Buffer.byteLength(response.body ?? "", "utf8")
    },
    extensions: {}
  };
  await trace.complete(event);
}
