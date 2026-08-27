import { describe, expect, it } from "vitest";

import { sha256Hex } from "@oal/core";

import {
  createProtocolLock,
  PROTOCOL_MEMBER_PATH,
  protocolLockFromJson,
  protocolLockJson,
  protocolLockSha256,
  serializeProtocolLock,
  verifyProtocolLock,
  type LockMember,
  type ProtocolLock,
  type ProtocolLockResult
} from "./lock.ts";
import { loadProtocol } from "./protocol.ts";
import { baseMembers, baseProtocolDoc, loadSchema } from "./fixtures.ts";

const lockSchema = loadSchema("protocol-lock.v1.schema.json");
const protocolSchema = loadSchema("study-protocol.v1.schema.json");

function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

function fixtureMembers(): LockMember[] {
  return [...baseMembers()].map(([path, text]) => ({ path, text }));
}

function fixtureEffectiveContracts() {
  return [
    { variant: "shape-a", sha256: sha256Hex("shape a") },
    { variant: "shape-b", sha256: sha256Hex("shape b") }
  ];
}

function lockFixture(): ProtocolLock {
  const protocol = loadProtocol(baseProtocolDoc(), {
    schema: protocolSchema
  }).protocol;
  if (protocol === null) {
    throw new Error("Fixture protocol must load.");
  }
  const result = createProtocolLock(
    protocol,
    fixtureMembers(),
    fixtureEffectiveContracts(),
    { schema: lockSchema }
  );
  return lockOf(result);
}

function lockOf(result: ProtocolLockResult): ProtocolLock {
  if (result.lock === null) {
    throw new Error(
      `Fixture lock must be created: ${codesOf(result.diagnostics).join(", ")}`
    );
  }
  return result.lock;
}

describe("createProtocolLock", () => {
  it("creates a schema-valid lock over every member", () => {
    const lock = lockFixture();
    expect(Object.keys(lock.members).sort()).toEqual(
      [
        PROTOCOL_MEMBER_PATH,
        "profiles/codex-high-raw-sequential.yaml",
        "variants/api-shapes.yaml",
        "blinding/participant-surface.yaml",
        "phases/smoke.yaml",
        "phases/pilot.yaml"
      ].sort()
    );
    expect(lock.effective_contracts).toEqual({
      "shape-a": sha256Hex("shape a"),
      "shape-b": sha256Hex("shape b")
    });
    expect(lock.pack.id).toBe("workspace-service");
  });

  it("never contains its own digest", () => {
    const lock = lockFixture();
    const serialized = serializeProtocolLock(lock);
    expect(serialized).not.toContain("lock_sha256");
    expect(serialized).not.toContain(protocolLockSha256(lock));
    expect(Object.keys(protocolLockJson(lock) as object)).not.toContain(
      "protocol_lock_sha256"
    );
  });

  it("rejects a missing member", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const members = fixtureMembers().filter(
      (member) => member.path !== "phases/pilot.yaml"
    );
    const result = createProtocolLock(protocol, members, [], {
      schema: lockSchema
    });
    expect(result.lock).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-MEMBER-MISSING");
  });

  it("rejects an unsafe member path", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const members = [
      ...fixtureMembers(),
      { path: "../outside.yaml", text: "bytes" }
    ];
    const result = createProtocolLock(protocol, members, [], {
      schema: lockSchema
    });
    expect(result.lock).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-MEMBER-PATH-UNSAFE"
    );
  });

  it("rejects a duplicate member path", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const members = [
      ...fixtureMembers(),
      { path: "phases/pilot.yaml", text: "other bytes" }
    ];
    const result = createProtocolLock(protocol, members, [], {
      schema: lockSchema
    });
    expect(result.lock).toBeNull();
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-MEMBER-DUPLICATE");
  });

  it("rejects a digest for an unreferenced variant", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const result = createProtocolLock(
      protocol,
      fixtureMembers(),
      [
        ...fixtureEffectiveContracts(),
        { variant: "shape-z", sha256: sha256Hex("shape z") }
      ],
      { schema: lockSchema }
    );
    expect(result.lock).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-EFFECTIVE-CONTRACT-UNUSED"
    );
  });

  it("rejects a referenced variant without a digest", () => {
    const protocol = loadProtocol(baseProtocolDoc(), {
      schema: protocolSchema
    }).protocol;
    if (protocol === null) {
      throw new Error("Fixture protocol must load.");
    }
    const result = createProtocolLock(
      protocol,
      fixtureMembers(),
      [{ variant: "shape-a", sha256: sha256Hex("shape a") }],
      { schema: lockSchema }
    );
    expect(result.lock).toBeNull();
    expect(codesOf(result.diagnostics)).toContain(
      "OAL-STUDY-EFFECTIVE-CONTRACT-MISSING"
    );
  });
});

