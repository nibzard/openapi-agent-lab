/**
 * Participant workspace materialization (specification section 19.3). The
 * workspace holds declared materials only: rendered prompts, declared
 * participant files, the sanitized contract file, and a declared result
 * schema. Every other file is an error after the write pass.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertSafeRelativePath,
  canonicalJsonSha256,
  infrastructure,
  invalidInput,
  isWithin,
  sha256Hex,
  sha256HexBytes,
  type JsonObject
} from "@oal/core";

import type { WorkspaceFilePlan } from "./prompts.ts";
import type { ContractVisibilityValue } from "./template.ts";

/** Stable error codes of the workspace module. */
export const WorkspaceCode = {
  NotEmpty: "OAL-RUN-WORKSPACE-NOT-EMPTY",
  TargetUnsafe: "OAL-RUN-WORKSPACE-TARGET-UNSAFE",
  TargetDuplicate: "OAL-RUN-WORKSPACE-TARGET-DUPLICATE",
  ContractBytesMissing: "OAL-RUN-WORKSPACE-CONTRACT-BYTES-MISSING",
  SourceMissing: "OAL-RUN-WORKSPACE-SOURCE-MISSING",
  SourceNotRegular: "OAL-RUN-WORKSPACE-SOURCE-NOT-REGULAR",
  UndeclaredFile: "OAL-RUN-WORKSPACE-FILE-UNDECLARED",
  UndeclaredSymlink: "OAL-RUN-WORKSPACE-SYMLINK-UNDECLARED",
  FileMissing: "OAL-RUN-WORKSPACE-FILE-MISSING",
  FileModified: "OAL-RUN-WORKSPACE-FILE-MODIFIED",
  WriteFailed: "OAL-RUN-WORKSPACE-WRITE-FAILED",
  GitInitFailed: "OAL-RUN-WORKSPACE-GIT-INIT-FAILED"
} as const;

/** Conventional workspace name of the sanitized contract bundle. */
export const DEFAULT_CONTRACT_FILENAME = "openapi.json";

/** Directory a fresh Git repository creates inside the workspace. */
const GIT_DIRECTORY = ".git";

export interface MaterializeWorkspaceOptions {
  /** Empty directory that receives the declared materials. */
  readonly workspaceDir: string;
  readonly plan: readonly WorkspaceFilePlan[];
  readonly contractVisibility: ContractVisibilityValue;
  /**
   * Sanitized single-document bundle. Used only when the visibility is
   * `file`; the caller owns the sanitization and verification pass.
   */
  readonly sanitizedContract: string | null;
  /** Workspace file name of the contract. Default `openapi.json`. */
  readonly contractFilename?: string;
  /** Initialize a fresh Git repository after writing. Default false. */
  readonly gitInit?: boolean;
}

export interface MaterializedWorkspace {
  readonly workspaceDir: string;
  /** Every file written, including the contract bundle. */
  readonly files: readonly WorkspaceFilePlan[];
  readonly gitInitialized: boolean;
  /** Digest over the verified file set. */
  readonly verifiedSha256: string;
}

const execFileAsync = promisify(execFile);

/**
 * Write the declared materials into an empty workspace directory, then walk
 * the directory and compare it with the declared plan. An undeclared file,
 * a missing file, or a changed digest is fatal. Pack source, behavior
 * implementation, state, fixtures, rubric, workflows, trace, and
 * credentials are never part of the plan, so any copy of them fails the
 * walk.
 */
export async function materializeWorkspace(
  options: MaterializeWorkspaceOptions
): Promise<MaterializedWorkspace> {
  const root = path.resolve(options.workspaceDir);
  await assertEmptyWorkspace(root);

  const intended: WorkspaceFilePlan[] = [...options.plan];
  const filename = options.contractFilename ?? DEFAULT_CONTRACT_FILENAME;
  if (options.contractVisibility === "file") {
    if (options.sanitizedContract === null) {
      throw invalidInput(
        WorkspaceCode.ContractBytesMissing,
        "Contract visibility is file but no sanitized contract bytes were supplied."
      );
    }
    intended.push(contractPlan(filename, options.sanitizedContract));
  }

  const seen = new Set<string>();
  for (const entry of intended) {
    if (seen.has(entry.target)) {
      throw invalidInput(
        WorkspaceCode.TargetDuplicate,
        `Two planned files write the same target: ${entry.target}.`,
        { target: entry.target }
      );
    }
    seen.add(entry.target);
  }

  for (const entry of intended) {
    await writeEntry(root, entry);
  }
  const gitInitialized = options.gitInit === true ? await gitInit(root) : false;
  await verifyWorkspaceFiles(root, intended);

  return Object.freeze({
    workspaceDir: root,
    files: Object.freeze(intended),
    gitInitialized,
    verifiedSha256: verifiedDigest(intended)
  });
}

function contractPlan(filename: string, bytes: string): WorkspaceFilePlan {
  return Object.freeze({
    target: filename,
    origin: "contract",
    source: null,
    sourcePath: null,
    text: bytes,
    engine: null,
    bytes: byteLength(bytes),
    sha256: sha256Hex(bytes)
  });
}

async function assertEmptyWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length > 0) {
    throw invalidInput(
      WorkspaceCode.NotEmpty,
      `Workspace directory is not empty: ${root}.`,
      { entries: [...entries] }
    );
  }
}

