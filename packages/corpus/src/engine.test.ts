/**
 * Engine tests (specification section 48.5) against an in-memory
 * target: cases run in order against fresh worlds, bindings are
 * captured before assertions and survive later failures, every poll
 * attempt is recorded, missing bindings fail explicitly, cleanup
 * always runs once setup began, and emulator-only scope is rejected
 * before setup on targets without operator controls.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { validateSchemaInstance, type Json, type JsonObject } from "@oal/core";
import { parseCorpus } from "@oal/pack";

import { runCorpus } from "./engine.ts";
import type {
  CorpusOperatorCommand,
  CorpusTarget,
  CorpusTargetRequest,
  CorpusTargetResponse
} from "./target.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

/** An in-memory issue tracker that behaves like a small provider. */
class FakeIssueTarget implements CorpusTarget {
  readonly id = "fake";
  readonly version = "0.0.0";
  readonly capabilities;
  private issues: {
    number: number;
    title: string;
    state: string;
  }[] = [];
  private nextNumber = 1;
  private listCallCount = 0;
  /** The list stays empty until the call count passes this value. */
  hideListUntilCall = 0;
  readonly prepareCalls: string[] = [];
  readonly cleanupCalls: string[] = [];
  readonly waitCalls: number[] = [];
  readonly commands: CorpusOperatorCommand[] = [];

  constructor(operators = true) {
    this.capabilities = { operators, virtualTime: true };
  }

  async prepare(corpusCase: { readonly id: string }): Promise<void> {
    await Promise.resolve();
    this.issues = [];
    this.nextNumber = 1;
    this.listCallCount = 0;
    this.prepareCalls.push(corpusCase.id);
  }

  async cleanup(corpusCase: { readonly id: string }): Promise<void> {
    await Promise.resolve();
    this.cleanupCalls.push(corpusCase.id);
  }

  async wait(ms: number): Promise<void> {
    await Promise.resolve();
    this.waitCalls.push(ms);
  }

  async operate(command: CorpusOperatorCommand): Promise<Json> {
    await Promise.resolve();
    this.commands.push(command);
    return { ok: true, kind: command.kind };
  }

  private list(): JsonObject[] {
    this.listCallCount += 1;
    if (this.listCallCount <= this.hideListUntilCall) {
      return [];
    }
    return this.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state
    }));
  }

  async request(request: CorpusTargetRequest): Promise<CorpusTargetResponse> {
    await Promise.resolve();
    switch (request.operationId) {
      case "createIssue": {
        const body = request.body as JsonObject | undefined;
        const number = this.nextNumber;
        this.nextNumber += 1;
        const rawTitle = body?.["title"];
        const issue = {
          number,
          title: typeof rawTitle === "string" ? rawTitle : "",
          state: "open"
        };
        this.issues.push(issue);
        return {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "4999",
            "X-Auth-Token": "secret-token"
          },
          body: { ...issue },
          method: "POST",
          url: "https://fake.invalid/repos/o/r/issues"
        };
      }
      case "getIssue": {
        const number = request.parameters.path["issue_number"];
        const found = this.issues.find((issue) => issue.number === number);
        return found === undefined
          ? { status: 404, headers: {}, body: { message: "Not Found" } }
          : { status: 200, headers: {}, body: { ...found } };
      }
      case "listIssues":
        return {
          status: 200,
          headers: {},
          body: this.list(),
          method: "GET",
          url: "https://fake.invalid/repos/o/r/issues"
        };
      case "updateIssue": {
        const number = request.parameters.path["issue_number"];
        const body = request.body as JsonObject | undefined;
        const found = this.issues.find((issue) => issue.number === number);
        if (found === undefined) {
          return { status: 404, headers: {}, body: { message: "Not Found" } };
        }
        const rawState = body?.["state"];
        found.state = typeof rawState === "string" ? rawState : found.state;
        return { status: 200, headers: {}, body: { ...found } };
      }
      default:
        throw new Error(`Unknown operation ${request.operationId}.`);
    }
  }
}

/** Build one corpus from a JSON document. */
function corpusOf(value: Json): ReturnType<typeof parseCorpus> {
  return parseCorpus(value);
}

const INPUTS = { owner: "octocat", repository: "triage", marker: "run-1" };

