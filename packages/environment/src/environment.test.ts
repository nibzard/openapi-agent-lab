/**
 * Environment owner tests (specification section 48.2). The owner must
 * start the behavior child from frozen pack inputs, validate the
 * declared backend before any state exists, project the committed
 * state, and shut down idempotently with the child released.
 *
 * The webclip pack is the reference input. Its compiled contract IR is
 * frozen next to this suite; a digest guard fails the suite when the
 * pack's contract changes so the fixture is regenerated consciously.
 */

import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { StateStore } from "@oal/state-store";

import { loadPack, type LoadedPack } from "@oal/pack";
import type { ContractIR } from "@oal/contract-ir";
import { SchemaValidator, type Json } from "@oal/core";

import {
  EnvironmentCode,
  openEnvironment,
  type Environment
} from "./environment.ts";

const moduleDir = import.meta.dirname;
const webclipRoot = path.resolve(moduleDir, "../../../packs/webclip");
const fixtureIrPath = path.join(
  moduleDir,
  "fixtures",
  "webclip.contract-ir.json"
);

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Load the webclip pack plus its frozen contract inputs. */
async function webclipInputs(): Promise<{
  pack: LoadedPack;
  contract: {
    ir: ContractIR;
    semanticSha256: string;
    executionSha256: string;
  };
}> {
  const pack = await loadPack(webclipRoot);
  const ir = JSON.parse(await readFile(fixtureIrPath, "utf8")) as ContractIR;
  // Digest guard: the fixture must describe exactly this pack's
  // contract document, or the frozen inputs are stale.
  const entry = pack.references.find(
    (reference) => reference.role === "contract_entrypoint"
  );
  expect(entry).toBeDefined();
  const document = ir.source.documents[0];
  expect(document?.uri).toBe("contract/openapi.json");
  expect(document?.sha256).toBe(entry?.sha256);
  return {
    pack,
    contract: {
      ir,
      semanticSha256: ir.source.semantic_sha256,
      executionSha256: ir.source.execution_sha256
    }
  };
}

/** Open the webclip environment in a fresh temporary database. */
async function openWebclipEnvironment(
  overrides: Partial<Parameters<typeof openEnvironment>[0]> = {}
): Promise<Environment> {
  const { pack, contract } = await webclipInputs();
  const databasePath = path.join(await newScratch(), "state.sqlite");
  return openEnvironment({
    pack,
    contract,
    scenarioId: "baseline",
    seed: "e".repeat(64),
    worldId: "environment-test",
    databasePath,
    records: {
      batchId: "environment-test",
      packSha256: "0".repeat(64),
      implementationSha256: contract.executionSha256
    },
    now: () => Date.UTC(2026, 9, 10),
    ...overrides
  });
}

async function newScratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-environment-"));
  scratch.push(dir);
  return dir;
}

/**
 * Copy the webclip pack and rewrite the behavior module's
 * repository-relative imports to absolute file URLs so the copy runs
 * from any directory. Returns the copy's root.
 */
