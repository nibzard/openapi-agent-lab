/**
 * The GitHub corpus target (specification sections 48.5 and 48.7).
 * It drives provider HTTP directly against the pinned API version:
 * serial requests, an explicit budget, version and media headers on
 * every call, and a unique run marker in every create. A mutating
 * request is never retried automatically; an ambiguous transport
 * failure records uncertainty and reconciles only through bounded
 * issue-list reads for the run marker, feeding the cleanup ledger
 * without ever synthesizing a response. Preflight rejects an absent
 * repository or token before any write leaves the process, and
 * credentials never enter reports.
 */

import type {
  CorpusTarget,
  CorpusTargetRequest,
  CorpusTargetResponse
} from "./target.ts";
import type { Json, JsonObject } from "@oal/core";

/** The pinned provider API version (section 48.7). */
export const GITHUB_API_VERSION = "2026-03-10";

/** The recommended JSON media type of the provider. */
const GITHUB_MEDIA_TYPE = "application/vnd.github+json";

/** Default HTTP request budget of one target. */
const DEFAULT_MAX_REQUESTS = 400;

/** Bounded read retries after a rate-limit answer. */
const DEFAULT_MAX_READ_RETRIES = 2;

/** Bounded pages an uncertain create may search for the run marker. */
const DEFAULT_RECONCILIATION_PAGES = 3;

/** Code prefix of every error this target raises. */
const ERROR_PREFIX = "OAL-GITHUB";

type FetchLike = typeof fetch;

export interface GithubTargetOptions {
  /** Provider token; null means no credentials were provided. */
  readonly token: string | null;
  /** Repository as owner/name; null means none was declared. */
  readonly repository: string | null;
  /** Unique marker stamped into every create's title and body. */
  readonly runMarker: string;
  /**
   * Writes must be explicitly allowed; a read-only target refuses
   * every mutating operation before any request leaves.
   */
  readonly allowLiveWrites: boolean;
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: FetchLike;
  /** Injected wall clock in epoch milliseconds; defaults to Date.now. */
  readonly now?: () => number;
  /** Injected sleeper; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRequests?: number;
  readonly maxReadRetries?: number;
  readonly maxReconciliationPages?: number;
}

/** One entry of the cleanup ledger. */
export interface CleanupLedgerEntry {
  readonly number: number;
  readonly origin: "response" | "reconciliation";
  readonly closed: boolean;
  readonly error?: string;
}

/** What a cleanup pass achieved, for the failure report. */
export interface CleanupResult {
  readonly closed: number;
  readonly failures: CleanupLedgerEntry[];
}

/** Every failure this target reports. */
export class GithubTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, Json>> = {}
  ) {
    super(message);
    this.name = "GithubTargetError";
  }
}

function invalid(code: string, message: string): never {
  throw new GithubTargetError(`${ERROR_PREFIX}-${code}`, message);
}

/** One captured issue number, recorded the moment it arrived. */
interface CapturedIssue {
  readonly number: number;
  readonly origin: "response" | "reconciliation";
}

/**
 * The provider adapter. One instance serves one corpus run; every
 * HTTP request passes a serial queue and the budget counter.
 */
export class GithubTarget implements CorpusTarget {
  readonly id = "github";
  readonly version: string;
  readonly capabilities = { operators: false, virtualTime: false };

  private readonly runMarker: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly maxRequests: number;
  private readonly maxReadRetries: number;
  private readonly maxReconciliationPages: number;
  private readonly fetchLike: FetchLike;
  private readonly now: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;

  private requestsSent = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private captured: CapturedIssue[] = [];
  private ledger: CleanupLedgerEntry[] = [];

  constructor(options: GithubTargetOptions) {
    this.runMarker = options.runMarker;
    this.apiVersion = options.apiVersion ?? GITHUB_API_VERSION;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxReadRetries = options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES;
    this.maxReconciliationPages =
      options.maxReconciliationPages ?? DEFAULT_RECONCILIATION_PAGES;
    this.version = this.apiVersion;
    this.fetchLike = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleeper = options.sleep ?? ((ms) => sleepWallClock(ms));
    this.writesAllowed = options.allowLiveWrites;
    this.token = options.token;
    this.repository = options.repository;
  }

  private readonly writesAllowed: boolean;
  private readonly token: string | null;
  readonly repository: string | null;

  /** The cleanup ledger of this run, in capture order. */
  cleanupLedger(): readonly CleanupLedgerEntry[] {
    return this.ledger;
  }

  /** Every issue number this run captured, in capture order. */
  capturedNumbers(): readonly number[] {
    return this.captured.map((entry) => entry.number);
  }

