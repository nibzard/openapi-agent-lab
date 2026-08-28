/**
 * Safe YAML parsing for OpenAPI documents.
 *
 * The canonical implementation lives in `@oal/core`; this module re-exports
 * the public surface unchanged so existing imports keep working.
 */

export {
  parseSafeYaml,
  SafeYamlError,
  type SafeYamlErrorCode,
  type SafeYamlOptions
} from "@oal/core";
