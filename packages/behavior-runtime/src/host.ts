/**
 * Host side of the behavior IPC protocol (specification section
 * 16.5). The host spawns the module process with a minimal
 * environment, correlates requests by id, and enforces per-call
 * timeouts. The host object is itself a BehaviorBackend.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BehaviorHttpError,
  BehaviorTimeoutError,
  DEFAULT_BEHAVIOR_TIMEOUT_MS,
  type BackendDescription,
  type BackendFactoryContext,
  type BehaviorBackend,
  type BehaviorRequest,
  type BehaviorResult,
  type HandleContext,
  type InitializeContext,
  type InitializeResult,
  type Json
} from "@oal/behavior-api";
import {
  decodeBody,
  DEFAULT_MAX_MESSAGE_BYTES,
  encodeBody,
  parseLine,
  type ChildReply,
  type HostMessage,
  type WireBehaviorRequest,
  type WireBehaviorResult,
  type WireHandleContext
} from "./ipc.ts";

export interface BehaviorHostOptions {
  /** Absolute path to the module entry file. */
  entry: string;
  /** Factory context forwarded to the module's create(). */
  context: BackendFactoryContext;
  /** Run seed namespacing the deterministic services. */
  runSeed: string;
  /** Per-call timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Working directory for the child. Default the pack root. */
  cwd?: string;
  /** Protocol line bound. Default 16 MiB. */
  maxMessageBytes?: number;
}

export class BehaviorModuleHost implements BehaviorBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, (reply: ChildReply) => void>();
  private readonly options: BehaviorHostOptions;

  constructor(options: BehaviorHostOptions) {
    this.options = options;
  }

  /** Spawn the child process with a minimal environment. */
  async start(): Promise<void> {
    if (this.child !== null) {
      throw new Error("behavior module host already started");
    }
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", this.options.entry],
      {
        cwd: this.options.cwd ?? this.options.context.packRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          LANG: "C.UTF-8",
          OAL_BEHAVIOR_CHILD: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    this.child = child;
    const maxMessageBytes =
      this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    let buffer = "";
    let discarding = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          // The line before this newline was over the bound; drop it.
          discarding = false;
        } else {
          this.receive(line, maxMessageBytes);
        }
        newline = buffer.indexOf("\n");
      }
      // A partial line already past the bound can never parse; stop
      // buffering it. UTF-8 bytes never run below the character count,
      // so the character check is conservative.
      if (buffer.length > maxMessageBytes) {
        discarding = true;
        buffer = "";
      }
    });
    child.on("exit", () => {
      for (const resolve of this.pending.values()) {
        resolve({
          id: -1,
          ok: false,
          error: {
            kind: "internal",
            code: "behavior_process_exited",
            message: "The behavior module process exited."
          }
        });
      }
      this.pending.clear();
    });
    await this.call({
      id: this.takeId(),
      kind: "create",
      context: this.options.context
    });
  }

  async describe(): Promise<BackendDescription> {
    const result = await this.call({ id: this.takeId(), kind: "describe" });
    return result as BackendDescription;
  }

  async initialize(context: InitializeContext): Promise<InitializeResult> {
    // Live services cannot cross the process boundary, so only the
    // clock snapshot travels; the child rebuilds clock, ids, random,
    // and blobs from the run seed and pack root (section 16.5).
    const result = await this.call({
      id: this.takeId(),
      kind: "initialize",
      context: {
        runId: context.runId,
        fixtures: [...context.fixtures],
        nowMs: context.clock.nowMs(),
        runSeed: this.options.runSeed,
        packRoot: this.options.context.packRoot
      }
    });
    return result as InitializeResult;
  }

  /**
   * Project one state through the backend's projection. The projection
   * runs in the child like every other backend call; a backend that
   * implements no project rejects with behavior_project_unsupported.
   */
  async project(
    state: Readonly<Json>,
    request: BehaviorRequest | null
  ): Promise<Json> {
    const result = await this.call({
      id: this.takeId(),
      kind: "project",
      state: state as Json,
      request
    });
    return result as Json;
  }

  async handle(
    request: BehaviorRequest,
    context: HandleContext
  ): Promise<BehaviorResult> {
    const wireContext: WireHandleContext = {
      runId: context.runId,
      requestId: context.requestId,
      state: context.state as Json,
      nowMs: context.clock.nowMs(),
      runSeed: this.options.runSeed,
      packRoot: this.options.context.packRoot
    };
    const wire: WireBehaviorRequest = {
      operation: request.operation,
      principal: request.principal,
      parameters: request.parameters,
      body: encodeBody(request.body),
      selectedRequestMediaType: request.selectedRequestMediaType,
      acceptedResponseMediaTypes: [...request.acceptedResponseMediaTypes]
    };
    const result = (await this.call({
      id: this.takeId(),
      kind: "handle",
      request: wire,
      context: wireContext
    })) as WireBehaviorResult;
    const behaviorResult: BehaviorResult = {
      response: { status: result.response.status }
    };
    if (result.response.headers !== undefined) {
      behaviorResult.response.headers = result.response.headers;
    }
    if (result.response.mediaType !== undefined) {
      behaviorResult.response.mediaType = result.response.mediaType;
    }
    if (result.response.body !== undefined) {
      behaviorResult.response.body = decodeBody(result.response.body);
    }
    if (result.nextState !== undefined) {
      behaviorResult.nextState = result.nextState;
    }
    if (result.effects !== undefined) {
      behaviorResult.effects = result.effects;
    }
    if (result.observations !== undefined) {
      behaviorResult.observations = result.observations;
    }
    if (result.semanticEvents !== undefined) {
      behaviorResult.semanticEvents = result.semanticEvents;
    }
    return behaviorResult;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    try {
      await this.call({ id: this.takeId(), kind: "close" });
    } catch {
      // A dead child is the outcome close aims for.
    }
    child.kill();
    this.child = null;
  }

  /** Effective isolation level for reports (section 16.5). */
  readonly isolationLevel = "trusted-local" as const;

  private takeId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private receive(line: string, maxMessageBytes: number): void {
    if (line.trim().length === 0) {
      return;
    }
    let reply: ChildReply;
    try {
      reply = parseLine(line, maxMessageBytes) as ChildReply;
    } catch {
      return;
    }
    const resolve = this.pending.get(reply.id);
    if (resolve !== undefined) {
      this.pending.delete(reply.id);
      resolve(reply);
    }
  }

  private call(message: HostMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const child = this.child;
      if (child === null) {
        reject(new Error("behavior module host not started"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(
          new BehaviorTimeoutError(
            this.options.timeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS,
            "behavior module call timed out"
          )
        );
      }, this.options.timeoutMs ?? DEFAULT_BEHAVIOR_TIMEOUT_MS);
      this.pending.set(message.id, (reply) => {
        clearTimeout(timer);
        if (reply.ok) {
          resolve(reply.result);
          return;
        }
        if (reply.error.kind === "http") {
          reject(
            new BehaviorHttpError({
              status: reply.error.status ?? 500,
              code: reply.error.code,
              message: reply.error.message,
              body:
                reply.error.body === undefined
                  ? undefined
                  : decodeBody(reply.error.body)
            })
          );
          return;
        }
        const error = new Error(reply.error.message);
        error.name = reply.error.code;
        reject(error);
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
}
