import { describe, expect, it } from "vitest";

import {
  CensorCode,
  DispositionCode,
  TERMINAL_DISPOSITIONS,
  classifyCensorClass,
  classifyDisposition,
  evidenceIntegrityOf,
  harnessAborted,
  retryLineage,
  type DispositionInput,
  type EvidenceRequirement
} from "./disposition.ts";

function input(overrides: Partial<DispositionInput> = {}): DispositionInput {
  return {
    snapshot: { stages: new Set<string>() },
    operatorSignal: null,
    timeoutFiredAtMs: null,
    budgetExhaustedAtMs: null,
    invalidSetupCode: null,
    failure: null,
    exit: null,
    notStarted: false,
    unfinalizedLedger: false,
    ...overrides
  };
}

const CONTROL = new Set<string>(["participant_control_started"]);
const SPAWNED = new Set<string>(["participant_spawned"]);
const COMPLETED = new Set<string>([
  "participant_spawned",
  "participant_control_started",
  "turn_completed"
]);

describe("classifyDisposition", () => {
  it("keeps every terminal disposition of section 22.4", () => {
    expect(TERMINAL_DISPOSITIONS.length).toBe(13);
  });

  it("rule 1: an operator signal before any fired limit wins", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: CONTROL },
        operatorSignal: { signal: "SIGINT", receivedAtMs: 100 },
        timeoutFiredAtMs: 200
      })
    );
    expect(outcome.disposition).toBe("operator_interrupted");
    expect(outcome.reasonCode).toBe(DispositionCode.OperatorInterrupted);
  });

  it("rule 1 does not apply once the timeout fired first", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: COMPLETED },
        operatorSignal: { signal: "SIGINT", receivedAtMs: 300 },
        timeoutFiredAtMs: 100
      })
    );
    expect(outcome.disposition).toBe("timed_out");
  });

  it("rules 2 and 3: fired limits", () => {
    expect(
      classifyDisposition(input({ timeoutFiredAtMs: 10 })).disposition
    ).toBe("timed_out");
    expect(
      classifyDisposition(input({ budgetExhaustedAtMs: 10 })).disposition
    ).toBe("budget_exhausted");
  });

  it("rule 4: invalid setup before any spawn", () => {
    const outcome = classifyDisposition(
      input({ invalidSetupCode: "OAL-RUN-SETUP-FAILED" })
    );
    expect(outcome.disposition).toBe("invalid_setup");
    expect(outcome.reasonCode).toBe("OAL-RUN-SETUP-FAILED");
  });

  it("rule 4 never overrides a spawned participant", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: SPAWNED },
        invalidSetupCode: "OAL-RUN-SETUP-FAILED"
      })
    );
    expect(outcome.disposition).toBe("agent_incomplete");
  });

  it("rule 5: provider and infrastructure split at control start", () => {
    expect(
      classifyDisposition(input({ failure: { kind: "provider", code: "P" } }))
        .disposition
    ).toBe("provider_failed_pre_control");
    expect(
      classifyDisposition(
        input({
          snapshot: { stages: CONTROL },
          failure: { kind: "provider", code: "P" }
        })
      ).disposition
    ).toBe("provider_failed_post_control");
    expect(
      classifyDisposition(
        input({ failure: { kind: "infrastructure", code: "I" } })
      ).disposition
    ).toBe("infrastructure_failed_pre_control");
    expect(
      classifyDisposition(
        input({
          snapshot: { stages: CONTROL },
          failure: { kind: "infrastructure", code: "I" }
        })
      ).disposition
    ).toBe("infrastructure_failed_post_control");
  });

  it("rule 6: a nonzero exit after control is an agent failure", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: CONTROL },
        exit: { code: 3, signal: null }
      })
    );
    expect(outcome.disposition).toBe("agent_failed");
    expect(outcome.reasonCode).toBe(DispositionCode.AgentFailed);
  });

  it("rule 7: a persisted turn completion completes the trial", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: COMPLETED },
        exit: { code: 0, signal: null }
      })
    );
    expect(outcome.disposition).toBe("completed");
  });

  it("rule 8: exit zero without a turn completion stays incomplete", () => {
    const outcome = classifyDisposition(
      input({
        snapshot: { stages: new Set<string>([...SPAWNED, ...CONTROL]) },
        exit: { code: 0, signal: null }
      })
    );
    expect(outcome.disposition).toBe("agent_incomplete");
  });

  it("rules 9 and 10: never started and recovered ledger", () => {
    expect(classifyDisposition(input({ notStarted: true })).disposition).toBe(
      "not_started"
    );
    expect(
      classifyDisposition(input({ unfinalizedLedger: true })).disposition
    ).toBe("harness_aborted");
  });

  it("derives harness aborted only for an unfinalized ledger", () => {
    expect(harnessAborted(false)).toBe(null);
    expect(harnessAborted(true)?.disposition).toBe("harness_aborted");
  });
});

