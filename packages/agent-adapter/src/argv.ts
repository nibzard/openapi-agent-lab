/**
 * Placeholder expansion for the generic adapter (specification section 21.3).
 *
 * A template element may name one of the declared tokens. Expansion replaces
 * the token with its value and always produces exactly one argv element.
 * Nothing is split on whitespace and nothing is passed through a shell.
 */

import { invalidInput } from "@oal/core";

import type { AgentRunContext } from "./types.ts";

/** Error code for a token this API does not declare. */
export const ARGV_TOKEN_UNKNOWN = "AGENT_ARGV_TOKEN_UNKNOWN";

/** Error code for a declared token without a value in the run context. */
export const ARGV_TOKEN_UNRESOLVED = "AGENT_ARGV_TOKEN_UNRESOLVED";

/** Every token a template may name. */
export const ARGV_TOKEN_NAMES = [
  "instructions",
  "task",
  "launch",
  "workspace",
  "home",
  "tmpdir",
  "resultSchema",
  "baseUrl",
  "documentationUrl"
] as const;

export type ArgvTokenName = (typeof ARGV_TOKEN_NAMES)[number];

/** Shape the expansion reads. Derived from an `AgentRunContext`. */
export interface ArgvTokenSource {
  instructions?: string | undefined;
  task: string;
  launch: string;
  workspaceDir: string;
  homeDir: string;
  temporaryDir: string;
  resultSchemaPath?: string | undefined;
  baseUrl?: string | undefined;
  documentationUrl?: string | undefined;
}

/** Token syntax: one braced lowercase identifier. */
export const ARGV_TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

const TOKEN_READERS: Record<
  ArgvTokenName,
  (source: ArgvTokenSource) => string | undefined
> = {
  instructions: (source) => source.instructions,
  task: (source) => source.task,
  launch: (source) => source.launch,
  workspace: (source) => source.workspaceDir,
  home: (source) => source.homeDir,
  tmpdir: (source) => source.temporaryDir,
  resultSchema: (source) => source.resultSchemaPath,
  baseUrl: (source) => source.baseUrl,
  documentationUrl: (source) => source.documentationUrl
};

/** Result of expanding one argument template. */
export interface ArgvExpansion {
  /** Effective argv. One element per template element. */
  readonly argv: string[];
  /** Tokens used, in first-use order, without duplicates. */
  readonly usedTokens: ArgvTokenName[];
}

/** Derive the expansion source from one run context. */
export function argvTokenSourceFromContext(
  context: AgentRunContext
): ArgvTokenSource {
  return {
    instructions: context.prompts.instructions,
    task: context.prompts.task,
    launch: context.prompts.launch,
    workspaceDir: context.workspaceDir,
    homeDir: context.syntheticHomeDir,
    temporaryDir: context.temporaryDir,
    resultSchemaPath: context.resultSchemaPath,
    baseUrl: context.exposure.baseUrl,
    documentationUrl: context.exposure.documentationUrl
  };
}

/**
 * Expand one argument template. Each braced token becomes its value inside
 * the same element. An unknown token or a missing value is a hard error.
 */
export function expandArgument(
  template: string,
  source: ArgvTokenSource
): { value: string; usedTokens: ArgvTokenName[] } {
  const used: ArgvTokenName[] = [];
  const value = template.replace(ARGV_TOKEN_PATTERN, (_match, name: string) => {
    const reader = Object.prototype.hasOwnProperty.call(TOKEN_READERS, name)
      ? TOKEN_READERS[name as ArgvTokenName]
      : undefined;
    if (reader === undefined) {
      throw invalidInput(
        ARGV_TOKEN_UNKNOWN,
        `Unknown argv placeholder ${JSON.stringify(name)} in ${JSON.stringify(template)}.`,
        { token: name }
      );
    }
    const resolved = reader(source);
    if (resolved === undefined || resolved === "") {
      throw invalidInput(
        ARGV_TOKEN_UNRESOLVED,
        `argv placeholder ${JSON.stringify(name)} has no value in this run context.`,
        { token: name }
      );
    }
    if (!used.includes(name as ArgvTokenName)) {
      used.push(name as ArgvTokenName);
    }
    return resolved;
  });
  return { value, usedTokens: used };
}

/**
 * Expand an argument template array into the effective argv. The result has
 * exactly one element per template element and no secret material, because
 * the declared tokens never carry credentials.
 */
export function expandArgv(
  templates: readonly string[],
  source: ArgvTokenSource
): ArgvExpansion {
  const argv: string[] = [];
  const usedTokens: ArgvTokenName[] = [];
  for (const template of templates) {
    const expanded = expandArgument(template, source);
    argv.push(expanded.value);
    for (const token of expanded.usedTokens) {
      if (!usedTokens.includes(token)) {
        usedTokens.push(token);
      }
    }
  }
  return { argv, usedTokens };
}

/**
 * List the tokens one template names. Does not resolve them and does not
 * throw, so a caller can validate a configuration before a run exists.
 */
export function listArgumentTokens(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(ARGV_TOKEN_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
