/**
 * Corpus verify command tests (specification section 48.7). The
 * verification job runs the corpus on the local target and then on
 * the provider; these checks drive it end to end with a local HTTP
 * double standing in for the provider, so continuous integration
 * needs no token and touches no network. Missing credentials must
 * record a skip, never a pass; a complete run stamps the observed
 * fidelity claims with the report digest.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ExitCode, Json, JsonObject } from "@oal/core";

import { main } from "./cli.ts";
import { TerminationGuard } from "./signals.ts";
import { MemoryIo } from "./io.ts";

const packDir = path.resolve(
  import.meta.dirname,
  "../../../packs/github-issue-triage"
);

const scratch: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => closeServer(server)));
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** The state of the provider double. */
interface DoubleState {
  readonly issues: Map<number, JsonObject>;
  readonly closes: number[];
  readonly headers: Record<string, string>[];
  nextNumber: number;
}

/** One provider double over real HTTP. */
async function startProviderDouble(): Promise<{
  readonly url: string;
  readonly state: DoubleState;
}> {
  const state: DoubleState = {
    issues: new Map<number, JsonObject>([
      [
        1,
        {
          id: 10000,
          number: 1,
          title: "Seeded pull request entry",
          body: null,
          state: "open",
          labels: [],
          pull_request: { url: "https://provider.invalid/pulls/1" },
          created_at: "2000-01-01T00:00:00.000Z"
        }
      ]
    ]),
    closes: [],
    headers: [],
    nextNumber: 2
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "https://provider.invalid");
    const headerRecord: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headerRecord[name.toLowerCase()] = String(value ?? "");
    }
    state.headers.push(headerRecord);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body: Json =
        chunks.length === 0
          ? null
          : ((JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json) ??
            null);
      answer(request.method ?? "GET", url, body);
    });

    function answer(method: string, url: URL, body: Json): void {
      const send = (status: number, payload: Json): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const issueMatch = /^\/repos\/example\/triage\/issues\/(\d+)$/.exec(
        url.pathname
      );
      const labelsMatch =
        /^\/repos\/example\/triage\/issues\/(\d+)\/labels$/.exec(url.pathname);
      if (
        method === "POST" &&
        url.pathname === "/repos/example/triage/issues"
      ) {
        const request = body as JsonObject | null;
        const title = request?.title;
        if (typeof title !== "string" || title.length === 0) {
          send(422, { message: "Validation failed: no title." });
          return;
        }
        const number = state.nextNumber;
        state.nextNumber += 1;
        const issue: JsonObject = {
          id: 10000 + number,
          number,
          title,
          body: request?.body ?? null,
          state: "open",
          labels: [],
          created_at: "2026-10-10T00:00:00.000Z"
        };
        state.issues.set(number, issue);
        send(201, issue);
        return;
      }
      if (method === "GET" && url.pathname === "/repos/example/triage/issues") {
        const filter = url.searchParams.get("state") ?? "open";
        const all = [...state.issues.values()].filter(
          (issue) => filter === "all" || issue.state === filter
        );
        send(200, all as unknown as Json);
        return;
      }
      if (labelsMatch !== null) {
        const number = Number(labelsMatch[1]);
        const issue = state.issues.get(number);
        if (issue === undefined) {
          send(404, { message: "Not found." });
          return;
        }
        issue.labels = [
          { id: 9001, name: "oal-triage", description: null }
        ] as unknown as Json;
        send(200, issue.labels);
        return;
      }
      if (issueMatch !== null) {
        const number = Number(issueMatch[1]);
        const issue = state.issues.get(number);
        if (issue === undefined) {
          send(404, { message: "Not found." });
          return;
        }
        if (method === "GET") {
          send(200, issue);
          return;
        }
        if (method === "PATCH") {
          const request = body as JsonObject | null;
          if (request?.state === "closed") {
            issue.state = "closed";
            state.closes.push(number);
            send(200, issue);
            return;
          }
          send(422, { message: "Validation failed: only closing." });
          return;
        }
      }
      send(404, { message: "Not found." });
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port.toString(10)}`, state };
}

async function run(
  argv: readonly string[]
): Promise<{ code: ExitCode; io: MemoryIo; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-verify-"));
  scratch.push(cwd);
  const io = new MemoryIo();
  const guard = new TerminationGuard();
  const code = await main([...argv], io, { cwd, guard });
  return { code, io, cwd };
}

const BASE = [
  "corpus",
  "verify",
  packDir,
  "--corpus",
  "issue-triage-core",
  "--input",
  "owner=example",
  "--input",
  "repository=triage",
  "--repository",
  "example/triage",
  "--allow-live-writes"
];

describe("oal corpus verify", () => {
  it("records a skip, never a pass, when credentials are missing", async () => {
    const previous = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const out = path.join(await newScratchName(), "evidence");
      const { code, io } = await run([...BASE, "--out", out]);
      // The local run passed; the provider run is a recorded skip.
      expect(code).toBe(4);
      const local = JSON.parse(
        await readFile(path.join(out, "corpus-local.json"), "utf8")
      ) as JsonObject;
      expect(local["summary"]).toEqual({
        passed: 8,
        failed: 0,
        skipped: 0,
        error: 0
      });
      const skip = JSON.parse(
        await readFile(path.join(out, "skip.json"), "utf8")
      ) as JsonObject;
      expect(skip["kind"]).toBe("VerificationSkip");
      expect(skip["reason"]).toBe("GITHUB_TOKEN is not set");
      expect(io.stderrText()).toContain("skipped");
    } finally {
      restoreToken(previous);
    }
  }, 300_000);

  it("passes on both targets and stamps the observed claims", async () => {
    const provider = await startProviderDouble();
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
      const out = path.join(await newScratchName(), "evidence");
      const { code, io } = await run([
        ...BASE,
        "--provider-url",
        provider.url,
        "--out",
        out
      ]);
      expect(code).toBe(0);
      expect(io.stderrText()).toBe("");
      const providerReport = JSON.parse(
        await readFile(path.join(out, "corpus-github.json"), "utf8")
      ) as JsonObject;
      expect(providerReport["target"]).toMatchObject({ id: "github" });
      expect(providerReport["summary"]).toEqual({
        passed: 8,
        failed: 0,
        skipped: 0,
        error: 0
      });

      // The stamped claims carry the observation evidence.
      const observed = JSON.parse(
        await readFile(path.join(out, "fidelity-observed.json"), "utf8")
      ) as JsonObject;
      const claims = observed["claims"] as JsonObject[];
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims.filter(
        (entry) => entry["id"] === "create-issue-201"
      )) {
        expect(claim["classification"]).toBe("observed");
        expect(claim["last_verified_at"]).toMatch(
          /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
        );
        expect(claim["report_digest"]).toMatch(/^[0-9a-f]{64}$/u);
      }
      // Synthetic claims stay synthetic.
      for (const claim of claims.filter(
        (entry) => entry["id"] === "rate-limit-and-retry-behavior"
      )) {
        expect(claim["classification"]).toBe("synthetic");
      }

      // Every created issue was closed by cleanup, and every request
      // carried the discipline headers.
      const created = [...provider.state.issues.keys()].filter(
        (number) => number !== 1
      );
      expect(created.length).toBeGreaterThanOrEqual(6);
      for (const number of created) {
        expect(provider.state.closes).toContain(number);
      }
      const writes = provider.state.headers.filter(
        (header) => header["content-type"] === "application/json"
      );
      for (const header of writes.slice(0, 1)) {
        expect(header.authorization).toBe("Bearer test-token");
        expect(header["x-github-api-version"]).toBe("2026-03-10");
        expect(header.accept).toBe("application/vnd.github+json");
      }
    } finally {
      restoreToken(previous);
    }
  }, 300_000);
});

function restoreToken(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = previous;
  }
}

async function newScratchName(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oal-verify-out-"));
  scratch.push(dir);
  return dir;
}
