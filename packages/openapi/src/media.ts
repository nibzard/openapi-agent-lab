/**
 * Source format detection and media-type capability classification from
 * specification sections 13.1 and 13.11.
 */

export type SourceFormat = "json" | "yaml";

export const SOURCE_MEDIA_TYPES: Record<SourceFormat, string> = {
  json: "application/json",
  yaml: "application/yaml"
};

/**
 * Detect JSON or YAML from content. A document whose first non-space
 * character opens a JSON collection is JSON; everything else is YAML.
 */
export function detectSourceFormat(text: string): SourceFormat {
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      continue;
    }
    return ch === "{" || ch === "[" ? "json" : "yaml";
  }
  return "yaml";
}

export type MediaFamily =
  | "json"
  | "text"
  | "binary"
  | "form"
  | "multipart"
  | "xml"
  | "sse"
  | "other";

/** Classify a media type into its capability family. */
export function mediaFamily(mediaType: string): MediaFamily {
  const normalized = mediaType.trim().toLowerCase();
  const base = normalized.split(";")[0]?.trim() ?? "";
  if (base === "application/json" || base.endsWith("+json")) {
    return "json";
  }
  if (
    base === "application/xml" ||
    base === "text/xml" ||
    base.endsWith("+xml")
  ) {
    return "xml";
  }
  if (base === "text/event-stream") {
    return "sse";
  }
  if (base.startsWith("text/")) {
    return "text";
  }
  if (base === "application/octet-stream") {
    return "binary";
  }
  if (base === "application/x-www-form-urlencoded") {
    return "form";
  }
  if (base === "multipart/form-data" || base === "multipart/mixed") {
    return "multipart";
  }
  return "other";
}

/**
 * Contract-layer support for one media type. XML is approximated; unknown
 * media types are unsupported; everything else in the matrix is supported.
 */
export function mediaSupport(mediaType: string): {
  level: "supported" | "approximated" | "unsupported";
  reasonCode: string;
} {
  const family = mediaFamily(mediaType);
  const reasonCode = `media:${mediaType.trim().toLowerCase()}`;
  switch (family) {
    case "xml":
      return { level: "approximated", reasonCode: "media:application/xml" };
    case "other":
      return { level: "unsupported", reasonCode };
    case "json":
    case "text":
    case "binary":
    case "form":
    case "multipart":
    case "sse":
      return { level: "supported", reasonCode: "media:supported" };
    default:
      return { level: "unsupported", reasonCode };
  }
}

/** Reason code used when a parameter uses JSON content instead of a style. */
export const PARAMETER_CONTENT_REASON = "parameter:content";
