import { isCanonicalHttpsOrigin, parseShareUrl } from "@tinycloud/share-envelope";
import { parseNativeShareUrl } from "../native.js";

/**
 * Share link validator (design C §5 check 6, §6 Open/Copy). A link is
 * accepted only when it is https on a configured share origin and has one of
 * the share link shapes:
 * - `/s/<cid>#k=<key>`: registry envelope link;
 * - `/s/inline#v=2&p=<payload>`: Node Policy/v3 sealed-inline link (what
 *   `publishAddressedShare` emits);
 * - `/viewer#tc1=<token>`: native bearer link (`createNativeShare`).
 *
 * The result names the shape only; the link itself is never copied into it.
 */
export type ShareLinkShape = "envelope" | "inline" | "native";

export type ShareLinkCheck = { readonly ok: true; readonly shape: ShareLinkShape } | { readonly ok: false };

const MAX_LINK_LENGTH = 12 * 1024;

export function validateShareLink(link: unknown, shareOrigins: readonly string[]): ShareLinkCheck {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_LINK_LENGTH || /[\s\u0000-\u001f\u007f]/.test(link)) return { ok: false };
  let url: URL;
  try { url = new URL(link); } catch { return { ok: false }; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "") return { ok: false };
  if (!isCanonicalHttpsOrigin(url.origin) || !shareOrigins.includes(url.origin)) return { ok: false };
  try {
    if (url.pathname === "/viewer") {
      parseNativeShareUrl(link);
      return link === `${url.origin}/viewer${url.hash}` ? { ok: true, shape: "native" } : { ok: false };
    }
    if (url.pathname === "/s/inline") {
      return link === `${url.origin}/s/inline${url.hash}` && /^#v=2&p=[A-Za-z0-9_-]+$/.test(url.hash) ? { ok: true, shape: "inline" } : { ok: false };
    }
    parseShareUrl(link, { expectedOrigin: url.origin });
    return { ok: true, shape: "envelope" };
  } catch {
    return { ok: false };
  }
}
