/**
 * The private operator socket (specification section 48.3).
 *
 * HTTP over a Unix domain socket in a private operator directory.
 * The directory, the socket, and the bearer credential file carry
 * owner-only permissions, and the credential never reaches a
 * participant input or an evidence export. Protocol v1 serves four
 * routes; every mutation carries a durable control id, joins the
 * same serial queue as data requests, and records its order,
 * input, generation, revision, time, and result.
 *
 * Platforms without equivalent socket isolation answer
 * `OAL-WORLD-CONTROL-UNSUPPORTED`.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import path from "node:path";

import {
  DiagnosticCode,
  EXIT_INFRASTRUCTURE,
  OalError,
  canonicalJson,
  sha256Hex,
  type Json,
  type JsonObject
} from "@oal/core";
import type { StateStore } from "@oal/state-store";

/** Requests the protocol queues before it answers busy. */
export const CONTROL_QUEUE_LIMIT = 128;

/** Every protocol v1 route path. */
const PROTOCOL_ROUTES: ReadonlySet<string> = new Set([
  "/v1/world",
  "/v1/checkpoints",
  "/v1/reset",
  "/v1/advance-time"
]);

/** Largest control request body the protocol reads. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

const CONTROL_PROTOCOL_VERSION = 1;

const OPERATOR_DIRECTORY_MODE = 0o700;
const OPERATOR_FILE_MODE = 0o600;

/** The protocol v1 routes. */
export type ControlRoute =
  | "/v1/world"
  | "/v1/checkpoints"
  | "/v1/reset"
  | "/v1/advance-time";

/** One running operator socket. */
export interface WorldControlServer {
  /** Absolute path of the listening Unix domain socket. */
  readonly socketPath: string;
  /** The private operator directory (mode 0700). */
  readonly operatorDirectory: string;
  /** The bearer credential file inside the operator directory. */
  readonly credentialPath: string;
  /**
   * The operator bearer. Hand only to the operator; it never enters
   * evidence exports or participant inputs.
   */
  readonly credential: string;
  /** Stop the listener and remove the socket file. Idempotent. */
  close(): Promise<void>;
}

/** Result of one admitted control. */
export interface ControlOutcome {
  readonly httpStatus: number;
  readonly envelope: JsonObject;
}

/** One handler result, now or later. */
export type ControlEffect = ControlOutcome | Promise<ControlOutcome>;

/** The world-facing behavior behind the protocol routes. */
export interface WorldControlHandlers {
  /** The redacted world view `GET /v1/world` serves. */
  readonly world: () => ControlEffect;
  /** `POST /v1/checkpoints` after validation and idempotency. */
  readonly checkpoint: (payload: JsonObject) => ControlEffect;
  /** `POST /v1/reset` after validation and idempotency. */
  readonly reset: (payload: JsonObject) => ControlEffect;
  /** `POST /v1/advance-time` after validation and idempotency. */
  readonly advanceTime: (payload: JsonObject) => ControlEffect;
}

/** Options of {@link startWorldControl}. */
export interface WorldControlOptions {
  /** Directory for socket and credential; created mode 0700. */
  readonly operatorDirectory: string;
  /** Queued requests allowed before busy. Default 128. */
  readonly queueLimit?: number;
  /** Injected platform for the unsupported check. Default the host. */
  readonly platform?: NodeJS.Platform;
  /** The handlers the protocol serves. */
  readonly handlers: WorldControlHandlers;
}

/** Empty diagnostics and artifacts shared by every envelope. */
function envelope(
  status: string,
  result: Json | null,
  diagnostics: readonly JsonObject[] = []
): JsonObject {
  return {
    schema_version: CONTROL_PROTOCOL_VERSION,
    status,
    ...(result === null ? {} : { result }),
    diagnostics: [...diagnostics],
    artifacts: []
  };
}

/** One error diagnostic with a stable code. */
function diagnostic(code: string, message: string): JsonObject {
  return { code, message };
}

