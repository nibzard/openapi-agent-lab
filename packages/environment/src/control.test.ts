/**
 * Operator control tests (specification section 48.3). The private
 * socket serves protocol v1 behind one operator bearer, serializes
 * admitted controls in submission order, records durable control ids
 * that replay or conflict, refuses stale generations, and answers
 * busy before admission when the queue is full. Participant-shaped
 * credentials never pass, and the socket serves no data routes.
 */

import { cp, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OalError, type Json, type JsonObject } from "@oal/core";
import type { ContractIR } from "@oal/contract-ir";
import { loadPack } from "@oal/pack";
import { StateStore } from "@oal/state-store";

import { openEnvironment, type Environment } from "./environment.ts";
import {
  runControl,
  startWorldControl,
  worldControlUnsupported,
  type ControlOutcome,
  type WorldControlServer
} from "./control.ts";

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

/** One request against the operator socket. */
async function controlCall(
  server: { readonly socketPath: string },
  method: string,
  target: string,
  options: { readonly body?: Json; readonly credential?: string } = {}
): Promise<{ status: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? "" : JSON.stringify(options.body);
    const outgoing = request(
      {
        socketPath: server.socketPath,
        path: target,
        method,
        headers: {
          ...(options.credential === undefined
            ? {}
            : { authorization: `Bearer ${options.credential}` }),
          ...(text.length === 0
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text).toString(10)
              })
        }
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const parsed = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as JsonObject;
          resolve({ status: incoming.statusCode ?? 0, body: parsed });
        });
      }
    );
    outgoing.on("error", reject);
    if (text.length > 0) {
      outgoing.write(text);
    }
    outgoing.end();
  });
}

/** The code of the first diagnostic, for stable matching. */
function firstCode(body: JsonObject): string {
  const diagnostics = body["diagnostics"];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return "";
  }
  const first = diagnostics[0];
  if (typeof first === "object" && first !== null && "code" in first) {
    const code = (first as JsonObject)["code"];
    return typeof code === "string" ? code : "";
  }
  return "";
}

/** The result object of an envelope, as a record. */
function resultOf(body: JsonObject): JsonObject {
  const result = body["result"];
  if (typeof result !== "object" || result === null) {
    throw new Error("The envelope carries no result object.");
  }
  return result as JsonObject;
}

