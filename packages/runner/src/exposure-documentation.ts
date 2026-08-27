/**
 * The documentation plane of the raw HTTP exposure (specification
 * sections 9.4, 15.1, and 15.11). One frozen inventory of conventional
 * documentation candidates is compiled before the listener answers.
 * The plane serves sanitized contract bytes or a frozen index link
 * document, keeps every response outside ContractIR routing, and never
 * emits an api.exchange event.
 */

import {
  canonicalJson,
  diagnostic,
  errorDiagnostics,
  sha256Hex,
  type Diagnostic,
  type Json
} from "@oal/core";
import type {
  ContractIR,
  OperationIR,
  OperationSecurityIR,
  SecuritySchemeIR
} from "@oal/contract-ir";
import {
  evaluateSecurity,
  FRAMEWORK_ERRORS,
  mintRunCredentials,
  problemDocument,
  type FrameworkError,
  type RunCredentials
} from "@oal/gateway";

import type { ContractVisibility } from "./preflight.ts";

/** Stable diagnostic codes of the documentation profile compiler. */
export const DocumentationCode = {
  RouteCollision: "OAL-DOCS-ROUTE-COLLISION",
  RouteDuplicate: "OAL-DOCS-ROUTE-DUPLICATE",
  RouteParameterized: "OAL-DOCS-ROUTE-PARAMETERIZED",
  RouteControlPlane: "OAL-DOCS-ROUTE-CONTROL-PLANE",
  RouteMalformed: "OAL-DOCS-ROUTE-MALFORMED",
  DocumentMissing: "OAL-DOCS-DOCUMENT-MISSING",
  DocumentTooLarge: "OAL-DOCS-DOCUMENT-TOO-LARGE"
} as const;

/** The only named route profile version 1 provides (section 9.4). */
export const OPENAPI_CONVENTIONAL_V1 = "openapi-conventional-v1" as const;

/** One candidate selector of the enablement matrix. */
export type DocumentationCandidateId = "index" | "openapi" | "wellKnown";

/** Frozen candidate of the conventional profile. */
export interface DocumentationCandidate {
  /** Enablement selector used by run options. */
  readonly id: DocumentationCandidateId;
  readonly route_id: string;
  readonly method: "GET";
  /** Absolute literal path with a leading slash and no parameters. */
  readonly path: string;
  readonly role: "contract" | "index";
  readonly enabled: boolean;
}

/** Declared authentication policy of the plane. */
export type DocumentationAuthentication = "required" | "none";

/** Compiled, frozen profile (documentation-profile.v1). */
export interface DocumentationProfile {
  readonly id: typeof OPENAPI_CONVENTIONAL_V1;
  readonly version: "1.0.0";
  readonly candidates: readonly DocumentationCandidate[];
  readonly authentication: DocumentationAuthentication;
  readonly contentType: "application/json";
  readonly headers: Readonly<Record<string, string>>;
  readonly indexLinkOrdering: "canonical";
  readonly disabledCandidateOutcome: "neutral_unknown_route";
  readonly responseProfile: "neutral-v1";
}

/**
 * The conventional candidate inventory in canonical order. The default
 * enablement serves `GET /openapi.json` only; every candidate stays
 * individually enableable.
 */
export const CONVENTIONAL_V1_CANDIDATES: readonly DocumentationCandidate[] =
  Object.freeze([
    {
      id: "index",
      route_id: "root-index",
      method: "GET",
      path: "/",
      role: "index",
      enabled: false
    },
    {
      id: "openapi",
      route_id: "openapi-json",
      method: "GET",
      path: "/openapi.json",
      role: "contract",
      enabled: true
    },
    {
      id: "wellKnown",
      route_id: "well-known-openapi-json",
      method: "GET",
      path: "/.well-known/openapi.json",
      role: "contract",
      enabled: false
    }
  ]);

/** Default enablement selectors for the conventional profile. */
export type CandidateEnablement = Partial<
  Record<DocumentationCandidateId, boolean>
>;

/**
 * Build the candidate inventory for one run. Only the discoverable
 * visibility keeps candidates enabled; every other visibility freezes
 * the same inventory with all candidates disabled so the routes stay
 * controlled discovery probes.
 */
