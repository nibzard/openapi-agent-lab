import type { Json } from "./json.ts";

/** Resolve a JSON Pointer (`#/a/b`) against a document. */
export function resolveJsonPointer(
  document: Json,
  pointer: string
): Json | undefined {
  if (pointer === "" || pointer === "/") {
    return document;
  }
  const tokens = pointer.split("/").slice(1).map(unescapeToken);
  let current: Json | undefined = document;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index] as Json;
      continue;
    }
    if (typeof current === "object") {
      current = (current as { [key: string]: Json })[token];
      continue;
    }
    return undefined;
  }
  return current;
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function appendPointer(pointer: string, token: string): string {
  return pointer === ""
    ? `/${escapeToken(token)}`
    : `${pointer}/${escapeToken(token)}`;
}

export function appendIndex(pointer: string, index: number): string {
  return `${pointer}/${index}`;
}
