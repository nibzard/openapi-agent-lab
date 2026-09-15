/**
 * Evidence store layout and artifact manifests (specification
 * section 24). The store enforces write-once inputs, append-only
 * streams, atomic final writes, content-addressed blobs, and
 * non-self-referential manifests with recursive verification.
 */

import { createHash } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  lstat,
  open,
  readlink,
  readdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import {
  assertSafeRelativePath,
  canonicalJson,
  isSafeId,
  isSha256Hex,
  sha256HexBytes,
  type Json
} from "@oal/core";
import { JsonlSink } from "./trace.ts";

export const EVIDENCE_COMPONENT = "@oal/evidence";
export const EVIDENCE_VERSION = "0.1.0";

export const MANIFEST_NAME = "artifact-manifest.json";
const COMPLETION_POINTERS: ReadonlySet<string> = new Set([
  "run.completed.json",
  "batch.completed.json",
  "study.completed.json"
]);

/** Operator-only subtree; entries there carry sensitivity "operator". */
const OPERATOR_DIR = "operator";
const SENSITIVE_DIRS: ReadonlySet<string> = new Set(["operator", "session"]);

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  media_type: string;
  producer: { component: string; version: string };
  sensitivity: "redacted" | "operator" | "sensitive" | "public";
  child_manifest?: boolean;
  /** A symlink is recorded as inert metadata. Verification never follows it. */
  entry_type?: "file" | "symlink";
  /** The literal link target for an inert symlink entry. */
  link_target?: string;
}

export interface ArtifactManifest {
  schema_version: 1;
  kind: "ArtifactManifest";
  scope: {
    level: "trial" | "batch" | "study";
    id: string;
    run_id: string | null;
    batch_id: string | null;
    study_run_id: string | null;
  };
  created_at: string;
  entries: ManifestEntry[];
}

export interface BatchLayout {
  root: string;
  inputsDir: string;
  trialsDir: string;
}

export interface TrialLayout {
  root: string;
  sessionDir: string;
  workspaceDir: string;
  blobsDir: string;
  operatorDir: string;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".ndjson": "application/x-ndjson",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".sqlite": "application/vnd.sqlite3",
  ".xml": "application/xml"
};

function mediaTypeFor(path: string): string {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  return MEDIA_TYPES[name.slice(dot)] ?? "application/octet-stream";
}

function sensitivityFor(relativePath: string): ManifestEntry["sensitivity"] {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "state.sqlite") {
    return "sensitive";
  }
  for (const dir of SENSITIVE_DIRS) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) {
      return normalized.startsWith(`${OPERATOR_DIR}/`)
        ? "operator"
        : "redacted";
    }
  }
  return "redacted";
}

/**
 * The evidence store rooted at .oal/runs (batches) or .oal/studies
 * (study runs). All paths passed in are relative to the root and
 * must stay inside it.
 */
