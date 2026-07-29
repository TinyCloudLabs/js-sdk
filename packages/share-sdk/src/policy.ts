import type { ShareEnvelopeV2 } from "@tinycloud/share-envelope";
import { authorizeShare, type ShareAuthorizationAdapter, type ShareAuthorizationResult } from "./authorization.js";
import { normalizeShareTarget, type TargetPublishInput, type TargetPublishOutcome, type ShareTarget } from "./targets.js";

export interface SharePolicyPublishAdapter {
  publishPolicy(input: TargetPublishInput & { readonly notify: boolean }): Promise<TargetPublishOutcome>;
  claim(input: {
    readonly envelope: ShareEnvelopeV2;
    readonly method: "email-claim" | "email-otp";
    readonly resumeToken?: string;
    readonly proof?: unknown;
  }): Promise<ShareAuthorizationResult<unknown>>;
}

/** Canonical exact-email/domain publication seam shared by web and CLI. */
export async function publishPolicyShare(input: {
  readonly source: Uint8Array;
  readonly filename: string;
  readonly target: Extract<ShareTarget, { readonly kind: "email" | "emailDomain" }>;
  readonly expiresAt: Date;
  readonly origin: string;
  readonly notify?: boolean;
  readonly adapter: SharePolicyPublishAdapter;
}): Promise<TargetPublishOutcome> {
  const target = normalizeShareTarget(input.target);
  if (target.kind !== "email" && target.kind !== "emailDomain") throw new TypeError("policy publication requires an email target");
  return input.adapter.publishPolicy({
    source: input.source.slice(),
    filename: input.filename,
    target,
    expiresAt: input.expiresAt,
    origin: input.origin,
    notify: input.notify ?? false,
  });
}

/** Claim, OTP, or resume a policy share without exposing mailbox material. */
export async function claimShare(input: {
  readonly envelope: ShareEnvelopeV2;
  readonly adapter: SharePolicyPublishAdapter;
  readonly method?: "email-claim" | "email-otp";
  readonly resumeToken?: string;
  readonly proof?: unknown;
}): Promise<ShareAuthorizationResult<unknown>> {
  return input.adapter.claim({
    envelope: input.envelope,
    method: input.method ?? "email-claim",
    ...(input.resumeToken === undefined ? {} : { resumeToken: input.resumeToken }),
    ...(input.proof === undefined ? {} : { proof: input.proof }),
  });
}

/** Explicit name for noninteractive callers resuming a previously returned step. */
export async function resumeShareAuthorization<T>(input: {
  readonly envelope: ShareEnvelopeV2;
  readonly method: "openkey-device" | "email-claim" | "email-otp";
  readonly resumeToken: string;
  readonly proof?: unknown;
  readonly adapter: ShareAuthorizationAdapter<T>;
}): Promise<ShareAuthorizationResult<T>> {
  return authorizeShare(input);
}
