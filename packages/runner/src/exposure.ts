/**
 * The default exposure treatment: a loopback HTTP gateway over the pure
 * product pipeline of `@oal/gateway` (specification sections 15 and 22.2).
 * The server binds port zero, so the kernel picks the port, and every
 * exchange lands in the trial trace with bounded, redacted captures.
 */

import { createServer, type Server } from "node:http";

import { formatRfc3339, sha256HexBytes, type Json } from "@oal/core";
import {
  Redactor,
  traceHeaders,
  traceQuery,
  type TraceBody,
  type TraceEvent
} from "@oal/evidence";
import { handleGatewayRequest, matchRoute } from "@oal/gateway";

import type { ExposureRequest } from "./setup.ts";
import {
  credentialEnvironmentNames,
  type ExposureHandle,
  type TraceWriter
} from "./setup.ts";

/** Maximum bytes of one body kept verbatim in the trace. */
const MAX_TRACE_JSON_BYTES = 16 * 1024;

/** Default bind host; the runner never leaves loopback. */
export const DEFAULT_EXPOSURE_HOST = "127.0.0.1";

function queryOf(target: string): URLSearchParams {
  const marker = target.indexOf("?");
  return new URLSearchParams(marker === -1 ? "" : target.slice(marker + 1));
}

function pathOf(target: string): string {
  const marker = target.indexOf("?");
  return marker === -1 ? target : target.slice(0, marker);
}

function bodyOf(bytes: Uint8Array): TraceBody {
  if (bytes.byteLength === 0) {
    return { kind: "none" };
  }
  if (bytes.byteLength > MAX_TRACE_JSON_BYTES) {
    return {
      kind: "binary",
      size_bytes: bytes.byteLength,
      sha256: sha256HexBytes(bytes),
      blob_ref: null
    };
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return {
      kind: "json",
      size_bytes: bytes.byteLength,
      value: JSON.parse(text) as Json,
      truncated: false
    };
  } catch {
    return {
      kind: "text",
      size_bytes: bytes.byteLength,
      sha256: sha256HexBytes(bytes),
      text,
      truncated: false
    };
  }
}

/**
 * Bring up the loopback gateway for one trial. The handle serves the
 * contract data plane only: no readiness, control, or documentation
 * endpoint is participant visible.
 */
export async function createLoopbackExposure(
  request: ExposureRequest
): Promise<ExposureHandle> {
  const trace = request.trace;
  const redactor = new Redactor({
    hmacKey: Buffer.from(request.trialSeed, "utf8"),
    config: {
      sensitiveHeaderNames: [...request.sensitiveHeaderNames],
      keyPatterns: [...request.sensitiveKeyPatterns]
    }
  });

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      void handleExchange(request, trace, redactor, chunks, incoming, outgoing);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(request.port, request.host, () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("The loopback gateway reported no port."));
        return;
      }
      resolve(address.port);
    });
  });

  const baseUrl = `http://${request.host}:${port}`;
  const names = credentialEnvironmentNames(request.contract);

  return {
    baseUrl,
    credentialNames: Object.freeze([...names]),
    documentationUrl: null,
    mcpUrl: null,
    serverRecord: {
      schema_version: 1,
      kind: "Server",
      run_id: request.runId,
      mode: "contract",
      base_url: baseUrl,
      host: request.host,
      port,
      transport: "http",
      documentation_base_url: null,
      mcp: null,
      credential_names: [...names]
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  };
}

