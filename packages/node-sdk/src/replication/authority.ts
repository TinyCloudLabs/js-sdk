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
import { SiweMessage } from "siwe";

import {
  actionContains,
  KV,
  canonicalizeRecapCaveats,
  isCapabilitySubset,
  principalDid,
  parseSpaceUri,
  type PermissionEntry,
  type IWasmBindings,
  type WasmRecapEntry,
  type TinyCloudSession,
  type KVReplicaStorage,
  type ServiceContext,
  type ReplicationOptions,
} from "@tinycloud/sdk-core";
import {
  type AuthorityRefusal,
  type ReplicaConsentAnchor,
  type ReplicaDevice,
  type ReplicationAuthority,
  type ReplicationEvent,
} from "@tinycloud/sdk-services";
import type {
  ReplicaDenyInput,
  ReplicaLocalEraseOutcome,
  ReplicaPurgeFailedEvent,
  ReplicaPurgeLocalCopyResult,
  ReplicaPurgeTrigger,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import type { DelegateToOptions, DelegateToResult, TinyCloudNode } from "../TinyCloudNode";
import type { ReplicaRuntime } from "./replica-contract";
// @ts-ignore -- node-sdk builds before replica declarations; keep the literal import for bundlers.
import { parseUcanGrant as replicaParseUcanGrant } from "@tinycloud/replica";
const parseUcanGrant = replicaParseUcanGrant as ReplicaRuntime["parseUcanGrant"];
export { assertValidReplicationConfig } from "./config";
export { augmentSignInEntriesWithReplication, hasUnrestrictedGetCoverage } from "./authority-sign-in";

/** Report a completed deny from the already-loaded authority; delivery was revoked synchronously. */
export function reportReplicaDenial(
  result: { status: string; code?: string; intents?: number },
  reason: ReplicaDenyInput["reason"],
  onEvent: ReplicationOptions["onEvent"],
  context?: ServiceContext,
): void {
  if (result.status !== "denied" && result.status !== "deleted" && result.status !== "marker") return;
  const event: Extract<ReplicationEvent, { type: "replication.lifecycle" }> = {
    type: "replication.lifecycle",
    at: new Date().toISOString(),
    reason,
    action: result.status === "denied" ? "denied" : result.status === "deleted" ? "database_deleted" : "marker_set",
    ...(result.status === "denied" ? { partitions: result.intents } : {}),
    ...(result.status === "marker" ? { code: result.code } : {}),
  };
  try { onEvent?.(event); } catch { /* Observability cannot undo committed denial. */ }
  const { type, ...data } = event;
  try { context?.emit(type, data); } catch { /* Observability cannot undo committed denial. */ }
}

/** What the root needs after a local-copy erase: the outcome, the `purgeLocalCopy()` result and the marker state. */
export interface ReplicaLocalEraseReport {
  outcome: ReplicaLocalEraseOutcome;
  purge: ReplicaPurgeLocalCopyResult;
  /** The logout marker is set: the next load finishes the erase and the replica stays gated meanwhile. */
  logoutPending?: true;
}

/** Local-copy erase after a deny: 3 attempts in total, retries 150 ms then 450 ms apart, 3 s per attempt. */
const ERASE_RETRY_DELAYS_MS = [150, 450] as const;
const ERASE_ATTEMPT_MS = 3_000;

/**
 * Erases the browser local copy after a deny, retrying a `failed` outcome with the delays above. After
 * the last failure (or a refusal while the deny kept the keys) it notifies `handlers` with
 * `replica.purge.failed`; the logout marker the lifecycle set makes the next load finish the erase.
 * Never rejects. `undefined`: this storage has no browser local copy to erase.
 */
export async function eraseReplicaLocalCopy(
  lifecycle: KVReplicaStorage["lifecycle"],
  trigger: ReplicaPurgeTrigger,
  denyStatus: string | undefined,
  handlers: ReadonlySet<(event: ReplicaPurgeFailedEvent) => void>,
): Promise<ReplicaLocalEraseReport | undefined> {
  if (lifecycle?.kind !== "indexeddb" || lifecycle.eraseLocalCopy === undefined) return undefined;
  let outcome: ReplicaLocalEraseOutcome = { status: "failed", code: "STORAGE_ERROR", marker: false };
  for (let attempt = 0; attempt <= ERASE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, ERASE_RETRY_DELAYS_MS[attempt - 1]));
    try {
      outcome = await lifecycle.eraseLocalCopy({ signal: AbortSignal.timeout(ERASE_ATTEMPT_MS) });
    } catch {
      outcome = { status: "failed", code: "STORAGE_ERROR", marker: false };
    }
    if (outcome.status !== "failed") break;
  }
  const keysKept = denyStatus === "marker" || denyStatus === "unguarded";
  const purge: ReplicaPurgeLocalCopyResult = outcome.status === "erased"
    ? { ok: true }
    : { ok: false, retryNow: outcome.status === "failed" };
  if (outcome.status === "erased" || (outcome.status === "refused" && !keysKept)) return { outcome, purge };
  const logoutPending = outcome.status === "failed" && outcome.marker;
  const event: ReplicaPurgeFailedEvent = {
    type: "replica.purge.failed",
    trigger,
    reason: logoutPending ? "logout_pending" : "gate_unavailable",
    code: outcome.code,
    retryNow: outcome.status === "failed",
  };
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      console.error('Error in "replica.purge.failed" handler:', error);
    }
  }
  return logoutPending ? { outcome, purge, logoutPending } : { outcome, purge };
}

