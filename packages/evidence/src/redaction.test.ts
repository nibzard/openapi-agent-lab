import { describe, expect, it } from "vitest";

import { Redactor, DEFAULT_KEY_PATTERNS } from "./redaction.ts";

const KEY = new Uint8Array(32).fill(7);

function redactor(secrets: string[] = []): Redactor {
  return new Redactor({ hmacKey: KEY, secrets });
}

describe("Redactor", () => {
  it("fingerprints values with a keyed HMAC prefix", () => {
    const r = redactor();
    const fingerprint = r.fingerprint("hunter2");
    expect(fingerprint).toMatch(/^hmac-sha256:[0-9a-f]{8}$/);
    expect(r.fingerprint("hunter2")).toBe(fingerprint);
    expect(r.fingerprint("hunter3")).not.toBe(fingerprint);
  });

  it("uses distinct fingerprints per key", () => {
    const other = new Redactor({ hmacKey: new Uint8Array(32).fill(9) });
    expect(other.fingerprint("hunter2")).not.toBe(
      redactor().fingerprint("hunter2")
    );
  });

  it("path fingerprints are stable and prefixed", () => {
    const r = redactor();
    expect(r.redactPathValue("acme-corp-tenant")).toMatch(
      /^path-[0-9a-f]{12}$/
    );
    expect(r.redactPathValue("acme-corp-tenant")).toBe(
      r.redactPathValue("acme-corp-tenant")
    );
  });

  it("recognizes the default key patterns", () => {
    const r = redactor();
    expect(DEFAULT_KEY_PATTERNS.length).toBeGreaterThan(5);
    expect(r.isSensitiveKey("Authorization")).toBe(true);
    expect(r.isSensitiveKey("X-Api-Key")).toBe(true);
    expect(r.isSensitiveKey("session_TOKEN")).toBe(true);
    expect(r.isSensitiveKey("content-type")).toBe(false);
  });

  it("honors configured names over patterns", () => {
    const r = new Redactor({
      hmacKey: KEY,
      config: { sensitiveHeaderNames: ["x-team-code"] }
    });
    expect(r.isSensitiveKey("X-Team-Code")).toBe(true);
    expect(r.isSensitiveName("x-team-code")).toBe(true);
  });

  it("recognizes credential shapes", () => {
    const r = redactor();
    expect(r.credentialKind("Bearer abc.def")).toBe("bearer_token");
    expect(r.credentialKind("Basic dXNlcjpwYXNz")).toBe("basic_credential");
    expect(
      r.credentialKind(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
      )
    ).toBe("private_key");
    expect(r.credentialKind("header.payload.signature-signature-long")).toBe(
      "jwt"
    );
    expect(r.credentialKind("sk-1234567890abcdef")).toBe("provider_key");
    expect(r.credentialKind("AKIA1234567890ABCDEF")).toBe("provider_key");
    expect(r.credentialKind("just text")).toBeNull();
  });

  it("redacts header values for sensitive names and secret contents", () => {
    const r = redactor(["oal_deadbeef"]);
    expect(r.redactHeaderValue("authorization", "Bearer real")).toBe(
      "[REDACTED]"
    );
    expect(r.redactHeaderValue("x-team", "oal_deadbeef")).toBe("[REDACTED]");
    expect(r.redactHeaderValue("x-team", "blue")).toBe("blue");
  });

  it("redacts registered secrets anywhere in free text", () => {
    const r = redactor(["s3cretValue"]);
    expect(r.redactText("token=s3cretValue ok")).toBe("token=[REDACTED] ok");
  });

  it("gives query values stable fingerprints for sensitive names", () => {
    const r = new Redactor({
      hmacKey: KEY,
      config: { sensitiveQueryNames: ["api_key"] }
    });
    const first = r.redactQueryValue("api_key", "abc123");
    expect(first).toMatch(/^path-[0-9a-f]{12}$/);
    expect(r.redactQueryValue("api_key", "abc123")).toBe(first);
    expect(r.redactQueryValue("api_key", "other")).not.toBe(first);
    expect(r.redactQueryValue("team", "blue")).toBe("blue");
  });

  it("redacts sensitive keys inside JSON recursively", () => {
    const r = redactor();
    const redacted = r.redactJson({
      name: "computer-1",
      api_key: "abc",
      nested: { password: "x", keep: 1 },
      items: [{ access_token: "y" }, { ok: true }]
    });
    expect(redacted).toEqual({
      name: "computer-1",
      api_key: r.redactedValue("abc", "sensitive_key"),
      nested: {
        password: r.redactedValue("x", "sensitive_key"),
        keep: 1
      },
      items: [
        { access_token: r.redactedValue("y", "sensitive_key") },
        { ok: true }
      ]
    });
  });

  it("redacts registered secret values inside JSON strings", () => {
    const r = redactor(["oal_deadbeef"]);
    expect(r.redactJson({ note: "uses oal_deadbeef today" })).toEqual({
      note: r.redactedValue("uses oal_deadbeef today", "registered_secret")
    });
  });

  it("redacts credential-shaped values by shape kind", () => {
    const r = redactor();
    const redacted = r.redactJson({ header: "Bearer abc", plain: "hi" });
    expect(redacted).toEqual({
      header: r.redactedValue("Bearer abc", "bearer_token"),
      plain: "hi"
    });
  });

  it("redacts configured JSON pointers", () => {
    const r = new Redactor({
      hmacKey: KEY,
      config: { jsonPointers: ["/owner/email"] }
    });
    expect(
      r.redactJson({ owner: { email: "a@b.c" }, public_field: "x" })
    ).toEqual({
      owner: {
        email: r.redactedValue("a@b.c", "sensitive_pointer")
      },
      public_field: "x"
    });
  });

  it("leaves numbers, booleans, and null untouched", () => {
    const r = redactor();
    expect(r.redactJson({ a: 1, b: true, c: null, d: [1, 2] })).toEqual({
      a: 1,
      b: true,
      c: null,
      d: [1, 2]
    });
  });

  it("never exposes the secret through any output path", () => {
    const secret = "oal_canary_9f1e";
    const r = redactor([secret]);
    const outputs = [
      JSON.stringify(r.redactJson({ token: secret, note: `embeds ${secret}` })),
      r.redactText(`Authorization: Bearer ${secret}`),
      r.redactHeaderValue("x-team", secret),
      r.redactCookieValue("session", secret),
      r.redactQueryValue("team", secret)
    ];
    for (const output of outputs) {
      expect(output).not.toContain(secret);
    }
  });
});
