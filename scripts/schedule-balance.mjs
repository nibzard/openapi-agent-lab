/**
 * Scheduler-level nightly check for the specification section 36.2 lane
 * "repeated same-seed schedule materialization and shuffled-order
 * balance checks".
 *
 * The per-run invariants are already unit tested in
 * `packages/scheduler/src/schedule.test.ts`. This probe adds the
 * repeated, aggregate form the nightly lane asks for:
 *
 * 1. Same-seed materialization. Building the fixture schedule five
 *   times from one seed must repeat the canonical bytes and digest.
 * 2. Input-order invariance. Recompiling the fixture study with six
 *   shuffled member-map orders must leave the schedule bytes unchanged.
 * 3. Balance inside one schedule. Every block holds each cell exactly
 *   once, and every cell receives the same number of primary and held
 *   slots.
 * 4. Shuffle-order balance across seeds. Over 120 seeds, the cell order
 *   of the first block must spread evenly: no position/cell count below
 *   half or above double the even share.
 *
 * The probe loads the scheduler and study compiler source directly, so
 * it re-executes itself once with `--experimental-transform-types`, the
 * same way `scripts/perf-probe.mjs` does.
 *
 * Exit codes: 0 when every check passes, 1 on a check failure, 2 on an
 * operational error.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Node flag that lets plain node load the TypeScript workspace source. */
const TRANSFORM_FLAG = "--experimental-transform-types";

/** Repeats of the identical build in check 1. */
const REPEAT_BUILDS = 5;

/** Shuffled member-map orders in check 2. */
const SHUFFLED_ORDERS = 6;

/** Seeds swept in check 4. */
const SEED_SWEEP = 120;

/** Allowed deviation of one position/cell count from the even share. */
const BALANCE_LOW_SHARE = 0.5;
const BALANCE_HIGH_SHARE = 2;

/** Re-executes the script with type transformation when it is missing. */
function ensureTransformSupport(self) {
  if (process.execArgv.includes(TRANSFORM_FLAG)) {
    return;
  }
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", TRANSFORM_FLAG, self, ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 2);
}

/** Deterministic 32-bit generator for reproducible shuffles. */
function lehmer(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 48271) + 11) >>> 0;
    return state / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by an independent generator. */
function shuffled(entries, nextFloat) {
  const copy = [...entries];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(nextFloat() * (index + 1));
    const held = copy[index];
    copy[index] = copy[pick];
    copy[pick] = held;
  }
  return copy;
}

