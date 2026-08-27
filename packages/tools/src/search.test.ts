import { describe, expect, it } from "vitest";

import { OalError } from "@oal/core";
import type { ContractIR, OperationIR } from "@oal/contract-ir";

import { computerContract } from "./contract.fixture.ts";
import {
  compareCodePoints,
  OperationSearchIndex,
  queryTokens,
  SEARCH_FIELD_WEIGHTS,
  SEARCH_LIMITS,
  SEARCH_SCORE_FACTORS,
  searchAlgorithm,
  searchOperations,
  STOP_WORD_LIST_FILE,
  stopWords,
  tokenize
} from "./search.ts";

const CONTRACT = computerContract();

/**
 * Expected scores for the fixture contract, computed by hand from the
 * version 1 algorithm: exact token 100 x weight, token prefix 25 x weight,
 * exact query phrase 200 x weight.
 *
 * createComputer (POST /v1/computers), query "create a computer":
 * operationId 2000, path literal prefix 200, summary 2400, tag prefix 125,
 * description 200. Stop word "a" is dropped from the query tokens but stays
 * in the phrase.
 */
const CREATE_SCORE = 4925;

describe("tokenizer", () => {
  it("splits camelCase, snake_case, kebab-case, and punctuation", () => {
    expect(tokenize("createComputer")).toEqual(["create", "computer"]);
    expect(tokenize("list_computers")).toEqual(["list", "computers"]);
    expect(tokenize("health-check")).toEqual(["health", "check"]);
    expect(tokenize("path:POST /v1/computers")).toEqual([
      "path",
      "post",
      "v1",
      "computers"
    ]);
  });

  it("splits acronym run boundaries", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server"]);
    expect(tokenize("parseXMLContent")).toEqual(["parse", "xml", "content"]);
  });

  it("keeps digits attached to their word", () => {
    expect(tokenize("/v1/computers/{computer_id}")).toEqual([
      "v1",
      "computers",
      "computer",
      "id"
    ]);
    expect(tokenize("sha256")).toEqual(["sha256"]);
  });

  it("normalizes to NFKC and lowercase without locale collation", () => {
    expect(tokenize("Ｃｏｍｐｕｔｅｒ")).toEqual(["computer"]);
    expect(tokenize("Café")).toEqual(["café"]);
    expect(tokenize("")).toEqual([]);
  });

  it("drops stop words, duplicates, and tokens past the query cap", () => {
    expect(queryTokens("create a computer")).toEqual(["create", "computer"]);
    expect(queryTokens("the the computers")).toEqual(["computers"]);
    expect(queryTokens("computer computer computer")).toEqual(["computer"]);
    const long = Array.from({ length: 40 }, (_, index) => `token${index}`).join(
      " "
    );
    expect(queryTokens(long)).toHaveLength(SEARCH_LIMITS.queryTokens);
    expect(queryTokens(long)[31]).toBe("token31");
  });

  it("compares strings by code point, not by UTF-16 unit", () => {
    expect(compareCodePoints("a", "b")).toBe(-1);
    expect(compareCodePoints("same", "same")).toBe(0);
    const emoji = "😀";
    expect(emoji.charCodeAt(0)).toBe(0xd83d);
    expect(compareCodePoints(emoji, "�")).toBe(1);
    expect(compareCodePoints("path:GET /a.b", "path:GET /a_b")).toBe(-1);
  });
});

describe("stop-word list", () => {
  it("is checked in, versioned, lowercase, unique, and sorted", () => {
    const words = stopWords();
    expect(words.size).toBe(129);
    expect(words.has("the")).toBe(true);
    expect(words.has("a")).toBe(true);
    expect(words.has("create")).toBe(false);
    expect(words.has("list")).toBe(false);
    expect([...words].join(",")).toBe(
      [...words].sort(compareCodePoints).join(",")
    );
    expect(STOP_WORD_LIST_FILE).toBe("stop-words.v1.txt");
  });
});

