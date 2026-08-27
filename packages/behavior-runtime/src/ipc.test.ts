import { describe, expect, it } from "vitest";

import type { Body } from "@oal/behavior-api";
import { createHash } from "node:crypto";
import { decodeBody, encodeBody, parseLine } from "./ipc.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("encodeBody and decodeBody", () => {
  it("round-trips a none body", () => {
    expect(decodeBody(encodeBody({ kind: "none" }))).toEqual({ kind: "none" });
  });

  it("round-trips a json body", () => {
    const body: Body = { kind: "json", value: { count: 2 } };
    expect(decodeBody(encodeBody(body))).toEqual(body);
  });

  it("round-trips a text body", () => {
    const body: Body = {
      kind: "text",
      text: "hello",
      sizeBytes: 5,
      sha256: sha256(new TextEncoder().encode("hello"))
    };
    expect(decodeBody(encodeBody(body))).toEqual(body);
  });

  it("round-trips a binary body through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const body: Body = {
      kind: "binary",
      bytes,
      sizeBytes: 5,
      sha256: sha256(bytes)
    };
    const decoded = decodeBody(encodeBody(body));
    expect(decoded).toEqual(body);
    expect(
      decoded.kind === "binary" && decoded.bytes instanceof Uint8Array
    ).toBe(true);
  });

  it("round-trips a multipart body", () => {
    const body: Body = {
      kind: "multipart",
      parts: [
        {
          name: "file",
          headers: [{ name: "content-type", values: ["text/plain"] }],
          body: {
            kind: "text",
            text: "x",
            sizeBytes: 1,
            sha256: sha256(new TextEncoder().encode("x"))
          }
        }
      ]
    };
    expect(decodeBody(encodeBody(body))).toEqual(body);
  });

  it("is JSON-serializable on the wire", () => {
    const wire = encodeBody({
      kind: "binary",
      bytes: new Uint8Array([200, 201]),
      sizeBytes: 2,
      sha256: sha256(new Uint8Array([200, 201]))
    });
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(JSON.parse(JSON.stringify(wire)) as typeof wire).toEqual(wire);
  });
});

describe("parseLine", () => {
  it("parses a JSON line", () => {
    expect(parseLine('{"id":1,"kind":"describe"}')).toEqual({
      id: 1,
      kind: "describe"
    });
  });

  it("returns null for a blank line", () => {
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseLine("{nope")).toThrow();
  });

  it("rejects a line beyond the byte bound", () => {
    expect(() => parseLine(`{"pad":"${"x".repeat(64)}"}`, 16)).toThrow(
      /length bound/
    );
  });
});
