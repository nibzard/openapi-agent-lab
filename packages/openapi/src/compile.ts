import {
  canonicalJsonSha256,
  DiagnosticCode,
  escapeToken,
  invalidInput,
  isJsonObject,
  operationUid,
  parseJsonStrict,
  sha256Hex,
  StrictJsonError,
  unsupported,
  type Diagnostic,
  type Json,
  type JsonObject,
  type OalError
} from "@oal/core";
import {
  CONTRACT_IR_SCHEMA_URI,
  CONTRACT_IR_SCHEMA_VERSION,
  operationKey,
  type CallbackIR,
  type ContractIR,
  type MediaContentIR,
  type OperationIR,
  type ParameterContentIR,
  type ParameterIR,
  type ParameterLocation,
  type ParameterStyle,
  type RequestBodyIR,
  type ResponseHeaderIR,
  type ResponseIR,
  type ResponseSelectorKind,
  type RouteSegment,
  type SecuritySchemeIR,
  type SecuritySchemeType,
  type ServerIR,
  type SupportLevel,
  type WebhookIR
} from "@oal/contract-ir";
import type { CapabilityReport } from "@oal/capability";

import {
  buildCapabilityReport,
  CAP_LINK_DESCRIBED,
  type CapabilityOptions
} from "./capability.ts";
import { resolveCompilerLimits, type CompilerLimits } from "./limits.ts";
import { documentSetFromRecord, type DocumentSet } from "./loader.ts";
import {
  detectSourceFormat,
  mediaSupport,
  SOURCE_MEDIA_TYPES
} from "./media.ts";
import { normalizeSchema, type OpenApiDialect } from "./normalize.ts";
import {
  DEFAULT_REF_POLICY,
  discoverExternalRefs,
  ReferenceResolver,
  type RefPolicy,
  type ResolvedNode
} from "./refs.ts";
import {
  parsePathTemplate,
  PATH_METHODS,
  templatesConflict
} from "./routes.ts";
import { SchemaRegistry } from "./schemas.ts";
import {
  captureExamples,
  type CapturedExample,
  type ExampleBudget
} from "./examples.ts";
import { assignToolNames } from "./tools.ts";
import { parseSafeYaml, SafeYamlError } from "./yaml.ts";
import {
  DEFAULT_EXPLODE,
  DEFAULT_STYLE,
  parameterSupport,
  schemaShape,
  securitySchemeSupport,
  worstOf
} from "./support.ts";

export const COMPILER_NAME = "@oal/openapi";
export const COMPILER_VERSION = "0.1.0";

export interface CompileInput {
  readonly documents:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  readonly entrypoint: string;
}

export interface CompileOptions extends CapabilityOptions {
  readonly limits?: Partial<CompilerLimits>;
  readonly refPolicy?: RefPolicy;
}

export interface CompileResult {
  readonly contract: ContractIR;
  readonly report: CapabilityReport;
}

/** Diagnostics whose failure category is a capability, not bad input. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  DiagnosticCode.OasVersionUnsupported,
  DiagnosticCode.RefRemoteDisabled,
  DiagnosticCode.RefCycleUnsupported
]);

const LOCATIONS: readonly ParameterLocation[] = [
  "path",
  "query",
  "header",
  "cookie"
];
const STYLES: readonly ParameterStyle[] = [
  "simple",
  "label",
  "matrix",
  "form",
  "spaceDelimited",
  "pipeDelimited",
  "deepObject"
];
const SCHEME_TYPES: readonly SecuritySchemeType[] = [
  "apiKey",
  "http",
  "oauth2",
  "openIdConnect",
  "mutualTLS"
];

const encoder = new TextEncoder();

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isObject(value: Json | undefined): value is JsonObject {
  return isJsonObject(value);
}

/** Collect extension entries, stripping the `x-` prefix. */
function extensionsOf(node: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-")) {
      out[key.slice(2)] = value;
    }
  }
  return out;
}

/** True when the input was given as a record rather than a map. */
function isDocumentRecord(
  documents: CompileInput["documents"]
): documents is Readonly<Record<string, string>> {
  return typeof (documents as ReadonlyMap<string, string>).get !== "function";
}

function toDocumentSet(input: CompileInput): DocumentSet {
  if (isDocumentRecord(input.documents)) {
    return documentSetFromRecord(input.entrypoint, input.documents);
  }
  return { entrypoint: input.entrypoint, documents: input.documents };
}

class SupportAccumulator {
  private readonly levels: SupportLevel[] = [];
  private readonly codes = new Set<string>();

  add(level: SupportLevel, reasonCodes: readonly string[]): void {
    this.levels.push(level);
    for (const code of reasonCodes) {
      this.codes.add(code);
    }
  }

  get level(): SupportLevel {
    return worstOf(this.levels);
  }

  get reasonCodes(): string[] {
    return [...this.codes].sort();
  }
}

export class OpenApiCompiler {
  private readonly limits: CompilerLimits;
  private readonly policy: RefPolicy;
  private readonly texts: ReadonlyMap<string, string>;
  private readonly entrypoint: string;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly registry = new SchemaRegistry();
  private readonly parsed = new Map<string, Json>();
  private readonly budget: ExampleBudget = {
    retainedBytes: 0,
    exhausted: false
  };
  private dialect: OpenApiDialect = "3.1";
  private root: JsonObject = {};
  private entryUri = "";
  private readonly options: CompileOptions;
  private readonly resolver: ReferenceResolver;

  constructor(input: CompileInput, options: CompileOptions = {}) {
    const set: DocumentSet = toDocumentSet(input);
    this.entrypoint = set.entrypoint;
    this.texts = set.documents;
    this.limits = resolveCompilerLimits(options.limits);
    this.policy = options.refPolicy ?? DEFAULT_REF_POLICY;
    this.options = options;
    this.resolver = new ReferenceResolver(
      this.parsed,
      this.policy,
      this.limits,
      (diagnostic) => this.fail(diagnostic)
    );
  }

  // ---- diagnostics ----------------------------------------------------

  private emit(diagnostic: Diagnostic): void {
    if (this.diagnostics.length >= 1000) {
      return;
    }
    this.diagnostics.push(diagnostic);
  }

  private fail(diagnostic: Diagnostic): never {
    this.diagnostics.push(diagnostic);
    throw this.toError(diagnostic);
  }

  private toError(diagnostic: Diagnostic): OalError {
    const details: JsonObject = isObject(diagnostic.details)
      ? { ...diagnostic.details }
      : {};
    details.diagnostics = this.diagnostics as unknown as Json;
    return UNSUPPORTED_CODES.has(diagnostic.code)
      ? unsupported(diagnostic.code, diagnostic.message, details)
      : invalidInput(diagnostic.code, diagnostic.message, details);
  }

