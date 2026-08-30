/**
 * Loopback serving path for the gateway pipeline (specification
 * sections 15.1 and 25). The listener allocates one ingress sequence
 * per request, captures bounded request evidence, and records exactly
 * one trace event for every accepted, rejected, or disconnected
 * request. A client that goes away mid-request produces a bounded
 * disconnect event, never a second event for the same request.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import {
  diagnostic,
  DiagnosticCode,
  unsupported,
  type Diagnostic
} from "@oal/core";
import { CONTRACT_IR_SCHEMA_VERSION } from "@oal/contract-ir";
import { FRAMEWORK_ERRORS, problemDocument } from "./problem.ts";
import {
  handleGatewayRequest,
  type GatewayOptions,
  type GatewayResponse
} from "./server.ts";
import {
  captureBodyEvidence,
  traceHeaders,
  traceQueryParameters,
  type BlobStore,
  type BodyEvidence,
  type TraceHeader,
  type TraceQueryParameter
} from "./trace.ts";

export interface ListenerOptions {
  /** Gateway pipeline options, including optional transactional state. */
  gateway: GatewayOptions;
  /** Blob store for binary and multipart request evidence. */
  blobs?: BlobStore;
}

/** One trace record per served request, in ingress order. */
export interface GatewayTraceEvent {
  type: "api.exchange";
  sequence: number;
  request_id: string;
  /** Served, framework-rejected, or abandoned by the client. */
  outcome: "accepted" | "rejected" | "disconnected";
  request: {
    method: string;
    target: string;
    /** Wire headers; repeated lines stay separate and in order. */
    headers: TraceHeader[];
    query: TraceQueryParameter[];
    body: BodyEvidence;
  };
  response: {
    status: number;
    framework_code: string | null;
  } | null;
  error: {
    layer: "transport";
    code: string;
    message: string;
  } | null;
}

export interface GatewayListener {
  readonly port: number;
  /** Trace records in ingress order. */
  readonly events: readonly GatewayTraceEvent[];
  /** Serve-phase diagnostics, for example client disconnects. */
  readonly diagnostics: readonly Diagnostic[];
  close(): Promise<void>;
}

/** Stable transport error code for an abandoned request. */
const CLIENT_DISCONNECTED = "client_disconnected";

/**
 * Test one header value the way Node does before it writes: only
 * horizontal tab, printable ASCII, and 8-bit bytes are accepted.
 * Anything else, most notably CR and LF, makes the write throw.
 */
function writableHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      code === 0x09 ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x80 && code <= 0xff);
    if (!allowed) {
      return false;
    }
  }
  return true;
}

/** RFC 9110 token characters; every outbound header name must match. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_|~0-9A-Za-z]+$/;

/**
 * Drop the header lines HTTP forbids instead of letting the write
 * throw. Fixture header values reach the wire unvalidated, so this is
 * the deterministic guard. Returns the writable lines and the dropped
 * names in stable declaration order.
 */
function outboundHeaders(headers: Record<string, string>): {
  headers: Record<string, string>;
  dropped: string[];
} {
  const writable: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (HEADER_TOKEN.test(name) && writableHeaderValue(value)) {
      writable[name] = value;
    } else {
      dropped.push(name);
    }
  }
  return { headers: writable, dropped };
}

/**
 * Start one loopback gateway listener on an ephemeral 127.0.0.1 port.
 * The listener is the serving path for trials and conformance tests.
 */
