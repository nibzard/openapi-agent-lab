/**
 * github-issue-triage scenario behavior backend (backend API version
 * 1).
 *
 * A local emulator of the modeled GitHub Issues surface: create,
 * read, list, add one pre-existing label, close. Two properties the
 * corpus pins live here. First, the number of an issue (the
 * repository-scoped path handle) and its id (the global identity)
 * come from different counters and never alias. Second, list results
 * include one seeded pull-request entry, so list assertions must
 * select by number and ignore entries carrying the pull_request key,
 * exactly as the provider behaves.
 *
 * Unsupported input combinations answer 422 with a problem body:
 * that is the capability boundary of the modeled surface, not a
 * crash.
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

/** The one label the modeled surface admits. */
const TRIAGE_LABEL = "oal-triage";

const HANDLERS: Record<string, DomainHandler> = {};

type LabelRecord = {
  id: number;
  name: string;
  description: string | null;
};

type IssueRecord = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: LabelRecord[];
  pullRequest: boolean;
  created_at: string;
};

type ScenarioState = {
  /** Live issues keyed by number as text. */
  issues: Record<string, IssueRecord>;
  /** Issue numbers in insertion order. */
  order: string[];
  /** Pre-existing labels keyed by name. */
  labels: Record<string, LabelRecord>;
};

type DomainContext = {
  clock: DeterministicClock;
  ids: DeterministicIds;
};

type DomainHandler = (
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
) => BehaviorResult;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(init: {
  status: number;
  message: string;
}): never {
  throw new BehaviorHttpError({
    status: init.status,
    code: init.status === 404 ? "not_found" : "validation_failed",
    message: init.message,
    body: {
      kind: "json",
      value: {
        message: init.message,
        documentation_url: "https://docs.github.com/en/rest/issues/issues"
      }
    }
  });
}

/** Narrow committed JSON state back to the scenario shape. */
function readState(value: Readonly<Json>): ScenarioState {
  if (!isObject(value) || !isObject(value.issues) || !isObject(value.labels)) {
    throw new Error("The scenario state lacks issues or labels.");
  }
  const order = Array.isArray(value.order)
    ? value.order.map((entry) => String(entry))
    : [];
  return { issues: value.issues as Record<string, IssueRecord>, order, labels: value.labels as Record<string, LabelRecord> };
}

/** The wire view of one issue; pull requests keep their marker. */
function issueJson(issue: IssueRecord): Json {
  const value: Record<string, Json> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({
      id: label.id,
      name: label.name,
      description: label.description
    })) as unknown as Json,
    created_at: issue.created_at
  };
  if (issue.pullRequest) {
    value.pull_request = {
      url: `https://api.github.com/repos/example/triage/pulls/${issue.number.toString(10)}`
    };
  }
  return value as unknown as Json;
}

function pathInt(request: BehaviorRequest, name: string): number {
  const raw = request.parameters.path[name];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : -1;
}

function issueByNumber(
  state: ScenarioState,
  number: number
): IssueRecord | undefined {
  if (number < 0) {
    return undefined;
  }
  return state.issues[number.toString(10)];
}

function withIssue(
  state: ScenarioState,
  issue: IssueRecord
): ScenarioState {
  return {
    issues: { ...state.issues, [issue.number.toString(10)]: issue },
    order: state.order,
    labels: state.labels
  };
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

function createIssue(
  request: BehaviorRequest,
  state: ScenarioState,
  domain: DomainContext
): BehaviorResult {
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const title = body?.title;
  if (body === null || typeof title !== "string" || title.length < 1) {
    problem({
      status: 422,
      message: "Validation failed: the issue title is missing or empty."
    });
  }
  const requestBody =
    body?.body === undefined || body?.body === null
      ? null
      : String(body.body);
  // Numbers are repository-scoped handles; ids are global identities.
  // Distinct counters keep them distinct forever.
  let number = domain.ids.next("issue");
  while (state.issues[number.toString(10)] !== undefined) {
    number = domain.ids.next("issue");
  }
  const issue: IssueRecord = {
    id: domain.ids.next("issue-id") + 10_000,
    number,
    title,
    body: requestBody,
    state: "open",
    labels: [],
    pullRequest: false,
    created_at: domain.clock.now()
  };
  return {
    ...jsonResult(201, issueJson(issue)),
    nextState: {
      ...withIssue(state, issue),
      order: [...state.order, number.toString(10)]
    },
    semanticEvents: [
      {
        name: "issue.created",
        eventVersion: 1,
        payload: { number, id: issue.id }
      }
    ]
  };
}

function getIssue(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const issue = issueByNumber(state, pathInt(request, "issue_number"));
  if (issue === undefined) {
    problem({ status: 404, message: "Not found: no issue has this number." });
  }
  return jsonResult(200, issueJson(issue));
}

function listIssues(request: BehaviorRequest, state: ScenarioState): BehaviorResult {
  const query = request.parameters.query;
  const stateFilter = String(query.state ?? "open");
  if (stateFilter !== "open" && stateFilter !== "closed" && stateFilter !== "all") {
    problem({
      status: 422,
      message: "Validation failed: the state filter is not open, closed, or all."
    });
  }
  const perPage = Number(query.per_page ?? 30);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    problem({
      status: 422,
      message: "Validation failed: per_page must stay between 1 and 100."
    });
  }
  const page = Number(query.page ?? 1);
  const live = state.order
    .map((key) => state.issues[key])
    .filter((issue): issue is IssueRecord => issue !== undefined)
    .filter(
      (issue) => stateFilter === "all" || issue.state === stateFilter
    );
  const start = (page - 1) * perPage;
  const slice = live.slice(start, start + perPage);
  return jsonResult(200, slice.map(issueJson) as unknown as Json);
}

