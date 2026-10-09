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
  expandPermissionEntry,
  isCapabilitySubset,
  recapCaveatsEqual,
  type PermissionEntry,
  type ReplicationOptions,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";
import {
  kvPrefixCovers,
  requiresSecretsOptIn,
  type AuthorityRefusal,
  type ReplicaDevice,
  type ReplicationAuthority,
} from "@tinycloud/sdk-services";
import { compactUcanPayload } from "../delegation";

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

/** A pkh space-id comparison that ignores only EIP-55 casing of the address segment. */
export function samePkhSpaceId(a: string, b: string): boolean {
  const normalize = (space: string): string => {
    const match = /^(tinycloud:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})(:.+)$/.exec(space);
    return match === null ? space : `${match[1]}${match[2]!.toLowerCase()}${match[3]}`;
  };
  return normalize(a) === normalize(b);
}

/**
 * The unrestricted-get gate (§4.1): an entry grants `get` on `p` when it is a
 * `tinycloud.kv` entry for `spaceId` whose path covers `p`, whose expanded
 * actions include `get` (or `tinycloud.kv/*`), and whose caveats are
 * unconstrained — `undefined`, `[]` or `[{}]`. Short space names match the
 * space id's last segment, like the CLI's `sameLoginSpace`.
 */
export function hasUnrestrictedGetCoverage(
  entries: readonly PermissionEntry[],
  spaceId: string,
  prefix: string,
): boolean {
  const shortName = spaceId.split(":").pop() ?? spaceId;
  return entries.some((entry) => {
    if (entry.service !== KV_SERVICE) return false;
    const entrySpace = entry.space;
    if (
      entrySpace === undefined ||
      (!samePkhSpaceId(entrySpace, spaceId) && entrySpace !== shortName)
    ) {
      return false;
    }
    if (!kvPrefixCovers(entry.path, prefix)) return false;
    if (!recapCaveatsEqual(entry.caveats, undefined)) return false;
    return expandPermissionEntry(entry).some((expanded) =>
      expanded.actions.some((action) => actionContains(action, KV_GET)),
    );
  });
}

/**
 * One augmentation step for both the sign-in request and
 * `replicationSignInEntries()` (§4.1, §4.6): for each configured prefix, the
 * replication entry `{kv, spaceId, prefix, [get, sync]}` — added only when an
 * unrestricted `get` covering the prefix already exists and the
 * secrets/vault opt-in is satisfied.
 */
export function augmentSignInEntriesWithReplication(input: {
  entries: readonly PermissionEntry[];
  primarySpaceId: string;
  replication?: Pick<ReplicationOptions, "prefixes" | "allowSecrets">;
}): PermissionEntry[] {
  const out: PermissionEntry[] = [];
  const replication = input.replication;
  if (replication === undefined) return out;
  for (const prefix of replication.prefixes) {
    if (
      requiresSecretsOptIn(input.primarySpaceId, prefix) &&
      replication.allowSecrets !== true
    ) {
      continue;
    }
    if (!hasUnrestrictedGetCoverage(input.entries, input.primarySpaceId, prefix)) {
      continue;
    }
    out.push({
      service: KV_SERVICE,
      space: input.primarySpaceId,
      path: prefix,
      actions: [KV_GET, KV_SYNC],
    });
  }
  return out;
}

/** Constructor-time validation (§3.1). The space-dependent secrets check runs later, at sign-in/open. */
export function assertValidReplicationConfig(
  replication: (ReplicationOptions & { storage?: unknown }) | undefined,
): void {
  if (replication === undefined || replication.enabled !== true) return;
  if (replication.storage === undefined || replication.storage === null) {
    throw new TypeError("replication.enabled requires replication.storage");
  }
  if (!Array.isArray(replication.prefixes) || replication.prefixes.length === 0) {
    throw new TypeError("replication.prefixes must be a non-empty array");
  }
  for (const prefix of replication.prefixes) {
    if (typeof prefix !== "string" || prefix === "") {
      throw new TypeError("replication.prefixes must not contain an empty prefix");
    }
  }
  for (const [index, prefix] of replication.prefixes.entries()) {
    for (const other of replication.prefixes.slice(index + 1)) {
      if (kvPrefixCovers(prefix, other) || kvPrefixCovers(other, prefix)) {
        throw new TypeError(
          `replication.prefixes must not overlap: ${JSON.stringify(prefix)} and ${JSON.stringify(other)}`,
        );
      }
    }
    if (prefix.split("/", 1)[0] === "vault" && replication.allowSecrets !== true) {
      throw new TypeError(
        `replication prefix ${JSON.stringify(prefix)} overlaps the vault namespace; pass allowSecrets to opt in`,
      );
    }
  }
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
export interface ReplicationAuthorityHost {
  replicationSession(): TinyCloudSession | undefined;
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

export function createReplicationAuthority(host: ReplicationAuthorityHost): ReplicationAuthority {
  const planOrRefusal = (entries: PermissionEntry[]): DelegationPlanResult | AuthorityRefusal => {
    const plan = host.planDelegation(entries);
    if ("refused" in plan) return plan;
    return { path: plan.path, parentCid: plan.parentCid, expiresAt: plan.expiresAt };
  };

  return {
    sessionGrant(prefix: string): { ucan: string; device: ReplicaDevice } | AuthorityRefusal {
      const session = host.replicationSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      const siweExpiry = session.siwe ? host.siweExpiration(session.siwe)?.getTime() : undefined;
      if (siweExpiry !== undefined && siweExpiry <= Date.now() + AUTHORITY_EXPIRY_MARGIN_MS) {
        return { refused: "SESSION_EXPIRING" };
      }
      let payload: Record<string, unknown>;
      try {
        payload = compactUcanPayload(session.delegationHeader.Authorization);
      } catch {
        // Not a compact UCAN (SIWE/CACAO session): delegate posture does not apply.
        return { refused: "NOT_COVERED" };
      }
      const att = payload.att;
      if (att === null || typeof att !== "object" || Array.isArray(att)) {
        return { refused: "NOT_COVERED" };
      }
      const covered = ucanAttCovers(att as Record<string, Record<string, unknown>>, session.spaceId, prefix, KV_GET, { ignoreCaveats: true }) &&
        ucanAttCovers(att as Record<string, Record<string, unknown>>, session.spaceId, prefix, KV_SYNC, { ignoreCaveats: true });
      if (!covered) return { refused: "NOT_COVERED" };
      if (!ucanAttUnconstrainedFor(att as Record<string, Record<string, unknown>>, session.spaceId, prefix)) {
        return { refused: "CAVEATED_AUTHORITY" };
      }
      return {
        ucan: session.delegationHeader.Authorization,
        device: { did: session.verificationMethod, jwk: session.jwk },
      };
    },

    plan(prefix: string): DelegationPlanResult | AuthorityRefusal {
      const session = host.replicationSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      return planOrRefusal(replicationEntries(session.spaceId, prefix));
    },

    async mint(
      deviceDid: string,
      prefix: string,
      signal: AbortSignal,
    ): Promise<{ ucan: string; parentCid: string; expiresAt: number }> {
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
}

