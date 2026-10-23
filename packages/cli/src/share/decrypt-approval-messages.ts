/**
 * User-facing text for the share decrypt approval. Kept apart from
 * decrypt-approval.ts so the share command renderer does not load the device
 * login graph. DRAFT wording, not yet approved; every string for this step is here.
 */
export const DECRYPT_APPROVAL_MESSAGES = {
  reason: "Approve decrypt access to everything encrypted with your default key, including your Secrets, until this sign-in ends, so this share can be sent.",
  notice: "This addressed share needs decrypt access to your default key until this sign-in ends.",
  notCompleted: "The decrypt approval wasn't completed; nothing was sent.",
  ownerUnpinned: "This profile records no owner, so decrypt cannot be approved for it. No request was sent and nothing was stored.",
  sessionUnusable: "This sign-in has no readable end time, or ends within a minute, so decrypt cannot be approved for it. Sign in again. No request was sent and nothing was stored.",
} as const;
