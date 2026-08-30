/**
 * The pack-to-gateway projection of contract response fixtures. The
 * run wiring and the exposure treatments both import it, so it depends
 * on no runner module. It reads loaded pack state only, so the
 * projection is pure: identical packs produce identical fixtures.
 */

import { isJsonObject, type Json, type JsonObject } from "@oal/core";
import type { ContractFixture } from "@oal/gateway";
import type { LoadedPack } from "@oal/pack";

/** Manifest pointer prefix of one declared response fixture body. */
const RESPONSE_FIXTURES_POINTER = "/contract/response_fixtures";

/**
 * Project the response fixtures a loaded pack declares into the shape
 * `handleGatewayRequest` serves (specification section 15.5). The
 * manifest order is preserved, and `json_file` bodies resolve through
 * the references the pack loader already parsed, so identical packs
 * produce identical fixtures with no filesystem read.
 */
export function packResponseFixtures(pack: LoadedPack): ContractFixture[] {
  const contractSection = isJsonObject(pack.manifest["contract"])
    ? pack.manifest["contract"]
    : null;
  const declared =
    contractSection !== null &&
    Array.isArray(contractSection["response_fixtures"])
      ? contractSection["response_fixtures"]
      : [];
  const fixtures: ContractFixture[] = [];
  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index];
    if (!isJsonObject(entry)) {
      continue;
    }
    const id = entry["id"];
    const operation = entry["operation"];
    const status = entry["status"];
    if (
      typeof id !== "string" ||
      typeof operation !== "string" ||
      typeof status !== "number"
    ) {
      continue;
    }
    const mediaType = entry["media_type"];
    const headers = entry["headers"];
    const body = fixtureBodyOf(pack, index, entry["body"]);
    fixtures.push({
      id,
      operation,
      status,
      ...(typeof mediaType === "string" ? { media_type: mediaType } : {}),
      headers: isJsonObject(headers) ? stringValuesOf(headers) : {},
      ...(body === undefined ? {} : { body })
    });
  }
  return fixtures;
}

/**
 * Shape one declared fixture body. A `json_file` body carries the
 * parsed document of its loader reference; an unparsable or absent
 * reference keeps a null value, because preflight refuses such packs
 * before any exposure starts.
 */
function fixtureBodyOf(
  pack: LoadedPack,
  index: number,
  declared: Json | undefined
): ContractFixture["body"] | undefined {
  if (!isJsonObject(declared)) {
    return undefined;
  }
  const kind = declared["kind"];
  if (kind === "json_inline") {
    return { kind: "json_inline", value: declared["value"] ?? null };
  }
  if (kind === "json_file") {
    const source = declared["source"];
    const pointer = `${RESPONSE_FIXTURES_POINTER}/${index}/body`;
    const reference = pack.references.find(
      (candidate) =>
        candidate.role === "fixture_body" && candidate.pointer === pointer
    );
    return {
      kind: "json_file",
      ...(typeof source === "string" ? { source } : {}),
      value: reference?.document ?? null
    };
  }
  if (kind === "text_file") {
    const source = declared["source"];
    const pointer = `${RESPONSE_FIXTURES_POINTER}/${index}/body`;
    const reference = pack.references.find(
      (candidate) =>
        candidate.role === "fixture_body" && candidate.pointer === pointer
    );
    return {
      kind: "text_file",
      ...(typeof source === "string" ? { source } : {}),
      value: reference?.text ?? null
    };
  }
  return { kind: typeof kind === "string" ? kind : "none" };
}

/** Keep the string-valued header entries a fixture declares. */
function stringValuesOf(value: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      headers[name] = entry;
    }
  }
  return headers;
}
