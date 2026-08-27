/**
 * Child side of the behavior IPC protocol. An executable behavior
 * module entry calls runBehaviorChild with its BackendModule; the
 * process then serves one request at a time over stdio until the host
 * closes the channel.
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import type {
  BackendFactoryContext,
  BackendModule,
  BehaviorBackend,
  BehaviorHttpError,
  BehaviorRequest,
  BehaviorResult,
  HandleContext,
  InitializeContext
} from "@oal/behavior-api";
import { createNamespacePrng, VirtualClock } from "@oal/state-store";
import {
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "./adapters.ts";
import {
  decodeBody,
  encodeBody,
  parseLine,
  type ChildReply,
  type HostMessage,
  type WireBehaviorRequest,
  type WireBehaviorResult,
  type WireHandleContext
} from "./ipc.ts";

export interface ChildOptions {
  /** Hard bound on one protocol line. */
  maxMessageBytes?: number;
}

/**
 * Serve a BackendModule over stdin and stdout. The first message must
 * be create; requests are handled serially in ingress order; the
 * process exits when stdin ends or a close message arrives.
 */
export async function runBehaviorChild(
  module: BackendModule,
  options: ChildOptions = {}
): Promise<void> {
  const maxBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
  const holder: { backend: BehaviorBackend | null } = { backend: null };
  let current: Promise<void> = Promise.resolve();

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    let message: HostMessage;
    try {
      const parsed = parseLine(line, maxBytes) as HostMessage | null;
      if (parsed === null) {
        return;
      }
      message = parsed;
    } catch (error) {
      reply({
        id: -1,
        ok: false,
        error: {
          kind: "internal",
          code: "behavior_ipc_message_invalid",
          message: error instanceof Error ? error.message : "unreadable message"
        }
      });
      return;
    }
    current = current.then(() => serve(message));
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
    rl.on("error", () => {
      resolve();
    });
  });
  await current;
  const created = holder.backend;
  if (created?.close !== undefined) {
    await created.close();
  }

  async function serve(message: HostMessage): Promise<void> {
    const target = holder.backend;
    try {
      switch (message.kind) {
        case "create":
          holder.backend = await module.create(
            message.context as BackendFactoryContext
          );
          reply({ id: message.id, ok: true, result: null });
          break;
        case "describe":
          requireBackend(target);
          reply({ id: message.id, ok: true, result: await target.describe() });
          break;
        case "initialize":
          requireBackend(target);
          reply({
            id: message.id,
            ok: true,
            result: await target.initialize(
              message.context as InitializeContext
            )
          });
          break;
        case "handle": {
          requireBackend(target);
          const wire = message.request as WireBehaviorRequest;
          const request: BehaviorRequest = {
            operation: wire.operation,
            principal: wire.principal,
            parameters: wire.parameters,
            body: decodeBody(wire.body),
            selectedRequestMediaType: wire.selectedRequestMediaType,
            acceptedResponseMediaTypes: wire.acceptedResponseMediaTypes
          };
          const result = await target.handle(
            request,
            rebuildContext(message.context)
          );
          const encoded = encodeResult(result);
          reply({ id: message.id, ok: true, result: encoded });
          break;
        }
        case "project": {
          requireBackend(target);
          if (target.project === undefined) {
            reply({
              id: message.id,
              ok: false,
              error: {
                kind: "internal",
                code: "behavior_project_unsupported",
                message: "The backend implements no project."
              }
            });
            break;
          }
          reply({
            id: message.id,
            ok: true,
            result: await target.project(
              message.state as never,
              message.request as never
            )
          });
          break;
        }
        case "close":
          if (target?.close !== undefined) {
            await target.close();
          }
          reply({ id: message.id, ok: true, result: null });
          process.exit(0);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "BehaviorHttpError") {
        const httpError = error as BehaviorHttpError;
        reply({
          id: message.id,
          ok: false,
          error: {
            kind: "http",
            status: httpError.status,
            code: httpError.code,
            message: httpError.message,
            body:
              httpError.behaviorBody === undefined
                ? undefined
                : encodeBody(httpError.behaviorBody)
          }
        });
        return;
      }
      reply({
        id: message.id,
        ok: false,
        error: {
          kind: "internal",
          code: "behavior_internal_error",
          message: error instanceof Error ? error.message : "unknown failure"
        }
      });
    }
  }

  function requireBackend(
    target: BehaviorBackend | null
  ): asserts target is BehaviorBackend {
    if (target === null) {
      throw new Error("backend not created");
    }
  }

  function reply(message: ChildReply): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * Rebuild deterministic services from the wire snapshot: virtual time
 * pinned to the parent's now, IDs starting fresh per request, a PRNG
 * namespaced by request so unrelated requests never perturb one
 * another, and the shared digest-addressed blob directory.
 */
function rebuildContext(wire: WireHandleContext): HandleContext {
  const clock = new VirtualClock({ initialMs: wire.nowMs });
  return {
    runId: wire.runId,
    requestId: wire.requestId,
    state: wire.state,
    clock: clockAdapter(clock),
    ids: idsAdapter(),
    random: randomAdapter(
      createNamespacePrng(wire.runSeed, `request:${wire.requestId}`)
    ),
    blobs: fileBlobStore(join(wire.packRoot, ".oal", "blobs"))
  };
}

/** Encode a behavior result for the wire, keeping optionals absent. */
function encodeResult(result: BehaviorResult): WireBehaviorResult {
  const encoded: WireBehaviorResult = {
    response: { status: result.response.status }
  };
  if (result.response.headers !== undefined) {
    encoded.response.headers = result.response.headers;
  }
  if (result.response.mediaType !== undefined) {
    encoded.response.mediaType = result.response.mediaType;
  }
  if (result.response.body !== undefined) {
    encoded.response.body = encodeBody(result.response.body);
  }
  if (result.nextState !== undefined) {
    encoded.nextState = result.nextState;
  }
  if (result.effects !== undefined) {
    encoded.effects = result.effects;
  }
  if (result.observations !== undefined) {
    encoded.observations = result.observations;
  }
  if (result.semanticEvents !== undefined) {
    encoded.semanticEvents = result.semanticEvents;
  }
  return encoded;
}
