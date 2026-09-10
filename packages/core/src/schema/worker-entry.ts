/**
 * Schema worker entry (review remediation F2). Runs the synchronous
 * {@link SchemaValidator} and raw regular-expression execution off the
 * parent event loop. The parent process owns the deadline and kills
 * this thread when a job exceeds it; no timer inside this file can
 * interrupt a blocked regular expression, so none is attempted.
 *
 * Compiled validators are cached per bundle identity, so a warm worker
 * serves repeat requests without recompiling the contract schemas.
 */

import { parentPort } from "node:worker_threads";

import type { Json } from "../json.ts";
import { SchemaValidator, type SchemaViolation } from "./validator.ts";
import type {
  SchemaWorkerReply,
  SchemaWorkerRequest,
  SchemaWorkerResult
} from "./worker-protocol.ts";

/** One registered bundle: root schema plus its reference table. */
interface Bundle {
  root: Json;
  refs: Record<string, Json> | null;
}

const bundles = new Map<string, Bundle>();
const validators = new Map<string, SchemaValidator>();

function validatorOf(bundleId: string, maxDepth?: number): SchemaValidator {
  const cacheKey =
    maxDepth === undefined ? bundleId : `${bundleId}@${maxDepth}`;
  const cached = validators.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const bundle = bundles.get(bundleId);
  if (bundle === undefined) {
    throw new Error(`Schema bundle ${bundleId} is not registered.`);
  }
  const validator = new SchemaValidator(bundle.root, {
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(bundle.refs === null
      ? {}
      : { resolveRef: (ref: string): Json | undefined => bundle.refs?.[ref] })
  });
  // A bundle registers once per worker, so the cache stays bounded by
  // the number of distinct schemas the parent hands over.
  if (validators.size > 512) {
    validators.clear();
  }
  validators.set(cacheKey, validator);
  return validator;
}

function distinctPlainMatches(text: string, literal: string): string[] {
  const matches: string[] = [];
  let index = text.indexOf(literal);
  while (index !== -1) {
    const matched = text.slice(index, index + literal.length);
    if (!matches.includes(matched)) {
      matches.push(matched);
    }
    index = text.indexOf(literal, index + literal.length);
  }
  return matches;
}

function distinctRegexpMatches(text: string, regexp: RegExp): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(regexp)) {
    const matched = match[0];
    if (matched.length > 0 && !matches.includes(matched)) {
      matches.push(matched);
    }
  }
  return matches;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First printable ASCII character the pattern accepts. */
function firstPrintableMatch(source: string): string | null {
  let probe: RegExp;
  try {
    probe = new RegExp(source);
  } catch {
    return null;
  }
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const ch = String.fromCharCode(code);
    if (probe.test(ch)) {
      return ch;
    }
  }
  return null;
}

/** Compute one job. Registration is handled by the caller. */
function runJob(
  request: Exclude<SchemaWorkerRequest, { kind: "register" }>
): SchemaWorkerResult {
  switch (request.kind) {
    case "validate": {
      const violations: SchemaViolation[] = validatorOf(
        request.bundleId,
        request.maxDepth
      ).errors(request.instance);
      return { type: "violations", violations };
    }
    case "regex-test": {
      let value = false;
      try {
        value = new RegExp(request.pattern).test(request.candidate);
      } catch {
        value = false;
      }
      return { type: "boolean", value };
    }
    case "regex-first-printable":
      return { type: "string", value: firstPrintableMatch(request.pattern) };
    case "scan-text": {
      const literals = request.literals.map((rule) =>
        rule.caseInsensitive
          ? distinctRegexpMatches(
              request.text,
              new RegExp(escapeRegExp(rule.literal), "gi")
            )
          : distinctPlainMatches(request.text, rule.literal)
      );
      const patterns = request.patterns.map((pattern) => {
        try {
          return distinctRegexpMatches(request.text, new RegExp(pattern, "g"));
        } catch {
          return [];
        }
      });
      return { type: "scan", literals, patterns };
    }
  }
}

if (parentPort === null) {
  throw new Error("schema worker entry requires a worker thread parent port");
}

parentPort.on("message", (request: SchemaWorkerRequest) => {
  if (request.kind === "register") {
    bundles.set(request.bundleId, {
      root: request.root,
      refs: request.refs
    });
    parentPort?.postMessage({
      kind: "registered",
      bundleId: request.bundleId
    } satisfies SchemaWorkerReply);
    return;
  }
  try {
    parentPort?.postMessage({
      kind: "result",
      id: request.id,
      result: runJob(request)
    } satisfies SchemaWorkerReply);
  } catch (error) {
    parentPort?.postMessage({
      kind: "failure",
      id: request.id,
      message: error instanceof Error ? error.message : String(error)
    } satisfies SchemaWorkerReply);
  }
});
