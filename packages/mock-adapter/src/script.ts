/**
 * Script vocabulary for the in-process mock agent (specification section 21).
 *
 * A script is a fixed list of behaviors. The mock performs them in order, so
 * two runs of the same script produce the same session events, the same
 * workspace files, and the same final output. No model is called.
 *
 * ## Script format
 *
 * - `events`: lines the mock emits on stdout, stderr, jsonrpc, or the
 *   adapter channel, in order.
 * - `files`: files the mock writes inside the participant workspace.
 * - `requests`: HTTP calls against the exposure base URL, in order. A
 *   request can send extra headers, assert one expected status, and
 *   capture response values into named variables.
 * - `finalText` or `finalReport`: the final message of the run. The runner
 *   reads that message as the `adapter_final` report. `finalReport` is a
 *   JSON value the adapter serializes; the two fields are exclusive.
 *
 * ## Variables
 *
 * A request with `capture` copies response values into named variables:
 * body fields by dot path or JSON pointer, and response headers by name.
 * Later requests substitute `{{variable}}` tokens in their path, header
 * values, and body strings. The final report substitutes them in its
 * string values. Load-time validation rejects a token that no earlier
 * request captures, so a broken chain fails before any network call.
 *
 * ```ts
 * const script: MockAgentScript = {
 *   requests: [
 *     {
 *       path: "/v1/clips",
 *       method: "POST",
 *       credentialName: "X_API_KEY",
 *       body: { url: "https://example.test/page" },
 *       expectStatus: 201,
 *       capture: { body: { clipId: "id" }, headers: { etag: "etag" } }
 *     },
 *     {
 *       path: "/v1/clips/{{clipId}}/render",
 *       headers: { accept: "text/markdown", "if-match": "{{etag}}" },
 *       expectStatus: 200
 *     }
 *   ],
 *   finalReport: { clip_id: "{{clipId}}", rendered: true }
 * };
 * ```
 */

import type { AgentCapabilities } from "@oal/agent-adapter";

/** One stream line the mock emits as a session event. */
export interface MockEventSpec {
  /** Channel the line is recorded on. */
  readonly channel: "stdout" | "stderr" | "jsonrpc" | "adapter";
  /** Text of the line. The session redactor runs before the text is stored. */
  readonly text: string;
  /** Machine-readable kind recorded with the line. */
  readonly kind?: string | undefined;
  /** Pause before this line, in milliseconds. */
  readonly delayMs?: number | undefined;
}

/** One file the mock writes inside the participant workspace. */
export interface MockFileSpec {
  /** Path relative to the workspace root. It cannot escape the workspace. */
  readonly path: string;
  readonly content: string;
}