  private requireObject(
    node: Json,
    uri: string,
    pointer: string,
    message: string
  ): JsonObject {
    if (isJsonObject(node)) {
      return node;
    }
    const diagnostic = structure(message, uri, pointer);
    this.diagnostics.push(diagnostic);
    throw this.toError(diagnostic);
  }

  private abortOnError(): void {
    const error = this.diagnostics.find((entry) => entry.severity === "error");
    if (error !== undefined) {
      throw this.toError(error);
    }
  }

  // ---- pipeline -------------------------------------------------------

  compile(): CompileResult {
    const sourceSha = this.parseEntrypoint();
    const documents = this.freezeReachableDocuments();
    const securitySchemes = this.compileSecuritySchemes();
    const rootServers = this.compileServers(this.root.servers);
    const { operations, webhooks } = this.compileSurfaces(
      rootServers,
      securitySchemes
    );
    this.checkAmbiguousRoutes(operations);
    this.assignToolNames(operations, webhooks);
    this.abortOnError();

    const contract: ContractIR = {
      $schema: CONTRACT_IR_SCHEMA_URI,
      schema_version: CONTRACT_IR_SCHEMA_VERSION,
      kind: "ContractIR",
      compiler: { name: COMPILER_NAME, version: COMPILER_VERSION },
      source: {
        entrypoint: this.entrypoint,
        media_type: SOURCE_MEDIA_TYPES[detectSourceFormat(this.entryText())],
        openapi_version: asString(this.root.openapi) ?? "",
        sha256: sourceSha,
        semantic_sha256: "",
        execution_sha256: "",
        documents
      },
      api: {
        title: this.infoField("title"),
        version: this.infoField("version"),
        description: this.infoField("description"),
        servers: rootServers
      },
      security_schemes: securitySchemes,
      schemas: this.registry.toJson(),
      operations,
      webhooks,
      diagnostics: [...this.diagnostics].sort(compareDiagnostics),
      extensions: extensionsOf(this.root)
    };
    contract.source.semantic_sha256 = canonicalJsonSha256(
      semanticProjection(contract)
    );
    contract.source.execution_sha256 = canonicalJsonSha256(
      executionProjection(contract)
    );
    return {
      contract,
      report: buildCapabilityReport(contract, this.options)
    };
  }

  private entryText(): string {
    return this.texts.get(this.entrypoint) ?? "";
  }

  private infoField(field: string): string | null {
    const info = this.root.info;
    if (!isObject(info)) {
      return null;
    }
    return asString(info[field]);
  }

  // ---- stages 1 to 4 --------------------------------------------------

  private parseEntrypoint(): string {
    const text = this.entryText();
    if (text === "") {
      this.fail(missingEntrypoint(this.entrypoint));
    }
    const bytes = encoder.encode(text).byteLength;
    if (bytes > this.limits.maxSourceOpenapiBytes) {
      this.fail(tooLarge(this.entrypoint, bytes, this.limits));
    }
    const root = this.parseDocument(this.entrypoint, text);
    if (!isObject(root)) {
      this.fail(
        structure(
          "The OpenAPI document must be a mapping.",
          this.entrypoint,
          "#"
        )
      );
    }
    this.root = root;
    this.entryUri = this.entrypoint;
    this.checkVersion();
    return sha256Hex(text);
  }

  private checkVersion(): void {
    const version = asString(this.root.openapi);
    if (version === null) {
      this.fail(
        versionFailure(
          "The document has no `openapi` version string.",
          this.entryUri
        )
      );
    }
    if (/^3\.0\.\d+/.test(version)) {
      this.dialect = "3.0";
      return;
    }
    if (/^3\.1\.\d+/.test(version)) {
      this.dialect = "3.1";
      return;
    }
    this.fail(
      versionFailure(
        `OpenAPI ${version} is not supported; this compiler accepts 3.0.x and 3.1.x.`,
        this.entryUri
      )
    );
  }

  private parseDocument(uri: string, text: string): Json {
    const cached = this.parsed.get(uri);
    if (cached !== undefined) {
      return cached;
    }
    const format = detectSourceFormat(text);
    let value: Json;
    try {
      value =
        format === "json"
          ? parseJsonStrict(text, {
              maxBytes: this.limits.maxSourceOpenapiBytes,
              maxNodes: this.limits.maxParsedNodes
            })
          : parseSafeYaml(text, {
              maxBytes: this.limits.maxSourceOpenapiBytes,
              maxNodes: this.limits.maxParsedNodes,
              maxDepth: this.limits.maxTraversalDepth,
              maxAliasExpansions: this.limits.maxParsedNodes
            });
    } catch (error) {
      throw this.parseFailure(uri, error);
    }
    this.parsed.set(uri, value);
    return value;
  }

  private parseFailure(uri: string, error: unknown): OalError {
    if (error instanceof StrictJsonError) {
      return this.toError(
        ingest(DiagnosticCode.JsonInvalid, error.message, uri, "#", {
          offset: error.offset
        })
      );
    }
    if (error instanceof SafeYamlError) {
      return this.toError(
        ingest(yamlCodeOf(error.code), error.message, uri, error.nodePointer, {
          line: error.line,
          column: error.column
        })
      );
    }
    return this.toError(
      ingest(
        DiagnosticCode.YamlInvalid,
        error instanceof Error ? error.message : String(error),
        uri,
        "#",
        {}
      )
    );
  }

  // ---- stage 5 --------------------------------------------------------

