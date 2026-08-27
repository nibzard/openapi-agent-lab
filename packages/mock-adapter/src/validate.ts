/**
 * Script validation for the in-process mock agent.
 *
 * Validation is pure and synchronous, so a bad script fails before the run
 * starts and before any network call or file write happens.
 */

import type { MockAgentScript } from "./script.ts";

const CHANNELS = ["stdout", "stderr", "jsonrpc", "adapter"] as const;

const STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "provider_failed"
] as const;

/** Return one diagnostic string per problem found. An empty list is valid. */
export function validateMockScript(script: MockAgentScript): string[] {
  const problems: string[] = [];
  for (let index = 0; index < (script.events?.length ?? 0); index += 1) {
    const event = script.events?.[index];
    if (event === undefined) {
      continue;
    }
    if (!CHANNELS.includes(event.channel)) {
      problems.push(
        `events[${index}].channel must be stdout, stderr, jsonrpc, or adapter: ${JSON.stringify(event.channel)}`
      );
    }
    if (
      event.delayMs !== undefined &&
      (!isCount(event.delayMs) || event.delayMs < 0)
    ) {
      problems.push(
        `events[${index}].delayMs must be zero or greater: ${String(event.delayMs)}`
      );
    }
  }
  for (let index = 0; index < (script.files?.length ?? 0); index += 1) {
    const file = script.files?.[index];
    if (file === undefined) {
      continue;
    }
    if (!isWorkspaceRelative(file.path)) {
      problems.push(
        `files[${index}].path must stay inside the workspace: ${file.path}`
      );
    }
  }
  for (let index = 0; index < (script.requests?.length ?? 0); index += 1) {
    const request = script.requests?.[index];
    if (request === undefined) {
      continue;
    }
    if (!request.path.startsWith("/")) {
      problems.push(
        `requests[${index}].path must start with a slash: ${request.path}`
      );
    }
    if (
      request.delayMs !== undefined &&
      (!isCount(request.delayMs) || request.delayMs < 0)
    ) {
      problems.push(
        `requests[${index}].delayMs must be zero or greater: ${String(request.delayMs)}`
      );
    }
  }
  if (
    script.exitCode !== undefined &&
    (!Number.isInteger(script.exitCode) ||
      script.exitCode < 0 ||
      script.exitCode > 255)
  ) {
    problems.push(
      `exitCode must be an integer between 0 and 255: ${String(script.exitCode)}`
    );
  }
  if (script.status !== undefined && !STATUSES.includes(script.status)) {
    problems.push(
      `status must be a known run status: ${JSON.stringify(script.status)}`
    );
  }
  if (
    script.durationMs !== undefined &&
    (!isCount(script.durationMs) || script.durationMs < 0)
  ) {
    problems.push(
      `durationMs must be zero or greater: ${String(script.durationMs)}`
    );
  }
  return problems;
}

function isCount(value: number): boolean {
  return Number.isFinite(value);
}

/** True when a path is relative and stays under the workspace root. */
export function isWorkspaceRelative(path: string): boolean {
  if (path === "" || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const parts = path.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
      continue;
    }
    depth += 1;
  }
  return true;
}
