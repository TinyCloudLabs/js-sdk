import type { ShareEnvelopeV2 } from "@tinycloud/share-envelope";

/** The only interactive boundary exposed by the headless SDK. */
export type ShareAuthorizationMethod = "openkey-device" | "email-claim" | "email-otp";

export interface ShareAuthorizationRequired {
  readonly state: "authorization-required";
  readonly method: ShareAuthorizationMethod;
  /** A browser-safe continuation location. It must never contain a claim secret. */
  readonly continueUrl?: string;
  /** An opaque, short-lived, nonce-bound handle. It is not a bearer credential. */
  readonly resumeToken?: string;
}

export interface ShareAuthorizationDenied {
  readonly state: "denied";
  readonly reason: "rejected" | "expired" | "revoked" | "unsupported";
}

export interface ShareAuthorizationReady<T> {
  readonly state: "ready";
  readonly value: T;
}

export type ShareAuthorizationResult<T> = ShareAuthorizationReady<T> | ShareAuthorizationRequired | ShareAuthorizationDenied;

export interface ShareAuthorizationAdapter<T> {
  begin(input: {
    readonly envelope: ShareEnvelopeV2;
    readonly method: ShareAuthorizationMethod;
  }): Promise<ShareAuthorizationResult<T>>;
  resume(input: {
    readonly envelope: ShareEnvelopeV2;
    readonly method: ShareAuthorizationMethod;
    readonly resumeToken: string;
    readonly proof?: unknown;
  }): Promise<ShareAuthorizationResult<T>>;
}

/**
 * Start or continue a target authorization without ever guessing a device,
 * claim, or delegation secret. Adapters own their protocol and are expected
 * to bind their resume token to a server challenge and expiry.
 */
export async function authorizeShare<T>(
  input: {
    readonly envelope: ShareEnvelopeV2;
    readonly method: ShareAuthorizationMethod;
    readonly adapter: ShareAuthorizationAdapter<T>;
    readonly resumeToken?: string;
    readonly proof?: unknown;
  },
): Promise<ShareAuthorizationResult<T>> {
  if (input.resumeToken !== undefined) {
    if (input.resumeToken.length < 16 || input.resumeToken.length > 512) {
      return { state: "denied", reason: "rejected" };
    }
    return input.adapter.resume({
      envelope: input.envelope,
      method: input.method,
      resumeToken: input.resumeToken,
      ...(input.proof === undefined ? {} : { proof: input.proof }),
    });
  }
  return input.adapter.begin({ envelope: input.envelope, method: input.method });
}

export function authorizationMethodForTarget(target: { readonly kind: string }): ShareAuthorizationMethod | undefined {
  if (target.kind === "recipientDid") return "openkey-device";
  if (target.kind === "email") return "email-claim";
  if (target.kind === "emailDomain") return "email-claim";
  return undefined;
}
