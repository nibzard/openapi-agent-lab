/**
 * Message protocol of the schema worker (review remediation F2).
 * Every message is plain JSON data, so structured clone can carry it
 * across the worker boundary in both directions. The parent owns the
 * deadline and the termination decision; the worker only computes.
 */

import type { Json } from "../json.ts";
import type { SchemaViolation } from "./validator.ts";

/** One job the parent sends to a worker. */
export type SchemaWorkerRequest =
  | {
      kind: "register";
      /** Bundle identity the worker caches compiled validators under. */
      bundleId: string;
      root: Json;
      /** Reference table; a null value disables reference resolution. */
      refs: Record<string, Json> | null;
    }
  | {
      kind: "validate";
      id: number;
      bundleId: string;
      instance: Json;
      maxDepth?: number;
    }
  | { kind: "regex-test"; id: number; pattern: string; candidate: string }
  | { kind: "regex-first-printable"; id: number; pattern: string }
  | {
      kind: "scan-text";
      id: number;
      literals: readonly { literal: string; caseInsensitive: boolean }[];
      patterns: readonly string[];
      text: string;
    };

/** One reply from a worker. */
export type SchemaWorkerReply =
  | { kind: "registered"; bundleId: string }
  | { kind: "result"; id: number; result: SchemaWorkerResult }
  | { kind: "failure"; id: number; message: string };

/** Result payload of one completed job. */
export type SchemaWorkerResult =
  | { type: "violations"; violations: SchemaViolation[] }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string | null }
  | { type: "scan"; literals: string[][]; patterns: string[][] };
