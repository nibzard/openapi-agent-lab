import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_KEY_FRAGMENTS,
  CREDENTIAL_KEY_PATTERN,
  isCredentialKey,
  normalizeCredentialKey
} from "./sensitive.ts";

describe("credential key-name recognition", () => {
  it("normalizes case and collapses separator runs", () => {
    expect(normalizeCredentialKey("X-Api-Key")).toBe("xapikey");
    expect(normalizeCredentialKey("X_API__KEY")).toBe("xapikey");
    expect(normalizeCredentialKey("  A p i   Key ")).toBe("apikey");
  });

  it("matches every canonical fragment after normalization", () => {
    for (const fragment of CREDENTIAL_KEY_FRAGMENTS) {
      expect(isCredentialKey(`x-${fragment}-value`), fragment).toBe(true);
      expect(isCredentialKey(fragment.toUpperCase()), fragment).toBe(true);
    }
  });

  it("matches separator runs inside a fragment", () => {
    expect(isCredentialKey("to-ken")).toBe(true);
    expect(isCredentialKey("SEC_RET")).toBe(true);
    expect(isCredentialKey("pass word")).toBe(true);
    expect(isCredentialKey("api--key")).toBe(true);
    expect(isCredentialKey("a-pi_key")).toBe(true);
  });

  it("keeps the loose compound join from the compiler pattern", () => {
    expect(isCredentialKey("apiZkey")).toBe(true);
    expect(isCredentialKey("privateXkey")).toBe(true);
    expect(isCredentialKey("sessionQid")).toBe(true);
    expect(isCredentialKey("access9key")).toBe(true);
  });

  it("keeps ordinary names insensitive", () => {
    expect(isCredentialKey("content-type")).toBe(false);
    expect(isCredentialKey("x-team")).toBe(false);
    expect(isCredentialKey("user")).toBe(false);
    expect(isCredentialKey("keyboard")).toBe(false);
    expect(isCredentialKey("monkey")).toBe(false);
    expect(isCredentialKey("zip-code")).toBe(false);
  });

  it("exposes a stateless case-insensitive pattern", () => {
    expect(CREDENTIAL_KEY_PATTERN.flags).toBe("i");
    expect(CREDENTIAL_KEY_PATTERN.test("Bearer")).toBe(false);
    expect(CREDENTIAL_KEY_PATTERN.test("SESSION_TOKEN")).toBe(true);
    // A second call must see the same result: no lastIndex is carried.
    expect(CREDENTIAL_KEY_PATTERN.test("SESSION_TOKEN")).toBe(true);
    expect(CREDENTIAL_KEY_PATTERN.test("SESSION_TOKEN")).toBe(true);
  });
});