/** Response values one request copies into script variables. */
export interface MockCaptureSpec {
  /**
   * Variables copied out of the JSON response body. Each key names the
   * variable; each value is a dot path (`id`, `items.0.id`) or, when it
   * starts with a slash, a JSON pointer (`/items/0/id`).
   */
  readonly body?: Readonly<Record<string, string>> | undefined;
  /** Variables copied out of response headers. The value is the header name. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** One HTTP request the mock sends to the exposure base URL. */
export interface MockRequestSpec {
  /** Path appended to the exposure base URL. It must start with a slash. */
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  /**
   * Name of the credential in the tool environment. When set, the value is
   * sent as a bearer token. The value is never recorded in any event.
   */
  readonly credentialName?: string | undefined;
  /** JSON body sent with the request. */
  readonly body?: unknown;
  /**
   * Extra headers sent with the request. Values may use `{{variable}}`
   * tokens. A script header overrides the default content type, but the
   * credential authorization is applied last and cannot be overridden.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Values copied out of the response into script variables. Later
   * requests and the final report substitute them as `{{variable}}`.
   */
  readonly capture?: MockCaptureSpec | undefined;
  /** Status the mock expects. Any other status fails the run. */
  readonly expectStatus?: number | undefined;
  /** Pause before this request, in milliseconds. */
  readonly delayMs?: number | undefined;
}

/** The full script of one mock run. */
export interface MockAgentScript {
  readonly events?: readonly MockEventSpec[] | undefined;
  readonly files?: readonly MockFileSpec[] | undefined;
  readonly requests?: readonly MockRequestSpec[] | undefined;
  /** Final message the run reports. Template tokens stay verbatim. */
  readonly finalText?: string | undefined;
  /**
   * Final JSON result the run reports on the final message channel. The
   * adapter serializes the rendered value, so the runner reads it as the
   * `adapter_final` report. String values may use `{{variable}}` tokens.
   * It is exclusive with `finalText`.
   */
  readonly finalReport?: unknown;
  /** Usage totals the run reports. */
  readonly usage?: Readonly<Record<string, number>> | undefined;
  /**
   * Status the run reports. Defaults to `completed`. A script can force
   * `failed`, `timed_out`, `cancelled`, or `provider_failed`.
   */
  readonly status?:
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "provider_failed"
    | undefined;
  /** Exit code the run reports. Defaults to 0. */
  readonly exitCode?: number | undefined;
  /** Simulated work time in milliseconds. Defaults to 0. */
  readonly durationMs?: number | undefined;
}

/** Adapter configuration. */
export interface MockAgentConfig extends MockAgentScript {
  /** Capabilities the probe declares. */
  readonly capabilities?: AgentCapabilities | undefined;
  /** Model name recorded in the `agent.started` event. */
  readonly model?: string | undefined;
  /** Adapter identifier recorded with every session event. */
  readonly id?: string | undefined;
}

/** Capabilities used when the configuration declares none. */
export const DEFAULT_MOCK_CAPABILITIES: AgentCapabilities = {
  nativeSystemPrompt: true,
  nativeOutputSchema: false,
  mcp: false,
  machineReadableTranscript: true,
  usageReporting: true,
  separateToolEnvironment: true,
  enforceableToolNetworkPolicy: true,
  sandboxModes: []
};

/** Version line the probe reports. */
export const MOCK_ADAPTER_VERSION =
  "oal-mock-agent 1.0.0 (in-process, no model)";

/** Default adapter identifier. */
export const DEFAULT_MOCK_ADAPTER_ID = "mock-agent";

/** Reason a script was rejected before the run started. */
export const MOCK_SCRIPT_INVALID = "MOCK_SCRIPT_INVALID";

/** A request returned a status the script did not declare. */
export const MOCK_HTTP_STATUS_MISMATCH = "MOCK_HTTP_STATUS_MISMATCH";

/** A request could not be completed. */
export const MOCK_HTTP_REQUEST_FAILED = "MOCK_HTTP_REQUEST_FAILED";

/** A step referenced a variable no earlier step captured. */
export const MOCK_TEMPLATE_UNRESOLVED = "MOCK_TEMPLATE_UNRESOLVED";

/** A step could not capture a value its script declared. */
export const MOCK_CAPTURE_FAILED = "MOCK_CAPTURE_FAILED";

/** One complete `{{variable}}` token. */
const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/gu;

/** Legal variable name, so one token can never be ambiguous. */
const VARIABLE_NAME = /^[A-Za-z0-9_-]+$/u;

/**
 * Deepest value level the engine visits. The cap keeps a cyclic script
 * value from hanging validation or rendering. JSON serialization rejects
 * such a value later, exactly as it does without templates.
 */
const MAX_TEMPLATE_DEPTH = 64;

/** Names of every `{{variable}}` token in the text, in order of appearance. */
export function templateNamesIn(text: string): readonly string[] {
  return [...text.matchAll(TEMPLATE_TOKEN)].map((match) => match[1] ?? "");
}

/** True when the text holds a `{{` that opens no complete token. */
export function hasMalformedTemplate(text: string): boolean {
  return text.replace(TEMPLATE_TOKEN, "").includes("{{");
}

/** Result of one template render. */
export interface RenderedText {
  readonly text: string;
  /** Variables the text referenced but the variables did not carry. */
  readonly missing: readonly string[];
}

/** Replace every `{{variable}}` token with its captured value. */
export function renderTemplate(
  text: string,
  variables: Readonly<Record<string, string>>
): RenderedText {
  const missing: string[] = [];
  const rendered = text.replace(TEMPLATE_TOKEN, (token, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.push(name);
      return token;
    }
    return value;
  });
  return { text: rendered, missing };
}

/** Result of one deep template render. */
export interface RenderedValue {
  readonly value: unknown;
  /** Variables the strings referenced but the variables did not carry. */
  readonly missing: readonly string[];
}

/**
 * Replace tokens in every string of a JSON-like value. Object key order is
 * kept, so serialization stays deterministic. Tokens inside a rendered
 * value are not rescanned.
 */
export function renderTemplatesDeep(
  value: unknown,
  variables: Readonly<Record<string, string>>
): RenderedValue {
  const missing: string[] = [];
  return { value: renderDeep(value, variables, missing, 0), missing };
}

