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

/** One Chrome HAR 1.2 entry. */
function harEntry(input: {
  method: string;
  url: string;
  status: number;
  responseJson?: Json;
  requestJson?: Json;
  startedDateTime?: string;
}): Json {
  return {
    startedDateTime: input.startedDateTime ?? "2026-08-31T09:00:03.573Z",
    time: 42,
    request: {
      method: input.method,
      url: input.url,
      httpVersion: "HTTP/1.1",
      headers: [
        { name: "Authorization", value: HAR_BEARER },
        { name: "Cookie", value: HAR_COOKIE },
        { name: "Accept", value: "application/json" },
        ...(input.requestJson === undefined
          ? []
          : [
              {
                name: "Content-Type",
                value: "application/json"
              }
            ])
      ],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: input.requestJson === undefined ? 0 : 24,
      ...(input.requestJson === undefined
        ? {}
        : {
            postData: {
              mimeType: "application/json",
              text: JSON.stringify(input.requestJson)
            }
          })
    },
    response: {
      status: input.status,
      httpVersion: "HTTP/1.1",
      headers: [
        {
          name: "Content-Type",
          value: "application/json"
        }
      ],
      cookies: [],
      content: {
        size: 32,
        mimeType: "application/json",
        text:
          input.responseJson === undefined
            ? ""
            : JSON.stringify(input.responseJson)
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

async function writeInputs(
  cwd: string
): Promise<{ har: string; contract: string }> {
  const har = path.join(cwd, "session.har");
  const contract = path.join(cwd, "openapi.json");
  await writeFile(har, JSON.stringify(syntheticHar()));
  await writeFile(contract, JSON.stringify(CONTRACT));
  return { har, contract };
}

interface ImportSummary {
  kind: string;
  run_id: string;
  session_dir: string;
  entries: number;
  matched: number;
  diagnostics: Array<{ code: string; message: string }>;
}

async function importHar(
  cwd: string,
  extra: readonly string[] = []
): Promise<{
  io: MemoryIo;
  code: number;
  summary: ImportSummary | undefined;
}> {
  const { har, contract } = await writeInputs(cwd);
  const io = new MemoryIo();
  const code = await main(
    [
      "trace",
      "import",
      har,
      "--contract",
      contract,
      ...extra,
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
});