export async function startGatewayListener(
  options: ListenerOptions
): Promise<GatewayListener> {
  // The contract schema version is checked before the socket binds, so
  // an unsupported contract refuses at startup (section 42.2, AC-012).
  // Widen the field before the check: the producer types it narrowly,
  // but a contract read from disk carries no runtime guarantee.
  const version: number = options.gateway.contract.schema_version;
  if (version !== CONTRACT_IR_SCHEMA_VERSION) {
    throw unsupported(
      DiagnosticCode.UnsupportedSchemaVersion,
      `Contract schema version ${String(version)} is not supported; this build serves version ${String(CONTRACT_IR_SCHEMA_VERSION)}.`,
      { contract_schema_version: version }
    );
  }
  let sequence = 0;
  const events: GatewayTraceEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const blobs = options.blobs ?? null;

  const serve = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    sequence += 1;
    const requestId = `req_${sequence.toString(10).padStart(8, "0")}`;
    const method = incoming.method ?? "";
    const target = incoming.url ?? "/";
    const chunks: Buffer[] = [];
    let response: GatewayResponse | null = null;
    let transportError: { code: string; message: string } | null = null;
    let recorded = false;

    incoming.on("error", () => undefined);
    outgoing.on("error", () => undefined);

    const evidence = (): BodyEvidence => {
      return captureBodyEvidence(
        new Uint8Array(Buffer.concat(chunks)),
        headerValue(incoming.headers["content-type"]),
        blobs
      );
    };

    // Exactly one event per request; a disconnect also emits one
    // bounded serve-phase diagnostic.
    const record = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      if (transportError !== null) {
        diagnostics.push(
          diagnostic({
            severity: "warning",
            phase: "serve",
            code: "OAL-CLIENT-DISCONNECTED",
            message: transportError.message,
            details: { request_id: requestId }
          })
        );
      }
      events.push({
        type: "api.exchange",
        sequence,
        request_id: requestId,
        outcome: outcomeOf(response, transportError),
        request: {
          method,
          target,
          headers: traceHeaders(incoming.rawHeaders),
          query: traceQueryParameters(target),
          body: evidence()
        },
        response:
          response === null
            ? null
            : {
                status: response.status,
                framework_code: response.frameworkCode
              },
        error:
          transportError === null
            ? null
            : { layer: "transport", ...transportError }
      });
    };

    // A response stream that closes before it finished writing means
    // the client abandoned the exchange after the request arrived.
    outgoing.on("close", () => {
      if (!outgoing.writableFinished && !recorded) {
        transportError = {
          code: CLIENT_DISCONNECTED,
          message: "The client disconnected before the response completed."
        };
        record();
      }
    });

    // The write is the last place a header line that HTTP forbids can
    // be stopped: Node throws on it, and the throw would escape this
    // listener as an unhandled rejection. The header filter runs inside
    // the same guard because fixture header values arrive untyped, so a
    // value it cannot test takes the handled path too. Invalid lines
    // are dropped deterministically with one stable diagnostic, and any
    // other write failure becomes a settled framework error, so the
    // client still receives one response and the process stays alive.
    const writeResponse = (candidate: GatewayResponse): void => {
      try {
        const writable = outboundHeaders(candidate.headers);
        if (writable.dropped.length > 0) {
          diagnostics.push(
            diagnostic({
              severity: "warning",
              phase: "serve",
              code: "OAL-RESPONSE-HEADER-INVALID",
              message:
                "Response header lines with characters that HTTP forbids were not sent.",
              details: {
                request_id: requestId,
                headers: writable.dropped
              }
            })
          );
        }
        outgoing.writeHead(candidate.status, writable.headers);
        outgoing.end(candidate.body);
      } catch {
        const error = FRAMEWORK_ERRORS.internalError;
        response = {
          status: error.status,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(problemDocument(error, requestId)),
          requestId,
          provenance: null,
          approximation: null,
          frameworkCode: error.code
        };
        diagnostics.push(
          diagnostic({
            severity: "error",
            phase: "serve",
            code: "OAL-RESPONSE-WRITE-FAILED",
            message: "Writing the response failed; an internal error was sent.",
            details: { request_id: requestId }
          })
        );
        try {
          outgoing.writeHead(response.status, response.headers);
          outgoing.end(response.body);
        } catch {
          // Nothing more can be written; settle the socket so the
          // exchange still ends with exactly one trace event.
          outgoing.destroy();
          record();
          return;
        }
      }
      outgoing.on("finish", () => {
        record();
      });
    };

    void (async () => {
      try {
        for await (const chunk of incoming) {
          chunks.push(chunk as Buffer);
        }
      } catch {
        transportError = {
          code: CLIENT_DISCONNECTED,
          message: "The client disconnected before the request completed."
        };
        record();
        return;
      }

      let computed: GatewayResponse;
      try {
        computed = handleGatewayRequest(options.gateway, sequence, {
          method,
          target,
          headers: incoming.headers as Record<
            string,
            string | string[] | undefined
          >,
          body: new Uint8Array(Buffer.concat(chunks))
        });
      } catch {
        // Unexpected pipeline failures still answer as a framework
        // error and still produce exactly one trace event.
        const error = FRAMEWORK_ERRORS.internalError;
        computed = {
          status: error.status,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(problemDocument(error, requestId)),
          requestId,
          provenance: null,
          approximation: null,
          frameworkCode: error.code
        };
      }

      if (outgoing.destroyed) {
        transportError = {
          code: CLIENT_DISCONNECTED,
          message: "The client disconnected before the response completed."
        };
        record();
        return;
      }

      response = computed;
      writeResponse(computed);
    })();
  };

  const server: Server = createServer((incoming, outgoing) => {
    serve(incoming, outgoing);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    get port(): number {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The loopback listener has no port.");
      }
      return address.port;
    },
    get events(): readonly GatewayTraceEvent[] {
      return events;
    },
    get diagnostics(): readonly Diagnostic[] {
      return diagnostics;
    },
    close: (): Promise<void> => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    }
  };
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Classify the recorded outcome: a transport error or the absence of a
 * served response means the client abandoned the exchange; otherwise a
 * framework code means the request was rejected, not accepted.
 */
function outcomeOf(
  response: GatewayResponse | null,
  transportError: { code: string; message: string } | null
): GatewayTraceEvent["outcome"] {
  if (transportError !== null || response === null) {
    return "disconnected";
  }
  return response.frameworkCode === null ? "accepted" : "rejected";
}
