import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { ArtifactStore, MANIFEST_NAME } from "./artifacts.ts";
import { JsonlSink } from "./trace.ts";
import { SemanticEventStream, documentationStream } from "./streams.ts";

let dir: string;
let store: ArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oal-artifacts-"));
  store = new ArtifactStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ArtifactStore layout", () => {
  it("creates the batch and trial trees", async () => {
    const batch = await store.initBatch("batch-01");
    const trial = await store.initTrial("batch-01", "run-01");
    expect(batch.inputsDir.startsWith(dir)).toBe(true);
    expect(trial.blobsDir.endsWith(join("blobs", "sha256"))).toBe(true);
    expect(await store.exists("runs/batch-01/inputs")).toBe(true);
    expect(await store.exists("runs/batch-01/trials/run-01/session")).toBe(
      true
    );
    expect(await store.exists("runs/batch-01/trials/run-01/workspace")).toBe(
      true
    );
    expect(await store.exists("runs/batch-01/trials/run-01/operator")).toBe(
      true
    );
  });

  it("rejects unsafe identifiers and paths", async () => {
    await expect(store.initBatch("../escape")).rejects.toThrow();
    expect(() => store.resolve("../outside.txt")).toThrow();
    await expect(store.initBatch("bad id with spaces")).rejects.toThrow();
  });
});

describe("write discipline", () => {
  it("enforces write-once semantics", async () => {
    await store.initBatch("batch-01");
    await store.writeOnce("runs/batch-01/batch.json", "{}");
    await expect(
      store.writeOnce("runs/batch-01/batch.json", '{"again":true}')
    ).rejects.toThrow();
    expect(await store.read("runs/batch-01/batch.json")).toBe("{}");
  });

  it("atomic writes replace prior content", async () => {
    await store.initTrial("batch-01", "run-01");
    await store.atomicWrite(
      "runs/batch-01/trials/run-01/state.final.json",
      "v1"
    );
    await store.atomicWrite(
      "runs/batch-01/trials/run-01/state.final.json",
      "v2"
    );
    expect(
      await store.read("runs/batch-01/trials/run-01/state.final.json")
    ).toBe("v2");
  });

  it("deduplicates content-addressed blobs", async () => {
    await store.initTrial("batch-01", "run-01");
    const blobDir = "runs/batch-01/trials/run-01/blobs/sha256";
    const first = await store.putBlob(blobDir, new Uint8Array([1, 2, 3]));
    const second = await store.putBlob(blobDir, new Uint8Array([1, 2, 3]));
    expect(second.path).toBe(first.path);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.read(first.path)).not.toBe("");
  });
});

describe("manifests and verification", () => {
  it("writes a non-self-referential manifest and verifies it", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    await store.writeOnce(`${trial}/run.started.json`, '{"started":true}\n');
    const sink = await store.openSink(`${trial}/trace.jsonl`);
    await sink.appendJson({ sequence: 1 });
    await sink.appendJson({ sequence: 2 });
    await store.atomicWrite(`${trial}/state.final.json`, '{"count":3}\n');

    const manifest = await store.writeManifest({
      scopeDir: trial,
      level: "trial",
      id: "run-01",
      runId: "run-01",
      batchId: "batch-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "run.started.json",
      "state.final.json",
      "trace.jsonl"
    ]);
    for (const entry of manifest.entries) {
      expect(entry.producer).toEqual({
        component: "@oal/evidence",
        version: "0.1.0"
      });
      expect(["redacted", "operator", "sensitive", "public"]).toContain(
        entry.sensitivity
      );
    }
    expect(
      manifest.entries.find((entry) => entry.path === MANIFEST_NAME)
    ).toBeUndefined();

    const manifestPath = `${trial}/${MANIFEST_NAME}`;
    const manifestText = await store.read(manifestPath);
    const digest = createHash("sha256").update(manifestText).digest("hex");
    await store.atomicWrite(
      `${trial}/run.completed.json`,
      `{"manifest_path":"${manifestPath}","manifest_sha256":"${digest}"}\n`
    );
    const verification = await store.verify(`${trial}/run.completed.json`);
    expect(verification).toEqual({ ok: true, problems: [] });
  });

  it("marks sqlite and operator files with the right sensitivity", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    await store.atomicWrite(`${trial}/state.sqlite`, "bytes");
    await store.atomicWrite(`${trial}/operator/backend-errors.log`, "err");
    const manifest = await store.writeManifest({
      scopeDir: trial,
      level: "trial",
      id: "run-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    const byPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry])
    );
    expect(byPath.get("state.sqlite")?.sensitivity).toBe("sensitive");
    expect(byPath.get("operator/backend-errors.log")?.sensitivity).toBe(
      "operator"
    );
  });

  it("detects tampering after finalization", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    await store.writeOnce(`${trial}/run.started.json`, "one\n");
    const manifest = await store.writeManifest({
      scopeDir: trial,
      level: "trial",
      id: "run-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    void manifest;
    const manifestPath = `${trial}/${MANIFEST_NAME}`;
    const digest = createHash("sha256")
      .update(await store.read(manifestPath))
      .digest("hex");
    await store.atomicWrite(
      `${trial}/run.completed.json`,
      `{"manifest_path":"${manifestPath}","manifest_sha256":"${digest}"}\n`
    );
    await writeFile(store.resolve(`${trial}/run.started.json`), "tampered\n");
    const verification = await store.verify(`${trial}/run.completed.json`);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toContain("run.started.json");
  });

  it("verifies binary bytes and records symlinks without reading targets", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    await writeFile(
      store.resolve(`${trial}/state.sqlite`),
      Buffer.from([0xff, 0xfe, 0x00, 0x80])
    );
    const external = join(dir, "external-secret.txt");
    await writeFile(external, "must-not-enter-the-manifest");
    await symlink(external, store.resolve(`${trial}/workspace/link`));
    const manifest = await store.writeManifest({
      scopeDir: trial,
      level: "trial",
      id: "run-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    const link = manifest.entries.find(
      (entry) => entry.path === "workspace/link"
    );
    expect(link?.entry_type).toBe("symlink");
    expect(JSON.stringify(manifest)).not.toContain("must-not-enter");
    const manifestPath = `${trial}/${MANIFEST_NAME}`;
    const digest = createHash("sha256")
      .update(await store.read(manifestPath))
      .digest("hex");
    await store.atomicWrite(
      `${trial}/run.completed.json`,
      `{"manifest_path":"${manifestPath}","manifest_sha256":"${digest}"}\n`
    );
    expect(await store.verify(`${trial}/run.completed.json`)).toEqual({
      ok: true,
      problems: []
    });
  });

  it("detects a missing manifest from the completion pointer", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    await store.atomicWrite(
      `${trial}/run.completed.json`,
      `{"manifest_path":"${trial}/${MANIFEST_NAME}","manifest_sha256":"${"a".repeat(64)}"}\n`
    );
    const verification = await store.verify(`${trial}/run.completed.json`);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toContain("missing");
  });
});

