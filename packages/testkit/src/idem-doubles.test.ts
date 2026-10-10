/**
 * Idempotency negative doubles and report classifications
 * (specification sections 48.5 and 48.6). The doubles each carry one
 * defect: a duplicate effect under promised idempotency, and an
 * incorrect rollback after a committed response is lost. The idem
 * corpus must fail against its corresponding double and pass against
 * the honest target. The classification checks pin how a report tells
 * an expected service error, an assertion failure, a provider
 * failure, a runtime error, and a lost response apart - and that a
 * lost response never becomes evidence of a rollback.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCorpus, parsePackYaml, type CorpusDocument } from "@oal/pack";
import { runCorpus, type CorpusReport } from "@oal/corpus";
import type {
  CorpusTarget,
  CorpusTargetRequest,
  CorpusTargetResponse
} from "@oal/corpus";
import type { JsonObject } from "@oal/core";

const corpusPath = path.resolve(
  import.meta.dirname,
  "../../../packs/idem-runtime/corpora/core.yaml"
);

/** The defects a double can carry; one at a time. */
type Defect = "none" | "duplicate_effect" | "incorrect_rollback";

/** The loss script: cut the transport of the first create only. */
type LossScript = "none" | "lose-first-create";

/** The transport condition a scripted target reports. */
type TransportCondition = "ok" | "lost" | "provider_failure" | "throw";

/**
 * A hand-written job API double. It honors an Idempotency-Key the
 * way the real runtime does - commit, then seal, then replay - and
 * its defects break exactly one of those promises. It never imports
 * the real backend, so a corpus failure against it is the double's
 * defect, not a pack bug.
 */
class IdemDouble implements CorpusTarget {
  readonly id = "idem-double";
  readonly version = "1.0.0";
  readonly capabilities = { operators: false, virtualTime: false };

  private jobs = new Map<string, JsonObject>();
  private nextId = 1;
  private entries = new Map<string, { text: string; response: JsonObject }>();
  private creates = 0;

  constructor(
    private readonly defect: Defect,
    private readonly lossScript: LossScript = "none",
    private readonly transport: TransportCondition = "ok"
  ) {}

  async prepare(): Promise<void> {}

  async wait(): Promise<void> {}

  async cleanup(): Promise<void> {}

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    await Promise.resolve();
    if (this.transport === "throw") {
      throw new Error("the double crashed");
    }
    if (this.transport === "provider_failure") {
      return {
        status: null,
        outcome: "provider_failure",
        headers: {},
        body: null,
        method: this.methodOf(instruction.operationId)
      };
    }
    if (this.transport === "lost") {
      return {
        status: null,
        outcome: "lost",
        headers: {},
        body: null,
        method: this.methodOf(instruction.operationId)
      };
    }
    if (instruction.operationId === "create_job") {
      return this.createJob(instruction);
    }
    if (instruction.operationId === "get_job") {
      return this.getJob(instruction);
    }
    throw new Error(
      `The double implements no operation ${JSON.stringify(instruction.operationId)}.`
    );
  }

  private createJob(instruction: CorpusTargetRequest): CorpusTargetResponse {
    this.creates += 1;
    const key = headerOf(instruction, "Idempotency-Key");
    const body = instruction.body;
    const raw =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as JsonObject)["text"]
        : undefined;
    const text = typeof raw === "string" ? raw : "";
    const method = "POST";
    const url = "/v1/jobs";
    if (this.lossScript === "lose-first-create" && this.creates === 1) {
      // The create commits first; the transport cuts after. The
      // incorrect-rollback defect undoes the commit instead - the
      // double treated the loss as a failure.
      const job = this.commitJob(text);
      if (this.defect === "incorrect_rollback") {
        this.jobs.delete(job["id"] as string);
      }
      return {
        status: null,
        outcome: "lost",
        headers: {},
        body: null,
        method,
        url
      };
    }
    if (key !== null && this.defect !== "duplicate_effect") {
      const stored = this.entries.get(key);
      if (stored !== undefined) {
        if (stored.text !== text) {
          // The same key with a different body conflicts.
          return {
            status: 409,
            headers: {},
            body: {
              code: "idempotency_conflict",
              message:
                "The Idempotency-Key was reused with a different request body."
            },
            method,
            url
          };
        }
        return { status: 201, headers: {}, body: stored.response, method, url };
      }
    }
    const job = this.commitJob(text);
    const response: JsonObject = { ...job };
    if (key !== null) {
      this.entries.set(key, { text, response });
    }
    return { status: 201, headers: {}, body: response, method, url };
  }

  private commitJob(text: string): JsonObject {
    const id = `job_${this.nextId.toString(10).padStart(8, "0")}`;
    this.nextId += 1;
    const job: JsonObject = {
      id,
      text,
      status: "queued",
      created_at: "2000-01-01T00:00:00.000Z"
    };
    this.jobs.set(id, job);
    return job;
  }

  private getJob(instruction: CorpusTargetRequest): CorpusTargetResponse {
    const path = instruction.parameters.path;
    const rawId = path["jobId"];
    const id = typeof rawId === "string" ? rawId : "";
    const job = this.jobs.get(id);
    if (job === undefined) {
      return {
        status: 404,
        headers: {},
        body: { code: "not_found", message: "No job has this identifier." },
        method: "GET",
        url: `/v1/jobs/${id}`
      };
    }
    return {
      status: 200,
      headers: {},
      body: job,
      method: "GET",
      url: `/v1/jobs/${id}`
    };
  }

  private methodOf(operationId: string): string {
    return operationId === "get_job" ? "GET" : "POST";
  }
}

