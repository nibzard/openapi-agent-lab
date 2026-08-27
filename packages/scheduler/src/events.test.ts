import { describe, expect, it } from "vitest";
import { SchemaValidator } from "@oal/core";
import type { Disposition, PhasePlan } from "@oal/study-ir";

import {
  activateHeldSlot,
  appendAssignmentEvent,
  assignmentEventJson,
  assignmentStates,
  blockCompletion,
  createAssignmentLedger,
  heldUnusedAssignments,
  primaryScheduleSettled,
  replacementPolicyOf,
  serializeAssignmentEvent,
  type ActivationRequest,
  type AssignmentEvent,
  type AssignmentEventDraft,
  type AssignmentLedger
} from "./events.ts";
import type { AssignmentSchedule } from "./schedule.ts";
import { buildAssignmentSchedule } from "./schedule.ts";
import {
  COHORT_SEED,
  EFFECTIVE_CONTRACTS,
  FIXTURE_CELLS,
  PHASE_PLAN_SHA256,
  PROTOCOL_LOCK_SHA256,
  STUDY_RUN_ID,
  fixtureStudy,
  loadSchema
} from "./fixtures.ts";

const eventSchema = new SchemaValidator(
  loadSchema("assignment-event.v1.schema.json")
);

const T0 = "2026-08-27T12:00:00.000Z";
const T1 = "2026-08-27T12:01:00.000Z";
const T2 = "2026-08-27T12:02:00.000Z";

/** One distinct, grammar-valid run ID per launch. */
function runIdOf(launchOrder: number): string {
  return `run_${String(launchOrder).padStart(24, "0")}`;
}

function scheduleOf(planOverride?: (plan: PhasePlan) => PhasePlan) {
  const study = fixtureStudy();
  const phasePlan = planOverride?.(study.phasePlan) ?? study.phasePlan;
  const result = buildAssignmentSchedule({
    study_run_id: STUDY_RUN_ID,
    ir: study.ir,
    phasePlan,
    protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
    phase_plan_sha256: PHASE_PLAN_SHA256,
    schedule_seed: COHORT_SEED,
    effective_contracts: EFFECTIVE_CONTRACTS,
    cell_digests: study.cellDigests
  });
  const schedule = result.schedule;
  if (schedule === null) {
    throw new Error(
      `Fixture schedule must build: ${JSON.stringify(result.diagnostics)}`
    );
  }
  return { schedule, plan: phasePlan };
}

function append(
  ledger: AssignmentLedger,
  schedule: AssignmentSchedule,
  draft: Partial<AssignmentEventDraft> & {
    assignment_id: string;
    kind: AssignmentEventDraft["kind"];
  },
  recordedAt: string = T0
): AssignmentLedger {
  const result = appendAssignmentEvent(ledger, schedule, {
    study_run_id: STUDY_RUN_ID,
    recorded_at: recordedAt,
    ...draft
  });
  if (result.event === null) {
    throw new Error(
      `Fixture event must append: ${JSON.stringify(result.diagnostics)}`
    );
  }
  return result.ledger;
}

/** Brings every primary to one terminal disposition. */
function settlePrimaries(
  schedule: AssignmentSchedule,
  disposition: Disposition = "completed"
): AssignmentLedger {
  let ledger = createAssignmentLedger(STUDY_RUN_ID);
  let order = 0;
  for (const assignment of schedule.assignments) {
    if (assignment.kind !== "primary") {
      continue;
    }
    ledger = append(ledger, schedule, {
      assignment_id: assignment.assignment_id,
      kind: "planned"
    });
    ledger = append(ledger, schedule, {
      assignment_id: assignment.assignment_id,
      kind: "launched",
      run_id: runIdOf(order)
    });
    ledger = append(ledger, schedule, {
      assignment_id: assignment.assignment_id,
      kind: "terminal",
      disposition
    });
    order += 1;
  }
  return ledger;
}

