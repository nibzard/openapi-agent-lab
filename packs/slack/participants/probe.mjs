#!/usr/bin/env node
/**
 * Exercise every operation an OpenAPI document declares against a
 * running mock, and record the failures.
 *
 * Usage: node probe.mjs [contractPath]
 *
 * The contract path defaults to ./openapi.json. The base URL comes
 * from the OAL_BASE_URL environment variable. When OAL_AUTH_BEARER
 * is set, the probe sends it as the Authorization header. A run fails
 * an operation when the answer is not a declared 2xx status or when the
 * body is an application/problem+json document. The report lands in
 * ./probe-report.json. Requests are paced below the server's burst
 * quota.
 *
 * Node built-ins only: this file runs inside a trial workspace with
 * no installed packages.
 */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const contractPath = process.argv[2] ?? "./openapi.json";
const baseUrl = (process.env.OAL_BASE_URL ?? "").replace(/\/$/, "");
if (baseUrl === "") {
  console.error("probe: OAL_BASE_URL is not set");
  process.exit(2);
}
// The mock verifies a declared security alternative on every request.
// The runner exports the synthetic bearer it minted for the run.
const bearer = process.env.OAL_AUTH_BEARER ?? "";

const BURST_LIMIT = 80;
const BURST_WINDOW_MS = 1000;
const sendTimes = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stay under the server's per-second burst quota. */
async function waitForBurstSlot() {
  for (;;) {
    const now = performance.now();
    while (sendTimes.length > 0 && now - sendTimes[0] >= BURST_WINDOW_MS) {
      sendTimes.shift();
    }
    if (sendTimes.length < BURST_LIMIT) {
      sendTimes.push(now);
      return;
    }
    await sleep(sendTimes[0] + BURST_WINDOW_MS - now);
  }
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** A documentation placeholder is not a wire value. */
function isPlaceholder(value) {
  return (
    typeof value === "string" &&
    (value.includes("{{") || /^<[A-Za-z_][A-Za-z0-9_]*>$/.test(value))
  );
}

/** Resolve a local $ref inside the document, or return null. */
function resolveRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    return null;
  }
  let node = document;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") {
      return null;
    }
    node = node[key];
  }
  return node === undefined ? null : node;
}

/** Parameters of one operation, path-level first. */
function parametersOf(document, pathItem, operation) {
  const out = [];
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const resolved =
      parameter !== null && typeof parameter === "object" && typeof parameter.$ref === "string"
        ? resolveRef(document, parameter.$ref)
        : parameter;
    if (resolved !== null && typeof resolved === "object") {
      out.push(resolved);
    }
  }
  return out;
}

/** One wire value for a schema: example, default, enum, then by type. */
function scalarFor(schema) {
  if (schema === null || typeof schema !== "object") {
    return "probe_value";
  }
  const example =
    (Array.isArray(schema.examples) ? schema.examples[0] : undefined) ??
    schema.example ??
    schema.default;
  if (example !== undefined && !isPlaceholder(example)) {
    return typeof example === "object" ? JSON.stringify(example) : String(example);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const first = schema.enum[0];
    return typeof first === "object" ? JSON.stringify(first) : String(first);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "number" || type === "integer") {
    return "1";
  }
  if (type === "boolean") {
    return "true";
  }
  // "probe_value" never looks like a boolean or a number, so the
  // urlencoded parser on the server leaves it a string.
  return "probe_value";
}

function schemaOf(document, parameter) {
  if (parameter.content !== undefined) {
    const entries = Object.values(parameter.content);
    const first = entries[0];
    return first !== undefined ? (first.schema ?? {}) : {};
  }
  return parameter.schema ?? {};
}

/** Declared 2xx statuses of an operation, including 2XX ranges. */
function declaredSuccesses(operation) {
  const statuses = [];
  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    const resolved =
      response !== null && typeof response === "object" && typeof response.$ref === "string"
        ? resolveRef(document, response.$ref)
        : response;
    if (resolved === null || typeof resolved !== "object") {
      continue;
    }
    if (/^2\d\d$/.test(code)) {
      statuses.push(Number(code));
    } else if (code === "2XX") {
      statuses.push(200, 201, 202, 204);
    }
  }
  return statuses;
}

/** Serialize a value for the declared media type. */
async function bodyFor(document, requestBody) {
  const content = requestBody?.content ?? {};
  const entry =
    content["application/json"] !== undefined
      ? ["application/json", content["application/json"]]
      : Object.entries(content)[0];
  if (entry === undefined) {
    return null;
  }
  const [mediaType, declared] = entry;
  const schema = declared?.schema ?? {};
  const value = valueForSchema(schema, new Set());
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return { mediaType, bytes: new TextEncoder().encode(JSON.stringify(value)) };
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    const properties =
      schema !== null && typeof schema === "object" && schema.properties !== undefined
        ? schema.properties
        : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name) => typeof name === "string")
        : []
    );
    const pairs = [];
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) {
        continue;
      }
      const raw = scalarFor(properties[name]);
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(raw)}`);
    }
    return {
      mediaType,
      bytes: new TextEncoder().encode(pairs.join("&"))
    };
  }
  if (mediaType.startsWith("multipart/")) {
    const boundary = "oalprobe";
    const properties =
      schema !== null && typeof schema === "object" && schema.properties !== undefined
        ? schema.properties
        : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name) => typeof name === "string")
        : []
    );
    const parts = [];
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) {
        continue;
      }
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${scalarFor(properties[name])}`
      );
    }
    parts.push(`--${boundary}--\r\n`);
    return {
      mediaType: `${mediaType}; boundary=${boundary}`,
      bytes: new TextEncoder().encode(parts.join("\r\n"))
    };
  }
  return { mediaType, bytes: new TextEncoder().encode(String(value)) };
}

