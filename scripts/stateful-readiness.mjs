#!/usr/bin/env node
/**
 * Stateful environments readiness gate. Reads
 * tests/stateful-acceptance.map.json and fails while any plan task
 * (SE-P0-01 through SE-P6-03) is pending or partial, or while a task
 * that requires live provider verification was completed without a
 * recorded live pass. A recorded provider skip never satisfies this
 * gate; it blocks completion of the task it belongs to.
 *
 * The gate is deliberately outside `pnpm run ci`: continuous
 * integration verifies that the map is honest, not that the milestone
 * is finished. Exit 0 means every task has passing evidence; exit 1
 * lists the blocking tasks.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mapPath = new URL(
  "../tests/stateful-acceptance.map.json",
  import.meta.url
);

const PHASES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];
const VALID_STATUSES = new Set(["pending", "partial", "complete"]);

/**
 * @param {readonly unknown[]} tasks
 * @returns {{ok: boolean, blocking: Array<{id: string, phase: string, status: string, summary: string}>, counts: Record<string, number>}}
 */
export function evaluateStatefulReadiness(tasks) {
  const blocking = [];
  const counts = {};
  for (const entry of tasks) {
    const task = /** @type {any} */ (entry);
    if (!VALID_STATUSES.has(task.status)) {
      throw new Error(`${task.id}: unknown status ${task.status}`);
    }
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    if (task.status === "complete") {
      if (
        task.requires_live_provider === true &&
        task.evidence?.live_provider !== true
      ) {
        blocking.push({
          id: task.id,
          phase: task.phase ?? "unknown",
          status: "provider-skip",
          summary:
            "Required live provider verification was skipped or not recorded; a skip never completes this task."
        });
      }
      continue;
    }
    blocking.push({
      id: task.id,
      phase: task.phase ?? "unknown",
      status: task.status,
      summary: task.remaining ?? ""
    });
  }
  return { ok: blocking.length === 0, blocking, counts };
}

async function main() {
  const input =
    process.argv[2] === undefined
      ? mapPath
      : new URL(`file://${path.resolve(process.argv[2])}`);
  const map = JSON.parse(await readFile(input, "utf8"));
  const { ok, blocking, counts } = evaluateStatefulReadiness(map.tasks);
  const byPhase = new Map();
  for (const item of blocking) {
    const list = byPhase.get(item.phase) ?? [];
    list.push(item);
    byPhase.set(item.phase, list);
  }
  const lines = [];
  lines.push("Stateful environments readiness");
  lines.push(
    `tasks: ${map.tasks.length} ` +
      `(complete ${counts.complete ?? 0}, partial ${counts.partial ?? 0}, ` +
      `pending ${counts.pending ?? 0})`
  );
  for (const phase of [
    ...PHASES,
    ...[...byPhase.keys()].filter((name) => !PHASES.includes(name))
  ]) {
    const list = byPhase.get(phase) ?? [];
    lines.push(
      `${phase}: ${list.length === 0 ? "ready" : `${list.length} blocking`}`
    );
    for (const item of list) {
      lines.push(`  ${item.id} [${item.status}]: ${item.summary}`);
    }
  }
  console.log(lines.join("\n"));
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