  private freezeReachableDocuments(): Array<{ uri: string; sha256: string }> {
    const reachable = new Set<string>([this.entrypoint]);
    const queue: string[] = [this.entrypoint];
    while (queue.length > 0) {
      const uri = queue.shift() as string;
      const text = this.texts.get(uri);
      if (text === undefined) {
        this.fail(missingDocument(uri));
      }
      this.parseDocument(uri, text);
      for (const target of discoverExternalRefs(uri, text)) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
    return [...reachable]
      .sort()
      .map((uri) => ({ uri, sha256: sha256Hex(this.texts.get(uri) ?? "") }));
  }

  // ---- shared nodes ---------------------------------------------------

  private deref(value: Json, uri: string, pointer: string): ResolvedNode {
    return this.resolver.deref(uri, pointer, value);
  }

  private registerOptionalSchema(
    node: Json | undefined,
    uri: string,
    pointer: string
  ): { uid: string | null; normalized: Json | null } {
    if (node === undefined) {
      return { uid: null, normalized: null };
    }
    return this.registerSchema(node, uri, pointer);
  }

  private registerSchema(
    node: Json,
    uri: string,
    pointer: string
  ): { uid: string; normalized: Json } {
    const resolved = this.deref(node, uri, pointer);
    const normalized = normalizeSchema(
      resolved,
      this.resolver,
      this.dialect,
      this.limits,
      (diagnostic) => this.fail(diagnostic)
    );
    const uid = this.registry.register(
      normalized.schema,
      resolved.pointer,
      resolved.uri
    );
    return { uid, normalized: normalized.schema };
  }

  private compileServers(node: Json | undefined): ServerIR[] {
    if (!Array.isArray(node)) {
      return [];
    }
    const out: ServerIR[] = [];
    for (const entry of node) {
      if (!isObject(entry)) {
        continue;
      }
      const variables: ServerIR["variables"] = {};
      if (isObject(entry.variables)) {
        for (const name of Object.keys(entry.variables).sort()) {
          const variable = entry.variables[name];
          if (!isObject(variable)) {
            continue;
          }
          variables[name] = {
            // A server variable enumerates an unordered set of allowed
            // values, so members are sorted to keep the digests stable
            // when equivalent documents declare them in a different order.
            enum: Array.isArray(variable.enum)
              ? variable.enum
                  .filter((item): item is string => typeof item === "string")
                  .sort()
              : [],
            default: asString(variable.default) ?? "",
            description: asString(variable.description)
          };
        }
      }
      out.push({
        url: asString(entry.url) ?? "",
        description: asString(entry.description),
        variables
      });
    }
    return out;
  }

  private compileSecuritySchemes(): Record<string, SecuritySchemeIR> {
    const out: Record<string, SecuritySchemeIR> = {};
    const components = this.root.components;
    const schemes = isObject(components)
      ? components.securitySchemes
      : undefined;
    if (!isObject(schemes)) {
      return out;
    }
    for (const name of Object.keys(schemes).sort()) {
      const node = schemes[name];
      if (node === undefined) {
        continue;
      }
      const resolved = this.deref(
        node,
        this.entryUri,
        `#/components/securitySchemes/${escapeToken(name)}`
      );
      const scheme = this.requireObject(
        resolved.value,
        resolved.uri,
        resolved.pointer,
        `Security scheme '${name}' must be a mapping.`
      );
      const type = asString(scheme.type);
      if (type === null || !SCHEME_TYPES.includes(type as SecuritySchemeType)) {
        this.fail(
          structure(
            `Security scheme '${name}' has an unknown type.`,
            resolved.uri,
            resolved.pointer
          )
        );
      }
      const flows: NonNullable<SecuritySchemeIR["flows"]> = {};
      if (isObject(scheme.flows)) {
        for (const flowName of Object.keys(scheme.flows).sort()) {
          const flow = scheme.flows[flowName];
          if (!isObject(flow)) {
            continue;
          }
          const scopes: Record<string, string> = {};
          if (isObject(flow.scopes)) {
            for (const scope of Object.keys(flow.scopes).sort()) {
              scopes[scope] = asString(flow.scopes[scope]) ?? "";
            }
          }
          flows[flowName] = {
            authorization_url: asString(flow.authorizationUrl),
            token_url: asString(flow.tokenUrl),
            refresh_url: asString(flow.refreshUrl),
            scopes
          };
        }
      }
      const support = securitySchemeSupport(
        type as SecuritySchemeType,
        asString(scheme.scheme)
      );
      if (support.level !== "supported") {
        this.emit(
          capabilityDiagnostic(
            support.level,
            DiagnosticCode.CapAuthFlowUnsupported,
            `Security scheme '${name}' is ${support.level}.`,
            resolved.uri,
            resolved.pointer,
            support.reasonCodes
          )
        );
      }
      const location = asString(scheme.in);
      out[name] = {
        name,
        type: type as SecuritySchemeType,
        description: asString(scheme.description),
        location: location === null ? null : (location as ParameterLocation),
        wire_name: asString(scheme.name),
        scheme: asString(scheme.scheme),
        bearer_format: asString(scheme.bearerFormat),
        flows: Object.keys(flows).length > 0 ? flows : null,
        open_id_connect_url: asString(scheme.openIdConnectUrl),
        support: support.level,
        support_reason_codes: support.reasonCodes,
        source_pointer: resolved.pointer
      };
    }
    return out;
  }

  // ---- paths and webhooks ---------------------------------------------

  private compileSurfaces(
    rootServers: ServerIR[],
    securitySchemes: Record<string, SecuritySchemeIR>
  ): { operations: OperationIR[]; webhooks: WebhookIR[] } {
    const operations: OperationIR[] = [];
    const webhooks: WebhookIR[] = [];
    const rootSecurity = this.root.security;

    // OpenAPI 3.1 allows a document that has only webhooks or components.
    if (this.root.paths !== undefined && !isObject(this.root.paths)) {
      this.fail(
        structure("`paths` must be a mapping.", this.entryUri, "#/paths")
      );
    }
    const paths = isObject(this.root.paths) ? this.root.paths : {};
    for (const template of Object.keys(paths).sort()) {
      const node = paths[template];
      if (node === undefined) {
        continue;
      }
      const resolved = this.deref(
        node,
        this.entryUri,
        `#/paths/${escapeToken(template)}`
      );
      const item = this.requireObject(
        resolved.value,
        resolved.uri,
        resolved.pointer,
        `Path item '${template}' must be a mapping.`
      );
      void item;
      this.compilePathItem(
        resolved,
        template,
        rootServers,
        rootSecurity,
        securitySchemes,
        operations
      );
    }

    const webhookNodes = this.root.webhooks;
    if (isObject(webhookNodes)) {
      for (const name of Object.keys(webhookNodes).sort()) {
        const node = webhookNodes[name];
        if (node === undefined) {
          continue;
        }
        const resolved = this.deref(
          node,
          this.entryUri,
          `#/webhooks/${escapeToken(name)}`
        );
        const hook = this.requireObject(
          resolved.value,
          resolved.uri,
          resolved.pointer,
          `Webhook '${name}' must be a mapping.`
        );
        const hookOperations: OperationIR[] = [];
        this.compilePathItem(
          resolved,
          name,
          [],
          rootSecurity,
          securitySchemes,
          hookOperations,
          "webhook"
        );
        webhooks.push({
          name,
          description: asString(hook.description),
          operations: hookOperations,
          source_pointer: resolved.pointer
        });
      }
    }

    operations.sort(compareOperations);
    if (this.root.paths === undefined && webhooks.length === 0) {
      this.fail(
        structure(
          "The document declares no paths and no webhooks.",
          this.entryUri,
          "#"
        )
      );
    }
    if (operations.length + webhooks.length > this.limits.maxOperations) {
      this.fail(limitReached(operations.length + webhooks.length, this.limits));
    }
    return { operations, webhooks };
  }

  private compilePathItem(
    resolved: ResolvedNode,
    template: string,
    inheritedServers: ServerIR[],
    rootSecurity: Json | undefined,
    securitySchemes: Record<string, SecuritySchemeIR>,
    sink: OperationIR[],
    surface: "path" | "webhook" = "path"
  ): void {
    const item = this.requireObject(
      resolved.value,
      resolved.uri,
      resolved.pointer,
      `Path item '${template}' must be a mapping.`
    );
    // A webhook names a non-routable surface, so it carries no template
    // parsing. ContractIR still requires at least one route segment, so the
    // webhook name is recorded as one literal segment.
    const segments: RouteSegment[] =
      surface === "path"
        ? parsePathTemplateOrFail(
            template,
            resolved.uri,
            resolved.pointer,
            (diagnostic) => this.fail(diagnostic)
          )
        : [{ kind: "literal", value: template }];
    const pathServers = this.compileServers(item.servers);
    const effectiveServers =
      pathServers.length > 0 ? pathServers : inheritedServers;
    const pathParameters = this.compileParameterList(
      item.parameters,
      resolved.uri,
      `${resolved.pointer}/parameters`
    );

    for (const method of PATH_METHODS) {
      const node = item[method];
      if (node === undefined) {
        continue;
      }
      const opPointer = `${resolved.pointer}/${method}`;
      const operationNode = this.requireObject(
        node,
        resolved.uri,
        opPointer,
        `Operation ${method} must be a mapping.`
      );
      sink.push(
        this.compileOperation({
          node: operationNode,
          uri: resolved.uri,
          pointer: opPointer,
          method,
          template,
          segments,
          surface,
          servers: effectiveServers,
          pathParameters,
          rootSecurity,
          securitySchemes
        })
      );
    }
  }

  private compileOperation(input: {
    node: JsonObject;
    uri: string;
    pointer: string;
    method: string;
    template: string;
    segments: RouteSegment[];
    surface: "path" | "webhook";
    servers: ServerIR[];
    pathParameters: ParameterIR[];
    rootSecurity: Json | undefined;
    securitySchemes: Record<string, SecuritySchemeIR>;
  }): OperationIR {
    const { node, uri, pointer, method, template, segments, surface } = input;
    const key = operationKey(method, template);
    const support = new SupportAccumulator();
    const emitFor = (diagnostic: Diagnostic): void => {
      this.emit({ ...diagnostic, operation_key: key });
    };

    const operationParameters = this.compileParameterList(
      node.parameters,
      uri,
      `${pointer}/parameters`
    );
    const parameters = mergeParameters(
      input.pathParameters,
      operationParameters
    );
    for (const parameter of parameters) {
      support.add(parameter.support, parameter.support_reason_codes);
      if (parameter.support !== "supported") {
        emitFor(
          capabilityDiagnostic(
            parameter.support,
            DiagnosticCode.CapParameterUnsupported,
            `Parameter '${parameter.name}' (${parameter.location}) is ${parameter.support}.`,
            uri,
            parameter.source_pointer,
            parameter.support_reason_codes
          )
        );
      }
    }
    if (surface === "path") {
      checkPathParameters(
        template,
        segments,
        parameters,
        uri,
        pointer,
        emitFor
      );
    }

    const requestBody = this.compileRequestBody(
      node.requestBody,
      uri,
      `${pointer}/requestBody`,
      support,
      emitFor
    );
    const responses = this.compileResponses(
      node.responses,
      uri,
      `${pointer}/responses`,
      support,
      emitFor
    );
    const callbacks = this.compileCallbacks(
      node.callbacks,
      uri,
      `${pointer}/callbacks`,
      support,
      emitFor
    );

    const hasSuccess = responses.some(
      (response) =>
        response.selector_kind === "exact" &&
        (response.status ?? 0) >= 200 &&
        (response.status ?? 0) < 300
    );
    const hasFallback = responses.some(
      (response) =>
        response.selector_kind === "default" ||
        response.selector_kind === "range"
    );
    if (surface === "path" && !hasSuccess && !hasFallback) {
      support.add("unsupported", ["response:no-success"]);
      emitFor(
        capabilityDiagnostic(
          "unsupported",
          DiagnosticCode.CapResponseGenerationUnsupported,
          "The operation declares no deterministic success response.",
          uri,
          `${pointer}/responses`,
          ["response:no-success"]
        )
      );
    }

    const security = this.compileSecurity(
      node.security,
      input.rootSecurity,
      input.securitySchemes,
      support,
      emitFor,
      uri,
      pointer
    );
    if (surface === "webhook") {
      support.add("approximated", ["webhook:invocation-unsupported"]);
      emitFor(
        capabilityDiagnostic(
          "approximated",
          DiagnosticCode.CapCallbackUnsupported,
          "Webhook definitions are preserved but never invoked.",
          uri,
          pointer,
          ["webhook:invocation-unsupported"]
        )
      );
    }

    const opServers = this.compileServers(node.servers);
    return {
      key,
      uid: operationUid(key),
      surface,
      method: method.toUpperCase(),
      path_template: template,
      route_segments: segments,
      operation_id: asString(node.operationId),
      tool_name: "",
      summary: asString(node.summary),
      description: asString(node.description),
      tags: Array.isArray(node.tags)
        ? node.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      deprecated: asBoolean(node.deprecated, false),
      servers: opServers.length > 0 ? opServers : input.servers,
      parameters,
      request_body: requestBody,
      responses,
      security,
      callbacks,
      extensions: extensionsOf(node),
      source_pointer: pointer,
      support: {
        level: support.level,
        diagnostic_codes: []
      }
    };
  }

  private finalizeSupport(operations: OperationIR[]): void {
    for (const operation of operations) {
      operation.support.diagnostic_codes = this.diagnostics
        .filter((entry) => entry.operation_key === operation.key)
        .map((entry) => entry.code)
        .filter((code, index, all) => all.indexOf(code) === index)
        .sort();
    }
  }

  private compileParameterList(
    node: Json | undefined,
    uri: string,
    pointer: string
  ): ParameterIR[] {
    if (node === undefined) {
      return [];
    }
    if (!Array.isArray(node)) {
      this.fail(structure("`parameters` must be an array.", uri, pointer));
    }
    const seen = new Set<string>();
    const out: ParameterIR[] = [];
    node.forEach((entry, index) => {
      const resolved = this.deref(entry, uri, `${pointer}/${index}`);
      const parameter = this.compileParameter(
        this.requireObject(
          resolved.value,
          resolved.uri,
          resolved.pointer,
          "A parameter must be a mapping."
        ),
        resolved.uri,
        resolved.pointer
      );
      const identity = `${parameter.location}:${parameter.name}`;
      if (seen.has(identity)) {
        this.fail(
          duplicateParameter(parameter, resolved.uri, resolved.pointer)
        );
      }
      seen.add(identity);
      out.push(parameter);
    });
    return out;
  }

  private compileParameter(
    node: JsonObject,
    uri: string,
    pointer: string
  ): ParameterIR {
    const name = asString(node.name);
    const rawLocation = asString(node.in);
    if (
      name === null ||
      rawLocation === null ||
      !LOCATIONS.includes(rawLocation as ParameterLocation)
    ) {
      this.fail(
        structure("A parameter needs a valid `name` and `in`.", uri, pointer)
      );
    }
    const location = rawLocation as ParameterLocation;
    const rawStyle = asString(node.style);
    const style: ParameterStyle =
      rawStyle !== null && STYLES.includes(rawStyle as ParameterStyle)
        ? (rawStyle as ParameterStyle)
        : DEFAULT_STYLE[location];

    const registered = this.registerOptionalSchema(
      node.schema,
      uri,
      `${pointer}/schema`
    );
    const normalized = registered.normalized;
    const contentNodes = isObject(node.content) ? node.content : null;
    const content =
      contentNodes === null
        ? null
        : this.compileParameterContent(contentNodes, uri, `${pointer}/content`);

    const outcome = parameterSupport({
      location,
      style,
      shape: schemaShape(normalized ?? undefined),
      contentMediaTypes: content === null ? [] : [content.media_type]
    });
    const examples = this.captureExamples(node, name, uri, pointer);
    const defaultValue = isObject(normalized) ? normalized.default : undefined;

    return {
      name,
      location,
      style,
      explode: asBoolean(node.explode, DEFAULT_EXPLODE[location]),
      allow_reserved: asBoolean(node.allowReserved, false),
      required: location === "path" ? true : asBoolean(node.required, false),
      deprecated: asBoolean(node.deprecated, false),
      description: asString(node.description),
      schema_ref: registered.uid,
      content,
      examples: examples.map((example) => ({
        name: example.name,
        value: example.value
      })),
      default_value: defaultValue,
      support: outcome.level,
      support_reason_codes: outcome.reasonCodes,
      source_pointer: pointer
    };
  }

  private compileParameterContent(
    node: JsonObject,
    uri: string,
    pointer: string
  ): ParameterContentIR {
    const mediaTypes = Object.keys(node).sort();
    const chosen = mediaTypes[0] ?? "";
    const entry = this.requireObject(
      node[chosen] as Json,
      uri,
      pointer,
      "Parameter content entry must be a mapping."
    );
    const token = escapeToken(chosen);
    return {
      media_type: chosen,
      schema_ref: this.registerSchema(
        entry.schema ?? {},
        uri,
        `${pointer}/${token}/schema`
      ).uid,
      examples: this.captureExamples(
        entry,
        null,
        uri,
        `${pointer}/${token}`
      ).map((example) => ({ name: example.name, value: example.value }))
    };
  }

  private captureExamples(
    node: JsonObject,
    keyName: string | null,
    uri: string,
    pointer: string
  ): CapturedExample[] {
    return captureExamples(
      node,
      keyName,
      uri,
      pointer,
      this.limits,
      this.budget,
      (d) => {
        this.emit(d);
      }
    );
  }

  private compileRequestBody(
    node: Json | undefined,
    uri: string,
    pointer: string,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void
  ): RequestBodyIR | null {
    if (node === undefined) {
      return null;
    }
    const resolved = this.deref(node, uri, pointer);
    const body = this.requireObject(
      resolved.value,
      resolved.uri,
      resolved.pointer,
      "A request body must be a mapping."
    );
    const content = this.compileMediaContentMap(
      body.content,
      resolved.uri,
      `${resolved.pointer}/content`,
      support,
      emitFor
    );
    return {
      required: asBoolean(body.required, false),
      description: asString(body.description),
      content,
      source_pointer: resolved.pointer
    };
  }

  private compileResponses(
    node: Json | undefined,
    uri: string,
    pointer: string,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void
  ): ResponseIR[] {
    if (node === undefined) {
      this.fail(
        structure("An operation must declare `responses`.", uri, pointer)
      );
    }
    const resolved = this.deref(node, uri, pointer);
    const responses = this.requireObject(
      resolved.value,
      resolved.uri,
      resolved.pointer,
      "`responses` must be a mapping."
    );
    const out: ResponseIR[] = [];
    for (const selector of Object.keys(responses).sort()) {
      const entry = responses[selector];
      if (entry === undefined) {
        continue;
      }
      // A selector must be `default`, a `[1-5]XX` range, or a concrete
      // status code. Anything else would parse to NaN and corrupt the
      // canonical digests, so it fails as a structure error.
      if (!isResponseSelector(selector)) {
        this.fail(
          structure(
            `Response selector '${selector}' must be a status code, a 1XX to 5XX range, or 'default'.`,
            resolved.uri,
            `${resolved.pointer}/${escapeToken(selector)}`
          )
        );
      }
      const entryResolved = this.deref(
        entry,
        resolved.uri,
        `${resolved.pointer}/${escapeToken(selector)}`
      );
      const response = this.requireObject(
        entryResolved.value,
        entryResolved.uri,
        entryResolved.pointer,
        `Response '${selector}' must be a mapping.`
      );
      const responseSupport = new SupportAccumulator();
      const headers = this.compileResponseHeaders(
        entryResolved,
        responseSupport
      );
      const content = this.compileMediaContentMap(
        response.content,
        entryResolved.uri,
        `${entryResolved.pointer}/content`,
        responseSupport,
        emitFor
      );
      this.compileLinks(
        response.links,
        entryResolved.uri,
        `${entryResolved.pointer}/links`,
        responseSupport,
        emitFor
      );
      out.push({
        selector,
        selector_kind: selectorKindOf(selector),
        status: selectorKindOf(selector) === "exact" ? Number(selector) : null,
        description: asString(response.description),
        headers,
        content,
        source_pointer: entryResolved.pointer
      });
      support.add(responseSupport.level, responseSupport.reasonCodes);
    }
    return out.sort(compareResponses);
  }

  private compileResponseHeaders(
    response: ResolvedNode,
    support: SupportAccumulator
  ): ResponseHeaderIR[] {
    const body = this.requireObject(
      response.value,
      response.uri,
      response.pointer,
      "A response must be a mapping."
    );
    const nodes = body.headers;
    if (!isObject(nodes)) {
      return [];
    }
    const out: ResponseHeaderIR[] = [];
    for (const name of Object.keys(nodes).sort()) {
      const node = nodes[name];
      if (node === undefined) {
        continue;
      }
      const resolved = this.deref(
        node,
        response.uri,
        `${response.pointer}/headers/${escapeToken(name)}`
      );
      const header = this.requireObject(
        resolved.value,
        resolved.uri,
        resolved.pointer,
        `Header '${name}' must be a mapping.`
      );
      const registered = this.registerOptionalSchema(
        header.schema,
        resolved.uri,
        `${resolved.pointer}/schema`
      );
      const contentNodes = isObject(header.content) ? header.content : null;
      const content =
        contentNodes === null
          ? null
          : this.compileParameterContent(
              contentNodes,
              resolved.uri,
              `${resolved.pointer}/content`
            );
      const outcome = parameterSupport({
        location: "header",
        style: "simple",
        shape: schemaShape(registered.normalized ?? undefined),
        contentMediaTypes: content === null ? [] : [content.media_type]
      });
      support.add(outcome.level, outcome.reasonCodes);
      out.push({
        name,
        required: asBoolean(header.required, false),
        deprecated: asBoolean(header.deprecated, false),
        description: asString(header.description),
        schema_ref: registered.uid,
        content,
        examples: this.captureExamples(
          header,
          name,
          resolved.uri,
          resolved.pointer
        ).map((example) => ({ name: example.name, value: example.value })),
        support: outcome.level,
        support_reason_codes: outcome.reasonCodes
      });
    }
    return out;
  }

  private compileMediaContentMap(
    node: Json | undefined,
    uri: string,
    pointer: string,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void
  ): MediaContentIR[] {
    if (node === undefined) {
      return [];
    }
    const map = this.requireObject(
      node,
      uri,
      pointer,
      "`content` must be a mapping."
    );
    const out: MediaContentIR[] = [];
    for (const mediaType of Object.keys(map).sort()) {
      const entry = map[mediaType];
      if (entry === undefined) {
        continue;
      }
      const resolved = this.deref(
        entry,
        uri,
        `${pointer}/${escapeToken(mediaType)}`
      );
      const media = this.requireObject(
        resolved.value,
        resolved.uri,
        resolved.pointer,
        `Media type '${mediaType}' must be a mapping.`
      );
      const outcome = mediaSupport(mediaType);
      support.add(outcome.level, [outcome.reasonCode]);
      if (outcome.level !== "supported") {
        emitFor(
          capabilityDiagnostic(
            outcome.level,
            DiagnosticCode.CapMediaUnsupported,
            `Media type '${mediaType}' is ${outcome.level}.`,
            resolved.uri,
            resolved.pointer,
            [outcome.reasonCode]
          )
        );
      }
      out.push({
        media_type: mediaType,
        schema_ref: this.registerOptionalSchema(
          media.schema,
          resolved.uri,
          `${resolved.pointer}/schema`
        ).uid,
        examples: this.captureExamples(
          media,
          null,
          resolved.uri,
          resolved.pointer
        ).map((example) => ({
          name: example.name,
          value: example.value,
          summary: example.summary
        })),
        support: outcome.level,
        support_reason_codes: [outcome.reasonCode]
      });
    }
    return out;
  }

  private compileCallbacks(
    node: Json | undefined,
    uri: string,
    pointer: string,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void
  ): CallbackIR[] {
    if (node === undefined) {
      return [];
    }
    if (!isObject(node)) {
      this.fail(structure("`callbacks` must be a mapping.", uri, pointer));
    }
    const out: CallbackIR[] = [];
    for (const name of Object.keys(node).sort()) {
      const entry = node[name];
      if (entry === undefined) {
        continue;
      }
      const callbackResolved = this.deref(
        entry,
        uri,
        `${pointer}/${escapeToken(name)}`
      );
      const callback = this.requireObject(
        callbackResolved.value,
        callbackResolved.uri,
        callbackResolved.pointer,
        `Callback '${name}' must be a mapping.`
      );
      const expressions: CallbackIR["expressions"] = [];
      for (const expression of Object.keys(callback).sort()) {
        const pathItem = callback[expression];
        if (pathItem === undefined) {
          continue;
        }
        const itemResolved = this.deref(
          pathItem,
          callbackResolved.uri,
          `${callbackResolved.pointer}/${escapeToken(expression)}`
        );
        const item = this.requireObject(
          itemResolved.value,
          itemResolved.uri,
          itemResolved.pointer,
          "A callback expression must be a path item."
        );
        for (const method of PATH_METHODS) {
          const operation = item[method];
          if (operation === undefined) {
            continue;
          }
          const opResolved = this.deref(
            operation,
            itemResolved.uri,
            `${itemResolved.pointer}/${method}`
          );
          const callbackOperation = this.requireObject(
            opResolved.value,
            opResolved.uri,
            opResolved.pointer,
            "A callback operation must be a mapping."
          );
          const inner = new SupportAccumulator();
          expressions.push({
            method: method.toUpperCase(),
            path_template: expression,
            request_body: this.compileRequestBody(
              callbackOperation.requestBody,
              opResolved.uri,
              `${opResolved.pointer}/requestBody`,
              inner,
              emitFor
            ),
            responses: this.compileResponses(
              callbackOperation.responses,
              opResolved.uri,
              `${opResolved.pointer}/responses`,
              inner,
              emitFor
            )
          });
        }
      }
      support.add("approximated", [`callback:${name}`]);
      emitFor(
        capabilityDiagnostic(
          "approximated",
          DiagnosticCode.CapCallbackUnsupported,
          `Callback '${name}' is preserved but never invoked.`,
          callbackResolved.uri,
          callbackResolved.pointer,
          [`callback:${name}`]
        )
      );
      out.push({ name, expressions, source_pointer: callbackResolved.pointer });
    }
    return out;
  }

  /**
   * Compile one response `links` map. ContractIR dedicates no field to
   * links, so every link is preserved as data inside a described-only
   * capability diagnostic, mirroring how callbacks are kept as data with an
   * approximated outcome (acceptance criterion AC-011). Links never cause
   * follow-up requests.
   */
  private compileLinks(
    node: Json | undefined,
    uri: string,
    pointer: string,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void
  ): void {
    if (node === undefined) {
      return;
    }
    if (!isObject(node)) {
      this.fail(structure("`links` must be a mapping.", uri, pointer));
    }
    for (const name of Object.keys(node).sort()) {
      const entry = node[name];
      if (entry === undefined) {
        continue;
      }
      const resolved = this.deref(
        entry,
        uri,
        `${pointer}/${escapeToken(name)}`
      );
      const link = this.requireObject(
        resolved.value,
        resolved.uri,
        resolved.pointer,
        `Link '${name}' must be a mapping.`
      );
      const server = isObject(link.server) ? link.server : null;
      const parameters = isObject(link.parameters) ? link.parameters : null;
      const reasonCode = `link:${name}`;
      support.add("approximated", [reasonCode]);
      emitFor({
        severity: "info",
        phase: "compile",
        code: CAP_LINK_DESCRIBED,
        message: `Link '${name}' is preserved as a description and never followed.`,
        document_uri: resolved.uri,
        json_pointer: resolved.pointer,
        operation_key: null,
        retryable: false,
        related: [],
        details: {
          reason_codes: [reasonCode],
          level: "approximated",
          link: {
            name,
            operation_ref: asString(link.operationRef),
            operation_id: asString(link.operationId),
            description: asString(link.description),
            parameters,
            request_body: link.requestBody ?? null,
            server
          }
        }
      });
    }
  }

  private compileSecurity(
    node: Json | undefined,
    rootSecurity: Json | undefined,
    schemes: Record<string, SecuritySchemeIR>,
    support: SupportAccumulator,
    emitFor: (diagnostic: Diagnostic) => void,
    uri: string,
    pointer: string
  ): OperationIR["security"] {
    const declared = node !== undefined ? node : rootSecurity;
    if (declared === undefined) {
      return { anonymous: true, alternatives: [] };
    }
    if (!Array.isArray(declared)) {
      this.fail(
        structure("`security` must be an array.", uri, `${pointer}/security`)
      );
    }
    const alternatives: NonNullable<OperationIR["security"]>["alternatives"] =
      [];
    let anonymous = false;
    for (const requirement of declared) {
      const schemesOut: Array<{ name: string; scopes: string[] }> = [];
      if (isObject(requirement)) {
        for (const schemeName of Object.keys(requirement).sort()) {
          const scheme = schemes[schemeName];
          if (scheme === undefined) {
            this.fail(
              ingest(
                DiagnosticCode.RefNotFound,
                `Security requirement references an undeclared scheme '${schemeName}'.`,
                uri,
                pointer,
                { scheme: schemeName }
              )
            );
          }
          const scopes = Array.isArray(requirement[schemeName])
            ? (requirement[schemeName] as Json[]).filter(
                (scope): scope is string => typeof scope === "string"
              )
            : [];
          support.add(scheme.support, scheme.support_reason_codes);
          if (scheme.support !== "supported") {
            emitFor(
              capabilityDiagnostic(
                scheme.support,
                DiagnosticCode.CapAuthFlowUnsupported,
                `Security scheme '${schemeName}' is ${scheme.support}.`,
                uri,
                scheme.source_pointer,
                scheme.support_reason_codes
              )
            );
          }
          schemesOut.push({ name: schemeName, scopes: [...scopes].sort() });
        }
      }
      if (schemesOut.length === 0) {
        anonymous = true;
      }
      alternatives.push({ schemes: schemesOut });
    }
    return { anonymous, alternatives };
  }

  // ---- stages 10 and 11 -----------------------------------------------

  private checkAmbiguousRoutes(operations: OperationIR[]): void {
    const byMethod = new Map<string, OperationIR[]>();
    for (const operation of operations) {
      if (operation.surface !== "path") {
        continue;
      }
      const list = byMethod.get(operation.method) ?? [];
      list.push(operation);
      byMethod.set(operation.method, list);
    }
    for (const method of [...byMethod.keys()].sort()) {
      const list = (byMethod.get(method) ?? []).sort(compareOperations);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const left = list[i] as OperationIR;
          const right = list[j] as OperationIR;
          if (left.path_template === right.path_template) {
            continue;
          }
          if (!templatesConflict(left.route_segments, right.route_segments)) {
            continue;
          }
          this.fail(ambiguousRoute(left, right, method, this.entryUri));
        }
      }
    }
  }

  private assignToolNames(
    operations: OperationIR[],
    webhooks: WebhookIR[]
  ): void {
    const candidates = [
      ...operations,
      ...webhooks.flatMap((hook) => hook.operations)
    ].map((operation) => ({
      key: operation.key,
      uid: operation.uid,
      operationId: operation.operation_id
    }));
    const { assignments } = assignToolNames(candidates);
    for (const operation of operations) {
      operation.tool_name =
        assignments.get(operation.key)?.tool_name ?? operation.uid;
    }
    for (const hook of webhooks) {
      for (const operation of hook.operations) {
        operation.tool_name =
          assignments.get(operation.key)?.tool_name ?? operation.uid;
      }
    }
    this.finalizeSupport(operations);
    for (const hook of webhooks) {
      this.finalizeSupport(hook.operations);
    }
  }
}

