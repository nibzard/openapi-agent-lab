/**
 * Stable diagnostic codes produced by the Arazzo parser, compiler, and trace
 * aligner (specification section 20.2). Codes are stable API; wording is not.
 *
 * The version code carries the name given by the specification text. Every
 * other code stays in the same `ARZZO-*` namespace so one subsystem owns one
 * prefix.
 */
export const ArazzoCode = {
  /** The document declares an Arazzo version outside the supported 1.1.x line. */
  VersionUnsupported: "ARZZO-VERSION-UNSUPPORTED",
  /** A required field is absent, has the wrong JSON type, or conflicts. */
  StructureInvalid: "ARZZO-STRUCTURE-INVALID",
  /** The document exceeds the configured byte limit. */
  SizeLimit: "ARZZO-SIZE-LIMIT",
  /** The document exceeds the configured materialized node limit. */
  NodeLimit: "ARZZO-NODE-LIMIT",
  /** The document exceeds the configured nesting depth limit. */
  DepthLimit: "ARZZO-DEPTH-LIMIT",
  /** The YAML subset parser rejected a construct it does not own. */
  YamlUnsupported: "ARZZO-YAML-UNSUPPORTED",
  /** The JSON document is not valid JSON. */
  JsonInvalid: "ARZZO-JSON-INVALID",
  /** The same mapping key appears twice in one document. */
  DuplicateKey: "ARZZO-DUPLICATE-KEY",
  /** Two workflows or two steps in one workflow share one ID. */
  IdDuplicate: "ARZZO-ID-DUPLICATE",
  /** A workflow, step, or output ID fails the safe identifier grammar. */
  IdUnsafe: "ARZZO-ID-UNSAFE",
  /** A step depends on a step ID that the workflow does not declare. */
  DependencyUnknown: "ARZZO-DEPENDENCY-UNKNOWN",
  /** Step dependencies form a cycle. */
  DependencyCycle: "ARZZO-DEPENDENCY-CYCLE",
  /** A dependency reference uses an unsupported cross-workflow form. */
  DependencyUnsupported: "ARZZO-DEPENDENCY-UNSUPPORTED",
  /** A source description name is not declared by the document. */
  SourceUnknown: "ARZZO-SOURCE-UNKNOWN",
  /** A source description names a description type this compiler cannot use. */
  SourceTypeUnsupported: "ARZZO-SOURCE-TYPE-UNSUPPORTED",
  /** An operation reference resolves to no contract operation. */
  OperationUnresolved: "ARZZO-OPERATION-UNRESOLVED",
  /** An operation reference matches more than one contract operation. */
  OperationAmbiguous: "ARZZO-OPERATION-AMBIGUOUS",
  /** A step targets a channel or a nested workflow, not an operation. */
  StepTargetUnsupported: "ARZZO-STEP-TARGET-UNSUPPORTED",
  /** A reusable object, selector, payload replacement, or action is outside
   * the supported subset. */
  FeatureUnsupported: "ARZZO-FEATURE-UNSUPPORTED",
  /** A mapped parameter name is not declared for the resolved operation. */
  ParameterUnknown: "ARZZO-PARAMETER-UNKNOWN",
  /** A request body media type is not declared for the resolved operation. */
  MediaTypeUnsupported: "ARZZO-MEDIA-TYPE-UNSUPPORTED",
  /** The resolved operation declares no request body. */
  RequestBodyUnsupported: "ARZZO-REQUEST-BODY-UNSUPPORTED",
  /** An output name or output expression is invalid. */
  OutputInvalid: "ARZZO-OUTPUT-INVALID",
  /** A runtime expression names a source outside the supported subset. */
  ExpressionUnsupported: "ARZZO-EXPRESSION-UNSUPPORTED",
  /** A runtime expression or criterion does not parse. */
  ExpressionInvalid: "ARZZO-EXPRESSION-INVALID",
  /** An expression exceeds the configured length limit. */
  ExpressionLength: "ARZZO-EXPRESSION-LENGTH",
  /** An expression exceeds the configured nesting depth limit. */
  ExpressionDepth: "ARZZO-EXPRESSION-DEPTH",
  /** An evaluation exceeded the configured step budget. */
  ExpressionSteps: "ARZZO-EXPRESSION-STEPS",
  /** A criterion reads a step that this step does not depend on. */
  StepUnordered: "ARZZO-STEP-UNORDERED",
  /** The trace search stopped at its candidate budget. */
  AlignmentCandidateLimit: "ARZZO-ALIGNMENT-CANDIDATE-LIMIT"
} as const;

export type ArazzoCodeValue = (typeof ArazzoCode)[keyof typeof ArazzoCode];
