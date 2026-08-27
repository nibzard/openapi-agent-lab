export const packageName = "@oal/evidence";

export {
  Redactor,
  DEFAULT_KEY_PATTERNS,
  type RedactedValue,
  type RedactionConfig,
  type RedactorOptions
} from "./redaction.ts";
export {
  EventStream,
  JsonlSink,
  asJsonObject,
  captureBody,
  redactPath,
  traceHeaders,
  traceQuery,
  type BodyCaptureLimits,
  type BlobPutTarget,
  type CaptureBodyInput,
  type TraceBody,
  type TraceError,
  type TraceEvent,
  type TraceHeader,
  type TraceOperation,
  type TraceQueryParameter,
  type TraceValidationOutcome
} from "./trace.ts";
export {
  SemanticEventStream,
  documentationStream,
  type DocumentationExchange,
  type SemanticEvent
} from "./streams.ts";
export {
  ArtifactStore,
  EVIDENCE_COMPONENT,
  EVIDENCE_VERSION,
  MANIFEST_NAME,
  type ArtifactManifest,
  type BatchLayout,
  type ManifestEntry,
  type TrialLayout,
  type VerificationResult
} from "./artifacts.ts";