// ---- diagnostic constructors ------------------------------------------

function ingest(
  code: string,
  message: string,
  uri: string,
  pointer: string,
  details: Json
): Diagnostic {
  return {
    severity: "error",
    phase: "ingest",
    code,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details
  };
}

function structure(message: string, uri: string, pointer: string): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code: DiagnosticCode.OasStructureInvalid,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details: {}
  };
}

function capabilityDiagnostic(
  level: SupportLevel,
  code: string,
  message: string,
  uri: string,
  pointer: string,
  reasonCodes: readonly string[]
): Diagnostic {
  return {
    severity: level === "unsupported" ? "warning" : "info",
    phase: "compile",
    code,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details: { reason_codes: [...reasonCodes].sort(), level }
  };
}

function versionFailure(message: string, uri: string): Diagnostic {
  return ingest(DiagnosticCode.OasVersionUnsupported, message, uri, "#", {});
}

function missingEntrypoint(entrypoint: string): Diagnostic {
  return ingest(
    DiagnosticCode.InputMissing,
    `The entrypoint document is missing: ${entrypoint}.`,
    entrypoint,
    "#",
    { entrypoint }
  );
}

function missingDocument(uri: string): Diagnostic {
  return ingest(
    DiagnosticCode.RefNotFound,
    `A referenced document is missing from the pack: ${uri}.`,
    uri,
    "#",
    { document_uri: uri }
  );
}

