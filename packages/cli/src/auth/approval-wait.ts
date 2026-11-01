import { CLI_NAME } from "@tinycloud/operations/cli-name";
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
    throw new CLIError("INVALID_TIMEOUT", `Invalid --timeout ${JSON.stringify(value)}: use Ns or Nm (for example 90s or 5m), at most 9m.`, ExitCode.USAGE_ERROR);
  }
  const ms = match ? Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000) : 0;
  if (ms === 0) {
    throw new CLIError("INVALID_TIMEOUT", `Invalid --timeout ${JSON.stringify(value)}: the wait must be longer than zero. Use Ns or Nm (for example 90s or 5m), at most 9m, or leave --timeout off to wait until the approval is answered.`, ExitCode.USAGE_ERROR);
  }
  if (ms > MAX_APPROVAL_TIMEOUT_MS) {
    throw new CLIError("INVALID_TIMEOUT", `--timeout may be at most 9m. Use a shorter wait (for example 90s); when the command exits with code 8 the approval is still pending, so run it again to keep waiting.`, ExitCode.USAGE_ERROR);
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
  `Wait at most this long for the owner's OpenKey approval (Ns or Nm, more than 0, at most 9m; for example 90s). Exits 8 with {"pending":{"step","of","approvalUrl","expiresAt"}} on stdout as soon as a new approval link exists, and again if the wait ends while the approval is still pending; run the same command again to keep waiting. Without it the command waits until the approval is answered.`;

export const APPROVAL_TIMEOUT_EXAMPLE = `${CLI_NAME} onboard --timeout 90s`;
