/**
 * github-issue-triage corpus checks (specification section 48.7).
 * The hand-written double serves the modeled surface faithfully
 * except for at most one defect, so the eight fixed core cases pass
 * against it and a wrong close transition fails. The checks pin the
 * two distinctions the provider forces: an issue's number (the
 * repository-scoped path handle) never substitutes for its id, and
 * list results include pull-request entries, which number-based
 * selection ignores without asserting them away.
 */

import { describe, expect, it } from "vitest";

import { parseCorpus, type CorpusDocument } from "@oal/pack";
import { runCorpus, type CorpusReport } from "@oal/corpus";
import type {
  CorpusTarget,
  CorpusTargetRequest,
  CorpusTargetResponse
} from "@oal/corpus";
import type { Json, JsonObject } from "@oal/core";

import { loadGithubTriagePack } from "./index.ts";

const pack = await loadGithubTriagePack();
const corpusReference = pack.loaded.references.find(
  (reference) => reference.role === "corpus"
);
if (corpusReference === undefined) {
  throw new Error("The github-issue-triage pack declares no corpus.");
}
const corpus: CorpusDocument = parseCorpus(corpusReference.document ?? {});

const INPUTS: Readonly<Record<string, Json>> = {
  owner: "example",
  repository: "triage"
};

/** Json as text; anything else is the empty string. */
function textOf(value: Json | undefined | null): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
}

/** The defects a double can carry; one at a time. */
type Defect = "none" | "wrong-close";

/** One in-memory issue document. */
interface IssueEntry {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { id: number; name: string; description: string | null }[];
  pullRequest: boolean;
}

/**
 * A double of the modeled issue surface. It behaves faithfully
 * except for at most one defect, and it never imports the real
 * backend, so a corpus failure against it is the double's defect,
 * not a pack bug.
 */
class GithubDouble implements CorpusTarget {
  readonly id = "github-double";
  readonly version = "2026-03-10";
  readonly capabilities = { operators: false, virtualTime: false };

  private issues: IssueEntry[] = [];
  private nextNumber = 1;
  private nextId = 10001;

  constructor(private readonly defect: Defect) {}

  async prepare(): Promise<void> {
    await Promise.resolve();
    this.issues = [
      {
        id: 10000,
        number: 1,
        title: "Seeded pull request entry",
        body: null,
        state: "open",
        labels: [],
        pullRequest: true
      }
    ];
    this.nextNumber = 2;
    this.nextId = 10001;
  }

  async cleanup(): Promise<void> {
    await Promise.resolve();
  }

  async wait(): Promise<void> {}

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    await Promise.resolve();
    switch (instruction.operationId) {
      case "create_issue":
        return this.createIssue(instruction);
      case "get_issue":
        return this.getIssue(instruction);
      case "list_issues":
        return this.listIssues(instruction);
      case "add_labels":
        return this.addLabels(instruction);
      case "update_issue":
        return this.updateIssue(instruction);
      default:
        throw new Error(
          `The double implements no operation ${JSON.stringify(instruction.operationId)}.`
        );
    }
  }

  private createIssue(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const raw = instruction.body;
    const body =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as JsonObject)
        : null;
    const title = body?.title;
    if (body === null || typeof title !== "string" || title.length < 1) {
      return problem(
        422,
        "Validation failed: the issue title is missing or empty."
      );
    }
    const entry: IssueEntry = {
      id: this.nextId,
      number: this.nextNumber,
      title,
      body: typeof body.body === "string" ? body.body : null,
      state: "open",
      labels: [],
      pullRequest: false
    };
    this.nextId += 1;
    this.nextNumber += 1;
    this.issues.push(entry);
    return { status: 201, headers: {}, body: this.issueJson(entry) };
  }

  private entryOf(instruction: CorpusTargetRequest): IssueEntry | undefined {
    const number = Number(instruction.parameters.path.issue_number);
    return this.issues.find((entry) => entry.number === number);
  }

  private getIssue(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const entry = this.entryOf(instruction);
    if (entry === undefined) {
      return problem(404, "Not found: no issue has this number.");
    }
    return { status: 200, headers: {}, body: this.issueJson(entry) };
  }

  private listIssues(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const state = textOf(instruction.parameters.query.state) || "open";
    const perPage = Number(instruction.parameters.query.per_page ?? 30);
    const page = Number(instruction.parameters.query.page ?? 1);
    const filtered = this.issues.filter(
      (entry) => state === "all" || entry.state === state
    );
    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage);
    return {
      status: 200,
      headers: {},
      body: slice.map((entry) => this.issueJson(entry)) as unknown as Json
    };
  }

  private addLabels(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const entry = this.entryOf(instruction);
    if (entry === undefined) {
      return problem(404, "Not found: no issue has this number.");
    }
    const raw = instruction.body;
    const body =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as JsonObject)
        : null;
    const labels = body?.labels;
    if (!Array.isArray(labels)) {
      return problem(
        422,
        "Validation failed: labels must name at least one label."
      );
    }
    for (const name of labels) {
      const text = textOf(name);
      if (text !== "oal-triage") {
        return problem(
          422,
          `Validation failed: the label ${text} is not pre-existing.`
        );
      }
    }
    if (!entry.labels.some((label) => label.name === "oal-triage")) {
      entry.labels.push({
        id: 9001,
        name: "oal-triage",
        description: "Triage runs of the lab"
      });
    }
    return {
      status: 200,
      headers: {},
      body: entry.labels as unknown as Json
    };
  }

  private updateIssue(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const entry = this.entryOf(instruction);
    if (entry === undefined) {
      return problem(404, "Not found: no issue has this number.");
    }
    const raw = instruction.body;
    const body =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as JsonObject)
        : null;
    if (body?.state !== "closed") {
      return problem(422, "Validation failed: only closing is modeled.");
    }
    // The wrong-close defect claims the close but leaves the state
    // open, so the read after the close catches it.
    if (this.defect !== "wrong-close") {
      entry.state = "closed";
    }
    return {
      status: 200,
      headers: {},
      body: { ...this.issueJson(entry), state: "closed" }
    };
  }

  private issueJson(entry: IssueEntry): JsonObject {
    const value: JsonObject = {
      id: entry.id,
      number: entry.number,
      title: entry.title,
      body: entry.body,
      state: entry.state,
      labels: entry.labels as unknown as Json,
      created_at: "2000-01-01T00:00:00.000Z"
    };
    if (entry.pullRequest) {
      value.pull_request = {
        url: `https://api.github.com/repos/example/triage/pulls/${entry.number.toString(10)}`
      };
    }
    return value;
  }
}

