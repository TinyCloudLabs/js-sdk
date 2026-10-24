import { buildShortLink, parseLink } from "./grammar.js";

const KEY_PARAMETER = /[#&]k=([A-Za-z0-9_-]{43})(?:&|$)/;

/**
 * The body CID (`c`) of a short share link, or `undefined` for any other string: the full form, another link type,
 * another fragment version, a query, a non-canonical spelling or an id that is not lowercase. `trustedOrigins`
 * names the origins the link may be on; without it the link's own origin is trusted and the check is on the shape
 * of the link only.
 */
export function shortShareLinkCid(href: string, options: { readonly trustedOrigins?: readonly string[] } = {}): string | undefined {
  try {
    const parsed = parseLink(href, { trustedOrigins: options.trustedOrigins ?? [new URL(href).origin] });
    if (parsed.form !== "short" || parsed.pathType !== "share") return undefined;
    return href === buildShortLink({ origin: parsed.origin, type: "share", id: parsed.id, key: parsed.key, bodyCid: parsed.c }) ? parsed.c : undefined;
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
