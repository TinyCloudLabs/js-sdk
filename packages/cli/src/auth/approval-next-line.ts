import type { ApprovalPending } from "../output/errors.js";

/**
 * SEAM for TC-2360: the agent-directed `Next:` line. It is printed on stderr, as the LAST line, with exit 8 (a pending approval
 * whose link was just handed out, or still waits) and with the link the CLI itself prints; never with another exit number. TC-2360
 * (js-sdk #834) owns the wording in `auth/next-line.ts`; when it lands this function delegates to it and the call sites stay as they are.
 */
export function approvalNextLine(pending: ApprovalPending): string {
  return `Next: send the owner this link, then run the same command again to keep waiting (it stays valid until ${pending.expiresAt}): ${pending.approvalUrl}`;
}