  async prepare(): Promise<void> {
    await Promise.resolve();
    // Preflight: an absent repository or token stops the run before
    // any write can leave the process.
    if (!this.writesAllowed) {
      invalid(
        "WRITES-NOT-ALLOWED",
        "The github target refuses writes: pass --allow-live-writes to permit them."
      );
    }
    if (this.repository === null || this.repository === "") {
      invalid(
        "REPOSITORY-MISSING",
        "The github target needs an explicit --repository owner/name before writes."
      );
    }
    if (this.token === null || this.token.length === 0) {
      invalid(
        "TOKEN-MISSING",
        "The github target needs GITHUB_TOKEN before writes; restrict it to a disposable repository."
      );
    }
  }

  async wait(ms: number): Promise<void> {
    // The provider waits by wall clock (section 48.5).
    await this.sleeper(ms);
  }

  async cleanup(): Promise<void> {
    const result = await this.closeCaptured();
    if (result.failures.length > 0) {
      // A failed cleanup is a non-success result that names every
      // resource it could and could not remove.
      invalid(
        "CLEANUP-FAILED",
        `Cleanup closed ${result.closed.toString(10)} of ${this.ledger.length.toString(10)} created issues; failures: ${JSON.stringify(result.failures)}`
      );
    }
  }

  async request(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    // One request at a time, in submission order.
    const run = this.queue.then(() => this.serve(instruction));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async serve(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    if (
      instruction.poll &&
      instruction.operationId !== "get_issue" &&
      instruction.operationId !== "list_issues"
    ) {
      invalid(
        "POLL-MUTATION",
        `Poll repeats read operations only; ${JSON.stringify(instruction.operationId)} is not a supported read.`
      );
    }
    switch (instruction.operationId) {
      case "create_issue":
        return this.createIssue(instruction);
      case "get_issue":
        return this.getIssue(instruction);
      case "list_issues":
        return this.listIssues(instruction);
      case "add_labels":
        return this.addLabels(instruction);
      case "update_issue":
        return this.updateIssue(instruction);
      default:
        invalid(
          "OPERATION-UNSUPPORTED",
          `The github target implements no operation ${JSON.stringify(instruction.operationId)}.`
        );
    }
  }

  // ---------------------------------------------------------------- sends

  /** One authorized send inside the budget. */
  private async send(init: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    query?: Readonly<Record<string, string>>;
    body?: Json;
    read: boolean;
    rateLimitRetries?: number;
  }): Promise<{ status: number; headers: Headers; text: string }> {
    if (this.requestsSent >= this.maxRequests) {
      // The budget is exhausted: a provider-side stop, not a crash.
      return {
        status: -2,
        headers: new Headers(),
        text: JSON.stringify({
          message: `The github target reached its request budget of ${this.maxRequests.toString(10)}.`
        })
      };
    }
    const url = new URL(`${this.baseUrl}${init.path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token ?? ""}`,
      accept: GITHUB_MEDIA_TYPE,
      "x-github-api-version": this.apiVersion
    };
    const body =
      init.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.fetchLike(url.toString(), {
        method: init.method,
        headers,
        ...(body === undefined ? {} : { body })
      });
    } catch (cause) {
      return {
        status: -1,
        headers: new Headers(),
        text: cause instanceof Error ? cause.message : String(cause)
      };
    }
    this.requestsSent += 1;
    // A rate-limit answer waits and retries reads only, boundedly.
    if (init.read && response.status > 0 && isRateLimited(response)) {
      const retries = init.rateLimitRetries ?? 0;
      if (retries < this.maxReadRetries) {
        const delay = retryAfterMs(response.headers, this.now);
        if (delay !== null) {
          await this.sleeper(delay);
          return this.send({ ...init, rateLimitRetries: retries + 1 });
        }
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text()
    };
  }

  // ------------------------------------------------------------ operators

  private repositoryOf(instruction: CorpusTargetRequest): {
    owner: string;
    repo: string;
  } {
    const owner = textOf(instruction.parameters.path.owner);
    const repo = textOf(instruction.parameters.path.repo);
    if (owner.length === 0 || repo.length === 0) {
      invalid(
        "REPOSITORY-MISSING",
        "The corpus request names no owner or repository."
      );
    }
    const declared = this.repository;
    if (
      declared !== null &&
      declared !== "" &&
      declared !== `${owner}/${repo}`
    ) {
      invalid(
        "REPOSITORY-MISMATCH",
        `The corpus addresses ${owner}/${repo}, but the run declared ${declared}.`
      );
    }
    return { owner, repo };
  }

