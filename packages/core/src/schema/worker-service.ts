/**
 * Parent-side schema worker boundary (review remediation F2). Every
 * execution path that evaluates contract- or pack-supplied schemas and
 * regular expressions goes through this service: the work runs inside
 * worker threads with a per-job deadline, a bounded queue, bounded
 * message sizes, and bounded worker heaps.
 *
 * The deadline and the termination decision stay in this process. When
 * a job exceeds its deadline, the worker thread that runs it is
 * terminated and replaced; the timed-out job rejects with the stable
 * code OAL-SCHEMA-WORKER-TIMEOUT and queued work is released under the
 * declared policy: queued jobs keep their own submit-time deadline and
 * fail fast once it passed, otherwise they run on the replacement
 * worker. There is no synchronous fallback path.
 */

import { Worker } from "node:worker_threads";

import { EXIT_INFRASTRUCTURE, OalError } from "../errors.ts";
import type { Json } from "../json.ts";
import type { SchemaViolation } from "./validator.ts";
import type {
  SchemaWorkerReply,
  SchemaWorkerRequest,
  SchemaWorkerResult
} from "./worker-protocol.ts";

/** Stable codes of the schema worker boundary (section 32.2, mock). */
export type SchemaWorkerErrorCode =
  | "OAL-SCHEMA-WORKER-TIMEOUT"
  | "OAL-SCHEMA-WORKER-FAILED"
  | "OAL-SCHEMA-WORKER-QUEUE-FULL"
  | "OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE";

/** Infrastructure failure of the bounded execution boundary. */
export class SchemaWorkerError extends OalError {
  constructor(code: SchemaWorkerErrorCode, message: string) {
    super({
      code,
      message,
      category: "mock",
      exitCode: EXIT_INFRASTRUCTURE
    });
    this.name = "SchemaWorkerError";
  }
}

/** Resource settings of the worker boundary. */
export interface SchemaWorkerSettings {
  /** Deadline of one job, measured from submission. */
  readonly deadlineMs: number;
  /** Worker threads kept available for schema work. */
  readonly workerCount: number;
  /** Jobs that may wait for a free worker. */
  readonly maxPending: number;
  /** Serialized byte bound of one worker message. */
  readonly maxMessageBytes: number;
  /** Heap bound of one worker, in bytes. */
  readonly memoryBytes: number;
}

/**
 * Defaults mirror `LIMIT_DEFAULTS` of `@oal/config`. The values live in
 * two places because `@oal/config` stays dependency-free of
 * `@oal/core`; serving paths configure the service from their resolved
 * limit table, so these defaults serve direct library use only.
 */
export const DEFAULT_SCHEMA_WORKER_SETTINGS: SchemaWorkerSettings = {
  deadlineMs: 1_000,
  workerCount: 2,
  maxPending: 128,
  maxMessageBytes: 8 * 1024 * 1024,
  memoryBytes: 256 * 1024 * 1024
};

/** A request shape before the job identity is assigned. */
type JobRequest = SchemaWorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

/** A request message with its job identity assigned. */
type JobMessage = Exclude<SchemaWorkerRequest, { kind: "register" }>;

/** One registered schema bundle the parent hands to workers. */
interface SchemaBundle {
  readonly id: string;
  readonly root: Json;
  readonly refs: Record<string, Json> | null;
}

/** One submitted job. */
interface PendingJob {
  readonly request: JobMessage;
  /** Registration messages that must precede the job on the same port. */
  readonly registrations: readonly SchemaBundle[];
  readonly deadlineAt: number;
  readonly deadlineMs: number;
  resolve: (result: SchemaWorkerResult) => void;
  reject: (error: SchemaWorkerError) => void;
}

/** One worker thread with its bookkeeping. */
interface WorkerSlot {
  readonly worker: Worker;
  /** Bundle identities this thread has already received. */
  readonly registered: Set<string>;
  current: PendingJob | null;
  timer: NodeJS.Timeout | null;
  terminated: boolean;
}

const WORKER_ENTRY_URL = new URL("./worker-entry.ts", import.meta.url);

/** Distinct bundles are few: one contract or one pack at a time. */
const MAX_BUNDLES = 256;

/** Identity of one reference table handed in as a plain record. */
const refsKeyIds = new WeakMap<object, string>();
let refsKeyCount = 0;

/**
 * The shared worker boundary. One instance per process serves every
 * call site; use {@link schemaWorkerService} for the configured
 * singleton.
 */
