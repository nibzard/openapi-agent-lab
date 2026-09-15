/**
 * In-process mock agent adapter (specification section 21).
 */

export const packageName = "@oal/mock-adapter";

export {
  DEFAULT_MOCK_ADAPTER_ID,
  DEFAULT_MOCK_CAPABILITIES,
  MOCK_ADAPTER_VERSION,
  MOCK_CAPTURE_FAILED,
  MOCK_HTTP_REQUEST_FAILED,
  MOCK_HTTP_STATUS_MISMATCH,
  MOCK_SCRIPT_INVALID,
  MOCK_TEMPLATE_UNRESOLVED,
  validateScriptTemplates
} from "./script.ts";
export type {
  MockAgentConfig,
  MockAgentScript,
  MockEventSpec,
  MockFileSpec,
  MockRequestSpec
} from "./script.ts";

export { isWorkspaceRelative, validateMockScript } from "./validate.ts";

export { MockAgentAdapter } from "./adapter.ts";
export type { MockPreparedAgent } from "./adapter.ts";
