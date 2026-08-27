/**
 * Pluggable transcript parsing for the generic adapter.
 *
 * The parser turns one captured stream into normalized events. It keeps no
 * more than the current line in memory, so a long session stays bounded.
 */

import { LineAssembler } from "@oal/agent-adapter";

import type { TranscriptConfig } from "./config.ts";

/** One parsed transcript record. */
export interface TranscriptEvent {
  /** Adapter-declared kind, or null when the line carries no kind. */
  readonly kind: string | null;
  /** Participant-visible text of the event. */
  readonly text: string;
  /** Token usage reported by the event, when present. */
  readonly usage?: Record<string, number>;
}

export interface TranscriptParser {
  /** Consume decoded stream text and return the events it completed. */
  push(text: string): TranscriptEvent[];
  /** Return the event held by a trailing partial line, when present. */
  flush(): TranscriptEvent | null;
}

/** Default bound on parsed events from one stream. */
export const DEFAULT_MAX_TRANSCRIPT_EVENTS = 1000;

interface ParserState {
  events: number;
}

/**
 * Build the parser named by the configuration. Every parser shares the line
 * framing; only the interpretation of one line differs.
 */
export function createTranscriptParser(
  config: TranscriptConfig
): TranscriptParser {
  const assembler = new LineAssembler();
  const state: ParserState = { events: 0 };
  const maxEvents = config.maxEvents ?? DEFAULT_MAX_TRANSCRIPT_EVENTS;

  const accept = (event: TranscriptEvent): TranscriptEvent | null => {
    if (state.events >= maxEvents) {
      return null;
    }
    state.events += 1;
    return event;
  };

  return {
    push(text: string): TranscriptEvent[] {
      const out: TranscriptEvent[] = [];
      for (const line of assembler.push(text)) {
        const parsed = accept(parseLine(line, config.kind));
        if (parsed !== null) {
          out.push(parsed);
        }
      }
      return out;
    },
    flush(): TranscriptEvent | null {
      const rest = assembler.flush();
      if (rest === null || rest === "") {
        return null;
      }
      return accept(parseLine(rest, config.kind));
    }
  };
}

function parseLine(line: string, kind: string): TranscriptEvent {
  if (kind !== "json-events") {
    return { kind: null, text: line };
  }
  if (line.trim() === "") {
    return { kind: null, text: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unparsed", text: line };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparsed", text: line };
  }
  const record = parsed as Record<string, unknown>;
  return {
    kind: readKind(record),
    text: readText(record),
    ...(!hasUsage(record) ? {} : { usage: readUsage(record.usage) })
  };
}

function readKind(record: Record<string, unknown>): string | null {
  for (const key of ["type", "kind", "event"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

function readText(record: Record<string, unknown>): string {
  for (const key of ["text", "message", "content", "delta"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function hasUsage(record: Record<string, unknown>): boolean {
  const usage = record.usage;
  return (
    typeof usage === "object" &&
    usage !== null &&
    !Array.isArray(usage) &&
    Object.keys(usage).length > 0
  );
}

function readUsage(value: unknown): Record<string, number> {
  const source = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      usage[key] = entry;
    }
  }
  return usage;
}
