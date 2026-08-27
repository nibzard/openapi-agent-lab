import { createHash } from "node:crypto";

import { canonicalJson, type Json } from "./json.ts";

/** Lowercase 64-character SHA-256 digest of UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 over canonical JSON bytes; the semantic digest basis. */
export function canonicalJsonSha256(value: Json): string {
  return sha256Hex(canonicalJson(value));
}

/** SHA-256 over raw bytes. */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compare two hex digests in constant time. */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}