describe("runCorpus", () => {
  it("runs cases in order and produces a schema-valid report", async () => {
    const target = new FakeIssueTarget();
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "engine-core",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [{ name: "owner" }, { name: "repository" }, { name: "marker" }],
        cases: [
          {
            id: "create-read",
            claim_ids: ["create", "read"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {
                    path: {
                      owner: { input: "owner" },
                      repo: { input: "repository" }
                    }
                  },
                  body: { title: { input: "marker" } }
                },
                bind: { number: { source: "body", pointer: "/number" } },
                assert: [{ op: "status", expected: 201 }]
              },
              {
                id: "read",
                request: {
                  operation_id: "getIssue",
                  parameters: {
                    path: { issue_number: { binding: "create.number" } }
                  }
                },
                assert: [
                  {
                    op: "equals",
                    actual: { source: "body", pointer: "/number" },
                    expected: { binding: "create.number" }
                  },
                  {
                    op: "exists",
                    actual: { source: "body", pointer: "/title" }
                  }
                ]
              }
            ],
            cleanup: [
              {
                id: "close",
                request: {
                  operation_id: "updateIssue",
                  parameters: {
                    path: { issue_number: { binding: "create.number" } }
                  },
                  body: { state: "closed" }
                },
                assert: [{ op: "status", expected: 200 }]
              }
            ]
          },
          {
            id: "two-creates",
            claim_ids: ["create"],
            scope: "black_box",
            steps: [
              {
                id: "first",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "one" }
                },
                bind: { number: { source: "body", pointer: "/number" } },
                assert: [{ op: "status", expected: 201 }]
              },
              {
                id: "second",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "two" }
                },
                assert: [{ op: "status", expected: 201 }]
              },
              {
                id: "list",
                request: { operation_id: "listIssues", parameters: {} },
                assert: [
                  {
                    op: "length",
                    actual: { source: "body", pointer: "" },
                    expected: 2
                  },
                  {
                    op: "contains",
                    actual: { source: "body", pointer: "" },
                    expected: { title: "two" }
                  },
                  {
                    op: "equals",
                    actual: { source: "body", pointer: "" },
                    expected: [
                      { number: 2, title: "two", state: "open" },
                      { number: 1, title: "one", state: "open" }
                    ],
                    set_comparison: true
                  }
                ]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: INPUTS, now: () => new Date("2026-10-10T12:00:00.000Z") }
    );

    expect(report.summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      error: 0
    });
    expect(report.generated_at).toBe("2026-10-10T12:00:00.000Z");
    expect(report.target.id).toBe("fake");
    expect(target.prepareCalls).toEqual(["create-read", "two-creates"]);
    expect(target.cleanupCalls).toEqual(["create-read", "two-creates"]);

    const createRead = report.cases[0];
    expect(createRead?.status).toBe("passed");
    expect(createRead?.behavioral_conformance).toBe("pass");
    expect(createRead?.agent_success).toBe("not_evaluated");
    expect(createRead?.steps[0]?.bindings[0]?.value).toBe(1);
    expect(createRead?.cleanup).toEqual({ status: "passed", steps: 1 });

    // Sensitive headers never enter the report; others are lowercased.
    const headers = createRead?.steps[0]?.exchange?.headers ?? {};
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "4999"
    });

    // The report validates against corpus-report.v1.
    const schema = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "schemas", "corpus-report.v1.schema.json"),
        "utf8"
      )
    ) as JsonObject;
    const violations = await validateSchemaInstance(
      schema,
      JSON.parse(JSON.stringify(report)) as Json
    );
    expect(violations).toEqual([]);
  });

  it("captures bindings before assertions and keeps cleanup usable", async () => {
    const target = new FakeIssueTarget();
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "late-failure",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "wrong-status",
            claim_ids: ["create"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                bind: { number: { source: "body", pointer: "/number" } },
                assert: [{ op: "status", expected: 999 }]
              },
              {
                id: "read-anyway",
                request: {
                  operation_id: "getIssue",
                  parameters: {
                    path: { issue_number: { binding: "create.number" } }
                  }
                },
                assert: [{ op: "status", expected: 200 }]
              }
            ],
            cleanup: [
              {
                id: "close-anyway",
                request: {
                  operation_id: "updateIssue",
                  parameters: {
                    path: { issue_number: { binding: "create.number" } }
                  },
                  body: { state: "closed" }
                },
                assert: [{ op: "status", expected: 200 }]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    const failed = report.cases[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.behavioral_conformance).toBe("fail");
    expect(failed?.steps[0]?.status).toBe("failed");
    expect(failed?.steps[0]?.bindings[0]?.value).toBe(1);
    expect(failed?.steps[1]?.status).toBe("passed");
    expect(failed?.steps[2]?.phase).toBe("cleanup");
    expect(failed?.steps[2]?.status).toBe("passed");
    expect(failed?.cleanup).toEqual({ status: "passed", steps: 1 });
  });

  it("fails a missing binding explicitly and still attempts cleanup", async () => {
    const target = new FakeIssueTarget();
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "missing-binding",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "pointer-misses",
            claim_ids: ["create"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                bind: { ghost: { source: "body", pointer: "/absent" } },
                assert: [{ op: "status", expected: 201 }]
              },
              {
                id: "needs-ghost",
                request: {
                  operation_id: "getIssue",
                  parameters: {
                    path: { issue_number: { binding: "create.ghost" } }
                  }
                },
                assert: [{ op: "status", expected: 200 }]
              }
            ],
            cleanup: [
              {
                id: "sweep",
                request: { operation_id: "listIssues", parameters: {} },
                assert: [{ op: "status", expected: 200 }]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    const failed = report.cases[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.steps[0]?.bindings[0]?.missing).toBe(true);
    expect(
      failed?.diagnostics.some(
        (entry) => entry.code === "OAL-CORPUS-BINDING-MISSING"
      )
    ).toBe(true);
    // The unresolvable reference stops the step sequence with an
    // explicit failure, and cleanup still runs.
    expect(failed?.steps[1]?.status).toBe("failed");
    expect(failed?.steps[1]?.diagnostic?.code).toBe(
      "OAL-CORPUS-BINDING-MISSING"
    );
    expect(failed?.steps[2]?.phase).toBe("cleanup");
    expect(failed?.steps[2]?.status).toBe("passed");
    expect(failed?.cleanup.steps).toBe(1);
    expect(target.cleanupCalls).toEqual(["pointer-misses"]);
  });

  it.each(["request", "wait", "cleanup"])(
    "records a poll %s exception and still attempts every cleanup",
    async (failure) => {
      const target = new FakeIssueTarget();
      target.hideListUntilCall = 100;
      const request = target.request.bind(target);
      vi.spyOn(target, "request").mockImplementation(async (instruction) => {
        if (
          instruction.operationId === "brokenRead" ||
          (failure === "request" && instruction.poll)
        ) {
          throw new Error("poll request failed");
        }
        return request(instruction);
      });
      if (failure === "wait") {
        vi.spyOn(target, "wait").mockRejectedValue(
          new Error("poll wait failed")
        );
      }
      const poll = (id: string, operationId: string): JsonObject => ({
        id,
        poll: {
          operation_id: operationId,
          parameters: {},
          attempts: 2,
          interval_ms: 1,
          deadline_ms: 100
        },
        assert: [
          { op: "length", actual: { source: "body", pointer: "" }, expected: 1 }
        ]
      });
      const report = await runCorpus(
        corpusOf({
          api_version: 1,
          id: "poll-errors",
          version: "1.0.0",
          scenario: "baseline",
          inputs: [],
          cases: [
            {
              id: "cleanup-after-poll",
              claim_ids: ["cleanup"],
              scope: "black_box",
              steps: [
                {
                  id: "create",
                  request: {
                    operation_id: "createIssue",
                    parameters: {},
                    body: { title: "test" }
                  },
                  bind: { number: { source: "body", pointer: "/number" } },
                  assert: [{ op: "status", expected: 201 }]
                },
                ...(failure === "cleanup" ? [] : [poll("read", "listIssues")])
              ],
              cleanup: [
                poll("broken-cleanup", "brokenRead"),
                {
                  id: "close",
                  request: {
                    operation_id: "updateIssue",
                    parameters: {
                      path: { issue_number: { binding: "create.number" } }
                    },
                    body: { state: "closed" }
                  },
                  assert: [{ op: "status", expected: 200 }]
                }
              ]
            }
          ]
        }),
        target
      );
      const result = report.cases[0];
      expect(result?.cleanup).toEqual({ status: "error", steps: 2 });
      expect(result?.steps.at(-1)?.status).toBe("passed");
      expect(target.cleanupCalls).toEqual(["cleanup-after-poll"]);
      expect(
        report.diagnostics.some(
          (entry) => entry.message === "poll request failed"
        )
      ).toBe(true);
      expect(result?.status).toBe("error");
      expect(result?.failure_class).toBe("runtime_error");
      if (failure !== "cleanup") {
        expect(result?.steps[1]?.attempts).toHaveLength(
          failure === "wait" ? 1 : 0
        );
      }
    }
  );

  it("records every poll attempt and fails exhaustion", async () => {
    const target = new FakeIssueTarget();
    target.hideListUntilCall = 1;
    const poll = {
      id: "wait-for-list",
      poll: {
        operation_id: "listIssues",
        parameters: {},
        attempts: 3,
        interval_ms: 5,
        deadline_ms: 100
      },
      assert: [
        {
          op: "length",
          actual: { source: "body", pointer: "" },
          expected: 1
        }
      ]
    };
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "polls",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "poll-recovers",
            claim_ids: ["list"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                assert: [{ op: "status", expected: 201 }]
              },
              poll
            ]
          },
          {
            id: "poll-exhausts",
            claim_ids: ["list"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                assert: [{ op: "status", expected: 201 }]
              },
              {
                ...poll,
                id: "wait-forever",
                poll: {
                  ...poll.poll,
                  attempts: 3
                },
                assert: [
                  {
                    op: "length",
                    actual: { source: "body", pointer: "" },
                    expected: 99
                  }
                ]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    const recovered = report.cases[0];
    expect(recovered?.status).toBe("passed");
    const attempts = recovered?.steps[1]?.attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.waited_ms).toBe(0);
    expect(attempts[0]?.passed).toBe(false);
    expect(attempts[1]?.waited_ms).toBe(5);
    expect(attempts[1]?.passed).toBe(true);
    expect(recovered?.steps[1]?.status).toBe("passed");

    const exhausted = report.cases[1];
    expect(exhausted?.status).toBe("failed");
    expect(exhausted?.steps[1]?.attempts).toHaveLength(3);
    expect(
      exhausted?.diagnostics.some(
        (entry) => entry.code === "OAL-CORPUS-POLL-EXHAUSTED"
      )
    ).toBe(true);
    expect(target.waitCalls).toEqual([5, 5, 5]);
  });

  it("skips emulator-only cases before setup without operator controls", async () => {
    const target = new FakeIssueTarget(false);
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "scopes",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "hidden-state",
            claim_ids: ["reset"],
            scope: "emulator_only",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                assert: [{ op: "status", expected: 201 }]
              },
              { id: "reset", operator: { kind: "reset" } }
            ]
          },
          {
            id: "plain",
            claim_ids: ["create"],
            scope: "black_box",
            steps: [
              {
                id: "create",
                request: {
                  operation_id: "createIssue",
                  parameters: {},
                  body: { title: "t" }
                },
                assert: [{ op: "status", expected: 201 }]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    const hidden = report.cases[0];
    expect(hidden?.status).toBe("skipped");
    expect(hidden?.skip_reason).toContain("operator controls");
    expect(hidden?.behavioral_conformance).toBe("not_evaluated");
    expect(hidden?.steps).toEqual([]);
    expect(report.summary.skipped).toBe(1);
    expect(report.cases[1]?.status).toBe("passed");
    expect(target.prepareCalls).toEqual(["plain"]);
  });

  it("dispatches operator steps and records their results", async () => {
    const target = new FakeIssueTarget();
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "operators",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "advance-and-inspect",
            claim_ids: ["time"],
            scope: "emulator_only",
            steps: [
              {
                id: "advance",
                operator: { kind: "advance_time", by_ms: 250 }
              },
              {
                id: "inspect",
                operator: { kind: "inspect" },
                assert: [
                  { op: "exists", actual: { source: "body", pointer: "/kind" } }
                ]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    expect(report.cases[0]?.status).toBe("passed");
    expect(target.commands).toEqual([
      { kind: "advance_time", byMs: 250 },
      { kind: "inspect" }
    ]);
    expect(report.cases[0]?.steps[0]?.operator_result).toEqual({
      ok: true,
      kind: "advance_time"
    });
    expect(report.cases[0]?.steps[1]?.assertions[0]?.passed).toBe(true);
  });

  it("treats a target failure as an error and still tears down", async () => {
    const target = new FakeIssueTarget();
    const report = await runCorpus(
      corpusOf({
        api_version: 1,
        id: "transport",
        version: "1.0.0",
        scenario: "baseline",
        inputs: [],
        cases: [
          {
            id: "unknown-operation",
            claim_ids: ["create"],
            scope: "black_box",
            steps: [
              {
                id: "boom",
                request: {
                  operation_id: "deployCluster",
                  parameters: {}
                },
                assert: [{ op: "status", expected: 200 }]
              },
              {
                id: "never-runs",
                request: { operation_id: "listIssues", parameters: {} },
                assert: [{ op: "status", expected: 200 }]
              }
            ],
            cleanup: [
              {
                id: "sweep",
                request: { operation_id: "listIssues", parameters: {} },
                assert: [{ op: "status", expected: 200 }]
              }
            ]
          }
        ]
      }),
      target,
      { inputs: {} }
    );

    const errored = report.cases[0];
    expect(errored?.status).toBe("error");
    expect(errored?.behavioral_conformance).toBe("not_evaluated");
    expect(errored?.steps[0]?.diagnostic?.code).toBe(
      "OAL-CORPUS-TARGET-FAILED"
    );
    // The sequence stops, cleanup still runs, and the world tears down.
    expect(errored?.steps.some((step) => step.id === "never-runs")).toBe(false);
    expect(errored?.cleanup.steps).toBe(1);
    expect(target.cleanupCalls).toEqual(["unknown-operation"]);
  });
});