export function conventionalCandidates(
  enablement: CandidateEnablement,
  visibility: ContractVisibility
): readonly DocumentationCandidate[] {
  return CONVENTIONAL_V1_CANDIDATES.map((candidate) => ({
    ...candidate,
    enabled:
      visibility === "discoverable" &&
      (enablement[candidate.id] ?? candidate.enabled)
  }));
}

/** Percent-decode once, collapse repeated slashes, drop one tail slash. */
export function normalizeDocumentationPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const collapsed = decoded.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/")
    ? collapsed.slice(0, -1)
    : collapsed;
}

function isControlPlanePath(path: string): boolean {
  return path === "/oal" || path.startsWith("/oal/");
}

export interface DocumentationProfileInput {
  readonly visibility: ContractVisibility;
  readonly candidates: readonly DocumentationCandidate[];
  readonly authentication: DocumentationAuthentication;
  readonly contract: ContractIR;
  /** Sanitized contract byte length, or null when none is supplied. */
  readonly documentBytes: number | null;
  readonly maxDocumentBytes: number;
}

export interface CompiledDocumentationProfile {
  readonly diagnostics: readonly Diagnostic[];
  readonly profile: DocumentationProfile | null;
}

/**
 * Compile and validate one documentation profile. Validation rejects
 * duplicate or parameterized candidates, control-plane targets, any
 * enabled candidate that collides with a declared product operation, a
 * missing sanitized document, and an oversized document. Every finding
 * is a preflight-style OAL diagnostic.
 */
export function compileDocumentationProfile(
  input: DocumentationProfileInput
): CompiledDocumentationProfile {
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>();
  for (const candidate of input.candidates) {
    if (seen.has(normalizeDocumentationPath(candidate.path))) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.RouteDuplicate,
          message: `Documentation candidate ${candidate.route_id} repeats the path of another candidate.`,
          details: { path: candidate.path }
        })
      );
    }
    seen.set(normalizeDocumentationPath(candidate.path), candidate.route_id);
    if (candidate.path.includes("{") || candidate.path.includes("}")) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.RouteParameterized,
          message: `Documentation candidate ${candidate.route_id} declares a parameterized path.`,
          details: { path: candidate.path }
        })
      );
    }
    if (!candidate.path.startsWith("/") || candidate.path.includes("?")) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.RouteMalformed,
          message: `Documentation candidate ${candidate.route_id} is not an absolute path.`,
          details: { path: candidate.path }
        })
      );
    }
    if (isControlPlanePath(candidate.path)) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.RouteControlPlane,
          message: `Documentation candidate ${candidate.route_id} targets the reserved control prefix.`,
          details: { path: candidate.path }
        })
      );
    }
    if (!candidate.enabled) {
      continue;
    }
    const collision = input.contract.operations.find(
      (operation) =>
        operation.method === candidate.method &&
        normalizeDocumentationPath(operation.path_template) ===
          normalizeDocumentationPath(candidate.path)
    );
    if (collision !== undefined) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.RouteCollision,
          message: `Documentation candidate ${candidate.route_id} collides with the declared product operation.`,
          operation_key: collision.key,
          details: {
            method: candidate.method,
            path: candidate.path,
            operation_key: collision.key
          }
        })
      );
    }
    if (candidate.role === "contract" && input.documentBytes === null) {
      diagnostics.push(
        diagnostic({
          severity: "error",
          phase: "preflight",
          code: DocumentationCode.DocumentMissing,
          message: `Documentation candidate ${candidate.route_id} is enabled without sanitized contract bytes.`,
          details: { path: candidate.path }
        })
      );
    }
  }
  if (
    input.documentBytes !== null &&
    input.documentBytes > input.maxDocumentBytes
  ) {
    diagnostics.push(
      diagnostic({
        severity: "error",
        phase: "preflight",
        code: DocumentationCode.DocumentTooLarge,
        message: "The sanitized contract exceeds the profile size ceiling.",
        details: {
          document_bytes: input.documentBytes,
          max_document_bytes: input.maxDocumentBytes
        }
      })
    );
  }
  if (errorDiagnostics(diagnostics).length > 0) {
    return { diagnostics, profile: null };
  }
  return {
    diagnostics,
    profile: {
      id: OPENAPI_CONVENTIONAL_V1,
      version: "1.0.0",
      candidates: input.candidates,
      authentication: input.authentication,
      contentType: "application/json",
      headers: {},
      indexLinkOrdering: "canonical",
      disabledCandidateOutcome: "neutral_unknown_route",
      responseProfile: "neutral-v1"
    }
  };
}