async function writeEntry(
  root: string,
  entry: WorkspaceFilePlan
): Promise<void> {
  try {
    assertSafeRelativePath(entry.target, "workspace target");
  } catch (cause) {
    throw invalidInput(
      WorkspaceCode.TargetUnsafe,
      cause instanceof Error ? cause.message : "Workspace target is unsafe.",
      { target: entry.target }
    );
  }
  const absolute = path.join(root, entry.target);
  if (!isWithin(root, absolute)) {
    throw invalidInput(
      WorkspaceCode.TargetUnsafe,
      "Workspace target escapes the workspace.",
      {
        target: entry.target
      }
    );
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  if (entry.text !== null) {
    await writeAtomic(absolute, entry.text);
    return;
  }
  if (entry.sourcePath === null) {
    throw invalidInput(
      WorkspaceCode.SourceMissing,
      `Planned copy has no source path: ${entry.target}.`,
      { target: entry.target }
    );
  }
  const stats = await lstat(entry.sourcePath).catch(() => null);
  if (stats === null) {
    throw invalidInput(
      WorkspaceCode.SourceMissing,
      `Planned copy source does not exist: ${entry.sourcePath}.`,
      { target: entry.target, source: entry.sourcePath }
    );
  }
  if (!stats.isFile()) {
    throw invalidInput(
      WorkspaceCode.SourceNotRegular,
      `Planned copy source is not a regular file: ${entry.sourcePath}.`,
      { target: entry.target, source: entry.sourcePath }
    );
  }
  await copyFile(entry.sourcePath, absolute).catch(() => {
    throw invalidInput(
      WorkspaceCode.WriteFailed,
      `Could not copy ${entry.sourcePath} to ${entry.target}.`,
      { target: entry.target, source: entry.sourcePath }
    );
  });
}

/** Plain write into an empty workspace, made atomic by a rename. */
async function writeAtomic(absolute: string, text: string): Promise<void> {
  const temporary = `${absolute}.tmp-${process.pid.toString(16)}`;
  await writeFile(temporary, text, "utf8").catch(() => {
    throw invalidInput(
      WorkspaceCode.WriteFailed,
      `Could not write ${absolute}.`,
      { target: absolute }
    );
  });
  await rename(temporary, absolute);
}

async function gitInit(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  } catch (cause) {
    throw infrastructure(
      WorkspaceCode.GitInitFailed,
      `Git repository initialization failed in ${root}: ${describe(cause)}.`
    );
  }
  return true;
}

interface WorkspaceProblem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Walk a workspace directory and compare it with the declared plan. The
 * `.git` directory of an initialized repository is the only tolerated
 * extra. The same check runs right after materialization and again before
 * the workspace is archived.
 */
export async function verifyWorkspaceFiles(
  workspaceDir: string,
  files: readonly WorkspaceFilePlan[],
  allowedOutputPaths: readonly string[] = [],
  allowUndeclaredFiles = false
): Promise<void> {
  const root = path.resolve(workspaceDir);
  const declared = new Map(
    files.map((entry) => [
      entry.target,
      { bytes: entry.bytes, sha256: entry.sha256 }
    ])
  );
  const present = new Set<string>();
  const allowedOutputs = new Set(allowedOutputPaths);
  const problems: WorkspaceProblem[] = [];
  await walk(root, "", async (relative, absolute) => {
    present.add(relative);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      problems.push({
        code: WorkspaceCode.UndeclaredSymlink,
        path: relative,
        message: `Workspace contains a symlink: ${relative}.`
      });
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    const expected = declared.get(relative);
    if (expected === undefined) {
      if (allowedOutputs.has(relative) || allowUndeclaredFiles) {
        return;
      }
      problems.push({
        code: WorkspaceCode.UndeclaredFile,
        path: relative,
        message: `Workspace contains an undeclared file: ${relative}.`
      });
      return;
    }
    const bytes = await readFile(absolute);
    const sha256 = sha256HexBytes(bytes);
    if (sha256 !== expected.sha256 || bytes.byteLength !== expected.bytes) {
      problems.push({
        code: WorkspaceCode.FileModified,
        path: relative,
        message: `Workspace file does not match its declared digest: ${relative}.`
      });
    }
  });
  for (const entry of files) {
    if (!present.has(entry.target)) {
      problems.push({
        code: WorkspaceCode.FileMissing,
        path: entry.target,
        message: `Declared workspace file is missing: ${entry.target}.`
      });
    }
  }
  if (problems.length > 0) {
    const first = problems[0] as WorkspaceProblem;
    throw invalidInput(first.code, first.message, {
      problems: problems.map((problem) => ({
        code: problem.code,
        path: problem.path
      }))
    });
  }
}

/**
 * Depth-first walk of one directory. The visitor runs for every entry,
 * including directories. Paths are relative and use POSIX separators.
 */
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

function verifiedDigest(files: readonly WorkspaceFilePlan[]): string {
  const document: JsonObject = {
    files: files
      .map((file) => ({
        target: file.target,
        bytes: file.bytes,
        sha256: file.sha256
      }))
      .sort((left, right) => (left.target < right.target ? -1 : 1))
  };
  return canonicalJsonSha256(document);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
