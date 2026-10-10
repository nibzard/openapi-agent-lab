/**
 * idem-runtime scenario behavior backend (backend API version 1).
 *
 * A deliberately small synthetic job lifecycle. The module creates
 * queued jobs and reads them back; the interesting behavior lives in
 * the runtime around it, not here: the gateway serves idempotency
 * replays from the sealed store before this module runs at all. What
 * this module contributes is the observable domain state - one job
 * per create, distinct identifiers, deterministic timestamps - that
 * the replay, conflict, separation, expiry, and lost-response checks
 * measure against.
 *
 * The module runs as plain TypeScript under Node type stripping, so
 * it stays erasable-syntax only and imports the runtime values it
 * needs through the declared public packages.
 */

import { runBehaviorChild } from "@oal/behavior-runtime";
import { BehaviorHttpError } from "@oal/behavior-api";
import type {
  BackendDescription,
  BackendFactoryContext,
  BackendModule,
  BehaviorBackend,
  BehaviorRequest,
  BehaviorResult,
  DeterministicClock,
  DeterministicIds,
  HandleContext,
  InitializeContext,
  InitializeResult,
  Json
} from "@oal/behavior-api";

const JSON_MEDIA_TYPE = "application/json";

type JobRecord = {
  id: string;
  text: string;
  status: "queued";
  created_at: string;
};

type ScenarioState = {
  /** Live jobs keyed by identifier. */
  jobs: Record<string, JobRecord>;
  /** Identifiers in insertion order. */
  order: string[];
};

type DomainContext = {
  clock: DeterministicClock;
  ids: DeterministicIds;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow committed JSON state back to the scenario shape. */
function readState(value: Readonly<Json>): ScenarioState {
  if (!isObject(value) || !isObject(value.jobs) || !Array.isArray(value.order)) {
    throw new Error("The scenario state lacks jobs or order.");
  }
  return value as unknown as ScenarioState;
}

function problem(init: {
  status: number;
  code: string;
  message: string;
}): never {
  throw new BehaviorHttpError({
    status: init.status,
    code: init.code,
    message: init.message,
    body: {
      kind: "json",
      value: { code: init.code, message: init.message }
    }
  });
}

function createJob(
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
): BehaviorResult {
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const text = body?.text;
  if (body === null || typeof text !== "string" || text.length < 1) {
    problem({
      status: 422,
      code: "validation_failed",
      message: "The request body failed validation."
    });
  }
  // The ids service is the only identifier source; the loop walks past
  // any identifier already live, so a rollback restores the position
  // exactly and the next create draws the same value again.
  let id = domain.ids.next("job");
  while (state.jobs[id] !== undefined) {
    id = domain.ids.next("job");
  }
  const job: JobRecord = {
    id,
    text,
    status: "queued",
    created_at: domain.clock.now()
  };
  return {
    response: {
      status: 201,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value: job as unknown as Json }
    },
    nextState: {
      jobs: { ...state.jobs, [id]: job },
      order: [...state.order, id]
    },
    semanticEvents: [
      { name: "job.created", eventVersion: 1, payload: { jobId: id } }
    ]
  };
}

function getJob(request: BehaviorRequest, state: ScenarioState): BehaviorResult {
  const raw = request.parameters.path.jobId;
  const id = typeof raw === "string" ? raw : "";
  const job = state.jobs[id];
  if (job === undefined) {
    problem({
      status: 404,
      code: "not_found",
      message: "No job has this identifier."
    });
  }
  return {
    response: {
      status: 200,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value: job as unknown as Json }
    }
  };
}

const HANDLERS: Record<
  string,
  (
    request: BehaviorRequest,
    state: ScenarioState,
    domain: DomainContext
  ) => BehaviorResult
> = {
  "POST /v1/jobs": createJob,
  "GET /v1/jobs/{jobId}": getJob
};

/**
 * Build the backend for one contract. The description derives from
 * the compiled contract, so the declared keys can never drift from
 * the operations the gateway actually routes.
 */
function idemBackend(
  contract: BackendFactoryContext["contract"]
): BehaviorBackend {
  return {
    async describe(): Promise<BackendDescription> {
      return {
        backendApiVersion: 1,
        stateSchemaVersion: 1,
        operations: contract.operations.map((operation) => ({
          key: operation.key,
          support:
            HANDLERS[`${operation.method} ${operation.path_template}`] !==
            undefined
              ? "implemented"
              : "unsupported"
        })),
        semanticEvents: [
          {
            name: "job.created",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: {
                jobId: { type: "string", pattern: "^job_[0-9a-z]+$" }
              },
              required: ["jobId"],
              additionalProperties: false
            }
          }
        ]
      };
    },
    initialize(_context: InitializeContext): Promise<InitializeResult> {
      return Promise.resolve({ state: { jobs: {}, order: [] } });
    },
    async handle(
      request: BehaviorRequest,
      context: HandleContext
    ): Promise<BehaviorResult> {
      const key = `${request.operation.method} ${request.operation.path_template}`;
      const handler = HANDLERS[key];
      if (handler === undefined) {
        throw new Error(`The idem backend implements no ${key} handler.`);
      }
      return handler(request, readState(context.state), {
        clock: context.clock,
        ids: context.ids
      });
    }
  };
}

export const backend: BackendModule = {
  apiVersion: 1,
  name: "idem-runtime",
  version: "0.1.0",
  async create(context: BackendFactoryContext): Promise<BehaviorBackend> {
    return idemBackend(context.contract);
  }
};

if (process.env.OAL_BEHAVIOR_CHILD === "1") {
  void runBehaviorChild(backend);
}