/** Envelope builder for handler authors outside this module. */
export function controlEnvelope(
  status: string,
  result: Json | null,
  diagnostics: readonly JsonObject[] = []
): JsonObject {
  return envelope(status, result, diagnostics);
}

/** Diagnostic builder for handler authors outside this module. */
export function controlDiagnostic(code: string, message: string): JsonObject {
  return diagnostic(code, message);
}

/** Refuse a platform without private socket isolation. */
export function worldControlUnsupported(platform: NodeJS.Platform): OalError {
  return new OalError({
    code: DiagnosticCode.WorldControlUnsupported,
    message: `World controls need a private Unix domain socket; platform ${JSON.stringify(platform)} has no equivalent isolation in this build.`,
    category: "startup",
    exitCode: EXIT_INFRASTRUCTURE,
    details: { platform }
  });
}

interface ControlRequest {
  readonly route: ControlRoute;
  readonly method: string;
  readonly body: JsonObject | null;
}

/** Read and size-check one request body. */
function readBody(
  chunks: readonly Buffer[]
): { ok: true; text: string } | { ok: false; reason: "too-large" } {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
    if (total > MAX_CONTROL_BODY_BYTES) {
      return { ok: false, reason: "too-large" };
    }
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** Validate one mutation payload against the protocol shape. */
function validateMutation(
  route: ControlRoute,
  body: JsonObject
): { ok: true } | { ok: false; message: string } {
  const controlId = body["control_id"];
  if (typeof controlId !== "string" || controlId.length === 0) {
    return {
      ok: false,
      message: "A mutation control carries a nonempty control_id."
    };
  }
  if (route === "/v1/reset" || route === "/v1/advance-time") {
    const expected = body["expect_generation"];
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1
    ) {
      return {
        ok: false,
        message: `${route} requires expect_generation as a positive integer.`
      };
    }
  }
  if (route === "/v1/advance-time") {
    const byMs = body["by_ms"];
    if (
      typeof byMs !== "number" ||
      !Number.isInteger(byMs) ||
      byMs < 0 ||
      !Number.isSafeInteger(byMs)
    ) {
      return {
        ok: false,
        message: "advance-time requires by_ms as a nonnegative safe integer."
      };
    }
  }
  if (route === "/v1/checkpoints") {
    const out = body["out"];
    if (typeof out !== "string" || out.length === 0) {
      return {
        ok: false,
        message: "checkpoints requires out as a new local output path."
      };
    }
  }
  return { ok: true };
}

/**
 * Start the operator socket. The returned server serializes admitted
 * requests through one queue of `queueLimit` waiting entries; the
 * overflow answer is 503 with `OAL-WORLD-BUSY` before admission.
 */
