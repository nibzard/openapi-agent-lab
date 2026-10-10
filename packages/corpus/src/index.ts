export const packageName = "@oal/corpus";

export {
  runCorpus,
  type AssertionRecord,
  type AttemptRecord,
  type BindingRecord,
  type CaseRecord,
  type CorpusReport,
  type ExchangeRecord,
  type ReportDiagnostic,
  type RunCorpusOptions,
  type StepRecord
} from "./engine.ts";
export {
  type CorpusOperatorCommand,
  type CorpusTarget,
  type CorpusTargetCapabilities,
  type CorpusTargetRequest,
  type CorpusTargetResponse
} from "./target.ts";

export {
  GITHUB_API_VERSION,
  GithubTarget,
  GithubTargetError
} from "./github.ts";
export type {
  CleanupLedgerEntry,
  CleanupResult,
  GithubTargetOptions
} from "./github.ts";
