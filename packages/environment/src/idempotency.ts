/**
 * The world idempotency engine (specification sections 17.3 and
 * 48.6). Pack policies name the operations that honor an idempotency
 * key, where the key rides, whose principal the cache belongs to,
 * which statuses cache, and how long an entry lives. The controller
 * consults the sealed store before behavior runs and stages the
 * committed response for recording, so a replay never re-executes the
 * operation and a rollback discards the record with the transaction.
 */

import { canonicalJson, isJsonObject, sha256Hex } from "@oal/core";
import type {
  GatewayIdempotency,
  GatewayIdempotencyDecision,
  GatewayIdempotencyQuery
} from "@oal/gateway";
import type {
  IdempotencyIdentity,
  IdempotencyPolicyOptions,
  StateStore,
  StoredResponse
} from "@oal/state-store";
import type { Json, JsonObject } from "@oal/core";

/** One pack-declared idempotency policy, parsed from the manifest. */
export interface IdempotencyPolicyRecord {
  readonly id: string;
  readonly operations: readonly string[];
  readonly keyLocation: "header" | "query";
  readonly keyName: string;
  readonly principalScope: "authenticated_principal" | "global" | "api_key";
  readonly cacheStatuses: readonly string[];
  readonly cacheFailures: boolean;
  /** Virtual-time entry lifetime; null means no expiry. */
  readonly ttlMs: number | null;
  readonly maxEntries?: number;
  readonly conflictStatus: number;
}

/**
 * Parse the manifest's idempotency policies. A manifest that declares
 * none yields an empty list; a malformed entry throws, because the
 * pack loader already schema-validated the declaration and anything
 * else is a tooling defect.
 */
export function idempotencyPoliciesOf(
  manifest: JsonObject
): IdempotencyPolicyRecord[] {
  const root = manifest["idempotency"];
  if (root === undefined || root === null) {
    return [];
  }
  if (!isJsonObject(root) || !Array.isArray(root["policies"])) {
    throw new Error("The idempotency declaration lacks a policies list.");
  }
  const policies: IdempotencyPolicyRecord[] = [];
  for (const entry of root["policies"]) {
    if (!isJsonObject(entry)) {
      throw new Error("An idempotency policy is not an object.");
    }
    const id = entry["id"];
    const operations = entry["operations"];
    const key = entry["key"];
    const principalScope = entry["principal_scope"];
    const ttl = entry["ttl"];
    const conflictStatus = entry["conflict_status"];
    if (typeof id !== "string" || !Array.isArray(operations)) {
      throw new Error("An idempotency policy lacks an id or operations.");
    }
    if (!isJsonObject(key)) {
      throw new Error(`Idempotency policy ${id} lacks a key declaration.`);
    }
    const keyLocation = key["location"];
    const keyName = key["name"];
    if (
      (keyLocation !== "header" && keyLocation !== "query") ||
      typeof keyName !== "string"
    ) {
      throw new Error(`Idempotency policy ${id} declares no usable key.`);
    }
    if (
      principalScope !== "authenticated_principal" &&
      principalScope !== "global" &&
      principalScope !== "api_key"
    ) {
      throw new Error(
        `Idempotency policy ${id} declares an unknown principal scope.`
      );
    }
    const cacheStatuses = entry["cache_statuses"];
    const cacheFailures = entry["cache_failures"];
    const maxEntries = entry["max_entries"];
    if (!Array.isArray(cacheStatuses) || typeof cacheFailures !== "boolean") {
      throw new Error(
        `Idempotency policy ${id} declares no cache status list.`
      );
    }
    if (!isJsonObject(ttl)) {
      throw new Error(`Idempotency policy ${id} declares no ttl.`);
    }
    const ttlMs =
      ttl["kind"] === "duration" && typeof ttl["ms"] === "number"
        ? ttl["ms"]
        : null;
    if (typeof conflictStatus !== "number") {
      throw new Error(`Idempotency policy ${id} declares no conflict status.`);
    }
    policies.push({
      id,
      operations: operations.filter(
        (operation): operation is string => typeof operation === "string"
      ),
      keyLocation,
      keyName,
      principalScope,
      cacheStatuses: cacheStatuses.filter(
        (pattern): pattern is string => typeof pattern === "string"
      ),
      cacheFailures,
      ttlMs,
      ...(typeof maxEntries === "number" ? { maxEntries } : {}),
      conflictStatus
    });
  }
  return policies;
}

/** Flatten stored response headers back to string values. */
function headerStrings(headers: JsonObject): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      flat[name] = value;
    }
  }
  return flat;
}

/**
 * Whether a response status matches a policy's cache pattern list.
 * Each pattern is three characters with an X wildcard, as the pack
 * schema declares ("2XX", "201").
 */
function statusMatches(status: number, patterns: readonly string[]): boolean {
  const text = status.toString(10).padStart(3, "0");
  return patterns.some((pattern) => {
    if (pattern.length !== 3) {
      return false;
    }
    for (let i = 0; i < 3; i += 1) {
      const expected = pattern[i];
      if (expected !== "X" && expected !== text[i]) {
        return false;
      }
    }
    return true;
  });
}

/**
 * The cache principal of one request. A global policy shares one
 * cache; an authenticated policy keys on the presented credential
 * value, so two principals that both verify never share entries; an
 * api_key policy keys on the presented key material. The value is
 * hashed, never stored raw.
 */