export class SchemaWorkerService {
  private settings: SchemaWorkerSettings;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingJob[] = [];
  private readonly bundles = new Map<string, SchemaBundle>();
  private readonly bundleIds = new WeakMap<object, Map<string, string>>();
  /** Content-keyed cache for boolean and null schemas. */
  private readonly inlineBundleIds = new Map<string, string>();
  private nextBundleId = 0;
  private nextJobId = 1;
  private closed = false;

  constructor(settings: Partial<SchemaWorkerSettings> = {}) {
    this.settings = { ...DEFAULT_SCHEMA_WORKER_SETTINGS, ...settings };
  }

  /** Replace the resource settings; the next job uses the new values. */
  configure(settings: Partial<SchemaWorkerSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  currentSettings(): SchemaWorkerSettings {
    return this.settings;
  }

  /** Identity of a schema bundle, registering it on first use. */
  bundleOf(schema: Json, refs?: Record<string, Json>): string {
    const refsKey = refs === undefined ? "" : refsKeyOf(refs);
    const known = this.knownBundleId(schema, refsKey);
    if (known !== undefined && this.bundles.has(known)) {
      return known;
    }
    const id = `bundle_${this.nextBundleId}`;
    this.nextBundleId += 1;
    this.bundles.set(id, { id, root: schema, refs: refs ?? null });
    if (this.bundles.size > MAX_BUNDLES) {
      // Drop the oldest registration; the identity index re-registers
      // that schema under a fresh id when the same object returns.
      const oldest = this.bundles.keys().next().value;
      if (oldest !== undefined) {
        this.bundles.delete(oldest);
      }
    }
    if (typeof schema === "object" && schema !== null) {
      let byRefs = this.bundleIds.get(schema);
      if (byRefs === undefined) {
        byRefs = new Map<string, string>();
        this.bundleIds.set(schema, byRefs);
      }
      byRefs.set(refsKey, id);
    } else {
      this.inlineBundleIds.set(`${JSON.stringify(schema)}@${refsKey}`, id);
    }
    return id;
  }

  private knownBundleId(schema: Json, refsKey: string): string | undefined {
    if (typeof schema === "object" && schema !== null) {
      return this.bundleIds.get(schema)?.get(refsKey);
    }
    return this.inlineBundleIds.get(`${JSON.stringify(schema)}@${refsKey}`);
  }

  /** Validate one instance against one schema inside the boundary. */
  async validate(
    schema: Json,
    instance: Json,
    options: {
      refs?: Record<string, Json>;
      maxDepth?: number;
      deadlineMs?: number;
    } = {}
  ): Promise<SchemaViolation[]> {
    const bundleId = this.bundleOf(schema, options.refs);
    const bundle = this.bundles.get(bundleId);
    if (bundle === undefined) {
      throw new SchemaWorkerError(
        "OAL-SCHEMA-WORKER-FAILED",
        "The schema bundle disappeared before dispatch."
      );
    }
    const result = await this.submit(
      {
        kind: "validate",
        bundleId,
        instance,
        ...(options.maxDepth === undefined
          ? {}
          : { maxDepth: options.maxDepth })
      },
      [bundle],
      options.deadlineMs
    );
    return result.type === "violations" ? result.violations : [];
  }

  /** Test one candidate against one raw pattern inside the boundary. */
  async regexTest(
    pattern: string,
    candidate: string,
    deadlineMs?: number
  ): Promise<boolean> {
    const result = await this.submit(
      { kind: "regex-test", pattern, candidate },
      [],
      deadlineMs
    );
    return result.type === "boolean" ? result.value : false;
  }

  /**
   * First printable ASCII character one raw pattern accepts, computed
   * inside the boundary.
   */
  async regexFirstPrintable(
    pattern: string,
    deadlineMs?: number
  ): Promise<string | null> {
    const result = await this.submit(
      { kind: "regex-first-printable", pattern },
      [],
      deadlineMs
    );
    return result.type === "string" ? result.value : null;
  }

  /**
   * Scan one rendered text for forbidden literals and patterns inside
   * the boundary. Returns the distinct matches per rule, in rule order.
   */
  async scanText(
    literals: readonly { literal: string; caseInsensitive: boolean }[],
    patterns: readonly string[],
    text: string,
    deadlineMs?: number
  ): Promise<{ literals: string[][]; patterns: string[][] }> {
    const result = await this.submit(
      { kind: "scan-text", literals, patterns, text },
      [],
      deadlineMs
    );
    return result.type === "scan"
      ? { literals: result.literals, patterns: result.patterns }
      : { literals: [], patterns: [] };
  }

  /** Terminate every worker and reject queued work. */
  close(): void {
    this.closed = true;
    for (const slot of this.slots.splice(0)) {
      this.takeOffline(slot, "OAL-SCHEMA-WORKER-FAILED");
    }
    for (const job of this.queue.splice(0)) {
      job.reject(
        new SchemaWorkerError(
          "OAL-SCHEMA-WORKER-FAILED",
          "The schema worker boundary closed before the job ran."
        )
      );
    }
  }

  private async submit(
    request: JobRequest,
    registrations: readonly SchemaBundle[],
    deadlineMs?: number
  ): Promise<SchemaWorkerResult> {
    if (this.closed) {
      throw new SchemaWorkerError(
        "OAL-SCHEMA-WORKER-FAILED",
        "The schema worker boundary is closed."
      );
    }
    const effectiveDeadline = deadlineMs ?? this.settings.deadlineMs;
    const bytes = Buffer.byteLength(
      JSON.stringify({
        request,
        registrations: registrations.map((bundle) => ({
          bundleId: bundle.id,
          root: bundle.root,
          refs: bundle.refs
        }))
      }),
      "utf8"
    );
    if (bytes > this.settings.maxMessageBytes) {
      throw new SchemaWorkerError(
        "OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE",
        `The schema worker message needs ${bytes} bytes; the bound is ${this.settings.maxMessageBytes}.`
      );
    }
    if (this.queue.length >= this.settings.maxPending) {
      throw new SchemaWorkerError(
        "OAL-SCHEMA-WORKER-QUEUE-FULL",
        `The schema worker queue holds ${this.queue.length} pending jobs; the bound is ${this.settings.maxPending}.`
      );
    }
    const message = {
      ...request,
      id: this.nextJobId
    } as JobMessage;
    this.nextJobId += 1;
    return new Promise<SchemaWorkerResult>((resolve, reject) => {
      this.queue.push({
        request: message,
        registrations,
        deadlineAt: Date.now() + effectiveDeadline,
        deadlineMs: effectiveDeadline,
        resolve,
        reject
      });
      this.pump();
    });
  }

  private pump(): void {
    // Spawn on demand: a job runs when a worker is idle or the pool
    // still has room for one more thread.
    while (
      this.queue.length > 0 &&
      (this.idleSlot() !== null ||
        this.slots.length < this.settings.workerCount)
    ) {
      let slot = this.idleSlot();
      if (slot === null) {
        slot = this.spawn();
        if (slot === null) {
          return;
        }
      }
      const job = this.queue.shift();
      if (job === undefined) {
        return;
      }
      this.assign(slot, job);
    }
  }

  private idleSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (!slot.terminated && slot.current === null) {
        return slot;
      }
    }
    return null;
  }

  private spawn(): WorkerSlot | null {
    if (this.closed) {
      return null;
    }
    const memoryMb = Math.max(
      16,
      Math.ceil(this.settings.memoryBytes / (1024 * 1024))
    );
    const worker = this.createWorker(memoryMb);
    if (worker === null) {
      return null;
    }
    const slot: WorkerSlot = {
      worker,
      registered: new Set<string>(),
      current: null,
      timer: null,
      terminated: false
    };
    worker.on("message", (reply: SchemaWorkerReply) => {
      this.onReply(slot, reply);
    });
    worker.on("error", () => {
      this.takeOffline(slot, "OAL-SCHEMA-WORKER-FAILED");
    });
    worker.on("exit", () => {
      this.takeOffline(slot, "OAL-SCHEMA-WORKER-FAILED");
    });
    this.slots.push(slot);
    return slot;
  }

  private createWorker(memoryMb: number): Worker | null {
    const limits = { maxOldGenerationSizeMb: memoryMb };
    try {
      return new Worker(WORKER_ENTRY_URL, {
        execArgv: process.execArgv,
        resourceLimits: limits
      });
    } catch {
      // Some parent flags are invalid inside workers; a bare worker
      // still loads the entry through default type stripping.
      try {
        return new Worker(WORKER_ENTRY_URL, {
          execArgv: [],
          resourceLimits: limits
        });
      } catch {
        return null;
      }
    }
  }

  private assign(slot: WorkerSlot, job: PendingJob): void {
    const remaining = job.deadlineAt - Date.now();
    if (remaining <= 0) {
      // Released queued work: the deadline passed while the job waited.
      job.reject(
        new SchemaWorkerError(
          "OAL-SCHEMA-WORKER-TIMEOUT",
          `The schema worker job waited past its ${job.deadlineMs} ms deadline.`
        )
      );
      return;
    }
    for (const bundle of job.registrations) {
      if (slot.registered.has(bundle.id)) {
        continue;
      }
      slot.registered.add(bundle.id);
      slot.worker.postMessage({
        kind: "register",
        bundleId: bundle.id,
        root: bundle.root,
        refs: bundle.refs
      } satisfies SchemaWorkerRequest);
    }
    slot.current = job;
    slot.timer = setTimeout(() => {
      // The parent enforces the deadline: terminate the blocked thread.
      this.takeOffline(slot, "OAL-SCHEMA-WORKER-TIMEOUT");
    }, remaining);
    slot.worker.postMessage(job.request);
  }

  private onReply(slot: WorkerSlot, reply: SchemaWorkerReply): void {
    if (reply.kind === "registered" || slot.terminated) {
      return;
    }
    const job = slot.current;
    if (job === null || job.request.id !== reply.id) {
      return;
    }
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.current = null;
    if (reply.kind === "result") {
      job.resolve(reply.result);
    } else {
      job.reject(
        new SchemaWorkerError(
          "OAL-SCHEMA-WORKER-FAILED",
          `The schema worker failed the job: ${reply.message}`
        )
      );
    }
    this.pump();
  }

  private takeOffline(slot: WorkerSlot, code: SchemaWorkerErrorCode): void {
    if (slot.terminated) {
      return;
    }
    slot.terminated = true;
    const index = this.slots.indexOf(slot);
    if (index !== -1) {
      this.slots.splice(index, 1);
    }
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    const job = slot.current;
    slot.current = null;
    void slot.worker.terminate().catch(() => undefined);
    if (job !== null) {
      job.reject(
        new SchemaWorkerError(
          code,
          code === "OAL-SCHEMA-WORKER-TIMEOUT"
            ? `The schema worker job exceeded its ${job.deadlineMs} ms deadline; the worker was terminated.`
            : "The schema worker exited before the job completed."
        )
      );
    }
    this.pump();
  }
}