/**
 * The frozen index document. It names enabled contract candidates in
 * canonical path order and carries no other content.
 */
export function documentationIndexDocument(
  profile: DocumentationProfile
): string {
  const links = profile.candidates
    .filter((candidate) => candidate.enabled && candidate.role === "contract")
    .map((candidate) => ({ rel: "describedby", href: candidate.path }))
    .sort((left, right) =>
      left.href < right.href ? -1 : left.href > right.href ? 1 : 0
    );
  return canonicalJson({
    schema_version: 1,
    kind: "DocumentationIndex",
    profile: profile.id,
    links
  } as Json);
}

/** One serialized documentation response. */
export interface DocumentationServing {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** Authentication status of one documentation request. */
export type DocumentationAuthenticationStatus =
  | "authenticated"
  | "not_required"
  | "rejected";

/** Outcome vocabulary of documentation-event.v1. */
export type DocumentationOutcome =
  | "contract_served"
  | "index_served"
  | "rejected_authentication"
  | "neutral_unknown_route"
  | "disabled";

/** Everything the listener needs to answer and record one probe. */
export interface DocumentationResult {
  readonly serving: DocumentationServing;
  readonly candidate: DocumentationCandidate;
  readonly authenticationStatus: DocumentationAuthenticationStatus;
  readonly outcome: DocumentationOutcome;
  readonly bodySha256: string | null;
  readonly bytes: number;
}

export interface DocumentationServeInput {
  readonly method: string;
  readonly path: string;
  /** Raw request headers, as node delivers them. */
  readonly headers: Record<string, string | string[] | undefined>;
  readonly query: URLSearchParams;
  /** Correlation id of the request, from the shared ingress sequence. */
  readonly requestId: string;
}

/**
 * A bounded neutral problem response. The bytes come from the gateway's
 * own problem serializer, so the disabled-candidate shape equals the
 * paired blind treatment's unknown-route shape byte for byte.
 */
function problemServing(
  error: FrameworkError,
  requestId: string
): DocumentationServing {
  return {
    status: error.status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify(problemDocument(error, requestId))
  };
}

/** Byte length of one serving, so the record matches the wire. */
function servedBytes(serving: DocumentationServing): number {
  return Buffer.byteLength(serving.body ?? "", "utf8");
}

function syntheticSecurityOperation(
  security: OperationSecurityIR
): OperationIR {
  return {
    key: "path:GET /",
    uid: "documentation_candidate",
    surface: "path",
    method: "GET",
    path_template: "/",
    route_segments: [],
    operation_id: null,
    tool_name: "documentation_candidate",
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    servers: [],
    parameters: [],
    request_body: null,
    responses: [],
    security,
    callbacks: [],
    extensions: {},
    source_pointer: "",
    support: { level: "supported", diagnostic_codes: [] }
  };
}

/** One alternative per declared scheme; any verified scheme admits. */
function declaredSecurity(contract: ContractIR): OperationSecurityIR {
  return {
    anonymous: false,
    alternatives: Object.keys(contract.security_schemes)
      .sort()
      .map((name) => ({ schemes: [{ name, scopes: [] }] }))
  };
}

export interface DocumentationPlaneInit {
  readonly profile: DocumentationProfile;
  readonly visibility: ContractVisibility;
  readonly contract: ContractIR;
  readonly trialSeed: string;
  /** Exact sanitized localized contract bytes. */
  readonly document: string;
}

/**
 * The serving side of the documentation plane. The document, the index
 * document, and both digests are computed once, so every enabled
 * candidate answers with identical bytes for the whole run.
 */
export class DocumentationPlane {
  private readonly profile: DocumentationProfile;
  private readonly visibilityValue: ContractVisibility;
  private readonly contract: ContractIR;
  private readonly document: string;
  private readonly indexDocument: string;
  private readonly credentials: RunCredentials;
  private readonly security: OperationSecurityIR;
  readonly documentSha256: string;
  readonly indexSha256: string;

