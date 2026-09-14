export const SHARE_CONTENT_LIMIT = 100 * 1024 * 1024;
export const SHARE_PUBLISH_RESULT_VERSION = 1 as const;
export const DEFAULT_SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type SharePublishTarget =
  | { readonly kind: "bearer" }
  | { readonly kind: "recipientDid"; readonly did: string }
  | { readonly kind: "email"; readonly address: string }
  | { readonly kind: "emailDomain"; readonly domain: string };

/** Input shared by the native bearer and Policy/v3 addressed publishers. */
export interface SharePublishOptions {
  readonly source: Uint8Array | AsyncIterable<Uint8Array>;
  readonly filename: string;
  readonly mediaType?: string;
  readonly allowBinary?: boolean;
  readonly target?: SharePublishTarget;
  readonly expiresAt?: Date;
  readonly origin: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export interface PublishedShareMetadata {
  readonly protocol: "tinycloud-share";
  readonly version: 1;
  readonly shareId: string;
  readonly origin: string;
  readonly target: { readonly kind: "bearer" | "recipientDid" | "email" | "emailDomain"; readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  readonly actions: readonly string[];
  readonly expiresAt: string;
  readonly display: { readonly filename?: string; readonly senderName?: string };
  readonly recipientMatcher?: { readonly kind: "bearer" | "recipientDid" | "exactEmail" | "emailDomain"; readonly value?: string };
  readonly registrationCid?: string;
  readonly policyCid?: string;
  readonly ownerDelegationCid?: string;
  readonly enforcementDelegationCid?: string;
  readonly ownerDid?: string;
  readonly shareKeyDid?: string;
  readonly enforcerDid?: string;
  readonly envelopeCid?: string;
  readonly shareCid?: string;
}

/** Sender-only Policy/v3 material retained in encrypted history for delivery retries. */
export interface PublishedShareDeliveryMaterial {
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly shareCid: string;
}

export interface PublishedShare {
  readonly protocol: "tinycloud-share";
  readonly version: typeof SHARE_PUBLISH_RESULT_VERSION;
  /** The complete link is deliberately non-enumerable on production results. */
  readonly url: string;
  readonly link: { readonly kind: "native" | "policy"; readonly cid: string };
  readonly metadata: PublishedShareMetadata;
  /** Non-enumerable Policy/v3 delivery material; never included in command output. */
  readonly deliveryMaterial?: PublishedShareDeliveryMaterial;
}

/** Machine-readable output omits the complete bearer capability and delivery material. */
export function redactPublishedShare(result: PublishedShare): Omit<PublishedShare, "url" | "deliveryMaterial"> {
  return {
    protocol: "tinycloud-share",
    version: SHARE_PUBLISH_RESULT_VERSION,
    link: { ...result.link },
    metadata: {
      protocol: "tinycloud-share",
      version: 1,
      shareId: result.metadata.shareId,
      origin: result.metadata.origin,
      target: { ...result.metadata.target },
      resource: { ...result.metadata.resource },
      actions: [...result.metadata.actions],
      expiresAt: result.metadata.expiresAt,
      display: { ...result.metadata.display },
    },
  };
}

export type SharePublishErrorCode =
  | "invalid-argument"
  | "authority-required"
  | "max-bytes-exceeded";

export class SharePublishError extends Error {
  readonly code: SharePublishErrorCode;
  constructor(code: SharePublishErrorCode, message: string) {
    super(message);
    this.name = "SharePublishError";
    this.code = code;
  }
}
