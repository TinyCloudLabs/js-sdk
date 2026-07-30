import type { SenderShareRecord } from "./history.js";

export type ShareNotifyState = "delivered" | "already-delivered" | "partial-failure";

export interface ShareNotifyResult {
  readonly protocol: "tinycloud-share";
  readonly version: 1;
  readonly shareId: string;
  readonly state: ShareNotifyState;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly retryable?: boolean;
}

export interface ShareNotifyInput {
  readonly shareId: string;
  readonly recipient: string;
  readonly record?: SenderShareRecord;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ShareDeliveryAdapter {
  /** The server must deduplicate this key before any message is sent. */
  deliver(input: ShareNotifyInput): Promise<"delivered" | "already-delivered">;
}

export class ShareNotifyError extends Error {
  readonly code = "delivery-failed" as const;
  constructor(message = "share delivery did not complete") {
    super(message);
    this.name = "ShareNotifyError";
  }
}

/**
 * Delivery is deliberately separate from publication. A failed notification
 * never causes a second envelope or link to be minted.
 */
export async function notifyShare(input: {
  readonly shareId: string;
  readonly recipient: string;
  readonly record?: SenderShareRecord;
  readonly adapter: ShareDeliveryAdapter;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}): Promise<ShareNotifyResult> {
  if (!input.shareId || !input.recipient || !input.recipient.includes("@")) throw new ShareNotifyError("recipient is invalid");
  const idempotencyKey = input.idempotencyKey ?? `tinycloud-share:${input.shareId}`;
  const attemptsLimit = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attemptsLimit) || attemptsLimit < 1 || attemptsLimit > 8) throw new ShareNotifyError("maxAttempts is invalid");
  let attempts = 0;
  let lastError: unknown;
  while (attempts < attemptsLimit) {
    if (input.signal?.aborted) throw new ShareNotifyError("share delivery was cancelled");
    attempts += 1;
    try {
      const state = await input.adapter.deliver({ shareId: input.shareId, recipient: input.recipient, idempotencyKey, ...(input.record === undefined ? {} : { record: input.record }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return { protocol: "tinycloud-share", version: 1, shareId: input.shareId, state, idempotencyKey, attempts };
    } catch (error) {
      lastError = error;
    }
  }
  void lastError;
  return { protocol: "tinycloud-share", version: 1, shareId: input.shareId, state: "partial-failure", idempotencyKey, attempts, retryable: true };
}