describe("verifyProtocolLock", () => {
  it("accepts unchanged members", () => {
    const lock = lockFixture();
    const result = verifyProtocolLock(lock, {
      members: fixtureMembers()
    });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports exactly the member that drifted", () => {
    const lock = lockFixture();
    const members = fixtureMembers().map((member) =>
      member.path === "phases/pilot.yaml"
        ? { path: member.path, text: `${member.text}# edited` }
        : member
    );
    const result = verifyProtocolLock(lock, { members });
    expect(result.ok).toBe(false);
    expect(result.drift.length).toBe(1);
    const drift = result.drift[0];
    expect(drift?.kind).toBe("digest");
    expect(drift?.path).toBe("phases/pilot.yaml");
    expect(drift?.recorded).toBe(sha256Hex(memberTextOf("phases/pilot.yaml")));
    expect(drift?.actual).toBe(
      sha256Hex(`${memberTextOf("phases/pilot.yaml")}# edited`)
    );
    expect(codesOf(result.diagnostics)).toContain("OAL-STUDY-LOCK-DRIFT");
  });

  it("reports a locked member that disappeared", () => {
    const lock = lockFixture();
    const members = fixtureMembers().filter(
      (member) => member.path !== "blinding/participant-surface.yaml"
    );
    const result = verifyProtocolLock(lock, { members });
    expect(result.ok).toBe(false);
    expect(
      result.drift.some(
        (entry) =>
          entry.kind === "missing" &&
          entry.path === "blinding/participant-surface.yaml"
      )
    ).toBe(true);
  });

  it("reports a supplied member the lock does not cover", () => {
    const lock = lockFixture();
    const members = [
      ...fixtureMembers(),
      { path: "extra/new-member.yaml", text: "new bytes" }
    ];
    const result = verifyProtocolLock(lock, { members });
    expect(result.ok).toBe(false);
    expect(
      result.drift.some(
        (entry) =>
          entry.kind === "unrecorded" && entry.path === "extra/new-member.yaml"
      )
    ).toBe(true);
  });

  it("reports protocol identity drift", () => {
    const lock = lockFixture();
    const doc = baseProtocolDoc();
    const metadata = doc["metadata"] as { version: string };
    metadata.version = "2.0.0";
    const protocol = loadProtocol(doc, { schema: protocolSchema }).protocol;
    if (protocol === null) {
      throw new Error("Edited fixture protocol must load.");
    }
    const result = verifyProtocolLock(lock, {
      members: fixtureMembers(),
      protocol
    });
    expect(result.ok).toBe(false);
    expect(
      result.drift.some(
        (entry) => entry.kind === "identity" && entry.detail.includes("version")
      )
    ).toBe(true);
    expect(
      result.drift.some(
        (entry) =>
          entry.kind === "identity" && entry.detail.includes("source digest")
      )
    ).toBe(true);
  });

  it("reports a recorded lock digest that no longer matches", () => {
    const lock = lockFixture();
    const result = verifyProtocolLock(lock, {
      members: fixtureMembers(),
      expectedLockSha256: sha256Hex("stale recorded digest")
    });
    expect(result.ok).toBe(false);
    expect(result.drift.some((entry) => entry.kind === "lock_digest")).toBe(
      true
    );
    expect(result.lockSha256).toBe(protocolLockSha256(lock));
  });

  it("reports a referenced variant the lock does not cover", () => {
    const lock = lockFixture();
    const doc = baseProtocolDoc();
    const factors = doc["factors"] as {
      levels: { id: string; contract_variant?: string }[];
    }[];
    const apiShape = factors[0];
    if (apiShape === undefined) {
      throw new Error("Fixture protocol has no first factor.");
    }
    apiShape.levels.push({ id: "shape_c", contract_variant: "shape-c" });
    const protocol = loadProtocol(doc, { schema: protocolSchema }).protocol;
    if (protocol === null) {
      throw new Error("Edited fixture protocol must load.");
    }
    const result = verifyProtocolLock(lock, {
      members: fixtureMembers(),
      protocol
    });
    expect(result.ok).toBe(false);
    expect(result.drift.some((entry) => entry.kind === "variant_missing")).toBe(
      true
    );
  });
});

describe("protocolLockFromJson", () => {
  it("round-trips a lock through its persisted JSON form", () => {
    const lock = lockFixture();
    const parsed = protocolLockFromJson(protocolLockJson(lock), {
      schema: lockSchema
    });
    expect(parsed.diagnostics).toEqual([]);
    const restored = lockOf(parsed);
    expect(protocolLockSha256(restored)).toBe(protocolLockSha256(lock));
  });

  it("rejects a persisted lock with an unknown member", () => {
    const lock = lockFixture();
    const json = {
      ...(protocolLockJson(lock) as Record<string, unknown>),
      protocol_lock_sha256: "0".repeat(64)
    };
    const parsed = protocolLockFromJson(json, { schema: lockSchema });
    expect(parsed.lock).toBeNull();
    expect(codesOf(parsed.diagnostics)).toContain("OAL-STUDY-SCHEMA-INVALID");
  });
});

function memberTextOf(path: string): string {
  const text = baseMembers().get(path);
  if (text === undefined) {
    throw new Error(`Fixture has no member at ${path}.`);
  }
  return text;
}