describe("event streams on disk", () => {
  it("documentation and semantic streams keep their own counters", async () => {
    await store.initTrial("batch-01", "run-01");
    const trial = "runs/batch-01/trials/run-01";
    const doc = documentationStream(
      await JsonlSink.open(store.resolve(`${trial}/documentation.jsonl`))
    );
    const first = doc.reserve();
    await doc.complete({
      sequence: first.sequence,
      type: "documentation.exchange",
      event_id: first.event_id
    });
    const semantic = SemanticEventStream.open(
      await JsonlSink.open(
        store.resolve(`${trial}/semantic-events.redacted.jsonl`)
      )
    );
    const event = await semantic.append({
      run_id: "run-01",
      pack_id: "steel-computer",
      name: "computer.created",
      event_version: 1,
      logical_time: "2000-01-01T00:00:00.001Z",
      caused_by_api_event_id: "evt_00000001",
      actor: "participant",
      state_revision_before: 0,
      state_revision_after: 1,
      payload_schema: "computer.created@1",
      payload: { id: "computer_0001" }
    });
    expect(event.event_id).toBe("sem_00000001");
    expect(event.semantic_sequence).toBe(1);
    const docLines = (
      await readFile(store.resolve(`${trial}/documentation.jsonl`), "utf8")
    )
      .trim()
      .split("\n");
    expect(JSON.parse(docLines[0] ?? "{}")).toMatchObject({
      event_id: "doc_00000001"
    });
  });

  it("semantic events number sequentially in commit order", async () => {
    const semantic = SemanticEventStream.open(
      await JsonlSink.open(join(dir, "semantic.jsonl"))
    );
    const base = {
      run_id: "run-01",
      pack_id: "p",
      name: "n",
      event_version: 1,
      logical_time: "2000-01-01T00:00:00.000Z",
      caused_by_api_event_id: null,
      actor: "participant" as const,
      state_revision_before: 0,
      state_revision_after: 1,
      payload_schema: "n@1",
      payload: {} as never
    };
    await semantic.append(base);
    const second = await semantic.append(base);
    expect(second.semantic_sequence).toBe(2);
    expect(second.event_id).toBe("sem_00000002");
  });
});

describe("append-only streams survive directory creation", () => {
  it("creates parent directories on first append", async () => {
    const sink = await JsonlSink.open(join(dir, "deep", "nested", "out.jsonl"));
    await sink.append("hello");
    expect(
      await readFile(join(dir, "deep", "nested", "out.jsonl"), "utf8")
    ).toBe("hello\n");
  });
});

describe("batch scope manifest", () => {
  it("covers batch files and trial manifests as children", async () => {
    await store.initBatch("batch-01");
    await store.initTrial("batch-01", "run-01");
    await store.writeOnce("runs/batch-01/batch.json", "{}\n");
    await store.writeOnce(
      "runs/batch-01/trials/run-01/run.started.json",
      "one\n"
    );
    await store.writeManifest({
      scopeDir: "runs/batch-01/trials/run-01",
      level: "trial",
      id: "run-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    const batchManifest = await store.writeManifest({
      scopeDir: "runs/batch-01",
      level: "batch",
      id: "batch-01",
      createdAt: "2026-08-27T12:00:01.000Z"
    });
    const paths = batchManifest.entries.map((entry) => entry.path);
    expect(paths).toContain("batch.json");
    expect(paths).toContain("trials/run-01/run.started.json");
    expect(paths).toContain(`trials/run-01/${MANIFEST_NAME}`);
    expect(paths).not.toContain(MANIFEST_NAME);
  });

  it("ignores leftover temporary files", async () => {
    await store.initBatch("batch-01");
    await mkdir(store.resolve("runs/batch-01/inputs"), { recursive: true });
    await writeFile(store.resolve("runs/batch-01/inputs/pack.tmp-1"), "junk");
    const manifest = await store.writeManifest({
      scopeDir: "runs/batch-01",
      level: "batch",
      id: "batch-01",
      createdAt: "2026-08-27T12:00:00.000Z"
    });
    expect(
      manifest.entries.find((entry) => entry.path.includes(".tmp"))
    ).toBeUndefined();
  });
});
