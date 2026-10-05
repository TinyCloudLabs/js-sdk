import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import type { AuthorityState, AuthorityWindow, GrantRecord, LocalReadPolicy } from "./types.js";

/**
 * The node's `kv_prefix_covers`: whole path segments, byte-exact. `notes/`
 * covers everything under `notes/` but not `notes`; `notes` covers `notes`
 * and `notes/…` but not `notes-secret/x`.
 */
export function kvPrefixCovers(prefix: string, key: string): boolean {
  if (prefix === "") return true;
  if (prefix.endsWith("/")) return key.startsWith(prefix);
  return key === prefix || key.startsWith(`${prefix}/`);
}

/**
 * Syncing the owner's secrets space, or any prefix overlapping the vault
 * namespace (including bare `vault`), copies encrypted secret material to
 * disk and needs an explicit opt-in (TC-733).
 */
export function requiresSecretsOptIn(space: string, prefix: string): boolean {
  if (space === "secrets" || space.endsWith(":secrets")) return true;
  const firstSegment = prefix.split("/", 1)[0];
  return firstSegment === "vault";
}

/** `"blake3-<hex>"` (quoted or not) → the 64-hex hash, or undefined. */
export function hashFromEtag(etag: string): string | undefined {
  const match = /^"?blake3-([0-9a-f]{64})"?$/.exec(etag);
  return match?.[1];
}

export type EffectiveAuthority = {
  state: AuthorityState;
  notBefore: string | null;
  expiresAt: string | null;
  retainUntil: string | null;
};

function minIso(a: string | null, bSeconds: number | null): string | null {
  if (bSeconds === null) return a;
  const b = new Date(bSeconds * 1000).toISOString();
  if (a === null) return b;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string | null, bSeconds: number | null): string | null {
  if (bSeconds === null) return a;
  const b = new Date(bSeconds * 1000).toISOString();
  if (a === null) return b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * The window local reads are enforced against: the node-attested window from
 * the last successful sync, bounded by the installed leaf grant (an upper
 * bound only — a multi-parent ancestor can end the chain earlier, which only
 * the node can see).
 */
export function effectiveAuthority(input: {
  window: AuthorityWindow | null;
  grant: GrantRecord | null;
  revoked: string | null;
  policy: LocalReadPolicy;
  now: number;
}): EffectiveAuthority {
  const notBefore = maxIso(input.window?.notBefore ?? null, input.grant?.notBefore ?? null);
  const expiresAt = minIso(input.window?.expiresAt ?? null, input.grant?.expiresAt ?? null);
  const retainUntil = input.policy === "retainAfterExpiry" ? input.window?.retainUntil ?? null : null;
  let state: AuthorityState = "valid";
  if (input.revoked !== null) state = "revoked";
  else if (notBefore !== null && input.now < Date.parse(notBefore)) state = "not-yet-valid";
  else if (expiresAt !== null && input.now >= Date.parse(expiresAt)) state = "expired";
  return { state, notBefore, expiresAt, retainUntil };
}

/**
 * Throws unless local reads are allowed now. Returns the reported authority
 * state: `valid`, or `expired` while a node-attested retention holds.
 */
export function assertReadable(authority: EffectiveAuthority, now: number): AuthorityState {
  switch (authority.state) {
    case "valid":
      return "valid";
    case "revoked":
      throw new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "The replica's grant was revoked; local reads are blocked.");
    case "not-yet-valid":
      throw new ReplicaError(
        ReplicaErrorCode.GRANT_NOT_YET_VALID,
        `The replica's grant is not valid before ${authority.notBefore}.`,
      );
    case "expired":
      if (authority.retainUntil !== null && now < Date.parse(authority.retainUntil)) return "expired";
      throw new ReplicaError(
        ReplicaErrorCode.GRANT_EXPIRED,
        authority.retainUntil === null
          ? `The replica's grant expired at ${authority.expiresAt}; local reads are blocked.`
          : `The replica's retention ended at ${authority.retainUntil}; local reads are blocked.`,
      );
  }
}
