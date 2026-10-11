export type Backend = "sqlite" | "pg16" | "pg16-c";
export type Tier = "core" | "edge" | "speed" | "tc12";
export type ClientKind = "cli" | "sdk";
export type GateId = "tc858-phase1-workspace" | "tc858-phase1-beta";
export type SetId = "phase1-companion";
export type Unit = "ms" | "bytes" | "count" | "ops/s";

export type HarnessErrorCode =
  | "TOPOLOGY_INVALID" | "DOCKER_FAILED" | "READINESS_TIMEOUT" | "IMAGE_RESOLVE_FAILED" | "SUT_RESOLVE_FAILED"
  | "INPUTS_MISMATCH" | "CLIENT_UNSUPPORTED_OPTION" | "CLIENT_CRASHED" | "RPC_PROTOCOL" | "RPC_TIMEOUT"
  | "DEADLINE_EXCEEDED" | "ABORTED" | "TEARDOWN_FAILED" | "PREFLIGHT_FAILED" | "NOT_IMPLEMENTED";

export class HarnessError extends Error {
  constructor(readonly code: HarnessErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "HarnessError";
  }
}

/** Every awaited harness operation takes these. Both are optional; whichever fires first wins.
 * deadlineMs is relative to the call. On expiry the op rejects with HarnessError("DEADLINE_EXCEEDED");
 * on abort, HarnessError("ABORTED", signal.reason). */
export interface CallOptions { signal?: AbortSignal; deadlineMs?: number }
