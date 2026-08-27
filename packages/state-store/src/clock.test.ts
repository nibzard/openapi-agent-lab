import { describe, expect, it } from "vitest";

import { VIRTUAL_EPOCH_ISO, VIRTUAL_EPOCH_MS } from "@oal/core";

import { VirtualClock } from "./clock.ts";

describe("VirtualClock", () => {
  it("starts at the default logical epoch", () => {
    const clock = new VirtualClock();
    expect(clock.nowMs()).toBe(VIRTUAL_EPOCH_MS);
    expect(clock.now()).toBe(VIRTUAL_EPOCH_ISO);
    expect(clock.now()).toBe("2000-01-01T00:00:00.000Z");
    expect(clock.tickMs).toBe(1);
  });

  it("accepts a configured initial value and tick", () => {
    const clock = new VirtualClock({
      initialMs: Date.parse("2026-08-27T12:00:00.000Z"),
      tickMs: 250
    });
    expect(clock.now()).toBe("2026-08-27T12:00:00.000Z");
    expect(clock.tickMs).toBe(250);
    expect(clock.tick()).toBe("2026-08-27T12:00:00.250Z");
  });

  it("formats every tick as RFC 3339 UTC with milliseconds", () => {
    const clock = new VirtualClock();
    expect(clock.tick()).toBe("2000-01-01T00:00:00.001Z");
    expect(clock.tick()).toBe("2000-01-01T00:00:00.002Z");
    expect(clock.advance()).toBe("2000-01-01T00:00:00.003Z");
    expect(clock.advance(997)).toBe("2000-01-01T00:00:01.000Z");
    expect(clock.advance(0)).toBe("2000-01-01T00:00:01.000Z");
  });

  it("advances by an explicit amount for scenario time jumps", () => {
    const clock = new VirtualClock();
    clock.advance(60_000);
    expect(clock.now()).toBe("2000-01-01T00:01:00.000Z");
  });

  it("sets an absolute logical time and refuses to move backwards", () => {
    const clock = new VirtualClock();
    clock.set("2001-02-03T04:05:06.007Z");
    expect(clock.nowMs()).toBe(Date.parse("2001-02-03T04:05:06.007Z"));
    expect(() => clock.set(VIRTUAL_EPOCH_MS)).toThrowError(/backwards/);
    expect(() => clock.set("not-a-timestamp")).toThrowError(/RFC 3339/);
    expect(() => clock.advance(-1)).toThrowError(/nonnegative/);
    expect(() => new VirtualClock({ tickMs: -1 })).toThrowError(/nonnegative/);
  });

  it("reports a snapshot copy", () => {
    const clock = new VirtualClock({ initialMs: 5, tickMs: 2 });
    clock.tick();
    expect(clock.snapshot()).toEqual({
      nowMs: 7,
      now: "1970-01-01T00:00:00.007Z",
      tickMs: 2
    });
  });
});