function problem(status: number, message: string): CorpusTargetResponse {
  return {
    status,
    headers: {},
    body: {
      message,
      documentation_url: "https://docs.github.com/en/rest/issues/issues"
    }
  };
}

function caseOf(report: CorpusReport, id: string) {
  const found = report.cases.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`The report carries no case ${JSON.stringify(id)}.`);
  }
  return found;
}

function stepOf(report: CorpusReport, caseId: string, stepId: string) {
  const found = caseOf(report, caseId).steps.find((step) => step.id === stepId);
  if (found === undefined) {
    throw new Error(`The case carries no step ${JSON.stringify(stepId)}.`);
  }
  return found;
}

function bodyOf(step: { exchange?: { body?: Json } }): Json | null {
  return step.exchange?.body ?? null;
}

async function run(defect: Defect = "none"): Promise<CorpusReport> {
  return runCorpus(corpus, new GithubDouble(defect), { inputs: INPUTS });
}

describe("the github-issue-triage corpus", () => {
  it("passes all eight core cases against the faithful double", async () => {
    const report = await run();
    expect(report.summary).toEqual({
      passed: 8,
      failed: 0,
      skipped: 0,
      error: 0
    });
  }, 30_000);

  it("fails a wrong close transition at the read after the close", async () => {
    const report = await run("wrong-close");
    // The defect also fails the exclusion case's closed-list check
    // as collateral; the primary detection point stays the read.
    expect(report.summary).toEqual({
      passed: 6,
      failed: 2,
      skipped: 0,
      error: 0
    });
    const record = caseOf(report, "close-read");
    expect(record.status).toBe("failed");
    // The close itself claims success; the read exposes the state
    // that never moved.
    expect(stepOf(report, "close-read", "close").status).toBe("passed");
    const read = stepOf(report, "close-read", "read");
    expect(read.status).toBe("failed");
    const stateCheck = read.assertions.find(
      (assertion) =>
        assertion.op === "equals" && assertion.expected === "closed"
    );
    expect(stateCheck?.passed).toBe(false);
    expect(stateCheck?.actual).toBe("open");
    expect(record.failure_class).toBe("assertion_failure");
  }, 30_000);

  it("preserves the number and id as distinct identities", async () => {
    const report = await run();
    const create = stepOf(report, "create-read", "create");
    const body = bodyOf(create);
    expect(body).toMatchObject({ number: 2 });
    const created = body as JsonObject;
    expect(created.id).not.toBe(created.number);
    // The binding that later paths use is the number.
    const binding = create.bindings.find((entry) => entry.name === "number");
    expect(binding?.value).toBe(2);
    // The read resolved through the number and returned the same
    // issue, so the distinct id never leaked into a path.
    const read = stepOf(report, "create-read", "read");
    expect(bodyOf(read)).toMatchObject({ number: 2, id: 10001 });
  }, 30_000);

  it("ignores pull-request entries in list assertions", async () => {
    const report = await run();
    const listOpen = stepOf(report, "create-list", "list-open");
    const items = bodyOf(listOpen);
    expect(Array.isArray(items)).toBe(true);
    const entries: JsonObject[] = Array.isArray(items)
      ? (items as JsonObject[])
      : [];
    // The seeded pull request is present in the open list...
    expect(entries.some((entry) => entry.pull_request !== undefined)).toBe(
      true
    );
    // ...and the case's contains assertion selected the created issue
    // by number, passing without asserting the pull request away.
    const selection = listOpen.assertions.find(
      (assertion) => assertion.op === "contains"
    );
    expect(selection?.passed).toBe(true);
    expect(selection?.expected).toEqual({ number: 2 });
  }, 30_000);
});
