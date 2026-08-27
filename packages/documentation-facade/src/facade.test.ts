import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlSink, EventStream } from "@oal/evidence";
import { DocumentationFacade, DEFAULT_ROUTES } from "./facade.ts";

const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Steel"}}';

describe("DocumentationFacade", () => {
  it("serves the frozen document bytes on the declared route", async () => {
    const facade = new DocumentationFacade({ document: DOCUMENT });
    const response = await facade.handle({
      method: "GET",
      path: "/openapi.json",
      authenticated: false,
      observedAt: "2026-08-27T12:00:00.000Z"
    });
    expect(response).toEqual({
      status: 200,
      contentType: "application/json",
      body: DOCUMENT,
      contentLength: DOCUMENT.length
    });
  });

  it("answers HEAD without body bytes but keeps the length", async () => {
    const facade = new DocumentationFacade({ document: DOCUMENT });
    const response = await facade.handle({
      method: "HEAD",
      path: "/openapi.json",
      authenticated: false,
      observedAt: "2026-08-27T12:00:00.000Z"
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
    expect(response.contentLength).toBe(DOCUMENT.length);
  });

  it("refuses control-plane paths and unknown routes", async () => {
    const facade = new DocumentationFacade({ document: DOCUMENT });
    for (const path of ["/oal", "/oal/reset", "/health"]) {
      const response = await facade.handle({
        method: "GET",
        path,
        authenticated: false,
        observedAt: "2026-08-27T12:00:00.000Z"
      });
      expect(response.status).toBe(404);
      expect(response.body).not.toContain("openapi");
    }
  });

  it("rejects undeclared methods with 405", async () => {
    const facade = new DocumentationFacade({ document: DOCUMENT });
    const response = await facade.handle({
      method: "POST",
      path: "/openapi.json",
      authenticated: false,
      observedAt: "2026-08-27T12:00:00.000Z"
    });
    expect(response.status).toBe(405);
  });

  it("exposes one stable document digest", () => {
    const facade = new DocumentationFacade({ document: DOCUMENT });
    expect(facade.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(facade.digest).toBe(
      new DocumentationFacade({ document: DOCUMENT }).digest
    );
  });

  it("records documentation exchanges in stream order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oal-docfacade-"));
    try {
      const sink = await JsonlSink.open(join(dir, "documentation.jsonl"));
      const stream = EventStream.open(sink, "doc");
      const facade = new DocumentationFacade({
        document: DOCUMENT,
        stream,
        runId: "run-01",
        batchId: "batch-01"
      });
      await facade.handle({
        method: "GET",
        path: "/openapi.json",
        authenticated: true,
        observedAt: "2026-08-27T12:00:00.000Z"
      });
      await facade.handle({
        method: "GET",
        path: "/unknown",
        authenticated: false,
        observedAt: "2026-08-27T12:00:01.000Z"
      });
      const lines = (await readFile(join(dir, "documentation.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(first.event_id).toBe("doc_00000001");
      expect(first.outcome).toBe("served");
      expect(first.candidate).toEqual({
        profile: "openapi-document",
        route_id: "docs.openapi"
      });
      const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
      expect(second.outcome).toBe("refused:404");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("declares the conventional route set", () => {
    expect(DEFAULT_ROUTES).toHaveLength(1);
    expect(DEFAULT_ROUTES[0]?.path).toBe("/openapi.json");
  });
});
