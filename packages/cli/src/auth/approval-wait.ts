import { ExitCode } from "../config/constants.js";
import { COLLECT_GRACE_MS } from "@tinycloud/share-envelope/links";
import { CLIError } from "../output/errors.js";

/** The longest `--timeout` wait, as for `secrets wait --timeout`: 9 minutes. */
export const MAX_APPROVAL_TIMEOUT_MS = 9 * 60_000;
/**
 * Once the owner has approved, collecting the result may run this long past the deadline before the command gives up. The result is
 * saved locally either way. It is the requester machine's constant: the CLI has no second one.
 */
export const APPROVAL_COLLECT_GRACE_MS = COLLECT_GRACE_MS;

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
}

/** When the command must be done with OpenKey: the deadline, plus the machine's collect grace once the owner has approved. */
export function approvalLimitMs(wait: ApprovalWait, approved: boolean): number {
  return wait.deadlineMs + (approved ? COLLECT_GRACE_MS : 0);
}

/** The least `onboard --timeout` leaves for OpenKey to host a new account's space: enough for a first probe or two. */
const MIN_SPACE_SETUP_MS = 15_000;

/**
 * How long `onboard --timeout` lets a new account's space setup run after step 1 was approved: what is left of the
 * timeout plus the grace, never less than 15 s. Unbounded `onboard` waits 150 s there.
 */
export function spaceSetupTimeoutMs(wait: ApprovalWait): number {
  return Math.max(MIN_SPACE_SETUP_MS, approvalLimitMs(wait, true) - (wait.now ?? Date.now)());
}

export const APPROVAL_TIMEOUT_OPTION_DESCRIPTION =
  `Wait at most this long for the owner's OpenKey approval (Ns or Nm, more than 0, at most 9m; for example 60s). Exits 8 with {"pending":{"step","of","approvalUrl","expiresAt"}} on stdout as soon as a new approval link exists, and again if the wait ends while the approval is still pending: that is not a failure, so send the owner the link and run the same command again. A link that expired ends as exit 3 and its saved request is dropped once OpenKey says it is expired (or 11 minutes after its expiry); until then the next run asks OpenKey once more, so exit 3 can repeat once before a new request is made. An approval already given is still collected after the timeout, for at most 30 s more (plus up to 3 s, and in onboard the next link). On a new account onboard also waits for OpenKey to host the space, for the time left of timeout + 30 s grace (at least 15 s; about 90 s in all for 60s, at worst a little under 2 minutes); if it is not ready, exit 1 SPACE_SETUP_PENDING: wait a minute and run it again (the re-run continues with step 2; if a storage command later says Space not found, wait and retry). Without it the command waits until the approval is answered.`;
