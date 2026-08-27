import { describe, expect, it } from "vitest";

import {
  boundPlainText,
  buildToolDescription,
  normalizePlainText,
  SERIALIZATION_GUIDANCE,
  SOURCE_TEXT_BUDGET,
  TOOL_DESCRIPTION_LIMIT,
  UNTRUSTED_LABEL
} from "./description.ts";

/** Every control character the normalizer must remove, except whitespace. */
function forbiddenControlCharacters(): Set<string> {
  return new Set(
    Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).filter(
      (char) => char !== "\n" && char !== "\t"
    )
  );
}

describe("normalizePlainText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizePlainText("  a\t\tb\n\nc  ")).toBe("a b c");
    expect(normalizePlainText("")).toBe("");
  });

  it("strips control characters", () => {
    expect(normalizePlainText("a\u0000b\u0007c")).toBe("a b c");
    expect(normalizePlainText("line\u001fbreak")).toBe("line break");
  });

  it("normalizes Unicode to composed form", () => {
    expect(normalizePlainText("café")).toBe("café");
    expect(normalizePlainText("Ｔｅｓｔ")).toBe("Test");
  });
});

describe("boundPlainText", () => {
  it("returns short text unchanged", () => {
    expect(boundPlainText("short", 10)).toEqual({
      text: "short",
      truncated: false
    });
  });

  it("cuts long text and marks the cut", () => {
    const bounded = boundPlainText("x".repeat(10), 6);
    expect(bounded).toEqual({ text: "xxx...", truncated: true });
    expect(bounded.text.length).toBe(6);
    expect(SOURCE_TEXT_BUDGET).toBe(400);
  });
});

describe("buildToolDescription", () => {
  it("places source text under the untrusted label", () => {
    const built = buildToolDescription({
      method: "POST",
      pathTemplate: "/v1/computers",
      operationId: "createComputer",
      summary: "Create   a computer",
      description: null
    });
    expect(built.sourceTextTruncated).toBe(false);
    expect(built.text).toBe(
      [
        "createComputer (POST /v1/computers)",
        SERIALIZATION_GUIDANCE,
        `${UNTRUSTED_LABEL}: Create a computer`
      ].join("\n\n")
    );
    expect(built.text.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT);
  });

  it("keeps the guidance when no source text exists", () => {
    const built = buildToolDescription({
      method: "GET",
      pathTemplate: "/health",
      operationId: null,
      summary: null,
      description: null
    });
    expect(built.text).toBe(
      ["GET /health", SERIALIZATION_GUIDANCE].join("\n\n")
    );
    expect(built.text).not.toContain(UNTRUSTED_LABEL);
  });

  it("bounds the source text and the whole description", () => {
    const built = buildToolDescription({
      method: "POST",
      pathTemplate: "/v1/computers",
      operationId: "createComputer",
      summary: "s".repeat(5000),
      description: "d".repeat(5000)
    });
    expect(built.sourceTextTruncated).toBe(true);
    expect(built.text.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT);
    expect(built.text.endsWith("...")).toBe(true);
    const forbidden = forbiddenControlCharacters();
    for (const line of built.text.split("\n")) {
      expect(line).not.toMatch(/\s{2,}/);
      expect(Array.from(line).filter((char) => forbidden.has(char))).toEqual(
        []
      );
    }
  });

  it("states the bridge-injected authentication rule", () => {
    expect(SERIALIZATION_GUIDANCE).toContain("never pass credentials");
    expect(TOOL_DESCRIPTION_LIMIT).toBe(1000);
  });
});