export async function startWorldControl(
  options: WorldControlOptions
): Promise<WorldControlServer> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw worldControlUnsupported(platform);
  }
  const queueLimit = options.queueLimit ?? CONTROL_QUEUE_LIMIT;
  await mkdir(options.operatorDirectory, {
    recursive: true,
    mode: OPERATOR_DIRECTORY_MODE
  });
  await chmod(options.operatorDirectory, OPERATOR_DIRECTORY_MODE);
  const socketPath = path.join(options.operatorDirectory, "control.sock");
  const credentialPath = path.join(
    options.operatorDirectory,
    "operator-credential"
  );
  const credential = randomBytes(32).toString("hex");
  await writeFile(credentialPath, `${credential}\n`, {
    mode: OPERATOR_FILE_MODE
  });
  await chmod(credentialPath, OPERATOR_FILE_MODE);
  await rm(socketPath, { force: true });

  // One queue serializes admitted requests. The counter refuses new
  // entries before admission once the limit is reached.
  let waiting = 0;
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  const server: Server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).finally(() => {
      outgoing.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve();
    });
  });
  await chmod(socketPath, OPERATOR_FILE_MODE);

  async function handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse
  ): Promise<void> {
    const method = (incoming.method ?? "GET").toUpperCase();
    const target = (incoming.url ?? "/").split("?")[0] ?? "/";
    const route = target as ControlRoute;
    const known = PROTOCOL_ROUTES.has(target);
    const send = (status: number, body: JsonObject): void => {
      const text = `${JSON.stringify(body)}\n`;
      outgoing.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text).toString(10)
      });
      outgoing.write(text);
    };

    // The operator credential: one bearer, checked on every request.
    const authorization = incoming.headers.authorization;
    if (authorization !== `Bearer ${credential}`) {
      send(
        401,
        envelope("unauthenticated", null, [
          diagnostic(
            "OAL-WORLD-CONTROL-UNAUTHORIZED",
            "World controls require the operator bearer credential."
          )
        ])
      );
      return;
    }
    if (!known) {
      send(
        404,
        envelope("not-found", null, [
          diagnostic(
            "OAL-WORLD-CONTROL-ROUTE-UNKNOWN",
            `No protocol v1 route for ${method} ${target}.`
          )
        ])
      );
      return;
    }
    const wantsMethod = route === "/v1/world" ? "GET" : "POST";
    if (method !== wantsMethod) {
      send(
        405,
        envelope("method-not-allowed", null, [
          diagnostic(
            "OAL-WORLD-CONTROL-METHOD",
            `${route} answers ${wantsMethod} only.`
          )
        ])
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(chunk as Buffer);
    }
    const read = readBody(chunks);
    if (!read.ok) {
      send(
        413,
        envelope("too-large", null, [
          diagnostic(
            "OAL-WORLD-CONTROL-TOO-LARGE",
            "The control body exceeds the protocol limit."
          )
        ])
      );
      return;
    }
    let body: JsonObject | null = null;
    if (read.text.length > 0) {
      let parsed: Json;
      try {
        parsed = JSON.parse(read.text) as Json;
      } catch {
        send(
          400,
          envelope("invalid", null, [
            diagnostic(
              "OAL-WORLD-CONTROL-BODY",
              "The control body is not JSON."
            )
          ])
        );
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        send(
          400,
          envelope("invalid", null, [
            diagnostic(
              "OAL-WORLD-CONTROL-BODY",
              "The control body must be a JSON object."
            )
          ])
        );
        return;
      }
      body = parsed as JsonObject;
    }

    const request: ControlRequest = { route, method, body };
    // Admission: the queue refuses before it admits (section 48.3).
    if (waiting >= queueLimit) {
      send(
        503,
        envelope("busy", null, [
          diagnostic(
            DiagnosticCode.WorldBusy,
            `The world queue holds ${String(queueLimit)} waiting entries; retry the control later.`
          )
        ])
      );
      return;
    }
    waiting += 1;
    const run = async (): Promise<void> => {
      try {
        const outcome = await dispatch(request, options.handlers);
        send(outcome.httpStatus, outcome.envelope);
      } catch (error) {
        send(
          500,
          envelope("failed", null, [
            diagnostic(
              "OAL-WORLD-CONTROL-FAILED",
              error instanceof Error ? error.message : String(error)
            )
          ])
        );
      } finally {
        waiting -= 1;
      }
    };
    tail = tail.then(run, run);
    await tail;
  }

  async function dispatch(
    request: ControlRequest,
    handlers: WorldControlHandlers
  ): Promise<ControlOutcome> {
    if (request.route === "/v1/world") {
      return handlers.world();
    }
    const body = request.body ?? {};
    const valid = validateMutation(request.route, body);
    if (!valid.ok) {
      return {
        httpStatus: 400,
        envelope: envelope("invalid", null, [
          diagnostic("OAL-WORLD-CONTROL-BODY", valid.message)
        ])
      };
    }
    if (request.route === "/v1/checkpoints") {
      return handlers.checkpoint(body);
    }
    if (request.route === "/v1/reset") {
      return handlers.reset(body);
    }
    return handlers.advanceTime(body);
  }

  return {
    socketPath,
    operatorDirectory: options.operatorDirectory,
    credentialPath,
    credential,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  };
}

