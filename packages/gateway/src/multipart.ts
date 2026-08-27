/**
 * Multipart body parsing (specification section 15.3). Splits one
 * multipart body into bounded parts and enforces the parts limit from
 * the limit table; the caller answers 413 when the limit is exceeded.
 * The limit default comes from LIMIT_DEFAULTS.maxMultipartParts.
 */

export interface MultipartPart {
  /** Field name from Content-Disposition, when present. */
  name: string | null;
  filename: string | null;
  /** Part headers keyed by lowercase name. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type MultipartResult =
  | { ok: true; parts: MultipartPart[] }
  | {
      ok: false;
      code: "boundary_missing" | "parts_limit_exceeded";
      message: string;
    };

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

/** Parse a multipart body against its Content-Type boundary. */
export function parseMultipart(
  body: Uint8Array,
  contentType: string | null,
  maxParts: number
): MultipartResult {
  const boundary = boundaryOf(contentType);
  if (boundary === null) {
    return {
      ok: false,
      code: "boundary_missing",
      message: "The multipart Content-Type declares no boundary."
    };
  }
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const separator = Buffer.from("\r\n\r\n", "utf8");
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  const parts: MultipartPart[] = [];
  let cursor = bytes.indexOf(delimiter);
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    // A closing delimiter, two trailing dashes, ends the body.
    if (bytes[afterDelimiter] === DASH && bytes[afterDelimiter + 1] === DASH) {
      break;
    }
    let sectionStart = afterDelimiter;
    if (bytes[sectionStart] === CR && bytes[sectionStart + 1] === LF) {
      sectionStart += 2;
    } else if (bytes[sectionStart] === LF) {
      sectionStart += 1;
    }
    const next = bytes.indexOf(delimiter, sectionStart);
    const sectionEnd = next === -1 ? bytes.length : next;
    parts.push(parsePart(bytes.subarray(sectionStart, sectionEnd), separator));
    if (parts.length > maxParts) {
      return {
        ok: false,
        code: "parts_limit_exceeded",
        message: `The multipart body exceeds the limit of ${maxParts} parts.`
      };
    }
    cursor = next;
  }
  return { ok: true, parts };
}

/** Parse one part section: header block, then body bytes. */
function parsePart(section: Buffer, separator: Buffer): MultipartPart {
  const headerEnd = section.indexOf(separator);
  const headerBlock =
    headerEnd === -1 ? section : section.subarray(0, headerEnd);
  let body =
    headerEnd === -1
      ? section.subarray(section.length)
      : section.subarray(headerEnd + separator.length);
  // The CRLF immediately before the next delimiter is framing, not data.
  if (
    body.length >= 2 &&
    body[body.length - 2] === CR &&
    body[body.length - 1] === LF
  ) {
    body = body.subarray(0, body.length - 2);
  } else if (body.length >= 1 && body[body.length - 1] === LF) {
    body = body.subarray(0, body.length - 1);
  }
  const headers = parseHeaderBlock(headerBlock.toString("utf8"));
  const disposition = headers["content-disposition"] ?? null;
  return {
    name: disposition === null ? null : dispositionValue(disposition, "name"),
    filename:
      disposition === null ? null : dispositionValue(disposition, "filename"),
    headers,
    body
  };
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name.length > 0) {
      headers[name] = value;
    }
  }
  return headers;
}

/** Extract one `key="value"` attribute of a Content-Disposition value. */
function dispositionValue(disposition: string, key: string): string | null {
  const prefix = `${key}=`;
  for (const attribute of disposition.split(";")) {
    const trimmed = attribute.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) {
      continue;
    }
    const raw = trimmed.slice(prefix.length).trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? raw.slice(1, -1)
        : raw;
    return unquoted;
  }
  return null;
}

/** Boundary parameter of a multipart Content-Type, unquoted. */
function boundaryOf(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  for (const parameter of contentType.split(";")) {
    const trimmed = parameter.trim();
    if (!trimmed.toLowerCase().startsWith("boundary=")) {
      continue;
    }
    const raw = trimmed.slice("boundary=".length).trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? raw.slice(1, -1)
        : raw;
    if (unquoted.length > 0) {
      return unquoted;
    }
  }
  return null;
}
