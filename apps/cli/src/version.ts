/**
 * CLI identity. The version is a compile-time constant so the binary never
 * reads package.json at runtime.
 */
export const CLI_NAME = "oal";

export const VERSION = "0.1.0";

export function versionLine(): string {
  return `${CLI_NAME} ${VERSION}`;
}
