import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_OK,
  EXIT_UNSUPPORTED,
  invalidInput,
  infrastructure,
  isJsonObject,
  stableJsonStringify,
  type ExitCode
} from "@oal/core";
import { hostilePatternDiagnostics } from "@oal/openapi";

import { diagnosticToJson } from "../diagnostics.ts";
import type { CommandArgs } from "../commands.ts";
import type { Io } from "../io.ts";
import { resolveSourceArgument } from "../source.ts";
import { compileServeSource } from "./serve.ts";
import {
  invalidOptionValue,
  missingArgument,
  tooManyArguments
} from "../usage.ts";

/** Compile a source and report its semantic and capability surfaces. */
export async function inspectCommand(
  args: CommandArgs,
  io: Io
): Promise<ExitCode> {
  const source = args.positionals[0];
  if (source === undefined) {
    throw missingArgument(args.command.name, "source");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  if (args.context.format !== "terminal" && args.context.format !== "json") {
    throw invalidOptionValue(
      "--format",
      args.context.format,
      "one of: terminal, json"
    );
  }
  const resolved =
    source === "-"
      ? await resolveSourceArgument(source, {
          cwd: args.context.cwd,
          maxBytes: args.context.maxSourceBytes,
          ...(io.stdin === undefined ? {} : { stdin: io.stdin })
        })
      : null;
  const compiled = await compileServeSource(
    resolved?.entrypoint ?? source,
    resolved === null ? args.context.cwd : "/",
    args.context.maxSourceBytes
  );
  // Every declared pattern answers a short adversarial probe inside
  // the worker boundary. Strict mode makes a hostile pattern an error;
  // the default records a warning.
  const patternFindings = await hostilePatternDiagnostics(compiled.contract, {
    strict: args.flags.has("strict")
  });
  const report = isJsonObject(compiled.capabilityReport)
    ? compiled.capabilityReport
    : {};
  const operationSelector = args.flags.string("operation");
  const operations = compiled.contract.operations.filter(
    (operation) =>
      operationSelector === undefined ||
      operation.key === operationSelector ||
      operation.operation_id === operationSelector
  );
  if (operationSelector !== undefined && operations.length === 0) {
    throw invalidInput(
      "OAL-INSPECT-OPERATION-UNKNOWN",
      `No operation has the ID or key ${operationSelector}.`,
      { operation: operationSelector }
    );
  }
  const operationKeys = new Set(operations.map((operation) => operation.key));
  const capabilityOperations = Array.isArray(report["operations"])
    ? report["operations"].filter(
        (operation) =>
          isJsonObject(operation) &&
          typeof operation["key"] === "string" &&
          operationKeys.has(operation["key"])
      )
    : [];
  const sourceEntrypoint =
    compiled.pack === null
      ? pathOf(resolved?.entrypoint ?? source, args.context.cwd)
      : path.resolve(compiled.pack.root, compiled.contract.source.entrypoint);
  const reportedDiagnostics = Array.isArray(report["diagnostics"])
    ? report["diagnostics"]
    : [];
  const artifact = {
    schema_version: 1,
    kind: "InspectReport",
    entrypoint: sourceEntrypoint,
    openapi_version: compiled.contract.source.openapi_version,
    source_format: compiled.contract.source.media_type,
    source_sha256: compiled.contract.source.sha256,
    semantic_sha256: compiled.contract.source.semantic_sha256,
    execution_sha256: compiled.contract.source.execution_sha256,
    referenced_documents: compiled.contract.source.documents,
    operation_count: operations.length,
    missing_operation_ids: operations.filter(
      (operation) => operation.operation_id === null
    ).length,
    duplicate_operation_ids: report["duplicate_operation_ids"] ?? [],
    tool_name_collisions: report["tool_name_collisions"] ?? [],
    counts: report["counts"] ?? {},
    operations: capabilityOperations,
    features: report["features"] ?? [],
    recommendations: report["recommendations"] ?? {},
    diagnostics: [
      ...reportedDiagnostics,
      ...patternFindings.map(diagnosticToJson)
    ],
    pack_eval_compatibility:
      compiled.pack === null
        ? null
        : {
            eval_ids: Array.isArray(compiled.pack.manifest["evals"])
              ? compiled.pack.manifest["evals"].flatMap((entry) =>
                  isJsonObject(entry) && typeof entry["id"] === "string"
                    ? [entry["id"]]
                    : []
                )
              : []
          }
  };
  const strictFailure =
    args.flags.has("strict") &&
    (operations.some((operation) => operation.support.level !== "supported") ||
      patternFindings.some((finding) => finding.severity === "error"));
  if (args.context.format === "json") {
    io.stdout(stableJsonStringify(artifact));
  } else {
    const recommendedExposure = isJsonObject(artifact.recommendations)
      ? artifact.recommendations["recommended_exposure"]
      : null;
    io.stdout(`OpenAPI version: ${artifact.openapi_version}`);
    io.stdout(`Source: ${artifact.entrypoint}`);
    io.stdout(`Source SHA-256: ${artifact.source_sha256}`);
    io.stdout(`Semantic SHA-256: ${artifact.semantic_sha256}`);
    io.stdout(`Operations: ${artifact.operation_count}`);
    io.stdout(
      `Recommended exposure: ${typeof recommendedExposure === "string" ? recommendedExposure : "none"}`
    );
  }
  const outPath = args.context.outPath;
  if (outPath !== null) {
    await writeFile(outPath, `${stableJsonStringify(artifact)}\n`).catch(
      (error: unknown) => {
        throw infrastructure(
          "OAL-ARTIFACT-WRITE-FAILED",
          `Failed to write --out target ${outPath}: ${describe(error)}`
        );
      }
    );
  }
  return strictFailure ? EXIT_UNSUPPORTED : EXIT_OK;
}

function pathOf(source: string, cwd: string): string {
  return source === "-" ? source : path.resolve(cwd, source);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
