import { refuse } from "./errors";
import type { Json } from "./encoding";

/**
 * A profile row is the complete definition of a held profile (spec §3.3). Every profile rule is
 * keyed on the row selected by the credential's signed `profile`, never on the issuer.
 */
export interface ProfileRow {
  profile: string;
  profileVersion: number;
  vct: string;
  holder: { kind: "account-pkh"; chainId: string };
  bindingDomain: string;
  /** Top-level claim names that may be selectively disclosed; nothing else is disclosable. */
  disclosable: readonly string[];
  /** Signed claims beyond the shared set that this row tolerates. */
  optionalSignedClaims: readonly string[];
  /** Largest allowed `exp - iat`, seconds. */
  maxLifetimeSeconds: number;
  /** Accepted `status.method` values. */
  statusMethods: readonly string[];
  /** Checks the disclosed claim values; throws a HeldCredentialError. */
  validateDisclosed(claims: Readonly<Record<string, Json>>): void;
}

export const HELD_EMAIL_TTL_SECONDS = 365 * 24 * 60 * 60;
export const ACCOUNT_BINDING_DOMAIN = "tinycloud.credentials/account-binding/v1";

export const EMAIL_HELD_ROW: ProfileRow = {
  profile: "tinycloud.email-held/v1",
  profileVersion: 1,
  vct: "opencredentials.email/v1",
  holder: { kind: "account-pkh", chainId: "1" },
  bindingDomain: ACCOUNT_BINDING_DOMAIN,
  disclosable: ["email", "emailDomain"],
  optionalSignedClaims: [],
  maxLifetimeSeconds: HELD_EMAIL_TTL_SECONDS,
  statusMethods: ["none"],
  validateDisclosed(claims) {
    const { email, emailDomain } = claims;
    if ((typeof email === "string" && /[^\x00-\x7F]/.test(email)) || (typeof emailDomain === "string" && /[^\x00-\x7F]/.test(emailDomain))) {
      refuse("bad-disclosure", "non-ASCII email is refused until G14 (Unicode/IDNA) is decided");
    }
    if (email !== undefined) {
      if (typeof email !== "string" || email !== email.toLowerCase() || email.split("@").length !== 2 || email.length < 3 || email.length > 320 || /[\s\u0000-\u001f]/.test(email)) {
        refuse("bad-disclosure", "email is not a canonical lowercase address");
      }
    }
    if (emailDomain !== undefined) {
      if (typeof emailDomain !== "string" || emailDomain === "" || emailDomain !== emailDomain.toLowerCase() || emailDomain.includes("@")) {
        refuse("bad-disclosure", "emailDomain is not a lowercase domain");
      }
    }
    if (typeof email === "string" && typeof emailDomain === "string" && email.slice(email.lastIndexOf("@") + 1) !== emailDomain) {
      refuse("bad-disclosure", "emailDomain does not match email");
    }
  },
};

export const DEFAULT_ROWS: readonly ProfileRow[] = [EMAIL_HELD_ROW];

export function findRow(rows: readonly ProfileRow[], profile: string, profileVersion: number): ProfileRow | undefined {
  return rows.find((row) => row.profile === profile && row.profileVersion === profileVersion);
}
