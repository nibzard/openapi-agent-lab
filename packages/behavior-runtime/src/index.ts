export const packageName = "@oal/behavior-runtime";

export {
  clockAdapter,
  fileBlobStore,
  idsAdapter,
  randomAdapter
} from "./adapters.ts";
export {
  decodeBody,
  encodeBody,
  parseLine,
  IPC_PROTOCOL_VERSION,
  DEFAULT_MAX_MESSAGE_BYTES,
  type ChildReply,
  type HostMessage,
  type WireBehaviorRequest,
  type WireBehaviorResult,
  type WireBody,
  type WireHandleContext,
  type WireInitializeContext,
  type WireMultipartPart
} from "./ipc.ts";
export { runBehaviorChild, type ChildOptions } from "./child.ts";
export { BehaviorModuleHost, type BehaviorHostOptions } from "./host.ts";
