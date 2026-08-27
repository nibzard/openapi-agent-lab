/**
 * Participant surface manifest (specification sections 9.6 and 19.3). The
 * manifest freezes everything a participant can observe: workspace files,
 * contract discovery routes, response catalogs, environment names,
 * credential shapes, tools, and adapter message kinds. Names and shapes are
 * recorded; values and secrets are never part of the document.
 */

import { readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJsonSha256,
  invalidInput,
  isJsonObject,
  sha256HexBytes,
  type Json,
  type JsonObject
} from "@oal/core";

import type { WorkspaceFilePlan } from "./prompts.ts";

/** Stable error codes of the surface module. */
export const SurfaceCode = {
  IdUnsafe: "OAL-RUN-SURFACE-ID-UNSAFE",
  EntryDuplicate: "OAL-RUN-SURFACE-ENTRY-DUPLICATE",
  DescriptorInvalid: "OAL-RUN-SURFACE-DESCRIPTOR-INVALID",
  FileMissing: "OAL-RUN-SURFACE-FILE-MISSING",
  FileUndeclared: "OAL-RUN-SURFACE-FILE-UNDECLARED",
  FileModified: "OAL-RUN-SURFACE-FILE-MODIFIED",
  FileNotRegular: "OAL-RUN-SURFACE-FILE-NOT-REGULAR",
  DigestMissing: "OAL-RUN-SURFACE-DIGEST-MISSING"
} as const;

/** Channels of the participant-surface-manifest version 1 schema. */
export type SurfaceChannel =
  | "file"
  | "http-route"
  | "environment"
  | "credential"
  | "tool"
  | "message"
  | "workspace";

/** Provenance classes of the participant-surface-manifest schema. */
export type SurfaceProvenanceClass =
  | "contractual"
  | "task_essential"
  | "treatment"
  | "framework_incidental";

/** Transformation label of the sanitized contract bundle. */
export const CONTRACT_TRANSFORMATION = "sanitized-bundle-v1";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ID_LENGTH = 128;
const GIT_DIRECTORY = ".git";