/**
 * The protocol-level control processing the environment serves:
 * idempotency by control id, generation check, then the handler. The
 * socket queue admits controls one at a time, and each store read
 * and write runs in its own transaction, so a control observes the
 * last completed operation and its record commits atomically.
 */
export async function runControl(
  store: StateStore,
  input: {
    readonly route: ControlRoute;
    readonly payload: JsonObject;
    readonly effect: () => ControlEffect;
  }
): Promise<ControlOutcome> {
  const rawId = input.payload["control_id"];
  const controlId = typeof rawId === "string" ? rawId : "";
  const payloadSha256 = sha256Hex(
    canonicalJson({ route: input.route, payload: input.payload })
  );
  const existing = store.lookupControl(controlId);
  if (existing !== null) {
    if (existing.payloadSha256 !== payloadSha256) {
      return {
        httpStatus: 409,
        envelope: envelope("conflict", null, [
          diagnostic(
            DiagnosticCode.WorldControlConflict,
            `Control ${JSON.stringify(controlId)} ran with a different payload.`
          )
        ])
      };
    }
    return {
      httpStatus: existing.status,
      envelope: JSON.parse(existing.resultJson) as JsonObject
    };
  }
  const world = store.readWorld();
  const generation = world?.generation ?? 1;
  if (
    (input.route === "/v1/reset" || input.route === "/v1/advance-time") &&
    input.payload["expect_generation"] !== generation
  ) {
    return {
      httpStatus: 409,
      envelope: envelope("generation-mismatch", null, [
        diagnostic(
          DiagnosticCode.WorldGenerationMismatch,
          `The world is at generation ${String(generation)}, but the control expects ${JSON.stringify(input.payload["expect_generation"])}.`
        )
      ])
    };
  }
  const outcome = await Promise.resolve(input.effect());
  // The socket queue serializes controls, so the counts below are
  // stable until this control records: its order, the world it saw,
  // and the committed revision all ride the envelope and the stored
  // evidence as one form.
  const state = store.getState();
  // The effect's own fields win: a reset reports the generation it
  // produced, not the one it consumed. The record stamps the rest.
  const effect = outcome.envelope["result"];
  const effectResult: JsonObject =
    typeof effect === "object" && effect !== null && !Array.isArray(effect)
      ? (effect as JsonObject)
      : {};
  const withRecord: JsonObject = {
    ...outcome.envelope,
    result: {
      generation,
      revision: state?.revision ?? 0,
      virtual_time: store.clock.now(),
      ...effectResult,
      control_id: controlId,
      route: input.route,
      order: store.countControls() + 1
    }
  };
  const recordable = store.recordControl({
    controlId,
    route: input.route,
    payloadSha256,
    status: outcome.httpStatus,
    resultJson: canonicalJson(withRecord),
    createdAt: new Date().toISOString()
  });
  if (recordable.outcome === "replayed") {
    return {
      httpStatus: recordable.status,
      envelope: JSON.parse(recordable.resultJson) as JsonObject
    };
  }
  if (recordable.outcome === "conflict") {
    return {
      httpStatus: 409,
      envelope: envelope("conflict", null, [
        diagnostic(
          DiagnosticCode.WorldControlConflict,
          `Control ${JSON.stringify(controlId)} ran with a different payload.`
        )
      ])
    };
  }
  return { httpStatus: outcome.httpStatus, envelope: withRecord };
  return outcome;
}

/** The stable codes the protocol answers, for callers that match. */
export const CONTROL_CODES = {
  busy: DiagnosticCode.WorldBusy,
  generationMismatch: DiagnosticCode.WorldGenerationMismatch,
  conflict: DiagnosticCode.WorldControlConflict,
  unsupported: DiagnosticCode.WorldControlUnsupported
} as const;

/** The operator address a listener can report without secrets. */
export function controlAddress(server: {
  readonly socketPath: string;
}): string {
  return `unix://${server.socketPath}`;
}