function principalKeyOf(
  policy: IdempotencyPolicyRecord,
  query: GatewayIdempotencyQuery
): string {
  if (policy.principalScope === "global") {
    return "global";
  }
  const authorization = query.headers["authorization"];
  if (authorization !== undefined && authorization.length > 0) {
    return sha256Hex(authorization);
  }
  for (const [name, value] of Object.entries(query.headers)) {
    if (name !== "authorization" && /key|token/i.test(name)) {
      return sha256Hex(`${name}:${value}`);
    }
  }
  return query.principal === null || query.principal.anonymous
    ? "anonymous"
    : `scheme:${query.principal.scheme}`;
}

/** Read the policy's idempotency key from the request, if present. */
function keyValueOf(
  policy: IdempotencyPolicyRecord,
  query: GatewayIdempotencyQuery
): string | null {
  if (policy.keyLocation === "header") {
    const value = query.headers[policy.keyName.toLowerCase()];
    return value === undefined || value.length === 0 ? null : value;
  }
  const value = query.query[policy.keyName];
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return first === undefined || first.length === 0 ? null : first;
  }
  return value.length === 0 ? null : value;
}

/** The request target without its query string. */
function normalizedPathOf(target: string): string {
  const cut = target.indexOf("?");
  return cut === -1 ? target : target.slice(0, cut);
}

/** The store options of one policy. */
function storeOptionsOf(
  policy: IdempotencyPolicyRecord
): IdempotencyPolicyOptions {
  return {
    ...(policy.ttlMs === null ? {} : { ttlMs: policy.ttlMs }),
    ...(policy.maxEntries === undefined
      ? {}
      : { maxEntries: policy.maxEntries }),
    conflictStatus: policy.conflictStatus
  };
}

/** The world's idempotency cache, backed by the sealed store. */
export class WorldIdempotency implements GatewayIdempotency {
  private pending: {
    readonly identity: IdempotencyIdentity;
    readonly requestFingerprint: string;
    readonly response: StoredResponse;
    readonly options: IdempotencyPolicyOptions;
  } | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly policies: readonly IdempotencyPolicyRecord[]
  ) {}

  /** Entries the store currently holds. */
  count(): number {
    return this.store.countIdempotencyEntries();
  }

  beforeBehavior(
    query: GatewayIdempotencyQuery
  ): GatewayIdempotencyDecision | null {
    const policy = this.policyFor(query.operationKey);
    if (policy === null) {
      return null;
    }
    const keyValue = keyValueOf(policy, query);
    if (keyValue === null) {
      return null;
    }
    const result = this.store.lookupIdempotency({
      identity: this.identityOf(policy, query, keyValue),
      requestFingerprint: this.fingerprintOf(query),
      policy: storeOptionsOf(policy),
      nowMs: this.store.clock.nowMs()
    });
    if (result.outcome === "replay" && result.response !== null) {
      return {
        kind: "replay",
        status: result.response.status,
        headers: headerStrings(result.response.headers),
        body: result.response.body
      };
    }
    if (result.outcome === "conflict") {
      return {
        kind: "conflict",
        status: result.conflictStatus ?? policy.conflictStatus
      };
    }
    // A miss or an expired entry runs the normal path; the store
    // already removed the expired row.
    return null;
  }

  stage(
    query: GatewayIdempotencyQuery,
    response: {
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: Json | undefined;
    }
  ): void {
    const policy = this.policyFor(query.operationKey);
    if (policy === null) {
      return;
    }
    const keyValue = keyValueOf(policy, query);
    if (keyValue === null) {
      return;
    }
    const cacheable =
      statusMatches(response.status, policy.cacheStatuses) ||
      (policy.cacheFailures && response.status >= 500);
    if (!cacheable) {
      return;
    }
    const headers: JsonObject = {};
    for (const [name, value] of Object.entries(response.headers)) {
      headers[name] = value;
    }
    this.pending = {
      identity: this.identityOf(policy, query, keyValue),
      requestFingerprint: this.fingerprintOf(query),
      response: {
        status: response.status,
        headers,
        body: response.body === undefined ? null : response.body
      },
      options: storeOptionsOf(policy)
    };
  }

  /**
   * Record the staged response inside the caller's commit
   * transaction. A rollback calls {@link discardPending} instead, so
   * the entry dies with the transaction.
   */
  flushPending(sequence: number): void {
    const pending = this.pending;
    if (pending === null) {
      return;
    }
    this.pending = null;
    this.store.putIdempotencyRecord({
      identity: pending.identity,
      requestFingerprint: pending.requestFingerprint,
      response: pending.response,
      sequence,
      logicalTime: this.store.clock.now(),
      policy: pending.options,
      nowMs: this.store.clock.nowMs()
    });
  }

  /** Drop the staged response; the transaction rolled back. */
  discardPending(): void {
    this.pending = null;
  }

  private policyFor(operationKey: string): IdempotencyPolicyRecord | null {
    return (
      this.policies.find((policy) =>
        policy.operations.includes(operationKey)
      ) ?? null
    );
  }

  private identityOf(
    policy: IdempotencyPolicyRecord,
    query: GatewayIdempotencyQuery,
    keyValue: string
  ): IdempotencyIdentity {
    return {
      operationKey: query.operationKey,
      principalKey: principalKeyOf(policy, query),
      normalizedPath: normalizedPathOf(query.target),
      idempotencyKey: keyValue
    };
  }

  private fingerprintOf(query: GatewayIdempotencyQuery): string {
    return canonicalJson({
      method: query.method,
      target: query.target,
      body: query.body ?? null
    });
  }
}
