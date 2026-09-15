import { afterAll, describe, expect, it } from "vitest";

import type { Json } from "../json.ts";
import { closeSchemaWorker } from "../index.ts";
import { SchemaValidator } from "./validator.ts";
import {
  patternAcceptsInWorker,
  SchemaWorkerError,
  SchemaWorkerService,
  scanForbiddenTextInWorker,
  validateSchemaInstance
} from "./worker-service.ts";

/** The catastrophic pattern of the observed hostile contract. */
const REGEX_BOMB = "^(a+)+$";

afterAll(() => {
  service.close();
  closeSchemaWorker();
});

const service = new SchemaWorkerService({ deadlineMs: 2_000 });

describe("schema worker boundary", () => {
  it("validates an instance like the synchronous validator", async () => {
    const schema: Json = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", pattern: "^[a-z]+$" } }
    };
    const instance: Json = { name: "NOPE" };
    const violations = await service.validate(schema, instance);
    expect(violations.map((violation) => violation.code)).toEqual(["pattern"]);
    expect(new SchemaValidator(schema).errors(instance)).toEqual(violations);
  });

  it("resolves references from the registered bundle", async () => {
    const refs: Record<string, Json> = {
      "oal-schema:doc#/components/schemas/name": { type: "string" }
    };
    const schema: Json = {
      type: "object",
      properties: {
        name: { $ref: "oal-schema:doc#/components/schemas/name" }
      }
    };
    await expect(
      service.validate(schema, { name: "ok" }, { refs })
    ).resolves.toEqual([]);
    const violations = await service.validate(schema, { name: 1 }, { refs });
    expect(violations[0]?.code).toBe("type");
  });

  it("keeps the compiled bundle warm across calls", async () => {
    const schema: Json = { type: "string", pattern: "^a+$" };
    const first = service.bundleOf(schema);
    const second = service.bundleOf(schema);
    expect(second).toBe(first);
    await expect(service.validate(schema, "aaa")).resolves.toEqual([]);
  });

  it("terminates a blocked worker at the deadline and recovers", async () => {
    const hostile = new SchemaWorkerService({ deadlineMs: 150 });
    try {
      const schema: Json = { type: "string", pattern: REGEX_BOMB };
      const attack = "a".repeat(1024) + "!";
      await expect(hostile.validate(schema, attack)).rejects.toMatchObject({
        code: "OAL-SCHEMA-WORKER-TIMEOUT"
      });
      // The replacement worker serves later valid requests.
      await expect(
        hostile.validate({ type: "string", pattern: "^a+$" }, "aaa")
      ).resolves.toEqual([]);
    } finally {
      hostile.close();
    }
  });

  it("fails fast when the queue is full", async () => {
    const tight = new SchemaWorkerService({
      deadlineMs: 300,
      workerCount: 1,
      maxPending: 1
    });
    try {
      const schema: Json = { type: "string", pattern: REGEX_BOMB };
      // Rejection handlers attach at creation, not after intermediate
      // awaits: the deadline timer can reject the queued jobs in one
      // macrotask and a later one, and a promise that sits rejected
      // across a macrotask boundary without a handler is reported as
      // an unhandled rejection.
      const blockedRejected = expect(
        tight.validate(schema, `${"a".repeat(1024)}!`)
      ).rejects.toMatchObject({ code: "OAL-SCHEMA-WORKER-TIMEOUT" });
      const waitingRejected = expect(
        tight.validate(schema, `${"a".repeat(512)}!`)
      ).rejects.toMatchObject({ code: "OAL-SCHEMA-WORKER-TIMEOUT" });
      await expect(
        tight.validate(schema, `${"a".repeat(256)}!`)
      ).rejects.toMatchObject({ code: "OAL-SCHEMA-WORKER-QUEUE-FULL" });
      await waitingRejected;
      await blockedRejected;
    } finally {
      tight.close();
    }
  });

  it("refuses a message above the byte bound", async () => {
    const tight = new SchemaWorkerService({ maxMessageBytes: 64 });
    try {
      await expect(
        tight.validate({ type: "string" }, "x".repeat(256) as unknown as Json)
      ).rejects.toMatchObject({
        code: "OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE"
      });
    } finally {
      tight.close();
    }
  });

  it("refuses a registration above the byte bound at the worker", async () => {
    // The request itself is tiny; only the schema bundle is over the
    // bound, so the refusal happens when the worker would receive the
    // registration, not at submit time.
    const heavy = {
      type: "string",
      description: "d".repeat(512)
    } as unknown as Json;
    const tight = new SchemaWorkerService({ maxMessageBytes: 256 });
    try {
      await expect(
        tight.validate(heavy, "value" as unknown as Json)
      ).rejects.toMatchObject({
        code: "OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE",
        message: /schema bundle registration needs/
      });
    } finally {
      tight.close();
    }
  });

  it("runs raw pattern probes inside the boundary", async () => {
    await expect(patternAcceptsInWorker("^a+$", "aaa")).resolves.toBe(true);
    await expect(patternAcceptsInWorker("^a+$", "b")).resolves.toBe(false);
    await expect(patternAcceptsInWorker("(", "b")).resolves.toBe(false);
  });

  it("scans forbidden literals and patterns in one bounded call", async () => {
    const scan = await scanForbiddenTextInWorker(
      [
        { literal: "secret", caseInsensitive: false },
        { literal: "Token", caseInsensitive: true }
      ],
      ["api[_-]?key"],
      "The SECRET_TOKEN holds secret data; api_key = 1; API-KEY = 2"
    );
    expect(scan.literals).toEqual([["secret"], ["TOKEN"]]);
    expect(scan.patterns).toEqual([["api_key"]]);
  });

  it("exposes a typed infrastructure error", () => {
    const error = new SchemaWorkerError(
      "OAL-SCHEMA-WORKER-TIMEOUT",
      "bound reached"
    );
    expect(error.code).toBe("OAL-SCHEMA-WORKER-TIMEOUT");
    expect(error.category).toBe("mock");
  });
});

describe("process-wide boundary facade", () => {
  it("validates through the shared service", async () => {
    await expect(
      validateSchemaInstance({ type: "number" }, 3)
    ).resolves.toEqual([]);
    await expect(
      validateSchemaInstance({ type: "number" }, "3")
    ).resolves.toHaveLength(1);
  });
});
