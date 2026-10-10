/**
 * Replication authority (TC-858, plan v3 §4).
 *
 * `ReplicationAuthority` answers, per configured prefix, whether this node's
 * session can back a local replica: the session UCAN itself (delegate
 * posture), a child UCAN minted through `delegateTo`, or nothing (the
 * controller then reports `grant_missing` and reads from the network).
 *
 * The unrestricted-authority rule is enforced here, before any network work:
 * a prefix covered only by a caveated `get`/`sync` refuses with
 * `CAVEATED_AUTHORITY` — on the session path, the runtime-grant path, and on
 * any reuse of an installed grant (the adapter marks every grant's
 * `unconstrained` flag; the controller enforces it on reuse).
 */

import {
  KV,
  actionContains,
  canonicalizeRecapCaveats,
  parseSpaceUri,
  type PermissionEntry,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";
import {
  kvPrefixCovers,
  type AuthorityRefusal,
  type ReplicaDevice,
  type ReplicationAuthority,
} from "@tinycloud/sdk-services";
import { parseUcanGrant } from "@tinycloud/replica";
export { assertValidReplicationConfig } from "./config";
export { augmentSignInEntriesWithReplication, hasUnrestrictedGetCoverage } from "./authority-sign-in";

const KV_GET = KV.GET;
const KV_SYNC = KV.SYNC;
const KV_SERVICE = "tinycloud.kv";

/** The delegation the replication grant delegates: get + sync on one prefix of the session space. */
function replicationEntries(spaceId: string, prefix: string): PermissionEntry[] {
  return [
    {
      service: KV_SERVICE,
      space: spaceId,
      path: prefix,
      actions: [KV_GET, KV_SYNC],
    },
  ];
}




/**
 * The signed UCAN attenuation (`att`: resource → ability → caveat branches).
 * Only array branch sets are known; anything else is treated as constrained —
 * fail closed, never assume unconstrained.
 */
function caveatBranchesUnconstrained(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    return true;
  }
  if (!Array.isArray(value)) return false;
  try {
    return (
      canonicalizeRecapCaveats(value as Record<string, unknown>[]) ===
      canonicalizeRecapCaveats(undefined)
    );
  } catch {
    return false;
  }
}

/** The KV path a signed UCAN resource names in `space`, like replica's `kvPathIn`. */
function kvPathInResource(resource: string, space: string): string | undefined {
  for (const base of [`${space}/kv/`, `tinycloud://${space}/kv/`]) {
    if (resource.startsWith(base)) return resource.slice(base.length);
  }
  return undefined;
}

/**
 * Whether the signed `att` grants `ability` on a path covering `prefix`,
 * with each grant unrestricted (no caveats). With `ignoreCaveats`, answers
 * coverage only — used to distinguish `CAVEATED_AUTHORITY` from `NOT_COVERED`.
 */
export function ucanAttCovers(
  att: Record<string, Record<string, unknown>>,
  space: string,
  prefix: string,
  ability: string,
  options?: { ignoreCaveats?: boolean },
): boolean {
  for (const [resource, abilities] of Object.entries(att)) {
    const path = kvPathInResource(resource, space);
    if (path === undefined || !kvPrefixCovers(path, prefix)) continue;
    for (const [granted, caveats] of Object.entries(abilities)) {
      if (!actionContains(granted, ability)) continue;
      if (options?.ignoreCaveats === true || caveatBranchesUnconstrained(caveats)) {
        return true;
      }
    }
  }
  return false;
}

/** `unconstrained` for `ReplicaGrantInfo` (§2.1): get AND sync on the prefix carry no caveats. */
export function ucanAttUnconstrainedFor(
  att: Record<string, Record<string, unknown>>,
  space: string,
  prefix: string,
): boolean {
  return (
    ucanAttCovers(att, space, prefix, KV_GET) &&
    ucanAttCovers(att, space, prefix, KV_SYNC)
  );
}

export interface DelegationPlanResult {
  path: "session" | "runtime";
  parentCid: string;
  expiresAt: number;
}

/**
 * The `TinyCloudNode` internals the authority needs. `planDelegation` is the
 * pure extraction of `delegateTo`'s parent selection (§4.3), so `plan` and
 * `mint` can never disagree about which parent or expiry a delegation gets.
 */
export type ReplicationAuthoritySession = Pick<
  TinyCloudSession,
  "delegationHeader" | "delegationCid" | "spaceId" | "verificationMethod" | "jwk"
> & Partial<Pick<TinyCloudSession, "siwe">>;

export interface ReplicationAuthorityHost {
  replicationSession(): ReplicationAuthoritySession | undefined;
  /** The SIWE "Expiration Time" of the session — the delegateTo delegation cap. */
  siweExpiration(siwe: string): Date | undefined;
  planDelegation(
    entries: PermissionEntry[],
    options?: { expiry?: string | number },
  ): ({ grant?: unknown } & DelegationPlanResult) | AuthorityRefusal;
  mintDelegation(
    deviceDid: string,
    entries: PermissionEntry[],
  ): Promise<{ ucan: string; expiresAt: number }>;
}

/** Milliseconds of validity a session or parent must have left for authority reuse (delegateTo's margin). */
export const AUTHORITY_EXPIRY_MARGIN_MS = 60_000;


