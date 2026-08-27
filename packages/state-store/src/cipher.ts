/**
 * Per-run data-encryption key usage (specification section 38.1 rules).
 *
 * Domain state and replayable idempotency responses are sealed with
 * authenticated encryption before they reach SQLite, including WAL pages.
 * Idempotency key identity and normalized request identity use keyed HMACs,
 * never raw digests. The key itself is never persisted by this package; the
 * caller keeps it in the private control directory with mode 0600.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from "node:crypto";

import { isSha256Hex } from "@oal/core";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Authenticated-encryption result stored in SQLite BLOB columns. */
export interface SealedValue {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
}

/** Keyed operations available to one run. */
export interface RunSecrets {
  /** Seal raw bytes with AES-256-GCM; the tag is appended to the ciphertext. */
  seal(plaintext: Uint8Array): SealedValue;
  /** Open sealed bytes; throws when the tag or key does not match. */
  open(sealed: SealedValue): Uint8Array;
  /** Seal UTF-8 text. */
  sealText(text: string): SealedValue;
  /** Open sealed UTF-8 text. */
  openText(sealed: SealedValue): string;
  /** Keyed hex tag over a value; used where the spec forbids raw digests. */
  tag(value: string): string;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function hmac(key: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(info).digest());
}

function requireKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `Data-encryption key must be ${KEY_BYTES} bytes, got ${key.byteLength}.`
    );
  }
}

/** Generate a fresh random per-run data-encryption key. */
export function generateDataEncryptionKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

/**
 * Deterministically derive a data-encryption key from a seed digest. Use for
 * tests and local development; production runs keep an independent random key.
 */
export function deriveDataEncryptionKey(seed: string): Uint8Array {
  if (!isSha256Hex(seed)) {
    throw new Error(
      `Seed must be a lowercase 64-character SHA-256 digest, got ${JSON.stringify(seed)}.`
    );
  }
  return hmac(new Uint8Array(KEY_BYTES), `oal/dek/v1/${seed}`);
}

/** Build the keyed operations for one master key. */
export function createRunSecrets(key: Uint8Array): RunSecrets {
  requireKey(key);
  const encryptionKey = hmac(key, "oal/state-encryption/v1");
  const tagKey = hmac(key, "oal/keyed-tag/v1");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function seal(plaintext: Uint8Array): SealedValue {
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const body = concat([
      new Uint8Array(cipher.update(plaintext)),
      new Uint8Array(cipher.final())
    ]);
    return {
      ciphertext: concat([body, new Uint8Array(cipher.getAuthTag())]),
      nonce
    };
  }

  function open(sealed: SealedValue): Uint8Array {
    const { ciphertext, nonce } = sealed;
    if (nonce.byteLength !== NONCE_BYTES) {
      throw new Error(
        `Sealed nonce must be ${NONCE_BYTES} bytes, got ${nonce.byteLength}.`
      );
    }
    if (ciphertext.byteLength < TAG_BYTES) {
      throw new Error(
        "Sealed ciphertext is shorter than its authentication tag."
      );
    }
    const split = ciphertext.byteLength - TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(ciphertext.slice(split));
    try {
      return concat([
        new Uint8Array(decipher.update(ciphertext.slice(0, split))),
        new Uint8Array(decipher.final())
      ]);
    } catch (error) {
      throw new Error(
        `Sealed value failed authentication: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    seal,
    open,
    sealText(text: string): SealedValue {
      return seal(encoder.encode(text));
    },
    openText(sealed: SealedValue): string {
      return decoder.decode(open(sealed));
    },
    tag(value: string): string {
      return createHmac("sha256", tagKey).update(value, "utf8").digest("hex");
    }
  };
}
