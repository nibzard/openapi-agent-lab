/** One digested artifact of the release candidate. */
export interface CandidateArtifact {
  readonly path: string;
  readonly sha256: string;
}

/** The manifest written beside the candidate artifacts. */
export interface ReleaseCandidateManifest {
  readonly schema_version: number;
  readonly kind: "ReleaseCandidateManifest";
  readonly built_at: string;
  readonly tool_version: string;
  readonly archives: readonly string[];
  readonly units: number;
  readonly artifacts: readonly CandidateArtifact[];
  readonly notes: readonly string[];
}

/** Assemble the release candidate below one output directory. */
export declare function buildReleaseCandidate(outDir: string): Promise<{
  readonly outDir: string;
  readonly manifest: ReleaseCandidateManifest;
}>;
