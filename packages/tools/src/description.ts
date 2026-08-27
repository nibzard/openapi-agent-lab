/**
 * Tool description assembly (specification section 18.2).
 *
 * Generator-owned text defines tool behavior and argument semantics. Source
 * summary and description text is normalized, length-bounded, and placed
 * under an explicit untrusted label. The builder accepts ContractIR fields
 * only, so hidden scenario or grader text cannot enter by construction.
 */

/** Largest complete tool description, in characters. */
export const TOOL_DESCRIPTION_LIMIT = 1000;

/** Largest source summary plus description text, in characters. */
export const SOURCE_TEXT_BUDGET = 400;

/** Marker appended when source text is cut to fit the budget. */
const SOURCE_TEXT_ELLIPSIS = "...";

/** Generator-owned serialization guidance, shared by every tool. */
export const SERIALIZATION_GUIDANCE = [
  "Calls one API operation through the tested service.",
  "Pass parameters in the grouped argument objects.",
  "Send JSON bodies as plain JSON values with an explicit content type.",
  "Name binary bodies as bounded base64 with byte count and SHA-256.",
  "Authentication is injected by the bridge: never pass credentials.",
  "Large responses come back truncated with the digest of the complete bytes."
].join(" ");

/** Label that marks every source-owned text block. */
export const UNTRUSTED_LABEL = "Untrusted contract description";

/** Contract-derived inputs only. No free text enters here. */
export interface ToolDescriptionSource {
  method: string;
  pathTemplate: string;
  operationId: string | null;
  /** Operation summary from the contract, when present. */
  summary: string | null;
  /** Operation description from the contract, when present. */
  description: string | null;
}

/**
 * Normalize source text to plain text: strip control characters, collapse
 * every whitespace run to one space, and trim. Normalization is Unicode NFKC
 * so composed and decomposed forms compare equal.
 */
export function normalizePlainText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut normalized text to a budget and mark the cut. */
export function boundPlainText(
  text: string,
  budget: number
): { text: string; truncated: boolean } {
  if (text.length <= budget) {
    return { text, truncated: false };
  }
  const room = Math.max(budget - SOURCE_TEXT_ELLIPSIS.length, 0);
  return {
    text: `${text.slice(0, room)}${SOURCE_TEXT_ELLIPSIS}`,
    truncated: true
  };
}

/** Assemble one complete tool description. */
export function buildToolDescription(source: ToolDescriptionSource): {
  text: string;
  sourceTextTruncated: boolean;
} {
  const target = `${source.method} ${source.pathTemplate}`;
  const identity =
    source.operationId === null ? target : `${source.operationId} (${target})`;

  const summary = normalizePlainText(source.summary ?? "");
  const description = normalizePlainText(source.description ?? "");
  const merged = [summary, description]
    .filter((part) => part.length > 0)
    .join(" ");
  const bounded = boundPlainText(merged, SOURCE_TEXT_BUDGET);

  const blocks: string[] = [identity, SERIALIZATION_GUIDANCE];
  if (bounded.text.length > 0) {
    blocks.push(`${UNTRUSTED_LABEL}: ${bounded.text}`);
  }
  const assembled = blocks.join("\n\n");
  if (assembled.length > TOOL_DESCRIPTION_LIMIT) {
    const cut = boundPlainText(assembled, TOOL_DESCRIPTION_LIMIT);
    return { text: cut.text, sourceTextTruncated: true };
  }
  return { text: assembled, sourceTextTruncated: bounded.truncated };
}
