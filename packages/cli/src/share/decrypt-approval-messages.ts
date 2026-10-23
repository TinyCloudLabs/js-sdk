/**
 * User-facing text for the share decrypt approval. Kept apart from
 * decrypt-approval.ts so the share command renderer does not load the device
 * login graph. `reason` is the approved owner prompt; the other strings are DRAFT. Every string for this step is here.
 */
export const DECRYPT_APPROVAL_MESSAGES = {
  reason: "To send this share, approve decrypt access to everything encrypted with your default key, including your Secrets, until this sign-in ends.",
  notice: "This addressed share needs decrypt access to your default key until this sign-in ends.",
  notCompleted: "The decrypt approval wasn't completed; nothing was sent.",
  ownerUnpinned: "This profile records no owner, so decrypt cannot be approved for it. No request was sent and nothing was stored.",
  sessionUnusable: "This sign-in has no readable end time, or ends too soon to approve decrypt for it. Sign in again. No request was sent and nothing was stored.",
} as const;