const KV_GET = KV.GET;
const KV_SYNC = KV.SYNC;
const KV_SERVICE = "tinycloud.kv";

/** The verified owner proof is signed, finite, exact-space, and uncaveated on one get+sync scope. */
export function verifiedOwnerConsentAnchor(
  session: TinyCloudSession,
  wasmBindings: Pick<IWasmBindings, "validatePersistedSession">,
  exactVerifiedRecap: (verified: { verifiedRecap?: unknown }) => WasmRecapEntry[],
): ReplicaConsentAnchor | null {
  if (typeof session.siwe !== "string" || typeof session.signature !== "string" ||
      typeof session.address !== "string" || typeof session.chainId !== "number") return null;
  try {
    const verified = wasmBindings.validatePersistedSession?.({
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      jwk: session.jwk,
      address: session.address,
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature,
    });
    if (!verified || !Number.isSafeInteger(Date.parse(verified.expiresAt ?? ""))) return null;
    const signedIssuedAt = new SiweMessage(session.siwe).issuedAt;
    if (typeof signedIssuedAt !== "string") return null;
    const issuedAt = Date.parse(signedIssuedAt);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
    const granted = exactVerifiedRecap(verified)
      .filter((entry) => entry.space === session.spaceId && entry.service === "kv")
      .map((entry) => ({ ...entry, service: "tinycloud.kv" }));
    const coversGetAndSync = granted.some((entry) => isCapabilitySubset([{
      service: "tinycloud.kv",
      space: session.spaceId,
      path: entry.path,
      actions: [KV.GET, KV.SYNC],
    }], granted).subset);
    return coversGetAndSync ? { at: issuedAt, source: "siwe" } : null;
  } catch {
    return null;
  }
}

/** Fresh sign-in only: the lifecycle creates keys; restore never calls this. */
export function establishReplicaSessionStamp(
  storage: KVReplicaStorage,
  principal: string,
  anchor: ReplicaConsentAnchor,
): Promise<ReplicaSessionStamp> {
  if (storage.kind === "indexeddb" && storage.lifecycle?.kind === "indexeddb") {
    return storage.lifecycle.establishSessionStamp(principal, { consentAnchor: anchor });
  }
  if (storage.kind === "sqlite" && storage.lifecycle?.kind === "file") {
    return storage.lifecycle.establishSessionStamp(principal, { consentAnchor: anchor });
  }
  throw Object.assign(new Error("Replica sign-in requires its platform lifecycle gate."), {
    code: "REPLICA_GATED" as const, gate: "gate_unavailable" as const,
  });
}

