/**
 * THE single shared email normalisation function (gap G14; the same rules as billing's
 * `src/email-normalise.ts`, TC-1439). Interim until Sam answers the alias question; if the rule
 * changes it changes only here.
 *
 *   - trim and lowercase;
 *   - fold a `+tag` suffix of the local part, for every domain;
 *   - remove dots of the local part for gmail.com and googlemail.com only (googlemail.com maps to gmail.com).
 *
 * Returns null for empty or malformed input: callers must fail closed.
 */
export function normaliseEmail(email: string): string | null {
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  let [local, domain] = parts as [string, string];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (local === "") return null;
  return `${local}@${domain}`;
}
