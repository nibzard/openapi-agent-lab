import { DiagnosticCode, invalidInput } from "@oal/core";
import type { RouteSegment } from "@oal/contract-ir";

/** Method names accepted as compile targets, in canonical order. */
export const PATH_METHODS: readonly string[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
];

const PARAMETER_PATTERN = /^\{([^{}/]+)\}$/;

/**
 * Split a path template into literal and parameter segments. Malformed
 * templates fail compilation.
 */
export function parsePathTemplate(template: string): RouteSegment[] {
  if (!template.startsWith("/")) {
    throw invalidInput(
      DiagnosticCode.OasStructureInvalid,
      `Path template must start with '/': ${template}.`,
      { path_template: template }
    );
  }
  const body = template.slice(1);
  if (body === "") {
    return [];
  }
  const segments: RouteSegment[] = [];
  const seen = new Set<string>();
  for (const raw of body.split("/")) {
    if (raw === "") {
      throw invalidInput(
        DiagnosticCode.OasStructureInvalid,
        `Path template has an empty segment: ${template}.`,
        { path_template: template }
      );
    }
    const match = PARAMETER_PATTERN.exec(raw);
    if (match !== null) {
      const name = match[1] as string;
      if (seen.has(name)) {
        throw invalidInput(
          DiagnosticCode.OasStructureInvalid,
          `Path template repeats the parameter {${name}}: ${template}.`,
          { path_template: template, parameter: name }
        );
      }
      seen.add(name);
      segments.push({ kind: "parameter", value: name });
      continue;
    }
    if (raw.includes("{") || raw.includes("}")) {
      throw invalidInput(
        DiagnosticCode.OasStructureInvalid,
        `Path template has malformed braces: ${template}.`,
        { path_template: template }
      );
    }
    segments.push({ kind: "literal", value: raw });
  }
  return segments;
}

/**
 * True when two templates on the same method can match the same concrete
 * path while neither is a strict literal specialization of the other.
 * Literal beats parameter, so `/a/{x}` and `/a/b` do not conflict; two
 * parameter names in the same position do.
 */
export function templatesConflict(
  a: readonly RouteSegment[],
  b: readonly RouteSegment[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let parameterMismatch = false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] as RouteSegment;
    const right = b[i] as RouteSegment;
    if (left.kind !== right.kind) {
      // Literal wins over parameter at the same depth.
      return false;
    }
    if (left.kind === "literal" && right.kind === "literal") {
      if (left.value !== right.value) {
        return false;
      }
      continue;
    }
    if (left.value !== right.value) {
      parameterMismatch = true;
    }
  }
  return parameterMismatch;
}

/** Render a template back from segments, for diagnostics. */
export function renderTemplate(segments: readonly RouteSegment[]): string {
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments
    .map((segment) =>
      segment.kind === "parameter" ? `{${segment.value}}` : segment.value
    )
    .join("/")}`;
}