export class ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  batchLayout(batchId: string): BatchLayout {
    return {
      root: this.resolve(`runs/${batchId}`),
      inputsDir: this.resolve(`runs/${batchId}/inputs`),
      trialsDir: this.resolve(`runs/${batchId}/trials`)
    };
  }

  trialLayout(batchId: string, runId: string): TrialLayout {
    const base = `runs/${batchId}/trials/${runId}`;
    return {
      root: this.resolve(base),
      sessionDir: this.resolve(`${base}/session`),
      workspaceDir: this.resolve(`${base}/workspace`),
      blobsDir: this.resolve(`${base}/blobs/sha256`),
      operatorDir: this.resolve(`${base}/operator`)
    };
  }

  resolve(relativePath: string): string {
    assertSafeRelativePath(relativePath, "artifact path");
    return join(this.root, relativePath);
  }

  /** Create the batch directory tree (section 24.1). */
  async initBatch(batchId: string): Promise<BatchLayout> {
    requireId(batchId, "batch id");
    const layout = this.batchLayout(batchId);
    await mkdir(layout.inputsDir, { recursive: true });
    await mkdir(layout.trialsDir, { recursive: true });
    return layout;
  }

  /** Create the trial directory tree (section 24.1). */
  async initTrial(batchId: string, runId: string): Promise<TrialLayout> {
    requireId(batchId, "batch id");
    requireId(runId, "run id");
    const layout = this.trialLayout(batchId, runId);
    await mkdir(layout.sessionDir, { recursive: true });
    await mkdir(layout.workspaceDir, { recursive: true });
    await mkdir(layout.blobsDir, { recursive: true });
    await mkdir(layout.operatorDir, { recursive: true });
    return layout;
  }

  /** Write-once: fails when the target already exists. */
  async writeOnce(relativePath: string, content: string): Promise<void> {
    const target = this.resolve(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  /** Atomic write: temporary file, then rename (section 24.3). */
  async atomicWrite(relativePath: string, content: string): Promise<void> {
    const target = this.resolve(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid.toString(16)}`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  }

  /** Open an append-only JSONL stream. */
  async openSink(relativePath: string): Promise<JsonlSink> {
    return JsonlSink.open(this.resolve(relativePath));
  }

  /** Read a stored artifact as UTF-8 text. */
  async read(relativePath: string): Promise<string> {
    return readFile(this.resolve(relativePath), "utf8");
  }

  /**
   * Content-addressed, exclusive blob write. The same content maps to
   * the same path, so writes deduplicate naturally.
   */
  async putBlob(
    relativeDir: string,
    bytes: Uint8Array
  ): Promise<{ digest: string; path: string }> {
    const digest = sha256HexBytes(bytes);
    const blobPath = `${relativeDir}/${digest}`;
    const target = this.resolve(blobPath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await openExclusive(target);
    if (handle !== null) {
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    return { digest, path: blobPath };
  }

  /**
   * Write the non-self-referential manifest for one scope. Covers
   * every payload below the scope directory except the manifest
   * itself, completion pointers, and any file the caller marks as a
   * completion-time writer.
   */
  async writeManifest(options: {
    scopeDir: string;
    level: "trial" | "batch" | "study";
    id: string;
    runId?: string;
    batchId?: string;
    studyRunId?: string;
    createdAt: string;
  }): Promise<ArtifactManifest> {
    const entries: ManifestEntry[] = [];
    await this.collectEntries(options.scopeDir, "", entries);
    entries.sort((left, right) => (left.path < right.path ? -1 : 1));
    const manifest: ArtifactManifest = {
      schema_version: 1,
      kind: "ArtifactManifest",
      scope: {
        level: options.level,
        id: options.id,
        run_id: options.runId ?? null,
        batch_id: options.batchId ?? null,
        study_run_id: options.studyRunId ?? null
      },
      created_at: options.createdAt,
      entries
    };
    const manifestPath = posix.join(toPosix(options.scopeDir), MANIFEST_NAME);
    await this.atomicWrite(
      manifestPath,
      `${canonicalJson(manifest as unknown as Json)}\n`
    );
    return manifest;
  }

  private async collectEntries(
    scopeDir: string,
    prefix: string,
    entries: ManifestEntry[]
  ): Promise<void> {
    const absolute = this.resolve(
      prefix.length === 0 ? scopeDir : `${scopeDir}/${prefix}`
    );
    const children = await readdir(absolute, { withFileTypes: true });
    for (const child of children) {
      if (child.name.includes(".tmp-") || child.name.endsWith(".tmp")) {
        continue;
      }
      const relative =
        prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        await this.collectEntries(scopeDir, relative, entries);
        continue;
      }
      const atScopeRoot = prefix.length === 0;
      if (
        atScopeRoot &&
        (child.name === MANIFEST_NAME || COMPLETION_POINTERS.has(child.name))
      ) {
        continue;
      }
      if (child.isSymbolicLink()) {
        const linkTarget = await readlink(join(absolute, child.name));
        const bytes = Buffer.from(linkTarget, "utf8");
        entries.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          media_type: "application/vnd.oal.symlink",
          producer: {
            component: EVIDENCE_COMPONENT,
            version: EVIDENCE_VERSION
          },
          sensitivity: sensitivityFor(relative),
          entry_type: "symlink",
          link_target: linkTarget
        });
        continue;
      }
      const bytes = await readFile(join(absolute, child.name));
      entries.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        media_type: mediaTypeFor(child.name),
        producer: { component: EVIDENCE_COMPONENT, version: EVIDENCE_VERSION },
        sensitivity: sensitivityFor(relative),
        entry_type: "file",
        child_manifest: child.name === MANIFEST_NAME
      });
    }
  }

  /**
   * Verify one scope from its completion pointer. The pointer names
   * the finalized manifest; every referenced leaf and child manifest
   * digest must match on disk (section 24.4).
   */
  async verify(pointerPath: string): Promise<VerificationResult> {
    const pointerText = await this.read(pointerPath).catch(() => null);
    if (pointerText === null) {
      return { ok: false, problems: ["completion pointer is missing"] };
    }
    let pointer: {
      manifest_path?: string;
      manifest_sha256?: string;
      artifact_manifest_sha256?: string;
    };
    try {
      pointer = JSON.parse(pointerText) as typeof pointer;
    } catch {
      return { ok: false, problems: ["completion pointer is not valid JSON"] };
    }
    const problems: string[] = [];
    if (typeof pointer.manifest_path !== "string") {
      return {
        ok: false,
        problems: ["completion pointer has no manifest_path"]
      };
    }
    const pointerDigest =
      pointer.manifest_sha256 ?? pointer.artifact_manifest_sha256;
    if (!isSha256Hex(pointerDigest ?? "")) {
      problems.push("completion pointer has no manifest_sha256 digest");
    }
    const manifestText = await this.read(pointer.manifest_path).catch(
      () => null
    );
    if (manifestText === null) {
      return { ok: false, problems: [...problems, "manifest is missing"] };
    }
    const actualDigest = createHash("sha256")
      .update(manifestText)
      .digest("hex");
    if (pointerDigest !== actualDigest) {
      problems.push("manifest digest does not match the completion pointer");
    }
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifestText) as unknown;
    } catch {
      return {
        ok: false,
        problems: [...problems, "artifact manifest is not valid JSON"]
      };
    }
    if (
      !isUnknownRecord(parsedManifest) ||
      parsedManifest["schema_version"] !== 1 ||
      parsedManifest["kind"] !== "ArtifactManifest" ||
      !Array.isArray(parsedManifest["entries"])
    ) {
      return {
        ok: false,
        problems: [...problems, "artifact manifest has an invalid schema"]
      };
    }
    const manifestEntries = parsedManifest["entries"];
    const scopeDir = posix.dirname(toPosix(pointer.manifest_path));
    for (const rawEntry of manifestEntries) {
      if (!isUnknownRecord(rawEntry)) {
        problems.push("artifact manifest contains an invalid entry");
        continue;
      }
      const entry = {
        path: rawEntry["path"],
        bytes: rawEntry["bytes"],
        sha256: rawEntry["sha256"],
        entry_type: rawEntry["entry_type"],
        link_target: rawEntry["link_target"]
      };
      if (
        typeof entry.path !== "string" ||
        typeof entry.bytes !== "number" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        typeof entry.sha256 !== "string" ||
        !isSha256Hex(entry.sha256)
      ) {
        problems.push("artifact manifest contains an invalid entry");
        continue;
      }
      try {
        assertSafeRelativePath(entry.path, "manifest entry path");
      } catch {
        problems.push(`${entry.path} is not a safe manifest path`);
        continue;
      }
      let entryPath: string;
      try {
        entryPath = this.resolve(`${scopeDir}/${entry.path}`);
      } catch {
        problems.push(`${entry.path} escapes the artifact store`);
        continue;
      }
      const entryStats = await lstat(entryPath).catch(() => null);
      if (entryStats === null) {
        problems.push(`${entry.path} is missing`);
        continue;
      }
      if (entry.entry_type === "symlink") {
        if (!entryStats.isSymbolicLink()) {
          problems.push(`${entry.path} is not the recorded symlink`);
          continue;
        }
        const linkTarget = await readlink(entryPath);
        if (
          typeof entry.link_target !== "string" ||
          linkTarget !== entry.link_target
        ) {
          problems.push(`${entry.path} link target mismatch`);
        }
        const bytes = Buffer.from(linkTarget, "utf8");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== entry.sha256) {
          problems.push(`${entry.path} digest mismatch`);
        }
        if (bytes.length !== entry.bytes) {
          problems.push(`${entry.path} size mismatch`);
        }
        continue;
      }
      if (!entryStats.isFile()) {
        problems.push(`${entry.path} is not a regular file`);
        continue;
      }
      const bytes = await readFile(entryPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.sha256) {
        problems.push(`${entry.path} digest mismatch`);
      }
      if (bytes.length !== entry.bytes) {
        problems.push(`${entry.path} size mismatch`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  /** Whether a target path already exists. */
  async exists(relativePath: string): Promise<boolean> {
    const target = this.resolve(relativePath);
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}

/** Open exclusively; an existing target yields null (deduplicated). */
async function openExclusive(target: string): Promise<FileHandle | null> {
  try {
    return await open(target, "wx");
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return null;
    }
    throw error;
  }
}

export interface VerificationResult {
  ok: boolean;
  problems: string[];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function requireId(value: string, what: string): void {
  if (!isSafeId(value)) {
    throw new Error(`${what} ${value} is not a safe identifier`);
  }
}