/** One contract discovery route of a documentation facade. */
export interface ContractRouteDescriptor {
  readonly method: string;
  readonly path: string;
  /** Digest of the exact bytes the route serves, when frozen. */
  readonly catalogSha256: string | null;
  readonly maxBytes: number;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

/** One frozen response catalog the participant can observe. */
export interface ResponseCatalogDescriptor {
  readonly id: string;
  readonly operationKey: string | null;
  readonly sha256: string;
  readonly maxBytes: number;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

/**
 * One environment variable name. The descriptor holds no value field, so a
 * value cannot enter the manifest by mistake.
 */
export interface EnvironmentNameDescriptor {
  readonly name: string;
  /** Where the name is declared, for example `participant.environment`. */
  readonly source: string;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

/**
 * One credential shape: scheme name and location only. The value and its
 * fingerprint are never part of the surface document.
 */
export interface CredentialShapeDescriptor {
  readonly id: string;
  readonly scheme: string;
  readonly location: string;
  readonly environmentName: string | null;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

/** One tool the exposure mode offers. */
export interface ToolDescriptor {
  readonly name: string;
  /** Digest of the tool description and schema set, when frozen. */
  readonly catalogSha256: string | null;
  readonly maxBytes: number;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

/** One adapter message kind that can reach participant context. */
export interface MessageKindDescriptor {
  readonly kind: string;
  /** Adapter that emits the message kind. */
  readonly source: string;
  readonly maxBytes: number;
  readonly provenanceClass?: SurfaceProvenanceClass;
}

export interface CompileSurfaceOptions {
  readonly cellId: string;
  readonly runId: string | null;
  /** True for the pre-localization template of specification section 9.6. */
  readonly isTemplate: boolean;
  readonly files: readonly WorkspaceFilePlan[];
  readonly contractRoutes?: readonly ContractRouteDescriptor[];
  readonly responseCatalogs?: readonly ResponseCatalogDescriptor[];
  readonly environmentNames?: readonly EnvironmentNameDescriptor[];
  readonly credentialShapes?: readonly CredentialShapeDescriptor[];
  readonly tools?: readonly ToolDescriptor[];
  readonly messageKinds?: readonly MessageKindDescriptor[];
  readonly extensions?: JsonObject;
}

export interface CompiledSurface {
  /** Document that conforms to participant-surface-manifest.v1. */
  readonly manifest: JsonObject;
  /** Digest of the canonical manifest text. */
  readonly manifestSha256: string;
}

/** One difference between the manifest and the archived workspace. */
export interface SurfaceProblem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Compile and freeze the participant surface manifest. The manifest holds
 * one entry per observable surface item. Entry identifiers derive from the
 * item name, so the same surface always yields the same manifest.
 */
export function compileSurfaceManifest(
  options: CompileSurfaceOptions
): CompiledSurface {
  const entries: JsonObject[] = [];
  const ids = new Set<string>();

  const push = (id: string, entry: JsonObject): void => {
    if (!SAFE_ID.test(id)) {
      throw invalidInput(
        SurfaceCode.IdUnsafe,
        `Surface entry identifier is not a safe id: ${id}.`,
        { id }
      );
    }
    if (ids.has(id)) {
      throw invalidInput(
        SurfaceCode.EntryDuplicate,
        `Two surface entries share the identifier ${id}.`,
        { id }
      );
    }
    ids.add(id);
    entries.push(Object.freeze({ id, ...entry }));
  };

  push("workspace-root", {
    source: "runner",
    target: ".",
    channel: "workspace",
    media_type: null,
    bytes: null,
    catalog_sha256: null,
    max_bytes: maxBytesOf(options.files),
    transformation: null,
    provenance_class: "framework_incidental"
  });

  for (const file of options.files) {
    push(`file-${slug(file.target)}`, {
      source: file.source ?? "runner",
      target: file.target,
      channel: "file",
      media_type: mediaTypeOf(file.target),
      bytes: file.bytes,
      catalog_sha256: file.sha256,
      max_bytes: Math.max(1, file.bytes),
      transformation: transformationOf(file),
      provenance_class: provenanceOf(file.origin)
    });
  }

  for (const route of options.contractRoutes ?? []) {
    push(`route-${slug(`${route.method} ${route.path}`)}`, {
      source: "documentation-facade",
      target: `${route.method} ${route.path}`,
      channel: "http-route",
      media_type: "application/json",
      bytes: null,
      catalog_sha256: route.catalogSha256,
      max_bytes: boundedMaxBytes(route.maxBytes),
      transformation: "sanitized-bundle-v1",
      provenance_class: route.provenanceClass ?? "contractual"
    });
  }

  for (const catalog of options.responseCatalogs ?? []) {
    push(`catalog-${slug(catalog.id)}`, {
      source: catalog.operationKey ?? "response-profile",
      target: catalog.operationKey ?? "response-profile",
      channel: "http-route",
      media_type: "application/json",
      bytes: null,
      catalog_sha256: catalog.sha256,
      max_bytes: boundedMaxBytes(catalog.maxBytes),
      transformation: null,
      provenance_class: catalog.provenanceClass ?? "contractual"
    });
  }

  for (const name of options.environmentNames ?? []) {
    push(`env-${slug(name.name)}`, {
      source: name.source,
      target: name.name,
      channel: "environment",
      media_type: null,
      bytes: null,
      catalog_sha256: null,
      max_bytes: 1,
      transformation: "name-only",
      provenance_class: name.provenanceClass ?? "framework_incidental"
    });
  }

  for (const credential of options.credentialShapes ?? []) {
    push(`credential-${slug(credential.id)}`, {
      source: credential.scheme,
      target: credential.environmentName ?? credential.id,
      channel: "credential",
      media_type: null,
      bytes: null,
      catalog_sha256: null,
      max_bytes: 1,
      transformation: `shape:${credential.location}`,
      provenance_class: credential.provenanceClass ?? "contractual"
    });
  }

  for (const tool of options.tools ?? []) {
    push(`tool-${slug(tool.name)}`, {
      source: "exposure",
      target: tool.name,
      channel: "tool",
      media_type: "application/json",
      bytes: null,
      catalog_sha256: tool.catalogSha256,
      max_bytes: boundedMaxBytes(tool.maxBytes),
      transformation: null,
      provenance_class: tool.provenanceClass ?? "contractual"
    });
  }

  for (const message of options.messageKinds ?? []) {
    push(`message-${slug(message.kind)}`, {
      source: message.source,
      target: message.kind,
      channel: "message",
      media_type: null,
      bytes: null,
      catalog_sha256: null,
      max_bytes: boundedMaxBytes(message.maxBytes),
      transformation: null,
      provenance_class: message.provenanceClass ?? "framework_incidental"
    });
  }

  const body: JsonObject = {
    cell_id: options.cellId,
    run_id: options.runId,
    entries: entries as Json,
    extensions: options.extensions ?? {}
  };
  const manifest: JsonObject = Object.freeze({
    schema_version: 1,
    kind: "ParticipantSurfaceManifest",
    cell_id: options.cellId,
    run_id: options.runId,
    template: options.isTemplate,
    rendered_sha256: options.isTemplate ? null : canonicalJsonSha256(body),
    entries: entries as Json,
    extensions: options.extensions ?? {}
  });
  return Object.freeze({
    manifest,
    manifestSha256: canonicalJsonSha256(manifest)
  });
}

/**
 * Compare an archived workspace directory with the manifest. Every problem
 * carries a stable code; an empty list means the archive matches the
 * declared surface. The `.git` directory of an initialized repository is
 * ignored, and non-file channels are not checked here.
 */
export async function verifySurface(
  manifest: JsonObject,
  archivedDir: string
): Promise<readonly SurfaceProblem[]> {
  const expected = new Map<string, { bytes: number | null; sha256: string }>();
  const listed = manifest["entries"];
  const entries: readonly Json[] = Array.isArray(listed) ? listed : [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      continue;
    }
    if (entry["channel"] !== "file") {
      continue;
    }
    const target = entry["target"];
    const digest = entry["catalog_sha256"];
    if (typeof target !== "string") {
      continue;
    }
    if (typeof digest !== "string") {
      expected.set(target, { bytes: null, sha256: "" });
      continue;
    }
    const bytes = entry["bytes"];
    expected.set(target, {
      bytes: typeof bytes === "number" ? bytes : null,
      sha256: digest
    });
  }

