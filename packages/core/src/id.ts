import { sha256Hex } from "./digest.ts";

/**
 * Safe identifier grammar for every ID used in paths and references:
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

export function assertSafeId(value: string, what: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `${what} is not a safe identifier: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** Tool-name grammar shared by operationIds and generated tool names. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function isToolName(value: string): boolean {
  return TOOL_NAME_PATTERN.test(value);
}

const HEX = "0123456789abcdef";

function toHex(buffer: Uint8Array, start: number, count: number): string {
  let out = "";
  for (let i = start; i < start + count; i += 1) {
    const byte = buffer[i] as number;
    out += HEX[(byte >> 4) & 0xf] as string;
    out += HEX[byte & 0xf] as string;
  }
  return out;
}

function sha256Bytes(value: string): Uint8Array {
  const byteString = sha256Hex(value);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(byteString.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Operation UID: `op_` plus the first 12 lowercase hexadecimal characters of
 * SHA-256 over the UTF-8 canonical operation key.
 */
export function operationUid(operationKey: string): string {
  return `op_${toHex(sha256Bytes(operationKey), 0, 6)}`;
}

/**
 * Schema reference UID: `sch_` plus the first 12 hexadecimal characters of
 * SHA-256 over the canonical JSON of the normalized schema.
 */
export function schemaUid(canonicalSchemaJson: string): string {
  return `sch_${toHex(sha256Bytes(canonicalSchemaJson), 0, 6)}`;
}

/**
 * Domain-separated short identifier: `asg_`, `bat_`, or `run_` style prefix
 * plus the first 24 lowercase hexadecimal characters of SHA-256 over the seed
 * value (a canonical JSON string built by the caller). The full digest is
 * retained by the caller for collision checks.
 */
export function prefixedId24(prefix: string, seedValue: string): string {
  return `${prefix}${toHex(sha256Bytes(seedValue), 0, 12)}`;
}

/** Zero-padded decimal sequence used by event and request IDs. */
export function sequenceId(prefix: string, sequence: number): string {
  return `${prefix}_${sequence.toString(10).padStart(8, "0")}`;
}
