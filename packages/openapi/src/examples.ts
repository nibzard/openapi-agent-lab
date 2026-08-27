import {
  canonicalJson,
  DiagnosticCode,
  isJsonObject,
  type Diagnostic,
  type Json,
  type JsonObject
} from "@oal/core";

import type { CompilerLimits } from "./limits.ts";
import {
  detectHighConfidenceSecret,
  isSensitiveExample,
  SENSITIVE_ANNOTATION
} from "./sensitive.ts";

const encoder = new TextEncoder();

/** UTF-8 byte length of a JSON value in canonical form. */
export function jsonByteLength(value: Json): number {
  return encoder.encode(canonicalJson(value)).byteLength;
}

export interface CapturedExample {
  readonly name: string | null;
  readonly value: Json;
  readonly summary: string | null;
}

export interface ExampleBudget {
  retainedBytes: number;
  exhausted: boolean;
}

/**
 * Extract retained examples from one media-type or parameter object.
 *
 * Sensitive examples are skipped and reported, single examples above the
 * per-example byte limit fail compilation, and the retained-bytes budget
 * stops retention without failing the run.
 */
export function captureExamples(
  node: JsonObject,
  keyName: string | null,
  uri: string,
  pointer: string,
  limits: CompilerLimits,
  budget: ExampleBudget,
  emit: (diagnostic: Diagnostic) => void
): CapturedExample[] {
  const out: CapturedExample[] = [];
  const single = node.example;
  if (single !== undefined) {
    push(out, keyName, single, null, uri, pointer, limits, budget, emit);
  }
  const map = node.examples;
  if (isJsonObject(map)) {
    for (const name of Object.keys(map).sort()) {
      const entry = map[name];
      if (entry === undefined) {
        continue;
      }
      const summary =
        isJsonObject(entry) && typeof entry.summary === "string"
          ? entry.summary
          : null;
      if (isJsonObject(entry) && entry.value !== undefined) {
        push(
          out,
          name,
          entry.value,
          summary,
          uri,
          `${pointer}/examples/${escapeKey(name)}`,
          limits,
          budget,
          emit
        );
        continue;
      }
      if (isJsonObject(entry) && typeof entry.externalValue === "string") {
        emit({
          severity: "info",
          phase: "compile",
          code: DiagnosticCode.CapResponseGenerationUnsupported,
          message: `External example '${name}' is not retained; supply an inline value.`,
          document_uri: uri,
          json_pointer: pointer,
          operation_key: null,
          retryable: false,
          related: [],
          details: { example_name: name }
        });
      }
    }
  }
  return out;
}

function push(
  out: CapturedExample[],
  name: string | null,
  value: Json,
  summary: string | null,
  uri: string,
  pointer: string,
  limits: CompilerLimits,
  budget: ExampleBudget,
  emit: (diagnostic: Diagnostic) => void
): void {
  if (detectHighConfidenceSecret(value)) {
    emit(secretDetected(uri, pointer));
    return;
  }
  if (isMarkedSensitive(value) || isSensitiveExample(name, value)) {
    emit({
      severity: "warning",
      phase: "compile",
      code: DiagnosticCode.ExampleSensitiveSkipped,
      message: "A sensitive example was skipped and redacted.",
      document_uri: uri,
      json_pointer: pointer,
      operation_key: null,
      retryable: false,
      related: [],
      details: { example_name: name }
    });
    return;
  }
  const size = jsonByteLength(value);
  if (size > limits.maxOneExampleBytes) {
    emit({
      severity: "error",
      phase: "compile",
      code: DiagnosticCode.InputTooLarge,
      message: `An example exceeds the per-example byte limit of ${limits.maxOneExampleBytes}.`,
      document_uri: uri,
      json_pointer: pointer,
      operation_key: null,
      retryable: false,
      related: [],
      details: {
        example_name: name,
        bytes: size,
        max_one_example_bytes: limits.maxOneExampleBytes
      }
    });
    return;
  }
  if (budget.exhausted) {
    return;
  }
  if (budget.retainedBytes + size > limits.maxRetainedExamplesBytes) {
    budget.exhausted = true;
    emit({
      severity: "warning",
      phase: "compile",
      code: DiagnosticCode.LimitReached,
      message: `Retained examples exceeded the budget of ${limits.maxRetainedExamplesBytes} bytes; further examples are dropped.`,
      document_uri: uri,
      json_pointer: pointer,
      operation_key: null,
      retryable: false,
      related: [],
      details: { max_retained_examples_bytes: limits.maxRetainedExamplesBytes }
    });
    return;
  }
  budget.retainedBytes += size;
  out.push({ name, value, summary });
}

function isMarkedSensitive(value: Json): boolean {
  return isJsonObject(value) && value[SENSITIVE_ANNOTATION] === true;
}

function secretDetected(uri: string, pointer: string): Diagnostic {
  return {
    severity: "error",
    phase: "ingest",
    code: DiagnosticCode.InputSecretDetected,
    message:
      "A high-confidence credential was found; replace it with a synthetic placeholder.",
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details: {}
  };
}

function escapeKey(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
