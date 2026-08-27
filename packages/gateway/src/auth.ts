/**
 * Authentication emulation (specification section 15.9). Each run mints
 * unique synthetic credentials; the gateway evaluates the declared
 * OpenAPI security expression against presented values and passes only
 * a verified principal onward. Raw credential values never reach
 * behavior state.
 */

import { canonicalJsonSha256 } from "@oal/core";
import type {
  ContractIR,
  OperationIR,
  SecuritySchemeIR
} from "@oal/contract-ir";

export interface RunCredentials {
  /** apiKey values keyed by scheme name. */
  apiKeys: Record<string, string>;
  /** HTTP Basic username and password. */
  basic: { username: string; password: string };
  /** Bearer token shared by bearer, oauth2, and openIdConnect. */
  bearer: string;
}

export interface Principal {
  /** Name of the first scheme that verified. */
  scheme: string;
  /** Granted scopes; empty for non-oauth schemes. */
  scopes: string[];
  anonymous: boolean;
}

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      code: "authentication_failed" | "authorization_failed";
      scheme: string | null;
    };

/** Credential alphabet: unmistakably synthetic, no real secrets. */
function syntheticToken(kind: string, name: string, runSeed: string): string {
  const digest = canonicalJsonSha256({ kind, name, runSeed });
  return `oal_${digest.slice(0, 24)}`;
}

/**
 * Mint the run's synthetic credentials. Deterministic in the run seed
 * so replayed runs present identical values, but unique per run.
 */
export function mintRunCredentials(
  contract: ContractIR,
  runSeed: string
): RunCredentials {
  const apiKeys: Record<string, string> = {};
  for (const [name, scheme] of Object.entries(contract.security_schemes)) {
    if (scheme.type === "apiKey") {
      apiKeys[name] = syntheticToken("apiKey", name, runSeed);
    }
  }
  return {
    apiKeys,
    basic: {
      username: syntheticToken("basic-username", "basic", runSeed),
      password: syntheticToken("basic-password", "basic", runSeed)
    },
    bearer: syntheticToken("bearer", "bearer", runSeed)
  };
}

/** Every scope any flow of the scheme declares; the dummy grant. */
export function grantedScopes(scheme: SecuritySchemeIR): string[] {
  if (scheme.flows === null) {
    return [];
  }
  const scopes = new Set<string>();
  for (const flow of Object.values(scheme.flows)) {
    for (const scope of Object.keys(flow.scopes)) {
      scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

export interface PresentedCredentials {
  /** Lowercased header name to value. */
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
}

/** Extract the credential an apiKey scheme expects from the request. */
function presentedApiKey(
  scheme: SecuritySchemeIR,
  request: PresentedCredentials
): string | null {
  if (scheme.location === null || scheme.wire_name === null) {
    return null;
  }
  switch (scheme.location) {
    case "header":
      return request.headers[scheme.wire_name.toLowerCase()] ?? null;
    case "query": {
      const value = request.query[scheme.wire_name];
      if (value === undefined) {
        return null;
      }
      if (Array.isArray(value)) {
        const first = value[0];
        return first === undefined ? null : first;
      }
      return value;
    }
    case "cookie":
      return request.cookies[scheme.wire_name] ?? null;
    case "path":
      return null;
  }
}

/** Decode a Basic authorization value to its username and password. */
function decodeBasic(
  authorization: string
): { username: string; password: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(authorization);
  if (match === null) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) {
    return null;
  }
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1)
  };
}

function verifyScheme(
  schemeName: string,
  scheme: SecuritySchemeIR,
  requiredScopes: readonly string[],
  request: PresentedCredentials,
  credentials: RunCredentials
): "verified" | "failed" | "unauthorized" | "unsupported" {
  switch (scheme.type) {
    case "apiKey": {
      const presented = presentedApiKey(scheme, request);
      const expected = credentials.apiKeys[schemeName];
      if (presented === null || expected === undefined) {
        return "failed";
      }
      return presented === expected ? "verified" : "failed";
    }
    case "http": {
      const authorization = request.headers["authorization"] ?? null;
      if (authorization === null) {
        return "failed";
      }
      if (scheme.scheme === "basic") {
        const presented = decodeBasic(authorization);
        if (presented === null) {
          return "failed";
        }
        return presented.username === credentials.basic.username &&
          presented.password === credentials.basic.password
          ? "verified"
          : "failed";
      }
      if (scheme.scheme === "bearer") {
        const match = /^Bearer\s+(.+)$/i.exec(authorization);
        return match !== null && (match[1] as string) === credentials.bearer
          ? "verified"
          : "failed";
      }
      return "unsupported";
    }
    case "oauth2":
    case "openIdConnect": {
      const match = /^Bearer\s+(.+)$/i.exec(
        request.headers["authorization"] ?? ""
      );
      if (match === null || (match[1] as string) !== credentials.bearer) {
        return "failed";
      }
      const granted = new Set(grantedScopes(scheme));
      const missing = requiredScopes.some((scope) => !granted.has(scope));
      return missing ? "unauthorized" : "verified";
    }
    case "mutualTLS":
      return "unsupported";
  }
}

/**
 * Evaluate the operation's security expression. An operation with no
 * security declaration, or one that explicitly allows anonymous
 * access, receives an anonymous principal. Otherwise every scheme of
 * one alternative must verify; a scope deficit reports 403 rather
 * than 401.
 */
export function evaluateSecurity(
  operation: OperationIR,
  contract: ContractIR,
  request: PresentedCredentials,
  credentials: RunCredentials
): AuthOutcome {
  const security = operation.security;
  if (
    security === null ||
    security.anonymous ||
    security.alternatives.length === 0
  ) {
    return {
      ok: true,
      principal: { scheme: "anonymous", scopes: [], anonymous: true }
    };
  }
  let sawUnsupported = false;
  for (const alternative of security.alternatives) {
    let schemeName: string | null = null;
    let allVerified = true;
    let scopeDeficit = false;
    for (const { name, scopes } of alternative.schemes) {
      schemeName = name;
      const scheme = contract.security_schemes[name];
      if (scheme === undefined) {
        allVerified = false;
        continue;
      }
      const verdict = verifyScheme(name, scheme, scopes, request, credentials);
      if (verdict === "failed") {
        allVerified = false;
      } else if (verdict === "unauthorized") {
        scopeDeficit = true;
        allVerified = false;
      } else if (verdict === "unsupported") {
        sawUnsupported = true;
        allVerified = false;
      }
    }
    if (allVerified && schemeName !== null) {
      const scheme = contract.security_schemes[schemeName] as SecuritySchemeIR;
      return {
        ok: true,
        principal: {
          scheme: schemeName,
          scopes: grantedScopes(scheme),
          anonymous: false
        }
      };
    }
    if (scopeDeficit) {
      return {
        ok: false,
        code: "authorization_failed",
        scheme: schemeName
      };
    }
  }
  if (sawUnsupported) {
    // Unsupported flows surface as authentication failure; the
    // capability report owns the detailed diagnostic.
    return { ok: false, code: "authentication_failed", scheme: null };
  }
  return { ok: false, code: "authentication_failed", scheme: null };
}
