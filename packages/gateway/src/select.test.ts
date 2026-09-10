/**
 * Response-selection tests for specification section 15.5 and 15.7: a
 * missing Accept header must serve the documented default preference,
 * never the alphabetical declaration order, while a present Accept
 * still decides the served representation.
 */

import { describe, expect, it } from "vitest";

import type { Json } from "@oal/core";
import type {
  MediaContentIR,
  MediaExampleIR,
  ResponseIR
} from "@oal/contract-ir";
import { pickMediaType, selectResponse } from "./select.ts";
import { createTableSchemaLookup } from "./validate.ts";

function contentEntry(
  mediaType: string,
  examples: MediaExampleIR[]
): MediaContentIR {
  return {
    media_type: mediaType,
    schema_ref: null,
    examples,
    support: "supported",
    support_reason_codes: []
  };
}

function response(init: Partial<ResponseIR>): ResponseIR {
  return {
    selector: init.selector ?? "200",
    selector_kind: init.selector_kind ?? "exact",
    status: init.status ?? 200,
    description: null,
    headers: [],
    content: init.content ?? [
      contentEntry("application/json", [
        { name: null, value: { id: "thing_0001" }, summary: null }
      ])
    ],
    source_pointer: ""
  };
}

const GENERATION = {
  seed: "select_seed_1",
  lookup: () => undefined
};

describe("selectResponse without an Accept header", () => {
  // The compiler emits response content in alphabetical order, so the
  // declared order serves application/octet-stream first.
  const octetAndJson: ResponseIR = response({
    content: [
      contentEntry("application/octet-stream", []),
      contentEntry("application/json", [
        { name: null, value: { id: "thing_0001" }, summary: null }
      ])
    ]
  });

  it("serves the documented application/json preference", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [octetAndJson],
      [],
      GENERATION
    );
    expect(selected?.mediaType).toBe("application/json");
    expect(selected?.body).toEqual({ id: "thing_0001" });
  });

  it("treats an explicit null Accept like a missing header", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [octetAndJson],
      [],
      GENERATION,
      null
    );
    expect(selected?.mediaType).toBe("application/json");
  });

  it("still honors an Accept header that picks the binary type", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [octetAndJson],
      [],
      GENERATION,
      "application/octet-stream"
    );
    expect(selected?.mediaType).toBe("application/octet-stream");
    expect(selected?.body).toBeUndefined();
  });
});

describe("selectResponse with a fixture", () => {
  it("serves the fixture under its declared media type", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [response({})],
      [
        {
          id: "fx_json",
          operation: "path:GET /things",
          status: 200,
          media_type: "application/json",
          headers: {},
          body: { kind: "json_inline", value: { id: "thing_fixture" } }
        }
      ],
      GENERATION,
      "text/plain"
    );
    expect(selected?.provenance).toBe("fixture:fx_json");
    expect(selected?.mediaType).toBe("application/json");
    expect(selected?.body).toEqual({ id: "thing_fixture" });
  });
});

describe("selectResponse skips invalid examples (section 15.5)", () => {
  const schemas: Record<string, Json> = {
    sch_team: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[TE][A-Z0-9]{8,}$" }
      }
    }
  };
  const lookup = createTableSchemaLookup(schemas);

  it("skips an invalid singular example for a valid named example", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [
        response({
          content: [
            {
              media_type: "application/json",
              schema_ref: "sch_team",
              examples: [
                { name: null, value: { id: "T12345" }, summary: null },
                { name: "alpha", value: { id: "TAAAAAAAA" }, summary: null },
                { name: "beta", value: { id: "TBBBBBBBB" }, summary: null }
              ],
              support: "supported",
              support_reason_codes: []
            }
          ]
        })
      ],
      [],
      { seed: "select_seed_1", lookup }
    );
    expect(selected?.provenance).toBe("example:alpha");
    expect(selected?.body).toEqual({ id: "TAAAAAAAA" });
    expect(selected?.approximation).toBe("example_invalid_skipped:1");
  });

  it("demotes an invalid example to schema generation", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [
        response({
          content: [
            {
              media_type: "application/json",
              schema_ref: "sch_team",
              examples: [
                { name: null, value: { id: "T12345" }, summary: null }
              ],
              support: "supported",
              support_reason_codes: []
            }
          ]
        })
      ],
      [],
      { seed: "select_seed_1", lookup }
    );
    expect(selected?.provenance).toBe("schema_generation");
    expect((selected?.body as { id?: string }).id).toBe("TAAAAAAAA");
    expect(selected?.approximation).toBe("example_invalid_skipped:1");
  });

  it("serves the highest-precedence example without a schema", async () => {
    const selected = await selectResponse(
      "path:GET /things",
      [
        response({
          content: [
            contentEntry("application/json", [
              { name: null, value: { id: "T12345" }, summary: null }
            ])
          ]
        })
      ],
      [],
      { seed: "select_seed_1", lookup }
    );
    expect(selected?.provenance).toBe("example:singular");
    expect(selected?.body).toEqual({ id: "T12345" });
    expect(selected?.approximation).toBeNull();
  });
});

describe("pickMediaType", () => {
  it("follows the documented preference order", () => {
    expect(
      pickMediaType(
        response({
          content: [
            contentEntry("text/plain", []),
            contentEntry("application/xml", [])
          ]
        })
      )
    ).toBe("text/plain");
    expect(
      pickMediaType(
        response({
          content: [
            contentEntry("application/octet-stream", []),
            contentEntry("text/plain", [])
          ]
        })
      )
    ).toBe("text/plain");
    expect(
      pickMediaType(
        response({ content: [contentEntry("application/xml", [])] })
      )
    ).toBe("application/xml");
  });

  it("returns null without declared content", () => {
    expect(pickMediaType(response({ content: [] }))).toBeNull();
    expect(pickMediaType(null)).toBeNull();
  });
});
