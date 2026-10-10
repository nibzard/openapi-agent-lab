/** Refusal codes of the archive compatibility checks. */
export declare const ArchiveCode: {
  readonly DynamicImport: "OAL-ARCHIVE-DYNAMIC-IMPORT";
  readonly EscapingImport: "OAL-ARCHIVE-ESCAPING-IMPORT";
  readonly ExternalImport: "OAL-ARCHIVE-EXTERNAL-IMPORT";
  readonly SubpathImport: "OAL-ARCHIVE-SUBPATH-IMPORT";
  readonly UnresolvedImport: "OAL-ARCHIVE-UNRESOLVED-IMPORT";
  readonly MissingEntry: "OAL-ARCHIVE-MISSING-ENTRY";
};

/** One archive unit: a workspace package or the CLI application. */
export interface ArchiveUnit {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly isCli: boolean;
}

/** A refusal raised by the archive compatibility checks. */
export declare class ArchiveBuildError extends Error {
  readonly code: string;
  readonly sourcePath: string;
  constructor(code: string, sourcePath: string, message: string);
}

/** Every static import specifier of one module source. */
export declare function staticImportsOf(source: string): string[];

/** The dynamic import and require call sites of one source. */
export declare function dynamicCallsOf(source: string): string[];

/**
 * Classify one import of one archived source. Throws an
 * {@link ArchiveBuildError} when the import is not a relative path
 * inside its unit, a node builtin, or the public name of an archived
 * package.
 */
export declare function checkImport(
  specifier: string,
  unit: ArchiveUnit,
  fromFile: string,
  srcRoot: string,
  archivedNames: ReadonlySet<string>
): void;

/** The transitive archive units, starting from the CLI. */
export declare function archiveUnits(): Promise<ArchiveUnit[]>;

/** Transpile one source into JavaScript with `.js` specifiers. */
export declare function compileSource(source: string): string;

/** Build every archive below one output directory. */
export declare function buildArchives(outDir: string): Promise<{
  readonly units: readonly ArchiveUnit[];
  readonly staged: readonly string[];
  readonly tarballs: readonly string[];
}>;