  constructor(init: DocumentationPlaneInit) {
    this.profile = init.profile;
    this.visibilityValue = init.visibility;
    this.contract = init.contract;
    this.document = init.document;
    this.indexDocument = documentationIndexDocument(init.profile);
    this.documentSha256 = sha256Hex(init.document);
    this.indexSha256 = sha256Hex(this.indexDocument);
    this.credentials = mintRunCredentials(init.contract, init.trialSeed);
    this.security = declaredSecurity(init.contract);
  }

  get candidates(): readonly DocumentationCandidate[] {
    return this.profile.candidates;
  }

  get profileId(): string {
    return this.profile.id;
  }

  get authentication(): DocumentationAuthentication {
    return this.profile.authentication;
  }

  get visibility(): ContractVisibility {
    return this.visibilityValue;
  }

  /**
   * The candidate a request addresses, or null. Candidates are GET-only;
   * HEAD rides on GET like it does on the product plane.
   */
  match(method: string, path: string): DocumentationCandidate | null {
    if (method !== "GET" && method !== "HEAD") {
      return null;
    }
    const normalized = normalizeDocumentationPath(path);
    return (
      this.profile.candidates.find(
        (candidate) => normalizeDocumentationPath(candidate.path) === normalized
      ) ?? null
    );
  }

  /**
   * Serve one matched candidate. A disabled candidate answers with the
   * neutral unknown-route shape without evaluating credentials, so the
   * response cannot leak that the route exists.
   */
  serve(
    candidate: DocumentationCandidate,
    input: DocumentationServeInput
  ): DocumentationResult {
    if (!candidate.enabled) {
      const serving = problemServing(
        FRAMEWORK_ERRORS.routeNotFound,
        input.requestId
      );
      return {
        serving,
        candidate,
        authenticationStatus: "not_required",
        outcome: "disabled",
        bodySha256: null,
        bytes: servedBytes(serving)
      };
    }
    let authenticationStatus: DocumentationAuthenticationStatus =
      "not_required";
    if (
      this.profile.authentication === "required" &&
      this.security.alternatives.length > 0
    ) {
      const outcome = evaluateSecurity(
        syntheticSecurityOperation(this.security),
        this.contract,
        {
          headers: flatHeaders(input.headers),
          query: queryOf(input.query),
          cookies: parseCookies(headerValue(input.headers, "cookie"))
        },
        this.credentials
      );
      if (!outcome.ok) {
        const serving = problemServing(
          FRAMEWORK_ERRORS.authenticationFailed,
          input.requestId
        );
        return {
          serving,
          candidate,
          authenticationStatus: "rejected",
          outcome: "rejected_authentication",
          bodySha256: null,
          bytes: servedBytes(serving)
        };
      }
      authenticationStatus = "authenticated";
    }
    const representation =
      candidate.role === "index" ? this.indexDocument : this.document;
    const digest =
      candidate.role === "index" ? this.indexSha256 : this.documentSha256;
    const bytes = Buffer.byteLength(representation, "utf8");
    const head = input.method === "HEAD";
    return {
      serving: {
        status: 200,
        headers: {
          "content-type": this.profile.contentType,
          "content-length": bytes.toString(10)
        },
        body: head ? undefined : representation
      },
      candidate,
      authenticationStatus,
      outcome: candidate.role === "index" ? "index_served" : "contract_served",
      bodySha256: digest,
      bytes
    };
  }
}

function flatHeaders(
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

function queryOf(query: URLSearchParams): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};
  for (const [name, value] of query.entries()) {
    const existing = parsed[name];
    if (existing === undefined) {
      parsed[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      parsed[name] = [existing, value];
    }
  }
  return parsed;
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

/**
 * The declared security schemes in canonical alias order. The
 * instruction renderer reads names and wire names only, never values.
 */
export function declaredSchemes(
  contract: ContractIR
): Array<{ alias: string; scheme: SecuritySchemeIR }> {
  return Object.entries(contract.security_schemes)
    .map(([alias, scheme]) => ({ alias, scheme }))
    .sort((left, right) => (left.alias < right.alias ? -1 : 1));
}
