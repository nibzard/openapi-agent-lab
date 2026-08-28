/**
 * Content-negotiation tests for specification section 15.7. A missing
 * Accept header permits the documented default preference, so a
 * declaration that lists application/octet-stream alphabetically first
 * still serves application/json to a plain request.
 */

import { describe, expect, it } from "vitest";

import {
  negotiateResponseMedia,
  parseAccept,
  preferredMediaType
} from "./negotiate.ts";

describe("preferredMediaType", () => {
  it("prefers json, then text, then octet-stream, then lexical", () => {
    expect(
      preferredMediaType(["application/octet-stream", "application/json"])
    ).toBe("application/json");
    expect(preferredMediaType(["text/plain", "application/octet-stream"])).toBe(
      "text/plain"
    );
    expect(preferredMediaType(["application/xml", "text/csv"])).toBe(
      "application/xml"
    );
    expect(preferredMediaType([])).toBeNull();
  });

  it("matches the preference case-insensitively", () => {
    expect(preferredMediaType(["Application/JSON"])).toBe("Application/JSON");
  });
});

describe("negotiateResponseMedia", () => {
  it("serves the documented default for a missing Accept header", () => {
    expect(
      negotiateResponseMedia(
        ["application/octet-stream", "application/json"],
        null
      )
    ).toBe("application/json");
  });

  it("keeps the declared order for an Accept header without entries", () => {
    expect(
      negotiateResponseMedia(["application/xml", "application/json"], "")
    ).toBe("application/xml");
  });

  it("honors a concrete Accept header over the default preference", () => {
    expect(
      negotiateResponseMedia(
        ["application/octet-stream", "application/json"],
        "application/octet-stream"
      )
    ).toBe("application/octet-stream");
  });

  it("parses quality factors and wildcards deterministically", () => {
    expect(parseAccept("application/json;q=0.5, TEXT/PLAIN")[0]?.type).toBe(
      "text/plain"
    );
    expect(
      negotiateResponseMedia(
        ["application/octet-stream", "application/json"],
        "*/*"
      )
    ).toBe("application/json");
  });
});