async function handleExchange(
  request: ExposureRequest,
  trace: TraceWriter,
  redactor: Redactor,
  chunks: readonly Buffer[],
  incoming: {
    method?: string | undefined;
    url?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
  },
  outgoing: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(data?: string): void;
  }
): Promise<void> {
  const startedAt = request.now();
  const method = (incoming.method ?? "GET").toUpperCase();
  const target = incoming.url ?? "/";
  const bytes = Buffer.concat([...chunks]);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers[name] = value ?? [];
  }
  const reserved = trace.reserve();
  const response = handleGatewayRequest(
    {
      contract: request.contract,
      limits: request.limits,
      runSeed: request.trialSeed
    },
    reserved.sequence,
    { method, target, headers, body: bytes }
  );
  const route = matchRoute(request.contract.operations, method, pathOf(target));
  const query = queryOf(target);
  const headerPairs = Object.entries(incoming.headers).flatMap(
    ([name, value]) =>
      value === undefined
        ? []
        : ([[name, Array.isArray(value) ? [...value] : [value]]] as Array<
            [string, string[]]
          >)
  );
  const queryEntries: Array<[string, string[]]> = [...query.entries()].map(
    ([name, value]) => [name, [value]]
  );
  const contentType = incoming.headers["content-type"];

  const event: TraceEvent = {
    schema_version: 1,
    type: "api.exchange",
    event_id: reserved.event_id,
    sequence: reserved.sequence,
    participant_ingress_sequence: reserved.sequence,
    observed_at: formatRfc3339(startedAt),
    logical_time: null,
    batch_id: request.batchId,
    run_id: request.runId,
    eval_id: request.evalId,
    actor: "participant",
    transport: { kind: "http", request_id: null, connection_id: null },
    operation: {
      matched: route.match !== null,
      key: route.match?.operation.key ?? null,
      uid: route.match?.operation.operation_id ?? null,
      operation_id: route.match?.operation.operation_id ?? null,
      method,
      path_template: route.match?.operation.path_template ?? pathOf(target),
      support: route.match === null ? "unsupported" : "supported"
    },
    request: {
      received_at: formatRfc3339(startedAt),
      method,
      path: pathOf(target),
      query_string: query.toString(),
      query: traceQuery(queryEntries, redactor),
      path_parameters: route.match?.pathParameters ?? {},
      headers: traceHeaders(headerPairs, redactor),
      credential_present:
        incoming.headers["authorization"] !== undefined ||
        request.sensitiveHeaderNames.some((name) =>
          Object.keys(incoming.headers).some(
            (header) => header.toLowerCase() === name
          )
        ),
      content_type: typeof contentType === "string" ? contentType : null,
      body: bodyOf(bytes)
    },
    authentication: {
      status:
        response.frameworkCode === "authentication_failed"
          ? "rejected"
          : "authenticated",
      alternative_index: null,
      schemes: [],
      principal_ref: null
    },
    validation: {
      request: {
        status: response.frameworkCode === null ? "valid" : "invalid",
        violations:
          response.frameworkCode === null
            ? []
            : [
                {
                  pointer: "",
                  code: response.frameworkCode,
                  message: "The gateway rejected the request."
                }
              ]
      },
      response: { status: "valid", violations: [] }
    },
    backend: {
      mode: "contract",
      name: null,
      outcome: response.frameworkCode === null ? "handled" : "skipped",
      duration_ms: Math.max(0, request.now() - startedAt),
      response_provenance:
        response.provenance?.startsWith("fixture:") === true
          ? "fixture"
          : "generated",
      effects: [],
      observations: {}
    },
    response: {
      completed_at: formatRfc3339(request.now()),
      status: response.status,
      headers: Object.entries(response.headers).map(([name, value]) => ({
        name: name.toLowerCase(),
        values: [value],
        redacted: false
      })),
      content_type: response.headers["content-type"] ?? null,
      body: bodyOf(Buffer.from(response.body ?? "", "utf8"))
    },
    state: null,
    idempotency: { status: "not_requested", record_ref: null },
    replay: { classification: "full", reason_code: null },
    error:
      response.frameworkCode === null
        ? null
        : {
            layer: "routing",
            code: response.frameworkCode,
            message: "The gateway served a framework error document.",
            retryable: false,
            details: {}
          },
    duration_ms: Math.max(0, request.now() - startedAt),
    resource_usage: {
      request_bytes: bytes.byteLength,
      response_bytes: Buffer.byteLength(response.body ?? "", "utf8")
    },
    extensions: {}
  };
  await trace.complete(event);
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(response.body ?? "");
}