  const problems: SurfaceProblem[] = [];
  const present = new Set<string>();
  await walk(archivedDir, "", async (relative, absolute) => {
    present.add(relative);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      problems.push(notRegular(relative));
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    const entry = expected.get(relative);
    if (entry === undefined) {
      problems.push({
        code: SurfaceCode.FileUndeclared,
        path: relative,
        message: `Archived workspace holds an undeclared file: ${relative}.`
      });
      return;
    }
    if (entry.sha256 === "") {
      problems.push({
        code: SurfaceCode.DigestMissing,
        path: relative,
        message: `Manifest entry declares no digest: ${relative}.`
      });
      return;
    }
    const bytes = await readFile(absolute);
    const sha256 = sha256HexBytes(bytes);
    if (sha256 !== entry.sha256) {
      problems.push({
        code: SurfaceCode.FileModified,
        path: relative,
        message: `Archived file digest differs from the manifest: ${relative}.`
      });
      return;
    }
    if (entry.bytes !== null && bytes.byteLength !== entry.bytes) {
      problems.push({
        code: SurfaceCode.FileModified,
        path: relative,
        message: `Archived file size differs from the manifest: ${relative}.`
      });
    }
  });
  for (const [target, entry] of expected) {
    if (!present.has(target)) {
      problems.push({
        code:
          entry.sha256 === ""
            ? SurfaceCode.DigestMissing
            : SurfaceCode.FileMissing,
        path: target,
        message: `Manifest file is missing from the archive: ${target}.`
      });
    }
  }
  return problems;
}

function notRegular(relative: string): SurfaceProblem {
  return {
    code: SurfaceCode.FileNotRegular,
    path: relative,
    message: `Archived workspace entry is not a regular file: ${relative}.`
  };
}

async function walk(
  root: string,
  prefix: string,
  visit: (relative: string, absolute: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(
    prefix === "" ? root : path.join(root, prefix),
    {
      withFileTypes: true
    }
  );
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (relative === GIT_DIRECTORY) {
      continue;
    }
    await visit(relative, path.join(root, relative));
    if (entry.isDirectory()) {
      await walk(root, relative, visit);
    }
  }
}

function provenanceOf(origin: WorkspaceFilePlan["origin"]): string {
  if (origin === "contract") {
    return "contractual";
  }
  return "task_essential";
}

function transformationOf(file: WorkspaceFilePlan): string {
  if (file.origin === "contract") {
    return CONTRACT_TRANSFORMATION;
  }
  if (file.engine === null) {
    return "byte-copy";
  }
  return `render:${file.engine}`;
}

function mediaTypeOf(target: string): string | null {
  if (target.endsWith(".json")) {
    return "application/json";
  }
  if (target.endsWith(".md")) {
    return "text/markdown";
  }
  if (target.endsWith(".txt")) {
    return "text/plain";
  }
  if (target.endsWith(".yaml") || target.endsWith(".yml")) {
    return "application/yaml";
  }
  return null;
}

function maxBytesOf(files: readonly WorkspaceFilePlan[]): number {
  let total = 0;
  for (const file of files) {
    total += file.bytes;
  }
  return Math.max(1, total);
}

function boundedMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput(
      SurfaceCode.DescriptorInvalid,
      `Surface descriptor max_bytes must be a positive integer, found ${value}.`
    );
  }
  return value;
}

/** Turn any surface name into a schema-safe entry identifier fragment. */
function slug(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  return cleaned.length === 0 ? "unnamed" : cleaned.slice(0, MAX_ID_LENGTH);
}
