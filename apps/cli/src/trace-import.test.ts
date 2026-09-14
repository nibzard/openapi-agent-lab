import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, SchemaValidator, type Json } from "@oal/core";

import { main } from "./cli.ts";
import { MemoryIo } from "./io.ts";
import { TraceImportCliCode } from "./handlers/trace-import.ts";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function newWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oal-trace-import-"));
  scratchDirectories.push(cwd);
  return cwd;
}

/** One canary credential the import must never persist. */
const HAR_BEARER = "Bearer har-canary-2f9d61";
const HAR_COOKIE = "session=har-cookie-canary-77";
/** A second canary that travels in a header and in body text. */
const HAR_BODY_SECRET = "har-body-canary-c41f88";

/** A small contract: list, create, and read clips, with a state enum. */
const CONTRACT = {
  openapi: "3.1.0",
  info: { title: "clips", version: "1.0.0" },
  paths: {
    "/v1/clips": {
      get: {
        operationId: "list_clips",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { type: "string" } }
                  },
                  required: ["items"]
                }
              }
            }
          }
        }
      },
      post: {
        operationId: "create_clip",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"]
              }
            }
          }
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"]
                }
              }
            }
          }
        }
      }
    },
    "/v1/clips/{clipId}": {
      get: {
        operationId: "get_clip",
        parameters: [
          {
            name: "clipId",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    state: { type: "string", enum: ["ready", "failed"] }
                  },
                  required: ["id", "state"]
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

/**
 * The same contract, authenticated by one API key header. Used to prove
 * credential presence recognizes contract-declared wire names.
 */
const API_KEY_CONTRACT = {
  ...CONTRACT,
  components: {
    securitySchemes: {
      clipKey: { type: "apiKey", in: "header", name: "X-Clip-Key" }
    }
  }
} as const;

/** One Chrome HAR 1.2 entry. */
function harEntry(input: {
  method: string;
  url: string;
  status: number;
  responseJson?: Json;
  requestJson?: Json;
  startedDateTime?: string;
  requestMime?: string;
  requestText?: string;
  responseMime?: string;
  responseText?: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  queryString?: Array<{ name: string; value: string }>;
  omitCredentialHeaders?: boolean;
}): Json {
  const hasBody =
    input.requestJson !== undefined || input.requestText !== undefined;
  const requestMime = input.requestMime ?? "application/json";
  const bodyText =
    input.requestText ?? JSON.stringify(input.requestJson ?? null);
  const responseMime = input.responseMime ?? "application/json";
  return {
    startedDateTime: input.startedDateTime ?? "2026-08-31T09:00:03.573Z",
    time: 42,
    request: {
      method: input.method,
      url: input.url,
      httpVersion: "HTTP/1.1",
      headers: [
        ...(input.omitCredentialHeaders
          ? []
          : [
              { name: "Authorization", value: HAR_BEARER },
              { name: "Cookie", value: HAR_COOKIE }
            ]),
        { name: "Accept", value: "application/json" },
        ...(hasBody ? [{ name: "Content-Type", value: requestMime }] : []),
        ...(input.requestHeaders ?? [])
      ],
      queryString: input.queryString ?? [],
      cookies: [],
      headersSize: -1,
      bodySize: hasBody ? 24 : 0,
      ...(hasBody
        ? { postData: { mimeType: requestMime, text: bodyText } }
        : {})
    },
    response: {
      status: input.status,
      httpVersion: "HTTP/1.1",
      headers: [
        {
          name: "Content-Type",
          value: responseMime
        }
      ],
      cookies: [],
      content: {
        size: 32,
        mimeType: responseMime,
        text:
          input.responseText ??
          (input.responseJson === undefined
            ? ""
            : JSON.stringify(input.responseJson))
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: 32
    },
    cache: {},
    timings: { send: 1, wait: 40, receive: 1 }
  };
}

/** Two matching entries, one unmatched route, one schema-invalid response. */
function syntheticHar(): Json {
  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "1" },
      entries: [
        harEntry({
          method: "GET",
          url: "https://api.example.test/v1/clips",
          status: 200,
          responseJson: { items: ["clip_1"] }
        }),
        harEntry({
          method: "POST",
          url: "https://api.example.test/v1/clips",
          status: 201,
          requestJson: { url: "https://example.com/page" },
          responseJson: { id: "clip_1" }
        }),
        harEntry({
          method: "GET",
          url: "https://api.example.test/v1/clippes/clip_1",
          status: 404
        }),
        harEntry({
          method: "GET",
          url: "https://api.example.test/v1/clips/clip_1",
          status: 200,
          responseJson: { id: "clip_1", state: "unknown-state" }
        })
      ]
    }
  };
}

interface ImportSummary {
  kind: string;
  run_id: string;
  session_dir: string;
  entries: number;
  matched: number;
  diagnostics: Array<{ code: string; message: string }>;
}

/** The parsed events of one written session trace. */
async function readEvents(sessionDir: string): Promise<Json[]> {
  const lines = (await readFile(path.join(sessionDir, "trace.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as Json);
}

async function importDocument(
  cwd: string,
  document: Json,
  options: {
    /** A contract value; the readonly test literals stringify the same. */
    contract?: unknown;
    flags?: readonly string[];
  } = {}
): Promise<{
  io: MemoryIo;
  code: number;
  summary: ImportSummary | undefined;
}> {
  const har = path.join(cwd, "session.har");
  const contract = path.join(cwd, "openapi.json");
  await writeFile(har, JSON.stringify(document));
  await writeFile(contract, JSON.stringify(options.contract ?? CONTRACT));
  const io = new MemoryIo();
  const code = await main(
    [
      "trace",
      "import",
      har,
      "--contract",
      contract,
      ...(options.flags ?? []),
      "--format",
      "json"
    ],
    io,
    { cwd }
  );
  const text = io.stdoutChunks.join("");
  const summary =
    code === EXIT_OK && text.length > 0
      ? (JSON.parse(text) as ImportSummary)
      : undefined;
  return { io, code, summary };
}

/** Import the synthetic recording, with extra CLI flags. */
async function importHar(
  cwd: string,
  flags: readonly string[] = []
): Promise<{
  io: MemoryIo;
  code: number;
  summary: ImportSummary | undefined;
}> {
  return await importDocument(cwd, syntheticHar(), { flags });
}

describe("oal trace import", () => {
  it("normalizes a HAR into a schema-valid trace with diagnostics", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "imported-session");
    const { io, code, summary } = await importHar(cwd, ["--out", out]);
    expect(code).toBe(EXIT_OK);
    expect(summary?.kind).toBe("TraceImportReport");
    expect(summary?.entries).toBe(4);
    expect(summary?.matched).toBe(3);
    expect(summary?.session_dir).toBe(out);

    const stderr = io.stderrText();
    expect(stderr).toContain(TraceImportCliCode.RouteUnmatched);
    expect(stderr).toContain("GET /v1/clippes/clip_1");
    expect(stderr).toContain(TraceImportCliCode.ResponseInvalid);
    expect(stderr).toContain("/state");

    const lines = (await readFile(path.join(out, "trace.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "trace-event.v1.schema.json"),
        "utf8"
      )
    ) as Json;
    const validator = new SchemaValidator(schema);
    for (const line of lines) {
      expect(validator.errors(JSON.parse(line) as Json)).toEqual([]);
    }
    const third = JSON.parse(lines[2] ?? "") as {
      operation: { matched: boolean };
      error: { code: string } | null;
    };
    expect(third.operation.matched).toBe(false);
    expect(third.error?.code).toBe("route_not_found");
    const fourth = JSON.parse(lines[3] ?? "") as {
      validation: { response: { status: string; violations: unknown[] } };
    };
    expect(fourth.validation.response.status).toBe("invalid");
    expect(fourth.validation.response.violations.length).toBeGreaterThan(0);
  });

  it("never persists credential header values from the HAR", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "imported-session");
    const { code } = await importHar(cwd, ["--out", out]);
    expect(code).toBe(EXIT_OK);
    const trace = await readFile(path.join(out, "trace.jsonl"), "utf8");
    expect(trace).not.toContain(HAR_BEARER);
    expect(trace).not.toContain("har-canary-2f9d61");
    expect(trace).not.toContain(HAR_COOKIE);
    expect(trace).not.toContain("har-cookie-canary-77");
    const first = JSON.parse(
      (await readFile(path.join(out, "trace.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)[0] ?? ""
    ) as {
      request: {
        headers: Array<{ name: string; values: string[]; redacted: boolean }>;
        credential_present: boolean;
      };
    };
    const authorization = first.request.headers.find(
      (header) => header.name === "authorization"
    );
    expect(authorization).toEqual({
      name: "authorization",
      values: ["[REDACTED]"],
      redacted: true
    });
    expect(first.request.credential_present).toBe(true);
  });

  it("is deterministic for one HAR and names the session by digest", async () => {
    const cwd = await newWorkspace();
    const first = await importHar(cwd, ["--out", path.join(cwd, "session-a")]);
    const second = await importHar(cwd, ["--out", path.join(cwd, "session-b")]);
    expect(first.code).toBe(EXIT_OK);
    expect(second.code).toBe(EXIT_OK);
    expect(second.summary?.run_id).toBe(first.summary?.run_id);
    expect(first.summary?.run_id).toMatch(/^import-[a-f0-9]+$/);
    const traceA = await readFile(
      path.join(cwd, "session-a", "trace.jsonl"),
      "utf8"
    );
    const traceB = await readFile(
      path.join(cwd, "session-b", "trace.jsonl"),
      "utf8"
    );
    expect(traceA).toBe(traceB);
  });

  it("writes the session under .oal/sessions by default", async () => {
    const cwd = await newWorkspace();
    const { code, summary } = await importHar(cwd);
    expect(code).toBe(EXIT_OK);
    const expected = path.join(cwd, ".oal", "sessions", summary?.run_id ?? "");
    expect(summary?.session_dir).toBe(expected);
    const entries = await readdir(path.join(cwd, ".oal", "sessions"));
    expect(entries).toEqual([summary?.run_id]);
    const capabilities = await stat(
      path.join(expected, "capability-report.json")
    );
    expect(capabilities.isFile()).toBe(true);
  });

  it("refuses a session target that already exists", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "already-there");
    await writeFile(out, "x");
    const { io, code } = await importHar(cwd, ["--out", out]);
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(TraceImportCliCode.TargetStale);
  });

  it("refuses a HAR without entries", async () => {
    const cwd = await newWorkspace();
    const har = path.join(cwd, "broken.har");
    await writeFile(har, JSON.stringify({ log: { version: "1.2" } }));
    const contract = path.join(cwd, "openapi.json");
    await writeFile(contract, JSON.stringify(CONTRACT));
    const io = new MemoryIo();
    const code = await main(
      ["trace", "import", har, "--contract", contract],
      io,
      { cwd }
    );
    expect(code).toBe(EXIT_INVALID);
    expect(io.stderrText()).toContain(TraceImportCliCode.HarInvalid);
  });

  it("feeds oal friction, which labels the incidents external", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "imported-session");
    const { code, summary } = await importHar(cwd, ["--out", out]);
    expect(code).toBe(EXIT_OK);
    const io = new MemoryIo();
    const frictionCode = await main(["friction", out, "--format", "json"], io, {
      cwd
    });
    expect(frictionCode).toBe(EXIT_OK);
    const report = JSON.parse(io.stdoutChunks.join("")) as {
      scope: { level: string; id: string };
      counts: { trials: number; exchanges: number };
      incidents: Array<{ kind: string; origin: string }>;
    };
    expect(report.scope).toEqual({ level: "run", id: summary?.run_id });
    expect(report.counts).toMatchObject({ trials: 1, exchanges: 4 });
    const unmatched = report.incidents.find(
      (incident) => incident.kind === "route_unmatched"
    );
    expect(unmatched?.origin).toBe("external");
    expect(
      report.incidents.every((incident) => incident.origin === "external")
    ).toBe(true);
  });

  it("scrubs a credential echoed in a text body and a query string", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "imported-session");
    const { code } = await importDocument(
      cwd,
      {
        log: {
          version: "1.2",
          creator: { name: "test", version: "1" },
          entries: [
            harEntry({
              method: "GET",
              url: "https://api.example.test/v1/clips",
              status: 200,
              responseMime: "text/plain",
              responseText: `echo ${HAR_BODY_SECRET} back`,
              requestHeaders: [
                { name: "X-Clip-Token", value: HAR_BODY_SECRET }
              ],
              queryString: [{ name: "sig", value: HAR_BODY_SECRET }]
            }),
            harEntry({
              method: "POST",
              url: "https://api.example.test/v1/clips",
              status: 400,
              requestMime: "application/json",
              requestText: `{"url": "${HAR_BODY_SECRET}"`,
              responseJson: { id: "clip_1" }
            })
          ]
        }
      },
      { flags: ["--out", out] }
    );
    expect(code).toBe(EXIT_OK);
    for (const file of await readdir(out)) {
      const text = await readFile(path.join(out, file), "utf8");
      expect(text).not.toContain(HAR_BODY_SECRET);
    }
    const event = (await readEvents(out))[0] as {
      request: {
        query: Array<{ name: string; values: string[] }>;
        headers: Array<{ name: string; values: string[] }>;
      };
      response: { body: { text: string } } | null;
    };
    expect(event.request.query.find((item) => item.name === "sig")).toEqual({
      name: "sig",
      values: ["[REDACTED]"]
    });
    expect(event.response?.body.text).toContain("[REDACTED]");
    // The malformed JSON body falls back to text capture, which scrubs
    // the echoed credential the same way.
    const malformed = (await readEvents(out))[1] as {
      request: { body: { kind: string; text?: string } };
    };
    expect(malformed.request.body.kind).toBe("text");
    expect(malformed.request.body.text).toContain("[REDACTED]");
  });

  it("counts a contract api key header as the credential", async () => {
    const cwd = await newWorkspace();
    const out = path.join(cwd, "imported-session");
    const apiKeyValue = "clip-key-canary-5e77a2";
    const { code } = await importDocument(
      cwd,
      {
        log: {
          version: "1.2",
          creator: { name: "test", version: "1" },
          entries: [
            harEntry({
              method: "GET",
              url: "https://api.example.test/v1/clips",
              status: 200,
              responseJson: { items: ["clip_1"] },
              omitCredentialHeaders: true,
              requestHeaders: [{ name: "X-Clip-Key", value: apiKeyValue }]
            })
          ]
        }
      },
      { contract: API_KEY_CONTRACT, flags: ["--out", out] }
    );
    expect(code).toBe(EXIT_OK);
    const event = (await readEvents(out))[0] as {
      request: {
        credential_present: boolean;
        headers: Array<{ name: string; values: string[] }>;
      };
      authentication: { status: string };
    };
    expect(event.request.credential_present).toBe(true);
    expect(event.authentication.status).toBe("authenticated");
    expect(
      event.request.headers.find((item) => item.name === "x-clip-key")
    ).toEqual({ name: "x-clip-key", values: ["[REDACTED]"], redacted: true });
    const trace = await readFile(path.join(out, "trace.jsonl"), "utf8");
    expect(trace).not.toContain(apiKeyValue);
  });
});
