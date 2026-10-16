export {
  assertGateAccess,
  clearGateIntent,
  denyGate,
  deferredGateToken,
  establishSessionStamp,
  identityHashOf,
  principalHashOf,
  readFirstInstall,
  resumeDeferredGate,
  readGateSnapshot,
  recordFirstInstall,
  restoreSessionStamp,
} from "./gateFile.js";
export type { DeferredEraseToken } from "./gateFile.js";