/** Build a value for a JSON schema, required properties only. */
function valueForSchema(schema, seen) {
  if (schema === null || typeof schema !== "object") {
    return "probe_value";
  }
  const resolved = typeof schema.$ref === "string" ? resolveRef(document, schema.$ref) : schema;
  if (resolved === null || typeof resolved !== "object") {
    return "probe_value";
  }
  if (seen.has(resolved)) {
    return {};
  }
  seen.add(resolved);
  const type = Array.isArray(resolved.type) ? resolved.type[0] : resolved.type;
  if (type === "object" || resolved.properties !== undefined) {
    const out = {};
    const required = new Set(
      Array.isArray(resolved.required)
        ? resolved.required.filter((name) => typeof name === "string")
        : []
    );
    for (const [name, property] of Object.entries(resolved.properties ?? {})) {
      if (required.size === 0 || required.has(name)) {
        out[name] = valueForSchema(property, seen);
      }
    }
    seen.delete(resolved);
    return out;
  }
  if (type === "array" || resolved.items !== undefined) {
    seen.delete(resolved);
    return [valueForSchema(resolved.items ?? {}, seen)];
  }
  const example =
    (Array.isArray(resolved.examples) ? resolved.examples[0] : undefined) ??
    resolved.example ??
    resolved.default;
  if (example !== undefined && !isPlaceholder(example)) {
    seen.delete(resolved);
    return example;
  }
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    seen.delete(resolved);
    return resolved.enum[0];
  }
  seen.delete(resolved);
  if (type === "number" || type === "integer") {
    return 1;
  }
  if (type === "boolean") {
    return true;
  }
  return "probe_value";
}

const documentText = await readFile(contractPath, "utf8");
const document = JSON.parse(documentText);
const operations = [];
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  if (pathItem === null || typeof pathItem !== "object") {
    continue;
  }
  for (const method of METHODS) {
    const operation = pathItem[method];
    if (operation === null || typeof operation !== "object") {
      continue;
    }
    operations.push({ key: `path:${method.toUpperCase()} ${path}`, path, method, pathItem, operation });
  }
}
operations.sort((a, b) => (a.key < b.key ? -1 : 1));

const failures = [];
const tally = {};
for (const entry of operations) {
  const parameters = parametersOf(document, entry.pathItem, entry.operation);
  let target = entry.path;
  const query = new Map();
  const headers = {};
  for (const parameter of parameters) {
    if (parameter.in === "path") {
      const value = scalarFor(schemaOf(document, parameter));
      target = target.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
    } else if (parameter.in === "query" && parameter.required) {
      query.set(parameter.name, scalarFor(schemaOf(document, parameter)));
    } else if (parameter.in === "header" && parameter.required) {
      headers[parameter.name] = scalarFor(schemaOf(document, parameter));
    }
  }
  if (query.size > 0) {
    const pairs = [...query.entries()].map(
      ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    );
    target += `?${pairs.join("&")}`;
  }
  const body =
    entry.operation.requestBody?.required === true
      ? await bodyFor(document, entry.operation.requestBody)
      : null;
  if (body !== null) {
    headers["content-type"] = body.mediaType;
  }
  if (bearer !== "") {
    headers.authorization = `Bearer ${bearer}`;
  }
  let status = 0;
  let contentType = "";
  let problemCode = null;
  try {
    await waitForBurstSlot();
    const response = await fetch(`${baseUrl}${target}`, {
      method: entry.method.toUpperCase(),
      headers,
      body: body === null ? undefined : body.bytes,
      redirect: "manual"
    });
    status = response.status;
    contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (contentType.includes("application/problem+json")) {
      try {
        problemCode = JSON.parse(text).code ?? null;
      } catch {
        problemCode = null;
      }
    }
  } catch (error) {
    failures.push({
      operation: entry.key,
      status: 0,
      detail: `transport: ${String(error)}`
    });
    continue;
  }
  tally[String(status)] = (tally[String(status)] ?? 0) + 1;
  const declared = declaredSuccesses(entry.operation);
  const passed =
    status >= 200 &&
    status < 300 &&
    declared.includes(status) &&
    !contentType.includes("application/problem+json");
  if (!passed) {
    failures.push({
      operation: entry.key,
      status,
      detail:
        problemCode !== null
          ? `framework ${problemCode}`
          : contentType.includes("application/problem+json")
            ? "problem+json body"
            : "status not a declared 2xx"
    });
  }
}

const report = {
  contract: contractPath,
  base_url: baseUrl,
  operations_total: operations.length,
  failures_found: failures,
  failures_total: failures.length,
  status_tally: Object.fromEntries(
    Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : 1))
  ),
  generated_at: new Date().toISOString()
};
await writeFile("probe-report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `probe: ${operations.length} operations, ${failures.length} failures, report in probe-report.json`
);
