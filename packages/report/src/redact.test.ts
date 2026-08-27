import { describe, expect, it } from "vitest";

import { canonicalJson, isJsonObject, type Json } from "@oal/core";

import {
  CHAIN_OF_THOUGHT_KEY_FRAGMENTS,
  MAX_SUMMARY_DEPTH,
  MAX_SUMMARY_ENTRIES,
  MAX_SUMMARY_TEXT_LENGTH,
  REDACTED_TEXT,
  TRUNCATION_MARKER,
  containsAnySecret,
  enforceReportRedaction,
  redactSummary
} from "./redact.ts";
import { CANARY_SECRET, HMAC_KEY, scenarioReport } from "./fixtures.ts";

const CONTEXT = { hmacKey: HMAC_KEY, secrets: [CANARY_SECRET] } as const;

function asObject(value: Json): Record<string, Json> {
  if (!isJsonObject(value)) {
    throw new TypeError("expected an object");
  }
  return value;
}

describe("chain-of-thought removal", () => {
  it("drops every key that names hidden reasoning", () => {
    const input: Json = {
      plan: "keep this",
      reasoning: "drop",
      chain_of_thought: "drop",
      thinking: "drop",
      inner_thought_log: "drop"
    };
    const output = asObject(redactSummary(input));
    expect(Object.keys(output).sort()).toEqual(["plan"]);
    expect(output["plan"]).toBe("keep this");
    expect(CHAIN_OF_THOUGHT_KEY_FRAGMENTS.length).toBeGreaterThan(1);
  });

  it("removes nested reasoning keys, not only top-level ones", () => {
    const output = asObject(
      redactSummary({ turn: { thinking: "drop", text: "keep" } })
    );
    const turn = asObject(output["turn"] as Json);
    expect(Object.keys(turn)).toEqual(["text"]);
  });
});

describe("bounded summaries", () => {
  it("truncates long strings to the fixed limit", () => {
    const output = asObject(redactSummary({ note: "n".repeat(300) }));
    const note = output["note"];
    if (typeof note !== "string") {
      throw new TypeError("expected a string");
    }
    expect(note.length).toBe(MAX_SUMMARY_TEXT_LENGTH);
    expect(note.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps short strings unchanged", () => {
    const output = asObject(redactSummary({ note: "short text" }));
    expect(output["note"]).toBe("short text");
  });

  it("caps object entries and marks the loss", () => {
    const input: Record<string, Json> = {};
    for (let index = 0; index < MAX_SUMMARY_ENTRIES + 6; index += 1) {
      input[`key${index.toString(10).padStart(3, "0")}`] = index;
    }
    const output = asObject(redactSummary(input));
    const keys = Object.keys(output);
    expect(keys).toHaveLength(MAX_SUMMARY_ENTRIES + 1);
    expect(keys.slice(0, -1)).toEqual([...keys.slice(0, -1)].sort());
    expect(output["truncated"]).toBe(true);
  });

  it("stops nesting at the depth limit", () => {
    let value: Json = { leaf: "deep" };
    for (let depth = 0; depth < MAX_SUMMARY_DEPTH + 4; depth += 1) {
      value = { nested: value };
    }
    const output = redactSummary(value);
    let cursor: Json = output;
    for (let depth = 0; depth < MAX_SUMMARY_DEPTH - 1; depth += 1) {
      cursor = asObject(cursor)["nested"] as Json;
    }
    expect(asObject(cursor)["nested"]).toEqual({});
  });
});

describe("credential redaction (section 30)", () => {
  it("replaces provider-key shapes with a fingerprint", () => {
    const output = asObject(
      redactSummary(
        { provider: "sk-live-0123456789abcdef" },
        { hmacKey: HMAC_KEY }
      )
    );
    expect(output["provider"]).toEqual({
      redacted: true,
      kind: "provider_key",
      fingerprint: "hmac-sha256:f5733880"
    });
  });

  it("replaces bearer tokens and sensitive keys", () => {
    const output = asObject(
      redactSummary(
        { header: "Bearer abc123", api_token: "plain value" },
        { hmacKey: HMAC_KEY }
      )
    );
    expect(output["header"]).toEqual({
      redacted: true,
      kind: "bearer_token",
      fingerprint: "hmac-sha256:655277bd"
    });
    expect(output["api_token"]).toEqual({
      redacted: true,
      kind: "sensitive_key",
      fingerprint: "hmac-sha256:e2919899"
    });
  });

  it("replaces registered secrets inside free text", () => {
    const output = asObject(
      redactSummary({ note: `prefix ${CANARY_SECRET} suffix` }, CONTEXT)
    );
    expect(output["note"]).toEqual({
      redacted: true,
      kind: "registered_secret",
      fingerprint: "hmac-sha256:c5c5db76"
    });
  });

  it("keeps plain values when no context is supplied", () => {
    const output = asObject(redactSummary({ api_token: "plain value" }));
    expect(output["api_token"]).toBe("plain value");
  });
});

describe("final report redaction", () => {
  it("enforceReportRedaction replaces secret occurrences in any string", () => {
    const document = {
      outer: [`prefix ${CANARY_SECRET} suffix`],
      nested: { key: CANARY_SECRET },
      number: 7
    };
    const redacted = enforceReportRedaction(document, [CANARY_SECRET]);
    expect(redacted).toEqual({
      outer: [`prefix ${REDACTED_TEXT} suffix`],
      nested: { key: REDACTED_TEXT },
      number: 7
    });
  });

  it("returns the document untouched when no secrets are registered", () => {
    const document = { key: "value" };
    expect(enforceReportRedaction(document, [])).toEqual(document);
  });

  it("containsAnySecret reports the leaked secret", () => {
    const text = canonicalJson({ note: `leak ${CANARY_SECRET}` });
    expect(containsAnySecret(text, [CANARY_SECRET])).toBe(CANARY_SECRET);
    expect(
      containsAnySecret(canonicalJson({ note: "clean" }), [CANARY_SECRET])
    ).toBeNull();
  });
});

describe("privacy of the built report", () => {
  const report = scenarioReport();

  it("carries no registered secret anywhere in its canonical JSON", () => {
    const text = canonicalJson(report as unknown as Json);
    expect(containsAnySecret(text, [CANARY_SECRET])).toBeNull();
  });

  it("carries no hidden chain of thought", () => {
    const text = canonicalJson(report as unknown as Json);
    expect(text.includes("hidden chain of thought")).toBe(false);
    expect(text.includes("reasoning")).toBe(false);
  });

  it("redacts the final-state summary surfaces", () => {
    const finalStates = report.surfaces.final_states ?? [];
    expect(finalStates).toHaveLength(1);
    const summary = asObject(finalStates[0]?.summary as Json);
    expect(Object.keys(summary)).toEqual(["api_token", "computer_id", "note"]);
    expect(summary["api_token"]).toEqual({
      redacted: true,
      kind: "sensitive_key",
      fingerprint: "hmac-sha256:9a5216e5"
    });
    const note = summary["note"];
    if (typeof note !== "string") {
      throw new TypeError("expected a string");
    }
    expect(note.length).toBe(MAX_SUMMARY_TEXT_LENGTH);
    expect(note.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("fingerprints the same value identically across builds", () => {
    const second = scenarioReport();
    const firstStates = report.surfaces.final_states ?? [];
    const secondStates = second.surfaces.final_states ?? [];
    expect(secondStates[0]?.summary).toEqual(firstStates[0]?.summary);
  });
});
