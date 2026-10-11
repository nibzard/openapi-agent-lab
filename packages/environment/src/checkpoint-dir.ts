/**
 * Checkpoint directories (specification section 48.4).
 *
 * One checkpoint is a private directory: a public manifest, the
 * encrypted payload under the checkpoint's own key, the key in
 * `private/key` with mode 0600, the referenced blob bytes, the
 * frozen behavior tree, and the compiled contract. Writes stage
 * beside the target and rename atomically, so a partial write
 * never becomes a valid checkpoint. Reads validate every
 * component before any listener opens.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  DiagnosticCode,
  invalidInput,
  isJsonObject,
  isWithin,
  type Json,
  type JsonObject
} from "@oal/core";
import {
  parseCheckpointDocument,
  type CheckpointDocument
} from "@oal/state-store";

import { EnvironmentError, EnvironmentCode } from "./environment.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const KEY_FILE_MODE = 0o600;

/** Name of the public manifest inside a checkpoint directory. */
export const CHECKPOINT_MANIFEST_NAME = "manifest.json";

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function incomplete(message: string): EnvironmentError {
  return new EnvironmentError(EnvironmentCode.CheckpointIncomplete, message);
}

function integrity(message: string): EnvironmentError {
  return new EnvironmentError(EnvironmentCode.CheckpointIntegrity, message);
}

/** Seal one payload under a fresh key: AES-256-GCM. */
function sealPayload(plaintext: string): {
  ciphertext: Buffer;
  nonce: Buffer;
  key: Buffer;
} {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return { ciphertext, nonce, key };
}

/** Open one sealed payload; a tag failure is an integrity error. */
function openPayload(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    throw integrity("The checkpoint payload failed its authenticity check.");
  }
}

/** The public manifest of one checkpoint directory. */
export interface CheckpointManifest {
  readonly schema_version: 2;
  readonly kind: "CheckpointDirectory";
  readonly checkpoint_id: string;
  readonly world_id: string;
  readonly generation: number;
  readonly created_at: string;
  readonly payload_sha256: string;
  readonly payload_bytes: number;
  readonly contract_ir_sha256: string;
  readonly frozen_identity: string;
  readonly frozen_entry_path: string;
  readonly frozen_entry_sha256: string;
  readonly frozen_file_count: number;
  readonly frozen_tree_sha256: string;
  readonly blob_count: number;
}

/** One checkpoint read back and validated. */
export interface ReadCheckpoint {
  readonly manifest: CheckpointManifest;
  readonly document: CheckpointDocument;
  readonly directory: string;
  readonly frozenRoot: string;
  readonly frozenEntry: string;
  readonly blobRoot: string;
  readonly contractIr: JsonObject;
}

/** Hash every path and file in the executable tree; refuse links. */
async function frozenTreeDigest(root: string): Promise<{
  sha256: string;
  fileCount: number;
}> {
  const files: [string, string][] = [];
  const walk = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory).catch(() => null);
    if (metadata === null) {
      throw incomplete("The frozen behavior tree is incomplete.");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw integrity(
        "The frozen behavior tree must contain only directories and files."
      );
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        files.push([
          path.relative(root, file).split(path.sep).join("/"),
          sha256Bytes(await readFile(file))
        ]);
      } else {
        throw integrity(
          "The frozen behavior tree must contain only directories and files."
        );
      }
    }
  };
  await walk(root);
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    sha256: sha256Bytes(Buffer.from(JSON.stringify(files))),
    fileCount: files.length
  };
}

/**
 * Write one checkpoint directory. The target must not exist; the
 * write stages beside it and renames, and a stale staging directory
 * from an interrupted write is removed first.
 */
