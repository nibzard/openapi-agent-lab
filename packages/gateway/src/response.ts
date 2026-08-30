/**
 * Response validation (specification section 15.4). The produced
 * response is checked against the declared contract response before
 * any state commit. The checks are bounded: the status must match a
 * declared selector, required response headers must be present, the
 * selected media type must be declared, and a served body must satisfy
 * the declared schema with response-side writeOnly handling, whatever
 * produced the value. An invalid result fails closed as 500
 * mock_response_invalid.
 */

import type { Json } from "@oal/core";
import type { ResponseIR } from "@oal/contract-ir";
import { responseBodyViolations } from "./response-body.ts";
import { findResponseForStatus, type SelectedResponse } from "./select.ts";

export interface ResponseViolation {
  location: "status" | "header" | "media_type" | "body";
  pointer: string;
  code: string;
  message: string;
}

export interface ResponseValidationResult {
  violations: ResponseViolation[];
}

/**
 * Validate one selected response against the operation declarations.
 * The selected response carries the declaration its value came from,
 * so header, media type, and body checks use that declaration.
 */
export function validateResponse(
  responses: readonly ResponseIR[],
  selected: SelectedResponse,
  schemaLookup: (ref: string) => Json | undefined
): ResponseValidationResult {
  const violations: ResponseViolation[] = [];

  // Status: an exact, range, or default declaration must match.
  if (findResponseForStatus(responses, selected.status) === null) {
    violations.push({
      location: "status",
      pointer: "",
      code: "status_undeclared",
      message: `Status ${selected.status} matches no declared response.`
    });
  }

  const declared = selected.response;
  if (declared === null) {
    return { violations };
  }

  for (const header of declared.headers) {
    if (!header.required) {
      continue;
    }
    const present = Object.keys(selected.headers).some(
      (name) => name.toLowerCase() === header.name.toLowerCase()
    );
    if (!present) {
      violations.push({
        location: "header",
        pointer: header.name,
        code: "required",
        message: `Required response header ${header.name} is missing.`
      });
    }
  }

  const declaredMedia = declared.content.map((entry) => entry.media_type);
  if (declaredMedia.length === 0) {
    if (selected.body !== undefined) {
      violations.push({
        location: "media_type",
        pointer: "",
        code: "media_type_undeclared",
        message: "The response declares no content for a present body."
      });
    }
  } else if (selected.mediaType === null) {
    violations.push({
      location: "media_type",
      pointer: "",
      code: "media_type_missing",
      message: "No response media type was selected."
    });
  } else if (!declaredMedia.includes(selected.mediaType)) {
    violations.push({
      location: "media_type",
      pointer: "",
      code: "media_type_undeclared",
      message: `Media type ${selected.mediaType} is not declared.`
    });
  }

  const media = selected.mediaType;
  // A fixture body is frozen pack data, but no pack check validates it
  // against the operation response schema, and section 15.4 checks every
  // served body. A fixture body therefore passes the same schema check
  // as a generated one; an invalid fixture fails closed instead of
  // serving contract-violating bytes. Fixture violations name the
  // fixture so a pack author can find the offending entry.
  if (media !== null && selected.body !== undefined) {
    const content = declared.content.find(
      (entry) => entry.media_type.toLowerCase() === media.toLowerCase()
    );
    if (content !== undefined) {
      const fixtureId = selected.provenance.startsWith("fixture:")
        ? selected.provenance.slice("fixture:".length)
        : null;
      for (const violation of responseBodyViolations(
        content,
        selected.body,
        schemaLookup
      )) {
        violations.push({
          location: "body",
          pointer: violation.pointer,
          code: violation.code,
          message:
            fixtureId === null
              ? violation.message
              : `Fixture ${fixtureId} body: ${violation.message}`
        });
      }
    }
  }
  return { violations };
}
