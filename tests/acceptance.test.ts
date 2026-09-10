/**
 * Specification section 42 acceptance map. The JSON map pins every
 * acceptance criterion to the automated tests that prove it. This suite
 * keeps the map honest, not complete: every criterion is present with a
 * valid status, every referenced test file exists, every referenced test
 * title appears in its file, and the coverage counts in
 * docs/acceptance-mvp.md are generated from this map.
 *
 * Completeness is a separate gate. scripts/release-readiness.mjs fails
 * while any required criterion is partial or missing, so continuous
 * integration can stay green over an honest incomplete map.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Correction {
  /** What the corrected requirement says and why the text moved. */
  readonly summary: string;
  /** The authority for the correction, usually a specification section. */
  readonly basis: string;
}

interface Deferred {
  /** What is not enforced yet. */
  readonly summary: string;
  /** The review-plan work package ("F2".."F7") or "unassigned". */
  readonly owner: string;
}

interface AcceptanceEntry {
  readonly id: string;
  readonly group: string;
  readonly claim: string;
  readonly milestone: string;
  readonly status: "covered" | "corrected" | "partial" | "missing";
  readonly tests: readonly string[];
  /**
   * A recorded deviation from the literal criterion text. The tests still
   * enforce the criterion's intent, and docs/acceptance-mvp.md documents
   * the deviation next to the same identifier.
   */
  readonly deviation?: {
    readonly summary: string;
    readonly spec_ref: string;
    readonly enforced: string;
  };
  /** Present when the requirement text itself was corrected. */
  readonly correction?: Correction;
  /** Present on every partial or missing criterion. */
  readonly deferred?: Deferred;
  /** True when the criterion demands success through a real execution path. */
  readonly requires_live?: boolean;
  /** What the mapped tests exercise, when tests exist. */
  readonly evidence?: "live" | "constructed";
}

/** Criteria that need proof through the real writer or command path. */
const RUNTIME_PROOFS: Readonly<Record<string, readonly RegExp[]>> = {
  "AC-054": [
    /packages\/runner\/src\/trial\.test\.ts/u,
    /disposition\.test\.ts/u
  ],
  "AC-056": [/packages\/runner\/src\/exposure\.test\.ts/u],
  "AC-057": [/packages\/runner\/src\/exposure\.test\.ts/u],
  "AC-058": [/packages\/runner\/src\/exposure\.test\.ts/u],
  "AC-060": [/packages\/openapi\/tests/u, /packages\/runner\/src\/exposure/u],
  "AC-071": [/apps\/cli\/src\/report\.test\.ts/u]
};

/** Every criterion the map must carry, including the remediation set. */
const EXPECTED_IDS: readonly string[] = Array.from(
  { length: 127 },
  (_, index) => `AC-${String(index + 1).padStart(3, "0")}`
);

const OWNER_PATTERN = /^(?:unassigned|F[2-7])(?:, ?F[2-7])*$/u;

function isSatisfied(entry: AcceptanceEntry): boolean {
  if (entry.status !== "covered" && entry.status !== "corrected") {
    return false;
  }
  return entry.requires_live !== true || entry.evidence === "live";
}

