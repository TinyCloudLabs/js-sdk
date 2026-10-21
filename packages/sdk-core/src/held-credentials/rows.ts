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
  /**
   * Whether this row admits a credential signed by `issuerDid`. Fixed per shipped profile.
   * Optional for a caller-defined row. When omitted, the row admits any issuer that the issuer
   * entry permits; the entry's own key, kid, and profile checks still apply.
   */
  permitsIssuer?(issuerDid: string): boolean;
}

export const HELD_EMAIL_TTL_SECONDS = 365 * 24 * 60 * 60;
export const ACCOUNT_BINDING_DOMAIN = "tinycloud.credentials/account-binding/v1";

const ORG_MEMBERSHIP_BINDING_DOMAIN = "tinycloud.credentials/org-binding/v1";
const ORG_MEMBERSHIP_TTL_SECONDS = 365 * 24 * 60 * 60;
const ORG_MEMBERSHIP_FREE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Org-family issuer DIDs: `did:web:o` + 26 base32 characters + `.orgs.credentials.org`. */
const ORG_ISSUER_DID_PATTERN = /^did:web:o[a-z2-7]{26}\.orgs\.credentials\.org$/;
const ORG_ROLES: readonly string[] = ["member", "admin"];
const MEMBERSHIP_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Shipped rows are fixed definitions. Freezing each row and its nested containers keeps a caller
 * from changing a shipped rule through a reference to it.
 */
function freezeRow(row: ProfileRow): ProfileRow {
  Object.freeze(row.holder);
  Object.freeze(row.disclosable);
  Object.freeze(row.optionalSignedClaims);
  Object.freeze(row.statusMethods);
  return Object.freeze(row);
}

export const EMAIL_HELD_ROW: ProfileRow = freezeRow({
  profile: "tinycloud.email-held/v1",
  profileVersion: 1,
  vct: "opencredentials.email/v1",
  holder: { kind: "account-pkh", chainId: "1" },
  bindingDomain: ACCOUNT_BINDING_DOMAIN,
  disclosable: ["email", "emailDomain"],
  optionalSignedClaims: [],
  maxLifetimeSeconds: HELD_EMAIL_TTL_SECONDS,
  statusMethods: ["none"],
  // Any issuer except the org family, which only the org rows admit.
  permitsIssuer: (issuerDid) => !ORG_ISSUER_DID_PATTERN.test(issuerDid),
  validateDisclosed(claims) {
    const { email, emailDomain } = claims;
    if ((typeof email === "string" && /[^\x00-\x7F]/.test(email)) || (typeof emailDomain === "string" && /[^\x00-\x7F]/.test(emailDomain))) {
      refuse("bad-disclosure", "email must be ASCII");
    }
    if (email !== undefined) {
      if (typeof email === "string" && (email.indexOf("@") < 1 || email.indexOf("@") === email.length - 1)) {
        refuse("bad-disclosure", "email needs a non-empty local part and domain");
      }
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
});

function orgMembershipRow(profile: string, maxLifetimeSeconds: number): ProfileRow {
  return freezeRow({
    profile,
    profileVersion: 1,
    vct: "opencredentials.org-membership/v1",
    holder: { kind: "account-pkh", chainId: "1" },
    bindingDomain: ORG_MEMBERSHIP_BINDING_DOMAIN,
    disclosable: ["role", "membershipType"],
    optionalSignedClaims: [],
    maxLifetimeSeconds,
    statusMethods: ["none"],
    permitsIssuer: (issuerDid) => ORG_ISSUER_DID_PATTERN.test(issuerDid),
    validateDisclosed(claims) {
      const { role, membershipType } = claims;
      if (role !== undefined && (typeof role !== "string" || !ORG_ROLES.includes(role))) {
        refuse("bad-disclosure", "role must be member or admin");
      }
      if (membershipType !== undefined && (typeof membershipType !== "string" || !MEMBERSHIP_TYPE_PATTERN.test(membershipType))) {
        refuse("bad-disclosure", "membershipType is not a canonical slug");
      }
    },
  });
}

/** Paid org membership row (profile `tinycloud.org-membership/v1`). */
export const ORG_MEMBERSHIP_ROW: ProfileRow = orgMembershipRow("tinycloud.org-membership/v1", ORG_MEMBERSHIP_TTL_SECONDS);
/** Free org membership row (profile `tinycloud.org-membership-free/v1`). */
export const ORG_MEMBERSHIP_FREE_ROW: ProfileRow = orgMembershipRow("tinycloud.org-membership-free/v1", ORG_MEMBERSHIP_FREE_TTL_SECONDS);
/** Both org rows. Not in `DEFAULT_ROWS`: a caller opts in by passing them as `rows`. */
export const ORG_MEMBERSHIP_ROWS: readonly ProfileRow[] = Object.freeze([ORG_MEMBERSHIP_ROW, ORG_MEMBERSHIP_FREE_ROW]);

export const DEFAULT_ROWS: readonly ProfileRow[] = Object.freeze([EMAIL_HELD_ROW]);

/**
 * Every row this package ships. The issuer set loader applies each shipped row's `permitsIssuer`
 * whatever rows the caller passes, so a caller row cannot relax a shipped profile's issuer rule.
 */
export const SHIPPED_ROWS: readonly ProfileRow[] = Object.freeze([EMAIL_HELD_ROW, ...ORG_MEMBERSHIP_ROWS]);

export function findRow(rows: readonly ProfileRow[], profile: string, profileVersion: number): ProfileRow | undefined {
  return rows.find((row) => row.profile === profile && row.profileVersion === profileVersion);
}

/**
 * Whether `row` admits `issuerDid`. A row without `permitsIssuer` admits every issuer its issuer
 * entry permits. A `permitsIssuer` that is present but not a function refuses with `bad-config`,
 * so a malformed rule is never read as permissive.
 */
export function rowPermitsIssuer(row: ProfileRow, issuerDid: string): boolean {
  if (row.permitsIssuer === undefined) return true;
  if (typeof row.permitsIssuer !== "function") refuse("bad-config", "a profile row's permitsIssuer must be a function when present");
  return row.permitsIssuer(issuerDid);
}
