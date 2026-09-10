#!/usr/bin/env node
/**
 * Release readiness gate. Reads tests/acceptance.map.json and fails while
 * any criterion of a required milestone is not satisfied.
 *
 * A criterion satisfies readiness when its status is covered or corrected
 * and, when the criterion requires a live successful task, the recorded
 * evidence is live. A corrected criterion satisfies the gate because the
 * corrected requirement is fully enforced; a partial or missing criterion
 * never does, however much of it is enforced.
 *
 * This gate is deliberately outside `pnpm run ci`: continuous integration
 * verifies that the map is honest, not that the product is complete. Run
 * it when you intend to publish: exit 0 means every required outcome has
 * passing evidence, exit 1 lists the blocking criteria.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mapPath = new URL("../tests/acceptance.map.json", import.meta.url);

/** Milestones a release must satisfy, in gate order. */
const REQUIRED_MILESTONES = [
  "raw-http-mvp",
  "agent-native-tools",
  "workflow",
  "research-protocol",
  "review-remediation"
];

const VALID_STATUSES = new Set(["covered", "corrected", "partial", "missing"]);

/**
 * @param {readonly unknown[]} entries
 * @returns {{ok: boolean, blocking: Array<{id: string, milestone: string, status: string, owner: string, summary: string}>, counts: Record<string, number>}}
 */
export function evaluateReadiness(entries) {
  const blocking = [];
  const counts = {};
  for (const entry of entries) {
    const record = /** @type {any} */ (entry);
    if (!VALID_STATUSES.has(record.status)) {
      throw new Error(`${record.id}: unknown status ${record.status}`);
    }
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    const satisfiedStatus =
      record.status === "covered" || record.status === "corrected";
    const liveEvidence =
      record.requires_live !== true || record.evidence === "live";
    if (satisfiedStatus && liveEvidence) {
      continue;
    }
    const deferred = record.deferred ?? {};
    blocking.push({
      id: record.id,
      milestone: record.milestone ?? "unknown",
      status: satisfiedStatus ? "constructed-evidence" : record.status,
      owner: deferred.owner ?? "unassigned",
      summary: deferred.summary ?? record.correction?.summary ?? ""
    });
  }
  return { ok: blocking.length === 0, blocking, counts };
}

async function main() {
  const input =
    process.argv[2] === undefined
      ? mapPath
      : new URL(`file://${path.resolve(process.argv[2])}`);
  const entries = JSON.parse(await readFile(input, "utf8"));
  const { ok, blocking, counts } = evaluateReadiness(entries);
  const byMilestone = new Map();
  for (const item of blocking) {
    const list = byMilestone.get(item.milestone) ?? [];
    list.push(item);
    byMilestone.set(item.milestone, list);
  }
  const lines = [];
  lines.push("Release readiness");
  lines.push(
    `criteria: ${entries.length} ` +
      `(covered ${counts.covered ?? 0}, corrected ${counts.corrected ?? 0}, ` +
      `partial ${counts.partial ?? 0}, missing ${counts.missing ?? 0})`
  );
  const milestones = [
    ...REQUIRED_MILESTONES,
    ...[...byMilestone.keys()].filter(
      (name) => !REQUIRED_MILESTONES.includes(name)
    )
  ];
  for (const milestone of milestones) {
    const list = byMilestone.get(milestone) ?? [];
    lines.push(
      `${milestone}: ${list.length === 0 ? "ready" : `${list.length} blocking`}`
    );
    for (const item of list) {
      lines.push(
        `  ${item.id} [${item.status}] owner ${item.owner}: ${item.summary}`
      );
    }
  }
  console.log(lines.join("\n"));
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