function tooLarge(
  uri: string,
  bytes: number,
  limits: CompilerLimits
): Diagnostic {
  return ingest(
    DiagnosticCode.InputTooLarge,
    `The source document exceeds ${limits.maxSourceOpenapiBytes} bytes.`,
    uri,
    "#",
    { bytes, max_source_openapi_bytes: limits.maxSourceOpenapiBytes }
  );
}

function limitReached(count: number, limits: CompilerLimits): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code: DiagnosticCode.LimitReached,
    message: `The document declares more than ${limits.maxOperations} operations.`,
    document_uri: "",
    json_pointer: "#/paths",
    operation_key: null,
    retryable: false,
    related: [],
    details: { operations: count, max_operations: limits.maxOperations }
  };
}

function duplicateParameter(
  parameter: ParameterIR,
  uri: string,
  pointer: string
): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code: DiagnosticCode.DuplicateKey,
    message: `Duplicate parameter '${parameter.name}' in '${parameter.location}'.`,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details: { name: parameter.name, location: parameter.location }
  };
}

function ambiguousRoute(
  left: OperationIR,
  right: OperationIR,
  method: string,
  uri: string
): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code: DiagnosticCode.RouteAmbiguous,
    message: `Templated routes ${left.path_template} and ${right.path_template} are equivalent.`,
    document_uri: uri,
    json_pointer: `#/paths/${escapeToken(left.path_template)}`,
    operation_key: left.key,
    retryable: false,
    related: [
      {
        document_uri: uri,
        json_pointer: `#/paths/${escapeToken(right.path_template)}`
      }
    ],
    details: {
      method,
      templates: [left.path_template, right.path_template].sort()
    }
  };
}

