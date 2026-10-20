/**
 * THE single shared email normalisation function (gap G14; the same rules as billing's
 * `src/email-normalise.ts`, TC-1439). The alias rules below are confirmed by Sam on 2026-10-19
 * (card tc-1439-email-aliases); a change to them changes only here.
 *
 *   - trim and lowercase;
 *   - fold a `+tag` suffix of the local part, for every domain;
 *   - remove dots of the local part for gmail.com and googlemail.com only (googlemail.com maps to
 *     gmail.com, as in billing's implementation).
 *
 * OPEN (G14): Unicode/IDNA handling is not defined. Until it is decided and frozen (before billing's
 * first production write), any input containing a UTF-16 code unit above 0x7F is refused, checked
 * before trim and lowercase. Billing mirrors this rule byte for byte.
 *
 * Returns null for empty or malformed input: callers must fail closed.
 */
export function normaliseEmail(email: string): string | null {
  if (typeof email === "string" && /[^\x00-\x7F]/.test(email)) return null;
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  let [local, domain] = parts as [string, string];
  if (local === "" || domain === "") return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (local === "") return null;
  return `${local}@${domain}`;
}