function headerOf(
  instruction: CorpusTargetRequest,
  name: string
): string | null {
  const value = instruction.parameters.header[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The corpus the shipped pack declares. */
async function packCorpus(): Promise<CorpusDocument> {
  return parseCorpus(parsePackYaml(await readFile(corpusPath, "utf8")));
}

/** The loss corpus: create loses its transport, the read reconciles. */
const LOSS_CORPUS_YAML = `api_version: 1
id: idem-loss
version: 1.0.0
scenario: baseline
inputs: []
cases:
  - id: lost-create-reconciles
    claim_ids: [idem-replay]
    scope: black_box
    steps:
      - id: create
        request:
          operation_id: create_job
          parameters:
            header:
              Idempotency-Key: loss-key
          body:
            text: committed then lost
      - id: read-back
        request:
          operation_id: get_job
          parameters:
            path:
              jobId: job_00000001
        assert:
          - op: status
            expected: 200
`;

function caseOf(report: CorpusReport, id: string) {
  const found = report.cases.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`The report carries no case ${JSON.stringify(id)}.`);
  }
  return found;
}

function stepOf(report: CorpusReport, caseId: string, stepId: string) {
  const found = caseOf(report, caseId).steps.find((step) => step.id === stepId);
  if (found === undefined) {
    throw new Error(`The case carries no step ${JSON.stringify(stepId)}.`);
  }
  return found;
}

async function run(
  target: CorpusTarget,
  corpus?: CorpusDocument
): Promise<CorpusReport> {
  return runCorpus(corpus ?? (await packCorpus()), target, {});
}