describe("searchAlgorithm", () => {
  it("freezes and records every ranking decision", () => {
    const algorithm = searchAlgorithm();
    expect(algorithm.version).toBe(1);
    expect(algorithm.tokenizer.version).toBe(1);
    expect(algorithm.tokenizer.normalization).toEqual(["nfkc", "lowercase"]);
    expect(algorithm.stemming).toBe("none");
    expect(algorithm.collation).toBe("unicode-code-point");
    expect(algorithm.stopWordList.version).toBe("v1");
    expect(algorithm.stopWordList.size).toBe(129);
    expect(algorithm.stopWordList.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(algorithm.fieldWeights).toEqual(SEARCH_FIELD_WEIGHTS);
    expect(algorithm.fieldWeights).toEqual({
      operationId: 10,
      method: 8,
      pathLiteral: 8,
      summary: 6,
      tag: 5,
      parameterName: 4,
      propertyName: 3,
      description: 1
    });
    expect(algorithm.scoreFactors).toEqual(SEARCH_SCORE_FACTORS);
    expect(algorithm.limits).toEqual(SEARCH_LIMITS);
    expect(algorithm.ordering).toBe(
      "score-descending-then-canonical-key-ascending"
    );
    expect(Object.isFrozen(algorithm)).toBe(true);
    expect(searchAlgorithm()).toEqual(algorithm);
  });
});

describe("OperationSearchIndex", () => {
  it("indexes every operation of the contract", () => {
    const index = OperationSearchIndex.build(CONTRACT);
    expect(index.size).toBe(6);
    expect(index.algorithm.version).toBe(1);
  });

  it("ranks an exact phrase above prefix matches", () => {
    const result = searchOperations(CONTRACT, {
      query: "create a computer",
      limit: 5
    });
    expect(result.results.map((entry) => entry.score)).toEqual([
      CREATE_SCORE,
      2325,
      2325,
      2200,
      750
    ]);
    expect(result.results[0]?.key).toBe("path:POST /v1/computers");
    expect(result.results[0]?.operationId).toBe("createComputer");
    expect(result.results[0]?.method).toBe("POST");
    expect(result.results[0]?.pathTemplate).toBe("/v1/computers");
    expect(result.results[0]?.summary).toBe("Create a computer");
    expect(result.results[0]?.tags).toEqual(["Computers"]);
    expect(result.results[0]?.support).toBe("supported");
    expect(result.matchedCount).toBe(5);
    expect(result.limited).toBe(false);
  });

  it("breaks score ties by canonical key in code-point order", () => {
    const result = searchOperations(CONTRACT, { query: "computer" });
    expect(result.results.map((entry) => [entry.key, entry.score])).toEqual([
      ["path:DELETE /v1/computers/{computer_id}", 6325],
      ["path:PUT /v1/computers/{computer_id}", 6325],
      ["path:GET /v1/computers/{computer_id}", 6200],
      ["path:POST /v1/computers", 5425],
      ["path:GET /v1/computers", 750]
    ]);
  });

  it("matches method, tag, parameter, and property fields", () => {
    const byMethod = searchOperations(CONTRACT, { query: "post" });
    expect(byMethod.results.map((entry) => entry.key)).toEqual([
      "path:POST /v1/computers"
    ]);
    expect(byMethod.results[0]?.score).toBe(
      SEARCH_SCORE_FACTORS.exactToken * SEARCH_FIELD_WEIGHTS.method +
        SEARCH_SCORE_FACTORS.exactPhrase * SEARCH_FIELD_WEIGHTS.method
    );

    const byTag = searchOperations(CONTRACT, { query: "computers" });
    expect(byTag.results.map((entry) => entry.key)).toContain(
      "path:GET /v1/computers"
    );

    const byParameter = searchOperations(CONTRACT, { query: "rack" });
    expect(byParameter.results).toHaveLength(1);
    expect(byParameter.results[0]?.key).toBe("path:POST /v1/computers");
    expect(byParameter.results[0]?.score).toBe(
      SEARCH_SCORE_FACTORS.exactToken * SEARCH_FIELD_WEIGHTS.propertyName +
        SEARCH_SCORE_FACTORS.exactPhrase * SEARCH_FIELD_WEIGHTS.propertyName
    );

    const byProperty = searchOperations(CONTRACT, { query: "total" });
    expect(byProperty.results).toHaveLength(1);
    expect(byProperty.results[0]?.key).toBe("path:GET /v1/computers");
    expect(byProperty.results[0]?.score).toBe(900);
  });

  it("resolves references while collecting property names", () => {
    const byNestedProperty = searchOperations(CONTRACT, { query: "status" });
    expect(byNestedProperty.results).toHaveLength(5);
    expect(byNestedProperty.results.map((entry) => entry.key)).toEqual([
      "path:GET /health",
      "path:GET /v1/computers",
      "path:GET /v1/computers/{computer_id}",
      "path:POST /v1/computers",
      "path:PUT /v1/computers/{computer_id}"
    ]);
    expect(
      new Set(byNestedProperty.results.map((entry) => entry.score))
    ).toEqual(new Set([900]));
  });

  it("applies filters before the limit", () => {
    const filtered = searchOperations(CONTRACT, {
      query: "computer",
      limit: 2
    });
    expect(filtered.results).toHaveLength(2);
    expect(filtered.matchedCount).toBe(5);
    expect(filtered.limited).toBe(true);

    const postOnly = searchOperations(CONTRACT, {
      query: "computer",
      methods: ["POST"]
    });
    expect(postOnly.results.map((entry) => entry.key)).toEqual([
      "path:POST /v1/computers"
    ]);

    const tagged = searchOperations(CONTRACT, {
      query: "computer",
      tags: ["Computers"]
    });
    expect(tagged.results.map((entry) => entry.key)).toEqual([
      "path:DELETE /v1/computers/{computer_id}",
      "path:PUT /v1/computers/{computer_id}",
      "path:POST /v1/computers",
      "path:GET /v1/computers"
    ]);

    const supported = searchOperations(CONTRACT, {
      query: "health",
      support: ["supported"]
    });
    expect(supported.results).toEqual([]);
    expect(supported.matchedCount).toBe(0);
    expect(supported.limited).toBe(false);

    const unfiltered = searchOperations(CONTRACT, { query: "health" });
    expect(unfiltered.results.map((entry) => entry.key)).toEqual([
      "path:GET /health"
    ]);
    expect(unfiltered.results[0]?.score).toBe(7200);
    expect(unfiltered.results[0]?.support).toBe("unsupported");
  });

  it("returns no operation when nothing scores", () => {
    const none = searchOperations(CONTRACT, { query: "kubernetes" });
    expect(none.results).toEqual([]);
    expect(none.matchedCount).toBe(0);
    const empty = searchOperations(CONTRACT, { query: "" });
    expect(empty.results).toEqual([]);
  });

  it("rejects a limit outside the declared range", () => {
    const attempt = (): unknown =>
      searchOperations(CONTRACT, { query: "computer", limit: 0 });
    expect(attempt).toThrowError(/from 1 to 100/);
    try {
      attempt();
    } catch (error) {
      if (!(error instanceof OalError)) {
        throw new Error("Expected an OalError.");
      }
      expect(error.code).toBe("OAL-SEARCH-LIMIT-INVALID");
    }
    expect(() =>
      searchOperations(CONTRACT, { query: "computer", limit: 101 })
    ).toThrowError(/from 1 to 100/);
  });

  it("caps one indexed field at the declared token count", () => {
    const contract = contractWithLongSummary();
    const within = searchOperations(contract, { query: "w4095" });
    expect(within.results).toHaveLength(1);
    expect(within.results[0]?.score).toBe(
      SEARCH_SCORE_FACTORS.exactToken * SEARCH_FIELD_WEIGHTS.summary +
        SEARCH_SCORE_FACTORS.exactPhrase * SEARCH_FIELD_WEIGHTS.summary
    );
    const beyond = searchOperations(contract, { query: "w4096" });
    expect(beyond.results).toEqual([]);
  });
});

/** A contract whose only operation has a summary longer than the cap. */
function contractWithLongSummary(): ContractIR {
  const base = computerContract();
  const words = Array.from({ length: 5000 }, (_, index) => `w${index}`);
  const operation: OperationIR = {
    ...(base.operations[0] as OperationIR),
    key: "path:GET /long",
    uid: "op_long00000000",
    method: "GET",
    path_template: "/long",
    route_segments: [{ kind: "literal", value: "long" }],
    operation_id: null,
    tool_name: "",
    summary: words.join(" "),
    description: null,
    tags: [],
    parameters: [],
    request_body: null,
    responses: [],
    security: null
  };
  return { ...base, operations: [operation] };
}