function pathParameterMissing(
  message: string,
  uri: string,
  pointer: string,
  details: Json
): Diagnostic {
  return {
    severity: "error",
    phase: "compile",
    code: DiagnosticCode.PathParameterMissing,
    message,
    document_uri: uri,
    json_pointer: pointer,
    operation_key: null,
    retryable: false,
    related: [],
    details
  };
}

// ---- helpers ----------------------------------------------------------

function yamlCodeOf(code: string): string {
  switch (code) {
    case "duplicate-key":
      return DiagnosticCode.DuplicateKey;
    case "node-limit":
      return DiagnosticCode.YamlNodeLimit;
    case "alias-limit":
      return DiagnosticCode.YamlAliasLimit;
    case "depth-limit":
      return DiagnosticCode.YamlDepthLimit;
    case "size-limit":
      return DiagnosticCode.InputTooLarge;
    default:
      return DiagnosticCode.YamlInvalid;
  }
}

function parsePathTemplateOrFail(
  template: string,
  uri: string,
  pointer: string,
  fail: (diagnostic: Diagnostic) => never
): RouteSegment[] {
  try {
    return parsePathTemplate(template);
  } catch (error) {
    return fail(
      structure(
        error instanceof Error ? error.message : String(error),
        uri,
        pointer
      )
    );
  }
}