describe("the idempotency negative doubles", () => {
  it("passes every case against the honest double", async () => {
    const report = await run(new IdemDouble("none"));
    expect(report.summary).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
      error: 0
    });
  }, 30_000);

  it("detects a duplicate effect under promised idempotency", async () => {
    const report = await run(new IdemDouble("duplicate_effect"));
    // The defect ignores the key entirely, so the conflict case fails
    // as collateral; the primary detection point stays the retry.
    expect(report.summary).toEqual({
      passed: 1,
      failed: 2,
      skipped: 0,
      error: 0
    });
    const retry = stepOf(report, "replay-same-key", "retry");
    expect(retry.status).toBe("failed");
    const equals = retry.assertions.find(
      (assertion) => assertion.op === "equals"
    );
    expect(equals?.passed).toBe(false);
    expect(equals?.actual).toBe("job_00000002");
    expect(equals?.expected).toBe("job_00000001");
    expect(caseOf(report, "replay-same-key").failure_class).toBe(
      "assertion_failure"
    );
  }, 30_000);

  it("detects an incorrect rollback after a committed response is lost", async () => {
    const corpus = parseCorpus(parsePackYaml(LOSS_CORPUS_YAML));
    const honest = await run(
      new IdemDouble("none", "lose-first-create"),
      corpus
    );
    // Against the honest target the create committed before the cut:
    // the lost step stays without verdict and the read reconciles.
    const lost = stepOf(honest, "lost-create-reconciles", "create");
    expect(lost.status).toBe("lost");
    expect(lost.exchange?.status).toBeNull();
    expect(lost.exchange?.delivery).toBe("lost");
    expect(lost.assertions).toEqual([]);
    expect(honest.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      error: 0
    });
    expect(
      caseOf(honest, "lost-create-reconciles").failure_class
    ).toBeUndefined();

    // Against the defect the resource vanished: the read answers 404
    // and the case fails on that assertion, never on the loss itself.
    const defective = await run(
      new IdemDouble("incorrect_rollback", "lose-first-create"),
      corpus
    );
    const defectiveLost = stepOf(defective, "lost-create-reconciles", "create");
    expect(defectiveLost.status).toBe("lost");
    const readBack = stepOf(defective, "lost-create-reconciles", "read-back");
    expect(readBack.status).toBe("failed");
    expect(readBack.service_error).toBe(true);
    expect(defective.summary).toEqual({
      passed: 0,
      failed: 1,
      skipped: 0,
      error: 0
    });
    expect(caseOf(defective, "lost-create-reconciles").failure_class).toBe(
      "assertion_failure"
    );
  }, 30_000);
});

describe("corpus report error classifications", () => {
  it("marks an expected service error without failing the case", async () => {
    const report = await run(new IdemDouble("none"));
    const reuse = stepOf(report, "conflict-different-body", "reuse");
    expect(reuse.status).toBe("passed");
    expect(reuse.service_error).toBe(true);
    expect(caseOf(report, "conflict-different-body").status).toBe("passed");
  }, 30_000);

  it("classifies an assertion failure", async () => {
    const report = await run(new IdemDouble("duplicate_effect"));
    expect(report.summary.failed).toBe(2);
    expect(caseOf(report, "replay-same-key").failure_class).toBe(
      "assertion_failure"
    );
  }, 30_000);

  it("classifies a provider failure and ends the case", async () => {
    const corpus = parseCorpus(parsePackYaml(LOSS_CORPUS_YAML));
    const report = await run(
      new IdemDouble("none", "none", "provider_failure"),
      corpus
    );
    const record = caseOf(report, "lost-create-reconciles");
    expect(record.status).toBe("failed");
    expect(record.failure_class).toBe("provider_failure");
    expect(
      record.diagnostics.some(
        (entry) => entry.code === "OAL-CORPUS-PROVIDER-FAILURE"
      )
    ).toBe(true);
    // The case ended at the provider failure; the read never ran.
    expect(record.steps).toHaveLength(1);
  }, 30_000);

  it("classifies a runtime error from a thrown target", async () => {
    const corpus = parseCorpus(parsePackYaml(LOSS_CORPUS_YAML));
    const report = await run(new IdemDouble("none", "none", "throw"), corpus);
    const record = caseOf(report, "lost-create-reconciles");
    expect(record.status).toBe("error");
    expect(record.failure_class).toBe("runtime_error");
    expect(record.steps[0]?.status).toBe("error");
  }, 30_000);

  it("never reads a lost response as rollback evidence", async () => {
    const corpus = parseCorpus(parsePackYaml(LOSS_CORPUS_YAML));
    const report = await run(new IdemDouble("none", "none", "lost"), corpus);
    const record = caseOf(report, "lost-create-reconciles");
    // Both steps lost their transport. Neither carries a verdict, a
    // binding, or a state claim, and the case says so without
    // concluding anything about the target's state.
    for (const step of record.steps) {
      expect(step.status).toBe("lost");
      expect(step.exchange?.delivery).toBe("lost");
      expect(step.assertions).toEqual([]);
      expect(step.bindings).toEqual([]);
    }
    expect(record.status).toBe("passed");
    expect(record.failure_class).toBeUndefined();
    // Nothing was verified, so behavioral conformance stays
    // unevaluated instead of passing on absent failures.
    expect(record.behavioral_conformance).toBe("not_evaluated");
    expect(
      record.diagnostics.every(
        (entry) => entry.code === "OAL-CORPUS-RESPONSE-LOST"
      )
    ).toBe(true);
  }, 30_000);
});