function addLabels(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const number = pathInt(request, "issue_number");
  const issue = issueByNumber(state, number);
  if (issue === undefined) {
    problem({ status: 404, message: "Not found: no issue has this number." });
  }
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const labels = body?.labels;
  if (!Array.isArray(labels) || labels.length < 1) {
    problem({
      status: 422,
      message: "Validation failed: labels must name at least one label."
    });
  }
  const resolved: LabelRecord[] = [];
  for (const name of labels) {
    const label = state.labels[String(name)];
    if (label === undefined) {
      problem({
        status: 422,
        message: `Validation failed: the label ${String(name)} is not pre-existing.`
      });
    }
    resolved.push(label);
  }
  const merged = [...issue.labels];
  for (const label of resolved) {
    if (!merged.some((existing) => existing.name === label.name)) {
      merged.push(label);
    }
  }
  const updated: IssueRecord = { ...issue, labels: merged };
  return {
    ...jsonResult(
      200,
      merged.map((label) => ({
        id: label.id,
        name: label.name,
        description: label.description
      })) as unknown as Json
    ),
    nextState: withIssue(state, updated),
    semanticEvents: [
      {
        name: "issue.labeled",
        eventVersion: 1,
        payload: { number: issue.number, labels: merged.map((l) => l.name) }
      }
    ]
  };
}

function updateIssue(
  request: BehaviorRequest,
  state: ScenarioState
): BehaviorResult {
  const number = pathInt(request, "issue_number");
  const issue = issueByNumber(state, number);
  if (issue === undefined) {
    problem({ status: 404, message: "Not found: no issue has this number." });
  }
  const raw = request.body.kind === "json" ? request.body.value : null;
  const body = isObject(raw) ? raw : null;
  const next = body?.state;
  if (body === null || next !== "closed") {
    problem({
      status: 422,
      message: "Validation failed: only closing with state closed is modeled."
    });
  }
  const updated: IssueRecord = { ...issue, state: "closed" };
  return {
    ...jsonResult(200, issueJson(updated)),
    nextState: withIssue(state, updated),
    semanticEvents: [
      { name: "issue.closed", eventVersion: 1, payload: { number: issue.number } }
    ]
  };
}

HANDLERS["POST /repos/{owner}/{repo}/issues"] = createIssue;
HANDLERS["GET /repos/{owner}/{repo}/issues"] = listIssues;
HANDLERS["GET /repos/{owner}/{repo}/issues/{issue_number}"] = getIssue;
HANDLERS["POST /repos/{owner}/{repo}/issues/{issue_number}/labels"] = addLabels;
HANDLERS["PATCH /repos/{owner}/{repo}/issues/{issue_number}"] = updateIssue;

/**
 * Build the backend for one contract. The description derives from
 * the compiled contract, so the declared keys can never drift from
 * the operations the gateway actually routes.
 */
function triageBackend(
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
            name: "issue.created",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: {
                number: { type: "integer", "minimum": 1 },
                id: { type: "integer" }
              },
              required: ["number", "id"],
              additionalProperties: false
            }
          },
          {
            name: "issue.labeled",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: {
                number: { type: "integer", "minimum": 1 },
                labels: { type: "array", items: { type: "string" } }
              },
              required: ["number", "labels"],
              additionalProperties: false
            }
          },
          {
            name: "issue.closed",
            eventVersion: 1,
            payloadSchema: {
              type: "object",
              properties: {
                number: { type: "integer", "minimum": 1 }
              },
              required: ["number"],
              additionalProperties: false
            }
          }
        ]
      };
    },
    initialize(_context: InitializeContext): Promise<InitializeResult> {
      return Promise.resolve({
        state: {
          issues: {
            // One seeded pull request: list results include it, so
            // list assertions select by number and ignore entries
            // carrying the pull_request key (section 48.7).
            "1": {
              id: 10_001,
              number: 1,
              title: "Seeded pull request entry",
              body: null,
              state: "open",
              labels: [],
              pullRequest: true,
              created_at: "2000-01-01T00:00:00.000Z"
            }
          },
          order: ["1"],
          labels: {
            [TRIAGE_LABEL]: {
              id: 9001,
              name: TRIAGE_LABEL,
              description: "Triage runs of the lab"
            }
          }
        }
      });
    },
    async handle(
      request: BehaviorRequest,
      context: HandleContext
    ): Promise<BehaviorResult> {
      const key = `${request.operation.method} ${request.operation.path_template}`;
      const handler = HANDLERS[key];
      if (handler === undefined) {
        throw new Error(`The triage backend implements no ${key} handler.`);
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
  name: "github-issue-triage",
  version: "0.1.0",
  async create(context: BackendFactoryContext): Promise<BehaviorBackend> {
    return triageBackend(context.contract);
  }
};

if (process.env.OAL_BEHAVIOR_CHILD === "1") {
  void runBehaviorChild(backend);
}