function mergeParameters(
  pathParameters: readonly ParameterIR[],
  operationParameters: readonly ParameterIR[]
): ParameterIR[] {
  const merged = new Map<string, ParameterIR>();
  for (const parameter of pathParameters) {
    merged.set(`${parameter.location}:${parameter.name}`, parameter);
  }
  for (const parameter of operationParameters) {
    merged.set(`${parameter.location}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

function checkPathParameters(
  template: string,
  segments: readonly RouteSegment[],
  parameters: readonly ParameterIR[],
  uri: string,
  pointer: string,
  emit: (diagnostic: Diagnostic) => void
): void {
  const declared = new Set(
    parameters
      .filter((parameter) => parameter.location === "path")
      .map((parameter) => parameter.name)
  );
  for (const segment of segments) {
    if (segment.kind !== "parameter" || declared.has(segment.value)) {
      continue;
    }
    emit(
      pathParameterMissing(
        `Path parameter '{${segment.value}}' has no required declaration.`,
        uri,
        pointer,
        { parameter: segment.value, path_template: template }
      )
    );
  }
  for (const name of [...declared].sort()) {
    if (
      !segments.some(
        (segment) => segment.kind === "parameter" && segment.value === name
      )
    ) {
      emit(
        pathParameterMissing(
          `Path parameter '${name}' is declared but not used in the template.`,
          uri,
          `${pointer}/parameters`,
          { parameter: name, path_template: template }
        )
      );
    }
  }
}

function selectorKindOf(selector: string): ResponseSelectorKind {
  if (selector === "default") {
    return "default";
  }
  if (/^[1-5]XX$/.test(selector)) {
    return "range";
  }
  return "exact";
}

/** OpenAPI allows `default`, `[1-5]XX` ranges, and concrete status codes. */
function isResponseSelector(selector: string): boolean {
  return selector === "default" || /^[1-5]([0-9]|X){2}$/.test(selector);
}

function compareOperations(a: OperationIR, b: OperationIR): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function compareResponses(a: ResponseIR, b: ResponseIR): number {
  const rank = (response: ResponseIR): number =>
    response.selector_kind === "exact"
      ? 0
      : response.selector_kind === "range"
        ? 1
        : 2;
  const left = rank(a);
  const right = rank(b);
  if (left !== right) {
    return left - right;
  }
  return a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.code !== b.code) {
    return a.code < b.code ? -1 : 1;
  }
  const left = `${a.document_uri ?? ""}${a.json_pointer ?? ""}`;
  const right = `${b.document_uri ?? ""}${b.json_pointer ?? ""}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Digest projection that excludes source identity and diagnostic wording. */
function semanticProjection(contract: ContractIR): Json {
  return {
    schema_version: contract.schema_version,
    kind: contract.kind,
    api: contract.api,
    security_schemes: contract.security_schemes,
    schemas: contract.schemas,
    operations: contract.operations,
    webhooks: contract.webhooks,
    extensions: contract.extensions
  } as unknown as Json;
}

/** Digest projection over every ordering that changes runtime behavior. */
function executionProjection(contract: ContractIR): Json {
  return {
    security_schemes: contract.security_schemes,
    schemas: contract.schemas,
    operations: contract.operations.map((operation) => ({
      key: operation.key,
      uid: operation.uid,
      tool_name: operation.tool_name,
      method: operation.method,
      path_template: operation.path_template,
      route_segments: operation.route_segments,
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        location: parameter.location,
        style: parameter.style,
        explode: parameter.explode,
        allow_reserved: parameter.allow_reserved,
        required: parameter.required,
        schema_ref: parameter.schema_ref,
        content: parameter.content,
        default_value: parameter.default_value
      })),
      request_body: operation.request_body,
      responses: operation.responses,
      security: operation.security
    }))
  } as unknown as Json;
}

/**
 * Compile a frozen document set into ContractIR plus its capability report.
 * Throws {@link OalError} when any error-severity diagnostic is produced.
 */
export function compileOpenApi(
  input: CompileInput,
  options: CompileOptions = {}
): CompileResult {
  return new OpenApiCompiler(input, options).compile();
}
