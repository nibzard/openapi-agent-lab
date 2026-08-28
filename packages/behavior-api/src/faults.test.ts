import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import {
  FaultCounters,
  matchFault,
  validateFaultRules,
  type FaultMatchInput,
  type FaultRule
} from "./faults.ts";

function rule(init: Partial<FaultRule> & { id: string }): FaultRule {
  return {
    id: init.id,
    operation: init.operation ?? "path:POST /things",
    phase: init.phase ?? "before_behavior",
    match: init.match ?? {},
    action: init.action ?? { kind: "response", status: 429 }
  };
}

function input(init: Partial<FaultMatchInput>): FaultMatchInput {
  return {
    operation: init.operation ?? "path:POST /things",
    phase: init.phase ?? "before_behavior",
    parameters: init.parameters ?? {},
    body: init.body,
    nowMs: init.nowMs ?? 1_000,
    sample: init.sample ?? 0
  };
}

describe("matchFault", () => {
  it("returns null when no rules are declared", () => {
    expect(matchFault([], input({}), new FaultCounters())).toBeNull();
  });

  it("skips rules for another operation or phase", () => {
    const counters = new FaultCounters();
    expect(
      matchFault(
        [
          rule({
            id: "a",
            operation: "path:GET /things",
            phase: "after_behavior"
          })
        ],
        input({}),
        counters
      )
    ).toBeNull();
    expect(counters.get("a")).toBe(0);
  });

  it("fires an unconditional rule on the first occurrence", () => {
    const evaluation = matchFault(
      [rule({ id: "a" })],
      input({}),
      new FaultCounters()
    );
    expect(evaluation?.rule.id).toBe("a");
    expect(evaluation?.occurrence).toBe(1);
  });

  it("honors an exact occurrence number", () => {
    const counters = new FaultCounters();
    const rules = [rule({ id: "a", match: { occurrence: 3 } })];
    expect(matchFault(rules, input({}), counters)).toBeNull();
    expect(matchFault(rules, input({}), counters)).toBeNull();
    const third = matchFault(rules, input({}), counters);
    expect(third?.occurrence).toBe(3);
    expect(matchFault(rules, input({}), counters)).toBeNull();
  });

  it("honors a bounded occurrence list", () => {
    const counters = new FaultCounters();
    const rules = [rule({ id: "a", match: { occurrence: [1, 3] } })];
    expect(matchFault(rules, input({}), counters)?.occurrence).toBe(1);
    expect(matchFault(rules, input({}), counters)).toBeNull();
    expect(matchFault(rules, input({}), counters)?.occurrence).toBe(3);
  });

  it("advances the counter only for predicate and window survivors", () => {
    const counters = new FaultCounters();
    const rules = [
      rule({ id: "a", match: { predicate: { parameters: { team: "red" } } } })
    ];
    expect(
      matchFault(rules, input({ parameters: { team: "blue" } }), counters)
    ).toBeNull();
    expect(counters.get("a")).toBe(0);
    expect(
      matchFault(rules, input({ parameters: { team: "red" } }), counters)
    ).not.toBeNull();
    expect(counters.get("a")).toBe(1);
  });

  it("matches body predicates on top-level properties", () => {
    const rules = [
      rule({ id: "a", match: { predicate: { body: { severity: 9 } } } })
    ];
    const body: Json = { severity: 9, note: "ahead" };
    expect(
      matchFault(rules, input({ body }), new FaultCounters())
    ).not.toBeNull();
    expect(
      matchFault(rules, input({ body: { severity: 1 } }), new FaultCounters())
    ).toBeNull();
    expect(
      matchFault(rules, input({ body: undefined }), new FaultCounters())
    ).toBeNull();
    expect(
      matchFault(rules, input({ body: [1, 2, 3] }), new FaultCounters())
    ).toBeNull();
  });

  it("matches parameter objects regardless of key order", () => {
    const rules = [
      rule({
        id: "a",
        match: { predicate: { parameters: { meta: { b: 2, a: 1 } } } }
      })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { meta: { a: 1, b: 2 } } }),
        new FaultCounters()
      )
    ).not.toBeNull();
  });

  it("matches body predicates regardless of key order", () => {
    const rules = [
      rule({
        id: "a",
        match: {
          predicate: { body: { filter: { page: 2, name: "red" } } }
        }
      })
    ];
    expect(
      matchFault(
        rules,
        input({
          body: { filter: { name: "red", page: 2 }, extra: true }
        }),
        new FaultCounters()
      )
    ).not.toBeNull();
  });

  it("matches nested reordered keys at every depth", () => {
    const rules = [
      rule({
        id: "a",
        match: {
          predicate: {
            parameters: { payload: { z: { y: 1, x: { w: 4, v: 3 } } } }
          }
        }
      })
    ];
    expect(
      matchFault(
        rules,
        input({
          parameters: { payload: { z: { x: { v: 3, w: 4 }, y: 1 } } }
        }),
        new FaultCounters()
      )
    ).not.toBeNull();
  });

  it("keeps array order significant", () => {
    const rules = [
      rule({
        id: "a",
        match: { predicate: { parameters: { ids: [1, 2] } } }
      })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { ids: [1, 2] } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { ids: [2, 1] } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("compares scalars and rejects type changes", () => {
    const rules = [
      rule({
        id: "a",
        match: { predicate: { parameters: { team: "blue", count: 3 } } }
      })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { team: "blue", count: 3 } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { team: "blue", count: "3" } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("never treats an absent value as the declared null", () => {
    const rules = [
      rule({ id: "a", match: { predicate: { parameters: { token: null } } } })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { token: null } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(rules, input({ parameters: {} }), new FaultCounters())
    ).toBeNull();
  });

  it("decides instead of throwing on an infinite parameter", () => {
    const rules = [
      rule({ id: "a", match: { predicate: { parameters: { limit: 5 } } } })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.POSITIVE_INFINITY } }),
        new FaultCounters()
      )
    ).toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.NEGATIVE_INFINITY } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("decides instead of throwing on a NaN parameter", () => {
    const rules = [
      rule({ id: "a", match: { predicate: { parameters: { limit: 5 } } } })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.NaN } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("decides instead of throwing on a non-finite from a lenient decode", () => {
    // JSON.parse("1e999") resolves to Infinity on every host.
    const parsed = JSON.parse('{"ratio": 1e999}') as Json;
    const rules = [
      rule({ id: "a", match: { predicate: { body: { ratio: 1 } } } })
    ];
    expect(
      matchFault(rules, input({ body: parsed }), new FaultCounters())
    ).toBeNull();
    const nested = [
      rule({
        id: "b",
        match: { predicate: { parameters: { payload: { ratio: 1 } } } }
      })
    ];
    expect(
      matchFault(
        nested,
        input({ parameters: { payload: { ratio: Number.POSITIVE_INFINITY } } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("matches two non-finite values only of the same kind", () => {
    const counters = new FaultCounters();
    const rules = [
      rule({
        id: "a",
        match: {
          predicate: { parameters: { limit: Number.POSITIVE_INFINITY } }
        }
      })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.POSITIVE_INFINITY } }),
        counters
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.NEGATIVE_INFINITY } }),
        counters
      )
    ).toBeNull();
    expect(
      matchFault(rules, input({ parameters: { limit: Number.NaN } }), counters)
    ).toBeNull();
  });

  it("matches a NaN parameter against a NaN predicate", () => {
    const rules = [
      rule({
        id: "a",
        match: { predicate: { parameters: { limit: Number.NaN } } }
      })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.NaN } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: Number.POSITIVE_INFINITY } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("keeps finite number comparisons unchanged", () => {
    const rules = [
      rule({ id: "a", match: { predicate: { parameters: { limit: 5 } } } })
    ];
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: 5 } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: 5.0 } }),
        new FaultCounters()
      )
    ).not.toBeNull();
    expect(
      matchFault(
        rules,
        input({ parameters: { limit: 6 } }),
        new FaultCounters()
      )
    ).toBeNull();
  });

  it("uses an inclusive virtual-time window", () => {
    const rules = [
      rule({ id: "a", match: { windowMs: { from: 100, to: 200 } } })
    ];
    expect(
      matchFault(rules, input({ nowMs: 99 }), new FaultCounters())
    ).toBeNull();
    expect(
      matchFault(rules, input({ nowMs: 100 }), new FaultCounters())
    ).not.toBeNull();
    expect(
      matchFault(rules, input({ nowMs: 200 }), new FaultCounters())
    ).not.toBeNull();
    expect(
      matchFault(rules, input({ nowMs: 201 }), new FaultCounters())
    ).toBeNull();
  });

  it("fires a probability rule only when the sample is below it", () => {
    const rules = [rule({ id: "a", match: { probability: 0.5 } })];
    expect(
      matchFault(rules, input({ sample: 0.4999 }), new FaultCounters())
    ).not.toBeNull();
    expect(
      matchFault(rules, input({ sample: 0.5 }), new FaultCounters())
    ).toBeNull();
    expect(
      matchFault(rules, input({ sample: 0 }), new FaultCounters())
    ).not.toBeNull();
  });

  it("respects declaration order for the first terminal win", () => {
    const rules = [
      rule({ id: "first", match: { occurrence: 2 } }),
      rule({ id: "second" })
    ];
    const counters = new FaultCounters();
    expect(matchFault(rules, input({}), counters)?.rule.id).toBe("second");
    expect(matchFault(rules, input({}), counters)?.rule.id).toBe("first");
  });

  it("counts rules independently", () => {
    const counters = new FaultCounters();
    expect(counters.next("a")).toBe(1);
    expect(counters.next("b")).toBe(1);
    expect(counters.next("a")).toBe(2);
    expect(counters.get("a")).toBe(2);
    expect(counters.get("missing")).toBe(0);
  });
});

