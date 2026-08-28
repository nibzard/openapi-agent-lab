import {
  parseBlockYaml,
  type BlockYamlDialect,
  type BlockYamlFailure,
  type Json
} from "@oal/core";

/**
 * Safe YAML subset parser for pack manifests.
 *
 * Supported: block mappings and block sequences (including a compact mapping
 * that starts on a sequence dash line), single-line flow collections, plain,
 * single-quoted and double-quoted scalars, literal `|` and folded `>`
 * block scalars with indentation and chomping indicators, comments, one
 * document with an optional leading `---`, and duplicate-key rejection.
 *
 * Not supported and rejected closed: anchors, aliases, tags, multiple
 * documents, multi-line flow collections, and compact nested sequences.
 *
 * Every expansion is bounded by node count, nesting depth, and input size.
 * No dynamic evaluation of any kind happens here. The parsing engine is the
 * shared line-based engine of `@oal/core`; the dialect below reproduces the
 * historical pack behavior exactly.
 */

export type PackYamlErrorCode =
  | "invalid"
  | "duplicate-key"
  | "node-limit"
  | "depth-limit"
  | "size-limit";

export class PackYamlError extends Error {
  readonly code: PackYamlErrorCode;
  /** One-based line number of the failure. */
  readonly line: number;

  constructor(code: PackYamlErrorCode, message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "PackYamlError";
    this.code = code;
    this.line = line;
  }
}

export interface PackYamlOptions {
  /** Maximum input length in bytes. Default 4 MiB. */
  readonly maxBytes?: number;
  /** Maximum materialized node count. Default 100_000. */
  readonly maxNodes?: number;
  /** Maximum nesting depth. Default 48. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_DEPTH = 48;

function packYamlCode(failure: BlockYamlFailure): PackYamlErrorCode {
  switch (failure.situation) {
    case "duplicate-key":
      return "duplicate-key";
    case "node-limit":
      return "node-limit";
    case "depth-limit":
      return "depth-limit";
    default:
      return "invalid";
  }
}

function packYamlMessage(failure: BlockYamlFailure): string {
  switch (failure.situation) {
    case "tab-indent":
      return "Tab characters are not allowed in indentation.";
    case "directive":
      return "YAML directives are not supported.";
    case "multiple-documents":
      return "Multiple YAML documents are not supported.";
    case "trailing-content":
      return "Unexpected content after the document.";
    case "sequence-indent":
      return "Unexpected indentation in a block sequence.";
    case "compact-sequence":
      return "Compact nested sequences are not supported.";
    case "mapping-indent":
      return "Unexpected indentation in a block mapping.";
    case "expected-entry":
      return "Expected a 'key: value' mapping entry.";
    case "empty-key":
      return "Mapping keys must not be empty.";
    case "duplicate-key":
      return `Duplicate mapping key: ${failure.key}`;
    case "node-limit":
      return "YAML node limit exceeded.";
    case "depth-limit":
      return "YAML nesting depth limit exceeded.";
    case "anchors":
      return "Anchors, aliases, and tags are not supported.";
    case "flow-unsupported":
      return "Flow collections are not supported.";
    case "quoted-scalar":
      return "Unterminated or trailing quoted scalar.";
    case "flow-trailing":
      return "Trailing content after a flow collection.";
    case "flow-unterminated":
      return "Unterminated flow collection.";
    case "flow-quoted":
      return "Unterminated quoted scalar in a flow collection.";
    case "flow-key":
      return "Unterminated quoted key in a flow mapping.";
    case "flow-colon":
      return "Expected ':' in a flow mapping.";
    case "flow-empty-key":
      return "Empty key in a flow mapping.";
    case "flow-separator":
      return `Expected ',' or '${failure.close}' in a flow collection.`;
    default:
      return "The YAML document is invalid.";
  }
}

/** Dialect that reproduces the pack manifest parser exactly. */
const PACK_YAML_DIALECT: BlockYamlDialect = {
  fail(failure) {
    throw new PackYamlError(
      packYamlCode(failure),
      packYamlMessage(failure),
      failure.line
    );
  },
  skipDirectives: true,
  tabCheck: "split",
  flow: true,
  limits: null,
  extendedEscapes: true,
  blankIsContent: false,
  chompFormulation: "text",
  flowSkipsBreaks: true,
  flowKeyBreaksOnBracket: true
};

/**
 * Parse pack YAML text into a JSON value. Throws {@link PackYamlError} on any
 * unsupported construct, duplicate key, or limit violation.
 */
export function parsePackYaml(
  text: string,
  options: PackYamlOptions = {}
): Json {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (text.length > maxBytes) {
    throw new PackYamlError(
      "size-limit",
      "YAML input exceeds the byte limit.",
      1
    );
  }
  return parseBlockYaml(text, {
    ...PACK_YAML_DIALECT,
    limits: {
      maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH
    }
  });
}
