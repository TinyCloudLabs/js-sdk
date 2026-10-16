export {
  assertGateAccess,
  clearGateIntent,
  denyGate,
  deferredGateToken,
  establishSessionStamp,
  identityHashOf,
  grantInstallHashOf,
  principalHashOf,
  readFirstInstall,
  resumeDeferredGate,
  readGateSnapshot,
  recordFirstInstall,
  recordGrantInstall,
  restoreSessionStamp,
} from "./gateFile.js";
export type { DeferredEraseToken } from "./gateFile.js";