/** Existing persisted stamp only: never manufactures an authority on restore. */
export function restoreReplicaSessionStamp(
  storage: KVReplicaStorage,
  principal: string,
  persisted: ReplicaSessionStamp | undefined,
): Promise<ReplicaSessionStamp> {
  if (storage.kind === "indexeddb" && storage.lifecycle?.kind === "indexeddb") {
    return storage.lifecycle.restoreSessionStamp(principal, persisted);
  }
  if (storage.kind === "sqlite" && storage.lifecycle?.kind === "file") {
    return storage.lifecycle.restoreSessionStamp(principal, persisted);
  }
  throw Object.assign(new Error("Replica restore requires its platform lifecycle gate."), {
    code: "REPLICA_GATED" as const, gate: "gate_unavailable" as const,
  });
}

/** The delegation the replication grant delegates: get + sync on one folder prefix. */
function replicationEntries(spaceId: string, prefix: string): PermissionEntry[] {
  return [{
    service: KV_SERVICE,
    space: spaceId,
    path: prefix === "/" ? "" : prefix,
    actions: [KV_GET, KV_SYNC],
  }];
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
  for (const root of [`${space}/kv`, `tinycloud://${space}/kv`]) {
    if (resource === root || resource === `${root}/`) return "/";
  }
  for (const base of [`${space}/kv/`, `tinycloud://${space}/kv/`]) {
    if (resource.startsWith(base)) return resource.slice(base.length);
  }
  return undefined;

}
/**
 * Whether the signed `att` grants `ability` over the folder prefix, with
 * unrestricted authority unless explicitly asked to ignore caveats.
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
    if (path === undefined) continue;
    for (const [granted, caveats] of Object.entries(abilities)) {
      if (!actionContains(granted, ability)) continue;
      if (!isCapabilitySubset(
        [{ service: KV_SERVICE, space, path: prefix, actions: [ability] }],
        [{ service: KV_SERVICE, space, path, actions: [granted] }],
      ).subset) continue;
      if (options?.ignoreCaveats === true || caveatBranchesUnconstrained(caveats)) return true;
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
> & Partial<Pick<TinyCloudSession, "siwe" | "signature" | "address" | "chainId">>;

export interface ReplicationAuthorityHost {
  replicationSession(): ReplicationAuthoritySession | undefined;
  /** Validated owner proof only; never infer consent from a compact child UCAN. */
  verifiedConsentAnchor?(session: ReplicationAuthoritySession): ReplicaConsentAnchor | null;
  /** The SIWE "Expiration Time" of the session — the delegateTo delegation cap. */
  siweExpiration(siwe: string): Date | undefined;
  planDelegation(
    entries: PermissionEntry[],
    options?: { expiry?: string | number },
  ): ({ grant?: unknown } & DelegationPlanResult) | AuthorityRefusal;
  mintDelegation(
    deviceDid: string,
    entries: PermissionEntry[],
    options?: { expiryMs?: number; renewalOnly?: boolean },
  ): Promise<{ ucan: string; expiresAt: number }>;
}