describe("validateFaultRules", () => {
  it("accepts a valid schedule", () => {
    expect(
      validateFaultRules([
        rule({
          id: "a",
          match: { probability: 0.25, windowMs: { from: 0, to: 10 } },
          action: { kind: "disconnect", after_bytes: 128 }
        })
      ])
    ).toBeNull();
  });

  it("rejects an empty id", () => {
    expect(validateFaultRules([rule({ id: "" })])).toBe(
      "fault rule has an empty id"
    );
  });

  it("rejects duplicate ids", () => {
    expect(validateFaultRules([rule({ id: "a" }), rule({ id: "a" })])).toBe(
      "duplicate fault id a"
    );
  });

  it("rejects a status outside 200 to 599", () => {
    expect(
      validateFaultRules([
        rule({ id: "a", action: { kind: "response", status: 600 } })
      ])
    ).not.toBeNull();
    expect(
      validateFaultRules([
        rule({ id: "a", action: { kind: "response", status: 199 } })
      ])
    ).not.toBeNull();
  });

  it("rejects a negative after_bytes bound", () => {
    expect(
      validateFaultRules([
        rule({ id: "a", action: { kind: "disconnect", after_bytes: -1 } })
      ])
    ).not.toBeNull();
  });

  it("rejects a probability outside [0, 1]", () => {
    expect(
      validateFaultRules([rule({ id: "a", match: { probability: 1.5 } })])
    ).not.toBeNull();
  });

  it("rejects an inverted time window", () => {
    expect(
      validateFaultRules([
        rule({ id: "a", match: { windowMs: { from: 10, to: 5 } } })
      ])
    ).not.toBeNull();
  });
});