function primaryIn(
  schedule: AssignmentSchedule,
  cellId: string
): AssignmentSchedule["assignments"][number] {
  const found = schedule.assignments.find(
    (assignment) =>
      assignment.kind === "primary" && assignment.cell_id === cellId
  );
  if (found === undefined) {
    throw new Error(`Fixture schedule must hold a primary of ${cellId}.`);
  }
  return found;
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

function lastEvent(ledger: AssignmentLedger): AssignmentEvent {
  const event = ledger.events[ledger.events.length - 1];
  if (event === undefined) {
    throw new Error("Ledger must hold one event.");
  }
  return event;
}

describe("appendAssignmentEvent", () => {
  it("records a planned, launched, and terminal fact in order", () => {
    const { schedule } = scheduleOf();
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    let ledger = createAssignmentLedger(STUDY_RUN_ID);
    ledger = append(ledger, schedule, {
      assignment_id: primary.assignment_id,
      kind: "planned"
    });
    ledger = append(ledger, schedule, {
      assignment_id: primary.assignment_id,
      kind: "launched",
      run_id: runIdOf(0)
    });
    ledger = append(ledger, schedule, {
      assignment_id: primary.assignment_id,
      kind: "terminal",
      disposition: "completed",
      evidence_integrity: "intact"
    });
    expect(ledger.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(ledger.events.map((event) => event.kind)).toEqual([
      "planned",
      "launched",
      "terminal"
    ]);
    const [planned, launched, terminal] = ledger.events as [
      AssignmentEvent,
      AssignmentEvent,
      AssignmentEvent
    ];
    expect(planned.launch_order).toBeNull();
    expect(launched.launch_order).toBe(0);
    expect(terminal.launch_order).toBeNull();
    expect(terminal.disposition).toBe("completed");
    expect(terminal.evidence_integrity).toBe("intact");
    expect(planned.batch_id).toBe(primary.child_batch_id);
    for (const event of [planned, launched, terminal]) {
      expect(eventSchema.errors(assignmentEventJson(event))).toEqual([]);
      expect(event.event_id).toMatch(/^asgevt_[a-f0-9]{16}$/);
    }
  });

  it("rejects an event of a different StudyRun", () => {
    const { schedule } = scheduleOf();
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const result = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: "another-study-run",
        recorded_at: T0,
        assignment_id: primary.assignment_id,
        kind: "planned"
      }
    );
    expect(result.event).toBeNull();
    expect(result.ledger.events).toHaveLength(0);
    expect(codes(result.diagnostics)).toContain(
      "OAL-SCHEDULE-STUDY-RUN-MISMATCH"
    );
  });

  it("rejects a second event of the same kind for one assignment", () => {
    const { schedule } = scheduleOf();
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const ledger = append(createAssignmentLedger(STUDY_RUN_ID), schedule, {
      assignment_id: primary.assignment_id,
      kind: "planned"
    });
    const result = appendAssignmentEvent(ledger, schedule, {
      study_run_id: STUDY_RUN_ID,
      recorded_at: T1,
      assignment_id: primary.assignment_id,
      kind: "planned"
    });
    expect(result.event).toBeNull();
    expect(result.ledger).toBe(ledger);
    expect(codes(result.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-APPEND-INVALID"
    );
  });

  it("rejects a terminal fact without a launch and a launch after not-started", () => {
    const { schedule } = scheduleOf();
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const planned = append(createAssignmentLedger(STUDY_RUN_ID), schedule, {
      assignment_id: primary.assignment_id,
      kind: "planned"
    });
    const terminal = appendAssignmentEvent(planned, schedule, {
      study_run_id: STUDY_RUN_ID,
      recorded_at: T1,
      assignment_id: primary.assignment_id,
      kind: "terminal",
      disposition: "completed"
    });
    expect(terminal.event).toBeNull();
    expect(codes(terminal.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-TRANSITION-INVALID"
    );
    const notStarted = appendAssignmentEvent(planned, schedule, {
      study_run_id: STUDY_RUN_ID,
      recorded_at: T1,
      assignment_id: primary.assignment_id,
      kind: "not_started",
      disposition: "not_started"
    });
    expect(notStarted.event).not.toBeNull();
    const afterSkip = appendAssignmentEvent(notStarted.ledger, schedule, {
      study_run_id: STUDY_RUN_ID,
      recorded_at: T2,
      assignment_id: primary.assignment_id,
      kind: "launched",
      run_id: runIdOf(0)
    });
    expect(afterSkip.event).toBeNull();
    expect(codes(afterSkip.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-TRANSITION-INVALID"
    );
  });

  it("rejects a planned fact for a held slot and an activation for a primary", () => {
    const { schedule } = scheduleOf();
    const held = schedule.assignments.find(
      (assignment) => assignment.kind === "held_replacement"
    );
    if (held === undefined) {
      throw new Error("Fixture schedule must hold a held slot.");
    }
    const plannedForHeld = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: STUDY_RUN_ID,
        recorded_at: T0,
        assignment_id: held.assignment_id,
        kind: "planned"
      }
    );
    expect(codes(plannedForHeld.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-TRANSITION-INVALID"
    );
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const activatedForPrimary = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: STUDY_RUN_ID,
        recorded_at: T0,
        assignment_id: primary.assignment_id,
        kind: "activated",
        replacement_target: primary.assignment_id,
        inherited_block_id: primary.block_id,
        inherited_repetition_index: primary.repetition_index
      }
    );
    expect(codes(activatedForPrimary.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-TRANSITION-INVALID"
    );
  });

  it("rejects a bad timestamp, an unknown assignment, and a foreign batch", () => {
    const { schedule } = scheduleOf();
    const primary = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const badTime = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: STUDY_RUN_ID,
        recorded_at: "2026-08-27T12:00:00Z",
        assignment_id: primary.assignment_id,
        kind: "planned"
      }
    );
    expect(codes(badTime.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-APPEND-INVALID"
    );
    const unknown = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: STUDY_RUN_ID,
        recorded_at: T0,
        assignment_id: "asg_000000000000000000000000",
        kind: "planned"
      }
    );
    expect(codes(unknown.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-APPEND-INVALID"
    );
    const foreignBatch = appendAssignmentEvent(
      createAssignmentLedger(STUDY_RUN_ID),
      schedule,
      {
        study_run_id: STUDY_RUN_ID,
        recorded_at: T0,
        assignment_id: primary.assignment_id,
        kind: "planned",
        batch_id: "bat_000000000000000000000000"
      }
    );
    expect(codes(foreignBatch.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-APPEND-INVALID"
    );
  });

  it("assigns launch orders that follow the recorded order", () => {
    const { schedule } = scheduleOf();
    const first = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const second = primaryIn(schedule, FIXTURE_CELLS[1] as string);
    let ledger = createAssignmentLedger(STUDY_RUN_ID);
    ledger = append(ledger, schedule, {
      assignment_id: first.assignment_id,
      kind: "planned"
    });
    ledger = append(ledger, schedule, {
      assignment_id: first.assignment_id,
      kind: "launched",
      run_id: runIdOf(0)
    });
    const retry = appendAssignmentEvent(ledger, schedule, {
      study_run_id: STUDY_RUN_ID,
      recorded_at: T2,
      assignment_id: second.assignment_id,
      kind: "launched",
      run_id: runIdOf(0),
      launch_order: 0
    });
    expect(retry.event).toBeNull();
    expect(codes(retry.diagnostics)).toContain(
      "OAL-SCHEDULE-EVENT-APPEND-INVALID"
    );
    const next = append(ledger, schedule, {
      assignment_id: second.assignment_id,
      kind: "planned"
    });
    const launched = append(next, schedule, {
      assignment_id: second.assignment_id,
      kind: "launched",
      run_id: runIdOf(1)
    });
    expect(lastEvent(launched).launch_order).toBe(1);
  });

  it("serializes every record as one schema-valid canonical JSON line", () => {
    const { schedule } = scheduleOf();
    const ledger = settlePrimaries(schedule);
    expect(ledger.events).toHaveLength(36);
    for (const event of ledger.events) {
      const line = serializeAssignmentEvent(event);
      expect(line).not.toContain("\n");
      expect(line.startsWith("{")).toBe(true);
      expect(eventSchema.errors(assignmentEventJson(event))).toEqual([]);
    }
  });
});

