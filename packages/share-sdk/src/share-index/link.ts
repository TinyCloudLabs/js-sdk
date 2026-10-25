import { isCanonicalHttpsOrigin, parseShareUrl } from "@tinycloud/share-envelope";
import { MAX_LINK_REQUEST_BYTES, parseLink } from "@tinycloud/share-envelope/links";
import { parseNativeShareUrl } from "../native.js";

/**
 * Share link validator (design C §5 check 6, §6 Open/Copy). A link is
 * accepted only when it is https on a configured share origin and has one of
 * the share link shapes:
 * - `/s/<cid>#k=<key>`: registry envelope link;
 * - `/s/<id>#v=4&k=<key>&c=<cid>` or `/s/full#v=4&k=<key>&r=<record>`: the
 *   short or full link of a Policy/v3 share (what `publishAddressedShare`
 *   emits and the links service stores);
 * - `/viewer#tc1=<token>`: native bearer link (`createNativeShare`).
 *
 * The result names the shape only; the link itself is never copied into it.
 */
export type ShareLinkShape = "envelope" | "link" | "native";

export type ShareLinkCheck = { readonly ok: true; readonly shape: ShareLinkShape } | { readonly ok: false };

const MAX_LINK_LENGTH = 12 * 1024;
/** A full link carries a whole record (the create request's cap) in base64url, plus the origin and fragment names. */
const MAX_FULL_LINK_LENGTH = Math.ceil((MAX_LINK_REQUEST_BYTES * 4) / 3) + 512;
/** A `/s/<id>` path (26 base32 characters) and `/s/full`: the paths the `v=4` grammar owns. */
const V4_SHARE_PATH = /^\/s\/([A-Za-z2-7]{26}|full)$/;

export function validateShareLink(link: unknown, shareOrigins: readonly string[]): ShareLinkCheck {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_FULL_LINK_LENGTH || /[\s\u0000-\u001f\u007f]/.test(link)) return { ok: false };
  let url: URL;
  try { url = new URL(link); } catch { return { ok: false }; }
  if (link.length > MAX_LINK_LENGTH && url.pathname !== "/s/full") return { ok: false };
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "") return { ok: false };
  if (!isCanonicalHttpsOrigin(url.origin) || !shareOrigins.includes(url.origin)) return { ok: false };
  try {
    if (url.pathname === "/viewer") {
      parseNativeShareUrl(link);
      return link === `${url.origin}/viewer${url.hash}` ? { ok: true, shape: "native" } : { ok: false };
    }
    if (V4_SHARE_PATH.test(url.pathname)) {
      const parsed = parseLink(link, { trustedOrigins: shareOrigins });
      return parsed.form === "full" || parsed.pathType === "share" ? { ok: true, shape: "link" } : { ok: false };
    }
    parseShareUrl(link, { expectedOrigin: url.origin });
    return { ok: true, shape: "envelope" };
  } catch {
    return { ok: false };
  }
}
