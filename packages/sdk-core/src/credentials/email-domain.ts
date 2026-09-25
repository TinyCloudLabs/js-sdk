/**
 * Canonical email-domain rules shared by senders, receivers, and the
 * OpenCredentials `tinycloud.email-domain-proof/v1` issuer. A domain is
 * canonical only as lowercase ASCII LDH labels (two or more, no trailing dot,
 * not an IP literal). Unicode and IDNA U-labels have no canonical form here:
 * IDNA A-labels (`xn--…`) are accepted verbatim, so equality is always a
 * plain string comparison with no normalization ambiguity.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isCanonicalEmailDomain(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^[0-9]+$/.test(labels.at(-1)!);
}

/** Canonicalizes a sender-entered domain (`@Example.com` → `example.com`) or throws. */
export function canonicalEmailDomain(value: string): string {
  const domain = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[\x21-\x7e]+$/.test(domain) || !isCanonicalEmailDomain(domain)) throw new TypeError("email domain must be lowercase ASCII DNS labels (use the xn-- form for international domains)");
  return domain;
}

/**
 * Canonical form of a recipient-entered mailbox (trimmed, lowercased), or
 * undefined when it has no canonical domain. The issuer accepts only this
 * form, so the local check agrees with what the credential will contain.
 */
export function canonicalMailbox(value: string): { readonly email: string; readonly domain: string } | undefined {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !/^[\x21-\x7e]+$/.test(local) || /["\\]/.test(local) || !isCanonicalEmailDomain(domain)) return undefined;
  return Object.freeze({ email, domain });
}

/** True only when the mailbox's canonical domain equals `domain` exactly (no suffix or subdomain match). */
export function mailboxBelongsToDomain(mailbox: string, domain: string): boolean {
  return canonicalMailbox(mailbox)?.domain === domain && isCanonicalEmailDomain(domain);
}
