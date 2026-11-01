import { ExitCode } from "../config/constants.js";
import { CLIError, type ApprovalPending } from "../output/errors.js";

/** The longest `--timeout` wait, as for `secrets wait --timeout`: 9 minutes. */
export const MAX_APPROVAL_TIMEOUT_MS = 9 * 60_000;
/** Between two checks for the owner's approval. */
export const APPROVAL_POLL_INTERVAL_MS = 2_000;
/**
 * Once the owner has approved, collecting the result may run this long past the
 * deadline before the command gives up. The result is saved locally either way.
 */
export const APPROVAL_COLLECT_GRACE_MS = 30_000;

const APPROVAL_TIMEOUT = /^(\d+)([sm])$/;

/** `--timeout D` for an approval wait: `Ns` or `Nm`, more than zero, at most 9 minutes; in milliseconds. */
export function parseApprovalTimeout(value: string): number {
  const match = APPROVAL_TIMEOUT.exec(value);
  if (!match && value !== "0") {
    throw new CLIError("INVALID_TIMEOUT", `Invalid --timeout ${JSON.stringify(value)}: use Ns or Nm (for example 60s or 5m), at most 9m.`, ExitCode.USAGE_ERROR);
  }
  const ms = match ? Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000) : 0;
  if (ms === 0) {
    throw new CLIError("INVALID_TIMEOUT", `Invalid --timeout ${JSON.stringify(value)}: the wait must be longer than zero. Use Ns or Nm (for example 60s or 5m), at most 9m, or leave --timeout off to wait until the approval is answered.`, ExitCode.USAGE_ERROR);
  }
  if (ms > MAX_APPROVAL_TIMEOUT_MS) {
    throw new CLIError("INVALID_TIMEOUT", `--timeout may be at most 9m. Use a shorter wait (for example 60s); when the command exits with code 8 the approval is still pending, so run it again to keep waiting.`, ExitCode.USAGE_ERROR);
  }
  return ms;
}

/**
 * Bounds one command's wait for an OpenKey approval. `deadlineMs` is absolute and shared by every
 * approval the command asks for; `step` of `of` says which approval this is.
 */
export interface ApprovalWait {
  readonly deadlineMs: number;
  readonly step: number;
  readonly of: number;
  /** Test seams: the clock and the sleep between two checks. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: the grace after the deadline for collecting an approval the owner already gave. */
  readonly graceMs?: number;
}

/** The longest one request waits for OpenKey. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A request that starts at the limit still gets this long to answer. */
const MIN_REQUEST_TIMEOUT_MS = 1_000;

/** When the command must be done with OpenKey: the deadline, plus the grace once the owner has approved. */
export function approvalLimitMs(wait: ApprovalWait, approved: boolean): number {
  return wait.deadlineMs + (approved ? wait.graceMs ?? APPROVAL_COLLECT_GRACE_MS : 0);
}

/**
 * How long one request to OpenKey may take. Without a deadline: 10 s as always. With one, never past its limit
 * (by more than the minimum a request needs to answer), so the whole command is bounded by the timeout plus the
 * grace, not by timeout plus the grace plus a slow request.
 */
export function approvalRequestTimeoutMs(wait: ApprovalWait | undefined, approved: boolean): number {
  if (!wait) return REQUEST_TIMEOUT_MS;
  const left = approvalLimitMs(wait, approved) - (wait.now ?? Date.now)();
  return Math.min(REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, left));
}

/** Exit 8 with `{"pending":{...}}` on stdout. It is the approval only; OpenKey being unavailable has its own errors. */
export function approvalPendingError(pending: ApprovalPending): CLIError {
  return new CLIError(
    "APPROVAL_PENDING",
    `Still waiting for the owner to approve in OpenKey. Run the same command again to keep waiting; the link stays valid until ${pending.expiresAt}.`,
    ExitCode.PENDING,
    { pending },
  );
}

export const APPROVAL_TIMEOUT_OPTION_DESCRIPTION =
  `Wait at most this long for the owner's OpenKey approval (Ns or Nm, more than 0, at most 9m; for example 60s). Exits 8 with {"pending":{"step","of","approvalUrl","expiresAt"}} on stdout as soon as a new approval link exists, and again if the wait ends while the approval is still pending: that is not a failure, so send the owner the link and run the same command again. An approval already given is still collected after the timeout, for at most 30 s more (plus creating the next link in onboard). Without it the command waits until the approval is answered.`;
