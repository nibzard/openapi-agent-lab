/**
 * external-demo scenario behavior backend (backend API version 1).
 *
 * The template backend: one resource, one transition. A counter is
 * created at zero and moves only through increment, which emits the
 * counter.incremented event. The module runs as plain TypeScript
 * under Node type stripping, so it stays erasable-syntax only and
 * imports the runtime values it needs through the declared public
 * packages.
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
  HandleContext,
  InitializeContext,
  InitializeResult,
  Json
} from "@oal/behavior-api";

const JSON_MEDIA_TYPE = "application/json";

const HANDLERS: Record<string, DomainHandler> = {};

type ScenarioState = {
  /** Live counters keyed by name. */
  counters: Record<string, { value: number }>;
};

type DomainHandler = (
  request: BehaviorRequest,
  state: ScenarioState
) => BehaviorResult;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(status: number, message: string): never {
  throw new BehaviorHttpError({
    status,
    code: status === 404 ? "not_found" : "validation_failed",
    message,
    body: { kind: "json", value: { message } }
  });
}

/** Narrow committed JSON state back to the scenario shape. */
function readState(value: Readonly<Json>): ScenarioState {
  if (!isObject(value) || !isObject(value.counters)) {
    throw new Error("The scenario state lacks counters.");
  }
  return { counters: value.counters as ScenarioState["counters"] };
}

function counterJson(name: string, value: number): Json {
  return { name, value } as unknown as Json;
}

function jsonResult(status: number, value: Json): BehaviorResult {
  return {
    response: {
      status,
      mediaType: JSON_MEDIA_TYPE,
      body: { kind: "json", value }
    }
  };
}

function createCounter(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const name = body?.name;
  if (body === null || typeof name !== "string" || name.length < 1) {
    problem(422, "Validation failed: the counter name is missing.");
  }
  if (state.counters[name] !== undefined) {
    problem(422, "Validation failed: a counter with this name exists.");
  }
  return {
    ...jsonResult(201, counterJson(name, 0)),
    nextState: {
      counters: { ...state.counters, [name]: { value: 0 } }
    },
    semanticEvents: [
      { name: "counter.created", eventVersion: 1, payload: { name } }
    ]
  };
}

function counterOf(
  request: BehaviorRequest,
  state: ScenarioState
): { name: string; value: number } {
  const name = String(request.parameters.path.name ?? "");
  const counter = state.counters[name];
  if (counter === undefined) {
    problem(404, "Not found: no counter has this name.");
  }
  return { name, value: counter.value };
}

function getCounter(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const counter = counterOf(request, state);
  return jsonResult(200, counterJson(counter.name, counter.value));
}

/** The one transition: value moves by exactly one, then the event. */
function incrementCounter(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const counter = counterOf(request, state);
  const next = counter.value + 1;
  return {
    ...jsonResult(200, counterJson(counter.name, next)),
    nextState: {
      counters: {
        ...state.counters,
        [counter.name]: { value: next }
      }
    },
    semanticEvents: [
      {
        name: "counter.incremented",
        eventVersion: 1,
        payload: { name: counter.name, value: next }
      }
    ]
  };
}

HANDLERS["POST /counters"] = createCounter;
HANDLERS["GET /counters/{name}"] = getCounter;
HANDLERS["POST /counters/{name}/increment"] = incrementCounter;

/**
 * Build the backend for one contract. The description derives from
 * the compiled contract, so the declared keys can never drift from
 * the operations the gateway actually routes.
 */
function demoBackend(
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
            name: "counter.created",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false
            }
          },
          {
            name: "counter.incremented",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "integer", minimum: 1 }
              },
              required: ["name", "value"],
              additionalProperties: false
            }
          }
        ]
      };
    },
    initialize(_context: InitializeContext): Promise<InitializeResult> {
      return Promise.resolve({ state: { counters: {} } });
    },
    async handle(
      request: BehaviorRequest,
      context: HandleContext
    ): Promise<BehaviorResult> {
      const key = `${request.operation.method} ${request.operation.path_template}`;
      const handler = HANDLERS[key];
      if (handler === undefined) {
        throw new Error(`The demo backend implements no ${key} handler.`);
      }
      return handler(request, readState(context.state));
    }
  };
}

export const backend: BackendModule = {
  apiVersion: 1,
  name: "external-demo",
  version: "0.1.0",
  async create(context: BackendFactoryContext): Promise<BehaviorBackend> {
    return demoBackend(context.contract);
  }
};

if (process.env.OAL_BEHAVIOR_CHILD === "1") {
  void runBehaviorChild(backend);
}