describe("classifyCensorClass", () => {
  const ok: readonly EvidenceRequirement[] = [
    { id: "api_trace", status: "ok" },
    { id: "lifecycle_ledger", status: "ok" }
  ];

  it("rule 1: no control start censors as pre-control", () => {
    const outcome = classifyCensorClass({
      disposition: "completed",
      controlStarted: false,
      requirements: ok
    });
    expect(outcome.censorClass).toBe("pre_control_nonparticipant");
    expect(outcome.reasonCode).toBe(CensorCode.PreControlNonParticipant);
  });

  it("rule 2: operator interruption and recovery censor administratively", () => {
    expect(
      classifyCensorClass({
        disposition: "operator_interrupted",
        controlStarted: true,
        requirements: ok
      }).censorClass
    ).toBe("administrative_censor");
    expect(
      classifyCensorClass({
        disposition: "harness_aborted",
        controlStarted: true,
        requirements: ok
      }).censorClass
    ).toBe("administrative_censor");
  });

  it("rule 3: a failed requirement censors as instrumentation", () => {
    const outcome = classifyCensorClass({
      disposition: "agent_failed",
      controlStarted: true,
      requirements: [
        ...ok,
        { id: "session_events", status: "missing" as const },
        { id: "api_trace", status: "corrupt" as const }
      ]
    });
    expect(outcome.censorClass).toBe("instrumentation_censor");
    expect([...outcome.failedRequirements]).toEqual([
      "session_events",
      "api_trace"
    ]);
  });

  it("rule 4: a participant failure on intact evidence never censors", () => {
    expect(
      classifyCensorClass({
        disposition: "agent_failed",
        controlStarted: true,
        requirements: ok
      }).censorClass
    ).toBe("none");
  });
});

describe("evidenceIntegrityOf", () => {
  it("returns intact, corrupt, and missing in that precedence", () => {
    expect(evidenceIntegrityOf([])).toBe("intact");
    expect(
      evidenceIntegrityOf([
        { id: "a", status: "ok" as const },
        { id: "b", status: "missing" as const }
      ])
    ).toBe("missing");
    expect(
      evidenceIntegrityOf([
        { id: "a", status: "missing" as const },
        { id: "b", status: "corrupt" as const }
      ])
    ).toBe("corrupt");
  });
});

describe("retryLineage", () => {
  it("records the immutable link to the failed attempt", () => {
    const lineage = retryLineage({
      runId: "run-2",
      retryOf: "run-1",
      attempt: 2,
      reasonCode: "OAL-PROVIDER-UNAVAILABLE",
      disposition: "provider_failed_post_control"
    });
    expect(lineage.attempt).toBe(2);
    expect(lineage.retryOf).toBe("run-1");
  });

  it("rejects the first attempt and unsafe identifiers", () => {
    expect(() =>
      retryLineage({
        runId: "run-1",
        retryOf: "run-0",
        attempt: 1,
        reasonCode: "OAL-PROVIDER-UNAVAILABLE",
        disposition: "provider_failed_post_control"
      })
    ).toThrowError(/at least 2/u);
    expect(() =>
      retryLineage({
        runId: "../escape",
        retryOf: "run-0",
        attempt: 2,
        reasonCode: "OAL-PROVIDER-UNAVAILABLE",
        disposition: "provider_failed_post_control"
      })
    ).toThrowError(/safe run identifiers/u);
  });
});
