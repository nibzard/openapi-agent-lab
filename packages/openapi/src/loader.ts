import { readFile } from "node:fs/promises";

import { DiagnosticCode, invalidInput, resolveWithinRoot } from "@oal/core";

import type { CompilerLimits } from "./limits.ts";
import { discoverExternalRefs } from "./refs.ts";

/** A frozen set of same-pack documents keyed by root-relative POSIX path. */
export interface DocumentSet {
  readonly entrypoint: string;
  readonly documents: ReadonlyMap<string, string>;
}

export function documentSetFromRecord(
  entrypoint: string,
  documents: Readonly<Record<string, string>>
): DocumentSet {
  const map = new Map<string, string>(Object.entries(documents));
  if (!map.has(entrypoint)) {
    throw invalidInput(
      DiagnosticCode.InputMissing,
      `The entrypoint document is missing: ${entrypoint}.`,
      { entrypoint }
    );
  }
  return { entrypoint, documents: map };
}

/**
 * Read the entrypoint plus every transitively referenced regular file that
 * stays inside the canonical reference root. Symlink escape is rejected.
 */
export async function loadDocumentSet(
  rootDir: string,
  entrypoint: string,
  limits: CompilerLimits
): Promise<DocumentSet> {
  const documents = new Map<string, string>();
  const queue: string[] = [entrypoint];
  let totalBytes = 0;
  let iterations = 0;
  const maxIterations = limits.maxUniqueReferenceTargets * 2 + 16;

  while (queue.length > 0) {
    iterations += 1;
    if (iterations > maxIterations) {
      throw invalidInput(
        DiagnosticCode.RefLimit,
        "Reference document discovery exceeded the configured limit.",
        { documents: documents.size }
      );
    }
    const relative = queue.shift() as string;
    if (documents.has(relative)) {
      continue;
    }
    const absolute = await resolveWithinRoot(rootDir, relative, "document");
    const bytes = await readFile(absolute);
    if (bytes.byteLength > limits.maxSourceOpenapiBytes) {
      throw invalidInput(
        DiagnosticCode.InputTooLarge,
        `Document ${relative} exceeds the source byte limit.`,
        {
          document_uri: relative,
          bytes: bytes.byteLength,
          max_source_openapi_bytes: limits.maxSourceOpenapiBytes
        }
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxBundledDocumentBytes) {
      throw invalidInput(
        DiagnosticCode.InputTooLarge,
        "The bundled document set exceeds the configured byte limit.",
        {
          bytes: totalBytes,
          max_bundled_document_bytes: limits.maxBundledDocumentBytes
        }
      );
    }
    const text = bytes.toString("utf8");
    documents.set(relative, text);
    for (const target of discoverExternalRefs(relative, text)) {
      if (!documents.has(target)) {
        queue.push(target);
      }
    }
  }

  if (!documents.has(entrypoint)) {
    throw invalidInput(
      DiagnosticCode.InputMissing,
      `The entrypoint document is missing: ${entrypoint}.`,
      { entrypoint }
    );
  }
  return { entrypoint, documents };
}
