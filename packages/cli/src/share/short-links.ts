import {
  DEFAULT_LINKS_API_ORIGIN,
  LINK_MIN_LIFE_SECONDS,
  LINK_TYPE_SPECS,
  LinkError,
  createLink,
  deleteLink,
  openLinkRecord,
  parseLink,
  type LinkSigner,
} from "@tinycloud/share-envelope/links";
import { fromBase64Url } from "@tinycloud/share-envelope";
import type { PublishedShare } from "@tinycloud/share-sdk";

/**
 * Links for addressed shares (TC-1737). A share of 120 seconds to 30 days gets a
 * short `v=4` link: the links API stores the sealed envelope and a header the
 * publishing key signs, and the content key stays in the link's fragment, so
 * the API never receives anything that decrypts the share. Any other share, or
 * a share the API cannot take, gets the full link, which carries the signed
 * record itself.
 *
 * Sender history keeps the link text a share printed, so the id of a short
 * link can be read back for `tc share unlink`.
 */

/** The longest life of a stored share link, in seconds. */
export const SHORT_LINK_MAX_LIFE_SECONDS = LINK_TYPE_SPECS.share.maxLifeSeconds;

export const LINK_EXPIRY_WARNING_URL = "https://tinycloud.xyz/delegations?from=link-expiry";
/** Printed (and returned as `linkNotice`) when a share lasts longer than a short link can. */
export const LINK_EXPIRY_WARNING = `This share lasts longer than 30 days, so it is sent as a full link instead of a short one. The full link is long. Learn how permissions work: ${LINK_EXPIRY_WARNING_URL}`;

export type LinkForm = "short" | "full";

/** Which link a share of this life gets, and whether the sender is told why it is the full link. */
export function linkFormForLifetime(lifetimeSeconds: number): { readonly form: LinkForm; readonly warning: boolean } {
  if (lifetimeSeconds < LINK_MIN_LIFE_SECONDS) return { form: "full", warning: false };
  if (lifetimeSeconds <= SHORT_LINK_MAX_LIFE_SECONDS) return { form: "short", warning: false };
  return { form: "full", warning: true };
}

/** Why the links service could not provide or delete a link, in words for the sender; nothing the service sent is echoed. */
export function linkFailureReason(error: unknown, action: "create" | "delete"): string {
  const otherwise = `the link could not be ${action === "create" ? "created" : "deleted"}`;
  if (!(error instanceof LinkError)) return otherwise;
  if (error.code === "service_unavailable") return "the links service could not be reached";
  if (error.code === "invalid_response" || error.code === "response_too_large") return "the links service answered incorrectly";
  if (error.code === "service_refused") {
    if (error.serviceError === "rate_limited") return "the links service is rate limiting this client";
    if (error.serviceError === "capacity") return "the links service is at capacity";
    return action === "create" ? "the links service refused this share" : "the links service refused the request";
  }
  return otherwise;
}

export function shortLinkFallbackNotice(error: unknown): string {
  return `Warning: no short link (${linkFailureReason(error, "create")}); printing the full link instead. It works, but it is long and some mail clients may break it.`;
}

/** The link a published share hands out, and the notice (printed to stderr, and `linkNotice` in JSON) that goes with it, if any. */
export interface ShownLink {
  readonly url: string;
  /** Whether `url` is a stored short link. */
  readonly short: boolean;
  readonly notice?: string;
}

export interface ShareLinks {
  /**
   * The link to hand out for a just-published share. Never throws because of the links service: the share
   * exists, so a service failure gives the full link and a notice.
   */
  show(published: PublishedShare, options: { readonly fullLink: boolean; readonly now?: Date }): Promise<ShownLink>;
  /** Delete a short link now, signed by the publishing key. The share itself is not revoked. */
  unlink(id: string): Promise<"deleted" | "absent">;
}

/**
 * The id of a recorded short link, or `undefined` when the recorded link is not a short `v=4` link (a full link,
 * a link from an older CLI, or no link).
 */
export function shortLinkId(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  try {
    const parsed = parseLink(link, { trustedOrigins: [new URL(link).origin] });
    return parsed.form === "short" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

export function createShareLinks(input: {
  /** The publishing profile's signer: its Ed25519 `did:key` is the header's issuer, and the key that signed the envelope. */
  readonly signer: () => Promise<LinkSigner>;
  readonly fetchFn?: typeof fetch;
  readonly apiOrigin?: string;
  /** Per-request limit for the links API, body included. */
  readonly timeoutMs?: number;
}): ShareLinks {
  const apiOrigin = input.apiOrigin ?? DEFAULT_LINKS_API_ORIGIN;
  const transport = {
    ...(input.fetchFn === undefined ? {} : { fetch: input.fetchFn }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  return {
    async show(published, options) {
      const material = published.deliveryMaterial;
      if (published.link.kind !== "policy") return { url: published.url, short: false };
      if (options.fullLink) return { url: published.url, short: false };
      const now = options.now ?? new Date();
      const expiresAt = new Date(published.metadata.expiresAt);
      const choice = linkFormForLifetime((expiresAt.getTime() - now.getTime()) / 1000);
      if (choice.form === "full") return { url: published.url, short: false, ...(choice.warning ? { notice: LINK_EXPIRY_WARNING } : {}) };
      try {
        const issuerKey = await input.signer();
        let sealed: { blob: Uint8Array; key: Uint8Array };
        if (material !== undefined) {
          sealed = { blob: fromBase64Url(material.sealedEnvelope), key: fromBase64Url(material.envelopeKey) };
        } else {
          // A full policy link carries the same sealed body and key when the publish result has no separate material.
          const parsed = parseLink(published.url, { trustedOrigins: [published.metadata.origin] });
          if (parsed.form !== "full") throw new LinkError("invalid_argument");
          const opened = await openLinkRecord(parsed.record, parsed.key, { now });
          if (opened.type !== "share" || opened.header.issuer !== issuerKey.did ||
              opened.header.bodyCid !== published.link.cid || opened.header.expiresAt !== published.metadata.expiresAt) {
            throw new LinkError("invalid_argument");
          }
          sealed = { blob: opened.body, key: parsed.key };
        }
        const created = await createLink({
          type: "share",
          sealed,
          issuerKey,
          apiOrigin,
          linkOrigin: new URL(published.url).origin,
          expiresAt,
          now,
          ...transport,
        });
        return { url: created.link, short: true };
      } catch (error) {
        return { url: published.url, short: false, notice: shortLinkFallbackNotice(error) };
      }
    },
    async unlink(id) {
      return deleteLink({ id, issuerKey: await input.signer(), apiOrigin, ...transport });
    },
  };
}
