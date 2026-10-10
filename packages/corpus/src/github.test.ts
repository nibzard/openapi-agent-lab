/**
 * GitHub target tests (specification sections 48.5 and 48.7) against
 * local HTTP doubles. Every check injects the fetch, the clock, and
 * the sleeper, so ordinary continuous integration needs no token and
 * touches no network. The doubles pin the request discipline: the
 * credential, media, and version headers; serial bounded requests;
 * rate-limit waits on reads only; no automatic retry of a mutating
 * request; run markers; uncertain-creation reconciliation; and the
 * cleanup ledger.
 */

import { describe, expect, it } from "vitest";

import { GithubTarget, GITHUB_API_VERSION } from "./github.ts";
import type { CorpusTargetRequest } from "./target.ts";
import type { Json } from "@oal/core";

/** One recorded outgoing request. */
interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Json | undefined;
}

/** A scripted double of the provider transport. */
class TransportDouble {
  readonly calls: Recorded[] = [];
  readonly sleeps: number[] = [];

  constructor(
    private readonly route: (
      call: Recorded,
      index: number
    ) => { status: number; headers?: Record<string, string>; body?: Json }
  ) {}

  fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init === undefined ? undefined : init.headers;
    for (const [name, value] of Object.entries(
      (rawHeaders ?? {}) as Record<string, string>
    )) {
      headers[name.toLowerCase()] = value;
    }
    const bodyText = textOfBody(init === undefined ? undefined : init.body);
    const call: Recorded = {
      method: init === undefined ? "GET" : (init.method ?? "GET"),
      url,
      headers,
      body: bodyText === null ? undefined : (JSON.parse(bodyText) as Json)
    };
    this.calls.push(call);
    const answer = this.route(call, this.calls.length - 1);
    return Promise.resolve(
      new Response(
        answer.body === undefined ? "" : JSON.stringify(answer.body),
        {
          status: answer.status,
          headers: answer.headers ?? {}
        }
      )
    );
  };

  readonly sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    return Promise.resolve();
  };
}

/** Extract a fetch body as text when it is one. */
function textOfBody(body: unknown): string | null {
  return typeof body === "string" ? body : null;
}

function target(
  transport: TransportDouble,
  overrides: Partial<ConstructorParameters<typeof GithubTarget>[0]> = {}
): GithubTarget {
  return new GithubTarget({
    token: "test-token",
    repository: "example/triage",
    runMarker: "run-2026-10-10-a1",
    allowLiveWrites: true,
    baseUrl: "https://provider.invalid",
    fetch: transport.fetch,
    sleep: transport.sleep,
    now: () => 1_700_000_000_000,
    ...overrides
  });
}

function createRequest(): CorpusTargetRequest {
  return {
    operationId: "create_issue",
    parameters: {
      path: { owner: "example", repo: "triage" },
      query: {},
      header: {}
    },
    body: { title: "Double create", body: "Created by the double." },
    poll: false
  };
}

function readRequest(number: number): CorpusTargetRequest {
  return {
    operationId: "get_issue",
    parameters: {
      path: { owner: "example", repo: "triage", issue_number: number },
      query: {},
      header: {}
    },
    body: undefined,
    poll: false
  };
}

function listRequest(): CorpusTargetRequest {
  return {
    operationId: "list_issues",
    parameters: {
      path: { owner: "example", repo: "triage" },
      query: { state: "open", per_page: 100 },
      header: {}
    },
    body: undefined,
    poll: true
  };
}

const ISSUE = (number: number, title: string): Json => ({
  id: 9000 + number,
  number,
  title,
  state: "open",
  labels: []
});

