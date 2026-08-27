/**
 * RFC 3339 UTC timestamp helpers. Persisted artifacts always use
 * millisecond precision ending in `Z`.
 */

const ISO_WITH_MS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

export function formatRfc3339(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function parseRfc3339(value: string): number {
  const match = ISO_WITH_MS.exec(value);
  if (match === null) {
    throw new Error(`Not an RFC 3339 UTC timestamp: ${JSON.stringify(value)}`);
  }
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    throw new Error(`Not an RFC 3339 UTC timestamp: ${JSON.stringify(value)}`);
  }
  return epochMs;
}

export function isRfc3339(value: string): boolean {
  if (ISO_WITH_MS.exec(value) === null) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Default logical epoch for the virtual clock: 2000-01-01T00:00:00.000Z. */
export const VIRTUAL_EPOCH_ISO = "2000-01-01T00:00:00.000Z";

export const VIRTUAL_EPOCH_MS = Date.parse(VIRTUAL_EPOCH_ISO);