/** Delegate a replica grant only through the selected owner parent for silent renewal. */
export async function mintNodeReplicationGrant(
  deviceDid: string,
  entries: PermissionEntry[],
  options: { expiryMs?: number; renewalOnly?: boolean } | undefined,
  renewalSession: ReplicationAuthoritySession | undefined,
  node: Pick<TinyCloudNode, "delegateTo">,
): Promise<{ ucan: string; expiresAt: number }> {
  if (options?.renewalOnly && !renewalSession) throw new Error("replication renewal lost its owner session");
  const delegateOptions: DelegateToOptions | undefined = options?.renewalOnly ? {
    expiry: options.expiryMs,
    onPrepared: async (prepared) => {
      assertRenewalParent(prepared.delegationHeader.Authorization, renewalSession!);
    },
  } : options?.expiryMs === undefined ? undefined : { expiry: options.expiryMs };
  const result: DelegateToResult = await node.delegateTo(principalDid(deviceDid), entries, delegateOptions);
  return {
    ucan: result.delegation.delegationHeader.Authorization,
    expiresAt: result.delegation.expiry.getTime(),
  };
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
    const space = resource.match(/^(?:tinycloud:\/\/)?(.+?)\/kv(?:\/|$)/)?.[1];
    if (space !== input.persistedSpace) continue;
    const owner = parseSpaceUri(space);
    if (owner?.owner && owner.address && owner.chainId) return { space, principal: owner.owner };
  }
  return undefined;
}
/** Runs before host activation; a replan cannot silently switch a renewal to a runtime parent. */
export function assertRenewalParent(authorization: string, session: ReplicationAuthoritySession): void {
  const grant = parseUcanGrant(authorization);
  if (
    grant.issuer !== session.verificationMethod.split("#", 1)[0] ||
    grant.prf.length !== 1 ||
    grant.prf[0] !== session.delegationCid
  ) {
    throw Object.assign(new Error("replication renewal requires the bound owner session parent"), { refused: "NOT_COVERED" as const });
  }
}

export function createReplicationAuthority(host: ReplicationAuthorityHost): ReplicationAuthority {
  const boundSession = host.replicationSession();
  let verifiedAnchor: ReplicaConsentAnchor | null = null;
  try {
    const candidate = boundSession && host.verifiedConsentAnchor?.(boundSession);
    if (candidate && Number.isFinite(candidate.at) && candidate.source !== "first_install") {
      verifiedAnchor = { at: candidate.at, source: candidate.source };
    }
  } catch {
    // Network sessions remain usable when the optional replica proof cannot be verified.
  }
  const activeSession = (): ReplicationAuthoritySession | undefined => {
    const session = host.replicationSession();
    return session !== undefined && session === boundSession ? session : undefined;
  };
  const planOrRefusal = (entries: PermissionEntry[], expiryMs?: number): DelegationPlanResult | AuthorityRefusal => {
    const plan = host.planDelegation(entries, expiryMs === undefined ? undefined : { expiry: expiryMs });
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
      const session = activeSession();
      return session === undefined || session.siwe === undefined;
    },
    consentAnchor(): ReplicaConsentAnchor | null {
      return activeSession() ? verifiedAnchor : null;
    },
    get canRenew() {
      const session = activeSession();
      return verifiedAnchor?.source === "siwe" && session !== undefined && session.siwe !== undefined;
    },
    sessionGrant(prefix: string): { ucan: string; device: ReplicaDevice } | AuthorityRefusal {
      const session = activeSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      // A compact session proves current signed coverage, not consent to install or mint.
      if (verifiedAnchor === null && session.siwe !== undefined) return { refused: "NOT_COVERED" };
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
      const session = activeSession();
      if (session === undefined) return { refused: "SESSION_EXPIRING" };
      if (verifiedAnchor === null) return { refused: "NOT_COVERED" };
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
      options?: { expiryMs?: number; renewalOnly?: boolean },
    ): Promise<{ ucan: string; parentCid: string; expiresAt: number }> {
      const session = activeSession();
      if (session === undefined) throw new Error("replication mint without the bound session");
      if (session.siwe === undefined) throw new Error("compact delegate sessions cannot mint device grants");
      if (verifiedAnchor?.source !== "siwe") throw new Error("replication mint requires verified owner consent");
      const entries = replicationEntries(session.spaceId, prefix);
      const plan = planOrRefusal(entries, options?.expiryMs);
      if ("refused" in plan) {
        throw Object.assign(
          new Error(`replication authority refused the mint: ${plan.refused}`),
          { refused: plan.refused },
        );
      }
      if (options?.renewalOnly && plan.path !== "session") {
        throw Object.assign(new Error("replication renewal requires a session parent"), { refused: "NOT_COVERED" as const });
      }
      signal.throwIfAborted();
      const minted = await new Promise<{ ucan: string; expiresAt: number }>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason ?? new Error("replication mint aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        host.mintDelegation(deviceDid, entries, options).then(
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