function renderDeep(
  value: unknown,
  variables: Readonly<Record<string, string>>,
  missing: string[],
  depth: number
): unknown {
  if (depth > MAX_TEMPLATE_DEPTH) {
    return value;
  }
  if (typeof value === "string") {
    const rendered = renderTemplate(value, variables);
    missing.push(...rendered.missing);
    return rendered.text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      renderDeep(entry, variables, missing, depth + 1)
    );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = renderDeep(entry, variables, missing, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Read one value out of a parsed response body. The path is a dot path
 * (`clip.id`, `items.0.id`) or, when it starts with a slash, a JSON pointer
 * (`/clip/id`, `/items/0/id`). Returns undefined when the path is absent.
 */
export function readBodyPath(body: unknown, path: string): unknown {
  // Pointer paths escape `~` and `/`; dot paths take both literally.
  const rawSegments = path.startsWith("/")
    ? path.slice(1).split("/")
    : path.split(".");
  const segments = path.startsWith("/")
    ? rawSegments.map(unescapePointer)
    : rawSegments;
  let current: unknown = body;
  for (const segment of segments) {
    current = stepInto(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function stepInto(container: unknown, segment: string): unknown {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  if (Array.isArray(container)) {
    if (!/^[0-9]+$/.test(segment)) {
      return undefined;
    }
    return container[Number.parseInt(segment, 10)];
  }
  if (!Object.prototype.hasOwnProperty.call(container, segment)) {
    return undefined;
  }
  return (container as Record<string, unknown>)[segment];
}

/** Undo the `~1` and `~0` escapes of a JSON pointer segment. */
function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Static template checks of one script, one diagnostic string per problem.
 * A request can use only the variables earlier requests capture, because
 * its own response has not arrived. The final report can use every
 * captured variable. This check runs beside the base script validation at
 * load time, so a broken chain fails before any network call.
 */
export function validateScriptTemplates(script: MockAgentScript): string[] {
  const problems: string[] = [];
  if (script.finalText !== undefined && script.finalReport !== undefined) {
    problems.push("finalText and finalReport cannot both be set");
  }
  const captured: string[] = [];
  const requests = script.requests ?? [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    if (request === undefined) {
      continue;
    }
    const label = `requests[${index}]`;
    const known = new Set(captured);
    checkTemplateText(`${label}.path`, request.path, known, problems);
    if (request.headers !== undefined) {
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value !== "string") {
          problems.push(`${label}.headers[${name}] must be a string`);
          continue;
        }
        checkTemplateText(`${label}.headers[${name}]`, value, known, problems);
      }
    }
    checkTemplateValue(`${label}.body`, request.body, known, problems, 0);
    registerCaptures(label, request.capture, captured, problems);
  }
  checkTemplateValue(
    "finalReport",
    script.finalReport,
    new Set(captured),
    problems,
    0
  );
  return problems;
}

/** Add capture variables of one request, after that request was checked. */
function registerCaptures(
  label: string,
  capture: MockCaptureSpec | undefined,
  captured: string[],
  problems: string[]
): void {
  if (capture === undefined) {
    return;
  }
  registerCaptureRecord(capture.body, "body", label, captured, problems);
  registerCaptureRecord(capture.headers, "headers", label, captured, problems);
}

function registerCaptureRecord(
  record: Readonly<Record<string, string>> | undefined,
  field: "body" | "headers",
  label: string,
  captured: string[],
  problems: string[]
): void {
  if (record === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(record)) {
    if (!VARIABLE_NAME.test(name)) {
      problems.push(
        `${label}.capture.${field} variable name must match [A-Za-z0-9_-]: ${JSON.stringify(name)}`
      );
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      problems.push(
        `${label}.capture.${field}[${name}] must be a non-empty string`
      );
      continue;
    }
    captured.push(name);
  }
}

/** Run the template checks over one string, labeled for diagnostics. */
function checkTemplateText(
  label: string,
  text: string,
  known: ReadonlySet<string>,
  problems: string[]
): void {
  if (hasMalformedTemplate(text)) {
    problems.push(`${label} contains a "{{" that opens no {{name}} token`);
  }
  for (const name of templateNamesIn(text)) {
    if (!known.has(name)) {
      problems.push(
        `${label} uses {{${name}}} but no earlier request captures it`
      );
    }
  }
}

/** Run the template checks over every string inside a JSON-like value. */
function checkTemplateValue(
  label: string,
  value: unknown,
  known: ReadonlySet<string>,
  problems: string[],
  depth: number
): void {
  if (depth > MAX_TEMPLATE_DEPTH) {
    return;
  }
  if (typeof value === "string") {
    checkTemplateText(label, value, known, problems);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      checkTemplateValue(
        `${label}[${index}]`,
        entry,
        known,
        problems,
        depth + 1
      );
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      checkTemplateValue(`${label}.${key}`, entry, known, problems, depth + 1);
    }
  }
}