/** Collects the failures of every check. */
async function run() {
  const {
    buildAssignmentSchedule,
    serializeAssignmentSchedule,
    assignmentScheduleSha256
  } = await import(
    new URL("../packages/scheduler/src/index.ts", import.meta.url)
  );
  const {
    EFFECTIVE_CONTRACTS,
    PHASE_PLAN_SHA256,
    PROTOCOL_LOCK_SHA256,
    STUDY_RUN_ID,
    COHORT_SEED,
    baseMembers,
    baseProtocolDoc,
    fixtureStudy,
    loadSchema
  } = await import(
    new URL("../packages/scheduler/src/fixtures.ts", import.meta.url)
  );
  const { compileStudy } = await import(
    new URL("../packages/study-ir/src/index.ts", import.meta.url)
  );

  const failures = [];
  const study = fixtureStudy();
  const build = (ir, seed) => {
    const result = buildAssignmentSchedule({
      study_run_id: STUDY_RUN_ID,
      ir,
      phasePlan: study.phasePlan,
      protocol_lock_sha256: PROTOCOL_LOCK_SHA256,
      phase_plan_sha256: PHASE_PLAN_SHA256,
      schedule_seed: seed,
      effective_contracts: EFFECTIVE_CONTRACTS,
      cell_digests: study.cellDigests
    });
    if (result.schedule === null) {
      throw new Error(
        `fixture schedule must build: ${JSON.stringify(result.diagnostics)}`
      );
    }
    return result.schedule;
  };

  // Check 1: repeated same-seed materialization.
  const materialized = [];
  for (let index = 0; index < REPEAT_BUILDS; index += 1) {
    const schedule = build(study.ir, COHORT_SEED);
    materialized.push(serializeAssignmentSchedule(schedule));
  }
  const uniqueMaterializations = new Set(materialized).size;
  if (uniqueMaterializations !== 1) {
    failures.push(
      `same-seed materialization: ${REPEAT_BUILDS} builds produced ` +
        `${uniqueMaterializations} distinct documents`
    );
  }
  console.log(
    `same-seed materialization: ${REPEAT_BUILDS} builds, ` +
      `${uniqueMaterializations} distinct document, digest ` +
      `${assignmentScheduleSha256(build(study.ir, COHORT_SEED)).slice(0, 16)}...`
  );

  // Check 2: shuffling the member-map order must not move the schedule.
  const memberOrders = new Set();
  const protocol = baseProtocolDoc();
  for (let index = 0; index < SHUFFLED_ORDERS; index += 1) {
    const nextFloat = lehmer(0x5eed0000 + index);
    const members = new Map(shuffled([...baseMembers()], nextFloat));
    const compiled = compileStudy(protocol, {
      schema: loadSchema("study-ir.v1.schema.json"),
      members
    });
    if (compiled.ir === null) {
      failures.push(`member order ${index}: fixture study failed to recompile`);
      continue;
    }
    memberOrders.add(assignmentScheduleSha256(build(compiled.ir, COHORT_SEED)));
  }
  if (memberOrders.size !== 1) {
    failures.push(
      `member-order invariance: ${SHUFFLED_ORDERS} shuffled orders ` +
        `produced ${memberOrders.size} distinct schedule digests`
    );
  } else {
    console.log(
      `member-order invariance: ${SHUFFLED_ORDERS} shuffled orders, ` +
        `one schedule digest`
    );
  }

  // Check 3: balance inside one schedule.
  const schedule = build(study.ir, COHORT_SEED);
  const primaries = schedule.assignments.filter(
    (assignment) => assignment.kind === "primary"
  );
  const held = schedule.assignments.filter(
    (assignment) => assignment.kind !== "primary"
  );
  const countByCell = (records) => {
    const counts = new Map();
    for (const record of records) {
      counts.set(record.cell_id, (counts.get(record.cell_id) ?? 0) + 1);
    }
    return counts;
  };
  const perCell = countByCell(primaries);
  const heldPerCell = countByCell(held);
  const primaryShares = [...perCell.values()];
  if (new Set(primaryShares).size > 1) {
    failures.push(
      `cell balance: primary counts differ across cells: ` +
        `${JSON.stringify([...perCell.entries()])}`
    );
  }
  if (new Set([...heldPerCell.values()]).size > 1) {
    failures.push(
      `cell balance: held counts differ across cells: ` +
        `${JSON.stringify([...heldPerCell.entries()])}`
    );
  }
  const blocks = new Map();
  for (const assignment of primaries) {
    const key = assignment.block_id;
    const cells = blocks.get(key) ?? new Set();
    cells.add(assignment.cell_id);
    blocks.set(key, cells);
  }
  const cellCount = perCell.size;
  for (const [blockId, cells] of blocks) {
    if (cells.size !== cellCount) {
      failures.push(
        `block completeness: block ${blockId} holds ${cells.size} of ` +
          `${cellCount} cells`
      );
    }
  }
  console.log(
    `schedule balance: ${primaries.length} primary and ${held.length} ` +
      `held assignments, ${perCell.get([...perCell.keys()][0])} primary ` +
      `per cell, ${blocks.size} complete blocks`
  );

  // Check 4: first-block cell order across seeds spreads evenly.
  const orderCounts = new Map();
  const orders = new Set();
  for (let index = 0; index < SEED_SWEEP; index += 1) {
    const seeded = build(study.ir, `${COHORT_SEED}-sweep-${index}`);
    const firstBlock = seeded.assignments
      .filter(
        (assignment) =>
          assignment.kind === "primary" && assignment.block_id === 0
      )
      .map((assignment) => assignment.cell_id);
    orders.add(firstBlock.join("|"));
    firstBlock.forEach((cellId, position) => {
      const key = `${position}:${cellId}`;
      orderCounts.set(key, (orderCounts.get(key) ?? 0) + 1);
    });
  }
  const even = SEED_SWEEP / cellCount;
  for (const [key, count] of [...orderCounts.entries()].sort()) {
    if (count < BALANCE_LOW_SHARE * even || count > BALANCE_HIGH_SHARE * even) {
      failures.push(
        `shuffle-order balance: position/cell ${key} appeared ${count} ` +
          `times, outside ${BALANCE_LOW_SHARE}x to ${BALANCE_HIGH_SHARE}x ` +
          `of the even share ${even.toFixed(1)}`
      );
    }
  }
  console.log(
    `shuffle-order balance: ${SEED_SWEEP} seeds, ${orders.size} distinct ` +
      `first-block orders, even share ${even.toFixed(1)} per position/cell`
  );

  for (const failure of failures) {
    console.error(`schedule-balance: FAIL ${failure}`);
  }
  console.log(
    `schedule-balance: ${failures.length === 0 ? "all checks passed" : `${failures.length} check failures`}`
  );
  return failures.length === 0 ? 0 : 1;
}

const self = fileURLToPath(import.meta.url);
ensureTransformSupport(self);
process.exit(await run());
