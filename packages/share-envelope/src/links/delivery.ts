import { parseLink } from "./grammar.js";

const KEY_PARAMETER = /[#&]k=([A-Za-z0-9_-]{43})(?:&|$)/;

/**
 * The body CID (`c`) of a short share link, or `undefined` for any other string: the full form, another link type,
 * another fragment version, a query or a non-canonical spelling. The link's own origin is the trusted origin, so
 * the check is on the shape of the link and not on where it points.
 */
export function shortShareLinkCid(href: string): string | undefined {
  try {
    const parsed = parseLink(href, { trustedOrigins: [new URL(href).origin] });
    return parsed.form === "short" && parsed.pathType === "share" ? parsed.c : undefined;
  } catch {
    return undefined;
  }
}

/** `text` with every occurrence of `href`, and of the key in its `k=` parameter, replaced. */
export function redactLink(text: string, href: string): string {
  const key = KEY_PARAMETER.exec(href)?.[1];
  const withoutLink = text.split(href).join("[share link]");
  return key === undefined ? withoutLink : withoutLink.split(key).join("[key]");
}
