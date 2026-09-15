/**
 * Bounded request evidence for gateway trace records (specification
 * section 25). Binary and multipart bodies are reduced to one SHA-256
 * digest over the raw bytes plus an optional content-addressed blob
 * reference, so byte equality can be evaluated later without keeping
 * unbounded copies in the trace itself.
 */

import { sha256HexBytes } from "@oal/core";

/** Content-addressed blob storage for request evidence. */
export interface BlobStore {
  /** Store bytes once; returns the digest and blob reference. */
  put(bytes: Uint8Array): { digest: string; blob_ref: string | null };
  /** Fetch stored bytes by blob reference. */
  get(blobRef: string): Uint8Array | undefined;
}

/**
 * In-memory BlobStore with a fixed byte budget. Once the budget is
 * spent, put still returns the digest but no blob reference.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private storedBytes = 0;

  private readonly maxBytes: number;

  constructor(maxBytes = 16 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  put(bytes: Uint8Array): { digest: string; blob_ref: string | null } {
    const digest = sha256HexBytes(bytes);
    const ref = `blobs/sha256/${digest}`;
    if (this.blobs.has(ref)) {
      return { digest, blob_ref: ref };
    }
    if (this.storedBytes + bytes.length > this.maxBytes) {
      return { digest, blob_ref: null };
    }
    this.blobs.set(ref, bytes);
    this.storedBytes += bytes.length;
    return { digest, blob_ref: ref };
  }

  get(blobRef: string): Uint8Array | undefined {
    return this.blobs.get(blobRef);
  }
}

/** Digest-and-blob summary of one request body. */
export interface BodyEvidence {
  kind: "none" | "text" | "binary" | "multipart";
  size_bytes: number;
  /** SHA-256 over the raw body bytes. */
  sha256: string | null;
  blob_ref: string | null;
}

/** Reduce one request body to bounded trace evidence. */
export function captureBodyEvidence(
  bytes: Uint8Array,
  contentType: string | null,
  blobs: BlobStore | null
): BodyEvidence {
  if (bytes.length === 0) {
    return { kind: "none", size_bytes: 0, sha256: null, blob_ref: null };
  }
  const digest = sha256HexBytes(bytes);
  const stored = blobs === null ? null : blobs.put(bytes);
  return {
    kind: evidenceKind(contentType),
    size_bytes: bytes.length,
    sha256: digest,
    blob_ref: stored === null ? null : stored.blob_ref
  };
}

function evidenceKind(contentType: string | null): BodyEvidence["kind"] {
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("multipart/")) {
    return "multipart";
  }
  const textual =
    base.startsWith("text/") ||
    base === "application/x-www-form-urlencoded" ||
    base === "application/xml" ||
    base.endsWith("+xml") ||
    base === "application/json" ||
    base.endsWith("+json");
  return textual ? "text" : "binary";
}

/** One wire header with every value of its repeated lines, in order. */
export interface TraceHeader {
  /** Lowercase header name. */
  name: string;
  values: string[];
}

/**
 * Group raw wire headers by lowercase name. Values stay separate and
 * keep wire order, so duplicate header lines survive normalization.
 */
export function traceHeaders(raw: readonly string[]): TraceHeader[] {
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = (raw[index] ?? "").toLowerCase();
    const value = raw[index + 1] ?? "";
    const values = grouped.get(name);
    if (values === undefined) {
      order.push(name);
      grouped.set(name, [value]);
    } else {
      values.push(value);
    }
  }
  return order.map((name) => {
    return { name, values: grouped.get(name) ?? [] };
  });
}

/** One query parameter with every value of its repeated pairs, in order. */
export interface TraceQueryParameter {
  name: string;
  values: string[];
}

/**
 * Group query pairs of a request target by name. Values stay separate
 * and keep wire order, so duplicate query keys survive normalization.
 */
export function traceQueryParameters(target: string): TraceQueryParameter[] {
  const question = target.indexOf("?");
  if (question === -1) {
    return [];
  }
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const pair of target.slice(question + 1).split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    const name = decodeComponent(rawKey.replace(/\+/g, " "));
    const value = decodeComponent(rawValue.replace(/\+/g, " "));
    if (name === null || value === null) {
      continue;
    }
    const values = grouped.get(name);
    if (values === undefined) {
      order.push(name);
      grouped.set(name, [value]);
    } else {
      values.push(value);
    }
  }
  return order.map((name) => {
    return { name, values: grouped.get(name) ?? [] };
  });
}

function decodeComponent(component: string): string | null {
  try {
    return decodeURIComponent(component);
  } catch {
    return null;
  }
}