describe("the acceptance map", () => {
  const mapPath = path.join(import.meta.dirname, "acceptance.map.json");
  const entriesPromise = readFile(mapPath, "utf8").then(
    (text) => JSON.parse(text) as readonly AcceptanceEntry[]
  );

  it("carries every criterion with a valid status record", async () => {
    const entries = await entriesPromise;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const problems: string[] = [];
    for (const id of EXPECTED_IDS) {
      const entry = byId.get(id);
      if (entry === undefined) {
        problems.push(`${id}: absent from the map`);
        continue;
      }
      if (entry.status === "covered" || entry.status === "corrected") {
        if (entry.tests.length === 0) {
          problems.push(`${id}: ${entry.status} with no enforcing test`);
        }
      }
      if (entry.status === "missing" && entry.tests.length > 0) {
        problems.push(`${id}: missing but names tests`);
      }
      if (entry.status === "corrected" && entry.correction === undefined) {
        problems.push(`${id}: corrected without a correction record`);
      }
      if (
        (entry.status === "partial" || entry.status === "missing") &&
        entry.deferred === undefined
      ) {
        problems.push(`${id}: ${entry.status} without a deferred record`);
      }
      if (entry.deferred !== undefined) {
        if (entry.deferred.summary.trim().length === 0) {
          problems.push(`${id}: empty deferred summary`);
        }
        if (!OWNER_PATTERN.test(entry.deferred.owner)) {
          problems.push(`${id}: deferred owner "${entry.deferred.owner}"`);
        }
      }
      if (entry.evidence !== undefined) {
        const evidence: unknown = entry.evidence;
        if (
          typeof evidence !== "string" ||
          (evidence !== "live" && evidence !== "constructed")
        ) {
          problems.push(`${id}: evidence "${String(evidence)}"`);
        }
      }
      if (
        entry.requires_live === true &&
        isSatisfied(entry) &&
        entry.evidence !== "live"
      ) {
        problems.push(
          `${id}: live criterion satisfied by constructed evidence`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("documents every deviation and correction in the acceptance report", async () => {
    const entries = await entriesPromise;
    const reported = entries.filter(
      (entry) => entry.deviation !== undefined || entry.correction !== undefined
    );
    const report = await readFile(
      path.join(import.meta.dirname, "..", "docs", "acceptance-mvp.md"),
      "utf8"
    ).catch(() => "");
    const absent = reported
      .filter((entry) => !report.includes(entry.id))
      .map((entry) => entry.id);
    expect(absent).toEqual([]);
    expect(reported.length).toBeGreaterThan(0);
  });

  it("names an existing test file for every mapped test", async () => {
    const entries = await entriesPromise;
    const referenced = new Set(
      entries
        .flatMap((entry) => entry.tests.map((test) => test.split(" > ")[0]))
        .filter((file) => file.length > 0)
    );
    const absent: string[] = [];
    for (const file of referenced) {
      const target = path.join(import.meta.dirname, "..", file);
      const text = await readFile(target, "utf8").catch(() => null);
      if (text === null) {
        absent.push(file);
      }
    }
    expect(absent).toEqual([]);
  });

  it("names a real test title for every mapped test", async () => {
    const entries = await entriesPromise;
    const byFile = new Map<string, Set<string>>();
    const absent: string[] = [];
    for (const test of new Set(entries.flatMap((e) => e.tests))) {
      const separator = test.indexOf(" > ");
      if (separator < 0) {
        absent.push(test);
        continue;
      }
      const file = test.slice(0, separator);
      const title = test.slice(separator + 3);
      let titles = byFile.get(file);
      if (titles === undefined) {
        const text = await readFile(
          path.join(import.meta.dirname, "..", file),
          "utf8"
        ).catch(() => "");
        titles = new Set(
          [
            ...text.matchAll(
              /(?:it|test)(?:\s*\.\s*\w+\s*)?\(\s*"((?:[^"\\]|\\.)*)"/gu
            )
          ]
            .map((match) => match[1])
            .filter((found): found is string => found !== undefined)
        );
        byFile.set(file, titles);
      }
      if (!titles.has(title)) {
        absent.push(test);
      }
    }
    expect(absent).toEqual([]);
  });

  it("requires real runtime proof for cross-layer claims", async () => {
    const entries = await entriesPromise;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const absent: string[] = [];
    for (const [id, patterns] of Object.entries(RUNTIME_PROOFS)) {
      const tests = byId.get(id)?.tests ?? [];
      for (const pattern of patterns) {
        if (!tests.some((test) => pattern.test(test))) {
          absent.push(`${id}: ${pattern.source}`);
        }
      }
    }
    expect(absent).toEqual([]);
  });

  it("records an owner for every open remediation work package", async () => {
    const entries = await entriesPromise;
    const owned = new Set(
      entries
        .filter((entry) => entry.deferred !== undefined)
        .flatMap(
          (entry) =>
            entry.deferred?.owner.split(",").map((part) => part.trim()) ?? []
        )
    );
    // F4 closed when the webclip negative controls landed; remove a
    // package here only when its last deferral is satisfied.
    const open = ["F2", "F3", "F5", "F6", "F7"];
    const missing = open.filter((owner) => !owned.has(owner));
    const closed = ["F4"].filter((owner) => owned.has(owner));
    expect({ missing, closed }).toEqual({ missing: [], closed: [] });
  });

  it("generates the deferred registry in the acceptance report", async () => {
    const entries = await entriesPromise;
    const expected = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (entry.deferred === undefined) {
        continue;
      }
      for (const owner of entry.deferred.owner
        .split(",")
        .map((part) => part.trim())) {
        const list = expected.get(owner) ?? new Set<string>();
        list.add(entry.id);
        expected.set(owner, list);
      }
    }
    const report = await readFile(
      path.join(import.meta.dirname, "..", "docs", "acceptance-mvp.md"),
      "utf8"
    );
    const section = report.slice(report.indexOf("## Deferred registry"));
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const line of section.split("\n")) {
      const match = /^\|\s*(F[2-7]|unassigned)[^|]*\|\s*([^|]+)\|$/.exec(line);
      if (match === null) {
        continue;
      }
      const owner = match[1];
      seen.add(owner);
      const listed = new Set(
        match[2]
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      );
      const wanted = expected.get(owner) ?? new Set<string>();
      for (const id of wanted) {
        if (!listed.has(id)) {
          problems.push(`${owner}: ${id} missing from the registry`);
        }
      }
      for (const id of listed) {
        if (!wanted.has(id)) {
          problems.push(`${owner}: registry lists ${id} without a deferral`);
        }
      }
    }
    for (const owner of expected.keys()) {
      if (!seen.has(owner)) {
        problems.push(`${owner}: no registry row`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("generates the coverage counts in the acceptance report", async () => {
    const entries = await entriesPromise;
    const statuses = ["covered", "corrected", "partial", "missing"] as const;
    type Status = (typeof statuses)[number];
    type Row = { total: number; by: Record<Status, number> };
    const emptyRow = (): Row => ({
      total: 0,
      by: { covered: 0, corrected: 0, partial: 0, missing: 0 }
    });
    const computed = new Map<string, Row>();
    for (const entry of entries) {
      const row = computed.get(entry.group) ?? emptyRow();
      row.total += 1;
      row.by[entry.status] += 1;
      computed.set(entry.group, row);
    }
    const total: Row = { total: entries.length, by: emptyRow().by };
    for (const row of computed.values()) {
      for (const status of statuses) {
        total.by[status] += row.by[status];
      }
    }
    const report = await readFile(
      path.join(import.meta.dirname, "..", "docs", "acceptance-mvp.md"),
      "utf8"
    );
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const line of report.split("\n")) {
      const match = /^\|\s*(42\.\d+|review|total)\s*\|/.exec(line);
      if (match === null) {
        continue;
      }
      // Cells: "", key, focus, criteria, covered, corrected, partial, missing, "".
      const cells = line.split("|").map((cell) => cell.trim());
      const count = Number(cells[3]);
      const numbers = cells.slice(4, 8).map((cell) => Number(cell));
      if (
        !Number.isInteger(count) ||
        numbers.some((value) => !Number.isInteger(value))
      ) {
        continue;
      }
      const key = cells[1];
      seen.add(key);
      const expected = key === "total" ? total : computed.get(key);
      if (expected === undefined) {
        problems.push(`report row "${key}" has no map group`);
        continue;
      }
      if (count !== expected.total) {
        problems.push(`${key}: total ${count} != ${expected.total}`);
      }
      statuses.forEach((status, index) => {
        if (numbers[index] !== expected.by[status]) {
          problems.push(
            `${key}: ${status} ${numbers[index]} != ${expected.by[status]}`
          );
        }
      });
    }
    for (const group of computed.keys()) {
      if (!seen.has(group)) {
        problems.push(`map group "${group}" missing from the report`);
      }
    }
    if (!seen.has("total")) {
      problems.push("report has no total row");
    }
    expect(problems).toEqual([]);
  });
});
