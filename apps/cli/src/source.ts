import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  DiagnosticCode,
  infrastructure,
  invalidInput,
  resolveWithinRoot,
  sha256HexBytes,
  toOalError
} from "@oal/core";

import { UsageCode } from "./usage.ts";

/** Media types a resolved source can carry. */
export type SourceMediaType = "application/json" | "application/yaml";

export interface ResolvedSource {
  /** Absolute path of the document bytes on the local filesystem. */
  readonly entrypoint: string;
  readonly media_type: SourceMediaType;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SourceOptions {
  readonly cwd?: string;
  readonly maxBytes?: number;
  readonly stdin?: Readable;
}

const PACK_MANIFEST = "pack.yaml";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function textTooLarge(bytes: number, maxBytes: number): string {
  return `Source exceeds the ${maxBytes} byte limit (${bytes} bytes read).`;
}

/**
 * Sniff the media type from the first non-whitespace byte: "{" or "["
 * selects JSON, anything else selects YAML. Contents are not parsed.
 */
export function sniffMediaType(contents: Uint8Array): SourceMediaType {
  let start = 0;
  const bomLength =
    contents.length >= 3 &&
    contents[0] === 0xef &&
    contents[1] === 0xbb &&
    contents[2] === 0xbf
      ? 3
      : 0;
  start += bomLength;
  for (let index = start; index < contents.length; index += 1) {
    const byte = contents[index];
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
      continue;
    }
    return byte === 0x7b || byte === 0x5b
      ? "application/json"
      : "application/yaml";
  }
  return "application/yaml";
}

/** Read one stream to EOF, refusing input larger than maxBytes. */
export async function readStreamBytes(
  stream: Readable,
  maxBytes: number
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== null) {
        reject(toOalError(error));
        return;
      }
      resolve(Buffer.concat(chunks));
    };
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        finish(
          invalidInput(
            DiagnosticCode.InputTooLarge,
            textTooLarge(total, maxBytes),
            {
              bytes: total,
              max_bytes: maxBytes
            }
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      finish(null);
    });
    stream.on("error", (error: Error) => {
      finish(error);
    });
  });
}

function fromBytes(entrypoint: string, contents: Uint8Array): ResolvedSource {
  return {
    entrypoint,
    media_type: sniffMediaType(contents),
    sha256: sha256HexBytes(contents),
    bytes: contents.byteLength
  };
}

async function loadFile(
  absolutePath: string,
  maxBytes: number
): Promise<ResolvedSource> {
  const stats = await stat(absolutePath).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw toOalError(error);
  });
  if (stats === null) {
    throw invalidInput(
      DiagnosticCode.InputMissing,
      `Source file not found: ${absolutePath}`
    );
  }
  if (stats.isDirectory()) {
    const manifest = path.join(absolutePath, PACK_MANIFEST);
    const manifestStats = await stat(manifest).catch(() => null);
    if (manifestStats !== null && manifestStats.isFile()) {
      throw infrastructure(
        UsageCode.NotImplemented,
        `Pack directory sources are not implemented in this build: ${absolutePath}`
      );
    }
    throw invalidInput(
      DiagnosticCode.InputMissing,
      `Source is a directory, not an OpenAPI document: ${absolutePath}`
    );
  }
  if (!stats.isFile()) {
    throw invalidInput(
      DiagnosticCode.InputMissing,
      `Source is not a regular file: ${absolutePath}`
    );
  }
  if (stats.size > maxBytes) {
    throw invalidInput(
      DiagnosticCode.InputTooLarge,
      textTooLarge(stats.size, maxBytes),
      { bytes: stats.size, max_bytes: maxBytes }
    );
  }
  const contents = await readFile(absolutePath).catch((error: unknown) => {
    throw toOalError(error);
  });
  return fromBytes(absolutePath, contents);
}

/**
 * Resolve the "<source>" CLI argument. "-" reads standard input to EOF and
 * spools it to a private temporary file so the entrypoint stays a real
 * absolute path. File sources must exist, be regular files, and stay under
 * the byte cap. ENOENT maps to OAL-INPUT-MISSING, oversize to
 * OAL-INPUT-TOO-LARGE.
 */
export async function resolveSourceArgument(
  source: string,
  options: SourceOptions = {}
): Promise<ResolvedSource> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (source === "-") {
    const stream = options.stdin;
    if (stream === undefined) {
      throw infrastructure(
        UsageCode.StdinUnavailable,
        'Source "-" requires a readable standard input stream.'
      );
    }
    const contents = await readStreamBytes(stream, maxBytes);
    const directory = await mkdtemp(path.join(tmpdir(), "oal-stdin-"));
    const entrypoint = path.join(directory, "source");
    await writeFile(entrypoint, contents);
    return fromBytes(entrypoint, contents);
  }
  if (source.length === 0) {
    throw invalidInput(DiagnosticCode.InputMissing, "Source path is empty.");
  }
  const absolutePath = path.resolve(options.cwd ?? process.cwd(), source);
  return await loadFile(absolutePath, maxBytes);
}

/**
 * Resolve a pack-relative source member. The relative path must pass
 * assertSafeRelativePath and realpath containment inside the pack root, so
 * parent traversal and symlink escapes fail with OAL-REF-OUTSIDE-ROOT.
 */
export async function resolvePackSource(
  packRoot: string,
  relative: string,
  options: SourceOptions = {}
): Promise<ResolvedSource> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const absolutePath = await resolveWithinRoot(
    packRoot,
    relative,
    "pack source"
  );
  return await loadFile(absolutePath, maxBytes);
}