async function webclipCopy(): Promise<string> {
  const root = await newScratch();
  await cp(webclipRoot, root, {
    recursive: true,
    // The linked package tree is skipped and re-linked below: a
    // dereferenced copy loses the pnpm layout the closure resolves
    // transitive dependencies through.
    filter: (source) => !source.includes(`${path.sep}node_modules`)
  });
  await symlink(
    path.join(webclipRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir"
  );
  // The recursive copy carries the pack's node_modules, so the
  // declared public imports resolve inside the copy.
  return root;
}

describe("the environment owner", () => {
  it("starts the behavior child and validates the declared backend", async () => {
    const environment = await openWebclipEnvironment();
    try {
      expect(environment.isolationLevel).toBe("trusted-local");
      expect(environment.description.backendApiVersion).toBe(1);
      // Exact coverage: every contract operation is implemented.
      expect(
        environment.description.operations.filter(
          (operation) => operation.support === "implemented"
        )
      ).toHaveLength(environment.description.operations.length);
      const manifest = environment.manifest();
      expect(manifest.worldId).toBe("environment-test");
      expect(manifest.generation).toBe(1);
      expect(manifest.parentCheckpointId).toBeNull();
      expect(manifest.pack.id).toBe("webclip");
      expect(manifest.scenarioId).toBe("baseline");
      expect(manifest.revision).toBe(0);
      expect(manifest.isolationLevel).toBe("trusted-local");
      expect(manifest.behaviorClosure.identity).toMatch(/^[0-9a-f]{64}$/u);
      expect(manifest.behaviorClosure.entryPath).toBe("behavior/index.ts");
      expect(manifest.behaviorClosure.fileCount).toBeGreaterThan(1);
      // The manifest document validates against environment.v1.
      const schema = JSON.parse(
        await readFile(
          path.resolve(
            moduleDir,
            "../../../schemas/environment.v1.schema.json"
          ),
          "utf8"
        )
      ) as Json;
      const violations = new SchemaValidator(schema).errors(
        environment.manifestDocument()
      );
      expect(violations).toEqual([]);
      expect(manifest.capabilities).toEqual({
        checkpoint: "available",
        reset: "available",
        advanceTime: "available",
        fork: "available",
        scheduledWork: "unsupported"
      });
    } finally {
      await environment.close();
    }
  }, 20_000);

  it("resets clock-derived initial state to the baseline", async () => {
    const root = await webclipCopy();
    const entry = path.join(root, "behavior/index.ts");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")).replace(
        "clips_limit: CLIPS_LIMIT",
        "clips_limit: Math.floor(Date.parse(context.clock.now()) / 1000)"
      )
    );
    const environment = await openWebclipEnvironment({
      pack: await loadPack(root)
    });
    try {
      const baseline = environment.finalState()?.state;
      await environment.advanceTime(10_000);
      await environment.reset();
      expect(environment.finalState()?.state).toEqual(baseline);
      expect(environment.manifest().generation).toBe(2);
    } finally {
      await environment.close();
    }
  });

  it("keeps the generation and state when reset initialization fails", async () => {
    const root = await webclipCopy();
    const entry = path.join(root, "behavior/index.ts");
    await writeFile(
      entry,
      (await readFile(entry, "utf8"))
        .replace(
          "const CLIPS_LIMIT = 100;",
          "const CLIPS_LIMIT = 100; let initializations = 0;"
        )
        .replace(
          "initialize(context: InitializeContext): Promise<InitializeResult> {",
          "initialize(context: InitializeContext): Promise<InitializeResult> { if (++initializations > 1) throw new Error('reset failed');"
        )
    );
    const environment = await openWebclipEnvironment({
      pack: await loadPack(root)
    });
    try {
      await environment.advanceTime(10_000);
      const before = environment.manifest();
      const state = environment.finalState();
      await expect(environment.reset()).rejects.toThrow("reset failed");
      expect(environment.manifest()).toEqual(before);
      expect(environment.finalState()).toEqual(state);
    } finally {
      await environment.close();
    }
  });

  it("rolls back the generation and clock when reset storage fails", async () => {
    const environment = await openWebclipEnvironment();
    try {
      await environment.advanceTime(10_000);
      const before = environment.manifest();
      const state = environment.finalState();
      const write = vi
        .spyOn(StateStore.prototype, "putState")
        .mockImplementationOnce(() => {
          throw new Error("reset storage failed");
        });
      try {
        await expect(environment.reset()).rejects.toThrow(
          "reset storage failed"
        );
      } finally {
        write.mockRestore();
      }
      expect(environment.manifest()).toEqual(before);
      expect(environment.finalState()).toEqual(state);
      await environment.reset();
      expect(environment.manifest().generation).toBe(2);
    } finally {
      await environment.close();
    }
  });

  it("refuses a pack that declares a wall clock", async () => {
    const root = await webclipCopy();
    const manifestPath = path.join(root, "pack.yaml");
    const manifest = (await readFile(manifestPath, "utf8")).replace(
      "    kind: virtual",
      "    kind: wall"
    );
    await writeFile(manifestPath, manifest, "utf8");
    const { contract } = await webclipInputs();
    const pack = await loadPack(root);
    await expect(
      openEnvironment({
        pack,
        contract,
        scenarioId: "baseline",
        seed: "0".repeat(64),
        worldId: "w",
        databasePath: path.join(await newScratch(), "state.sqlite"),
        records: {
          batchId: "b",
          packSha256: "0".repeat(64),
          implementationSha256: contract.executionSha256
        },
        now: () => 0
      })
    ).rejects.toMatchObject({
      code: EnvironmentCode.ClockUnsupported
    });
  }, 20_000);

  it("refuses a state schema version the backend does not serve", async () => {
    const root = await webclipCopy();
    const manifestPath = path.join(root, "pack.yaml");
    const manifest = (await readFile(manifestPath, "utf8")).replace(
      "  state_schema_version: 1",
      "  state_schema_version: 2"
    );
    await writeFile(manifestPath, manifest, "utf8");
    const { contract } = await webclipInputs();
    const pack = await loadPack(root);
    await expect(
      openEnvironment({
        pack,
        contract,
        scenarioId: "baseline",
        seed: "0".repeat(64),
        worldId: "w",
        databasePath: path.join(await newScratch(), "state.sqlite"),
        records: {
          batchId: "b",
          packSha256: "0".repeat(64),
          implementationSha256: contract.executionSha256
        },
        now: () => 0
      })
    ).rejects.toMatchObject({
      code: EnvironmentCode.StateSchemaInvalid
    });
  }, 20_000);

  it("refuses a backend that speaks another API version", async () => {
    const root = await webclipCopy();
    const entry = path.join(root, "behavior", "index.ts");
    const source = (await readFile(entry, "utf8")).replace(
      "        backendApiVersion: 1,",
      "        backendApiVersion: 2,"
    );
    if (!source.includes("backendApiVersion: 2")) {
      throw new Error("The backendApiVersion marker is absent from the copy.");
    }
    await writeFile(entry, source, "utf8");
    const { contract } = await webclipInputs();
    const pack = await loadPack(root);
    await expect(
      openEnvironment({
        pack,
        contract,
        scenarioId: "baseline",
        seed: "0".repeat(64),
        worldId: "w",
        databasePath: path.join(await newScratch(), "state.sqlite"),
        records: {
          batchId: "b",
          packSha256: "0".repeat(64),
          implementationSha256: contract.executionSha256
        },
        now: () => 0
      })
    ).rejects.toMatchObject({
      code: EnvironmentCode.BackendApiUnsupported
    });
  }, 20_000);

  it("refuses a pack without a behavior backend declaration", async () => {
    const root = await webclipCopy();
    const manifestPath = path.join(root, "pack.yaml");
    const manifest = (await readFile(manifestPath, "utf8"))
      .replace("    kind: module\n", "")
      .replace("    entrypoint: behavior/index.ts\n", "");
    await writeFile(manifestPath, manifest, "utf8");
    const { contract } = await webclipInputs();
    const pack = await loadPack(root);
    await expect(
      openEnvironment({
        pack,
        contract,
        scenarioId: "baseline",
        seed: "0".repeat(64),
        worldId: "w",
        databasePath: path.join(await newScratch(), "state.sqlite"),
        records: {
          batchId: "b",
          packSha256: "0".repeat(64),
          implementationSha256: contract.executionSha256
        },
        now: () => 0
      })
    ).rejects.toMatchObject({
      code: EnvironmentCode.BackendMissing
    });
  }, 20_000);

  it("keeps the manifest fixture honest when the pack contract changes", async () => {
    const { pack } = await webclipInputs();
    // The loader hashed the contract this test serves; existence of the
    // pack and the fixture's matching digests are asserted in
    // webclipInputs. Here the guard is explicit: both files must exist.
    expect(existsSync(webclipRoot)).toBe(true);
    expect(pack.references.length).toBeGreaterThan(0);
  });

  it("closes idempotently and stops the behavior child", async () => {
    const environment = await openWebclipEnvironment();
    await environment.close();
    // A second close is a no-op, not an error.
    await environment.close();
    // The child is gone: a further backend call cannot be served.
    await expect(
      environment.backend.handle(
        {
          operation: {
            key: "path:POST /v1/clips",
            method: "POST",
            path_template: "/v1/clips",
            parameters: [],
            responses: []
          } as never,
          principal: { scheme: "bearer", scopes: [], anonymous: false },
          parameters: { path: {}, query: {}, header: {}, cookie: {} },
          body: { kind: "none" },
          selectedRequestMediaType: null,
          acceptedResponseMediaTypes: []
        },
        "after-close"
      )
    ).rejects.toThrow();
  }, 20_000);

  it("projects the committed state through a projecting backend", async () => {
    // The reference webclip backend implements no projection, so the
    // copy declares one: the owner must surface it verbatim.
    const root = await webclipCopy();
    const entry = path.join(root, "behavior", "index.ts");
    const marker = "    return webclipBackend(context.contract);";
    const replaced = [
      "    const inner = webclipBackend(context.contract);",
      "    return {",
      "      ...inner,",
      "      async project(state: Json) {",
      "        return { projected: true, clips: (state as JsonObject).clips ?? {} };",
      "      }",
      "    };"
    ].join("\n");
    const source = (await readFile(entry, "utf8")).replace(marker, replaced);
    if (source === (await readFile(entry, "utf8"))) {
      throw new Error("The create marker is absent from the copy.");
    }
    await writeFile(entry, source, "utf8");
    const { contract } = await webclipInputs();
    const pack = await loadPack(root);
    const environment = await openEnvironment({
      pack,
      contract,
      scenarioId: "baseline",
      seed: "0".repeat(64),
      worldId: "w",
      databasePath: path.join(await newScratch(), "state.sqlite"),
      records: {
        batchId: "b",
        packSha256: "0".repeat(64),
        implementationSha256: contract.executionSha256
      },
      now: () => 0
    });
    try {
      const finalState = environment.finalState();
      expect(finalState?.revision).toBe(0);
      const projected = await environment.projection();
      expect(projected).toMatchObject({ projected: true, clips: {} });
    } finally {
      await environment.close();
    }
  }, 20_000);

  it("serves a null projection when the backend implements none", async () => {
    const environment = await openWebclipEnvironment();
    try {
      expect(await environment.projection()).toBeNull();
    } finally {
      await environment.close();
    }
  }, 20_000);
});

describe("environment controls", () => {
  it("inspects the world and refuses an overflowing advance", async () => {
    const environment = await openWebclipEnvironment();
    try {
      // World inspection is live: the manifest projection plus the
      // committed counters, with no private paths inside.
      const inspection = environment.inspect();
      expect(inspection["world_id"]).toBeDefined();
      expect(inspection["control_count"]).toBe(0);
      expect(JSON.stringify(inspection)).not.toContain("credential");

      // Time advances without touching the revision; overflow refuses.
      const revision = environment.finalState()?.revision;
      const advanced = await environment.advanceTime(5);
      expect(advanced.virtualTime).toBeDefined();
      expect(environment.finalState()?.revision).toBe(revision);
      await expect(environment.advanceTime(253402300799999)).rejects.toThrow(
        /overflow/
      );
    } finally {
      await environment.close();
    }
  }, 20_000);
});