export async function writeCheckpointDirectory(options: {
  readonly directory: string;
  readonly document: CheckpointDocument;
  readonly contractIr: Json;
  readonly blobSourceRoot: string;
  readonly frozenSourceRoot: string;
  readonly frozenEntryPath: string;
  readonly createdAt: string;
}): Promise<CheckpointManifest> {
  const existing = await stat(options.directory).catch(() => null);
  if (existing !== null) {
    throw invalidInput(
      DiagnosticCode.ArtifactExists,
      `Checkpoint directory ${options.directory} already exists; checkpoints never replace existing output.`,
      { directory: options.directory }
    );
  }
  const parent = path.dirname(options.directory);
  await mkdir(parent, { recursive: true });
  // Recovery: an interrupted write left a staging tree; remove it
  // before this write stages its own (section 48.4).
  for (const entry of await readdir(parent).catch(() => [])) {
    if (entry.startsWith(`${path.basename(options.directory)}.staging-`)) {
      await rm(path.join(parent, entry), { recursive: true, force: true });
    }
  }
  const staging = `${options.directory}.staging-${process.pid.toString(10)}-${randomBytes(3).toString("hex")}`;
  await rm(staging, { recursive: true, force: true });

  const payload = sealPayload(JSON.stringify(options.document));
  const contractBytes = Buffer.from(
    `${JSON.stringify(options.contractIr)}\n`,
    "utf8"
  );
  const frozenTree = await frozenTreeDigest(options.frozenSourceRoot);
  // The frozen entry differs from the pack source by the import
  // rewrite, so its digest is recorded as frozen, not as source.
  const frozenEntryBytes = await readFile(
    path.join(options.frozenSourceRoot, options.frozenEntryPath)
  );

  try {
    await mkdir(path.join(staging, "private"), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE
    });
    await chmod(path.join(staging, "private"), PRIVATE_DIRECTORY_MODE).catch(
      () => undefined
    );
    await writeFile(
      path.join(staging, "private", "key"),
      `${payload.key.toString("hex")}\n`,
      { mode: KEY_FILE_MODE }
    );
    await chmod(path.join(staging, "private", "key"), KEY_FILE_MODE).catch(
      () => undefined
    );
    await writeFile(path.join(staging, "payload.bin"), payload.ciphertext);
    await writeFile(path.join(staging, "payload.nonce"), payload.nonce);
    await writeFile(
      path.join(staging, CHECKPOINT_MANIFEST_NAME),
      `${JSON.stringify({
        schema_version: 2,
        kind: "CheckpointDirectory",
        checkpoint_id: options.document.checkpoint_id,
        world_id: options.document.world.world_id,
        generation: options.document.world.generation,
        created_at: options.createdAt,
        payload_sha256: sha256Bytes(payload.ciphertext),
        payload_bytes: payload.ciphertext.length,
        contract_ir_sha256: sha256Bytes(contractBytes),
        frozen_identity: options.document.frozen.behavior_closure_identity,
        frozen_entry_path: options.frozenEntryPath,
        frozen_entry_sha256: sha256Bytes(frozenEntryBytes),
        frozen_file_count: frozenTree.fileCount,
        frozen_tree_sha256: frozenTree.sha256,
        blob_count: options.document.blobs.references.length
      } as CheckpointManifest)}\n`
    );
    await writeFile(path.join(staging, "contract.ir.json"), contractBytes);
    // The referenced blob bytes travel beside the document, so a
    // restore answers future responses without the source store.
    for (const reference of options.document.blobs.references) {
      const source = path.join(options.blobSourceRoot, reference.relative_path);
      const bytes = await readFile(source).catch(() => {
        throw incomplete(
          `The world references blob ${reference.blob_id} at ${reference.relative_path}, but the blob store has no such file.`
        );
      });
      if (bytes.length !== reference.bytes) {
        throw integrity(
          `Blob ${reference.blob_id} is ${bytes.length.toString(10)} bytes on disk but ${reference.bytes.toString(10)} in the store.`
        );
      }
      const target = path.join(staging, "blobs", reference.relative_path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    // The frozen tree carries the behavior closure: pack files and
    // rewritten packages, exactly what the child executed.
    await cp(options.frozenSourceRoot, path.join(staging, "frozen"), {
      recursive: true
    });
    const copiedTree = await frozenTreeDigest(path.join(staging, "frozen"));
    if (copiedTree.sha256 !== frozenTree.sha256) {
      throw integrity(
        "The frozen behavior tree changed while the checkpoint was copied."
      );
    }
    await rename(staging, options.directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    schema_version: 2,
    kind: "CheckpointDirectory",
    checkpoint_id: options.document.checkpoint_id,
    world_id: options.document.world.world_id,
    generation: options.document.world.generation,
    created_at: options.createdAt,
    payload_sha256: sha256Bytes(payload.ciphertext),
    payload_bytes: payload.ciphertext.length,
    contract_ir_sha256: sha256Bytes(contractBytes),
    frozen_identity: options.document.frozen.behavior_closure_identity,
    frozen_entry_path: options.frozenEntryPath,
    frozen_entry_sha256: sha256Bytes(frozenEntryBytes),
    frozen_file_count: frozenTree.fileCount,
    frozen_tree_sha256: frozenTree.sha256,
    blob_count: options.document.blobs.references.length
  };
}

/**
 * Read one checkpoint directory and validate every component: the
 * manifest, the key, the payload authenticity, the document, the
 * contract, the frozen tree, and every referenced blob. Any failure
 * throws before a listener opens.
 */
export async function readCheckpointDirectory(
  directory: string
): Promise<ReadCheckpoint> {
  const manifestPath = path.join(directory, CHECKPOINT_MANIFEST_NAME);
  const manifestText = await readFile(manifestPath, "utf8").catch(() => {
    throw incomplete(
      `No checkpoint manifest at ${manifestPath}; an interrupted write leaves no valid checkpoint.`
    );
  });
  let manifestJson: Json;
  try {
    manifestJson = JSON.parse(manifestText) as Json;
  } catch {
    throw integrity(`The checkpoint manifest at ${manifestPath} is not JSON.`);
  }
  if (!isJsonObject(manifestJson)) {
    throw integrity("The checkpoint manifest is not a JSON object.");
  }
  if (
    manifestJson["schema_version"] !== 2 ||
    manifestJson["kind"] !== "CheckpointDirectory"
  ) {
    throw new EnvironmentError(
      EnvironmentCode.CheckpointIncompatible,
      "This runtime requires checkpoint directory version 2 with a complete frozen tree digest."
    );
  }
  const keyText = await readFile(
    path.join(directory, "private", "key"),
    "utf8"
  ).catch(() => {
    throw incomplete(
      "The checkpoint keeps no private key; it cannot be restored."
    );
  });
  const key = Buffer.from(keyText.trim(), "hex");
  if (key.length !== 32) {
    throw integrity("The checkpoint key is not a 32-byte value.");
  }
  const ciphertext = await readFile(path.join(directory, "payload.bin")).catch(
    () => {
      throw incomplete("The checkpoint payload is absent.");
    }
  );
  const nonce = await readFile(path.join(directory, "payload.nonce")).catch(
    () => {
      throw incomplete("The checkpoint payload nonce is absent.");
    }
  );
  const digest = sha256Bytes(ciphertext);
  if (manifestJson["payload_sha256"] !== digest) {
    throw integrity(
      "The checkpoint payload does not match the manifest digest."
    );
  }
  const payloadBytes = manifestJson["payload_bytes"];
  if (payloadBytes !== ciphertext.length) {
    throw integrity("The checkpoint payload size does not match the manifest.");
  }
  const documentText = openPayload(ciphertext, nonce, key);
  const document = parseCheckpointDocument(JSON.parse(documentText) as Json);

  const contractBytes = await readFile(
    path.join(directory, "contract.ir.json")
  ).catch(() => {
    throw incomplete("The compiled contract is absent from the checkpoint.");
  });
  if (manifestJson["contract_ir_sha256"] !== sha256Bytes(contractBytes)) {
    throw integrity(
      "The compiled contract does not match the manifest digest."
    );
  }
  const contractIr = JSON.parse(contractBytes.toString("utf8")) as Json;
  if (!isJsonObject(contractIr)) {
    throw integrity("The compiled contract is not a JSON object.");
  }
  const source = contractIr["source"];
  const semantic =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? (source as JsonObject)["semantic_sha256"]
      : undefined;
  if (
    typeof semantic === "string" &&
    semantic !== document.frozen.contract_semantic_sha256
  ) {
    throw integrity(
      "The compiled contract disagrees with the frozen contract identity in the payload."
    );
  }

  const frozenRoot = path.join(directory, "frozen");
  const frozenStats = await stat(frozenRoot).catch(() => null);
  if (frozenStats === null || !frozenStats.isDirectory()) {
    throw incomplete("The frozen behavior tree is absent.");
  }
  const frozenTree = await frozenTreeDigest(frozenRoot);
  if (
    manifestJson["frozen_tree_sha256"] !== frozenTree.sha256 ||
    manifestJson["frozen_file_count"] !== frozenTree.fileCount
  ) {
    throw integrity(
      "The frozen behavior tree does not match its recorded digest and file count."
    );
  }
  const entryPath = manifestJson["frozen_entry_path"];
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw integrity("The manifest names no frozen entry path.");
  }
  const frozenEntry = path.resolve(frozenRoot, entryPath);
  if (!isWithin(frozenRoot, frozenEntry)) {
    throw integrity("The frozen behavior entry leaves the checkpoint tree.");
  }
  const entryBytes = await readFile(frozenEntry).catch(() => {
    throw incomplete(
      `The frozen behavior entry ${entryPath} is absent from the checkpoint.`
    );
  });
  const entryDigest = sha256Bytes(entryBytes);
  const recordedDigest = manifestJson["frozen_entry_sha256"];
  if (typeof recordedDigest !== "string") {
    throw integrity("The manifest records no frozen entry digest.");
  }
  if (entryDigest !== recordedDigest) {
    throw integrity(
      "The frozen behavior entry does not match the recorded digest."
    );
  }
  if (
    manifestJson["frozen_identity"] !==
    document.frozen.behavior_closure_identity
  ) {
    throw integrity(
      "The manifest and the payload disagree about the frozen closure identity."
    );
  }

  const blobRoot = path.join(directory, "blobs");
  for (const reference of document.blobs.references) {
    const blobPath = path.join(blobRoot, reference.relative_path);
    const bytes = await readFile(blobPath).catch(() => {
      throw incomplete(
        `The checkpoint references blob ${reference.blob_id}, but ${reference.relative_path} is absent.`
      );
    });
    if (bytes.length !== reference.bytes) {
      throw integrity(
        `Blob ${reference.blob_id} is ${bytes.length.toString(10)} bytes in the checkpoint but ${reference.bytes.toString(10)} in the manifest payload.`
      );
    }
    if (reference.sha256 !== null && sha256Bytes(bytes) !== reference.sha256) {
      throw integrity(`Blob ${reference.blob_id} fails its content digest.`);
    }
  }

  const manifest: CheckpointManifest = {
    schema_version: 2,
    kind: "CheckpointDirectory",
    checkpoint_id: document.checkpoint_id,
    world_id: document.world.world_id,
    generation: document.world.generation,
    created_at:
      typeof manifestJson["created_at"] === "string"
        ? manifestJson["created_at"]
        : "",
    payload_sha256: digest,
    payload_bytes: ciphertext.length,
    contract_ir_sha256: sha256Bytes(contractBytes),
    frozen_identity: document.frozen.behavior_closure_identity,
    frozen_entry_path: entryPath,
    frozen_entry_sha256: recordedDigest,
    frozen_file_count: frozenTree.fileCount,
    frozen_tree_sha256: frozenTree.sha256,
    blob_count: document.blobs.references.length
  };
  return {
    manifest,
    document,
    directory,
    frozenRoot,
    frozenEntry,
    blobRoot,
    contractIr
  };
}
