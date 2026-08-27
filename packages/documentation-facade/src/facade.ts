/**
 * The documentation facade (specification sections 10.2 and 25.6). It
 * serves one frozen sanitized contract through protocol-declared
 * participant routes, emits documentation exchanges, and can never reach
 * control state. It is disabled for ordinary runs unless selected.
 */

import { sha256Hex, type Json, type JsonObject } from "@oal/core";
import type { DocumentationExchange, EventStream } from "@oal/evidence";

/** One frozen route the facade answers. */
export interface FacadeRoute {
  /** Route id, for example docs.openapi. */
  id: string;
  /** Response profile, for example openapi-document. */
  profile: string;
  method: "GET" | "HEAD";
  /** Absolute path with a leading slash, no query. */
  path: string;
  contentType: string;
}

/** The conventional frozen route set (specification section 10.2). */
export const DEFAULT_ROUTES: readonly FacadeRoute[] = [
  {
    id: "docs.openapi",
    profile: "openapi-document",
    method: "GET",
    path: "/openapi.json",
    contentType: "application/json"
  }
];

export interface FacadeRequest {
  method: string;
  path: string;
  /** Whether the participant presented credentials at ingress. */
  authenticated: boolean;
  observedAt: string;
}

export interface FacadeResponse {
  status: number;
  contentType: string | null;
  /** The exact frozen bytes; identical for every request. */
  body: string | undefined;
  contentLength: number;
}

export interface DocumentationFacadeOptions {
  /** Sanitized, frozen contract document bytes. */
  document: string;
  routes?: readonly FacadeRoute[];
  /** Sink for documentation exchanges; null disables recording. */
  stream?: EventStream | null;
  /** Identifiers stamped onto recorded exchanges. */
  runId?: string;
  batchId?: string;
}

const RESERVED_PATH = new Set(["/oal", "/oal/"]);

/**
 * A frozen documentation plane. The document digest is computed once;
 * every response serves the same bytes with the same digest.
 */
export class DocumentationFacade {
  readonly routes: readonly FacadeRoute[];
  private readonly document: string;
  private readonly documentDigest: string;
  private readonly stream: EventStream | null;
  private readonly runId: string | null;
  private readonly batchId: string | null;

  constructor(options: DocumentationFacadeOptions) {
    this.document = options.document;
    this.documentDigest = sha256Hex(options.document);
    this.routes = options.routes ?? DEFAULT_ROUTES;
    this.stream = options.stream === undefined ? null : options.stream;
    this.runId = options.runId ?? null;
    this.batchId = options.batchId ?? null;
  }

  /** Digest of the frozen document served by this facade. */
  get digest(): string {
    return this.documentDigest;
  }

  /**
   * Answer one participant request. Control-plane paths are refused;
   * unknown methods and paths receive plain 404 or 405 responses. Every
   * answered or refused request is recorded as a documentation exchange.
   */
  async handle(request: FacadeRequest): Promise<FacadeResponse> {
    const response = this.respond(request);
    await this.record(request, response);
    return response;
  }

  private respond(request: FacadeRequest): FacadeResponse {
    if (RESERVED_PATH.has(request.path)) {
      return notFound();
    }
    const matching = this.routes.filter((route) => route.path === request.path);
    if (matching.length === 0) {
      return notFound();
    }
    const route = matching[0];
    const headOnGet = route?.method === "GET" && request.method === "HEAD";
    if (
      route === undefined ||
      (request.method !== route.method && !headOnGet)
    ) {
      const response = notFound();
      response.status = 405;
      response.contentType = "text/plain";
      response.body = "method not allowed";
      response.contentLength = response.body.length;
      return response;
    }
    const body = request.method === "HEAD" ? undefined : this.document;
    return {
      status: 200,
      contentType: route.contentType,
      body,
      contentLength: this.document.length
    };
  }

  private async record(
    request: FacadeRequest,
    response: FacadeResponse
  ): Promise<void> {
    if (this.stream === null) {
      return;
    }
    const route = this.routes.find((entry) => entry.path === request.path);
    const exchange: Omit<DocumentationExchange, "event_id" | "sequence"> = {
      schema_version: 1,
      type: "documentation.exchange",
      participant_ingress_sequence: null,
      observed_at: request.observedAt,
      batch_id: this.batchId,
      run_id: this.runId,
      actor: "participant",
      request: { method: request.method, path: request.path },
      candidate: {
        profile: route?.profile ?? "unknown",
        route_id: route?.id ?? "unknown"
      },
      authentication: {
        status: request.authenticated ? "authenticated" : "unauthenticated"
      },
      visibility: "declared",
      outcome:
        response.status === 200 ? "served" : `refused:${response.status}`,
      response: {
        status: response.status,
        content_type: response.contentType,
        bytes: response.contentLength,
        body_sha256: response.status === 200 ? this.documentDigest : null
      },
      duration_ms: 0,
      extensions: {} as JsonObject
    };
    const reservedStream = this.stream.reserve();
    await this.stream.complete({
      ...exchange,
      event_id: reservedStream.event_id,
      sequence: reservedStream.sequence
    } as unknown as Json & { sequence: number });
  }
}

function notFound(): FacadeResponse {
  const body = "not found";
  return {
    status: 404,
    contentType: "text/plain",
    body,
    contentLength: body.length
  };
}