describe("the operator socket", () => {
  let environment: Environment;
  let control: WorldControlServer;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "oal-control-"));
    scratch.push(root);
    await cp(webclipRoot, root, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules`)
    });
    await symlink(
      path.join(webclipRoot, "node_modules"),
      path.join(root, "node_modules"),
      "dir"
    );
    const ir = JSON.parse(await readFile(fixtureIrPath, "utf8")) as ContractIR;
    const pack = await loadPack(root);
    environment = await openEnvironment({
      pack,
      contract: {
        ir,
        semanticSha256: ir.source.semantic_sha256,
        executionSha256: ir.source.execution_sha256
      },
      scenarioId: "baseline",
      seed: "b".repeat(64),
      worldId: "control-test-world",
      databasePath: path.join(root, "state.sqlite"),
      records: {
        batchId: "controls",
        packSha256: "0".repeat(64),
        implementationSha256: ir.source.execution_sha256
      },
      now: () => 0
    });
    control = await environment.openControl({
      operatorDirectory: path.join(root, "operator")
    });
  }, 60_000);

  afterAll(async () => {
    await control.close();
    await environment.close();
  });

  it("serves the world view behind the operator bearer", async () => {
    const view = await controlCall(control, "GET", "/v1/world", {
      credential: control.credential
    });
    expect(view.status).toBe(200);
    expect(view.body["status"]).toBe("ok");
    const result = resultOf(view.body);
    expect(result["world_id"]).toBe("control-test-world");
    expect(result["generation"]).toBe(1);
    expect(result["control_count"]).toBe(0);

    const anonymous = await controlCall(control, "GET", "/v1/world");
    expect(anonymous.status).toBe(401);
    expect(firstCode(anonymous.body)).toBe("OAL-WORLD-CONTROL-UNAUTHORIZED");

    // A participant-shaped bearer is not the operator credential.
    const participant = await controlCall(control, "GET", "/v1/world", {
      credential: "participant-bearer-from-credentials-json"
    });
    expect(participant.status).toBe(401);

    // The credential file carries owner-only permissions.
    const credentialStat = await stat(control.credentialPath);
    expect(credentialStat.mode & 0o077).toBe(0);
  });

  it("serves no data routes on the control socket", async () => {
    const clip = await controlCall(control, "POST", "/v1/clips", {
      credential: control.credential,
      body: { url: "https://example.com/a" }
    });
    expect(clip.status).toBe(404);
    expect(firstCode(clip.body)).toBe("OAL-WORLD-CONTROL-ROUTE-UNKNOWN");

    const unknown = await controlCall(control, "GET", "/v1/nope", {
      credential: control.credential
    });
    expect(unknown.status).toBe(404);

    const wrongMethod = await controlCall(control, "PUT", "/v1/world", {
      credential: control.credential
    });
    expect(wrongMethod.status).toBe(405);
  });

  it("serializes controls in submission order", async () => {
    const submissions = [1, 2, 3].map((index) =>
      controlCall(control, "POST", "/v1/advance-time", {
        credential: control.credential,
        body: {
          control_id: `advance-${String(index).padStart(2, "0")}`,
          expect_generation: 1,
          by_ms: 5
        }
      })
    );
    const answers = await Promise.all(submissions);
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body["status"]).toBe("ok");
    }
    const orders = answers.map((answer) => resultOf(answer.body)["order"]);
    expect(orders).toEqual([1, 2, 3]);
    for (const answer of answers) {
      const result = resultOf(answer.body);
      expect(result["generation"]).toBe(1);
      expect(result["revision"]).toBe(0);
      expect(typeof result["virtual_time"]).toBe("string");
    }
  });

  it("replays a repeated control id and refuses a changed payload", async () => {
    const payload = {
      control_id: "advance-replay",
      expect_generation: 1,
      by_ms: 7
    };
    const first = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: payload
    });
    expect(first.status).toBe(200);
    const repeated = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: payload
    });
    expect(repeated.status).toBe(200);
    expect(resultOf(repeated.body)).toEqual(resultOf(first.body));

    const changed = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: { ...payload, by_ms: 9 }
    });
    expect(changed.status).toBe(409);
    expect(firstCode(changed.body)).toBe("OAL-WORLD-CONTROL-CONFLICT");
  });

  it("refuses a stale generation", async () => {
    const stale = await controlCall(control, "POST", "/v1/reset", {
      credential: control.credential,
      body: { control_id: "reset-stale", expect_generation: 2 }
    });
    expect(stale.status).toBe(409);
    expect(firstCode(stale.body)).toBe("OAL-WORLD-GENERATION-MISMATCH");

    const current = await controlCall(control, "POST", "/v1/reset", {
      credential: control.credential,
      body: { control_id: "reset-current", expect_generation: 1 }
    });
    expect(current.status).toBe(200);
  });

  it("rejects malformed control payloads", async () => {
    const missing = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: { expect_generation: 1, by_ms: 1 }
    });
    expect(missing.status).toBe(400);

    const negative = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: {
        control_id: "advance-negative",
        expect_generation: 1,
        by_ms: -1
      }
    });
    expect(negative.status).toBe(400);

    const fraction = await controlCall(control, "POST", "/v1/advance-time", {
      credential: control.credential,
      body: {
        control_id: "advance-fraction",
        expect_generation: 1,
        by_ms: 1.5
      }
    });
    expect(fraction.status).toBe(400);

    const checkpointless = await controlCall(
      control,
      "POST",
      "/v1/checkpoints",
      {
        credential: control.credential,
        body: { control_id: "checkpoint-noout" }
      }
    );
    expect(checkpointless.status).toBe(400);
  });

  it("refuses platforms without private sockets", () => {
    const error = worldControlUnsupported("win32");
    expect(error).toBeInstanceOf(OalError);
    expect(error.code).toBe("OAL-WORLD-CONTROL-UNSUPPORTED");
  });
});

describe("the control queue", () => {
  it("answers busy before admission when the queue is full", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oal-control-queue-"));
    scratch.push(root);
    const store = StateStore.open({
      path: path.join(root, "state.db"),
      runId: "queue-world"
    });
    store.initializeWorld({
      worldId: "queue-world",
      createdAt: "2026-10-10T00:00:00.000Z"
    });
    store.putState({ state: { open: true }, expectedRevision: null });
    try {
      // One gate holds the first control so the queue stays full
      // deterministically: release happens after the overflow probe.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const effect = async (): Promise<ControlOutcome> => {
        await gate;
        return {
          httpStatus: 501,
          envelope: {
            schema_version: 1,
            status: "unsupported",
            diagnostics: [],
            artifacts: []
          }
        };
      };
      const server = await startWorldControl({
        operatorDirectory: path.join(root, "operator"),
        queueLimit: 1,
        handlers: {
          world: effect,
          checkpoint: (payload) =>
            runControl(store, {
              route: "/v1/checkpoints",
              payload,
              effect
            }),
          reset: (payload) =>
            runControl(store, {
              route: "/v1/reset",
              payload,
              effect
            }),
          advanceTime: (payload) =>
            runControl(store, {
              route: "/v1/advance-time",
              payload,
              effect
            })
        }
      });
      try {
        const first = controlCall(server, "POST", "/v1/advance-time", {
          credential: server.credential,
          body: {
            control_id: "advance-held",
            expect_generation: 1,
            by_ms: 1
          }
        });
        // Give the first request time to occupy its queue slot.
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        const overflow = await controlCall(server, "POST", "/v1/advance-time", {
          credential: server.credential,
          body: {
            control_id: "advance-overflow",
            expect_generation: 1,
            by_ms: 2
          }
        });
        expect(overflow.status).toBe(503);
        expect(overflow.body["status"]).toBe("busy");
        expect(firstCode(overflow.body)).toBe("OAL-WORLD-BUSY");

        release();
        const held = await first;
        expect(held.status).toBe(501);
        // The refused probe never recorded a control.
        expect(store.countControls()).toBe(1);
      } finally {
        await server.close();
      }
    } finally {
      store.close();
    }
  }, 30_000);
});
