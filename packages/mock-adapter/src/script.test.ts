/**
 * Validation of the mock script vocabulary.
 */

import { describe, expect, it } from "vitest";

import { validateMockScript } from "./validate.ts";
import type { MockAgentScript } from "./script.ts";

describe("validateMockScript", () => {
  it("accepts an empty script", () => {
    expect(validateMockScript({})).toEqual([]);
  });

  it("rejects a file path that escapes the workspace", () => {
    const script: MockAgentScript = {
      files: [
        { path: "../outside.txt", content: "no" },
        { path: "nested/ok.txt", content: "yes" }
      ]
    };
    expect(validateMockScript(script)).toEqual([
      "files[0].path must stay inside the workspace: ../outside.txt"
    ]);
  });

  it("rejects an absolute file path and an absolute request path", () => {
    const script: MockAgentScript = {
      files: [{ path: "/etc/passwd", content: "no" }],
      requests: [{ path: "computers" }]
    };
    expect(validateMockScript(script)).toEqual([
      "files[0].path must stay inside the workspace: /etc/passwd",
      "requests[0].path must start with a slash: computers"
    ]);
  });

  it("rejects an unknown channel and a negative delay", () => {
    const script = {
      events: [{ channel: "carrier-pigeon", text: "no", delayMs: -1 }]
    } as unknown as MockAgentScript;
    expect(validateMockScript(script)).toEqual([
      'events[0].channel must be stdout, stderr, jsonrpc, or adapter: "carrier-pigeon"',
      "events[0].delayMs must be zero or greater: -1"
    ]);
  });

  it("rejects a bad exit code and an unknown status", () => {
    const script = {
      exitCode: 1.5,
      status: "exploded"
    } as unknown as MockAgentScript;
    expect(validateMockScript(script)).toEqual([
      "exitCode must be an integer between 0 and 255: 1.5",
      'status must be a known run status: "exploded"'
    ]);
  });
});
