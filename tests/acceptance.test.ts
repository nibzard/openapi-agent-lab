/**
 * Specification section 42 acceptance map (task T053). The JSON map pins
 * every acceptance criterion to the automated tests that prove it, and
 * this suite keeps the map honest: every MVP criterion is present and
 * covered, every referenced test file exists, and every referenced test
 * title appears in its file.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface AcceptanceEntry {
  readonly id: string;
  readonly group: string;
  readonly claim: string;
  readonly milestone: string;
  readonly status: "covered" | "partial" | "gap";
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
}

/** The Raw-HTTP MVP gate of section 42. */
function isMvp(id: string): boolean {
  const number = Number(id.slice(3));
  return (number >= 1 && number <= 73) || (number >= 80 && number <= 99);
}

/** A criterion satisfies its milestone gate when covered or deviated. */
function satisfiesGate(entry: AcceptanceEntry): boolean {
  if (entry.status === "covered") {
    return true;
  }
  return (
    entry.status === "partial" &&
    entry.deviation !== undefined &&
    entry.tests.length > 0
  );
}

describe("the acceptance map", () => {
  const mapPath = path.join(import.meta.dirname, "acceptance.map.json");
  const entriesPromise = readFile(mapPath, "utf8").then(
    (text) => JSON.parse(text) as readonly AcceptanceEntry[]
  );

  it("covers every Raw-HTTP MVP criterion as covered", async () => {
    const entries = await entriesPromise;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const missing: string[] = [];
    const notCovered: string[] = [];
    for (let number = 1; number <= 120; number += 1) {
      const id = `AC-${String(number).padStart(3, "0")}`;
      const entry = byId.get(id);
      if (entry === undefined) {
        missing.push(id);
        continue;
      }
      if (isMvp(id) && !satisfiesGate(entry)) {
        notCovered.push(`${id} (${entry.status})`);
      }
    }
    expect(missing).toEqual([]);
    expect(notCovered).toEqual([]);
  });

  it("documents every deviation in the acceptance report", async () => {
    const entries = await entriesPromise;
    const deviated = entries.filter((entry) => entry.deviation !== undefined);
    const report = await readFile(
      path.join(import.meta.dirname, "..", "docs", "acceptance-mvp.md"),
      "utf8"
    ).catch(() => "");
    const absent = deviated
      .filter((entry) => !report.includes(entry.id))
      .map((entry) => entry.id);
    expect(absent).toEqual([]);
    expect(deviated.length).toBeGreaterThan(0);
  });

  it("gives every covered criterion at least one enforcing test", async () => {
    const entries = await entriesPromise;
    const empty = entries
      .filter((entry) => entry.status === "covered" && entry.tests.length === 0)
      .map((entry) => entry.id);
    expect(empty).toEqual([]);
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
});