  private staticIssuePath(
    instruction: CorpusTargetRequest,
    suffix: "" | "/labels"
  ): { owner: string; repo: string; number: number; path: string } {
    const { owner, repo } = this.repositoryOf(instruction);
    const number = Number(instruction.parameters.path.issue_number);
    if (!Number.isInteger(number) || number < 1) {
      invalid(
        "ISSUE-NUMBER-INVALID",
        "The corpus request names no issue number."
      );
    }
    return {
      owner,
      repo,
      number,
      path: `/repos/${owner}/${repo}/issues/${number.toString(10)}${suffix}`
    };
  }

  private async createIssue(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const { owner, repo } = this.repositoryOf(instruction);
    const raw = instruction.body;
    const body = isObject(raw ?? null) ? (raw as JsonObject) : null;
    const title = textOf(body?.title);
    if (body === null || title.length === 0) {
      // Let the provider's own validation answer; send as-is.
      const sent = await this.send({
        method: "POST",
        path: `/repos/${owner}/${repo}/issues`,
        body: raw ?? null,
        read: false
      });
      return this.responseOf(sent, "POST", `/repos/${owner}/${repo}/issues`);
    }
    // The run marker rides every create, so reconciliation can find
    // our issues and cleanup never touches unrelated ones.
    const marked: JsonObject = {
      title: `[${this.runMarker}] ${title}`,
      body: `${textOf(body.body)}\n\nrun-marker: ${this.runMarker}`
    };
    const sent = await this.send({
      method: "POST",
      path: `/repos/${owner}/${repo}/issues`,
      body: marked,
      read: false
    });
    if (sent.status === -1) {
      // An ambiguous transport failure: the issue may exist. Record
      // the uncertainty and reconcile only through bounded reads for
      // the run marker; the step itself keeps no verdict.
      await this.reconcileUncertainCreate(owner, repo);
      return {
        status: null,
        outcome: "lost",
        headers: {},
        body: null,
        method: "POST",
        url: `${this.baseUrl}/repos/${owner}/${repo}/issues`
      };
    }
    const parsed = parseJsonText(sent.text);
    const number = parsedNumber(parsed);
    if (sent.status === 201 && number !== null) {
      // Record the returned number immediately (section 48.7).
      this.capture(number, "response");
    }
    return this.responseOf(sent, "POST", `/repos/${owner}/${repo}/issues`);
  }

