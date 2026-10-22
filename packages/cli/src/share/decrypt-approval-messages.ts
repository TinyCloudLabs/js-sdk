/**
 * User-facing text for the one-hour share decrypt approval. Kept apart from
 * decrypt-approval.ts so the share command renderer does not load the device
 * login graph. The wording is not approved yet; every string for this step is here.
 */
export const DECRYPT_APPROVAL_MESSAGES = {
  reason: "Approve about one hour of decrypt access so this share can be sent.",
  notCompleted: "The decrypt approval wasn't completed; nothing was sent.",
} as const;