function refsKeyOf(refs: Record<string, Json>): string {
  const known = refsKeyIds.get(refs);
  if (known !== undefined) {
    return known;
  }
  const key = `refs_${refsKeyCount}`;
  refsKeyCount += 1;
  refsKeyIds.set(refs, key);
  return key;
}

let sharedService: SchemaWorkerService | null = null;

/** The process-wide schema worker boundary, started lazily. */
export function schemaWorkerService(): SchemaWorkerService {
  if (sharedService === null) {
    sharedService = new SchemaWorkerService();
  }
  return sharedService;
}

/** Configure the process-wide boundary. */
export function configureSchemaWorker(
  settings: Partial<SchemaWorkerSettings>
): void {
  schemaWorkerService().configure(settings);
}

/** Terminate the workers of the process-wide boundary. */
export function closeSchemaWorker(): void {
  if (sharedService !== null) {
    sharedService.close();
    sharedService = null;
  }
}

/** Validate one instance against one schema inside the boundary. */
export async function validateSchemaInstance(
  schema: Json,
  instance: Json,
  options: {
    refs?: Record<string, Json>;
    maxDepth?: number;
    deadlineMs?: number;
  } = {}
): Promise<SchemaViolation[]> {
  return schemaWorkerService().validate(schema, instance, options);
}

/** Test one candidate against one raw pattern inside the boundary. */
export async function patternAcceptsInWorker(
  pattern: string,
  candidate: string
): Promise<boolean> {
  return schemaWorkerService().regexTest(pattern, candidate);
}

/**
 * First printable ASCII character one raw pattern accepts, computed
 * inside the boundary.
 */
export async function firstPrintableMatchInWorker(
  pattern: string
): Promise<string | null> {
  return schemaWorkerService().regexFirstPrintable(pattern);
}

/**
 * Scan one rendered text for forbidden literals and patterns inside
 * the boundary. Returns the distinct matches per rule, in rule order.
 */
export async function scanForbiddenTextInWorker(
  literals: readonly { literal: string; caseInsensitive: boolean }[],
  patterns: readonly string[],
  text: string
): Promise<{ literals: string[][]; patterns: string[][] }> {
  return schemaWorkerService().scanText(literals, patterns, text);
}
