/**
 * Validation and template engine of the mock script vocabulary.
 */

import { describe, expect, it } from "vitest";

import { validateMockScript } from "./validate.ts";
import {
  hasMalformedTemplate,
  readBodyPath,
  renderTemplate,
  renderTemplatesDeep,
  templateNamesIn,
  validateScriptTemplates,
  type MockAgentScript
} from "./script.ts";

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

describe("template engine", () => {
  it("lists variable tokens in order of appearance", () => {
    expect(templateNamesIn("/clips/{{a}}/items/{{ b }}")).toEqual(["a", "b"]);
    expect(templateNamesIn("/clips/plain")).toEqual([]);
  });

  it("flags a brace pair that opens no complete token", () => {
    expect(hasMalformedTemplate("/clips/{{clipId}}")).toBe(false);
    expect(hasMalformedTemplate("/clips/{{clipId}")).toBe(true);
    expect(hasMalformedTemplate("/clips/{{ clip id }}")).toBe(true);
    expect(hasMalformedTemplate("/clips/plain}}")).toBe(false);
  });

  it("replaces known variables and reports missing ones", () => {
    const rendered = renderTemplate("/clips/{{id}}/x/{{missing}}", {
      id: "clip_7"
    });
    expect(rendered.text).toBe("/clips/clip_7/x/{{missing}}");
    expect(rendered.missing).toEqual(["missing"]);
  });

  it("renders every string of a nested value and keeps key order", () => {
    const rendered = renderTemplatesDeep(
      { items: ["{{a}}", { id: "{{b}}" }], count: 2, kept: "literal" },
      { a: "one", b: "two" }
    );
    expect(rendered.value).toEqual({
      items: ["one", { id: "two" }],
      count: 2,
      kept: "literal"
    });
    expect(Object.keys(rendered.value as object)).toEqual([
      "items",
      "count",
      "kept"
    ]);
    expect(rendered.missing).toEqual([]);
  });

  it("collects missing variables from a nested value", () => {
    const rendered = renderTemplatesDeep({ a: ["{{x}}"], b: "{{y}}" }, {});
    expect(rendered.missing).toEqual(["x", "y"]);
  });

  it("reads dot paths and array indexes", () => {
    const body = { clip: { id: "c_1" }, items: [{ url: "u" }] };
    expect(readBodyPath(body, "clip.id")).toBe("c_1");
    expect(readBodyPath(body, "items.0.url")).toBe("u");
    expect(readBodyPath(body, "clip.missing")).toBeUndefined();
    expect(readBodyPath(body, "clip.id.deeper")).toBeUndefined();
  });

  it("reads JSON pointers with escaping", () => {
    const body = { "a/b": { "c~d": "x" }, items: [{ id: 7 }] };
    expect(readBodyPath(body, "/a~1b/c~0d")).toBe("x");
    expect(readBodyPath(body, "/items/0/id")).toBe(7);
    expect(readBodyPath(body, "/items/9/id")).toBeUndefined();
  });
});

describe("validateScriptTemplates", () => {
  it("accepts a chain that captures before it uses", () => {
    const script: MockAgentScript = {
      requests: [
        {
          path: "/v1/clips",
          method: "POST",
          capture: { body: { clipId: "id" } }
        },
        {
          path: "/v1/clips/{{clipId}}/render",
          headers: { accept: "text/markdown" }
        },
        { path: "/v1/clips", method: "POST", body: { source: "{{clipId}}" } }
      ],
      finalReport: { clip_id: "{{clipId}}" }
    };
    expect(validateScriptTemplates(script)).toEqual([]);
  });

  it("rejects a token used before it is captured, in the same step, or never", () => {
    const script: MockAgentScript = {
      requests: [
        { path: "/v1/clips/{{clipId}}", capture: { body: { clipId: "id" } } },
        { path: "/v1/clips/{{unknown}}" }
      ]
    };
    expect(validateScriptTemplates(script)).toEqual([
      "requests[0].path uses {{clipId}} but no earlier request captures it",
      "requests[1].path uses {{unknown}} but no earlier request captures it"
    ]);
  });

  it("checks header values and nested body strings with labels", () => {
    const script: MockAgentScript = {
      requests: [
        {
          path: "/v1/clips",
          headers: { "if-match": "{{etag}}" },
          body: { nested: ["{{etag}}"] }
        }
      ]
    };
    expect(validateScriptTemplates(script)).toEqual([
      "requests[0].headers[if-match] uses {{etag}} but no earlier request captures it",
      "requests[0].body.nested[0] uses {{etag}} but no earlier request captures it"
    ]);
  });

  it("rejects malformed tokens", () => {
    const script: MockAgentScript = {
      requests: [{ path: "/v1/clips/{{clipId" }]
    };
    expect(validateScriptTemplates(script)).toEqual([
      'requests[0].path contains a "{{" that opens no {{name}} token'
    ]);
  });

  it("rejects a final report variable no request captures", () => {
    const script: MockAgentScript = {
      finalReport: { clip_id: "{{clipId}}" }
    };
    expect(validateScriptTemplates(script)).toEqual([
      "finalReport.clip_id uses {{clipId}} but no earlier request captures it"
    ]);
  });

  it("rejects finalText and finalReport together", () => {
    const script: MockAgentScript = {
      finalText: "kept",
      finalReport: { ok: true }
    };
    expect(validateScriptTemplates(script)).toEqual([
      "finalText and finalReport cannot both be set"
    ]);
  });

  it("rejects bad capture names and paths", () => {
    const script = {
      requests: [
        {
          path: "/v1/clips",
          capture: {
            body: { "bad name": "id", ok: "" },
            headers: { fine: "etag" }
          }
        }
      ]
    } as unknown as MockAgentScript;
    expect(validateScriptTemplates(script)).toEqual([
      'requests[0].capture.body variable name must match [A-Za-z0-9_-]: "bad name"',
      "requests[0].capture.body[ok] must be a non-empty string"
    ]);
  });

  it("accepts an existing-shape script without any new field", () => {
    const script: MockAgentScript = {
      events: [{ channel: "stdout", text: "done" }],
      requests: [{ path: "/v1/ping", method: "GET", expectStatus: 200 }],
      finalText: '{"pinged":true}'
    };
    expect(validateScriptTemplates(script)).toEqual([]);
  });
});