/** Verify a compact session delegation before using any persisted space metadata. */
export function replicationScopeFromSignedSession(input: {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  verificationMethod: string;
  persistedSpace: string;
}): { space: string; principal: string } | undefined {
  let grant: ReturnType<typeof parseUcanGrant>;
  try {
    grant = parseUcanGrant(input.delegationHeader.Authorization);
  } catch {
    return undefined;
  }
  const bareDid = (value: string): string => value.split("#", 1)[0]!;
  if (
    grant.cid !== input.delegationCid ||
    bareDid(grant.audience) !== bareDid(input.verificationMethod)
  ) return undefined;
  for (const resource of Object.keys(grant.att)) {
    const space = resource.match(/^(?:tinycloud:\/\/)?(.+?)\/kv\//)?.[1];
    if (space !== input.persistedSpace) continue;
    const owner = parseSpaceUri(space);
    if (owner?.owner && owner.address && owner.chainId) return { space, principal: owner.owner };
  }
  return undefined;
}
export function createReplicationAuthority(host: ReplicationAuthorityHost): ReplicationAuthority {
  const planOrRefusal = (entries: PermissionEntry[]): DelegationPlanResult | AuthorityRefusal => {
    const plan = host.planDelegation(entries);
    if ("refused" in plan) return plan;
    return { path: plan.path, parentCid: plan.parentCid, expiresAt: plan.expiresAt };
  };
  const sessionAudience = (value: string): string => value.split("#", 1)[0]!;
  const signedSessionGrant = (session: ReplicationAuthoritySession) => {
    const grant = parseUcanGrant(session.delegationHeader.Authorization);
    if (
      grant.cid !== session.delegationCid ||
      sessionAudience(grant.audience) !== sessionAudience(session.verificationMethod)
    ) return undefined;
    return grant;
  };
  const authority: ReplicationAuthority = {
    get sessionOnly() {
      const session = host.replicationSession();
      return session !== undefined && session.siwe === undefined;
    },
    sessionGrant(prefix: string): { ucan: string; device: ReplicaDevice } | AuthorityRefusal {
      const session = host.replicationSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      const siweExpiry = session.siwe ? host.siweExpiration(session.siwe)?.getTime() : undefined;
      if (siweExpiry !== undefined && siweExpiry <= Date.now() + AUTHORITY_EXPIRY_MARGIN_MS) {
        return { refused: "SESSION_EXPIRING" };
      }
      let grant: ReturnType<typeof parseUcanGrant>;
      try {
        const verified = signedSessionGrant(session);
        if (!verified) return { refused: "NOT_COVERED" };
        grant = verified;
      } catch {
        return { refused: "NOT_COVERED" };
      }
      const tokenExpiry = grant.expiresAt === null ? undefined : grant.expiresAt * 1000;
      if (tokenExpiry === undefined || tokenExpiry <= Date.now() + AUTHORITY_EXPIRY_MARGIN_MS) {
        return { refused: "SESSION_EXPIRING" };
      }
      const covered = ucanAttCovers(grant.att, session.spaceId, prefix, KV_GET, { ignoreCaveats: true }) &&
        ucanAttCovers(grant.att, session.spaceId, prefix, KV_SYNC, { ignoreCaveats: true });
      if (!covered) return { refused: "NOT_COVERED" };
      if (!ucanAttUnconstrainedFor(grant.att, session.spaceId, prefix)) {
        return { refused: "CAVEATED_AUTHORITY" };
      }
      return {
        ucan: grant.jwt,
        device: { did: session.verificationMethod, jwk: session.jwk },
      };
    },
    plan(prefix: string): DelegationPlanResult | AuthorityRefusal {
      const session = host.replicationSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      const sessionGrant = this.sessionGrant(prefix);
      if (!("refused" in sessionGrant)) {
        const signed = signedSessionGrant(session);
        if (!signed || signed.expiresAt === null) return { refused: "NOT_COVERED" };
        return {
          path: "session",
          parentCid: session.delegationCid,
          expiresAt: signed.expiresAt * 1000,
        };
      }
      if (authority.sessionOnly) return sessionGrant;
      return planOrRefusal(replicationEntries(session.spaceId, prefix));
    },
    async mint(
      deviceDid: string,
      prefix: string,
      signal: AbortSignal,
    ): Promise<{ ucan: string; parentCid: string; expiresAt: number }> {
      if (authority.sessionOnly) throw new Error("compact delegate sessions cannot mint device grants");
      const session = host.replicationSession();
      if (session === undefined) throw new Error("replication mint without a session");
      const entries = replicationEntries(session.spaceId, prefix);
      const plan = planOrRefusal(entries);
      if ("refused" in plan) {
        throw Object.assign(
          new Error(`replication authority refused the mint: ${plan.refused}`),
          { refused: plan.refused },
        );
      }
      signal.throwIfAborted();
      const minted = await new Promise<{ ucan: string; expiresAt: number }>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason ?? new Error("replication mint aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        host.mintDelegation(deviceDid, entries).then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      return { ucan: minted.ucan, parentCid: plan.parentCid, expiresAt: minted.expiresAt };
    },
  };
  return authority;
}
