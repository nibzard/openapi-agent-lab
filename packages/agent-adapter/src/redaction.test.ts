import { describe, expect, it } from "vitest";

import {
  collectingSink,
  REDACTED_MARKER,
  SessionEventRecorder
} from "./events.ts";
import { createSessionRedactor, sessionSecrets } from "./redaction.ts";
import type { AgentRunContext } from "./types.ts";

/** Values shaped like the ones the runner mints for one trial. */
const BEARER = "oal_5f3a91c07d2e4b68a1c9e0b2";
const API_KEY = "oal_7b2d94f16e8a40c3b5d7f2a1";
const BASIC_PASSWORD = "oal_9c4e27d80f1a5b6c3d4e5f60";
const PROVIDER_KEY = "sk-provider-topsecret-0003";
const BASE_URL = "http://127.0.0.1:8099/api";
/** Basic username the gateway mints for an http scheme aliased
 * `internal-auth`. */
const ALIAS_BASIC_USERNAME = "oal_1a2b3c4d5e6f7a8b9c0d1e2f";
const ALIAS_BASIC_PASSWORD = "oal_0f1e2d3c4b5a69787a6b5c4d";

const CONTEXT: AgentRunContext = {
  runId: "run_000001",
  workspaceDir: "/run/workspace",
  syntheticHomeDir: "/run/home",
  temporaryDir: "/run/tmp",
  prompts: { task: "Create one computer.", launch: "launch text payload" },
  exposure: {
    mode: "raw-http",
    baseUrl: BASE_URL,
    credentialNames: [
      "OAL_AUTH_BEARER",
      "OAL_AUTH_X_API_KEY",
      "OAL_AUTH_BASIC_PASSWORD"
    ]
  },
  launcherEnvironment: {
    PATH: "/usr/bin:/bin",
    PROVIDER_KEY: PROVIDER_KEY
  },
  toolEnvironment: {
    PATH: "/usr/bin:/bin",
    OAL_BASE_URL: BASE_URL,
    OAL_AUTH_BEARER: BEARER,
    OAL_AUTH_X_API_KEY: API_KEY,
    OAL_AUTH_BASIC_PASSWORD: BASIC_PASSWORD
  },
  toolExecutionPolicy: {
    inheritEnvironment: "none",
    allowedEnvironmentNames: [],
    network: "mock-only",
    filesystem: "workspace-only"
  },
  timeoutMs: 20000
};

/**
 * Context of a contract whose only http security scheme is aliased
 * `internal-auth`. The runner declares the scheme name plus the constant
 * split names, while the tool environment carries the per-alias split names.
 */
const SPLIT_ALIAS_CONTEXT: AgentRunContext = {
  ...CONTEXT,
  exposure: {
    mode: "raw-http",
    baseUrl: BASE_URL,
    credentialNames: [
      "OAL_AUTH_BEARER",
      "OAL_AUTH_INTERNAL_AUTH",
      "OAL_AUTH_BASIC_USERNAME",
      "OAL_AUTH_BASIC_PASSWORD"
    ]
  },
  toolEnvironment: {
    OAL_AUTH_BEARER: BEARER,
    OAL_AUTH_INTERNAL_AUTH_USERNAME: ALIAS_BASIC_USERNAME,
    OAL_AUTH_INTERNAL_AUTH_PASSWORD: ALIAS_BASIC_PASSWORD
  }
};

/**
 * Context of a contract whose http scheme is aliased `basic`, so the
 * constant split names are the names the environment uses.
 */
const SPLIT_BASIC_CONTEXT: AgentRunContext = {
  ...CONTEXT,
  exposure: {
    mode: "raw-http",
    baseUrl: BASE_URL,
    credentialNames: [
      "OAL_AUTH_BEARER",
      "OAL_AUTH_BASIC",
      "OAL_AUTH_BASIC_USERNAME",
      "OAL_AUTH_BASIC_PASSWORD"
    ]
  },
  toolEnvironment: {
    OAL_AUTH_BEARER: BEARER,
    OAL_AUTH_BASIC_USERNAME: ALIAS_BASIC_USERNAME,
    OAL_AUTH_BASIC_PASSWORD: ALIAS_BASIC_PASSWORD
  }
};

describe("sessionSecrets", () => {
  it("registers declared credential names, key patterns, and shapes", () => {
    const secrets = sessionSecrets(CONTEXT);
    expect(secrets).toContain(BEARER);
    expect(secrets).toContain(API_KEY);
    expect(secrets).toContain(BASIC_PASSWORD);
    expect(secrets).toContain(PROVIDER_KEY);
  });

  it("leaves non-credential environment values out of the registry", () => {
    const secrets = sessionSecrets(CONTEXT);
    expect(secrets).not.toContain(BASE_URL);
    expect(secrets).not.toContain("/usr/bin:/bin");
  });

  it("orders longer secrets first so substrings replace last", () => {
    const secrets = sessionSecrets(CONTEXT);
    const lengths = secrets.map((value) => value.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it("registers the basic split names written under a scheme alias", () => {
    const secrets = sessionSecrets(SPLIT_ALIAS_CONTEXT);
    expect(secrets).toContain(ALIAS_BASIC_USERNAME);
    expect(secrets).toContain(ALIAS_BASIC_PASSWORD);
  });

  it("registers the constant basic split names when the alias is basic", () => {
    const secrets = sessionSecrets(SPLIT_BASIC_CONTEXT);
    expect(secrets).toContain(ALIAS_BASIC_USERNAME);
    expect(secrets).toContain(ALIAS_BASIC_PASSWORD);
  });

  it("redacts the minted basic username inside recorded events", () => {
    const collector = collectingSink();
    const recorder = new SessionEventRecorder({
      runId: "run_000001",
      adapter: "generic",
      sink: collector.sink,
      redact: createSessionRedactor(SPLIT_ALIAS_CONTEXT),
      now: () => "2026-08-27T10:00:00.000Z"
    });
    recorder.text(
      "stdout",
      `Basic user=${ALIAS_BASIC_USERNAME} password=${ALIAS_BASIC_PASSWORD}\n`
    );
    expect(collector.events[0]?.payload).toMatchObject({
      channel: "stdout",
      redacted: true,
      preview: `Basic user=${REDACTED_MARKER} password=${REDACTED_MARKER}\n`
    });
    expect(JSON.stringify(collector.events)).not.toContain(
      ALIAS_BASIC_USERNAME
    );
    expect(JSON.stringify(collector.events)).not.toContain(
      ALIAS_BASIC_PASSWORD
    );
  });
});

describe("createSessionRedactor", () => {
  it("replaces every registered credential with the marker", () => {
    const redact = createSessionRedactor(CONTEXT);
    expect(
      redact(
        `Authorization: Bearer ${BEARER} key=${API_KEY} ` +
          `password=${BASIC_PASSWORD} provider=${PROVIDER_KEY}`
      )
    ).toBe(
      `Authorization: Bearer ${REDACTED_MARKER} key=${REDACTED_MARKER} ` +
        `password=${REDACTED_MARKER} provider=${REDACTED_MARKER}`
    );
  });

  it("keeps ordinary text unchanged", () => {
    const redact = createSessionRedactor(CONTEXT);
    const text = `calling ${BASE_URL} with PATH=/usr/bin:/bin`;
    expect(redact(text)).toBe(text);
  });

  it("returns the same output for the same context and text", () => {
    const first = createSessionRedactor(CONTEXT);
    const second = createSessionRedactor(CONTEXT);
    const text = `bearer ${BEARER} and key ${API_KEY}`;
    expect(first(text)).toBe(second(text));
    expect(first(text)).toBe(first(text));
  });
});