describe("the github target", () => {
  it("sends the credential, media, and version headers on every request", async () => {
    const transport = new TransportDouble(() => ({
      status: 201,
      body: ISSUE(7, "[run-2026-10-10-a1] Double create")
    }));
    const adapter = target(transport);
    await adapter.prepare();
    await adapter.request(createRequest());
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.headers.authorization).toBe("Bearer test-token");
    expect(call?.headers.accept).toBe("application/vnd.github+json");
    expect(call?.headers["x-github-api-version"]).toBe(GITHUB_API_VERSION);
    expect(call?.headers["content-type"]).toBe("application/json");
    // The token never rides the URL.
    expect(call?.url).not.toContain("test-token");
  });

  it("rejects missing writes permission, repository, or token before any request", async () => {
    const transport = new TransportDouble(() => ({ status: 200 }));
    const noWrites = target(transport, { allowLiveWrites: false });
    await expect(noWrites.prepare()).rejects.toMatchObject({
      code: "OAL-GITHUB-WRITES-NOT-ALLOWED"
    });
    const noRepository = target(transport, { repository: null });
    await expect(noRepository.prepare()).rejects.toMatchObject({
      code: "OAL-GITHUB-REPOSITORY-MISSING"
    });
    const noToken = target(transport, { token: null });
    await expect(noToken.prepare()).rejects.toMatchObject({
      code: "OAL-GITHUB-TOKEN-MISSING"
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("stamps the run marker into every create", async () => {
    const transport = new TransportDouble(() => ({
      status: 201,
      body: ISSUE(7, "[run-2026-10-10-a1] Double create")
    }));
    const adapter = target(transport);
    await adapter.prepare();
    await adapter.request(createRequest());
    const body = transport.calls[0]?.body as { title: string; body: string };
    expect(body.title).toBe("[run-2026-10-10-a1] Double create");
    expect(body.body).toContain("run-marker: run-2026-10-10-a1");
    // The returned number is captured immediately for cleanup.
    expect(adapter.capturedNumbers()).toEqual([7]);
  });

  it("sends list queries explicitly and bounds the page size", async () => {
    const transport = new TransportDouble(() => ({
      status: 200,
      body: [ISSUE(1, "Seeded"), ISSUE(7, "[run-2026-10-10-a1] Double create")]
    }));
    const adapter = target(transport);
    await adapter.prepare();
    const response = await adapter.request(listRequest());
    expect(response.status).toBe(200);
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("state=open");
    expect(url).toContain("per_page=100");
    // An oversized request clamps to the provider bound of 100.
    await adapter.request({
      ...listRequest(),
      parameters: {
        ...listRequest().parameters,
        query: { state: "all", per_page: 500 }
      }
    });
    expect(transport.calls[1]?.url).toContain("per_page=100");
  });

  it("waits a rate limit and retries reads only", async () => {
    let reads = 0;
    const transport = new TransportDouble((call) => {
      if (call.method === "GET" && reads === 0) {
        reads += 1;
        return {
          status: 403,
          headers: { "retry-after": "2" },
          body: { message: "rate limit exceeded" }
        };
      }
      return { status: 200, body: ISSUE(7, "read") };
    });
    const adapter = target(transport);
    await adapter.prepare();
    const response = await adapter.request(readRequest(7));
    expect(response.status).toBe(200);
    expect(transport.sleeps).toEqual([2000]);
    expect(transport.calls).toHaveLength(2);

    // A mutating request that hits a rate limit is never retried.
    let writes = 0;
    const writeTransport = new TransportDouble(() => {
      writes += 1;
      return {
        status: 403,
        headers: { "retry-after": "2" },
        body: { message: "rate limit exceeded" }
      };
    });
    const writeAdapter = target(writeTransport);
    await writeAdapter.prepare();
    const writeResponse = await writeAdapter.request(createRequest());
    expect(writeResponse.status).toBe(403);
    expect(writes).toBe(1);
    expect(writeTransport.sleeps).toEqual([]);
  });

  it("records an uncertain creation and reconciles boundedly", async () => {
    let createSent = false;
    const transport = new TransportDouble((call) => {
      if (call.method === "POST" && !createSent) {
        createSent = true;
        throw new Error("connection reset by peer");
      }
      if (call.url.includes("/issues?")) {
        return {
          status: 200,
          body: [
            ISSUE(1, "unrelated"),
            ISSUE(9, "[run-2026-10-10-a1] Double create")
          ]
        };
      }
      return {
        status: 200,
        body: ISSUE(9, "[run-2026-10-10-a1] Double create")
      };
    });
    const adapter = target(transport, { maxReconciliationPages: 2 });
    await adapter.prepare();
    const response = await adapter.request(createRequest());
    // The step keeps no verdict: the loss is uncertainty.
    expect(response.status).toBeNull();
    expect(response.outcome).toBe("lost");
    // Reconciliation searched bounded list pages for the marker and
    // captured the unique match for cleanup.
    const lists = transport.calls.filter((call) =>
      call.url.includes("/issues?")
    );
    expect(lists.length).toBeLessThanOrEqual(2);
    expect(adapter.capturedNumbers()).toEqual([9]);
    // A close in cleanup uses the reconciled number.
    await adapter.cleanup();
    const close = transport.calls.find(
      (call) => call.method === "PATCH" && call.url.endsWith("/issues/9")
    );
    expect(close?.body).toEqual({ state: "closed" });
  });

  it("fails cleanup when a close is refused", async () => {
    const transport = new TransportDouble((call) => {
      if (call.method === "POST") {
        return { status: 201, body: ISSUE(7, "[run-2026-10-10-a1] x") };
      }
      // Every close is refused: gone.
      return { status: 410, body: { message: "gone" } };
    });
    const adapter = target(transport);
    await adapter.prepare();
    await adapter.request(createRequest());
    await expect(adapter.cleanup()).rejects.toMatchObject({
      code: "OAL-GITHUB-CLEANUP-FAILED"
    });
    const ledger = adapter.cleanupLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.number).toBe(7);
    expect(ledger[0]?.closed).toBe(false);
    expect(ledger[0]?.error).toContain("410");
  });

  it("serves requests serially with no overlap", async () => {
    const holder: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      holder.release = resolve;
    });
    const transport = new TransportDouble(() => ({
      status: 200,
      body: ISSUE(7, "read")
    }));
    // Delay the first response until the test releases it.
    const originalFetch = transport.fetch;
    let first = true;
    const gatedFetch = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const isFirst = first;
      first = false;
      const answer = await originalFetch(input, init);
      if (isFirst) {
        await gate;
      }
      return answer;
    };
    transport.fetch = gatedFetch;
    const adapter = target(transport);
    await adapter.prepare();
    const one = adapter.request(readRequest(7));
    const two = adapter.request(readRequest(7));
    // The first request is in flight and the second has not started.
    await Promise.resolve();
    expect(transport.calls).toHaveLength(1);
    holder.release?.();
    const [firstDone, secondDone] = await Promise.all([one, two]);
    expect(firstDone.status).toBe(200);
    expect(secondDone.status).toBe(200);
    expect(transport.calls).toHaveLength(2);
  });

  it("stops as a provider failure when the budget is exhausted", async () => {
    const transport = new TransportDouble(() => ({
      status: 200,
      body: ISSUE(7, "read")
    }));
    const adapter = target(transport, { maxRequests: 1 });
    await adapter.prepare();
    const first = await adapter.request(readRequest(7));
    expect(first.status).toBe(200);
    const second = await adapter.request(readRequest(7));
    expect(second.status).toBeNull();
    expect(second.outcome).toBe("provider_failure");
  });
});
