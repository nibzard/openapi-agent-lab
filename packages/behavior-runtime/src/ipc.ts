/**
 * Versioned, length-bounded IPC protocol for executable behavior
 * modules (specification section 16.5). Messages are newline-
 * delimited JSON. Binary bodies travel base64-encoded under a wire
 * body shape; every line is bounded before parsing.
 */

import type {
  BehaviorRequest,
  BehaviorResult,
  Body,
  Json,
  MultipartPart
} from "@oal/behavior-api";

export type { Json };

export const IPC_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type WireBody =
  | { kind: "none" }
  | { kind: "json"; value: Json }
  | { kind: "text"; text: string; sizeBytes: number; sha256: string }
  | { kind: "binary"; bytesB64: string; sizeBytes: number; sha256: string }
  | { kind: "multipart"; parts: WireMultipartPart[] };

export interface WireMultipartPart {
  name: string;
  headers: Array<{ name: string; values: string[] }>;
  body: WireBody;
}

/**
 * Serializable handle context. Live deterministic services cannot
 * cross a process boundary, so the child rebuilds them from this
 * snapshot: virtual time, the run seed namespace, and the state.
 */
export interface WireHandleContext {
  runId: string;
  requestId: string;
  state: Json;
  nowMs: number;
  runSeed: string;
  packRoot: string;
}

export type HostMessage =
  | { id: number; kind: "create"; context: unknown }
  | { id: number; kind: "describe" }
  | { id: number; kind: "initialize"; context: unknown }
  | {
      id: number;
      kind: "handle";
      request: unknown;
      context: WireHandleContext;
    }
  | { id: number; kind: "project"; state: unknown; request: unknown }
  | { id: number; kind: "close" };

export type ChildReply =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: {
        kind: "http" | "internal";
        status?: number | undefined;
        code: string;
        message: string;
        body?: WireBody | undefined;
      };
    };

/** Wire form of a behavior request; bodies travel under WireBody. */
export interface WireBehaviorRequest {
  operation: BehaviorRequest["operation"];
  principal: BehaviorRequest["principal"];
  parameters: BehaviorRequest["parameters"];
  body: WireBody;
  selectedRequestMediaType: string | null;
  acceptedResponseMediaTypes: string[];
}

/** Wire form of a behavior result. */
export interface WireBehaviorResult {
  response: {
    status: number;
    headers?: Array<{ name: string; values: string[] }> | undefined;
    mediaType?: string | undefined;
    body?: WireBody | undefined;
  };
  nextState?: BehaviorResult["nextState"] | undefined;
  effects?: string[] | undefined;
  observations?: BehaviorResult["observations"] | undefined;
  semanticEvents?: BehaviorResult["semanticEvents"] | undefined;
}

export function encodeBody(body: Body): WireBody {
  switch (body.kind) {
    case "none":
    case "json":
      return body;
    case "text":
      return {
        kind: "text",
        text: body.text,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256
      };
    case "binary":
      return {
        kind: "binary",
        bytesB64: Buffer.from(body.bytes).toString("base64"),
        sizeBytes: body.sizeBytes,
        sha256: body.sha256
      };
    case "multipart":
      return {
        kind: "multipart",
        parts: body.parts.map(encodePart)
      };
  }
}

function encodePart(part: MultipartPart): WireMultipartPart {
  return {
    name: part.name,
    headers: part.headers,
    body: encodeBody(part.body)
  };
}

export function decodeBody(wire: WireBody): Body {
  switch (wire.kind) {
    case "none":
    case "json":
      return wire;
    case "text":
      return {
        kind: "text",
        text: wire.text,
        sizeBytes: wire.sizeBytes,
        sha256: wire.sha256
      };
    case "binary": {
      const bytes = new Uint8Array(Buffer.from(wire.bytesB64, "base64"));
      return {
        kind: "binary",
        bytes,
        sizeBytes: wire.sizeBytes,
        sha256: wire.sha256
      };
    }
    case "multipart":
      return {
        kind: "multipart",
        parts: wire.parts.map((part) => ({
          name: part.name,
          headers: part.headers,
          body: decodeBody(part.body)
        }))
      };
  }
}

/** Parse one protocol line; null when the line is empty. */
export function parseLine(
  line: string,
  maxBytes: number = DEFAULT_MAX_MESSAGE_BYTES
): unknown {
  if (line.trim().length === 0) {
    return null;
  }
  if (Buffer.byteLength(line, "utf8") > maxBytes) {
    throw new Error("IPC message exceeds the length bound");
  }
  return JSON.parse(line) as unknown;
}
