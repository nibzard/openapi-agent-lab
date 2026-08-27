import { describe, expect, it } from "vitest";

import { LIMIT_DEFAULTS } from "@oal/config";
import { parseMultipart } from "./multipart.ts";

const BOUNDARY = "oal_boundary";

function frame(
  parts: Array<{ headers: string[]; body: Uint8Array }>
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encoder.encode(`--${BOUNDARY}\r\n`));
    for (const header of part.headers) {
      chunks.push(encoder.encode(`${header}\r\n`));
    }
    chunks.push(encoder.encode("\r\n"));
    chunks.push(part.body);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const wire = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    wire.set(chunk, offset);
    offset += chunk.length;
  }
  return wire;
}

describe("multipart parsing", () => {
  it("parses names, filenames, headers, and exact body bytes", () => {
    const binary = new Uint8Array([0x00, 0x01, 0x0d, 0x0a, 0xff, 0x7f]);
    const result = parseMultipart(
      frame([
        {
          headers: [
            'Content-Disposition: form-data; name="payload"; filename="data.bin"',
            "Content-Type: application/octet-stream"
          ],
          body: binary
        },
        {
          headers: ['Content-Disposition: form-data; name="note"'],
          body: new TextEncoder().encode("line one\r\nline two")
        }
      ]),
      `multipart/form-data; boundary=${BOUNDARY}`,
      LIMIT_DEFAULTS.maxMultipartParts
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.parts).toHaveLength(2);
    const [payload, note] = result.parts;
    expect(payload?.name).toBe("payload");
    expect(payload?.filename).toBe("data.bin");
    expect(payload?.headers["content-type"]).toBe("application/octet-stream");
    // CRLF inside a part body is data and survives framing.
    const empty = new Uint8Array(0);
    expect(Buffer.from(payload?.body ?? empty)).toEqual(Buffer.from(binary));
    expect(note?.name).toBe("note");
    expect(note?.filename).toBeNull();
    expect(new TextDecoder().decode(note?.body ?? empty)).toBe(
      "line one\r\nline two"
    );
  });

  it("fails once the parts limit is exceeded", () => {
    const one = frame([
      {
        headers: ['Content-Disposition: form-data; name="a"'],
        body: new Uint8Array(0)
      }
    ]);
    const two = frame([
      {
        headers: ['Content-Disposition: form-data; name="a"'],
        body: new Uint8Array(0)
      },
      {
        headers: ['Content-Disposition: form-data; name="b"'],
        body: new Uint8Array(0)
      }
    ]);
    const type = `multipart/form-data; boundary=${BOUNDARY}`;
    expect(parseMultipart(one, type, 1).ok).toBe(true);
    const over = parseMultipart(two, type, 1);
    expect(over.ok).toBe(false);
    if (over.ok) {
      return;
    }
    expect(over.code).toBe("parts_limit_exceeded");
    expect(over.message).toContain("limit of 1");
  });

  it("fails when the boundary parameter is missing", () => {
    const result = parseMultipart(new Uint8Array(1), "multipart/form-data", 10);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("boundary_missing");
  });
});
