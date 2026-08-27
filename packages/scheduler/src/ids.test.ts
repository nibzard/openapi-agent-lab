import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@oal/core";

import {
  allocateControlIds,
  assignmentDomainObject,
  childBatchDomainObject,
  controlIdDocument,
  controlIdFromDigest,
  CONTROL_ID_MAX_HEX,
  CONTROL_ID_MIN_HEX,
  isControlId,
  requireFullDigest,
  resolveControlIdLengths,
  runDomainObject
} from "./ids.ts";

const PRIMARY_DOMAIN = assignmentDomainObject({
  study_run_id: "api-shape-pilot-01",
  phase_id: "pilot",
  cell_id: "shape_a__blind",
  assignment_kind: "primary",
  block_id: 0,
  repetition_index: 0,
  reserve_index: null
});

const a64 = "a".repeat(64);
const b64 = "b".repeat(64);
const c64 = "c".repeat(64);
/** Same 24-character prefix as `a64`, different full digest. */
const clash64 = `${"a".repeat(24)}${"f".repeat(40)}`;

describe("resolveControlIdLengths", () => {
  it("keeps 24 characters for digests that do not clash", () => {
    expect(resolveControlIdLengths([a64, b64, c64])).toEqual([24, 24, 24]);
  });

  it("extends every colliding ID to 32 characters together", () => {
    expect(resolveControlIdLengths([a64, clash64, b64])).toEqual([32, 32, 24]);
  });

  it("keeps the full digest behind every shortened ID", () => {
    expect(resolveControlIdLengths([a64])).toEqual([24]);
    expect(() => resolveControlIdLengths(["not-a-digest"])).toThrow();
  });
});

describe("requireFullDigest", () => {
  it("accepts a lowercase 64-character digest only", () => {
    expect(requireFullDigest(a64)).toBe(a64);
    expect(() => requireFullDigest(a64.toUpperCase())).toThrow();
    expect(() => requireFullDigest(a64.slice(1))).toThrow();
  });
});

describe("controlIdFromDigest", () => {
  it("renders the prefix plus 24 hexadecimal characters", () => {
    expect(controlIdFromDigest("asg", a64)).toBe(`asg_${"a".repeat(24)}`);
    expect(controlIdFromDigest("bat", b64, 32)).toBe(`bat_${"b".repeat(32)}`);
  });

  it("rejects any other length", () => {
    expect(() => controlIdFromDigest("run", a64, 12)).toThrow();
  });
});

describe("isControlId", () => {
  it("accepts the three control prefixes and hexadecimal bodies only", () => {
    expect(isControlId(`asg_${"a".repeat(24)}`)).toBe(true);
    expect(isControlId(`bat_${"0".repeat(32)}`)).toBe(true);
    expect(isControlId(`run_${"f".repeat(24)}`)).toBe(true);
    expect(isControlId(`evt_${"a".repeat(24)}`)).toBe(false);
    expect(isControlId(`asg_${"a".repeat(23)}`)).toBe(false);
    expect(isControlId(`asg_${"A".repeat(24)}`)).toBe(false);
    expect(isControlId(`asg_${"a".repeat(33)}`)).toBe(false);
  });
});

