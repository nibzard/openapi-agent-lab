/**
 * Documentation and semantic event streams (specification sections
 * 25.6 and 25.7). Documentation exchanges get their own monotonic
 * stream; semantic events carry committed domain facts with state
 * revision linkage.
 */

import { sequenceId, type Json, type JsonObject } from "@oal/core";
import { EventStream, type JsonlSink } from "./trace.ts";

export interface DocumentationExchange {
  schema_version: 1;
  type: "documentation.exchange";
  event_id: string;
  sequence: number;
  participant_ingress_sequence: number | null;
  observed_at: string;
  batch_id: string | null;
  run_id: string | null;
  actor: "participant" | "control";
  request: {
    method: string;
    path: string;
  };
  candidate: {
    profile: string;
    route_id: string;
  };
  authentication: {
    status: string;
  };
  visibility: string;
  outcome: string;
  response: {
    status: number;
    content_type: string | null;
    bytes: number;
    body_sha256: string | null;
  };
  duration_ms: number;
  extensions: JsonObject;
}

/** Stream for documentation.jsonl records; ids use the doc_ prefix. */
export function documentationStream(sink: JsonlSink): EventStream {
  return EventStream.open(sink, "doc");
}

export interface SemanticEvent {
  schema_version: 1;
  type: "semantic.event";
  event_id: string;
  semantic_sequence: number;
  run_id: string;
  pack_id: string;
  name: string;
  event_version: number;
  logical_time: string;
  caused_by_api_event_id: string | null;
  actor: "participant" | "control";
  state_revision_before: number;
  state_revision_after: number;
  payload_schema: string;
  payload: Json;
}

/**
 * Stream for semantic-events.redacted.jsonl. The semantic sequence is
 * its own monotonic counter, separate from api.exchange.
 */
export class SemanticEventStream {
  private next = 1;

  private readonly sink: JsonlSink;

  private constructor(sink: JsonlSink) {
    this.sink = sink;
  }

  static open(sink: JsonlSink): SemanticEventStream {
    return new SemanticEventStream(sink);
  }

  /** Append one committed semantic event in commit order. */
  async append(
    event: Omit<
      SemanticEvent,
      "schema_version" | "type" | "event_id" | "semantic_sequence"
    >
  ): Promise<SemanticEvent> {
    const record: SemanticEvent = {
      schema_version: 1,
      type: "semantic.event",
      event_id: sequenceId("sem", this.next),
      semantic_sequence: this.next,
      ...event
    };
    this.next += 1;
    await this.sink.appendJson(record as unknown as Json);
    return record;
  }
}