  /**
   * Search bounded issue-list pages for issues carrying only our run
   * marker. A unique match feeds the cleanup ledger; no response is
   * ever synthesized from it.
   */
  private async reconcileUncertainCreate(
    owner: string,
    repo: string
  ): Promise<void> {
    const matches: number[] = [];
    for (let page = 1; page <= this.maxReconciliationPages; page += 1) {
      const sent = await this.send({
        method: "GET",
        path: `/repos/${owner}/${repo}/issues`,
        query: { state: "open", per_page: "100", page: page.toString(10) },
        read: true
      });
      if (sent.status !== 200) {
        return;
      }
      const parsed = parseJsonText(sent.text);
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const entry of parsed) {
        if (!isObject(entry)) {
          continue;
        }
        const title = textOf(entry.title);
        if (
          title.startsWith(`[${this.runMarker}] `) &&
          parsedNumber(entry) !== null
        ) {
          matches.push(parsedNumber(entry) as number);
        }
      }
      if (parsed.length < 100) {
        break;
      }
    }
    if (matches.length === 1) {
      this.capture(matches[0] as number, "reconciliation");
    }
    // Zero or several matches stay uncertain; nothing is recorded.
  }

  private async getIssue(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const target = this.staticIssuePath(instruction, "");
    const sent = await this.send({
      method: "GET",
      path: target.path,
      read: true
    });
    return this.responseOf(sent, "GET", target.path);
  }

  private async listIssues(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const { owner, repo } = this.repositoryOf(instruction);
    const query: Record<string, string> = {
      state: textOf(instruction.parameters.query.state) || "open",
      per_page: boundedPerPage(instruction.parameters.query.per_page)
    };
    const page = instruction.parameters.query.page;
    if (page !== undefined) {
      const value = Number(page);
      if (Number.isInteger(value) && value >= 1) {
        query.page = value.toString(10);
      }
    }
    const path = `/repos/${owner}/${repo}/issues`;
    const sent = await this.send({
      method: "GET",
      path,
      query,
      read: true
    });
    return this.responseOf(sent, "GET", path);
  }

  private async addLabels(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const target = this.staticIssuePath(instruction, "/labels");
    const raw = instruction.body;
    const sent = await this.send({
      method: "POST",
      path: target.path,
      body: raw === undefined ? { labels: [] } : raw,
      read: false
    });
    return this.responseOf(sent, "POST", target.path);
  }

  private async updateIssue(
    instruction: CorpusTargetRequest
  ): Promise<CorpusTargetResponse> {
    const target = this.staticIssuePath(instruction, "");
    const sent = await this.send({
      method: "PATCH",
      path: target.path,
      body: rawBodyOf(instruction),
      read: false
    });
    return this.responseOf(sent, "PATCH", target.path);
  }

  // -------------------------------------------------------------- cleanup

  /** Close every captured issue; never an unrelated one. */
  private async closeCaptured(): Promise<CleanupResult> {
    let closed = 0;
    const failures: CleanupLedgerEntry[] = [];
    const [owner, repo] = splitRepository(this.repository);
    for (const entry of this.captured) {
      const record: CleanupLedgerEntry = {
        number: entry.number,
        origin: entry.origin,
        closed: false
      };
      if (owner === null || repo === null) {
        this.ledger.push({ ...record, error: "no repository declared" });
        continue;
      }
      try {
        const sent = await this.send({
          method: "PATCH",
          path: `/repos/${owner}/${repo}/issues/${entry.number.toString(10)}`,
          body: { state: "closed" },
          read: false
        });
        if (sent.status === 200) {
          closed += 1;
          this.ledger.push({ ...record, closed: true });
        } else {
          this.ledger.push({
            ...record,
            error: `close answered ${sent.status.toString(10)}`
          });
        }
      } catch (cause) {
        this.ledger.push({
          ...record,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
    for (const entry of this.ledger) {
      if (entry.error !== undefined || !entry.closed) {
        failures.push(entry);
      }
    }
    return { closed, failures };
  }

  // --------------------------------------------------------------- views

  private responseOf(
    sent: { status: number; headers: Headers; text: string },
    method: string,
    path: string
  ): CorpusTargetResponse {
    const headers: Record<string, string> = {};
    sent.headers.forEach((value, name) => {
      if (!SENSITIVE_HEADER.test(name)) {
        headers[name.toLowerCase()] = value;
      }
    });
    return {
      status: sent.status === -1 || sent.status === -2 ? null : sent.status,
      ...(sent.status === -1
        ? { outcome: "lost" as const }
        : sent.status === -2
          ? { outcome: "provider_failure" as const }
          : {}),
      headers,
      body: parseJsonText(sent.text),
      method,
      url: `${this.baseUrl}${path}`
    };
  }

  private capture(number: number, origin: CapturedIssue["origin"]): void {
    if (this.captured.some((entry) => entry.number === number)) {
      return;
    }
    this.captured.push({ number, origin });
  }
}

/** Header names that never enter a report. */
const SENSITIVE_HEADER =
  /authorization|cookie|token|api[-_]?key|session|secret/i;

function isObject(value: Json | null): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: Json | undefined): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
}

function rawBodyOf(instruction: CorpusTargetRequest): Json {
  return instruction.body ?? null;
}

function parseJsonText(text: string): Json {
  if (text.length === 0) {
    return null;
  }
  try {
    return (JSON.parse(text) as Json) ?? null;
  } catch {
    return text;
  }
}

function parsedNumber(value: Json | null): number | null {
  if (!isObject(value)) {
    return null;
  }
  const number = value.number;
  return typeof number === "number" && Number.isInteger(number) ? number : null;
}

function boundedPerPage(value: Json | undefined): string {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return Math.min(parsed, 100).toString(10);
  }
  return "30";
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("retry-after") !== null)
  );
}

function retryAfterMs(headers: Headers, now: () => number): number | null {
  const seconds = headers.get("retry-after");
  if (seconds !== null) {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) {
      return Math.min(value * 1000, 60_000);
    }
  }
  const date = headers.get("x-ratelimit-reset");
  if (date !== null) {
    const value = Number(date);
    if (Number.isFinite(value) && value > 0) {
      return Math.max(0, Math.min((value - now() / 1000) * 1000, 60_000));
    }
  }
  return null;
}

function splitRepository(
  repository: string | null
): [string | null, string | null] {
  if (repository === null) {
    return [null, null];
  }
  const cut = repository.indexOf("/");
  if (cut < 1 || cut === repository.length - 1) {
    return [null, null];
  }
  return [repository.slice(0, cut), repository.slice(cut + 1)];
}

function sleepWallClock(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