describe("activateHeldSlot", () => {
  it("maps one held slot of the failed cell to exactly one primary", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const result = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const event = result.event;
    if (event === null) {
      throw new Error(
        `Fixture activation must succeed: ${JSON.stringify(result.diagnostics)}`
      );
    }
    expect(result.diagnostics).toEqual([]);
    expect(result.ledger.events).toHaveLength(settled.events.length + 1);
    expect(event.assignment_id).not.toBe(target.assignment_id);
    const chosen = schedule.assignments.find(
      (assignment) => assignment.assignment_id === event.assignment_id
    );
    expect(chosen?.cell_id).toBe(target.cell_id);
    expect(chosen?.kind).toBe("held_replacement");
    expect(event.replacement_target).toBe(target.assignment_id);
    expect(event.inherited_block_id).toBe(target.block_id);
    expect(event.inherited_repetition_index).toBe(target.repetition_index);
    expect(event.launch_order).toBeNull();
    expect(event.batch_id).toBe(chosen?.child_batch_id);
    expect(event.reason_code).toBe("infrastructure_failed_pre_control");
    expect(eventSchema.errors(assignmentEventJson(event))).toEqual([]);
  });

  it("keeps the actual later launch position of the replacement", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const activation = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const heldId = activation.event?.assignment_id ?? "";
    const launched = append(
      activation.ledger,
      schedule,
      {
        assignment_id: heldId,
        kind: "launched",
        run_id: runIdOf(12)
      },
      T2
    );
    expect(lastEvent(launched).launch_order).toBe(12);
    const finished = append(
      launched,
      schedule,
      {
        assignment_id: heldId,
        kind: "terminal",
        disposition: "completed"
      },
      T2
    );
    expect(lastEvent(finished).launch_order).toBeNull();
  });

  it("refuses a second replacement for the same primary", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const first = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const second = activateHeldSlot(
      first.ledger,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(second.event).toBeNull();
    expect(second.ledger.events).toHaveLength(first.ledger.events.length);
    expect(codes(second.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-TARGET-INVALID"
    );
  });

  it("respects the frozen per-cell activation ceiling", () => {
    const { schedule, plan } = scheduleOf();
    const cell = FIXTURE_CELLS[0] as string;
    const first = primaryIn(schedule, cell);
    const second = schedule.assignments.find(
      (assignment) =>
        assignment.kind === "primary" &&
        assignment.cell_id === cell &&
        assignment.assignment_id !== first.assignment_id
    );
    if (second === undefined) {
      throw new Error("Fixture cell must hold two primaries.");
    }
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const policy = replacementPolicyOf(plan);
    expect(policy.maximum_activated_per_cell).toBe(1);
    const one = activateHeldSlot(
      settled,
      schedule,
      policy,
      {
        failed_assignment_id: first.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(one.event).not.toBeNull();
    const two = activateHeldSlot(
      one.ledger,
      schedule,
      policy,
      {
        failed_assignment_id: second.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(two.event).toBeNull();
    expect(codes(two.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-CAPACITY-EXHAUSTED"
    );
  });

  it("refuses activation while the primary schedule is unsettled", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    let ledger = createAssignmentLedger(STUDY_RUN_ID);
    ledger = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "planned"
    });
    ledger = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "launched",
      run_id: runIdOf(0)
    });
    ledger = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "terminal",
      disposition: "infrastructure_failed_pre_control"
    });
    const result = activateHeldSlot(
      ledger,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(result.event).toBeNull();
    expect(codes(result.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-TIMING-FORBIDDEN"
    );
  });

  it("allows immediate activation only directly after the terminal fact", () => {
    const immediate = (plan: PhasePlan): PhasePlan => {
      const replacements = plan.replacements;
      if (replacements === undefined) {
        throw new Error("Fixture plan must declare replacements.");
      }
      return {
        ...plan,
        replacements: {
          ...replacements,
          activation_timing: "immediate_after_terminal"
        }
      };
    };
    const { schedule, plan } = scheduleOf(immediate);
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    let ledger = createAssignmentLedger(STUDY_RUN_ID);
    ledger = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "planned"
    });
    ledger = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "launched",
      run_id: runIdOf(0)
    });
    const terminal = append(ledger, schedule, {
      assignment_id: target.assignment_id,
      kind: "terminal",
      disposition: "infrastructure_failed_pre_control"
    });
    const quick = activateHeldSlot(
      terminal,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(quick.event).not.toBeNull();

    const later = append(
      terminal,
      schedule,
      {
        assignment_id: schedule.assignments[1]?.assignment_id ?? "",
        kind: "planned"
      },
      T1
    );
    const tooLate = activateHeldSlot(
      later,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(tooLate.event).toBeNull();
    expect(codes(tooLate.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-TIMING-FORBIDDEN"
    );
  });

  it("refuses a disposition the locked policy does not select", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    const settled = settlePrimaries(schedule, "agent_failed");
    const result = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "agent_failed"
      },
      T2
    );
    expect(result.event).toBeNull();
    expect(codes(result.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-NOT-ELIGIBLE"
    );
  });

  it("selects a held slot for corrupt evidence and records the reason", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[1] as string);
    const settled = settlePrimaries(schedule, "completed");
    const request: ActivationRequest = {
      failed_assignment_id: target.assignment_id,
      disposition: "completed",
      evidence_integrity: "corrupt"
    };
    const result = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      request,
      T2
    );
    expect(result.event).not.toBeNull();
    expect(result.event?.evidence_integrity).toBe("corrupt");
    expect(result.event?.reason_code).toBe("completed");

    const mismatch = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      { ...request, disposition: "agent_incomplete" },
      T2
    );
    expect(mismatch.event).toBeNull();
    expect(codes(mismatch.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-TARGET-INVALID"
    );
  });

  it("selects the held slot with the lowest reserve index of the cell", () => {
    const twoSlots = (plan: PhasePlan): PhasePlan => {
      const replacements = plan.replacements;
      if (replacements === undefined) {
        throw new Error("Fixture plan must declare replacements.");
      }
      return {
        ...plan,
        replacements: {
          ...replacements,
          slots_per_cell: 2,
          maximum_activated_per_cell: 2
        },
        paid_calls: { primary: 12, maximum_with_replacements: 24 }
      };
    };
    const { schedule, plan } = scheduleOf(twoSlots);
    const cell = FIXTURE_CELLS[0] as string;
    const target = primaryIn(schedule, cell);
    expect(schedule.assignments.filter((a) => a.cell_id === cell)).toHaveLength(
      4
    );
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const first = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const chosenFirst = schedule.assignments.find(
      (assignment) => assignment.assignment_id === first.event?.assignment_id
    );
    expect(chosenFirst?.reserve_index).toBe(0);

    const other = schedule.assignments.find(
      (assignment) =>
        assignment.kind === "primary" &&
        assignment.cell_id === cell &&
        assignment.assignment_id !== target.assignment_id
    );
    if (other === undefined) {
      throw new Error("Fixture cell must hold two primaries.");
    }
    const second = activateHeldSlot(
      first.ledger,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: other.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const chosenSecond = schedule.assignments.find(
      (assignment) => assignment.assignment_id === second.event?.assignment_id
    );
    expect(chosenSecond?.reserve_index).toBe(1);
  });

  it("refuses activation when the plan freezes replacement kind none", () => {
    const noReplacements = (plan: PhasePlan): PhasePlan => ({
      ...plan,
      replacements: undefined
    });
    const { schedule, plan } = scheduleOf(noReplacements);
    const target = schedule.assignments[0];
    if (target === undefined) {
      throw new Error("Fixture schedule must hold a primary.");
    }
    const settled = settlePrimaries(
      schedule,
      "infrastructure_failed_pre_control"
    );
    const result = activateHeldSlot(
      settled,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    expect(result.event).toBeNull();
    expect(codes(result.diagnostics)).toContain(
      "OAL-SCHEDULE-ACTIVATION-NOT-ELIGIBLE"
    );
  });
});