describe("allocateControlIds", () => {
  it("derives one ID from the canonical domain object, not concatenation", () => {
    const allocation = allocateControlIds([
      { key: "primary-0-blind", prefix: "asg", domain: PRIMARY_DOMAIN }
    ]);
    const allocated = allocation.byKey.get("primary-0-blind");
    const digest = canonicalJsonSha256(
      controlIdDocument("asg", PRIMARY_DOMAIN)
    );
    expect(allocated?.id).toBe(`asg_${digest.slice(0, CONTROL_ID_MIN_HEX)}`);
    expect(allocated?.sha256).toBe(digest);
    expect(allocated?.hexLength).toBe(CONTROL_ID_MIN_HEX);
    // Independently hashed literal for the fixture primary of section 12.11.
    expect(allocated?.id).toBe("asg_92f1ab95f34aa50a0130cfcc");
  });

  it("separates the run namespace from the assignment namespace", () => {
    const allocation = allocateControlIds([
      { key: "assignment", prefix: "asg", domain: PRIMARY_DOMAIN },
      {
        key: "run",
        prefix: "run",
        domain: runDomainObject({
          study_run_id: "api-shape-pilot-01",
          phase_id: "pilot",
          cell_id: "shape_a__blind",
          assignment_kind: "primary",
          block_id: 0,
          repetition_index: 0,
          reserve_index: null
        })
      }
    ]);
    const assignment = allocation.byKey.get("assignment")?.id ?? "";
    const run = allocation.byKey.get("run")?.id ?? "";
    expect(assignment.startsWith("asg_")).toBe(true);
    expect(run.startsWith("run_")).toBe(true);
    expect(assignment.slice(4)).not.toBe(run.slice(4));
    expect(run).toBe("run_a3222c79f1e8b77a32533e3e");
  });

  it("derives one child batch ID per cell", () => {
    const allocation = allocateControlIds([
      {
        key: "shape_a__blind",
        prefix: "bat",
        domain: childBatchDomainObject({
          study_run_id: "api-shape-pilot-01",
          phase_id: "pilot",
          cell_id: "shape_a__blind"
        })
      }
    ]);
    expect(allocation.byKey.get("shape_a__blind")?.id).toBe(
      "bat_175afb0546fc2a0a8dba7cfa"
    );
  });

  it("rejects a duplicate key", () => {
    expect(() =>
      allocateControlIds([
        { key: "same", prefix: "asg", domain: PRIMARY_DOMAIN },
        { key: "same", prefix: "asg", domain: { other: 1 } }
      ])
    ).toThrow(/more than once/);
  });

  it("rejects an empty key", () => {
    expect(() =>
      allocateControlIds([{ key: "", prefix: "asg", domain: PRIMARY_DOMAIN }])
    ).toThrow(/non-empty key/);
  });

  it("rejects two IDs of one prefix that hash to the same domain object", () => {
    expect(() =>
      allocateControlIds([
        { key: "left", prefix: "asg", domain: PRIMARY_DOMAIN },
        { key: "right", prefix: "asg", domain: PRIMARY_DOMAIN }
      ])
    ).toThrow(/same domain object/);
  });

  it("extends every ID of a clashing group to 32 characters", () => {
    const left = `${"0".repeat(24)}${"1".repeat(40)}`;
    const right = `${"0".repeat(24)}${"2".repeat(40)}`;
    const other = "3".repeat(64);
    const allocation = allocateControlIds(
      [
        { key: "left", prefix: "asg", domain: { i: 0 } },
        { key: "right", prefix: "asg", domain: { i: 1 } },
        { key: "other", prefix: "asg", domain: { i: 2 } }
      ],
      {
        digestOf: (_prefix, domain) =>
          domain["i"] === 0 ? left : domain["i"] === 1 ? right : other
      }
    );
    expect(allocation.byKey.get("left")?.id).toBe(
      `asg_${"0".repeat(24)}${"1".repeat(8)}`
    );
    expect(allocation.byKey.get("right")?.id).toBe(
      `asg_${"0".repeat(24)}${"2".repeat(8)}`
    );
    expect(allocation.byKey.get("other")?.id).toBe(`asg_${"3".repeat(24)}`);
    expect(allocation.byKey.get("other")?.hexLength).toBe(CONTROL_ID_MIN_HEX);
    expect(allocation.extended).toEqual(["left", "right"]);
  });

  it("keeps a clash inside one prefix from disturbing another prefix", () => {
    const left = `${"0".repeat(24)}${"1".repeat(40)}`;
    const right = `${"0".repeat(24)}${"2".repeat(40)}`;
    const allocation = allocateControlIds(
      [
        { key: "asg-left", prefix: "asg", domain: { i: 0 } },
        { key: "asg-right", prefix: "asg", domain: { i: 1 } },
        { key: "run-left", prefix: "run", domain: { i: 0 } }
      ],
      {
        digestOf: (_prefix, domain) =>
          domain["i"] === 0 ? left : domain["i"] === 1 ? right : "9".repeat(64)
      }
    );
    expect(allocation.byKey.get("asg-left")?.hexLength).toBe(
      CONTROL_ID_MAX_HEX
    );
    expect(allocation.byKey.get("run-left")?.hexLength).toBe(
      CONTROL_ID_MIN_HEX
    );
  });

  it("keeps the full digest of every allocated ID", () => {
    const digest = canonicalJsonSha256(
      controlIdDocument("asg", PRIMARY_DOMAIN)
    );
    const allocation = allocateControlIds([
      { key: "real", prefix: "asg", domain: PRIMARY_DOMAIN }
    ]);
    expect(allocation.list).toHaveLength(1);
    expect(allocation.extended).toEqual([]);
    expect(allocation.byKey.get("real")?.sha256).toBe(digest);
    expect(controlIdFromDigest("asg", digest)).toBe(
      allocation.byKey.get("real")?.id
    );
  });

  it("keeps every ID of a real allocation unique", () => {
    const domains = [0, 1, 2].map((block) =>
      assignmentDomainObject({
        study_run_id: "api-shape-pilot-01",
        phase_id: "pilot",
        cell_id: "shape_a__blind",
        assignment_kind: "primary",
        block_id: block,
        repetition_index: block,
        reserve_index: null
      })
    );
    const allocation = allocateControlIds(
      domains.map((domain, index) => ({
        key: `p${index}`,
        prefix: "asg" as const,
        domain
      }))
    );
    expect(new Set(allocation.list.map((entry) => entry.id)).size).toBe(3);
  });
});