describe("assignment states and block completeness", () => {
  it("marks a never-activated held slot held_unused once the schedule settles", () => {
    const { schedule } = scheduleOf();
    const empty = createAssignmentLedger(STUDY_RUN_ID);
    expect(heldUnusedAssignments(schedule, empty)).toHaveLength(6);
    const heldId = schedule.assignments.find(
      (assignment) => assignment.kind === "held_replacement"
    )?.assignment_id;
    if (heldId === undefined) {
      throw new Error("Fixture schedule must hold a held slot.");
    }
    expect(assignmentStates(schedule, empty).get(heldId)).toBe("held");
    expect(primaryScheduleSettled(schedule, empty)).toBe(false);

    const settled = settlePrimaries(schedule);
    expect(primaryScheduleSettled(schedule, settled)).toBe(true);
    expect(assignmentStates(schedule, settled).get(heldId)).toBe("held_unused");
    expect(heldUnusedAssignments(schedule, settled)).toHaveLength(6);
    expect(
      assignmentStates(schedule, settled).get(
        schedule.assignments[0]?.assignment_id ?? ""
      )
    ).toBe("terminal");
  });

  it("reports a block incomplete until the mapped replacement terminates", () => {
    const { schedule, plan } = scheduleOf();
    const target = primaryIn(schedule, FIXTURE_CELLS[0] as string);
    let ledger = createAssignmentLedger(STUDY_RUN_ID);
    let order = 0;
    for (const assignment of schedule.assignments) {
      if (assignment.kind !== "primary") {
        continue;
      }
      const disposition =
        assignment.assignment_id === target.assignment_id
          ? "infrastructure_failed_pre_control"
          : "completed";
      ledger = append(ledger, schedule, {
        assignment_id: assignment.assignment_id,
        kind: "planned"
      });
      ledger = append(ledger, schedule, {
        assignment_id: assignment.assignment_id,
        kind: "launched",
        run_id: runIdOf(order)
      });
      ledger = append(ledger, schedule, {
        assignment_id: assignment.assignment_id,
        kind: "terminal",
        disposition
      });
      order += 1;
    }
    const open = blockCompletion(
      schedule,
      ledger,
      replacementPolicyOf(plan)
    ).find((block) =>
      block.missing_assignment_ids.includes(target.assignment_id)
    );
    expect(open?.complete).toBe(false);

    const activation = activateHeldSlot(
      ledger,
      schedule,
      replacementPolicyOf(plan),
      {
        failed_assignment_id: target.assignment_id,
        disposition: "infrastructure_failed_pre_control"
      },
      T2
    );
    const stillOpen = blockCompletion(
      schedule,
      activation.ledger,
      replacementPolicyOf(plan)
    ).find((block) => block.block_id === open?.block_id);
    expect(stillOpen?.complete).toBe(false);

    const heldId = activation.event?.assignment_id ?? "";
    const launched = append(
      activation.ledger,
      schedule,
      {
        assignment_id: heldId,
        kind: "launched",
        run_id: runIdOf(12)
      },
      T2
    );
    const finished = append(
      launched,
      schedule,
      {
        assignment_id: heldId,
        kind: "terminal",
        disposition: "completed"
      },
      T2
    );
    const complete = blockCompletion(
      schedule,
      finished,
      replacementPolicyOf(plan)
    ).find((block) => block.block_id === open?.block_id);
    expect(complete?.complete).toBe(true);
    expect(complete?.satisfied).toBe(complete?.total);
    expect(heldUnusedAssignments(schedule, finished)).toHaveLength(5);
  });

  it("summarizes every required block of the fixture", () => {
    const { schedule, plan } = scheduleOf();
    expect(
      blockCompletion(
        schedule,
        settlePrimaries(schedule),
        replacementPolicyOf(plan)
      )
    ).toEqual([
      {
        block_id: 0,
        total: 6,
        satisfied: 6,
        complete: true,
        missing_assignment_ids: []
      },
      {
        block_id: 1,
        total: 6,
        satisfied: 6,
        complete: true,
        missing_assignment_ids: []
      }
    ]);
  });
});
